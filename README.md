# CareerOS

Personal AI career intelligence & internship management for **DeepSeek Harness**.

一个装进 DSH 的 Cordis bundle：36 个 Agent 工具 + 一个 9 页签的求职面板 + 本地 SQLite 知识库。
所有数据只存本机；不自动投递、不对外发信。

```
D:\career_os\            ← 这个包本身就是 bundle
├── host/                Host 半（纯 ESM，零外部依赖）
├── client/              浏览器半（手写 CJS → __ModuleLoader__ 包装）
├── scripts/             build-client.mjs · extract_resume.py
├── tests/               60 个 node:test 用例（核心/抓取/计划/渲染）
├── docs/                架构 / 数据模型 / 数据源政策 / 开发 / 使用 / 验收
└── data/                career.db · logs · backups · exports（运行时生成）
```

## 立即使用

1. 左侧边栏底部点 **🎯 求职面板**。
2. 「简历与画像」导入简历（文件路径或粘贴），确认解析结果。
3. 补齐可实习时间、每周天数、目标城市/行业/岗位。
4. 「岗位雷达」粘贴 JD 收岗位，或让 Agent 帮你找。
5. 看匹配分组 → 「加入投递」→ 在「投递管理」推进状态。

## 给 Agent 的常用说法

| 你说 | 它会调用 |
| --- | --- |
| 我现在算秋招什么阶段 / 接下来该干什么 | `career_plan` |
| 帮我做一份秋招作战计划（结合前景、门槛、部门） | `career_plan_brief` |
| 把这家公司的校招岗位全抓下来 | `career_jobs_crawl` |
| 这家公司的岗位到底去哪儿拿 / 复制哪个地址给你 | `career_source_guide` |
| 帮我看看现在该投什么 | `career_match_rank` |
| 把这条 JD 存进 CareerOS | `career_job_save` |
| 这个岗位是真的在招吗 | `career_job_verify`（官方来源才能改 OPEN/CLOSED） |
| 我的简历和这个岗位差在哪 | `career_resume_match` |
| 研究一下这家公司值不值得去 | `career_company_get` → `career_research_save` |
| 这个岗位在核心业务还是边缘部门 | `career_unit_upsert` + `career_outlook_add` |
| 这家公司招聘 bar 多高 | `career_bar_analyze`（官方/经验/传闻严格分层） |
| 帮我准备面试 | `career_interview_prep` |
| 我已投的都在哪一步了 / 导出清单 | `career_applications_list` `career_applications_export` |
| 今天有什么要处理的 | `career_digest` |

## 秋招计划怎么算的

- **时间线**：按你的毕业年份推算（2027 届 → 秋招在 2026）。提前批 / 正式批 / 补录 / 春招 / 毕业窗口，每段都有窗口与倒计时。窗口是**行业常规节奏（经验值）**，公司级节点用 `career_event_add` 登记后会覆盖进去。
- **动作清单**：从你的画像完成度、岗位池、在投数量、14 天内截止、逾期跟进算出来。数字变了清单就变。
- **综合简报**：把时间线、意愿、岗位优先级与投递地址、门槛分层、市场信号、部门前景拼成一份 Markdown，**缺数据的部分写进「未知与待核实」而不是编**。
- **前景与部门**：`career_outlook_add` / `career_unit_upsert` 要求每条断言带来源、日期与证据等级（A 官方一手 / B 多源印证 / C 单一可溯源 / D 未证实 / U 信息不足）。

## 抓取能抓到什么

按优先级：**已知招聘系统的公开 API** → `schema.org JobPosting` JSON-LD → 页面内嵌 JSON（`__NUXT__` / `window.__INITIAL_STATE__`）→ 直接返回 JSON 的招聘接口 → 链接聚类 → 都没有就明确告诉你抓不到，**并给出精确到 URL 的取数指引**。

已实测可用的公开接口（免登录、免 key）：

