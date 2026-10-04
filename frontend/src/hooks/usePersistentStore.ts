import { useStore } from 'zustand'
import type { StoreApi, UseBoundStore } from 'zustand'
import Dexie, { type Table } from 'dexie'
import type { BeeColony, DropPoint, Orchard, RouteVersion, TransitRoute } from '@/types'
import { basisHash, buildLegs, freezeStops, sumDistanceKm } from '@/utils/routePlan'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** Dexie 封装：果园 / 蜂群 / 投放点 / 转场路线 / 路线版本 五张表 + 元数据表 */
export class BeeRouteDb extends Dexie {
  orchards!: Table<Orchard, string>
  colonies!: Table<BeeColony, string>
  dropPoints!: Table<DropPoint, string>
  routes!: Table<TransitRoute, string>
  routeVersions!: Table<RouteVersion, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbbeeroute')
    this.version(1).stores({
      orchards: 'id, name, crop',
      colonies: 'id, code, status',
      dropPoints: 'id, orchardId, code',
      routes: 'id, fromDropId, toDropId',
      meta: 'key'
    })
    // v2：投放点新增「可容纳箱数」字段，迁移时为历史投放点补齐（按 8 箱兜底）
    this.version(2)
      .stores({
        orchards: 'id, name, crop, bloomStart',
        colonies: 'id, code, status, currentOrchardId',
        dropPoints: 'id, orchardId, code, dropWindow',
        routes: 'id, fromDropId, toDropId, departAt',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        await tx
          .table<DropPoint, string>('dropPoints')
          .toCollection()
          .modify((point) => {
            if (!point.capacityBoxes) {
              point.capacityBoxes = 8
            }
          })
      })
    // v3：转场路线版本化——路线段挂版本头，发布时冻结顺序 / 坐标 / 首段时刻 / 预计里程
    this.version(SCHEMA_VERSION)
      .stores({
        orchards: 'id, name, crop, bloomStart',
        colonies: 'id, code, status, currentOrchardId',
        dropPoints: 'id, orchardId, code, dropWindow',
        routes: 'id, versionId, chainId, version, versionStatus, departAt',
        routeVersions: 'id, chainId, version, status, departAt',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        const points = await tx.table<DropPoint, string>('dropPoints').toArray()
        const legacy = (await tx.table('routes').toArray()) as Array<Record<string, unknown>>
        if (legacy.length === 0) return

        // 旧路线段补首版：按出发时刻 + 车型 + 风险备注归链，段顺序沿用旧顺序（按时刻兜底）
        type Group = { key: string; rows: Array<Record<string, unknown>> }
        const groups = new Map<string, Group>()
        ;[...legacy]
          .sort((a, b) => String(a.departAt ?? '').localeCompare(String(b.departAt ?? '')))
          .forEach((row) => {
            const key = `${String(row.departAt ?? '')}|${String(row.vehicleType ?? '')}|${String(row.riskNote ?? '')}`
            const group = groups.get(key) ?? { key, rows: [] }
            group.rows.push(row)
            groups.set(key, group)
          })

        const now = new Date().toISOString()
        let chainIndex = 0
        for (const group of groups.values()) {
          chainIndex += 1
          const chainId = `chain_v3_${chainIndex}`
          const versionId = `rv_${chainId}_1`
          const stopIds: string[] = []
          group.rows.forEach((row, seq) => {
            const fromId = String(row.fromDropId ?? '')
            const toId = String(row.toDropId ?? '')
            if (seq === 0) stopIds.push(fromId)
            stopIds.push(toId)
          })
          const first = group.rows[0]
          const departAt = String(first.departAt ?? '')
          const vehicleType = (first.vehicleType as TransitRoute['vehicleType']) ?? '厢式货车'
          const riskNote = String(first.riskNote ?? '')
          const frozen = freezeStops(stopIds, points)
          const frozenMap = new Map(frozen.map((item) => [item.dropId, item]))
          const coord = (id: string): { longitude: number; latitude: number } => {
            const live = points.find((item) => item.id === id)
            const snap = frozenMap.get(id)
            return { longitude: live?.longitude ?? snap?.longitude ?? 0, latitude: live?.latitude ?? snap?.latitude ?? 0 }
          }

          // 重写旧段：补齐版本归属、段顺序、冻结坐标、执行状态
          const upgraded: TransitRoute[] = group.rows.map((row, seq) => {
            const fromId = String(row.fromDropId ?? '')
            const toId = String(row.toDropId ?? '')
            const from = coord(fromId)
            const to = coord(toId)
            return {
              id: String(row.id ?? `rt_legacy_${chainIndex}_${seq}`),
              versionId,
              chainId,
              version: 1,
              seq,
              fromDropId: fromId,
              toDropId: toId,
              fromLongitude: from.longitude,
              fromLatitude: from.latitude,
              toLongitude: to.longitude,
              toLatitude: to.latitude,
              distanceKm: Number(row.distanceKm ?? 0) || 0,
              durationH: Number(row.durationH ?? 0) || 0,
              vehicleType,
              departAt,
              riskNote,
              legStatus: 'pending',
              actualNote: String(row.actualNote ?? '待执行') || '待执行',
              versionStatus: 'published'
            }
          })

          // 旧数据若已回填实际执行记录，首版沿用其执行状态（已执行段保留实际记录）
          upgraded.forEach((leg) => {
            if (leg.actualNote && leg.actualNote !== '待执行') leg.legStatus = 'done'
          })

          const versionHead: RouteVersion = {
            id: versionId,
            chainId,
            version: 1,
            status: 'published',
            vehicleType,
            departAt,
            stopIds,
            stops: frozen,
            totalDistanceKm: sumDistanceKm(upgraded),
            riskNote,
            basisHash: basisHash(stopIds, points),
            invalidReason: '',
            createdAt: now,
            publishedAt: now,
            invalidatedAt: ''
          }
          await tx.table<TransitRoute, string>('routes').bulkPut(upgraded)
          await tx.table<RouteVersion, string>('routeVersions').put(versionHead)
        }
        void buildLegs
      })
  }
}

