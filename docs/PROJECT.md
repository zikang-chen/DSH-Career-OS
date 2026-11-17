# CareerOS 项目介绍 · 功能讲解 · 架构说明

> 数据时点：2026-11-17。所有数字取自本机数据库与测试运行结果。
> 面向「想搞懂它是什么、怎么搭起来的、边界在哪」的人。

---

## 一、它是什么

**CareerOS 是一个装进 DeepSeek Harness（DSH）的求职情报与实习管理系统。**

形态上它是一个 **Cordis bundle**（插件包），不是独立 App：

- 装进 DSH 后，多出一个**右侧求职面板**（9 页签）和 **73 个 Agent 工具**
- 所有数据存本地 SQLite，**不出本机**
- **不自动投递、不对外发信**——只做情报、决策辅助和管理

它解决的问题很具体：国内校招/实习的信息是分散的（官网、论坛、公众号、内推群），
岗位列表每周在变，投递出去之后就石沉大海无法复盘，简历改一版就丢一版。
CareerOS 把这四件事收进一个本地系统：**发现岗位 → 判断匹配 → 定制简历 → 投递复盘**。

### 一句话技术定位

| 项 | 值 |
| --- | --- |
| 语言/运行时 | 纯 ESM JavaScript（Host）+ 手写 CJS（Client），跑在 Electron 44 / Node 24 |
| 外部依赖 | **零**（只用 `node:` 内置模块） |
| 数据库 | `node:sqlite`（内置），schema **v11**，FTS5 trigram 全文检索 |
| 实体表 | **34 张**（另 5 张 FTS 影子表） |
| Agent 工具 | **73 个** |
| 面板 | 9 页签，React（手写 createElement）→ 字符串包装成 `__ModuleLoader__` 模块 |
| 测试 | **176 个用例，12 个套件，全绿** |
| 代码规模 | Host ≈ 9,700 行 · Client ≈ 2,350 行 · 测试 ≈ 1,700 行 |

**为什么零依赖**：DSH 插件要在宿主 Electron 里加载，引入第三方包会带来版本冲突和体积问题。
`node:sqlite`、`fetch`、`WebSocket`（CDP 用）都是 Node 24 内置的，够用。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  DeepSeek Harness (Electron 44 / Node 24)                    │
│                                                              │
│  ┌───────────────────────┐    ┌───────────────────────────┐ │
│  │  Host 半（Node 进程）  │    │  Client 半（浏览器/renderer）│ │
│  │  host/index.js         │    │  client/index.cjs          │ │
│  │   ├ ctx.tools.register │◄──►│   ├ 9 页签面板（React）     │ │
│  │   ├ ctx.webServer      │HTTP│   ├ createPortal 弹层       │ │
│  │   └ ctx.effect 清理    │SSE │   └ __ModuleLoader__ 包装    │ │
│  └──────────┬────────────┘    └───────────────────────────┘ │
│             │                                                 │
└─────────────┼─────────────────────────────────────────────────┘
              │
    ┌─────────┴──────────┬──────────────┬─────────────────┐
    ▼                    ▼              ▼                 ▼
