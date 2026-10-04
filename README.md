# 蜜蜂授粉路线规划器（gbbeeroute）

面向果园托管服务队与蜂场技术员，把「果园地块 → 花期 → 蜂群投放点 → 转场路线」排成季内可执行的授粉安排，解决花期重叠时蜂群撞车、转场距离过远、投放点与地块不匹配的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21817>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbbeeroute
FRONTEND_PORT=21817
VITE_AMAP_KEY=            # 可选，留空即自动降级为本地 SVG 网格视图
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 |
| 语言 | TypeScript（`tsc --noEmit` 类型检查零错误） |
| UI 组件库 | Ant Design 5 |
| 地图 | 高德地图 JS API 2.0（可选，key 走 `VITE_AMAP_KEY`） |
| 状态管理 | Zustand |
| 路由 | React Router 6（nginx `try_files` 回落） |
| 构建 | Vite 5 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

> 转场路线采用**版本化发布**：草稿调整不影响现场，发布即冻结途经点顺序、坐标、首段时刻与预计里程；投放点换季挪动后旧版自动留档失效，确认重算才生成新版本（已执行段保留实际记录，只重算未执行段）；当日车辆运力不足会拒绝发布。

## 三、高德地图 Key 与降级策略

- 在 `.env` 里填写 `VITE_AMAP_KEY=<你的 key>` 后**重新构建**（`docker compose up -d --build`），地图将使用高德 JS API 渲染地块、投放点与转场折线；
- **未配置 key 或脚本加载失败时，`RouteMap` 自动降级为本地 SVG 网格视图**：按经纬度线性映射渲染地块、投放点与转场折线，支持点选拾取坐标；
- **构建与运行都不依赖该 key**：未配置 key 时不会注入任何外部脚本（避免无谓请求与报错），Docker 构建零网络依赖即可通过；
- 页面右上角始终显示当前数据源（高德地图 JS API / 本地 SVG 网格视图）。

## 四、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21817
npm run build      # 类型检查 + 生产构建
```

## 五、目录结构

```
sologsb-1117/
├── docker-compose.yml          # 顶层 name: gbbeeroute，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # orchard.ts / colony.ts / droppoint.ts / route.ts / index.ts
│       ├── stores/             # orchardStore / colonyStore / droppointStore / routeStore（Zustand）
│       ├── components/common/  # RouteMap / FlowerWindowBar / StatusTag / CoordPicker
│       ├── hooks/              # useAmap / usePersistentStore
│       ├── pages/              # SchedulePage / OrchardsPage / ColoniesPage / RoutesPage / ExportPage
│       ├── router/index.tsx
│       └── utils/              # geo.ts / routePlan.ts（依据指纹/运力/重算） / export.ts / id.ts
```

## 六、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Orchard 果园地块 | 地块名、作物、面积、经纬度、盛花期起止、需蜂强度（箱/亩）、园主联系方式、可达性、历史授粉年份 | `orchards` |
| BeeColony 蜂群 | 群号、蜂种、群势（足框）、箱型、当前所在地块、状态（待投放/在园/转场中/回场）、最近检查日期、健康备注 | `colonies` |
| DropPoint 投放点 | 所属地块、坐标、编号、可容纳箱数、遮阴条件、水源距离、投放时间窗、撤场时间、责任人、安排群号 | `dropPoints` |
| TransitRoute 转场路线段 | 归属版本、段序、出发/到达投放点、**冻结坐标**、预计里程与耗时、车辆类型、首段时刻、执行状态（已执行/未执行）、风险备注、实际记录 | `routes` |
| RouteVersion 路线版本 | 版本号、状态（草稿/已发布/失效）、冻结的停靠点顺序与坐标、首段时刻、预计总里程、依据指纹、失效原因与时间 | `routeVersions` |

- 数据库名 `gbbeeroute`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史投放点补齐「可容纳箱数」（默认 8 箱）；
- `version(3)` 升级迁移把旧的散装路线段**补成首版（v1 已发布）**：重建途经点顺序、冻结坐标、补段序与版本归属，已回填实际记录的段标记为「已执行」；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

### 路线版本发布约定

- **冻结发布**：发布时把途经投放点的顺序、坐标快照、首段出发时刻、预计里程写入版本头与各段；之后投放点再改坐标或删除，留档版本仍按旧数据展示；
- **草稿与回滚**：编辑只写草稿（`draft`），不影响现场使用的生效版本；发布在单个 IndexedDB 事务内完成，任一步失败整体回滚、草稿原样保留；
- **依据变化留档**：进入路线页会比对「顺序 + 现行坐标」指纹，已发布版本一旦偏离即置为 `invalid` 并记录变化明细，旧版只读留档；总表 / 路线表 / 导出统一只读取当前生效（最新 published）版本；
- **确认重算**：只有点「确认重算」才基于失效版生成下一版草稿；已执行段（含里程与实际记录）整段保留，仅未执行尾段按新坐标重算；
- **幂等**：草稿依据与当前生效版本完全一致时重复确认不新增版本；
- **当日运力容量**：同日期、同车型的已发布未执行段，按各到达投放点安排的群箱数累计，超过该车型单车容量（厢式货车 40 / 皮卡 20 / 农用三轮 12 / 人工搬运 6 箱）即拒绝发布。

## 七、主要页面

| 路由 | 功能 |
| --- | --- |
| `/` | 季内授粉安排总表：花期条带 + 已投放群体，冲突（同一蜂群被排入花期重叠的不同地块）标红并汇总 |
| `/orchards` | 果园地块管理：面积与需蜂强度自动算建议箱数、可达性标记、花期重叠提示、投放点维护（含坐标拾取） |
| `/colonies` | 蜂群台账：按群势与状态筛选，批量改状态、批量记录检查备注 |
| `/routes` | 转场路线规划：地图选点排顺序生成里程草稿，发布冻结为版本；投放点挪动后旧版留档失效，确认重算出版本（已执行段保留），支持运力容量校验与实际记录回填 |
| `/export` | 导出授粉安排清单 / 转场路线表（CSV，含版本号与段序）、全量 JSON 备份（含版本），并提供横向/纵向打印视图；均读取当前生效版本 |

## 八、计算约定

- 建议箱数 = ⌈面积(亩) × 需蜂强度(箱/亩)⌉，最少 1 箱；
- 转场里程按 Haversine 球面距离累计，耗时按平均 32 km/h + 0.25 h 装卸估算；
- 花期重叠：两地块盛花期区间交集天数 ≥ 1 即视为重叠；同一群号在重叠期内被排入两个地块 → 冲突。
