import type { DropPoint, FrozenStop, TransitRoute, VehicleType } from '@/types'
import { VEHICLE_CAPACITY_BOXES } from '@/types'
import { distanceKm, estimateDurationH, type LngLat } from './geo'

/** 依据快照：发布时参与冻结的顺序与坐标 */
export interface RouteBasis {
  stopIds: string[]
  departAt: string
  vehicleType: VehicleType
  riskNote: string
}

/** 非加密指纹：顺序 + 投放点现行坐标，用于判断「旧路线依据是否变化」 */
export function basisHash(stopIds: string[], points: Pick<DropPoint, 'id' | 'longitude' | 'latitude'>[]): string {
  const lookup = new Map(points.map((item) => [item.id, item]))
  const parts = stopIds.map((id) => {
    const point = lookup.get(id)
    // 坐标保留 5 位小数（约 1m），缺失点用 ∅ 标记，删除/挪点都会改变指纹
    return point ? `${id}@${point.longitude.toFixed(5)},${point.latitude.toFixed(5)}` : `${id}@∅`
  })
  const raw = parts.join('|')
  let hash = 5381
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 33 + raw.charCodeAt(i)) >>> 0
  }
  return `h${hash.toString(16)}`
}

/** 依据变化明细（用于旧版本失效原因） */
export function diffBasis(
  version: { stopIds: string[]; stops: FrozenStop[] },
  points: Pick<DropPoint, 'id' | 'code' | 'longitude' | 'latitude'>[]
): string[] {
  const live = new Map(points.map((item) => [item.id, item]))
  const frozen = new Map(version.stops.map((item) => [item.dropId, item]))
  const reasons: string[] = []
  version.stopIds.forEach((id, index) => {
    const oldSnap = frozen.get(id)
    const now = live.get(id)
    if (!now) {
      reasons.push(`第 ${index + 1} 站 ${oldSnap?.code ?? id} 已删除`)
      return
    }
    if (oldSnap && (Math.abs(oldSnap.longitude - now.longitude) > 0 || Math.abs(oldSnap.latitude - now.latitude) > 0)) {
      reasons.push(
        `第 ${index + 1} 站 ${now.code} 坐标由 (${oldSnap.longitude}, ${oldSnap.latitude}) 变为 (${now.longitude}, ${now.latitude})`
      )
    }
  })
  return reasons
}

export interface CapacityIssue {
  date: string
  vehicleType: VehicleType
  /** 当日该车型所有生效路线累计待运箱数（含本次） */
  demanded: number
  /** 当日运力容量（单趟容量；同日同车型按一辆车计） */
  capacity: number
  /** 本次新占用箱数 */
  added: number
}

/**
 * 车辆当日运力容量校验：
 * 同一日期、同一车型，已发布版本的未执行段按「到达投放点安排的群箱数」累计，
 * 与本次新路线需求相加，超出该车型单趟容量即拒绝发布。
 */
export function checkDailyCapacity(
  issue: { date: string; vehicleType: VehicleType; added: number },
  others: { departAt: string; vehicleType: VehicleType; demandedBoxes: number }[]
): CapacityIssue | null {
  const capacity = VEHICLE_CAPACITY_BOXES[issue.vehicleType]
  const sameDay = others.filter(
    (item) => item.vehicleType === issue.vehicleType && item.departAt.slice(0, 10) === issue.date
  )
  const demanded = sameDay.reduce((sum, item) => sum + item.demandedBoxes, 0) + issue.added
  return demanded > capacity
    ? { date: issue.date, vehicleType: issue.vehicleType, demanded, capacity, added: issue.added }
    : null
}

/** 一段的待运箱数 = 到达投放点安排的群箱数（每群按 1 箱计） */
export function legLoadBoxes(toDropId: string, points: Pick<DropPoint, 'id' | 'colonyCodes'>[]): number {
  return points.find((item) => item.id === toDropId)?.colonyCodes.length ?? 0
}

