import { BOX_UNITS, type BeeColony, type DropPoint, type RoutePlan, type RouteWaypoint, type TransitRoute, type VehicleType } from '@/types'
import { distanceKm, estimateDurationH } from '@/utils/geo'

/** 未执行段的默认实际记录标记；其余内容一律视为「已执行」 */
export const PENDING_ACTUAL = '待执行'

/** 路线计划文档 id：草稿固定 __draft，已发布版本 __v{n} */
export function planDocId(routeId: string, version: number): string {
  return version === 0 ? `${routeId}__draft` : `${routeId}__v${version}`
}

export function isExecutedLeg(leg: TransitRoute): boolean {
  const note = leg.actualNote.trim()
  return note !== '' && note !== PENDING_ACTUAL
}

/** 由选点顺序 + 当前投放点生成途经点顺序快照（发布时据此冻结坐标） */
export function buildWaypoints(orderedDropIds: string[], points: DropPoint[]): RouteWaypoint[] {
  const lookup = new Map(points.map((item) => [item.id, item]))
  const result: RouteWaypoint[] = []
  orderedDropIds.forEach((dropId, seq) => {
    const point = lookup.get(dropId)
    if (!point) return
    result.push({ dropId: point.id, seq, code: point.code, longitude: point.longitude, latitude: point.latitude })
  })
  return result
}

/** 计算路线指纹：顺序 + 坐标 + 首段时刻 + 车型 + 预计总里程；重复发布据此判幂等 */
export function computeFingerprint(input: {
  waypoints: RouteWaypoint[]
  departAt: string
  vehicleType: VehicleType
  totalDistanceKm: number
}): string {
  const coords = input.waypoints.map((item) => `${item.dropId}@${round6(item.longitude)},${round6(item.latitude)}`).join('|')
  const ordered = input.waypoints.map((item) => item.dropId).join('>')
  return [ordered, coords, input.departAt, input.vehicleType, round2(input.totalDistanceKm)].join('||')
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 按快照坐标逐段累计里程，返回每段与总计 */
export function legsDistance(waypoints: RouteWaypoint[]): { legs: number[]; total: number } {
  const legs: number[] = []
  for (let i = 1; i < waypoints.length; i += 1) {
    legs.push(
      distanceKm(
        { longitude: waypoints[i - 1].longitude, latitude: waypoints[i - 1].latitude },
        { longitude: waypoints[i].longitude, latitude: waypoints[i].latitude }
      )
    )
  }
  return { legs, total: round2(legs.reduce((sum, item) => sum + item, 0)) }
}

export interface RouteDraftMeta {
  vehicleType: VehicleType
  departAt: string
  riskNote: string
}

/**
 * 依据新快照生成转场段：
 * - 已执行段（actualNote 非「待执行」）按起终点对整段保留（含实际记录与当时里程/坐标）；
 * - 其余段只按新坐标重算里程与耗时（即「只算未执行段」）。
 */
export function buildLegs(
  routeId: string,
  version: number,
  waypoints: RouteWaypoint[],
  meta: RouteDraftMeta,
  previousLegs: TransitRoute[] = []
): TransitRoute[] {
  const executed = new Map(previousLegs.filter(isExecutedLeg).map((leg) => [`${leg.fromDropId}>${leg.toDropId}`, leg]))
  const legs: TransitRoute[] = []
  for (let i = 1; i < waypoints.length; i += 1) {
    const from = waypoints[i - 1]
    const to = waypoints[i]
    const seq = i - 1
    const kept = executed.get(`${from.dropId}>${to.dropId}`)
    if (kept) {
      legs.push({
        ...kept,
        id: `rt_${routeId}_v${version}_${seq}`,
        routeId,
        version,
        seq,
        vehicleType: meta.vehicleType,
        departAt: meta.departAt,
        riskNote: meta.riskNote
      })
      continue
    }
    const km = distanceKm({ longitude: from.longitude, latitude: from.latitude }, { longitude: to.longitude, latitude: to.latitude })
    legs.push({
      id: `rt_${routeId}_v${version}_${seq}`,
      routeId,
      version,
      seq,
      fromDropId: from.dropId,
      toDropId: to.dropId,
      fromLng: from.longitude,
      fromLat: from.latitude,
      toLng: to.longitude,
      toLat: to.latitude,
      distanceKm: km,
      durationH: estimateDurationH(km),
      vehicleType: meta.vehicleType,
      departAt: meta.departAt,
      riskNote: meta.riskNote,
      actualNote: PENDING_ACTUAL
    })
  }
  return legs
}

/**
 * 依据变化检测：对照当前投放点，返回已发布路线失效原因列表（空数组 = 依据未变）。
 * 顺序变化由规划编辑动作体现；这里检测投放点被删除 / 被挪动（坐标漂移）。
 */
export function detectBasisChanges(plan: RoutePlan, points: DropPoint[]): string[] {
  const lookup = new Map(points.map((item) => [item.id, item]))
  const reasons: string[] = []
  plan.waypoints.forEach((waypoint) => {
    const current = lookup.get(waypoint.dropId)
    if (!current) {
      reasons.push(`投放点 ${waypoint.code} 已被删除`)
      return
    }
    if (round6(current.longitude) !== round6(waypoint.longitude) || round6(current.latitude) !== round6(waypoint.latitude)) {
      reasons.push(`投放点 ${waypoint.code} 已挪动：(${waypoint.longitude}, ${waypoint.latitude}) → (${current.longitude}, ${current.latitude})`)
    }
  })
  return reasons
}

/** 统计一组投放点上已安排蜂群折合的占车箱位（按群号去重） */
export function requiredBoxUnits(dropIds: string[], points: DropPoint[], colonies: BeeColony[]): number {
  const codes = new Set<string>()
  const lookup = new Map(points.map((item) => [item.id, item]))
  dropIds.forEach((id) => {
    lookup.get(id)?.colonyCodes.forEach((code) => codes.add(code))
  })
  const colonyLookup = new Map(colonies.map((item) => [item.code, item]))
  let units = 0
  codes.forEach((code) => {
    const colony = colonyLookup.get(code)
    units += BOX_UNITS[colony?.boxType ?? ''] ?? 1
  })
  return units
}
