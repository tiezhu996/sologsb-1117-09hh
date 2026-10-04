import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Empty, Form, Input, Row, Select, Space, Table, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { DropPoint, RoutePlan, TransitRoute } from '@/types'
import { RoutePublishError, VEHICLE_DAILY_CAPACITY, VEHICLE_TYPES } from '@/types'
import RouteMap from '@/components/common/RouteMap'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { routeStore } from '@/stores/routeStore'
import { distanceKm, estimateDurationH, routeLegs } from '@/utils/geo'
import { isExecutedLeg, requiredBoxUnits } from '@/utils/routePlan'

function metaFromPlan(plan: RoutePlan | null): {
  vehicleType: TransitRoute['vehicleType']
  departAt: dayjs.Dayjs
  riskNote: string
} {
  return {
    vehicleType: plan?.vehicleType ?? '厢式货车',
    departAt: plan?.departAt ? dayjs(plan.departAt) : dayjs(),
    riskNote: plan?.riskNote ?? ''
  }
}

/** 转场路线规划：选点排顺序 → 保存草稿 → 发布冻结；依据变化后确认重算生成新版本 */
export default function RoutesPage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const plans = usePersistentStore(routeStore, (state) => state.plans)
  const activePlan = usePersistentStore(routeStore, (state) => state.activePlan)
  const activeLegs = usePersistentStore(routeStore, (state) => state.activeLegs)
  const draft = usePersistentStore(routeStore, (state) => state.draft)
  const basisChanges = usePersistentStore(routeStore, (state) => state.basisChanges)
  const [publishing, setPublishing] = useState(false)
  const [recalculating, setRecalculating] = useState(false)

  const [orderedIds, setOrderedIds] = useState<string[]>([])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [vehicleType, setVehicleType] = useState<TransitRoute['vehicleType']>('厢式货车')
  const [departAt, setDepartAt] = useState(dayjs())
  const [riskNote, setRiskNote] = useState('')

  /** 仅在草稿/生效版本身份（id）变化时回填编辑器，避免保存实际记录触发的水合打断编辑 */
  const editorSourceKey = useRef<string>('')
  useEffect(() => {
    const source = draft ?? activePlan
    const key = source ? source.id : ''
    if (key === editorSourceKey.current) return
    editorSourceKey.current = key
    if (!source) {
      setOrderedIds([])
      setVehicleType('厢式货车')
      setDepartAt(dayjs())
      setRiskNote('')
      return
    }
    setOrderedIds(source.waypoints.slice().sort((a, b) => a.seq - b.seq).map((item) => item.dropId))
    const meta = metaFromPlan(source)
    setVehicleType(meta.vehicleType)
    setDepartAt(meta.departAt)
    setRiskNote(meta.riskNote)
  }, [draft, activePlan])

  /** 依据变化检测：投放点挪动 / 删除后，生效路线自动标记失效依据 */
  useEffect(() => {
    routeStore.getState().refreshBasisChanges(dropPoints)
  }, [dropPoints, activePlan?.id])

  const ordered = useMemo(
    () => orderedIds.map((id) => dropPoints.find((item) => item.id === id)).filter((item): item is DropPoint => Boolean(item)),
    [orderedIds, dropPoints]
  )

  const legs = useMemo(() => routeLegs(ordered.map((item) => ({ longitude: item.longitude, latitude: item.latitude }))), [ordered])

  const dateKey = departAt.format('YYYY-MM-DD')
  const demand = useMemo(() => requiredBoxUnits(orderedIds, dropPoints, colonies), [orderedIds, dropPoints, colonies])
  const capacity = VEHICLE_DAILY_CAPACITY[vehicleType]
  const usedByOthers = useMemo(
    () =>
      plans
        .filter((plan) => plan.status === 'published' && plan.routeId !== (draft?.routeId ?? activePlan?.routeId))
        .filter((plan) => plan.vehicleType === vehicleType && plan.departAt.slice(0, 10) === dateKey)
        .reduce((sum, plan) => sum + requiredBoxUnits(plan.waypoints.map((item) => item.dropId), dropPoints, colonies), 0),
    [plans, vehicleType, dateKey, dropPoints, colonies, draft?.routeId, activePlan?.routeId]
  )
  const capacityOk = demand + usedByOthers <= capacity

  const historyPlans = useMemo(
    () => plans.filter((plan) => plan.status === 'superseded').sort((a, b) => b.version - a.version),
    [plans]
  )

  function orchardName(orchardId: string): string {
    return orchards.find((item) => item.id === orchardId)?.name ?? '未知地块'
  }

  function addPoint(id: string): void {
    if (orderedIds.includes(id)) {
      message.info('该投放点已在顺序中')
      return
    }
    setOrderedIds((prev) => [...prev, id])
  }

  function removePoint(id: string): void {
    setOrderedIds((prev) => prev.filter((item) => item !== id))
  }

  function move(index: number, direction: -1 | 1): void {
    const target = index + direction
    if (target < 0 || target >= orderedIds.length) return
    const next = [...orderedIds]
    const temp = next[index]
    next[index] = next[target]
    next[target] = temp
    setOrderedIds(next)
  }

  function handleDrop(targetId: string): void {
    if (!draggingId || draggingId === targetId) return
    setOrderedIds((prev) => {
      const next = prev.filter((item) => item !== draggingId)
      const index = next.indexOf(targetId)
      next.splice(index < 0 ? next.length : index, 0, draggingId)
      return next
    })
    setDraggingId(null)
  }

  function currentMeta(): { vehicleType: TransitRoute['vehicleType']; departAt: string; riskNote: string } {
    return { vehicleType, departAt: departAt.format('YYYY-MM-DDTHH:mm'), riskNote: riskNote.trim() }
  }

  async function saveDraft(): Promise<boolean> {
    if (orderedIds.length < 2) {
      message.warning('至少选择 2 个投放点才能生成转场路线')
      return false
    }
    try {
      await routeStore.getState().saveDraft(orderedIds, currentMeta())
      message.success('草稿已保存，尚未发布')
      return true
    } catch (error) {
      message.error(error instanceof RoutePublishError ? error.message : '草稿保存失败')
      return false
    }
  }

  async function publish(): Promise<void> {
    if (orderedIds.length < 2) {
      message.warning('至少选择 2 个投放点才能发布路线')
      return
    }
    if (!capacityOk) {
      message.error(`${vehicleType} ${dateKey} 当日运力 ${capacity} 箱位，已排 ${usedByOthers}，本路线需 ${demand}，容量不足，拒绝发布`)
      return
    }
    setPublishing(true)
    try {
      // 先落草稿（发布失败时它就是恢复点），再走发布事务
      const ok = await saveDraft()
      if (!ok) return
      const result = await routeStore.getState().publishDraft()
      if (result.created) {
        const kept = result.plan.legs.filter((leg) => isExecutedLeg(leg)).length
        message.success(
          `已发布 v${result.plan.version}：冻结 ${result.plan.waypoints.length} 个投放点顺序与坐标、首段时刻 ${result.plan.departAt}、预计里程 ${result.plan.totalDistanceKm} km` +
            (kept > 0 ? `；保留 ${kept} 段已执行记录，仅重算未执行段` : '')
        )
      } else {
        message.info('与当前生效版本完全一致（顺序/坐标/首段时刻/里程均未变），重复确认不新增版本')
      }
    } catch (error) {
      if (error instanceof RoutePublishError) {
        message.error(`发布失败，已恢复草稿：${error.message}`)
      } else {
        message.error('发布失败，已恢复草稿')
      }
    } finally {
      setPublishing(false)
    }
  }

  async function confirmRecalculate(): Promise<void> {
    setRecalculating(true)
    try {
      const nextDraft = await routeStore.getState().confirmRecalculate()
      setOrderedIds(nextDraft.waypoints.slice().sort((a, b) => a.seq - b.seq).map((item) => item.dropId))
      setVehicleType(nextDraft.vehicleType)
      setDepartAt(dayjs(nextDraft.departAt))
      setRiskNote(nextDraft.riskNote)
      message.success('已按当前投放点坐标重算草稿：已执行段保留实际记录，仅重算未执行段；核对后发布才会生成新版本')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重算失败')
    } finally {
      setRecalculating(false)
    }
  }

  async function discardDraft(): Promise<void> {
    await routeStore.getState().discardDraft()
    message.info('草稿已放弃')
  }

  async function saveActual(leg: TransitRoute, value: string): Promise<void> {
    await routeStore.getState().recordActual(leg.id, value)
    message.success(`段 ${leg.seq + 1} 实际记录已保存`)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">转场路线规划</h2>
          <p className="page-sub">
            选点排顺序后保存草稿；发布时冻结途经点顺序、坐标、首段时刻与预计里程。投放点换季挪动导致依据变化时，确认重算生成新版本，旧版本留档标记失效，已执行段保留实际记录。
          </p>
        </div>
        <Space>
          {activePlan ? (
            <Tag color="green">
              当前生效 v{activePlan.version} · 发布于 {dayjs(activePlan.publishedAt).format('YYYY-MM-DD HH:mm')}
            </Tag>
          ) : (
            <Tag>尚无已发布路线</Tag>
          )}
          {draft ? <Tag color="orange">草稿编辑中（未发布）</Tag> : null}
          <Button onClick={() => void saveDraft()}>保存草稿</Button>
          {draft ? (
            <Button danger onClick={() => void discardDraft()}>
              放弃草稿
            </Button>
          ) : null}
          <Button type="primary" loading={publishing} onClick={() => void publish()}>
            {activePlan ? '发布新版本' : '发布路线'}
          </Button>
        </Space>
      </div>

      {basisChanges.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`已发布的 v${activePlan?.version ?? 1} 路线依据已变化（投放点换季挪动/删除），现场坐标与冻结快照不一致，旧版本待留档失效`}
          description={
            <Space direction="vertical" align="start" size={6}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {basisChanges.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <Space>
                <Button type="primary" size="small" loading={recalculating} onClick={() => void confirmRecalculate()}>
                  确认重算
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  重算只生成草稿：已执行段保留实际记录，仅重算未执行段；核对无误点「发布新版本」后旧版本才留档失效。
                </Typography.Text>
              </Space>
            </Space>
          }
        />
      ) : null}

      <Row gutter={16}>
        <Col xs={24} xl={15}>
          <Card size="small" title="地图（投放点与转场折线；已发布路线按冻结坐标绘制）">
            <RouteMap
              orchards={orchards}
              dropPoints={dropPoints}
              routes={activeLegs}
              orderedDropIds={orderedIds}
              height={420}
              title="转场顺序预览"
            />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card size="small" title="投放点（点击加入转场顺序）" style={{ marginBottom: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              {dropPoints.map((point) => {
                const moved = activePlan?.waypoints.some((waypoint) => {
                  if (waypoint.dropId !== point.id) return false
                  return waypoint.longitude !== point.longitude || waypoint.latitude !== point.latitude
                })
                return (
                  <Space key={point.id} style={{ width: '100%', justifyContent: 'space-between' }}>
                    <span>
                      <Tag color="blue">{point.code}</Tag>
                      {orchardName(point.orchardId)} · 可容纳 {point.capacityBoxes} 箱 · 水源 {point.waterDistance} m
                      {moved ? <Tag color="warning" style={{ marginInlineStart: 6 }}>坐标已变</Tag> : null}
                    </span>
                    <Button size="small" onClick={() => addPoint(point.id)}>
                      加入顺序
                    </Button>
                  </Space>
                )
              })}
              {dropPoints.length === 0 ? <Empty description="暂无投放点，请先在果园地块管理中添加" /> : null}
            </Space>
          </Card>

          <Card
            size="small"
            title={`转场顺序（${ordered.length} 点 · 累计 ${legs.total} km）`}
            extra={
              <Button size="small" onClick={() => setOrderedIds([])}>
                清空顺序
              </Button>
            }
          >
            {ordered.length === 0 ? (
              <Typography.Text type="secondary">尚未选择投放点</Typography.Text>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                {ordered.map((point, index) => (
                  <div
                    key={point.id}
                    draggable
                    onDragStart={() => setDraggingId(point.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => handleDrop(point.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      border: '1px dashed #cfd9e2',
                      borderRadius: 8,
                      background: draggingId === point.id ? '#fff7e6' : '#fff',
                      cursor: 'grab'
                    }}
                  >
                    <Tag color="gold">第 {index + 1} 站</Tag>
                    <span style={{ flex: 1 }}>
                      {point.code} · {orchardName(point.orchardId)}
                      {index > 0 ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                          上一段 {distanceKm(ordered[index - 1], point)} km / 约 {estimateDurationH(distanceKm(ordered[index - 1], point))} h
                        </Typography.Text>
                      ) : null}
                    </span>
                    <Button size="small" disabled={index === 0} onClick={() => move(index, -1)}>
                      上移
                    </Button>
                    <Button size="small" disabled={index === ordered.length - 1} onClick={() => move(index, 1)}>
                      下移
                    </Button>
                    <Button size="small" danger type="link" onClick={() => removePoint(point.id)}>
                      移除
                    </Button>
                  </div>
                ))}
              </Space>
            )}
            <Form layout="vertical" style={{ marginTop: 12 }}>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="车辆类型" style={{ marginBottom: 8 }}>
                    <Select value={vehicleType} onChange={(value) => setVehicleType(value)} options={VEHICLE_TYPES.map((item) => ({ value: item, label: item }))} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="首段出发时刻（发布后冻结）" style={{ marginBottom: 8 }}>
                    <DatePicker showTime value={departAt} onChange={(value) => setDepartAt(value ?? dayjs())} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="途中风险备注" style={{ marginBottom: 8 }}>
                    <Input value={riskNote} onChange={(event) => setRiskNote(event.target.value)} placeholder="如 西沟坡道窄，雨天泥泞" />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
            <Tag color={capacityOk ? 'green' : 'red'} data-testid="capacity-tag">
              {dateKey} {vehicleType} 当日运力：{capacity} 箱位 ｜ 本路线 {demand} ｜ 同日已排 {usedByOthers}
              {capacityOk ? ' ｜ 可发布' : ' ｜ 容量不足，拒绝发布'}
            </Tag>
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        style={{ marginTop: 16 }}
        title={
          activePlan
            ? `生效路线 v${activePlan.version}（${activeLegs.length} 段 · 合计 ${activePlan.totalDistanceKm} km · 首段 ${activePlan.departAt}）`
            : '已发布的转场路线'
        }
      >
        {activePlan ? (
          <Table<TransitRoute>
            dataSource={activeLegs}
            rowKey="id"
            pagination={false}
            columns={[
              { title: '#', dataIndex: 'seq', key: 'seq', width: 50, render: (value: number) => value + 1 },
              {
                title: '出发（冻结坐标）',
                key: 'from',
                render: (_, record: TransitRoute) => {
                  const point = dropPoints.find((item) => item.id === record.fromDropId)
                  return point
                    ? `${point.code}（${orchardName(point.orchardId)}） ${record.fromLng.toFixed(4)},${record.fromLat.toFixed(4)}`
                    : `已删除点 ${record.fromDropId} ${record.fromLng.toFixed(4)},${record.fromLat.toFixed(4)}`
                }
              },
              {
                title: '到达（冻结坐标）',
                key: 'to',
                render: (_, record: TransitRoute) => {
                  const point = dropPoints.find((item) => item.id === record.toDropId)
                  return point
                    ? `${point.code}（${orchardName(point.orchardId)}） ${record.toLng.toFixed(4)},${record.toLat.toFixed(4)}`
                    : `已删除点 ${record.toDropId} ${record.toLng.toFixed(4)},${record.toLat.toFixed(4)}`
                }
              },
              { title: '里程（km）', dataIndex: 'distanceKm', key: 'km', width: 110 },
              { title: '预计耗时（h）', dataIndex: 'durationH', key: 'hour', width: 120 },
              { title: '车辆', dataIndex: 'vehicleType', key: 'vehicle', width: 100 },
              { title: '首段时刻', dataIndex: 'departAt', key: 'depart', width: 160 },
              { title: '风险备注', dataIndex: 'riskNote', key: 'risk', render: (value: string) => value || '—' },
              {
                title: '实际记录（已执行段重算时保留）',
                key: 'actual',
                width: 240,
                render: (_, record: TransitRoute) => <ActualNoteEditor leg={record} onSave={saveActual} />
              }
            ]}
          />
        ) : (
          <Empty description="尚无已发布路线，选点并发布后在此查看冻结版本" />
        )}
      </Card>

      {historyPlans.length > 0 ? (
        <Card size="small" style={{ marginTop: 16 }} title={`历史版本留档（${historyPlans.length} 个失效版本，只读）`}>
          <Table<RoutePlan>
            dataSource={historyPlans}
            rowKey="id"
            pagination={false}
            columns={[
              { title: '版本', dataIndex: 'version', key: 'version', width: 80, render: (value: number) => `v${value}` },
              { title: '状态', key: 'status', width: 100, render: () => <Tag color="red">已失效</Tag> },
              {
                title: '途经点顺序（冻结）',
                key: 'waypoints',
                render: (_, record: RoutePlan) =>
                  record.waypoints
                    .slice()
                    .sort((a, b) => a.seq - b.seq)
                    .map((item) => item.code)
                    .join(' → ')
              },
              { title: '里程（km）', dataIndex: 'totalDistanceKm', key: 'km', width: 110 },
              { title: '首段时刻', dataIndex: 'departAt', key: 'depart', width: 160 },
              { title: '发布时间', dataIndex: 'publishedAt', key: 'publishedAt', width: 160, render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm') },
              { title: '失效原因', dataIndex: 'supersededReason', key: 'reason' }
            ]}
          />
        </Card>
      ) : null}
    </div>
  )
}

function ActualNoteEditor({ leg, onSave }: { leg: TransitRoute; onSave: (leg: TransitRoute, value: string) => Promise<void> }): JSX.Element {
  const [value, setValue] = useState(leg.actualNote)
  const [saving, setSaving] = useState(false)
  const executed = isExecutedLeg(leg)
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Input
        size="small"
        value={value}
        status={executed ? undefined : 'warning'}
        onChange={(event) => setValue(event.target.value)}
        placeholder="回填实际转场情况"
      />
      <Button
        size="small"
        type="primary"
        loading={saving}
        onClick={async () => {
          setSaving(true)
          try {
            await onSave(leg, value)
          } finally {
            setSaving(false)
          }
        }}
      >
        保存
      </Button>
    </Space.Compact>
  )
}
