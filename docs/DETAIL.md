# CareerOS

个人求职情报与实习管理系统。所有数据保存在本机 SQLite；不自动投递简历、不对外发信。

## 能做什么

| 能力 | 入口 |
| --- | --- |
| 简历导入（.md/.txt/.docx/.pdf）+ 解析候选 + 版本管理 | 面板「简历与画像」/ `career_resume_import` |
| 求职画像与偏好（学历/时间/城市/目标/排除条件/技能） | 面板「简历与画像」/ `career_profile_get` `career_profile_update` |
| 岗位入库、公司归一化、跨来源去重、状态核验历史 | 面板「岗位雷达」/ `career_job_save` `career_job_verify` |
| 可解释匹配分组（含硬条件过滤） | `career_match_rank` `career_match_job` |
| 投递 CRM（看板/表格/时间线/跟进提醒） | 面板「投递管理」/ `career_application_*` |
| 公司与行业档案、研究简报、证据台账 | 面板「公司情报」「行业研究」/ `career_company_*` `career_industry_*` `career_research_save` |
| 论坛/面经导入、招聘 Bar 分层分析 | 面板「论坛与 Bar」/ `career_forum_import` `career_bar_analyze` |
| 面试准备包 | 面板「面试准备」/ `career_interview_prep` |
| 官方招聘页变化监控、临近截止提醒、日报 | 面板「设置」/ `career_monitor_*` `career_notifications` `career_digest` |

打开面板：左侧边栏底部的「🎯 求职面板」按钮。

## 数据与隐私

- 数据库：`data/career.db`（SQLite，WAL，FTS5 trigram 全文检索）
- 日志：`data/logs/career.log`（不记录简历全文与密钥）
- 备份/导出：`data/backups/`、`data/exports/`
- 删除：面板「设置 → 删除全部数据」需二次确认 token

## 明确不做的事

- 不抓取需要登录、验证码或反爬限制的第三方招聘平台与论坛（实习僧/BOSS/牛客/小红书/脉脉/知乎等）。这些来源在「数据源健康」里标为不可用，并提供关键词与搜索链接 + 手动粘贴导入。
- 不在未经确认的情况下投递简历、回复招聘方或修改外部账户。
- 不编造经历、学历、量化指标；解析结果一律标为「候选」，需你确认后才写入画像。
