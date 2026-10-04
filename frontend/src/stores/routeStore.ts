import { create } from 'zustand'
import type { DropPoint, RouteVersion, TransitRoute } from '@/types'
import { db, loadAll } from '@/hooks/usePersistentStore'
import { uid } from '@/utils/id'
import {
  basisHash,
  buildLegs,
  checkDailyCapacity,
  diffBasis,
  freezeStops,
  legLoadBoxes,
  routeLoadBoxes,
  sumDistanceKm,
  type CapacityIssue
} from '@/utils/routePlan'

/** 运力不足：发布被拒 */
export class CapacityExceededError extends Error {
  issue: CapacityIssue
  constructor(issue: CapacityIssue) {
    super(
      `当日运力容量不足：${issue.date} ${issue.vehicleType} 需运 ${issue.demanded} 箱，单车容量 ${issue.capacity} 箱（本次新增 ${issue.added} 箱）`
    )
    this.name = 'CapacityExceededError'
    this.issue = issue
  }
}

/** 重复确认且依据无变化：不新增版本 */
export class UnchangedConfirmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnchangedConfirmError'
  }
}

export interface DraftInput {
  vehicleType: TransitRoute['vehicleType']
  departAt: string
  riskNote: string
  stopIds: string[]
  /** 重算时传入：沿用上一版本的链 */
  chainId?: string
  /** 重算时传入：上一版本 id，已执行段整段保留 */
  fromVersionId?: string
}