| 平台 | 接口 |
| --- | --- |
| Lever | `https://api.lever.co/v0/postings/{company}?mode=json` |
| SmartRecruiters | `https://api.smartrecruiters.com/v1/companies/{company}/postings?limit=100` |
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true` |
| Workday | `POST https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`（待真实 tenant 验证） |

> 实测：`jobs.bytedance.com/campus` 是纯前端渲染，HTML 里没有岗位数据。系统返回「抓不到」+ **F12 找接口的逐步指引** + 候选招聘入口 + 填空模板，**不会编造岗位**。详见 [docs/source-playbook.md](docs/source-playbook.md)。
>
> 反向验证：`career_jobs_crawl` 抓 Lever 演示看板，返回 **10 条真实岗位**（标题/地点/投递地址齐全）。

## 投递管理：要证据链，不要状态标签

投递记录不只是「投了哪家」，而是**可复盘的凭据**：

- **JD 快照** —— `career_application_create` 会把当时的 JD 冻结进记录。岗位被 sync 刷新或删除后，
  面试前一天仍能看到「我当时投的是什么要求」。
- **材料快照** —— 记录这次提交用了哪版简历、附了哪些资料（`docIds`），没指定就诚实标注「未指定」。
- **冷冻期提醒** —— 同公司 6 个月内重复投递会直接告警（多数公司有冷冻期，重复投递会被筛掉）。
- **转化漏斗** —— `career_funnel` 按「达到过的最高阶段」统计 投递→测评/笔试→一面→二面→终面→Offer，
  给出阶段通过率、卡点、分渠道转化、停滞 ≥14 天的记录。
  复盘要看的是**哪一关在漏人**，不是投了多少家；
  样本 <10 条会明确提示「转化率不稳定，先攒样本」。
- **网申信息卡** —— `career_apply_card` 把投递表单要填的字段按顺序摊平（姓名/证件/学历/在读起止/排名/
  语言成绩/求职意向/附件），一键复制到招聘系统；**缺的字段如实标空**，并告诉你去哪补，不代填。

## 设计原则（对应实现）

- **Local first** —— SQLite 在本机；简历原文与联系方式不出机器。
- **Source first** —— 每条岗位事实都有 `job_source` 行（类型/链接/时间/摘录/可信度）。
- **Evidence chain** —— 投递也要有原始凭证：冻结 JD + 材料快照，岗位下架后判断仍可回放。
- **Verification first** —— 第三方线索只能把 `UNKNOWN` 升为 `UNVERIFIED`；`status_verified_at` 只由官方证据刷新；超期自动 `STALE`。
- **Graceful degradation** —— 抓不到的来源在「数据源健康」里明确标记，并给出手动导入与搜索入口，绝不编造。
- **Human in the loop** —— 简历解析是"提案"，确认后才入库；删除数据需两步 token。
- **Plugin first** —— 未改任何 DSH 核心源码。

## 文档

- [架构与技术决策](docs/architecture.md)
- [数据模型与状态机](docs/data-model.md)
- [数据源政策与合规边界](docs/source-policy.md)
- [开发者指南](docs/plugin-guide.md)
- [使用指南](docs/user-guide.md)
- [交付验收报告](docs/acceptance-report.md)

## 开发

```powershell
node --test tests\core.test.mjs      # 单个套件
node --test tests\                   # 全部 133 个测试（9 个套件）
node scripts\build-client.mjs        # 改过 client/index.cjs 后重新生成 bundle
node scripts\setup-runtime.mjs       # 装 PDF 解析依赖到项目内 runtime/pylib
```

改 Host 代码后重载插件：`plugin_manager set_plugin enabled=false/true target=include:dsh-career`。

## 现状

schema **v9** / ftsMode `trigram` / **67 工具** / 9 个测试套件 133 个用例全绿 / 面板已进入 Web boot graph。
`data/` 与 `runtime/` 不入库（含真实简历与联系方式）；新机器克隆后跑一次 `scripts/setup-runtime.mjs` 即可。
详见 [docs/acceptance-report.md](docs/acceptance-report.md) 与 [docs/environment.md](docs/environment.md)。
