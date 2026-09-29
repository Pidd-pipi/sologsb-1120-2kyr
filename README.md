# sologsb-1120 古钟表维修工序档案（gbclockrepair）

面向钟表修复师的工序档案台：为一台古董钟表建档，记录机芯型号、零件缺失与配换、拆解顺序、清洗润滑点位，以及修复后的走时测试数据。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21820**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
npm run verify   # fake-indexeddb 下跑封存/返修/补录生命周期断言
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1120/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{clock,part,step,test,archive}.ts
        ├── stores/{clock,part,step,archive}Store.ts
        ├── components/common/{StepSequence,RateChart,ClockCard,StateBadge,HistoryTimeline}.vue
        ├── hooks/{useClockSearch,useRepairProgress}.ts
        ├── pages/{ClockList,ClockDetail,StepForm,PartList,TestView}.vue
        └── utils/{db,archive,timeCalc,id,operator}.ts
    ├── verify-lifecycle.ts      # 封存/写锁/返修合并生命周期断言（npm run verify）
    └── verify-backfill.ts       # 旧档补录 v1 与沿革筛选断言
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/clocks` | 钟表台账：按种类/机芯/品相/年代区间筛选，按修复状态分栏 | Clock |
| `/clocks/:id` | 钟表详情：正式档案/返修中双视图，工序流、走时测试、零件清单与可按工序/零件/测试/档案筛选的维修沿革；封存、开返修单、合并下一版 | Clock、RepairStep、TimekeepingTest、MovementPart、HistoryEntry、ArchiveVersion、RepairOrder |
| `/steps/new` | 新建维修工序：选步骤类型后动态出清洗液/油脂/力矩字段，顺序号冲突即报错 | RepairStep、MovementPart |
| `/parts` | 零件与配换清单：按磨损状态分组，标出待修配条目与来源批号 | MovementPart |
| `/tests/:clockId` | 走时测试录入与多方位均值计算，生成走时单文本 | TimekeepingTest |

`/` 重定向到 `/clocks`，未匹配路由同样兜底到 `/clocks`。

## 数据存储说明

- 数据库名 `gbclockrepair`，当前结构版本 **v3**（`localStorage['gbclockrepair:db-version']` 记录）。
- 七张表：`clocks`（钟表）、`parts`（机芯零件）、`steps`（维修工序）、`tests`（走时测试）、`history`（维修沿革，只增不改）、`archives`（正式档案版本快照）、`repairs`（返修单）。
- v1 → v2 迁移：补齐老记录的 `state`、`partIds`、`torque`、`positions` 字段并新增索引。
- v2 → v3 迁移：旧数据首次打开**自动补成第 1 版**——按台生成基线快照并写一条「旧档补录」沿革；工序已全部完成且已有合格测试的旧档直接封存为正式档案 v1（封存操作者记为「系统迁移」），未达标的保留为待封存基线，达标后手动封存仍占用 v1。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 台示范钟表、3 项零件、3 道工序与 1 次走时测试。

## 维修沿革与档案封存规则

交接痛点（只看到最终工序、说不清谁改了顺序/零件决定/测试结论）由下面这套规则兜底：

- **只增不改的维修沿革**（`history` 表）：工序的追加/完成/回退/交换顺序、零件的登记/修改/删除、测试的录入/删除、档案的补录/封存/返修/合并，全部追加一条沿革，记录**操作者**（顶栏可切换，存于 localStorage）、**时间**、**关联记录**（具体工序/零件/测试/返修单/版本）与**前后值**（如顺序号 `1 → 2`、处理决定 `修配 → 换新`、测试结论 `合格 → 不合格`）。应用代码无任何 update/delete 沿革的入口。
- **封存**：工序全部完成且已有一次合格走时测试（结论含「合格」且非「不合格」）后，详情页出现封存入口；封存后生成只读的正式档案版本快照，业务数据加写锁。
- **返修单**：封存后的唯一修改入口。开单后锁解除，返修期内的沿革均挂返修单号（`FX-日期-序号`）。
- **合并下一版**：必须在返修期内**新完成至少一道工序**且**补录至少一次合格测试**，同时当前数据仍满足整体封存条件，才能合并生成 v2、v3……；条件不满足时合并被拒，**详情页默认继续展示原正式档案**（可手动切换查看返修中实时数据）。
- **详情页沿革筛选**：「维修沿革」标签页可按全部 / 工序 / 零件 / 测试 / 档案过滤；时间线每条均展示操作者、时间、关联记录标签与前后值对照表。
- 详情页顶部可在「正式档案（封存快照只读）」与「返修中数据（实时可改）」两个视图间切换；台账卡片带「正式档案 vN / 返修中」角标。

## 功能要点

- **顺序号不跳号**：新建工序时若顺序号大于「当前最大顺序号 + 1」直接报错并给出建议值；`<StepSequence>` 对缺口行标红。
- **工序排序**：支持「上移 / 下移」按钮与原生拖拽交换顺序，交换的是 `seq`。
- **工序完成 / 回退**：完成后写 `finishedAt`，回退后计入待办与回退计数。
- **双轴走时图**：`<RateChart>` 左轴日差 s/d、右轴摆幅 °，标注四方位读数与均值。
- **走时单导出**：按方位均值生成文本，可复制或下载 txt。
- **只增不改的维修沿革**：所有写操作自动留痕（操作者/时间/关联记录/前后值），详情页时间线可按工序、零件、测试、档案筛选。
- **档案封存与返修**：工序全完成且有合格测试即可封存，封存后只读；修改须先开返修单，返修中新完成一道工序并补一次合格测试才能合并下一版，否则详情继续展示原正式档案。