export interface RouteState {
  /** 当前生效（已发布且未失效）版本的段——总表 / 路线表 / 导出统一读这里 */
  rows: TransitRoute[]
  /** 全部版本头 */
  versions: RouteVersion[]
  /** 当前生效版本（可能为空） */
  current: RouteVersion | null
  /** 草稿版本（可能为空） */
  draft: RouteVersion | null
  /** 草稿段（编辑中，含已执行前缀） */
  draftLegs: TransitRoute[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 保存草稿（未发布；重算确认也先落草稿） */
  saveDraft: (input: DraftInput) => Promise<RouteVersion>
  /** 发布草稿：冻结顺序 / 坐标 / 首段时刻 / 预计里程；失败回滚保留草稿 */
  publishDraft: () => Promise<RouteVersion>
  /** 检测依据变化：旧版本留档并标记失效，返回是否发生失效 */
  detectDrift: () => Promise<boolean>
  /** 确认重算：基于失效版本生成新版本草稿，已执行段保留，只算未执行段 */
  confirmRecalculate: (invalidVersionId?: string) => Promise<RouteVersion>
  /** 回填实际记录（仅当前版本的段） */
  recordActual: (legId: string, actualNote: string, markDone?: boolean) => Promise<void>
  /** 放弃草稿 */
  discardDraft: () => Promise<void>
}

function pickCurrent(versions: RouteVersion[]): RouteVersion | null {
  const published = versions
    .filter((item) => item.status === 'published')
    .sort((a, b) => b.version - a.version)
  if (published.length === 0) return null
  // 多条链时取最近发布的一条
  return published.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
}

export const routeStore = create<RouteState>((set, get) => ({
  rows: [],
  versions: [],
  current: null,
  draft: null,
  draftLegs: [],
  loaded: false,

  hydrate: async () => {
    const [versions, allLegs] = await Promise.all([loadAll<RouteVersion>(db.routeVersions), loadAll<TransitRoute>(db.routes)])
    versions.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.version - a.version)
    const current = pickCurrent(versions)
    const draft = versions.filter((item) => item.status === 'draft').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    const rows = current
      ? allLegs
          .filter((leg) => leg.versionId === current.id)
          .sort((a, b) => a.seq - b.seq)
      : []
    const draftLegs = draft
      ? allLegs.filter((leg) => leg.versionId === draft.id).sort((a, b) => a.seq - b.seq)
      : []
    // 段上版本状态与版本头保持一致（失效标记后同步）
    if (current) {
      rows.forEach((leg) => {
        leg.versionStatus = current.status
      })
    }
    set({ versions, current, draft, draftLegs, rows, loaded: true })
  },

  saveDraft: async (input) => {
    const state = get()
    const points = await loadAll<DropPoint>(db.dropPoints)
    const uniqueIds = Array.from(new Set(input.stopIds))
    if (uniqueIds.length < 2) throw new Error('至少选择 2 个投放点才能生成转场路线')

    // 沿用链：重算时传入；否则接在「这条路线」最新版本之后
    // （生效版本可能已失效 → current 为 null，此时仍应沿用最近失效版本的链，而非另起孤立新链）
    const baseVersion = input.fromVersionId
      ? state.versions.find((item) => item.id === input.fromVersionId)
      : null
    const chainHead = state.versions
      .filter((item) => item.status !== 'draft')
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.version - a.version)[0]
    const chainId = input.chainId ?? baseVersion?.chainId ?? state.current?.chainId ?? chainHead?.chainId ?? uid('chain')

    // 已执行前缀：从重算来源版本整段搬过来（保留实际记录与冻结坐标）
    const preservedLegs = baseVersion
      ? (await loadAll<TransitRoute>(db.routes))
          .filter((leg) => leg.versionId === baseVersion.id && leg.legStatus === 'done')
          .sort((a, b) => a.seq - b.seq)
      : []

    const chainVersions = state.versions.filter((item) => item.chainId === chainId)
    const nextVersion = (baseVersion?.version ?? chainVersions.reduce((m, item) => Math.max(m, item.version), 0)) + 1
    const draftVersionId = `rv_${chainId}_draft_${Date.now().toString(36)}`
    const legs = buildLegs({
      versionId: draftVersionId,
      chainId,
      version: nextVersion,
      versionStatus: 'draft',
      stopIds: uniqueIds,
      vehicleType: input.vehicleType,
      departAt: input.departAt,
      riskNote: input.riskNote,
      livePoints: points,
      preservedLegs
    })
    const frozen = freezeStops(uniqueIds, points)
    const head: RouteVersion = {
      id: draftVersionId,
      chainId,
      version: nextVersion,
      status: 'draft',
      vehicleType: input.vehicleType,
      departAt: input.departAt,
      stopIds: uniqueIds,
      stops: frozen,
      totalDistanceKm: sumDistanceKm(legs),
      riskNote: input.riskNote,
      basisHash: basisHash(uniqueIds, points),
      invalidReason: '',
      createdAt: new Date().toISOString(),
      publishedAt: '',
      invalidatedAt: ''
    }
    // 草稿唯一：替换本链旧草稿（保留其它链草稿互不影响；本应用按当前路线编辑，统一替换）
    const oldDraftHeads = state.versions.filter((item) => item.status === 'draft')
    const oldDraftIds = new Set(oldDraftHeads.map((item) => item.id))
    const oldDraftLegs = (await loadAll<TransitRoute>(db.routes)).filter((leg) => oldDraftIds.has(leg.versionId))
    await db.transaction('rw', db.routeVersions, db.routes, async () => {
      await db.routeVersions.bulkDelete(oldDraftHeads.map((item) => item.id))
      await db.routes.bulkDelete(oldDraftLegs.map((item) => item.id))
      await db.routeVersions.put(head)
      await db.routes.bulkPut(legs)
    })
    await get().hydrate()
    return head
  },

  publishDraft: async () => {
    const state = get()
    const draft = state.draft
    if (!draft) throw new Error('没有可发布的草稿')
    const points = await loadAll<DropPoint>(db.dropPoints)
    const draftLegs = (await loadAll<TransitRoute>(db.routes)).filter((leg) => leg.versionId === draft.id)

    // 重复确认：草稿依据与当前生效版本完全一致 → 不新增版本
    const liveHash = basisHash(draft.stopIds, points)
    const sameChainCurrent = state.versions.find(
      (item) => item.chainId === draft.chainId && item.status === 'published' && item.version >= draft.version - 1
    )
    const unchanged =
      sameChainCurrent &&
      sameChainCurrent.basisHash === liveHash &&
      sameChainCurrent.departAt === draft.departAt &&
      sameChainCurrent.vehicleType === draft.vehicleType &&
      sameChainCurrent.riskNote === draft.riskNote &&
      JSON.stringify(sameChainCurrent.stopIds) === JSON.stringify(draft.stopIds)
    if (unchanged) {
      throw new UnchangedConfirmError('当前生效版本与草稿一致，重复确认不新增版本')
    }

    // 车辆当日运力容量：同日同车型已发布未执行段累计 + 本次待运箱数
    const added = routeLoadBoxes(draft.stopIds, points)
    const date = draft.departAt.slice(0, 10)
    const otherPublished = (await loadAll<TransitRoute>(db.routes))
      .filter((leg) => leg.versionStatus === 'published' && leg.legStatus === 'pending' && leg.versionId !== draft.id)
      .map((leg) => ({
        departAt: leg.departAt,
        vehicleType: leg.vehicleType,
        demandedBoxes: legLoadBoxes(leg.toDropId, points)
      }))
    const issue = checkDailyCapacity({ date, vehicleType: draft.vehicleType, added }, otherPublished)
    if (issue) throw new CapacityExceededError(issue)

    // 发布事务：草稿段整段提升为已发布（保留已执行段的实际记录），冻结后写入新版本
    // 事务任一步失败都会整体回滚——草稿与旧版本原样保留，即「发布失败恢复草稿」
    const publishedAt = new Date().toISOString()
    const versionNo = draft.version
    const frozenStops = freezeStops(draft.stopIds, points)
    const head: RouteVersion = {
      ...draft,
      status: 'published',
      version: versionNo,
      totalDistanceKm: sumDistanceKm(draftLegs),
      basisHash: liveHash,
      stops: frozenStops,
      publishedAt
    }
    // 发布冻结：段坐标以当前快照为准（与草稿一致），状态提升为 published；actualNote/legStatus 原样保留
    const frozenLegs: TransitRoute[] = draftLegs
      .sort((a, b) => a.seq - b.seq)
      .map((leg) => ({ ...leg, versionStatus: 'published' as const }))
    await db.transaction('rw', db.routeVersions, db.routes, async () => {
      await db.routeVersions.put(head)
      await db.routes.bulkPut(frozenLegs)
    })
    await get().hydrate()
    return head
  },

  detectDrift: async () => {
    const state = get()
    const points = await loadAll<DropPoint>(db.dropPoints)
    const now = new Date().toISOString()
    let changed = false
    await db.transaction('rw', db.routeVersions, db.routes, async () => {
      for (const version of state.versions.filter((item) => item.status === 'published')) {
        const liveHash = basisHash(version.stopIds, points)
        if (liveHash === version.basisHash) continue
        const reasons = diffBasis(version, points)
        changed = true
        await db.routeVersions.update(version.id, {
          status: 'invalid',
          invalidReason: reasons.join('；') || '途经投放点坐标或顺序依据已变化',
          invalidatedAt: now
        })
        const legs = await db.routes.where('versionId').equals(version.id).toArray()
        await db.routes.bulkPut(legs.map((leg) => ({ ...leg, versionStatus: 'invalid' as const })))
      }
    })
    if (changed) await get().hydrate()
    return changed
  },

  confirmRecalculate: async (invalidVersionId) => {
    const state = get()
    const points = await loadAll<DropPoint>(db.dropPoints)
    const source =
      (invalidVersionId ? state.versions.find((item) => item.id === invalidVersionId) : undefined) ??
      state.versions.find((item) => item.status === 'invalid') ??
      state.current ??
      undefined
    if (!source) throw new Error('暂无可重算的路线')

    // 已执行段保留实际记录：从最后一个已执行站之后开始只算未执行段
    const sourceLegs = (await loadAll<TransitRoute>(db.routes))
      .filter((leg) => leg.versionId === source.id)
      .sort((a, b) => a.seq - b.seq)
    const lastDoneSeq = sourceLegs.filter((leg) => leg.legStatus === 'done').reduce((m, leg) => Math.max(m, leg.seq), -1)
    const keepStopCount = lastDoneSeq + 2 // done 段的 from..to 站点全部保留
    const headStopIds = source.stopIds.slice(0, Math.max(2, keepStopCount))
    const tailStopIds = source.stopIds.slice(Math.max(2, keepStopCount))
    const stopIds = [...headStopIds, ...tailStopIds.filter((id) => points.some((point) => point.id === id))]

    // 幂等：若草稿已按同一来源与同一依据生成，重复确认直接返回原草稿（不新增版本）
    const liveHash = basisHash(stopIds, points)
    const existing = state.draft
    if (existing && existing.chainId === source.chainId && existing.basisHash === liveHash) {
      return existing
    }

    return get().saveDraft({
      stopIds,
      vehicleType: source.vehicleType,
      departAt: source.departAt,
      riskNote: source.riskNote,
      chainId: source.chainId,
      fromVersionId: source.id
    })
  },

  recordActual: async (legId, actualNote, markDone = true) => {
    const leg = await db.routes.get(legId)
    if (!leg) return
    await db.routes.put({
      ...leg,
      actualNote,
      legStatus: markDone ? 'done' : leg.legStatus
    })
    await get().hydrate()
  },

  discardDraft: async () => {
    const draft = get().draft
    if (!draft) return
    await db.transaction('rw', db.routeVersions, db.routes, async () => {
      await db.routeVersions.delete(draft.id)
      const legs = await db.routes.where('versionId').equals(draft.id).toArray()
      await db.routes.bulkDelete(legs.map((leg) => leg.id))
    })
    await get().hydrate()
  }
}))
