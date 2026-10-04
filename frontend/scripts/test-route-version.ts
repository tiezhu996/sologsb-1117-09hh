import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import Dexie from 'dexie'

import { BeeRouteDb, SCHEMA_VERSION } from '../src/hooks/usePersistentStore'
import type { BeeColony, DropPoint, RoutePlan } from '../src/types'
import { RoutePublishError } from '../src/types'
import { bindRouteDb, routeStore } from '../src/stores/routeStore'
import { isExecutedLeg, buildLegs, buildWaypoints, computeFingerprint, legsDistance, planDocId } from '../src/utils/routePlan'

let db: BeeRouteDb

async function freshDb(name: string): Promise<void> {
  await Dexie.delete(name)
  db = new BeeRouteDb(name)
  bindRouteDb(db)
  routeStore.setState({ plans: [], activeLegs: [], activePlan: null, draft: null, basisChanges: [], loaded: false })
}

const points: DropPoint[] = [
  {
    id: 'dp1',
    orchardId: 'o1',
    longitude: 107.1,
    latitude: 34.1,
    code: 'P1',
    capacityBoxes: 8,
    shade: '',
    waterDistance: 10,
    dropWindow: '2026-04-01',
    withdrawTime: '2026-04-10',
    owner: '甲',
    colonyCodes: ['Q-1']
  },
  {
    id: 'dp2',
    orchardId: 'o2',
    longitude: 107.2,
    latitude: 34.2,
    code: 'P2',
    capacityBoxes: 8,
    shade: '',
    waterDistance: 10,
    dropWindow: '2026-04-01',
    withdrawTime: '2026-04-10',
    owner: '乙',
    colonyCodes: ['Q-2']
  },
  {
    id: 'dp3',
    orchardId: 'o3',
    longitude: 107.3,
    latitude: 34.3,
    code: 'P3',
    capacityBoxes: 8,
    shade: '',
    waterDistance: 10,
    dropWindow: '2026-04-01',
    withdrawTime: '2026-04-10',
    owner: '丙',
    colonyCodes: []
  }
]

const colonies: BeeColony[] = [
  {
    id: 'c1',
    code: 'Q-1',
    species: '意蜂',
    strengthFrames: 8,
    boxType: '平箱',
    currentOrchardId: '',
    status: '待投放',
    lastCheckDate: '2026-04-01',
    healthNote: ''
  },
  {
    id: 'c2',
    code: 'Q-2',
    species: '意蜂',
    strengthFrames: 8,
    boxType: '平箱',
    currentOrchardId: '',
    status: '待投放',
    lastCheckDate: '2026-04-01',
    healthNote: ''
  }
]

async function seedScenarioData(): Promise<void> {
  await db.dropPoints.bulkPut(points)
  await db.colonies.bulkPut(colonies)
}

const META = { vehicleType: '厢式货车' as const, departAt: '2026-04-05T06:30', riskNote: '坡道' }

afterEach(async () => {
  await db.close()
})

test('首次发布：冻结顺序/坐标/首段时刻/里程，生成 v1', async () => {
  await freshDb('test-publish')
  await seedScenarioData()

  await routeStore.getState().saveDraft(['dp1', 'dp2'], META)
  const result = await routeStore.getState().publishDraft()

  assert.equal(result.created, true)
  assert.equal(result.plan.version, 1)
  assert.equal(result.plan.status, 'published')
  const state = routeStore.getState()
  assert.deepEqual(state.activePlan!.waypoints.map((w) => w.dropId), ['dp1', 'dp2'])
  assert.deepEqual(
    state.activeLegs.map((leg) => [leg.fromLng, leg.toLng]),
    [
      [107.1, 107.2]
    ]
  )
  assert.equal(state.activePlan!.departAt, META.departAt)
  assert.ok(state.activePlan!.totalDistanceKm > 0)
  assert.equal(state.draft, null)
  // routes 表段带版本归属
  const legRows = await db.routes.toArray()
  assert.ok(legRows.every((leg) => leg.routeId === result.plan.routeId && leg.version === 1))
})

