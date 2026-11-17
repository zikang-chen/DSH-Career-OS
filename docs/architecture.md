# CareerOS — 架构说明

## 运行时事实（本机实测，非假设）

| 项目 | 实测值 |
| --- | --- |
| DSH profiles | `desktop`（`C:\Users\<you>\.dsh\profiles\desktop`） |
| Host 运行时 | Electron 44.7.0 / Node **24.21.0**（`process.versions`） |
| SQLite | `node:sqlite` 内置可用，**FTS5 + trigram tokenizer 可用** |
| 外部 Node | v24.18.0；Python 3.12.4 |
| 包管理 | `pnpm` 不在 PATH；bundled pnpm 由 `load_workspace_dependencies` 提供 |
| 已装同类插件 | `dsh-finance`（`link:D:/finance_ds`）—— 作为可对照的参考实现 |

## 技术决策（ADR）

### ADR-1：零依赖实现

**决定**：插件只 import `node:` 内置模块，客户端为手写 CJS。

**理由**：
1. `node:sqlite` 已内置，无需 better-sqlite3 这类原生模块（Windows 上编译成本高、易失败）。
2. 不引入 schemastery/typescript/esbuild，安装时无需 `pnpm install` 解析依赖树，`install_bundle` 只做 link，失败面最小。
3. 客户端由 `scripts/build-client.mjs` 做**纯字符串包装**成 `window.__ModuleLoader__.load({id, factory})`，避免 bundler 版本与 DSH 客户端的兼容问题。

**代价**：没有 `Config` schema，插件行在 Config 面板显示 `status: absent`；配置由 `cordis.patch.yml` 传入并在 `apply` 内做默认值合并与校验。

### ADR-2：单 bundle 多模块，而非 13 个插件

需求文档列的 13 个插件边界按功能命名；实测中它们共享同一份画像、岗位库与证据表，拆成 13 个包会产生跨包事务与循环依赖。

**决定**：一个 bundle `dsh-career`，内部按 `host/repo/*`、`host/domain.js`、`host/sources.js`、`host/monitor.js` 模块化。若未来要独立升级某个 Connector，它已经是独立文件（`host/sources.js` 的 `CONNECTOR_META` + 各自函数），可平移。

### ADR-3：Store 只做 SQL，规则留在纯函数

`host/domain.js` 全部是纯函数（`normalizeJob` / `computeDedupeKey` / `applyHardFilters` / `analyzeMatch` / 各种 `parse*`），因此去重、匹配、解析都能在无数据库、无网络的情况下单测。

### ADR-4：状态是"观测日志"而不是字段

`job.status` 只是**最近一次可信观测的镜像**，真值在 `job_status_history`。第三方来源只能把 `UNKNOWN` 提升为 `UNVERIFIED`，不能断言"仍在招"；超过 21 天未核验的 `OPEN` 自动降级 `STALE`。

## 分层

```
浏览器 (client/wrapped-bundle.js)
  │  fetch /plugins/dsh-career/api/*
  │  EventSource /plugins/dsh-career/api/events   ← 实时刷新 + Agent 导航
  ▼
Host 插件 (host/index.js · apply)
  ├── routes.js      HTTP 路由（同源校验、2MB 体限制、二次确认 token）
  ├── tools.js       36 个 Agent 工具（tools 服务）
  ├── monitor.js     监控引擎 + 日报（sync_run 全量留痕）
  ├── sources.js     Connector：官方招聘页(robots 优先) / 搜索 / 手动粘贴
  ├── resume.js      简历文本提取 + 启发式结构化（提案制）
  ├── domain.js      纯函数：归一化 / 去重 / JD 解析 / 匹配
  ├── repo/*         画像、岗位、投递、情报、监控 五组仓储
  └── db.js + schema.js  node:sqlite + 版本化迁移
  ▼
data/career.db (WAL, FTS5 trigram)
```

## 扩展点（真实存在、已使用）

| 服务 | 用途 | 用法 |
| --- | --- | --- |
| `tools` | Agent 工具 | `ctx.tools.register({name, description, parameters, output:{schema,render}, execute})` |
| `webServer` | HTTP + SSE | `ctx.webServer.register({kind:'prefix', path, handler})` |
| `web`（可选） | 合规搜索发现 | `ctx.get('web').search({query,maxResults})` |
| `clientModules`（可选） | 自检浏览器半是否进入 boot graph | `graph().entries` |
| Client `slots` | UI 挂载 | `sidebar.footer.action`、`settings.plugins.tab` |

`web` 与 `clientModules` 都用 `ctx.get(...)` 可选获取，缺失时功能降级而不是加载失败。

## 已知限制

1. **视觉渲染未经浏览器验证**：本会话无浏览器控制能力。已验证的是「bundle 进入 Web boot graph（rev `ef266884a9c0`）且以 `text/javascript` 200 返回 71,348 字节」，不能据此断言像素级正确。
2. **PDF 提取有边界**：纯 stdlib 解析 Flate 流；扫描件或 CID 字体 PDF 会返回低置信度提示并建议改用手动粘贴。
3. **`dsh-finance` 重载告警**：每次 profile 重载都会打印 `duplicate prefix route "/plugins/dsh-finance/api"`。这是既有金融插件自身的问题（它的路由未在重载时释放），与 CareerOS 无关；实测其 API 仍正常响应。
