/** 车辆类型 */
export const VEHICLE_TYPES = ['厢式货车', '农用三轮', '皮卡', '人工搬运'] as const
export type VehicleType = (typeof VEHICLE_TYPES)[number]

/** 车辆单趟可运蜂箱数（当日运力容量按同车型同日期累计校验） */
export const VEHICLE_CAPACITY_BOXES: Record<VehicleType, number> = {
  厢式货车: 40,
  农用三轮: 12,
  皮卡: 20,
  人工搬运: 6
}

/** 路线段执行状态：已执行段保留实际记录，重算时整段保留，只算未执行段 */
export type RouteLegStatus = 'done' | 'pending'
/** 路线版本状态 */
export type RouteVersionStatus = 'draft' | 'published' | 'invalid'

/** 冻结的途经投放点（发布时快照，之后投放点改坐标/删除均不影响留档版本） */
export interface FrozenStop {
  dropId: string
  /** 发布时刻编号冗余，便于留档展示 */
  code: string
  longitude: number
  latitude: number
}

/** RouteVersion 路线版本头：一次发布冻结顺序、坐标、首段时刻与预计里程 */
export interface RouteVersion {
  id: string
  /** 路线链 id：同一季内同一条转场路线的各版本归为一条链 */
  chainId: string
  /** 链内自增版本号，首版为 1 */
  version: number
  status: RouteVersionStatus
  vehicleType: VehicleType
  /** 首段出发时刻（冻结） */
  departAt: string
  /** 途经投放点顺序（冻结 id 顺序，坐标另存 stops 快照） */
  stopIds: string[]
  /** 途经投放点坐标快照（冻结） */
  stops: FrozenStop[]
  /** 预计总里程（km，冻结） */
  totalDistanceKm: number
  riskNote: string
  /** 依据指纹：stopIds + 现行坐标，用于检测投放点坐标/顺序依据是否变化 */
  basisHash: string
  /** 失效原因（依据变化时记录变化明细） */
  invalidReason: string
  createdAt: string
  publishedAt: string
  invalidatedAt: string
}

/** TransitRoute 转场路线段（归属于某个路线版本） */
export interface TransitRoute {
  id: string
  /** 所属路线版本 */
  versionId: string
  /** 链 id（便于按链查询历史段） */
  chainId: string
  /** 链内版本号（冻结，导出/总表按同一版本读取） */
  version: number
  /** 段在版本内的顺序，从 0 起 */
  seq: number
  /** 出发投放点 */
  fromDropId: string
  /** 到达投放点 */
  toDropId: string
  /** 冻结坐标：发布后投放点改坐标/删除，留档段仍按原坐标展示 */
  fromLongitude: number
  fromLatitude: number
  toLongitude: number
  toLatitude: number
  /** 预计里程（km，冻结） */
  distanceKm: number
  /** 预计耗时（小时） */
  durationH: number
  vehicleType: VehicleType
  /** 首段出发时刻（每段冗余冻结值，统一取版本首段时刻） */
  departAt: string
  /** 途中风险备注 */
  riskNote: string
  /** 段执行状态 */
  legStatus: RouteLegStatus
  /** 实际转场记录 */
  actualNote: string
  /** 版本状态冗余（published/invalid），便于总表、导出过滤同一生效版本 */
  versionStatus: RouteVersionStatus
}