export const db = new BeeRouteDb()

/** 写入当前数据结构版本号 */
export async function stampDbVersion(): Promise<void> {
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

/** 读取整表 */
export async function loadAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入一条记录 */
export async function putRow<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 删除一条记录 */
export async function deleteRow<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/** Zustand store ↔ Dexie 表 的读写桥接（页面统一通过它读取 store） */
export function usePersistentStore<T extends object>(store: UseBoundStore<StoreApi<T>>): T
export function usePersistentStore<T extends object, S>(
  store: UseBoundStore<StoreApi<T>>,
  selector: (state: T) => S
): S
export function usePersistentStore<T extends object, S>(
  store: UseBoundStore<StoreApi<T>>,
  selector?: (state: T) => S
): T | S {
  return useStore(store, selector ?? ((state: T) => state as unknown as S))
}

/** 首次打开写入示例数据 */
export async function seedDemoData(): Promise<void> {
  const count = await db.orchards.count()
  if (count > 0) return

  const year = new Date().getFullYear()

  await db.orchards.bulkPut([
    {
      id: 'orc_ap',
      name: '北岭苹果园',
      crop: '苹果',
      areaMu: 120,
      longitude: 107.4132,
      latitude: 34.6128,
      bloomStart: `${year}-04-08`,
      bloomEnd: `${year}-04-18`,
      colonyIntensity: 0.1,
      ownerContact: '135****2043（周园主）',
      accessibility: '大车可达',
      historyYears: [year - 2, year - 1],
      note: '主栽富士，行距 4 m，南坡'
    },
    {
      id: 'orc_cherry',
      name: '西沟樱桃坡',
      crop: '樱桃',
      areaMu: 46,
      longitude: 107.3755,
      latitude: 34.5891,
      bloomStart: `${year}-04-12`,
      bloomEnd: `${year}-04-21`,
      colonyIntensity: 0.2,
      ownerContact: '138****7712（李园主）',
      accessibility: '仅小车',
      historyYears: [year - 1],
      note: '坡地梯田，需小车倒运蜂箱'
    },
    {
      id: 'orc_rape',
      name: '东滩油菜田',
      crop: '油菜',
      areaMu: 220,
      longitude: 107.4621,
      latitude: 34.6435,
      bloomStart: `${year}-03-28`,
      bloomEnd: `${year}-04-12`,
      colonyIntensity: 0.05,
      ownerContact: '137****9981（合作社）',
      accessibility: '大车可达',
      historyYears: [year - 1],
      note: '连片油菜，与苹果花期部分重叠'
    }
  ])

  await db.colonies.bulkPut([
    {
      id: 'col_001',
      code: 'Q-01',
      species: '意蜂',
      strengthFrames: 8,
      boxType: '标准继箱',
      currentOrchardId: 'orc_ap',
      status: '在园',
      lastCheckDate: `${year}-04-09`,
      healthNote: '群势稳定，子脾整齐'
    },
    {
      id: 'col_002',
      code: 'Q-02',
      species: '意蜂',
      strengthFrames: 6,
      boxType: '标准继箱',
      currentOrchardId: 'orc_rape',
      status: '转场中',
      lastCheckDate: `${year}-04-05`,
      healthNote: '轻微螨害，转场后需治螨'
    },
    {
      id: 'col_003',
      code: 'Q-03',
      species: '中蜂',
      strengthFrames: 4,
      boxType: '平箱',
      currentOrchardId: '',
      status: '待投放',
      lastCheckDate: `${year}-04-02`,
      healthNote: '新分群，群势偏弱'
    }
  ])

  await db.dropPoints.bulkPut([
    {
      id: 'dp_a01',
      orchardId: 'orc_ap',
      longitude: 107.4108,
      latitude: 34.6142,
      code: 'A-01',
      capacityBoxes: 8,
      shade: '北侧有防风林，午后半阴',
      waterDistance: 220,
      dropWindow: `${year}-04-07`,
      withdrawTime: `${year}-04-19`,
      owner: '周园主',
      colonyCodes: ['Q-01']
    },
    {
      id: 'dp_b01',
      orchardId: 'orc_rape',
      longitude: 107.4598,
      latitude: 34.6411,
      code: 'B-01',
      capacityBoxes: 12,
      shade: '无遮阴，需临时搭棚',
      waterDistance: 480,
      dropWindow: `${year}-03-27`,
      withdrawTime: `${year}-04-13`,
      owner: '合作社',
      colonyCodes: ['Q-02']
    },
    {
      id: 'dp_c01',
      orchardId: 'orc_cherry',
      longitude: 107.3741,
      latitude: 34.5902,
      code: 'C-01',
      capacityBoxes: 6,
      shade: '坡顶两株核桃树遮阴',
      waterDistance: 350,
      dropWindow: `${year}-04-11`,
      withdrawTime: `${year}-04-22`,
      owner: '李园主',
      colonyCodes: ['Q-02']
    }
  ])

  // 示例路线以「已发布 v1」写入：版本头冻结顺序 / 坐标 / 首段时刻 / 里程
  const departAt = `${year}-04-13T06:30`
  const stopIds = ['dp_b01', 'dp_c01']
  const points = await db.dropPoints.toArray()
  const versionId = 'rv_chain_demo_1'
  const chainId = 'chain_demo'
  const head: RouteVersion = {
    id: versionId,
    chainId,
    version: 1,
    status: 'published',
    vehicleType: '农用三轮',
    departAt,
    stopIds,
    stops: freezeStops(stopIds, points),
    totalDistanceKm: 0,
    riskNote: '西沟坡道窄，雨天泥泞，需小车倒运',
    basisHash: basisHash(stopIds, points),
    invalidReason: '',
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    invalidatedAt: ''
  }
  const legs = buildLegs({
    versionId,
    chainId,
    version: 1,
    versionStatus: 'published',
    stopIds,
    vehicleType: '农用三轮',
    departAt,
    riskNote: head.riskNote,
    livePoints: points
  })
  head.totalDistanceKm = sumDistanceKm(legs)
  await db.routes.bulkPut(legs)
  await db.routeVersions.put(head)
}
