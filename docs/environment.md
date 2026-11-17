# 环境修复与即插即用清单

> 记录时间：2026-11-16。每条都写明**改了什么、为什么、怎么验证**。
> 用 `career_selfcheck`（或在面板「设置」）随时复查当前状态。

## 一、总览

| 项目 | 状态 | 验证方式 |
| --- | --- | --- |
| Python 解释器 | ✅ `C:\Users\<you>\anaconda3\python.exe` 3.12.4 | `career_selfcheck.checks[python]` |
| PDF 解析依赖 | ✅ 项目内隔离 `runtime/pylib`（pdfminer.six + pypdf） | `checks[pdf]` |
| LaTeX 引擎 | ✅ xelatex / lualatex / pdflatex（CTEX/MiKTeX） | `checks[latex]` |
| CLI 数据库 | ✅ SQLite schema v7，FTS trigram | `checks[db]` |
| 浏览器半 | ✅ 已进入 Web boot graph | `checks[client]` |
| Web 搜索提供方 | ⚠️ 见下文第 1 条，需重启一次 | `checks[web-search]` |
| Web 抓取提供方 | ⚠️ 同上 | `checks[web-fetch]` |

## 二、逐条修复记录

### 1. `dsh-finance` 路由泄漏（连带搞坏 web 搜索/抓取）

**现象**：每次插件重载都打印
`dsh-finance (dsh-finance): Error: webserver: duplicate prefix route "/plugins/dsh-finance/api"`。
后果是 finance 这次激活失败 → 它注册的 `dsh-web-search` 搜索提供方不存在 → 而 finance 自己的
patch 又把 `web.searchProvider` 配成了 `dsh-web-search` → `web_search` 报
`configured web provider "dsh-web-search" is not registered`。
同时 `web.fetchProvider` 没配，而 fetch 侧有两个提供方（`deepseek-fetch-api`、`http`）→
`web_fetch` 报 `multiple usable web providers are registered`。

**根因**：`D:\finance_ds\src\index.ts` 调用 `registerRoutes(...)` 时**丢掉了返回值**。
`registerRoutes` 返回的正是路由 dispose 函数，但从未挂到 `ctx.effect`，所以 fiber 卸载时
路由不释放，下一次 apply 撞重复路由。

**修复**：
```ts
ctx.effect(() => {
  const disposeRoutes = registerRoutes(...)
  return () => { try { disposeRoutes() } catch (err) { logger.warn('route dispose failed', { error: ... }) } }
})
```

**补充**：`D:\career_os\cordis.patch.yml` 增加了 `web` 行的覆盖，显式指定
`fetchProvider: http`（纯 HTTP，不需要 key），并**同时**写上 `searchProvider: dsh-web-search`，
因为 Loader 的 override 会整体替换 config，少写一个就会把另一个清掉。

**还需要一步**：当前进程里已经泄漏的路由没有 disposer，重载后仍在，所以**必须重启一次 DSH**。
重启后：finance 正常激活 → `dsh-web-search` 注册 → 搜索恢复；`fetchProvider: http` 在组合时生效 → 抓取恢复。
之后反复重载都不会再泄漏。

### 2. 误装 PyMuPDF 破坏了 Anaconda（已完全恢复）

我最初为了 PDF 解析往 Anaconda 全局 `pip install pymupdf`，它连带升级了 `onnxruntime`
和 `protobuf 7.36.2`，而你的 `streamlit 1.32.0` 要求 `protobuf<5` → **streamlit 被破坏**。

**处理**：卸载 pymupdf / pymupdf4llm / pymupdf-layout / onnxruntime / flatbuffers，
把 protobuf 装回 `4.25.6`。已验证 `import streamlit` 正常（1.32.0）。

**教训**：不往用户全局 Python 装东西。

### 3. PDF 依赖改为项目内隔离 + 一条命令装

- 位置：`D:\career_os\runtime\pylib`（`pip install --target`，14 秒）
- 备选库：`pdfminer.six`（中文/CID 字体最稳）、`pypdf`
- 提取脚本启动时自己把该目录插入 `sys.path`，所以用哪个 Python 都行
- 一键安装：
  - 面板/Agent：`career_runtime_setup`
  - 命令行：`node scripts/setup-runtime.mjs`
  - HTTP：`POST /plugins/dsh-career/api/runtime/setup`

### 4. 真实 PDF 解析从「挂死」到 1 秒

**现象**：原 stdlib 解析器在你这份 345KB 的 PDF 上**跑了 2 分多钟不返回**（被工具 20s 超时截断）。

**原因**：手写 `stream...endstream` + 括号扫描在畸形/大量 stream 上是灾难性开销，且中文 CID 字体本来就还原不了。

**修复**：分层策略 + 硬限额
1. `pdfminer.six` → 这份简历 1707 字、中文占比 53%、可读率 93.5%、**< 1 秒**
2. `pypdf` → 兜底
3. stdlib → 最后兜底，且限制：文件 ≤60MB、stream ≤800 个、单流解压 ≤4MB、逐字符扫描不用嵌套量词正则
4. 三者都不可用时明确报「扫描件/无文本层，改用粘贴」，不编造

### 5. Windows 管道编码（GBK）导致解析崩溃

**现象**：`UnicodeEncodeError: 'gbk' codec can't encode character '\u2022'`。
简历里的 `•` 在 stdout 被管道接走时（默认 ANSI 代码页 GBK）编码不了。

**修复**（三层）：
1. 脚本启动时 `sys.stdout.reconfigure(encoding='utf-8', errors='replace')`
2. 打印走 `emit()`，失败退回 `ensure_ascii=True`（JSON 语义不变）
3. 宿主起进程时注入 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`

### 6. 其它

- 错误信息不再只给 `Command failed:`，现在带 stderr 尾部与超时判定
- 新增 `career_job_delete` / `career_application_delete` / `career_resume_delete`，可以**选择性**清理数据，不必整库删除
- 演示数据已清理（3 个 example.com 岗位、1 条演示投递、3 条乱码素材、2 个演示简历版本）
- 数据目录只剩：`career.db`、`logs/career.log`、`tex/<hash>/`（LaTeX 编译产物）

## 三、重启后的验收步骤

1. 完全退出 DSH（托盘也要退），重新打开。
2. 新建/进入会话，运行：
   - `career_selfcheck` → 7 项应全绿，`web` 里应出现 `dsh-web-search`
   - 或 `GET /plugins/dsh-career/api/runtime/health`
3. 若 `web-search` 仍不绿：说明 finance 还有别的激活错误，看它启动日志里的 error。
4. 提醒：finance 的 `src/invest/tools.ts` 有你自己未提交的 +48 行（`verifyAdvice` 集成），
   我这次 `tsc` 重建了 `lib/`，等于把那份在写的代码一起编译进去了。若不想让它生效，请先回滚该文件再重建。

## 四、仍受限的地方（不是 bug）

- 国内招聘平台/论坛无公开接口，只能检索链接 + 手动粘贴（见 `source-playbook.md`）
- Workday 接口未用真实 tenant 验证
- 大厂校招 SPA 需要你从 F12 复制 JSON 接口地址