/** 依据坐标（优先现行投放点，缺失时回退到冻结快照，保证留档段可渲染） */
export function resolveStopCoord(
  dropId: string,
  livePoints: Pick<DropPoint, 'id' | 'longitude' | 'latitude'>[],
  frozen?: FrozenStop[]
): LngLat {
  const live = livePoints.find((item) => item.id === dropId)
  if (live) return { longitude: live.longitude, latitude: live.latitude }
  const snap = frozen?.find((item) => item.dropId === dropId)
  return { longitude: snap?.longitude ?? 0, latitude: snap?.latitude ?? 0 }
}

export interface BuildLegsInput {
  versionId: string
  chainId: string
  version: number
  versionStatus: TransitRoute['versionStatus']
  stopIds: string[]
  vehicleType: VehicleType
  departAt: string
  riskNote: string
  livePoints: DropPoint[]
  /** 冻结快照（重算/发布时传入，供已删除点回退） */
  frozenStops?: FrozenStop[]
  /**
   * 已执行前缀（来自上一版本）：seq 与 stopIds 均匹配的段整段保留
   * （坐标、里程、actualNote、legStatus=done），其后尾段按新坐标重算。
   */
  preservedLegs?: TransitRoute[]
}

/**
 * 依据顺序与现行坐标生成连续转场段：
 * 已执行段（含实际记录）整段保留，只重算未执行段。
 */
export function buildLegs(input: BuildLegsInput): TransitRoute[] {
  const { versionId, chainId, version, versionStatus, stopIds, vehicleType, departAt, riskNote, livePoints, frozenStops, preservedLegs } =
    input
  const legs: TransitRoute[] = []
  for (let seq = 0; seq < stopIds.length - 1; seq += 1) {
    const fromId = stopIds[seq]
    const toId = stopIds[seq + 1]
    const preserved = preservedLegs?.find((item) => item.seq === seq && item.fromDropId === fromId && item.toDropId === toId)
    const from: LngLat = resolveStopCoord(fromId, livePoints, frozenStops)
    const to: LngLat = resolveStopCoord(toId, livePoints, frozenStops)
    if (preserved) {
      legs.push({
        ...preserved,
        id: `rtl_${versionId}_${seq}`,
        versionId,
        chainId,
        version,
        versionStatus,
        departAt,
        vehicleType,
        riskNote
      })
      continue
    }
    const km = distanceKm(from, to)
    legs.push({
      id: `rtl_${versionId}_${seq}`,
      versionId,
      chainId,
      version,
      seq,
      fromDropId: fromId,
      toDropId: toId,
      fromLongitude: from.longitude,
      fromLatitude: from.latitude,
      toLongitude: to.longitude,
      toLatitude: to.latitude,
      distanceKm: km,
      durationH: estimateDurationH(km),
      vehicleType,
      departAt,
      riskNote,
      legStatus: 'pending',
      actualNote: '待执行',
      versionStatus
    })
  }
  return legs
}

/** 段累计里程合计（保留 2 位） */
export function sumDistanceKm(legs: Pick<TransitRoute, 'distanceKm'>[]): number {
  return Math.round(legs.reduce((sum, item) => sum + item.distanceKm, 0) * 100) / 100
}

/** 路线待运箱数合计（各到达点安排群数去重前的逐段累计用于容量提示） */
export function routeLoadBoxes(stopIds: string[], livePoints: Pick<DropPoint, 'id' | 'colonyCodes'>[]): number {
  return stopIds.slice(1).reduce((sum, id) => sum + legLoadBoxes(id, livePoints), 0)
}

/** 构造冻结停靠点快照 */
export function freezeStops(
  stopIds: string[],
  livePoints: Pick<DropPoint, 'id' | 'code' | 'longitude' | 'latitude'>[]
): FrozenStop[] {
  return stopIds.map((id) => {
    const point = livePoints.find((item) => item.id === id)
    return {
      dropId: id,
      code: point?.code ?? id,
      longitude: point?.longitude ?? 0,
      latitude: point?.latitude ?? 0
    }
  })
}

