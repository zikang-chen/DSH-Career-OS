# 交付验收报告

生成时间：2026-11-16 · 全部数字来自本会话实测，未使用虚构路径或日志。

## 一、运行环境（实测）

| 项 | 值 |
| --- | --- |
| Profile | `desktop`（`C:\Users\<you>\.dsh\profiles\desktop`） |
| Host 运行时 | Electron 44.7.0 / Node 24.21.0 |
| SQLite | `node:sqlite` 内置；`ftsMode = trigram` |
| 插件 | `dsh-career@0.1.0`，`link:D:\career_os`，fiber `applied` |
| 数据库 | `D:\career_os\data\career.db`（schema v4，WAL） |
| Web GUI | `http://127.0.0.1:54088` |

## 二、模块状态

| 模块 | 当前状态 | 实现方式 | 验证结果 | 后续事项 |
| --- | --- | --- | --- | --- |
| 画像与偏好 | 已安装并通过测试 | `user_profile` + 面板表单 + `career_profile_*` | 实测写入后完成度 0%→100%；单测覆盖映射与完成度 | 增加多目标画像 |
| 简历库 | 部分实现 | `resume_version` + `scripts/extract_resume.py`（stdlib 解析 docx/pdf）+ 启发式结构化 | 实测导入返回 0.886 识别率，`major`/实习条目/要点正确；单测覆盖分段与空内容 | PDF 用扫描件时不支持；无 docx 导出 |
| 岗位雷达 | 已安装并通过测试 | `job`/`job_source`/`job_status_history` + `normalizeJob`/`findJobIdentity` + FTS5 | 实测跨来源重复岗位合并为 1 条（`mergedBy=dedupe_key`）；单测覆盖 4 类身份信号 | JS 渲染的招聘页抓不到列表 |
| 第三方招聘平台 | 外部数据源受限 | 未实现采集；`source_health` 声明为 blocked | 面板/`career_status` 可见原因与替代方案 | 仅能手动粘贴 |
| 论坛与 Bar | 部分实现 | `forum_post`/`forum_claim`/`hiring_requirement` + 手动导入 | 单测验证转载去重与 C 级证据；Bar 严格四层分层 | 无自动采集（合规） |
| 匹配引擎 | 已安装并通过测试 | `analyzeMatch`：6 维加权 + 硬条件前置 | 实测 3 岗分组 73.5/54.5/35，算法岗触发 `暂不符合硬条件` 并写明"岗位限 2028届" | 权重可在画像里调 |
| 投递 CRM | 已安装并通过测试 | `application`/`application_event` 只追加时间线 | 实测 `ready → applied`，`applied_at` 自动打点，2 条事件 | 日历视图 |
| 公司与行业 | 部分实现 | `company`/`industry`/`research_report` | 实测公司归一化与别名留存；研究报告需 Agent 生成内容 | 行业内容待研究填充 |
| 面试准备 | 已实现但未验证 | `career_interview_prep` 组装准备包 | 单测与工具返回结构正确；未用真实面经跑端到端 | 需先导入面经 |
| 监控与提醒 | 已实现但未验证 | `monitoring_rule`/`notification`/`sync_run` + robots 优先抓取 | 单测验证失败留痕与崩溃收尾；未对真实招聘页跑一次 | 自动轮转默认关闭 |
| 面板 UI | 已实现但未验证 | `client/index.cjs` → `__ModuleLoader__` 包装，9 个页签，SSE 实时刷新 | **已入 boot graph**（rev `ef266884a9c0`），bundle 以 `text/javascript` 200 返回 71,348 字节；**未做浏览器内视觉验证** | 需你打开确认布局 |
| 数据导出/备份/删除 | 已安装并通过测试 | `exporter.js` 两步 token | 实测 prepare→commit 清空 22 张表，计数归零 | — |
| 校招时间线与作战计划 | 已安装并通过测试 | `host/plan.js` 按毕业年份推算 6 个窗口 + 数据驱动动作清单 | 实测 2027 届在 2026-11-16 落在「秋招补录」剩 76 天，下阶段春招 +105 天；13 个用例覆盖边界/阶段/动作 | 窗口是经验值，需按公司登记真实节点 |
| 综合分析简报 | 已安装并通过测试 | `buildBrief` 汇总时间线/意愿/岗位/门槛/前景/部门 | 实测生成并入研究简报库（reportId），缺数据项写入「未知与待核实」 | 前景与部门需 `career_outlook_add` / `career_unit_upsert` 填证据 |
| 招聘页批量抓取 | 已安装并通过测试 | `host/crawl.js`：JSON-LD → 内嵌 JSON → **JSON 接口** → 链接聚类 | 13 个用例（含裸 JSON 响应）；实测字节跳动校招页为 SPA，正确返回「抓不到」而非编造 | 大厂多为 SPA，需填其 JSON 接口地址 |
| 已投递清单 + CSV | 已安装并通过测试 | `applications.list` 多条件筛选 + `toCsv`（UTF-8 BOM） | 实测投递记录带 apply_url/location/deadline，CSV 含表头与「秋招」中文 | 可在面板筛选后一键导出 |
| 简历素材库（知识库） | 已安装并通过测试 | `resume_experience` + 上传自动沉淀 + 逐条确认 | 实测上传/解析后沉淀 3 条（education/internship/project），全部标「待确认」 | 可继续补充科研/奖项 |
| 针对岗位微调简历 | 已安装并通过测试 | `planTailor` 只挑选+排序，不重写事实 | 实测对「字节·数据分析」保留 3 段、命中 Python/SQL、列出缺口 `C/数据分析/A/B测试` | 缺口需补经历而非改写 |
| LaTeX 工作室（Overleaf 式） | 已安装并通过测试 | `host/latex.js` + 本机 XeLaTeX 编译 | 实测编译成功（xelatex 2604ms），PDF 23,924 字节，`/resume/pdf` 返回 `application/pdf` | 也可下载 .tex 去 Overleaf |
| ATS 公开接口采集 | 已安装并通过测试 | `host/ats.js`：Lever/Greenhouse/Ashby/SmartRecruiters/Workday | **实测 Lever 看板返回 10 条真实岗位**（标题/地点/投递地址齐全）；SmartRecruiters 实测 200 | Workday 待真实 tenant 验证 |
| 取数指引 | 已安装并通过测试 | `host/guide.js` + `career_source_guide` | 实测 SPA 抓取失败时自动附上「F12 找 JSON 接口」逐步指引 + 候选入口 + 填空模板 | 常见雇主入口表可扩充 |
| 市场信号与业务部门 | 已实现但未验证 | `market_signal` / `company_unit` + 两个工具 | 单测覆盖写入与 upsert；**库内尚无真实信号数据** | 需按带来源的检索逐条登记 |