test('依据变化：投放点挪动 → 检测失效原因；确认重算 + 发布生成 v2，旧版留档 superseded', async () => {
  await freshDb('test-recalc')
  await seedScenarioData()
  await routeStore.getState().saveDraft(['dp1', 'dp2'], META)
  const v1 = (await routeStore.getState().publishDraft()).plan

  // 回填实际记录：第 1 段已执行
  await routeStore.getState().recordActual(v1.legs[0].id, '06:35 完成，比预计快')
  assert.equal(isExecutedLeg(routeStore.getState().activeLegs[0]), true)

  // 换季挪动 dp2
  await db.dropPoints.update('dp2', { longitude: 107.25, latitude: 34.25 })
  await routeStore.getState().hydrate()
  const movedPoints = await db.dropPoints.toArray()
  routeStore.getState().refreshBasisChanges(movedPoints)
  const reasons = routeStore.getState().basisChanges
  assert.ok(reasons.some((text) => text.includes('P2') && text.includes('挪动')))

  // 确认重算 → 草稿（未发布前旧版本仍生效）
  await routeStore.getState().confirmRecalculate()
  assert.equal(routeStore.getState().activePlan!.version, 1)
  assert.ok(routeStore.getState().draft)

  // 发布 → v2，旧版留档
  const v2Result = await routeStore.getState().publishDraft()
  assert.equal(v2Result.created, true)
  assert.equal(v2Result.plan.version, 2)
  const state = routeStore.getState()
  const archived = state.plans.filter((plan) => plan.status === 'superseded')
  assert.equal(archived.length, 1)
  assert.equal(archived[0].version, 1)
  assert.ok(archived[0].supersededReason.includes('挪动'))
  // 已执行段保留实际记录，新坐标未改起终点，里程沿用已执行记录
  assert.equal(state.activeLegs[0].actualNote, '06:35 完成，比预计快')
  assert.equal(state.activeLegs[0].distanceKm, v1.legs[0].distanceKm)
})

test('只算未执行段：新增投放点后，已执行段不动，未执行段按新点重算', async () => {
  await freshDb('test-pending-only')
  await seedScenarioData()
  await routeStore.getState().saveDraft(['dp1', 'dp2'], META)
  await routeStore.getState().publishDraft()
  const v1Legs = routeStore.getState().activeLegs
  await routeStore.getState().recordActual(v1Legs[0].id, '已执行 A→B')

  // 草稿顺序变为 dp1→dp2→dp3（dp1→dp2 已执行保留，dp2→dp3 新增重算）
  await routeStore.getState().saveDraft(['dp1', 'dp2', 'dp3'], META)
  const v2 = (await routeStore.getState().publishDraft()).plan

  assert.equal(v2.legs.length, 2)
  assert.equal(v2.legs[0].actualNote, '已执行 A→B')
  assert.equal(v2.legs[0].seq, 0)
  assert.equal(v2.legs[1].actualNote, '待执行')
  assert.equal(v2.legs[1].fromDropId, 'dp2')
  assert.equal(v2.legs[1].toDropId, 'dp3')
  assert.ok(v2.legs[1].distanceKm > 0)
})

test('重复确认幂等：同一顺序/坐标/时刻/里程再发布不新增版本', async () => {
  await freshDb('test-idempotent')
  await seedScenarioData()
  await routeStore.getState().saveDraft(['dp1', 'dp2'], META)
  const first = await routeStore.getState().publishDraft()
  assert.equal(first.created, true)

  // 再保存一份相同草稿并发布
  await routeStore.getState().saveDraft(['dp1', 'dp2'], META)
  const second = await routeStore.getState().publishDraft()
  assert.equal(second.created, false)
  assert.equal(second.plan.version, 1)
  assert.equal(routeStore.getState().plans.filter((p) => p.status === 'published').length, 1)
  assert.equal(routeStore.getState().plans.filter((p) => p.status === 'superseded').length, 0)
})

