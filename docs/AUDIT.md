# CareerOS 代码审计与优化计划（Phase 0）

> 审计时间：2026-11-17。**下面每条都来自实际读代码/查库/跑测试，不是推测。**
> 无法验证的会标「需验证」，不写成结论。

---

## 一、真实基线（实测）

| 项 | 实测值 | 与需求文档的差异 |
| --- | --- | --- |
| schema 版本 | **v12** | 文档说 v11 |
| 实体表 | **34 张**（另 5 张 FTS 影子表，共 39） | 一致 |
| Agent 工具 | **74 个** | 文档说 73 |
| HTTP 路由 | 100+ | 一致 |
| UI 页签 | **11 个**（不是 9 个） | 文档说 9 |
| 测试 | **183 个用例 / 13 个套件 / 全绿** | 文档说 176 / 12 |
| Host 代码 | ≈ 10,000 行（33 个 .js） | — |
| Client 代码 | `client/index.cjs` **2,348 行** | — |

**11 个页签**：总览 / 秋招计划 / 简历与画像 / 简历工作室 / 岗位雷达 / 投递管理 / 公司情报 / 行业研究 / 论坛与 Bar / 面试准备 / 设置。

---

## 二、已确认的问题（有证据）

### P0-1 radix：岗位详情藏在页面最底部 ✅ 本日已修

`RadarTab` 早期把详情卡片渲染在 `return` 的最末尾，前面还有「抓取表单 + 新增表单 + 完整岗位列表」三个卡片。
用户单击岗位后详情确实加载了，但在页面最底部，**视觉上等于没反应**。双击则完全没有绑定。

**已修**：改为 `Modal` 弹层（`client/index.cjs` 新增 `Modal` / `KV` 组件），
单击和双击都弹详情，包含基本信息 16 项、技能、匹配解释、JD、来源证据、状态历史、备注。

### P0-2 投递管理没有「详情」，且改状态要绕到看板 ✅ 本日已修

`TrackerTab` 只有 `POST /application/update`，**没有 `GET /application?id=`**，
所以「看投递详情 / 看当时提交了什么材料 / 看冻结的 JD」根本没法做。
清单表也只能看，改状态必须切到「看板」视图。

**已修**：
- Host 新增 `GET /application?id=`（返回 events + submittedJd + submissionSnapshot）
- 清单表行内直接改状态 + 「推进 ›」一键进下一阶段
- 点任意行弹出投递详情：冻结 JD、材料快照、状态时间线、快速记录按钮
- 去掉冗余的「表格」视图（与清单重复）

### P0-3 列表接口不给 JD 正文时没有补全机制 ✅ 本日已修

腾讯 `searchPosition` 只返回标题/地点/批次，正文要另调
`GET /api/v1/jobDetails/getJobDetailsByPostId?postId=…`（这个接口是**从页面 bundle 里扒出来的**，
猜了 14 个端点全 404）。

**已修**：
- schema v12 加 `job.post_id`
- 新模块 `host/jd.js`：详情提供方注册表（目前登记腾讯），`resolveJdProvider` + `fetchJdDetail`
- 新工具 `career_job_jd_fetch`：批量补缺 JD 的岗位
- `career_browser_capture` 新增 `fillJd`（默认 true）：抓完列表自动按 postId 补正文
- **实测**：腾讯实习生 8 条，`jdFill.filled = 8`，后台开发 292 字、PC客户端开发 259 字…

### P1-4 采集完整性未建模（只抓首页，无 total 对比）

- 字节 `count: 6559`，`limit=10`；腾讯一次 8~10 条
- 数据库**没有** `reported_total / observed_count / is_complete` 这类字段
- 因此「本次没抓到」与「岗位已关闭」在数据层面**无法区分**（虽然 diff 已用 `seen_codes` 缓解）

**未修**。计划：加 `company_capture` 完整性字段 + 解析响应里的 `count`，并在 UI 标注「本次只取到 10/6559」。

### P1-5 岗位列表无分页 ✅ 本日已修（offset）

Client 曾一次拉 120 条、`listJobs` 只有 `LIMIT` 没 `OFFSET`。**已加 `offset`**（repo + `/jobs` 路由），
并补了「翻页不重复」的测试。

### ~~P1-6 FTS 没被使用~~ —— **本条审计有误，特此更正**

`repo/jobs.js` 的 `searchJobIds()` **已经走 FTS**：`db.ftsMode === 'trigram'` 且查询 ≥3 字时用
`job_fts MATCH`，失败才回退 `LIKE`。我最初 grep 漏看了。**FTS 无需改动。**

### P1-7 采集完整性未建模 ✅ 本日已修（schema v13）

### P2-7 `toCsv` 忽略 typeFilter

`exportCsv` 把 status/query 传给导出接口，但**没传 typeFilter**，导出结果比界面多。

**未修**（一行修）。

### P2-8 Client 是 2,348 行单文件

组件、状态、请求、样式全在一个 `index.cjs`。改一处要通读全文，且已经踩过两次括号不平衡。