## 三、验收用例（spec §12）

| 用例 | 结果 | 证据 |
| --- | --- | --- |
| A 上传简历并允许人工纠错 | ✅ 通过 | 单测 2 项；实测返回「候选 + 需确认」结构，面板有可编辑表单 |
| B 目标行业岗位保存 + 结构化查询 | ✅ 通过 | 画像写入 `target_industries/target_roles`；`career_job_search` 支持 8 类筛选 |
| C 同一岗位多来源不重复 | ✅ 通过 | 实测 `created:false, mergedBy:"dedupe_key"`；单测 4 项 |
| D 官方关闭后不再显示在招 | ✅ 通过 | 单测：`OPEN→CLOSED` 写历史；21 天未核验自动 `STALE` |
| E 论坛导入抽取主题/证据等级 | ✅ 通过（单元级） | 单测：同内容二次导入 `duplicate:true`；claim 默认 C 级 |
| F Bar 区分官方要求与论坛传闻 | ✅ 通过 | 单测验证 hard/preferred/observed/unverified 各 1 条且互不混入；`career_bar_analyze` 返回 disclaimer |
| G 匹配有依据、不虚构、不给录用率 | ✅ 通过 | 实测输出 `blockers:["岗位限 2028届，你的毕业年份是 2027"]` + `disclaimer` 明示非概率 |
| H 待投递→已投递持久化 | ✅ 通过 | 实测事件 `ready→applied` 入库，`applied_at=2026-11-16` |
| I 定时任务失败可见错误 | ✅ 通过 | 单测：失败规则 `last_status=error` 且有 `last_error`；`sync_run` 记录 `finished_at` |
| J 重启后插件/配置/DB 正常 | ✅ 通过 | 单测：重开同库数据在、迁移不重跑；实测插件重载 3 次后 36 工具与数据均正常 |
| K 无权限社区明确不可用 | ✅ 通过 | `/api/sources` 返回 `job_board`、`social_platform` 为 `enabled:false, accessMode:blocked` 并带原因 |

## 四、测试

```
$ node --test tests/core.test.mjs      # tests 28  pass 28  fail 0
$ node --test tests/render.test.mjs    # tests  8  pass  8  fail 0
```

`core.test.mjs` 覆盖：迁移幂等/事务回滚、简历解析（含空输入不臆测）、4 类岗位身份解析、状态机与历史、硬条件过滤、6 维匹配、Bar 分层、投递时间线、监控失败留痕、崩溃收尾、blocked 源声明、JD 解析（截止日/出勤/届别/技能边界）。

`render.test.mjs` 用 stub React 运行时真实执行组件树，覆盖：bundle 加载与导出面、slot 注册、FootAction、OverviewTab（完整/稀疏载荷）、各页签初始态、TABS 唯一性、错误边界拦截抛错。