┌────────┐        ┌──────────┐   ┌───────────┐   ┌──────────────┐
│SQLite  │        │外部数据源 │   │专用浏览器  │   │ 本机能力      │
│career  │        │·ATS 公开  │   │（Edge/    │   │·xelatex 编译 │
│  .db   │        │ API      │   │ Chrome）   │   │·pdfminer 解析│
│34 张表 │        │·招聘页HTML│   │ + CDP     │   │·Python 子进程 │
└────────┘        └──────────┘   └───────────┘   └──────────────┘
```

### 2.1 两半的分工

| | Host 半 | Client 半 |
| --- | --- | --- |
| 跑在哪 | Node 进程 | 浏览器（renderer） |
| 职责 | 所有业务逻辑、数据库、网络、文件、子进程 | 只做展示与交互 |
| 对外 | 注册 73 个 Agent 工具 + 100+ HTTP 路由 | 通过 `/plugins/dsh-career/api/*` 调 Host |
| 状态 | 唯一真相源（SQLite） | 全部从接口拉，无本地持久状态 |

**关键约束**：Client 半**不做任何业务判断**。它只渲染 Host 给的数据、把用户操作转成 HTTP 请求。
所以「逻辑对不对」永远能在 Host 侧用测试验证，不需要跑浏览器。

### 2.2 为什么 Client 要手写 CJS + 字符串包装

DSH 的 client 模块加载器要 `window.__ModuleLoader__.load({id, factory})` 形式。
为了避免引入 Rollup/Vite/TSC 整条工具链，`scripts/build-client.mjs` 做一件很朴素的事：
读 `client/index.cjs`，用一层字符串包成 loader 格式，输出 `client/wrapped-bundle.js`。
**没有编译、没有 tree-shaking**，改完源码跑一条命令就生效。

---

## 三、Host 侧模块地图

Host 按「纯逻辑」和「有状态」分开，纯逻辑模块不碰数据库，方便单测。

### 3.1 纯逻辑层（无副作用，易测）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `domain.js` | 512 | 岗位归一化、去重键、身份解析、六维匹配引擎、技能抽取 |
| `crawl.js` | 446 | HTML 抓取策略链：JSON-LD → 内嵌 JSON → 链接聚类；字段识别 |
| `ats.js` | 229 | Lever / Greenhouse / Ashby / SmartRecruiters / Workday 归一器 |
| `browser.js` | 414 | 专用浏览器启动、CDP 客户端、响应候选打分、标签页复用 |
| `curl.js` | 237 | cURL 解析、SSRF 防护、单次重放 |
| `portal.js` | 147 | 15 家公司校招入口 + 现场探测 |
| `merge.js` | 192 | 多源简历合并：要点级去重、冲突检测、幂等 |
| `documents.js` | 176 | 证件分类、分数抽取、按岗位相关性排序 |
| `tailor.js` | 220 | 简历挑选/排序/精简、同义技能归并、章节顺序 |
| `plan.js` | 325 | 校招时间线推算、动作清单、9 节综合简报 |
| `funnel.js` | 141 | 投递漏斗：最高阶段统计、通过率、卡点 |
| `applycard.js` | 150 | 网申信息卡组装 |
| `latex.js` | 174 | LaTeX 渲染、xelatex 编译与缓存 |
| `guide.js` | 155 | 取数指引（ATS 接口或 F12 步骤） |
| `sources.js` | 309 | 粘贴解析、论坛检索词 |

### 3.2 有状态层（repo/）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `repo/jobs.js` | 553 | 岗位 CRUD、公司归一、来源证据、状态历史、去重合并 |
| `repo/profile.js` | 565 | 画像、简历版本、经历素材库、个人资料库 |
| `repo/applications.js` | 281 | 投递记录、JD 冻结、材料快照、状态时间线、冷冻期 |
| `repo/captures.js` | 227 | 抓取留痕、7 天过期、diff 基线、JD 快照 |
| `repo/intel.js` | 328 | 公司/行业/部门/前景信号/门槛/论坛观点 |
| `repo/monitor.js` | 204 | 监控规则、通知、数据源健康 |

### 3.3 装配层

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `schema.js` | 709 | 11 次版本化迁移，append-only，永不改老迁移 |
| `db.js` | 210 | DatabaseSync 门面：migrate / tx / backup |
| `tools.js` | 2364 | 73 个 Agent 工具定义 |
| `routes.js` | 910 | 100+ HTTP 路由 + SSE |
| `index.js` | 228 | 插件入口：装配、注册、ctx.effect 清理 |
| `resume.js` | 318 | PDF/DOCX 提取（分层引擎）、简历解析 |
| `runtime.js` | 130 | 环境自检、PDF 依赖安装 |
| `monitor.js` | 258 | 后台监控调度 |

---

## 四、数据模型（34 张实体表，分 6 组）

### 4.1 画像与简历（7 张）
`user_profile` · `resume_version` · `resume_experience`（经历素材库）· `personal_document`（证件凭据）· `skill` · `settings` · `schema_migrations`

### 4.2 岗位与来源（6 张）
`job` · `job_source`（来源证据）· `job_status_history`（append-only 状态变更）· `job_note` · `company` · `company_watch`

**核心设计**：`job.status` 只镜像最新核验值，**真实历史在 `job_status_history`**。
第三方线索只能把 `UNKNOWN` 升为 `UNVERIFIED`；只有官方证据能改成 `OPEN/CLOSED`；超期自动 `STALE`。

### 4.3 抓取留痕（2 张）
`company_capture`（每次抓取：时间/范围指纹/**seen_codes 基线**/条数）· `jd_snapshot`（JD 内容快照 + 哈希）

### 4.4 投递管理（2 张）
`application`（含 `submitted_jd` 冻结 JD、`submission_snapshot` 材料快照）· `application_event`（状态时间线）

