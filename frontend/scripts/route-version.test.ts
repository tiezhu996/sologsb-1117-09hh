import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { db, seedDemoData, stampDbVersion, SCHEMA_VERSION } from '../src/hooks/usePersistentStore'
import { routeStore, CapacityExceededError, UnchangedConfirmError } from '../src/stores/routeStore'
import { droppointStore } from '../src/stores/droppointStore'
import type { DropPoint, RouteVersion, TransitRoute } from '../src/types'

let passed = 0
function check(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function reset(): Promise<void> {
  if (db.isOpen()) await db.close()
  await db.delete()
  await db.open() // delete 会关闭连接，显式重开到 v3
  await seedDemoData()
  await stampDbVersion()
  // 清掉 demo 自带的已发布路线，测试在一条全新链上演进（地块/投放点/蜂群保留）
  await db.table('routes').clear()
  await db.table('routeVersions').clear()
  await droppointStore.getState().hydrate()
  await routeStore.getState().hydrate()
}

/** 旧数据升级：在 v2 结构下写一批散装段，再以 v3 实例打开验证补首版（全程用独立实例，避免单例版本抖动） */
async function testLegacyUpgrade(): Promise<void> {
  const Dexie = (await import('dexie')).default
  // 干净的 v2 库
  const seedDb = new Dexie('gbbeeroute')
  seedDb.version(2).stores({
    orchards: 'id, name, crop, bloomStart',
    colonies: 'id, code, status, currentOrchardId',
    dropPoints: 'id, orchardId, code, dropWindow',
    routes: 'id, fromDropId, toDropId, departAt',
    meta: 'key'
  })
  await seedDb.table('dropPoints').bulkPut([
    { id: 'p1', orchardId: 'o1', longitude: 107.1, latitude: 34.1, code: 'P1', capacityBoxes: 8, shade: '', waterDistance: 10, dropWindow: '2026-04-01', withdrawTime: '2026-04-10', owner: '', colonyCodes: ['Q-1'] },
    { id: 'p2', orchardId: 'o1', longitude: 107.2, latitude: 34.2, code: 'P2', capacityBoxes: 8, shade: '', waterDistance: 10, dropWindow: '2026-04-01', withdrawTime: '2026-04-10', owner: '', colonyCodes: [] },
    { id: 'p3', orchardId: 'o1', longitude: 107.3, latitude: 34.3, code: 'P3', capacityBoxes: 8, shade: '', waterDistance: 10, dropWindow: '2026-04-01', withdrawTime: '2026-04-10', owner: '', colonyCodes: [] }
  ])
  await seedDb.table('routes').bulkPut([
    { id: 'old1', fromDropId: 'p1', toDropId: 'p2', distanceKm: 12.3, durationH: 0.63, vehicleType: '皮卡', departAt: '2026-04-05T06:00', riskNote: 'r', actualNote: '待执行' },
    { id: 'old2', fromDropId: 'p2', toDropId: 'p3', distanceKm: 12.3, durationH: 0.63, vehicleType: '皮卡', departAt: '2026-04-05T06:00', riskNote: 'r', actualNote: '已于 4/5 执行完成' }
  ])
  await seedDb.close()

  // 以 v3 结构的全新实例打开 → 自动迁移；直接从该实例校验，不经过单例 db
  const { BeeRouteDb } = await import('../src/hooks/usePersistentStore')
  const v3 = new BeeRouteDb()
  await v3.open()
  const versions = await v3.table('routeVersions').toArray()
  const legs = await v3.table('routes').toArray()
  check('旧数据升级补首版（1 个版本头 v1 published）', () => {
    assert.equal(versions.length, 1)
    assert.equal(versions[0].version, 1)
    assert.equal(versions[0].status, 'published')
    assert.deepEqual(versions[0].stopIds, ['p1', 'p2', 'p3'])
    assert.ok(versions[0].stops.length === 3, '冻结 3 个停靠点坐标')
    assert.ok(versions[0].totalDistanceKm > 0)
  })
  check('旧段补齐版本归属/段序/冻结坐标/执行状态', () => {
    assert.equal(legs.length, 2)
    const l1 = legs.find((x: TransitRoute) => x.id === 'old1')!
    const l2 = legs.find((x: TransitRoute) => x.id === 'old2')!
    assert.equal(l1.version, 1)
    assert.equal(l1.seq, 0)
    assert.equal(l1.versionStatus, 'published')
    assert.equal(l1.legStatus, 'pending')
    assert.equal(l1.fromLongitude, 107.1)
    assert.equal(l2.legStatus, 'done', '有实际记录的段标记已执行')
    assert.equal(l2.actualNote, '已于 4/5 执行完成')
  })
  await v3.close()
  // 清掉升级演示库，并把模块单例重新打开到干净的 v3，供后续用例使用
  const wiper = new Dexie('gbbeeroute')
  await wiper.delete()
  await db.open()
  assert.ok(db.isOpen(), '单例已重新打开')
}

async function main(): Promise<void> {
  console.log(`schemaVersion = ${SCHEMA_VERSION}`)

  console.log('■ 旧数据升级')
  await testLegacyUpgrade()
  await reset()
  const store = routeStore.getState()
  const dpStore = droppointStore.getState()
  const points = dpStore.rows

  console.log('■ 首次发布')
  let head = await store.saveDraft({
    stopIds: ['dp_b01', 'dp_c01'],
    vehicleType: '农用三轮',
    departAt: '2026-04-13T06:30',
    riskNote: '坡道窄'
  })
  check('保存草稿后不影响现场生效版本（尚无 published）', () => {
    assert.equal(routeStore.getState().current, null)
    assert.equal(routeStore.getState().draft?.status, 'draft')
  })
  head = await store.publishDraft()
  await routeStore.getState().hydrate()
  check('发布冻结：版本头 v1 published，段为同版本', () => {
    assert.equal(head.version, 1)
    assert.equal(head.status, 'published')
    assert.deepEqual(head.stopIds, ['dp_b01', 'dp_c01'])
    assert.equal(head.departAt, '2026-04-13T06:30')
    assert.ok(head.totalDistanceKm > 0)
    assert.ok(head.basisHash.length > 0)
    const rows = routeStore.getState().rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].version, 1)
    assert.equal(rows[0].versionStatus, 'published')
  })

  console.log('■ 重复确认不新增版本')
  await store.saveDraft({
    stopIds: ['dp_b01', 'dp_c01'],
    vehicleType: '农用三轮',
    departAt: '2026-04-13T06:30',
    riskNote: '坡道窄'
  })
  await assert.rejects(
    () => routeStore.getState().publishDraft(),
    (err: unknown) => err instanceof UnchangedConfirmError,
    '应抛 UnchangedConfirmError'
  )
  await routeStore.getState().hydrate()
  check('拒绝后版本号仍是 v1（不新增）', () => {
    const published = routeStore.getState().versions.filter((v) => v.status === 'published')
    assert.equal(published.length, 1)
    assert.equal(published[0].version, 1)
  })

  console.log('■ 运力不足拒绝发布')
  // 农用三轮容量 12 箱；让到达点安排 13 个群号 > 12
  const c = points.find((p) => p.id === 'dp_c01')!
  const many: DropPoint = { ...c, colonyCodes: Array.from({ length: 13 }, (_, i) => `Q-${i}`) }
  await droppointStore.getState().save(many)
  await routeStore.getState().detectDrift() // 群号变化不影响坐标指纹；坐标未变，版本仍 published
  await routeStore.getState().saveDraft({
    stopIds: ['dp_b01', 'dp_c01'],
    vehicleType: '农用三轮',
    departAt: '2026-04-20T06:30',
    riskNote: '超载测试'
  })
  // 上面 draft 与 current 依据一致但日期不同 → 非 unchanged；运力应拦截
  await assert.rejects(
    () => routeStore.getState().publishDraft(),
    (err: unknown) => err instanceof CapacityExceededError && err.issue.demanded >= 13,
    '应抛 CapacityExceededError'
  )
  await routeStore.getState().hydrate()
  const draftAfterFail = routeStore.getState().draft
  check('发布失败恢复草稿（草稿仍在，无新版本，旧 v1 仍生效）', () => {
    assert.ok(draftAfterFail, '草稿保留')
    const published = routeStore.getState().versions.filter((v) => v.status === 'published')
    assert.equal(published.length, 1)
    assert.equal(routeStore.getState().current?.version, 1)
  })
  // 恢复群号
  await droppointStore.getState().save({ ...many, colonyCodes: ['Q-02'] })
  await store.discardDraft()

  console.log('■ 依据变化 → 旧版失效留档，确认重算出新版（已执行段保留）')
  // 回填第一段实际记录并标记已执行
  const v1Legs = await db.table<TransitRoute>('routes').where('versionId').equals(head.id).toArray()
  await store.recordActual(v1Legs[0].id, '06:35 发车，已顺利到达', true)
  // 挪动 dp_c01 坐标（换季临时挪投放点）
  const moved: DropPoint = { ...c, longitude: c.longitude + 0.05, latitude: c.latitude + 0.04, colonyCodes: ['Q-02'] }
  await droppointStore.getState().save(moved)
  const drifted = await routeStore.getState().detectDrift()
  check('旧版本留档并标记失效', () => {
    assert.equal(drifted, true)
    const old = routeStore.getState().versions.find((v) => v.id === head.id)!
    assert.equal(old.status, 'invalid')
    assert.ok(old.invalidReason.includes('坐标'), `失效原因含坐标：${old.invalidReason}`)
    assert.ok(old.invalidatedAt)
    // 留档段仍在、冻结坐标未被覆盖
  })
  check('当前生效版本清空（总表/导出读到 rows 为空，不再展示旧绕路）', () => {
    assert.equal(routeStore.getState().current, null)
    assert.deepEqual(routeStore.getState().rows, [])
  })
  const frozenLeg = (await db.table<TransitRoute>('routes').get(v1Legs[0].id)) as TransitRoute
  check('留档段冻结坐标仍是旧值，实际记录保留', () => {
    assert.equal(frozenLeg.toLongitude, 107.3741)
    assert.equal(frozenLeg.actualNote, '06:35 发车，已顺利到达')
    assert.equal(frozenLeg.legStatus, 'done')
    assert.equal(frozenLeg.versionStatus, 'invalid')
  })

  // 确认重算（不新增 published，先生成草稿）
  const draftV2 = await store.confirmRecalculate(head.id)
  await routeStore.getState().hydrate()
  check('重算草稿为 v2，且已执行段保留、只算未执行段', () => {
    assert.equal(draftV2.version, 2)
    assert.equal(draftV2.status, 'draft')
    const dLegs = routeStore.getState().draftLegs
    assert.equal(dLegs.length, 1, '两点一段')
    assert.equal(dLegs[0].legStatus, 'done', '唯一一段已执行，前缀整段保留')
    assert.equal(dLegs[0].actualNote, '06:35 发车，已顺利到达')
    // 已执行段里程保留旧值
    assert.equal(dLegs[0].distanceKm, frozenLeg.distanceKm)
  })

  // 发布 v2
  const head2 = await routeStore.getState().publishDraft()
  await routeStore.getState().hydrate()
  check('发布后 v2 生效，v1 仍留档失效；总表/路线表/导出读同一 v2', () => {
    assert.equal(head2.version, 2)
    assert.equal(head2.status, 'published')
    assert.equal(routeStore.getState().current?.id, head2.id)
    const rows = routeStore.getState().rows
    assert.ok(rows.every((r) => r.version === 2 && r.versionStatus === 'published'))
    const archived = routeStore.getState().versions.find((v) => v.id === head.id)!
    assert.equal(archived.status, 'invalid')
  })

  console.log('■ 未执行段重算场景（3 点：第 1 段已执行，尾段重算）')
  await reset()
  // 3 点路线
  await routeStore.getState().saveDraft({
    stopIds: ['dp_a01', 'dp_b01', 'dp_c01'],
    vehicleType: '厢式货车',
    departAt: '2026-05-01T07:00',
    riskNote: ''
  })
  const h3 = await routeStore.getState().publishDraft()
  const legs3 = (await db.table<TransitRoute>('routes').where('versionId').equals(h3.id).toArray()).sort((a, b) => a.seq - b.seq)
  await routeStore.getState().recordActual(legs3[0].id, '第1段已跑', true) // a01->b01 done
  // 挪动尾点 c01
  const dpC = droppointStore.getState().rows.find((p) => p.id === 'dp_c01')!
  await droppointStore.getState().save({ ...dpC, longitude: dpC.longitude + 0.1, latitude: dpC.latitude + 0.1 })
  await routeStore.getState().detectDrift()
  const draftV4 = await routeStore.getState().confirmRecalculate(h3.id)
  await routeStore.getState().hydrate()
  check('保留已执行第1段（旧里程+实际记录），第2段按新坐标重算为未执行', () => {
    const dl = routeStore.getState().draftLegs
    assert.equal(dl.length, 2)
    assert.equal(dl[0].legStatus, 'done')
    assert.equal(dl[0].actualNote, '第1段已跑')
    assert.equal(dl[0].distanceKm, legs3[0].distanceKm)
    assert.equal(dl[1].legStatus, 'pending')
    assert.equal(dl[1].actualNote, '待执行')
    assert.notEqual(dl[1].distanceKm, legs3[1].distanceKm, '尾段里程已重算')
    assert.equal(draftV4.version, h3.version + 1)
  })

  console.log('\n全部通过 ✅', `${passed} 项断言`)
  process.exit(0)
}

main().catch((err) => {
  console.error('测试失败 ❌', err)
  console.error(err instanceof Error ? err.stack : '')
  process.exit(1)
})
