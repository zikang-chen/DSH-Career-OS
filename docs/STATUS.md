# CareerOS 进度与功能清单

> 数据时点：2026-11-17。数字全部取自本机数据库与测试运行结果，不是估算。
> 每次改动后应更新本页；**没验证过的写「未验证」，不写成「已完成」**。

## 一、一句话现状

一个装进 DSH 的 Cordis bundle：**78 个 Agent 工具 + 5 工作区求职面板（11 个页签全保留）+ 本地 SQLite 知识库**，
从「发现岗位」到「定制简历」到「投递复盘」的链路已经跑通，并已用**字节跳动、腾讯两家真实校招站**端到端验证。

| 指标 | 值 |
| --- | --- |
| schema 版本 | **v13**（13 次迁移，append-only） |
| Agent 工具 | **78 个** |
| 测试 | **210 个全绿**，18 个套件 |
| 面板 | 5 工作区 / 11 页签全保留，已进入 Web boot graph |
| 运行时依赖 | **零外部依赖**（只用 `node:` 内置） |
| 库内真实数据 | 21 个岗位 · 27 条岗位来源 · 52 条 JD 快照 · 8 次抓取记录 |

## 二、已被真实数据验证的链路

下面每条都跑过真实网络请求，不是设计稿。

### 1. 岗位发现（四条路，按可靠性排序）

| 路径 | 实测证据 | 适用 |
| --- | --- | --- |
| 已知 ATS 公开 API | `api.lever.co/v0/postings/leverdemo` → 10 条岗位 | Lever / Greenhouse / Ashby / SmartRecruiters |
| **专用浏览器 + CDP 自动抓** | 字节 10 条、腾讯 11 条（6 秋招 + 5 实习） | 大厂 SPA 校招站（需登录） |
| 重放用户 cURL | `ats:lever` → 10 条岗位 | 只想粘一条命令、不想开浏览器 |
| 手动粘贴 | 始终可用（兜底） | 无法自动化的平台 |

### 2. 专用浏览器抓取（主力路径）

```
career_campus_portal  {company:"腾讯"}
  → 现场探测，返回 https://join.qq.com（HTTP 200 + 标题「首页 | 腾讯校招」）
career_browser_login   {url:"https://join.qq.com"}
  → 弹出独立 Edge 窗口，登录态存 data/browser-profile，一次登录长期有效
career_browser_capture {url:"…", company:"腾讯", scope:"招聘类型=实习生", recruitType:"daily"}
  → CDP 附着标签页 → 重载触发 XHR → 截响应 → 解析 → 入库 + JD 快照 + 抓取留痕
```

**实测拿到的真实接口**：

| 公司 | 列表接口 | 响应结构 |
| --- | --- | --- |
| 字节跳动 | `GET /api/v1/search/job/posts?portal_type=3` | `data.job_post_list[]`，`count: 6559` |
| 腾讯 | `GET /api/v1/position/searchPosition` | `data.positionList[]`，`count: 999` |

### 3. 7 天过期 + diff

- `captureFreshness` 返回 `ageDays / stale / dueAt`，阈值 7 天
- diff 基准是**上一次同范围抓取的岗位编号集合**（`seen_codes`），不是整个公司岗位库
- 范围不同或没有基线时，**明确说「无法可靠判定下架」**，不编造下架数

实测：字节第二次抓 `added 0 / removed 0 / unchanged 10`；腾讯实习生第二次抓 `added 0 / removed 0 / unchanged 5`。

### 4. JD 落库（含详情接口补全）

`jd_snapshot` 表每次抓取存一份（标题/地点/截止/描述/要求 + 内容哈希），
可发现「同一岗位要求从本科改成硕士」。当前 **52+ 条快照**。

**列表接口不给正文的站点会自动补**：腾讯 `searchPosition` 只返回标题/地点，
正文要另调 `GET /api/v1/jobDetails/getJobDetailsByPostId?postId=…`。
`career_browser_capture` 默认 `fillJd=true`，抓完列表立刻按 postId 逐条补正文；
也可用 `career_job_jd_fetch` 批量补历史岗位。
实测腾讯实习生 8 条全部补上（292/259/257/250/238/209/167/167 字）。

### 5. 简历定向出稿

`career_resume_build` 按岗位挑经历、排序、精简要点，且：
- 章节顺序随岗位变（产品岗把实操放前面）
- 从个人资料库按相关性挑证书，生成「证书与语言」小节
- **缺口如实列出**（同义组只合并真正等价的：英语←TOEFL/IELTS/CET，大模型←LLM/VLM/LoRA）
- LaTeX 编译：xelatex 实测 **1 页 PDF，2.7 秒**

### 6. 投递管理

`career_application_create` 冻结当时 JD + 材料快照；`career_funnel` 按「达到过的最高阶段」算转化率与卡点；
`career_apply_card` 生成可复制的网申信息卡。实测信息卡 **16/26 字段自动填上**，缺的如实标空。

## 三、功能清单

### 画像与简历（21 个工具）

| 能力 | 工具 | 状态 |
| --- | --- | --- |
| 画像读写 | `career_profile_get` / `career_profile_update` | ✅ |
| 单份简历导入 | `career_resume_upload` / `career_resume_import` | ✅ PDF/DOCX/MD/TXT |
| **批量导入一堆简历** | `career_resume_ingest` | ✅ 目录/多路径/粘文本，按内容指纹去重 |
| 素材库合并去重 | `career_vault_snapshot` / `career_vault_plan_merge` / `career_vault_apply` | ✅ 要点级去重 + 冲突报出 |
| 经历 CRUD | `career_experience_add/list/update` | ✅ |
| 版本管理 | `career_resume_list/activate/delete/compare` | ✅ |
| 定向出稿 | `career_resume_build` / `career_resume_tailor` | ✅ |
| LaTeX | `career_resume_tex` / `career_resume_compile` | ✅ 本机 xelatex |
| 匹配分析 | `career_resume_match` / `career_match_job` / `career_match_rank` | ✅ |