过程中修掉的**真实缺陷**（均由测试或实测暴露）：
1. `mapJob` 输出 snake_case、匹配器读 camelCase → 硬条件曾静默失效。
2. 非官方来源改状态时只写历史未更新 `job.status`。
3. `ApplicationRepo.get` 查询了不存在的 `job.source_url` 列。
4. 迁移重复写入版本号（UNIQUE 冲突）。
5. `北京字节跳动科技有限公司` 与 `字节跳动` 未归一 → 去重失败（新增噪声词归一 + 别名留存）。
6. `每周出勤 5 天` 解析失败。
7. 技能 `C`/`R` 在 React/PyTorch 中被误命中。
8. **面板闪退（用户实报）**：`/bootstrap` 把 `jobStats`/`applicationStats` 放在 `digest` 里，OverviewTab 却按顶层解构 → `TypeError: Cannot read properties of undefined (reading 'total')`，默认页签一渲染就抛错，React 卸载整个 portal，表现为"点了不打开 / 一开就闪退"。

### 缺陷 8 的定位过程

没有浏览器控制，所以补了一个**渲染测试夹具** `tests/render.test.mjs`：用最小的 React hook 运行时 stub 加递归展开 `h()` 树，把真实组件树跑一遍。首次运行即复现：

```
TypeError: Cannot read properties of undefined (reading 'total')
    at OverviewTab
```

修复后并用**线上真实 `/bootstrap` 响应**复验（`jobStats at top level? false | inside digest? true`）：
`OverviewTab / TrackerTab / ResumeTab / SettingsTab` 全部 PASS。

### 顺带加固

- 新增 `PanelErrorBoundary`（类组件错误边界）：任何页签渲染失败只显示一张带真实错误信息的卡片 + 重试按钮，**不再让整个面板消失**。
- OverviewTab 对 `digest`/`completeness`/`status` 的所有字段做了缺省保护，部分载荷也能渲染（已加稀疏数据测试）。

## 五、接口自检

| 检查 | 结果 |
| --- | --- |
| `GET /plugins/dsh-career/api/bootstrap` | 200 |
| `GET /api/sources` | 200，5 个 connector（3 启用 / 2 blocked） |
| `GET /api/events`（SSE） | 200 `text/event-stream` |
| `GET /api/client-health` | `inGraph:true`，rev `ef266884a9c0` |
| `GET /plugins/??dsh-career/client.js&rev=…` | 200 `text/javascript`，71,348 字节 |
| `dsh-finance` 是否受影响 | 其 `/api/state` 仍 200（重载时打印的重复路由告警是金融插件自身既有问题） |

## 六、已知问题

1. **面板视觉未验证** —— 本会话无浏览器控制。已证明的是：bundle 进入 boot graph（当前 rev `952170d3a683`）并以 `text/javascript` 200 返回，且组件树在 stub 运行时下用真实 `/bootstrap` 载荷渲染通过。像素级正确性仍需你确认。
2. **示例数据** —— 库里现有 `演示用户（示例数据，可一键清除）`、3 个 `example.com` 岗位、1 条投递。真实使用前请到「设置 → 数据与隐私 → 删除全部数据」清除（先导出备份）。
3. **`dsh-finance` 重载告警** 与本次改动无关，但其路由未正确释放，重载会打印一次错误。
4. **自动监控默认关闭**（`scheduleEnabled:false`），避免未经你同意联网。
5. **抓取型页签的数据路径未逐条验证** —— 岗位雷达/公司/行业/论坛等页签需要先 `fetch` 到数据才渲染内容，stub 运行时只覆盖了它们的初始（loading）态。错误边界已兜底，若某页签报错会显示具体错误而不是闪退——把那段文字发我即可定位。
6. SQLite 文件当前 405 KB，FTS 索引随岗位量线性增长。

## 六-附、一次自查事故（记录在案）

修改 `client/index.cjs` 时，我用 PowerShell `Get-Content -Raw` + 字符串替换批量改文本，而 Windows PowerShell 5.1 默认编码不是 UTF-8，导致源码里的中文被错误解码后写回、全部变成乱码。发现后从上一版 `client/wrapped-bundle.js`（该文件由 Node 以 utf8 写出）中按包装标记精确还原出完整源码，校验 `hasChinese: true / mojibake: false` 后才继续，随后改用 UTF-8 安全的编辑工具重做修复。

**教训**：本项目的源文件含中文，绝不能用 PowerShell 文本命令批量替换源码；只用编辑工具或 Node 脚本处理。

## 七、下一阶段

1. 用真实简历 + 真实目标公司跑一遍，修 UI 里暴露的布局问题。
2. 对 2–3 个真实企业招聘页跑 `career_jobs_sync`，校准解析器（尤其 JS 渲染页面）。
3. 导入 10+ 条真实面经，验证 `career_interview_prep` 的题型归纳质量。
4. 打开 `scheduleEnabled` 做一周无人值守验证，观察误报率。
5. 视需要加 `docx` 简历导出与语义检索（embedding）。
