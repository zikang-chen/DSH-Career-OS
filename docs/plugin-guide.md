# 开发者指南

## 目录

```
D:\career_os\
├── package.json          # bundle manifest（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml      # 插入本插件行 + 配置
├── host/                 # Host 半（纯 ESM，零依赖）
│   ├── index.js          # apply()：装配 db/repos/monitor/tools/routes
│   ├── config 合并        # DEFAULTS 在 index.js 内
│   ├── schema.js         # 版本化迁移 SQL
│   ├── db.js             # node:sqlite 门面 + 迁移 + tx
│   ├── domain.js         # 纯函数：归一化/去重/JD解析/匹配
│   ├── util.js           # 绑定归一化、身份键、相似度
│   ├── resume.js         # 简历文本提取 + 启发式结构化
│   ├── sources.js        # Connector 目录 + robots + 抓取 + 解析
│   ├── monitor.js        # 监控引擎 + 日报
│   ├── routes.js         # HTTP API + SSE
│   ├── panel.js          # SSE 广播
│   ├── exporter.js       # 导出/备份/两步删除
│   ├── repo/             # profile / jobs / applications / intel / monitor
│   └── ...
├── client/
│   ├── index.cjs         # 面板源码（CJS，手写 h() 调用）
│   └── wrapped-bundle.js # 生成物（勿手改）
├── scripts/
│   ├── build-client.mjs  # 包装成 __ModuleLoader__ 格式
│   └── extract_resume.py # stdlib 提取 docx/pdf 文本
├── tests/                # node:test
├── docs/                 # 本目录
└── data/                 # 运行时数据（DB/日志/备份/导出）
```

## 构建与安装

```powershell
cd D:\career_os
node scripts\build-client.mjs      # 只改 client/index.cjs 后需要
node --test tests/core.test.mjs    # 28 个测试
```

安装（在 DSH 会话里让 Agent 调用）：

```
plugin_manager action=install_bundle target=D:\career_os
```

**改 Host 代码后必须重载**：ESM 模块在同一进程内被缓存，仅改文件不会生效。

```
plugin_manager action=set_plugin enabled=false target=include:dsh-career
plugin_manager action=set_plugin enabled=true  target=include:dsh-career
```

（`target` 用 entryId `include:dsh-career`，不是包名。）重载后工具 schema 会自动刷新。

## 加一个工具

在 `host/tools.js` 里：

```js
add(makeTool({
  name: 'career_my_tool',
  description: '一句话说明它能做什么、什么时候该用。',
  params: { id: S('说明'), limit: N('条数') },
  required: ['id'],
  handler: (args) => ({ ok: true, data: repos.db.all('SELECT * FROM job WHERE id = ?', [args.id]) }),
}))
```

约定：
- `output.schema` 固定 `{type:'string'}`，`handler` 返回对象由 `makeTool` 序列化。
- 工具名以 `career_` 前缀开头（`index.js` 的 `tools/execute` 钩子据此推送面板活动指示）。
- 抛错即失败；不要返回"看起来成功但没做"的结果。

## 加一个接口

`host/routes.js`：

```js
route('GET', '/my-endpoint', ({ query }) => ({ ok: true, value: query.get('q') }))
route('POST', '/my-write', async ({ body }) => { /* ... */ return { ok: true } })
```

- 前缀固定 `/plugins/dsh-career/api`。
- 写操作后调用 `panel.publish({ kind: 'jobs', ... })`，面板会实时刷新（客户端订阅了 `jobs/applications/resume/profile/monitor/company/social/reports`）。
- 破坏性操作用 `exporter.prepareDelete` / `commitDelete` 的 token 模式。

## 加一个数据源

1. 在 `host/sources.js` 的 `CONNECTOR_META` 加一项，声明 `accessMode`、`capabilities`、`rateLimitNote`。
2. 遵循 `robotsAllows()` → `politeGet()` → 解析 → 返回结构化候选的顺序。
3. **拿不到就返回错误**，不要返回空数组冒充"没有结果"；错误会落进 `sync_run.error` 与 `source_health.last_error`，面板可见。
4. 若来源需要登录或禁止自动化，把 `accessMode` 设为 `'blocked'`、`enabled: false`，并提供手动导入路径。

## 加一张表

**不要改已有迁移**。在 `host/schema.js` 追加：

```js
{ version: 5, name: 'my-change', sql: `CREATE TABLE ...` }
```

并同步提升 `SCHEMA_VERSION`。迁移在事务中执行并记录版本号，重复启动不会重跑。

## 面板

`client/index.cjs` 是手写 `h(tag, props, ...children)` 的 React 组件。改完执行 `node scripts/build-client.mjs`。

- 主题色只用 `--dsw-alias-*` token（见 `T` 对象），不要硬编码颜色。
- 新页签：在 `TABS` 加一项 + 在 `content()` 的 `switch` 加分支。
- 组件里避免副作用；SSE 订阅在 `Panel` 的 `useEffect` 里统一管理并返回清理函数。
- 保持空状态/加载/错误三态：`Empty` / `Loading` / `ErrorBox`。

## 调试

| 症状 | 看哪里 |
| --- | --- |
| 工具没出现 | `career_status` 的 `tools` 数组；重载插件 |
| 面板按钮没有 | `GET /plugins/dsh-career/api/client-health` → `inGraph` |
| 接口 500 | `data/logs/career.log` |
| 监控一直失败 | 「设置 → 最近运行」+ `source_health.last_error` |
| 中文搜不到 | `career_status` 的 `db.ftsMode` 应为 `trigram` |

自检脚本（免安装、直接跑仓储层）：

```powershell
node --test tests\core.test.mjs
```