### 个人资料库（4 个工具）

| 能力 | 工具 | 状态 |
| --- | --- | --- |
| 批量存入证件/成绩/专利 | `career_doc_ingest` | ✅ 自动分类 + 抽分（托福/雅思/四六级/GPA） |
| 列表 / 修改 / 按岗位提取 | `career_doc_list` / `career_doc_update` / `career_doc_for_job` | ✅ |

> 注意：**默认资料库为空**（`personal_document = 0`），你的 TOEFL 105 目前只在经历正文里，
> 还没作为「凭据」入库。传一次成绩单就能自动出现在「证书与语言」。

### 岗位发现与采集（13 个工具）

| 能力 | 工具 | 状态 |
| --- | --- | --- |
| 校招地址（现场探测） | `career_campus_portal` | ✅ 内置 15 家 |
| 专用浏览器登录 | `career_browser_login` / `career_browser_close` | ✅ |
| CDP 自动抓取 | `career_browser_capture` | ✅ 支持 `useOpenTab` |
| cURL 重放 | `career_jobs_from_curl` | ✅ 含 SSRF 防护 |
| HTML 抓取 | `career_jobs_crawl` | ✅ ATS/JSON-LD/内嵌 JSON/链接聚类 |
| 增量检查 | `career_jobs_sync` | ✅ |
| 抓取状态 / 7 天过期 | `career_capture_status` | ✅ |
| 取数指引 | `career_source_guide` | ✅ |
| 岗位 CRUD / 核验 | `career_job_save/get/search/delete/verify` | ✅ |
| 状态核验 | 官方来源才能改 OPEN/CLOSED | ✅ |

### 公司与行业情报（9 个工具）

`career_company_upsert/get` · `career_industry_upsert/list` · `career_unit_upsert`（部门核心度）·
`career_outlook_add`（前景信号，必须带来源+日期+证据等级）· `career_bar_analyze`（门槛分层 A/B/C/D/U）·
`career_research_save` · `career_evidence_add` · `career_forum_import`

### 投递管理（10 个工具）

`career_application_create/update/delete` · `career_applications_list/export` · `career_application_board` ·
`career_funnel` · `career_apply_card` · `career_digest` · `career_feedback`

### 计划与面试（6 个工具）

`career_plan`（时间线+动作清单）· `career_plan_brief`（9 节综合简报）· `career_event_add`（公司级节点）·
`career_interview_prep` · `career_social_queries` · `career_monitor_create/run` · `career_notifications`

### 系统（5 个工具）

`career_status` · `career_selfcheck`（环境自检）· `career_runtime_setup`（装 PDF 依赖）·
`career_panel`（面板跳转）· `career_export`

## 四、库内真实数据（2026-11-17）

| 表 | 条数 | 说明 |
| --- | --- | --- |
| `job` | 21 | 字节 10（7 未标批次 + 3 daily）、腾讯 11（6 autumn_campus + 5 daily） |
| `job_source` | 27 | 每条岗位的来源证据（类型/链接/时间/摘录/可信度） |
| `company` | 4 | 字节跳动、腾讯等 |
| `jd_snapshot` | 52 | 每次抓取的 JD 全文快照 |
| `company_capture` | 8 | 抓取留痕（含 seen_codes 基线） |
| `resume_version` | 2 | 你的原始简历 + 产品市场方向改写稿 |
| `resume_experience` | 6 | 东南大学 / 华侨大学 / MSRA-ELVIS / 厦门实验室 / 闲鱼 / 专利语言 |
| `personal_document` | 0 | **空，待你上传成绩单等凭据** |
| `application` | 0 | 还没投递 |

## 五、已知限制（不是 bug，是边界）

| 限制 | 说明 |
| --- | --- |
| DSH 内置浏览器不可用 | 沙箱 webview，`DesktopBrowserBridge` 只开 `acquire/release/onOpenRequested`，插件读不到页面。必须用专用浏览器 |
| 腾讯详情页 URL 未渲染验证 | `post.html?id=21417` 返回 200 且是岗位投递页，但没验证渲染出的是否就是该岗位 |
| 列表只抓到首页 10~20 条 | 字节 `count: 6559`，一次只取 `limit=10`。要更多需加滚动翻页或多响应合并 |
| 招聘时间线未做 | JD 里有零散日期，但没抽成结构化节点（网申开始/截止/笔试/面试） |
| 图片型证件不做 OCR | 扫描件只登记文件，字段需手工补 |
| 通用 PDF 解析器读学术型 CV 会错 | 你的简历 `major` 被读成「客户关系」；所以结构化为人工合并，原文永存 |
| Workday 接口未用真实 tenant 验证 | 代码路径在，但没跑通实例 |

## 六、下一步候选

1. **给 8 条日常实习跑匹配排序** → `career_match_rank`，看哪几条值得投
2. **补资料库**（上传 TOEFL / 成绩单）→ 网申信息卡从 16/26 涨到 23/26
3. **加滚动翻页** → 把字节 6559 条缩到你的筛选范围后全量拿
4. **做招聘时间线** → 从 JD + 页面的招聘流程页抽结构化节点
5. **腾讯详情页 URL 确认** → 你点一个链接，我按实际路由改模板