test('运力不足拒绝发布：同车型同日已有其它路线占用，合计超容量时拒绝并保留草稿', async () => {
  await freshDb('test-capacity')
  await seedScenarioData()
  const pointsNow = await db.dropPoints.toArray()
  const dateKey = '2026-04-05'

  // 直接落一条「其它路线」的已发布版本（同日 · 人工搬运 · 占 2 箱位 Q-1/Q-2）
  const otherMeta = { ...META, vehicleType: '人工搬运' as const }
  const otherWp = buildWaypoints(['dp1', 'dp2'], pointsNow)
  const otherLegs = buildLegs('rt_other', 1, otherWp, otherMeta)
  const otherTotal = legsDistance(otherWp).total
  const otherPlan: RoutePlan = {
    id: planDocId('rt_other', 1),
    routeId: 'rt_other',
    version: 1,
    status: 'published',
    waypoints: otherWp,
    legs: otherLegs,
    vehicleType: '人工搬运',
    departAt: `${dateKey}T05:00`,
    riskNote: '',
    totalDistanceKm: otherTotal,
    publishedAt: new Date().toISOString(),
    supersededReason: '',
    fingerprint: computeFingerprint({ waypoints: otherWp, departAt: `${dateKey}T05:00`, vehicleType: '人工搬运', totalDistanceKm: otherTotal })
  }
  await db.routePlans.put(otherPlan)
  await db.routes.bulkPut(otherLegs)
  await routeStore.getState().hydrate()

  // 给 dp3 加 5 群，使新路线（dp1→dp3）需求达到 6 箱位，加上其它路线 2 → 8 > 人工搬运 6
  const extraColonies: BeeColony[] = ['Q-9', 'Q-10', 'Q-11', 'Q-12', 'Q-13'].map((code, idx) => ({
    id: `cx${idx}`,
    code,
    species: '意蜂',
    strengthFrames: 6,
    boxType: '平箱',
    currentOrchardId: '',
    status: '待投放',
    lastCheckDate: '2026-04-01',
    healthNote: ''
  }))
  await db.colonies.bulkPut(extraColonies)
  await db.dropPoints.update('dp3', { colonyCodes: ['Q-9', 'Q-10', 'Q-11', 'Q-12', 'Q-13'] })

  // 当前生效是 rt_other；让新草稿成为另一条逻辑路线（模拟换季新增路线）
  const nextPoints = await db.dropPoints.toArray()
  const wp = buildWaypoints(['dp1', 'dp3'], nextPoints)
  const meta = { vehicleType: '人工搬运' as const, departAt: `${dateKey}T08:00`, riskNote: '' }
  const legs0 = buildLegs('rt_new', 0, wp, meta)
  const total0 = legsDistance(wp).total
  const newDraft: RoutePlan = {
    id: planDocId('rt_new', 0),
    routeId: 'rt_new',
    version: 0,
    status: 'draft',
    waypoints: wp,
    legs: legs0,
    vehicleType: '人工搬运',
    departAt: meta.departAt,
    riskNote: '',
    totalDistanceKm: total0,
    publishedAt: '',
    supersededReason: '',
    fingerprint: computeFingerprint({ waypoints: wp, departAt: meta.departAt, vehicleType: '人工搬运', totalDistanceKm: total0 })
  }
  await db.routePlans.put(newDraft)
  await db.routes.bulkPut(legs0)
  await routeStore.getState().hydrate()

  await assert.rejects(
    () => routeStore.getState().publishDraft(),
    (error: unknown) => error instanceof RoutePublishError && error.code === 'CAPACITY_EXCEEDED'
  )
  // 拒绝后其它路线仍生效，草稿保留（即「恢复草稿」）
  const state = routeStore.getState()
  assert.equal(state.activePlan!.routeId, 'rt_other')
  assert.ok(state.draft)
  assert.equal(state.draft!.routeId, 'rt_new')
  // 其它路线未被错误标记失效
  const otherDoc = await db.routePlans.get(otherPlan.id)
  assert.equal(otherDoc!.status, 'published')
})

