/** 车辆类型 */
export const VEHICLE_TYPES = ['厢式货车', '农用三轮', '皮卡', '人工搬运'] as const
export type VehicleType = (typeof VEHICLE_TYPES)[number]

/**
 * 各车型「当日运力容量」（可装载箱数上限）。
 * 换季挪点后路线可能要把蜂箱整批转走，发布时按首段出发日期汇总在途箱数，
 * 同车型当日其它生效路线占用的容量也要扣除。
 */
export const VEHICLE_DAILY_CAPACITY: Record<VehicleType, number> = {
  厢式货车: 40,
  农用三轮: 20,
  皮卡: 12,
  人工搬运: 6
}

/** 箱型 → 折合占车箱数（标准继箱双层算 2 个标准箱位） */
export const BOX_UNITS: Record<string, number> = {
  标准继箱: 2,
  平箱: 1,
  交尾箱: 1
}

/** 路线计划状态：草稿 / 已发布（生效） / 已失效（被新版本取代，留档） */
export const ROUTE_PLAN_STATUSES = ['draft', 'published', 'superseded'] as const
export type RoutePlanStatus = (typeof ROUTE_PLAN_STATUSES)[number]

/** 发布失败原因码（页面据此提示） */
export type PublishErrorCode = 'CAPACITY_EXCEEDED' | 'POINT_MISSING' | 'TOO_FEW_POINTS' | 'DB_ERROR'

/** TransitRoute 转场段（路线中的一段；发布后字段冻结） */
export interface TransitRoute {
  id: string
  /** 所属路线计划（多条版本共享同一个 routeId） */
  routeId: string
  /** 所属发布版本号（草稿为 0） */
  version: number
  /** 段序号（从 0 开始） */
  seq: number
  /** 出发投放点 */
  fromDropId: string
  /** 到达投放点 */
  toDropId: string
  /** 发布时冻结的出发投放点坐标 */
  fromLng: number
  fromLat: number
  /** 发布时冻结的到达投放点坐标 */
  toLng: number
  toLat: number
  /** 预计里程（km，发布时冻结） */
  distanceKm: number
  /** 预计耗时（小时，发布时冻结） */
  durationH: number
  vehicleType: VehicleType
  /** 转场日期时刻（路线首段出发时刻，发布时冻结） */
  departAt: string
  /** 途中风险备注 */
  riskNote: string
  /** 实际转场记录；非「待执行」视为已执行段，重算时整段保留 */
  actualNote: string
}

/** 路线途经点快照：发布时冻结顺序与坐标 */
export interface RouteWaypoint {
  dropId: string
  /** 途经顺序（从 0 开始） */
  seq: number
  /** 冻结时的投放点编号冗余（留档可追溯） */
  code: string
  longitude: number
  latitude: number
}

/** 发布版本的变化依据指纹：顺序 + 坐标 + 首段时刻 + 车型 + 里程 */
export interface RoutePlanFingerprint {
  orderedDropIds: string[]
  coords: string
  departAt: string
  vehicleType: VehicleType
  totalDistanceKm: number
}

/**
 * RoutePlan 转场路线计划。
 * 同一条逻辑路线（routeId）会有多条记录：至多一条 published（当前生效），
 * 历史版本保留为 superseded 留档，另有至多一条 draft（编辑中的草稿）。
 */
export interface RoutePlan {
  /** `${routeId}__v${version}`，草稿 version=0 */
  id: string
  /** 逻辑路线 id */
  routeId: string
  /** 版本号，从 1 开始；草稿为 0 */
  version: number
  status: RoutePlanStatus
  /** 途经点顺序与坐标快照（已发布/已失效为冻结快照） */
  waypoints: RouteWaypoint[]
  /** 转场段（已发布/已失效为冻结快照；已执行段带实际记录） */
  legs: TransitRoute[]
  vehicleType: VehicleType
  /** 首段出发时刻（冻结） */
  departAt: string
  riskNote: string
  /** 预计总里程（km，冻结） */
  totalDistanceKm: number
  /** 发布时间（ISO），草稿为空 */
  publishedAt: string
  /** 失效留档原因 */
  supersededReason: string
  /** 变化依据指纹（发布时计算，重复发布据此判幂等） */
  fingerprint: string
}

/** 发布失败异常（携带可展示信息与原因码） */
export class RoutePublishError extends Error {
  code: PublishErrorCode
  constructor(code: PublishErrorCode, message: string) {
    super(message)
    this.name = 'RoutePublishError'
    this.code = code
  }
}