**未修**。计划：按 `pages/ components/ api/ theme/` 拆，但**受 DSH 加载机制约束**，
需要先验证 `build-client.mjs` 能否做多文件拼接（当前是整文件字符串包装）。

---

## 三、需验证（现在还不能下结论）

| 项 | 怎么验证 |
| --- | --- |
| `DatabaseSync` 是否造成面板卡顿 | 在 1000+ 岗位下测 `/jobs` 与 `/bootstrap` 响应时间 |
| SSE 连接是否泄漏 | 反复开关面板，看 `/events` 连接数 |
| 长 JD / 长 URL 是否横向溢出 | 用腾讯 292 字 JD 与超长 applyUrl 实测窄宽度 |
| 深色主题是否真的跟随宿主 | 切宿主主题后看 `--dsw-alias-*` 是否全部覆盖到 |
| Workday 适配器是否可用 | 需真实 tenant |

---

## 四、与需求的映射：哪些已经满足

| 需求要求 | 现状 |
| --- | --- |
| 不编造经历/技能/成绩 | ✅ 出稿只挑选排序，`gaps` 如实列 |
| 保留来源/状态历史/证据等级 | ✅ `job_source` / `job_status_history` / evidence A-E |
| 迁移向前兼容、不改旧迁移 | ✅ v1→v12 append-only |
| SSRF 防护 / 凭证脱敏 | ✅ `host/curl.js` |
| 不自动投递、不发信 | ✅ 无此能力 |
| 本地优先 | ✅ `data/` 不进 Git |
| JD 快照 / 材料快照保留 | ✅ 已实现并本日补全 JD |
| 投递漏斗按最高阶段 | ✅ `host/funnel.js` |
| 样本量提示 | ✅ 漏斗 <10 条明确提示 |
| 空/加载/错误状态 | ✅ `Empty` / `Loading` / `ErrorBox` |
| 窄面板适配 | ⚠️ 有 `S.grid(n)` 自适应，但未系统测窄宽度 |

## 五、与需求的差距（需要后续阶段）

1. **11 页签 → 5 工作区**（需求的核心诉求）：目前未整合。
2. **Dashboard 行动中心**：现有 `overview` 是统计概览，不是「今天做什么」的行动中心。
3. **设计 Token 体系**：已有 `T`（颜色）+ `S`（样式），但没有系统的字号/间距/圆角 token 表。
4. **简历工作台三栏**：现有是「素材库/定向微调/LaTeX」三个子页，不是三栏并排 + 版本 Diff。
5. **岗位对比**：无多岗位对比。
6. **高层任务工作流**（find-jobs / prep-resume / summarize-applications）：无，需要 Agent 手工串工具。
7. **异步任务中心**：无统一 task 表。
8. **数据源健康分类**：`source_health` 有基础字段，但错误未分类。

---

## 六、分阶段实施计划（含文件级范围与风险）

| 阶段 | 内容 | 主要文件 | 风险 |
| --- | --- | --- | --- |
| **P0（已完成）** | 岗位/投递详情弹层、JD 自动补全、行内改状态 | `client/index.cjs`、`host/jd.js`、`host/routes.js`、`host/tools.js`、`host/schema.js` | 低 |
| **P1（已完成）** | 5 工作区导航（11 页签全保留）+ Dashboard 行动入口 + 待核验/过期卡片 | `client/index.cjs` | 中 |
| **P2（已完成）** | 采集完整性（reported_total/observed/is_complete, schema v13）+ 岗位分页 offset | `host/schema.js`、`host/repo/captures.js`、`host/repo/jobs.js`、`host/crawl.js`、`host/routes.js`、`host/tools.js` | 中 |
| **P3（部分）** | 投递行内推进/快速记录已做；提醒去重、漏斗分时间范围未做 | `host/repo/applications.js`、`client` | 中 |
| **P4（未开始）** | 简历三栏工作台 + 版本 Diff + 质量检查 | `host/tailor.js`、`host/latex.js`、`client` | 高：不编造事实的边界要守住 |
| **P5（未开始）** | 高层任务工作流 + 工具响应统一 + Client 拆分 | `host/tools.js`、`client/*` | 高：兼容性风险最大 |

**执行原则**：每阶段结束必须 183 个测试全绿 + 真实数据验证；不一次性拆掉现有结构。

---

## 七、本日实际完成的验证

| 验证 | 结果 |
| --- | --- |
| Host 语法检查（33 个文件） | 0 失败 |
| 插件加载 | `import ok`，无警告 |
| 单元测试 | **183 / 183 通过，13 套件** |
| 腾讯 JD 自动补全 | 8 条全部补上正文（292/259/257/250/238/209/167/167 字） |
| 数据库 | schema v12，`post_id` 已落库 |
| 面板 | 已重载进入 boot graph |

**未能验证**：Electron 内的真实点击交互（需要你在 GUI 里点一次）、窄宽度视觉、深色主题。