test('发布失败恢复草稿：事务抛错后旧版本仍在、草稿保留', async () => {
  await freshDb('test-rollback')
  await seedScenarioData()
  await routeStore.getState().saveDraft(['dp1', 'dp2'], META)
  await routeStore.getState().publishDraft()
  const before = routeStore.getState().activePlan!

  // 新草稿
  await routeStore.getState().saveDraft(['dp1', 'dp2', 'dp3'], META)

  // 让发布事务中途失败：把 routePlans 表的 put 打桩抛错
  const originalPut = db.routePlans.put.bind(db.routePlans)
  let calls = 0
  db.routePlans.put = ((...args: unknown[]) => {
    calls += 1
    const doc = args[0] as RoutePlan
    if (doc && (doc as RoutePlan).status === 'published' && (doc as RoutePlan).version === 2) {
      throw new Error('forced write failure')
    }
    return originalPut(...(args as [RoutePlan]))
  }) as typeof db.routePlans.put

  await assert.rejects(
    () => routeStore.getState().publishDraft(),
    (error: unknown) => error instanceof RoutePublishError && error.code === 'DB_ERROR'
  )
  db.routePlans.put = originalPut
  assert.ok(calls > 0)

  const state = routeStore.getState()
  // v1 仍生效
  assert.equal(state.activePlan!.version, 1)
  assert.equal(state.activePlan!.id, before.id)
  // 没有遗留 v2 文档（事务已回滚）
  const v2 = await db.routePlans.where('version').equals(2).toArray()
  assert.equal(v2.length, 0)
  // 草稿仍在（恢复草稿）
  assert.ok(state.draft)
  assert.equal(state.draft!.waypoints.length, 3)
  // v1 未被错误标记失效
  const v1Doc = await db.routePlans.get(before.id)
  assert.equal(v1Doc!.status, 'published')
})

test('旧数据升级补首版：v2 时代的 routes 迁移为已发布 v1（坐标/里程冻结）', async () => {
  const name = 'test-upgrade'
  await Dexie.delete(name)
  // 用裸 Dexie 直接建 v2 结构并写旧数据（模拟老用户库）
  const oldDb = new Dexie(name)
  oldDb.version(2).stores({
    orchards: 'id, name, crop, bloomStart',
    colonies: 'id, code, status, currentOrchardId',
    dropPoints: 'id, orchardId, code, dropWindow',
    routes: 'id, fromDropId, toDropId, departAt',
    meta: 'key'
  })
  await oldDb.table('dropPoints').bulkAdd([
    {
      id: 'dp1',
      orchardId: 'o1',
      longitude: 107.1,
      latitude: 34.1,
      code: 'P1',
      capacityBoxes: 8,
      shade: '',
      waterDistance: 1,
      dropWindow: '2026-04-01',
      withdrawTime: '2026-04-10',
      owner: '',
      colonyCodes: []
    },
    {
      id: 'dp2',
      orchardId: 'o2',
      longitude: 107.2,
      latitude: 34.2,
      code: 'P2',
      capacityBoxes: 8,
      shade: '',
      waterDistance: 1,
      dropWindow: '2026-04-01',
      withdrawTime: '2026-04-10',
      owner: '',
      colonyCodes: []
    }
  ])
  await oldDb.table('routes').bulkAdd([
    {
      id: 'legacy-1',
      fromDropId: 'dp1',
      toDropId: 'dp2',
      distanceKm: 15.3,
      durationH: 0.73,
      vehicleType: '皮卡',
      departAt: '2026-04-05T07:00',
      riskNote: '旧备注',
      actualNote: '待执行'
    }
  ])
  oldDb.close()

  // 用当前 schema 打开 → 触发升级
  db = new BeeRouteDb(name)
  bindRouteDb(db)
  assert.equal(db.verno, SCHEMA_VERSION)
  await routeStore.getState().hydrate()
  const plan = routeStore.getState().activePlan!
  assert.ok(plan)
  assert.equal(plan.version, 1)
  assert.equal(plan.status, 'published')
  assert.deepEqual(plan.waypoints.map((w) => [w.dropId, w.longitude, w.latitude]), [
    ['dp1', 107.1, 34.1],
    ['dp2', 107.2, 34.2]
  ])
  assert.equal(plan.totalDistanceKm, 15.3)
  assert.equal(plan.legs[0].departAt, '2026-04-05T07:00')
  assert.equal(plan.legs[0].riskNote, '旧备注')
})

test('不同日期的同车型路线容量互不占用', async () => {
  await freshDb('test-different-day')
  await seedScenarioData()
  await routeStore.getState().saveDraft(['dp1', 'dp2'], { ...META, vehicleType: '人工搬运' })
  await routeStore.getState().publishDraft()
  // 次日再发一条，容量独立计算 → 可发布
  await routeStore.getState().saveDraft(['dp1', 'dp2'], { ...META, vehicleType: '人工搬运', departAt: '2026-04-06T07:00' })
  const result = await routeStore.getState().publishDraft()
  assert.equal(result.created, true)
})
