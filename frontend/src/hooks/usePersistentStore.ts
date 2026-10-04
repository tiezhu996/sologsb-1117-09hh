import { useStore } from 'zustand'
import type { StoreApi, UseBoundStore } from 'zustand'
import Dexie, { type Table } from 'dexie'
import type { BeeColony, DropPoint, Orchard, RoutePlan, RouteWaypoint, TransitRoute } from '@/types'
import { computeFingerprint, PENDING_ACTUAL } from '@/utils/routePlan'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** v3 升级前的旧版路线段结构（无版本/冻结字段） */
interface LegacyTransitRoute {
  id: string
  fromDropId: string
  toDropId: string
  distanceKm: number
  durationH: number
  vehicleType: TransitRoute['vehicleType']
  departAt: string
  riskNote: string
  actualNote: string
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Dexie 封装：果园 / 蜂群 / 投放点 / 转场路线段 / 路线版本 五张表 + 元数据表 */
export class BeeRouteDb extends Dexie {
  orchards!: Table<Orchard, string>
  colonies!: Table<BeeColony, string>
  dropPoints!: Table<DropPoint, string>
  routes!: Table<TransitRoute, string>
  routePlans!: Table<RoutePlan, string>
  meta!: Table<MetaRow, string>

  constructor(name = 'gbbeeroute') {
    super(name)
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
    // v3：路线版本化发布。旧路线段按「车型 + 出发日期」聚合，补成已发布首版（冻结坐标/顺序/时刻/里程）
    this.version(SCHEMA_VERSION)
      .stores({
        orchards: 'id, name, crop, bloomStart',
        colonies: 'id, code, status, currentOrchardId',
        dropPoints: 'id, orchardId, code, dropWindow',
        routes: 'id, routeId, version, seq, fromDropId, toDropId, departAt',
        routePlans: 'id, routeId, version, status, departAt',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        const pointList = await tx.table<DropPoint, string>('dropPoints').toArray()
        const pointLookup = new Map(pointList.map((item) => [item.id, item]))
        const routesTable = tx.table<TransitRoute, string>('routes')
        const legacy = (await routesTable.toArray()) as unknown as LegacyTransitRoute[]

        const groups = new Map<string, LegacyTransitRoute[]>()
        legacy.forEach((leg) => {
          const key = `${leg.vehicleType}|${(leg.departAt || '').slice(0, 10)}`
          const list = groups.get(key) ?? []
          list.push(leg)
          groups.set(key, list)
        })

        const plans: RoutePlan[] = []
        const migratedLegs: TransitRoute[] = []
        let groupIndex = 0
        groups.forEach((list) => {
          list.sort((a, b) => a.departAt.localeCompare(b.departAt) || a.id.localeCompare(b.id))
          const routeId = `rt_legacy_${groupIndex + 1}`
          const waypoints: RouteWaypoint[] = []
          const legs: TransitRoute[] = []
          list.forEach((leg, seq) => {
            const from = pointLookup.get(leg.fromDropId)
            const to = pointLookup.get(leg.toDropId)
            if (seq === 0 && from) {
              waypoints.push({ dropId: from.id, seq: 0, code: from.code, longitude: from.longitude, latitude: from.latitude })
            }
            if (!to) return
            if (!waypoints.some((item) => item.dropId === to.id)) {
              waypoints.push({ dropId: to.id, seq: waypoints.length, code: to.code, longitude: to.longitude, latitude: to.latitude })
            }
            legs.push({
              id: leg.id,
              routeId,
              version: 1,
              seq,
              fromDropId: leg.fromDropId,
              toDropId: leg.toDropId,
              fromLng: from?.longitude ?? 0,
              fromLat: from?.latitude ?? 0,
              toLng: to.longitude,
              toLat: to.latitude,
              distanceKm: leg.distanceKm,
              durationH: leg.durationH,
              vehicleType: leg.vehicleType,
              departAt: leg.departAt,
              riskNote: leg.riskNote ?? '',
              actualNote: leg.actualNote || PENDING_ACTUAL
            })
          })
          if (legs.length === 0) return
          const departAt = legs[0].departAt
          const totalDistanceKm = round2(legs.reduce((sum, leg) => sum + leg.distanceKm, 0))
          plans.push({
            id: `${routeId}__v1`,
            routeId,
            version: 1,
            status: 'published',
            waypoints,
            legs,
            vehicleType: legs[0].vehicleType,
            departAt,
            riskNote: legs[0].riskNote ?? '',
            totalDistanceKm,
            publishedAt: new Date().toISOString(),
            supersededReason: '',
            fingerprint: computeFingerprint({ waypoints, departAt, vehicleType: legs[0].vehicleType, totalDistanceKm })
          })
          migratedLegs.push(...legs)
          groupIndex += 1
        })

        if (migratedLegs.length > 0) {
          await routesTable.bulkPut(migratedLegs)
          await tx.table<RoutePlan, string>('routePlans').bulkPut(plans)
        }
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

  // 示例路线直接以「已发布 v1」写入：途经点顺序、坐标、首段时刻与里程全部冻结
  const routeId = 'rt_main'
  const departAt = `${year}-04-13T06:30`
  const demoWaypoints: RouteWaypoint[] = [
    { dropId: 'dp_b01', seq: 0, code: 'B-01', longitude: 107.4598, latitude: 34.6411 },
    { dropId: 'dp_c01', seq: 1, code: 'C-01', longitude: 107.3741, latitude: 34.5902 }
  ]
  const demoLeg: TransitRoute = {
    id: 'rt_001',
    routeId,
    version: 1,
    seq: 0,
    fromDropId: 'dp_b01',
    toDropId: 'dp_c01',
    fromLng: 107.4598,
    fromLat: 34.6411,
    toLng: 107.3741,
    toLat: 34.5902,
    distanceKm: 9.4,
    durationH: 0.54,
    vehicleType: '农用三轮',
    departAt,
    riskNote: '西沟坡道窄，雨天泥泞，需小车倒运',
    actualNote: PENDING_ACTUAL
  }
  await db.routes.put(demoLeg)
  await db.routePlans.put({
    id: `${routeId}__v1`,
    routeId,
    version: 1,
    status: 'published',
    waypoints: demoWaypoints,
    legs: [demoLeg],
    vehicleType: '农用三轮',
    departAt,
    riskNote: demoLeg.riskNote,
    totalDistanceKm: 9.4,
    publishedAt: new Date().toISOString(),
    supersededReason: '',
    fingerprint: computeFingerprint({ waypoints: demoWaypoints, departAt, vehicleType: '农用三轮', totalDistanceKm: 9.4 })
  })
}
