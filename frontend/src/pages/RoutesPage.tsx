import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  message
} from 'antd'
import dayjs from 'dayjs'
import type { DropPoint, RouteVersion, TransitRoute } from '@/types'
import { VEHICLE_TYPES, VEHICLE_CAPACITY_BOXES } from '@/types'
import RouteMap from '@/components/common/RouteMap'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { droppointStore } from '@/stores/droppointStore'
import { CapacityExceededError, routeStore, UnchangedConfirmError } from '@/stores/routeStore'
import { distanceKm, estimateDurationH, routeLegs } from '@/utils/geo'
import { routeLoadBoxes } from '@/utils/routePlan'

/** 转场路线规划：选点排顺序 → 保存草稿 → 发布冻结；依据变化后旧版留档失效，确认重算出版本 */
export default function RoutesPage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const routes = usePersistentStore(routeStore, (state) => state.rows)
  const versions = usePersistentStore(routeStore, (state) => state.versions)
  const current = usePersistentStore(routeStore, (state) => state.current)
  const draft = usePersistentStore(routeStore, (state) => state.draft)
  const draftLegs = usePersistentStore(routeStore, (state) => state.draftLegs)

  const [orderedIds, setOrderedIds] = useState<string[]>([])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [vehicleType, setVehicleType] = useState<TransitRoute['vehicleType']>('厢式货车')
  const [departAt, setDepartAt] = useState(dayjs())
  const [riskNote, setRiskNote] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [actualTarget, setActualTarget] = useState<TransitRoute | null>(null)
  const [actualText, setActualText] = useState('')

  const invalidVersion = versions.find((item) => item.status === 'invalid') ?? null

  // 进入页面即检测投放点坐标 / 存在性是否已偏离已发布版本依据
  useEffect(() => {
    void routeStore.getState().detectDrift()
  }, [dropPoints])

  const editingVersion = draft ?? current
  const editorSourceId = draft?.id ?? current?.id ?? null
  useEffect(() => {
    if (editingVersion) {
      setOrderedIds(editingVersion.stopIds)
      setVehicleType(editingVersion.vehicleType)
      setDepartAt(dayjs(editingVersion.departAt))
      setRiskNote(editingVersion.riskNote)
    }
    // 仅在切换编辑版本（id 变化）时回填，避免编辑中被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorSourceId])

  const ordered = useMemo(
    () => orderedIds.map((id) => dropPoints.find((item) => item.id === id)).filter((item): item is DropPoint => Boolean(item)),
    [orderedIds, dropPoints]
  )
  const legs = useMemo(() => routeLegs(ordered.map((item) => ({ longitude: item.longitude, latitude: item.latitude }))), [ordered])
  const loadBoxes = routeLoadBoxes(orderedIds, dropPoints)
  const capacity = VEHICLE_CAPACITY_BOXES[vehicleType]

  function orchardName(orchardId: string): string {
    return orchards.find((item) => item.id === orchardId)?.name ?? '未知地块（坐标已冻结）'
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

  /** 已执行段覆盖的站点数（done 段数 + 1）；这些站点及其顺序在重算草稿中锁定 */
  const doneStopCount = useMemo(() => {
    const doneCount = draftLegs.filter((item) => item.legStatus === 'done').length
    return draft && doneCount > 0 ? doneCount + 1 : 0
  }, [draft, draftLegs])
  // lockedStopCount 作为锁定前缀长度供排序边界使用
  const lockedStopCount = doneStopCount

  function canReorder(index: number): boolean {
    // 已执行前缀站点锁定
    return index >= doneStopCount
  }

  async function saveDraft(): Promise<void> {
    if (orderedIds.length < 2) {
      message.warning('至少选择 2 个投放点才能生成转场路线')
      return
    }
    try {
      await routeStore.getState().saveDraft({
        stopIds: orderedIds,
        vehicleType,
        departAt: departAt.format('YYYY-MM-DDTHH:mm'),
        riskNote: riskNote.trim()
      })
      message.success('草稿已保存（尚未发布，不影响现场使用的生效版本）')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '草稿保存失败')
    }
  }

  async function publish(): Promise<void> {
    if (orderedIds.length < 2) {
      message.warning('至少选择 2 个投放点才能发布')
      return
    }
    setPublishing(true)
    try {
      // 先确保草稿为最新编辑内容，再发布；发布事务失败会整体回滚、草稿保留
      await routeStore.getState().saveDraft({
        stopIds: orderedIds,
        vehicleType,
        departAt: departAt.format('YYYY-MM-DDTHH:mm'),
        riskNote: riskNote.trim()
      })
      const head = await routeStore.getState().publishDraft()
      message.success(`已发布 v${head.version}：顺序、坐标、首段时刻与里程已冻结`)
    } catch (error) {
      if (error instanceof CapacityExceededError) {
        message.error(error.message)
      } else if (error instanceof UnchangedConfirmError) {
        message.info(error.message)
      } else {
        message.error('发布失败，已恢复草稿：' + (error instanceof Error ? error.message : '未知错误'))
      }
    } finally {
      setPublishing(false)
    }
  }

  async function confirmRecalc(): Promise<void> {
    try {
      const head = await routeStore.getState().confirmRecalculate(invalidVersion?.id ?? current?.id)
      message.success(`已按最新投放点生成 v${head.version} 草稿，已执行段保留实际记录，请核对后发布`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重算失败')
    }
  }

  function openActual(leg: TransitRoute): void {
    setActualTarget(leg)
    setActualText(leg.actualNote === '待执行' ? '' : leg.actualNote)
  }

  async function submitActual(): Promise<void> {
    if (!actualTarget) return
    await routeStore.getState().recordActual(actualTarget.id, actualText.trim() || '已执行', true)
    message.success('实际记录已保存（已执行段在下次重算时保留）')
    setActualTarget(null)
  }

  const history = [...versions].sort((a, b) =>
    a.chainId === b.chainId ? b.version - a.version : b.publishedAt.localeCompare(a.publishedAt)
  )

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">转场路线规划</h2>
          <p className="page-sub">
            草稿调整顺序并实时重算里程；发布即冻结途经点顺序、坐标、首段时刻与预计里程。投放点挪动后旧版自动留档失效，确认重算才出版本（已执行段保留）。
          </p>
        </div>
        <Space>
          {draft ? (
            <Button onClick={() => void routeStore.getState().discardDraft()}>放弃草稿</Button>
          ) : null}
          <Button onClick={() => void saveDraft()}>保存草稿</Button>
          <Button type="primary" loading={publishing} onClick={() => void publish()}>
            发布版本
          </Button>
        </Space>
      </div>

      {/* 版本状态横幅 */}
      {invalidVersion ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={`已发布的 v${invalidVersion.version} 依据已变化，已留档标记失效`}
          description={
            <Space direction="vertical" size={4}>
              <span>变化明细：{invalidVersion.invalidReason || '途经投放点坐标/顺序与发布时不一致'}</span>
              <span>司机手中的旧版路线不再作为生效版本；确认重算将保留已执行段实际记录，仅重算未执行段。</span>
              <Button size="small" type="primary" onClick={() => void confirmRecalc()}>
                确认重算并生成草稿
              </Button>
            </Space>
          }
        />
      ) : current ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="success"
          showIcon
          message={
            <Space wrap size={6}>
              <span>当前生效版本 v{current.version}</span>
              <Tag color="blue">{current.vehicleType}</Tag>
              <Tag>首段 {current.departAt}</Tag>
              <Tag>{current.stopIds.length} 站 · {current.totalDistanceKm} km</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                发布于 {dayjs(current.publishedAt).format('YYYY-MM-DD HH:mm')}
              </Typography.Text>
            </Space>
          }
        />
      ) : (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="尚无已发布路线"
          description="在下方依次选择投放点并发布；发布后现场（总表、路线表、导出）统一读取该冻结版本。"
        />
      )}
      {draft ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={
            <Space wrap size={6}>
              <span>草稿 v{draft.version} 编辑中（未发布）</span>
              <Tag>{draft.stopIds.length} 站 · {draft.totalDistanceKm} km</Tag>
              {loadBoxes > capacity ? <Tag color="red">运力超限 {loadBoxes}/{capacity} 箱</Tag> : <Tag color="green">运力 {loadBoxes}/{capacity} 箱</Tag>}
            </Space>
          }
        />
      ) : null}

      <Row gutter={16}>
        <Col xs={24} xl={15}>
          <Card size="small" title="地图（投放点与转场折线；预览为实时草稿，发布后冻结）">
            <RouteMap
              orchards={orchards}
              dropPoints={dropPoints}
              routes={routes}
              orderedDropIds={orderedIds}
              height={420}
              title={draft ? `v${draft.version} 草稿预览` : current ? `当前生效 v${current.version}` : '转场顺序预览'}
            />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card size="small" title="投放点（点击加入转场顺序）" style={{ marginBottom: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              {dropPoints.map((point) => (
                <Space key={point.id} style={{ width: '100%', justifyContent: 'space-between' }}>
                  <span>
                    <Tag color="blue">{point.code}</Tag>
                    {orchardName(point.orchardId)} · 可容纳 {point.capacityBoxes} 箱 · 水源 {point.waterDistance} m
                  </span>
                  <Button size="small" disabled={orderedIds.includes(point.id)} onClick={() => addPoint(point.id)}>
                    加入顺序
                  </Button>
                </Space>
              ))}
              {dropPoints.length === 0 ? <Empty description="暂无投放点，请先在果园地块管理中添加" /> : null}
            </Space>
          </Card>

          <Card size="small" title={`转场顺序（${ordered.length} 点 · 累计 ${legs.total} km）`}>
            {ordered.length === 0 ? (
              <Typography.Text type="secondary">尚未选择投放点</Typography.Text>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                {ordered.map((point, index) => {
                  // 已执行段覆盖的前缀站点标「已执行」且锁定，不可改序/移除
                  const isDoneStop = index < doneStopCount
                  const locked = isDoneStop
                  return (
                    <div
                      key={point.id}
                      draggable={canReorder(index)}
                      onDragStart={() => canReorder(index) && setDraggingId(point.id)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => handleDrop(point.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 10px',
                        border: `1px ${locked ? 'solid #b7eb8f' : 'dashed #cfd9e2'}`,
                        borderRadius: 8,
                        background: locked ? '#f6ffed' : draggingId === point.id ? '#fff7e6' : '#fff',
                        cursor: canReorder(index) ? 'grab' : 'not-allowed'
                      }}
                    >
                      <Tag color={locked ? 'green' : 'gold'}>{locked ? '已执行' : `第 ${index + 1} 站`}</Tag>
                      <span style={{ flex: 1 }}>
                        {point.code} · {orchardName(point.orchardId)}
                        {index > 0 ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                            上一段 {distanceKm(ordered[index - 1], point)} km / 约 {estimateDurationH(distanceKm(ordered[index - 1], point))} h
                          </Typography.Text>
                        ) : null}
                      </span>
                      <Button size="small" disabled={index === 0 || index < lockedStopCount} onClick={() => move(index, -1)}>
                        上移
                      </Button>
                      <Button size="small" disabled={index === ordered.length - 1 || !canReorder(index)} onClick={() => move(index, 1)}>
                        下移
                      </Button>
                      <Button size="small" danger type="link" disabled={locked} onClick={() => removePoint(point.id)}>
                        移除
                      </Button>
                    </div>
                  )
                })}
              </Space>
            )}
            <Form layout="vertical" style={{ marginTop: 12 }}>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="车辆类型（含当日单车容量）" style={{ marginBottom: 8 }}>
                    <Select
                      value={vehicleType}
                      onChange={(value) => setVehicleType(value)}
                      options={VEHICLE_TYPES.map((item) => ({ value: item, label: `${item}（${VEHICLE_CAPACITY_BOXES[item]} 箱）` }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="首段出发时刻（发布冻结）" style={{ marginBottom: 8 }}>
                    <DatePicker showTime value={departAt} onChange={(value) => setDepartAt(value ?? dayjs())} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="途中风险备注" style={{ marginBottom: 8 }}>
                    <Input value={riskNote} onChange={(event) => setRiskNote(event.target.value)} placeholder="如 西沟坡道窄，雨天泥泞" />
                  </Form.Item>
                </Col>
              </Row>
              <Typography.Text type={loadBoxes > capacity ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
                本次待运 {loadBoxes} 箱；{draftLegs.some((l) => l.legStatus === 'done') ? '已执行段已锁定保留，仅未执行段参与重算；' : ''}
                {loadBoxes > capacity ? `超过该车型当日单车容量 ${capacity} 箱，发布会被拒绝。` : `未超过 ${capacity} 箱容量。`}
              </Typography.Text>
            </Form>
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        style={{ marginTop: 16 }}
        title={
          current
            ? `当前生效路线 v${current.version}（${routes.length} 段 · 合计 ${current.totalDistanceKm} km · 发布冻结）`
            : '当前生效路线（尚未发布）'
        }
      >
        <Table<TransitRoute>
          dataSource={routes}
          rowKey="id"
          pagination={false}
          locale={{ emptyText: '尚无已发布版本，请先在上方排好顺序并发布' }}
          columns={[
            { title: '段序', key: 'seq', width: 60, render: (_, record) => record.seq + 1 },
            {
              title: '出发',
              key: 'from',
              render: (_, record: TransitRoute) => {
                const point = dropPoints.find((item) => item.id === record.fromDropId)
                return point ? `${point.code}（${orchardName(point.orchardId)}）` : `${record.fromDropId}（冻结坐标）`
              }
            },
            {
              title: '到达',
              key: 'to',
              render: (_, record: TransitRoute) => {
                const point = dropPoints.find((item) => item.id === record.toDropId)
                return point ? `${point.code}（${orchardName(point.orchardId)}）` : `${record.toDropId}（冻结坐标）`
              }
            },
            { title: '里程（km）', dataIndex: 'distanceKm', key: 'km', width: 110 },
            { title: '预计耗时（h）', dataIndex: 'durationH', key: 'hour', width: 120 },
            { title: '车辆', dataIndex: 'vehicleType', key: 'vehicle', width: 100 },
            { title: '首段时刻', dataIndex: 'departAt', key: 'depart', width: 150 },
            {
              title: '执行',
              dataIndex: 'legStatus',
              key: 'status',
              width: 90,
              render: (value: TransitRoute['legStatus']) => (value === 'done' ? <Tag color="green">已执行</Tag> : <Tag>未执行</Tag>)
            },
            { title: '实际记录', dataIndex: 'actualNote', key: 'actual', width: 160 },
            {
              title: '操作',
              key: 'action',
              width: 110,
              render: (_, record: TransitRoute) => (
                <Button size="small" type="link" onClick={() => openActual(record)}>
                  回填实际
                </Button>
              )
            }
          ]}
        />
      </Card>

      <Card size="small" style={{ marginTop: 16 }} title={`版本留档（${history.length} 个版本，旧版只读留档）`}>
        {history.length === 0 ? (
          <Typography.Text type="secondary">暂无版本</Typography.Text>
        ) : (
          <Timeline
            items={history.map((item: RouteVersion) => ({
              color: item.status === 'published' ? 'green' : item.status === 'invalid' ? 'red' : 'gray',
              children: (
                <Space direction="vertical" size={2}>
                  <Space wrap size={6}>
                    <b>v{item.version}</b>
                    {item.status === 'published' ? (
                      <Tag color="green">生效中</Tag>
                    ) : item.status === 'invalid' ? (
                      <Tag color="red">已失效留档</Tag>
                    ) : (
                      <Tag>草稿</Tag>
                    )}
                    <Tag>{item.vehicleType}</Tag>
                    <Tag>{item.stopIds.length} 站</Tag>
                    <Tag>{item.totalDistanceKm} km</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {item.status === 'draft' ? `编辑于 ${dayjs(item.createdAt).format('MM-DD HH:mm')}` : `发布于 ${dayjs(item.publishedAt).format('YYYY-MM-DD HH:mm')}`}
                    </Typography.Text>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    首段 {item.departAt} · 顺序 {item.stops.map((stop) => stop.code).join(' → ')}
                  </Typography.Text>
                  {item.status === 'invalid' ? (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      失效原因：{item.invalidReason}
                    </Typography.Text>
                  ) : null}
                </Space>
              )
            }))}
          />
        )}
      </Card>

      <Modal title="回填实际转场记录" open={actualTarget !== null} onCancel={() => setActualTarget(null)} onOk={() => void submitActual()} okText="保存并标记已执行">
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          {actualTarget
            ? `第 ${actualTarget.seq + 1} 段：${actualTarget.fromDropId} → ${actualTarget.toDropId}（预计 ${actualTarget.distanceKm} km）`
            : ''}
        </Typography.Paragraph>
        <Input.TextArea rows={3} value={actualText} onChange={(event) => setActualText(event.target.value)} placeholder="如 06:35 发车，07:10 到达，坡道倒车一次" />
      </Modal>
    </div>
  )
}
