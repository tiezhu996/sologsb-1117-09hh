import { create } from 'zustand'
import type { BeeColony, DropPoint, RoutePlan, TransitRoute, VehicleType } from '@/types'
import { RoutePublishError, VEHICLE_DAILY_CAPACITY } from '@/types'
import { db as defaultDb, loadAll, type BeeRouteDb } from '@/hooks/usePersistentStore'
import { uid } from '@/utils/id'
import {
  buildLegs,
  buildWaypoints,
  computeFingerprint,
  detectBasisChanges,
  legsDistance,
  PENDING_ACTUAL,
  planDocId,
  requiredBoxUnits
} from '@/utils/routePlan'

/** store 当前绑定的数据库；测试可用 bindRouteDb 换成隔离库 */
let database: BeeRouteDb = defaultDb

/** 仅供测试：把 routeStore 绑定到指定数据库 */
export function bindRouteDb(next: BeeRouteDb): void {
  database = next
}

export interface PublishResult {
  /** 是否实际生成了新版本（重复确认时为 false） */
  created: boolean
  plan: RoutePlan
}

export interface RouteState {
  /** 全部路线版本（published + superseded + draft），留档版本保留 */
  plans: RoutePlan[]
  /** 当前生效路线的转场段（总表 / 路线表 / 导出统一读这里） */
  activeLegs: TransitRoute[]
  /** 当前生效路线（无则 null） */
  activePlan: RoutePlan | null
  /** 编辑中的草稿（无则 null） */
  draft: RoutePlan | null
  /** 生效路线相对当前投放点的变化依据（空 = 依据未变） */
  basisChanges: string[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 保存/覆盖草稿（编辑中的选点顺序、车型、时刻、风险备注）；发布失败后也用它恢复草稿 */
  saveDraft: (
    orderedDropIds: string[],
    meta: { vehicleType: VehicleType; departAt: string; riskNote: string }
  ) => Promise<RoutePlan>
  /** 清空草稿（放弃编辑） */
  discardDraft: () => Promise<void>
  /**
   * 发布当前草稿：
   * - 冻结途经点顺序 / 坐标 / 首段时刻 / 预计里程；
   * - 依据变化时旧版本留档标记失效，确认重算才生成新版本（已执行段保留，只重算未执行段）；
   * - 同一指纹重复确认幂等，不新增版本；
   * - 车辆当日运力容量不足时拒绝发布；
   * - 发布失败自动回滚，草稿保持原样。
   */
  publishDraft: () => Promise<PublishResult>
  /** 回填某段的实际执行记录（仅对当前生效版本） */
  recordActual: (legId: string, actualNote: string) => Promise<void>
  /** 依据变化时确认重算：基于当前投放点生成草稿（已执行段整段保留），等待下一步发布 */
  confirmRecalculate: () => Promise<RoutePlan>
  /** 判定当前生效路线相对当前投放点是否有依据变化 */
  refreshBasisChanges: (dropPoints: DropPoint[]) => void
}

/** 找当前生效路线 */
function pickActive(plans: RoutePlan[]): RoutePlan | null {
  return plans.filter((plan) => plan.status === 'published').sort((a, b) => b.version - a.version)[0] ?? null
}

function pickDraft(plans: RoutePlan[]): RoutePlan | null {
  return plans.find((plan) => plan.status === 'draft') ?? null
}

export const routeStore = create<RouteState>((set, get) => ({
  plans: [],
  activeLegs: [],
  activePlan: null,
  draft: null,
  basisChanges: [],
  loaded: false,

  hydrate: async () => {
    const plans = await loadAll<RoutePlan>(database.routePlans)
    const active = pickActive(plans)
    set({
      plans,
      activePlan: active,
      activeLegs: active ? [...active.legs].sort((a, b) => a.seq - b.seq) : [],
      draft: pickDraft(plans),
      loaded: true
    })
  },

  refreshBasisChanges: (dropPoints) => {
    const { activePlan } = get()
    set({ basisChanges: activePlan ? detectBasisChanges(activePlan, dropPoints) : [] })
  },

  saveDraft: async (orderedDropIds, meta) => {
    if (orderedDropIds.length < 2) {
      throw new RoutePublishError('TOO_FEW_POINTS', '至少选择 2 个投放点才能生成转场路线')
    }
    const points = await loadAll<DropPoint>(database.dropPoints)
    const missing = orderedDropIds.filter((id) => !points.some((point) => point.id === id))
    if (missing.length > 0) {
      throw new RoutePublishError('POINT_MISSING', '顺序中存在已被删除的投放点，请重新选点')
    }
    const { activePlan, draft } = get()
    const waypoints = buildWaypoints(orderedDropIds, points)
    // 编辑新草稿时，若生效版本的已执行段仍在新顺序里，预览即按「保留已执行段」处理
    const previousLegs = draft?.legs ?? activePlan?.legs ?? []
    const legs = buildLegs(draft?.routeId ?? activePlan?.routeId ?? uid('rt'), 0, waypoints, meta, previousLegs)
    const { total } = legsDistance(waypoints)
    const nextDraft: RoutePlan = {
      id: planDocId(legs[0].routeId, 0),
      routeId: legs[0].routeId,
      version: 0,
      status: 'draft',
      waypoints,
      legs,
      vehicleType: meta.vehicleType,
      departAt: meta.departAt,
      riskNote: meta.riskNote,
      totalDistanceKm: total,
      publishedAt: '',
      supersededReason: '',
      fingerprint: computeFingerprint({ waypoints, departAt: meta.departAt, vehicleType: meta.vehicleType, totalDistanceKm: total })
    }
    await database.transaction('rw', database.routePlans, database.routes, async () => {
      await database.routePlans.put(nextDraft)
      await database.routes.bulkPut(legs)
    })
    await get().hydrate()
    return nextDraft
  },

  discardDraft: async () => {
    const { draft } = get()
    if (!draft) return
    await database.transaction('rw', database.routePlans, database.routes, async () => {
      await database.routePlans.delete(draft.id)
      await database.routes.bulkDelete(draft.legs.map((leg) => leg.id))
    })
    await get().hydrate()
  },

  publishDraft: async () => {
    const { draft, activePlan, plans } = get()
    if (!draft) {
      throw new RoutePublishError('TOO_FEW_POINTS', '没有待发布的草稿，请先选点生成路线')
    }

    const points = await loadAll<DropPoint>(database.dropPoints)
    const colonies = await loadAll<BeeColony>(database.colonies)

    // —— 依据校验：草稿途经点必须都还存在 ——
    const missing = draft.waypoints.filter((waypoint) => !points.some((point) => point.id === waypoint.dropId))
    if (missing.length > 0) {
      throw new RoutePublishError('POINT_MISSING', `投放点 ${missing.map((item) => item.code).join('、')} 已被删除，无法发布`)
    }

    // —— 幂等：与当前生效版本同指纹（顺序/坐标/首段时刻/车型/里程均未变）→ 不新增版本 ——
    if (activePlan && activePlan.fingerprint === draft.fingerprint) {
      await get().discardDraft()
      return { created: false, plan: activePlan }
    }

    // —— 运力校验：同车型、同一出发日期的当日容量 ——
    const dateKey = draft.departAt.slice(0, 10)
    const demand = requiredBoxUnits(
      draft.waypoints.map((item) => item.dropId),
      points,
      colonies
    )
    const capacity = VEHICLE_DAILY_CAPACITY[draft.vehicleType]
    const usedByOthers = plans
      .filter((plan) => plan.status === 'published' && plan.routeId !== draft.routeId)
      .filter((plan) => plan.vehicleType === draft.vehicleType && plan.departAt.slice(0, 10) === dateKey)
      .reduce((sum, plan) => sum + requiredBoxUnits(plan.waypoints.map((item) => item.dropId), points, colonies), 0)
    if (demand + usedByOthers > capacity) {
      throw new RoutePublishError(
        'CAPACITY_EXCEEDED',
        `${dateKey} ${draft.vehicleType} 当日运力 ${capacity} 箱位，已排 ${usedByOthers} 箱位，本路线需 ${demand} 箱位，合计 ${
          demand + usedByOthers
        } 箱位，容量不足，已拒绝发布`
      )
    }

    // —— 发布事务：冻结新版本、旧版本留档失效、清理草稿；任一步失败整体回滚（草稿保留即「恢复草稿」） ——
    const routeId = draft.routeId
    const nextVersion = activePlan && activePlan.routeId === routeId ? activePlan.version + 1 : 1
    const reason = activePlan && activePlan.routeId === routeId ? detectBasisChanges(activePlan, points) : []
    if (activePlan && activePlan.routeId === routeId && reason.length === 0 && activePlan.fingerprint !== draft.fingerprint) {
      // 同一路线但依据（坐标/点集）未变，属于顺序/时刻/车型的主动调整，留档说明按变更处理
      reason.push('按最新选点顺序与排期重算发布')
    }

    const meta = { vehicleType: draft.vehicleType, departAt: draft.departAt, riskNote: draft.riskNote }
    // 已执行段保留实际记录，未执行段按新快照重算
    const previousLegs = activePlan?.routeId === routeId ? activePlan.legs : []
    const frozenLegs = buildLegs(routeId, nextVersion, draft.waypoints, meta, previousLegs)
    const published: RoutePlan = {
      id: planDocId(routeId, nextVersion),
      routeId,
      version: nextVersion,
      status: 'published',
      waypoints: draft.waypoints,
      legs: frozenLegs,
      vehicleType: draft.vehicleType,
      departAt: draft.departAt,
      riskNote: draft.riskNote,
      totalDistanceKm: draft.totalDistanceKm,
      publishedAt: new Date().toISOString(),
      supersededReason: '',
      fingerprint: draft.fingerprint
    }

    const snapshot = {
      plans: get().plans,
      activePlan: get().activePlan,
      activeLegs: get().activeLegs,
      draft: get().draft
    }

    try {
      await database.transaction('rw', database.routePlans, database.routes, async () => {
        // 旧版本留档标记失效（同一路线的历史 published → superseded）
        const superseded = plans
          .filter((plan) => plan.status === 'published' && plan.routeId === routeId)
          .map((plan) => ({ ...plan, status: 'superseded' as const, supersededReason: reason.join('；') || '依据变化后重算' }))
        for (const plan of superseded) {
          await database.routePlans.put(plan)
        }
        await database.routePlans.put(published)
        await database.routes.bulkPut(frozenLegs)
        // 清理草稿段与草稿文档
        await database.routes.bulkDelete(draft.legs.map((leg) => leg.id))
        await database.routePlans.delete(draft.id)
      })
    } catch (error) {
      // 发布失败：Dexie 事务已回滚，store 状态也恢复到发布前（草稿保留，即「恢复草稿」）
      set(snapshot)
      if (error instanceof RoutePublishError) throw error
      throw new RoutePublishError(
        'DB_ERROR',
        `发布失败，已恢复草稿：${error instanceof Error ? error.message : String(error)}`
      )
    }

    await get().hydrate()
    return { created: true, plan: published }
  },

  confirmRecalculate: async () => {
    const { activePlan } = get()
    if (!activePlan) {
      throw new RoutePublishError('TOO_FEW_POINTS', '当前没有已发布路线可重算')
    }
    const points = await loadAll<DropPoint>(database.dropPoints)
    // 新顺序取当前仍存在的冻结点（坐标用当前值），已删除的点剔除；已执行段在 saveDraft/buildLegs 中保留
    const currentOrder = activePlan.waypoints
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .filter((waypoint) => points.some((point) => point.id === waypoint.dropId))
      .map((waypoint) => waypoint.dropId)
    const draft = await get().saveDraft(currentOrder, {
      vehicleType: activePlan.vehicleType,
      departAt: activePlan.departAt,
      riskNote: activePlan.riskNote
    })
    return draft
  },

  recordActual: async (legId, actualNote) => {
    const { activePlan } = get()
    if (!activePlan) return
    const leg = activePlan.legs.find((item) => item.id === legId)
    if (!leg) return
    const updated: TransitRoute = {
      ...leg,
      actualNote: actualNote.trim() ? actualNote.trim() : PENDING_ACTUAL
    }
    const updatedPlan: RoutePlan = {
      ...activePlan,
      legs: activePlan.legs.map((item) => (item.id === legId ? updated : item))
    }
    await database.transaction('rw', database.routePlans, database.routes, async () => {
      await database.routes.put(updated)
      await database.routePlans.put(updatedPlan)
    })
    await get().hydrate()
  }
}))