### 4.5 公司/行业情报（10 张）
`industry` · `company_unit`（部门核心度）· `market_signal`（前景信号）· `research_report` · `hiring_requirement` · `interview_experience` · `forum_post` · `forum_claim` · `evidence` · `recruit_event`（校招节点）

### 4.6 系统（7 张）
`match_result` · `monitoring_rule` · `notification` · `source_health` · `sync_run` · `feedback` · `job_fts*`（FTS5 trigram）

> FTS5 用 trigram 分词，所以中文能直接做子串检索，不需要额外分词器。

---

## 五、三条主数据流

### 5.1 岗位采集流

```
入口(4 种)                    识别                     落库
─────────                    ─────                    ─────
ATS 公开 API ─┐
专用浏览器 CDP ─┤          extractPostingsFromPayload   importPostings
cURL 重放 ─────┼─────────►  ├ ATS 归一器逐个试         ├ 公司归一化
HTML 抓取 ─────┘            └ 通用 JSON 岗位数组识别    ├ 去重（编号>URL>标题相似）
                                                      ├ 写 job + job_source
                                                      ├ 记 company_capture(+seen_codes)
                                                      └ 存 jd_snapshot
```

**去重三级**：岗位编号 → 来源 URL → 公司+标题相似度（≥0.82）+ 地点兼容。
**关键修正**：有岗位编号时不按 URL 认身份——一次列表抓取里所有岗位共用一个 pageUrl。

### 5.2 简历出稿流

```
画像 + 素材库 + 资料库
        │
        ▼ planTailor：按岗位关键词给每段经历打分排序
        │  ├ 章节顺序随岗位变（产品岗实操前置）
        │  ├ 每段只留最相关 N 条要点
        │  └ 同义技能归并（英语←TOEFL/IELTS/CET，大模型←LLM/VLM/LoRA）
        ▼ planDocumentSelection：按相关性挑证书
        ▼ sectionsFromSelection → renderResumeTex / renderResumeText
        ▼ compileTex（xelatex，sha1 缓存）
       PDF + 纯文本 + 缺口清单
```

**只做挑选和排序，不生成任何新事实。** 缺口如实列 `gaps`。

### 5.3 投递复盘流

```
application(冻结 JD + 材料快照)
        │
        ▼ application_event（每次状态变更 append-only）
        ▼ computeFunnel：按「达到过的最高阶段」统计
        │  ├ 各阶段到达人数 / 通过率 / 到达率
        │  ├ 卡点（流失最多的一跳）
        │  ├ 分渠道转化
        │  └ 停滞 ≥14 天
        ▼ 样本 <10 明确提示「不稳定，先攒样本」
```

---

## 六、四个关键设计决策

### 6.1 证据分级 A/B/C/D/U

任何可能出错的结论都必须带来源与等级：
- **A** 官方一手（公司官网、监管文件）
- **B** 多源印证
- **C** 单一可溯源
- **D** 未证实
- **U** 信息不足

`career_outlook_add`、`career_evidence_add`、岗位状态、论坛观点全部强制带等级。
**没有依据的不写成结论，写进「未知与待核实」。**

### 6.2 抓取留痕 + 7 天过期 + 正确的 diff 基线

岗位列表是流水，所以每次抓取都记 `seen_codes`（本轮看到哪些岗位编号）。
下次 diff **只跟同范围的上次基线比**——这是踩过坑改出来的：
拿整个公司岗位库当基线，换个筛选范围再抓就会把别的批次全报成「下架」。

没有基线时明确说「无法可靠判定下架」，不编数字。

### 6.3 专用浏览器而不是内置浏览器

DSH 内置浏览器是沙箱化 Electron `<webview>`，`DesktopBrowserBridge` 只开放
`acquire / release / onOpenRequested`（源码注释：no Electron objects or arbitrary IPC cross this interface）。
插件读不到它的 DOM 或网络请求。

所以系统**另起一个独立 Edge/Chrome 进程**（独立 profile 在 `data/browser-profile`），
用 CDP 附着标签页、重载触发 XHR、截响应。调试端口只绑 `127.0.0.1`。

### 6.4 本地优先 + human in the loop

- 数据只存本机；`data/` 和 `runtime/` 不进 Git
- 简历解析是「提案」，确认后才入库
- 删除数据需两步 token
- 未改任何 DSH 核心源码

---

## 七、安全与合规边界（写进代码，不是口号）

| 边界 | 实现 |
| --- | --- |
| 只读公开页面 | 抓取前读 robots.txt，串行 + 节流（默认 2.5s） |
| 不破解签名 | 只重放用户自己浏览器里合法的请求 |
| 不绕登录 | 用用户自己的登录态，不构造凭证 |
| 防 SSRF | cURL 重放只允许 http/https，拒绝 `file://`、`localhost`、内网 IP |
| 凭证脱敏 | Cookie/Authorization 输出一律替换为 `<已脱敏 N 字符>` |
| 单次请求 | 不翻页循环、不并发撞接口 |
| 不代投递 | 只记录，没有任何自动提交能力 |

---

## 八、测试与质量

12 个套件，176 个用例，**全部离线**（不开网络、不起浏览器、不依赖本机环境）：

| 套件 | 用例 | 覆盖 |
| --- | --- | --- |
| `core.test.mjs` | 28 | 数据库、迁移、去重、状态机 |
| `merge.test.mjs` | 14 | 多源合并、要点去重、冲突 |
| `documents.test.mjs` | 14 | 证件分类、分数抽取、相关性 |
| `crm.test.mjs` | 18 | 信息卡、漏斗、JD 冻结 |
| `portal.test.mjs` | 18 | 门户解析、过期、diff、基线 |
| `curl.test.mjs` | 16 | cURL 解析、SSRF、脱敏 |
| `crawl.test.mjs` | 13 | 抓取策略、字段识别 |
| `plan.test.mjs` | 13 | 时间线、动作、简报 |
| `resume-vault.test.mjs` | 11 | 出稿、缺口、同义归并 |
| `sources-api.test.mjs` | 14 | ATS 归一器 |
| `browser.test.mjs` | 9 | 浏览器发现、响应打分 |
| `render.test.mjs` | 8 | 面板渲染（stub React，能复现白屏） |

`render.test.mjs` 值得说：它用 stub React 渲染面板组件，
当初就是靠它复现并修掉了「面板一打开就白屏」的 bug。

---

## 九、目录结构

```
D:\career_os\
├── host/                  Host 半（34 个 .js，零外部依赖）
│   ├── index.js           插件入口，装配一切
│   ├── tools.js           73 个 Agent 工具
│   ├── routes.js          100+ HTTP 路由 + SSE
│   ├── schema.js          v1→v11 迁移
│   ├── domain/crawl/ats/… 纯逻辑模块
│   └── repo/              有状态仓储
├── client/
│   ├── index.cjs          面板源码（CJS，手写 React）
│   └── wrapped-bundle.js  构建产物（不要手改）
├── scripts/
│   ├── build-client.mjs   包装 client 源码
│   ├── setup-runtime.mjs  装 PDF 依赖到项目内
│   ├── extract_resume.py  分层 PDF 提取
│   └── probe-*.mjs        站点接口探测工具
├── tests/                 12 个套件，176 用例
├── docs/                  见下
├── locale/zh.json en.json
├── package.json           bundle manifest
├── cordis.patch.yml       插件配置（含 web 提供方修复）
└── data/                  career.db / 简历 / 浏览器 profile / LaTeX 产物（不进 Git）
```

---

## 十、文档导航

| 文档 | 内容 |
| --- | --- |
| [使用教程](TUTORIAL.md) | 按任务查：找岗位、改简历、投递、复盘 |
| [进度与功能清单](STATUS.md) | 已完成什么、验证证据、已知限制、下一步 |
| [架构与技术决策](architecture.md) | 更细的模块边界与取舍 |
| [数据模型](data-model.md) | 表结构与状态机 |
| [数据源政策](source-policy.md) | 合规边界与抓取规则 |
| [环境修复记录](environment.md) | 环境问题怎么修的（含踩坑） |
| [开发者指南](plugin-guide.md) | 怎么改这个插件 |

---

## 十一、已知边界（不是 bug）

1. **内置浏览器不可用** —— 沙箱 webview，插件读不到页面。必须用专用浏览器。
2. **列表只抓首页 10~20 条** —— 字节 `count: 6559`，一次只取 `limit=10`。要更多需滚动翻页或多响应合并。
3. **有些站点列表不给 JD 正文** —— 如腾讯 `searchPosition` 只返回标题+地点。系统如实说明，不编。
4. **招聘时间线未做** —— JD 里有零散日期，但没抽成结构化节点。
5. **图片型证件不做 OCR** —— 只登记文件，字段手工补。
6. **通用 PDF 解析器读学术型 CV 会错** —— 所以结构化为人工合并，原文永存。
7. **Workday 接口未用真实 tenant 验证** —— 代码路径在，没跑通实例。
8. **腾讯详情页 URL 未渲染验证** —— `post.html?id=` 返回 200 且是投递页，但没验证渲染出的是否就是该岗位。
