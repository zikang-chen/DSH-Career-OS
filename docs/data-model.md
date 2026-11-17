# 数据模型

数据库：`data/career.db`，SQLite（`node:sqlite`），WAL，迁移版本 **4**。

## 迁移策略

`host/schema.js` 导出 `MIGRATIONS` 数组，每项 `{version, name, sql}`。`CareerDb.migrate()`：

1. 建 `schema_migrations(version, name, applied_at)`；
2. 只执行未应用的版本，每个版本在自己的事务里执行 SQL **并**记录版本号（同一事务，失败即整体回滚）；
3. `version 2`（FTS 索引）先尝试 `tokenize='trigram'`（CJK 子串检索必需），失败则回落到 `unicode61` 并记 `ftsMode`，此时中文检索走 `LIKE` 兜底。

已应用的迁移**永不修改**，只追加新版本。数据库版本高于插件时会告警但不阻塞。

## 实体一览

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `user_profile` | 求职画像（单行 `id='default'`） | JSON 列存数组/对象；未填字段为 `NULL` 而非猜测值 |
| `resume_version` | 简历版本 + 原文 + 解析提案 | `is_active` 唯一激活由应用层保证 |
| `skill` | 技能表 | `name_key` UNIQUE |
| `industry` / `company` | 行业与公司档案 | `name_key` UNIQUE（归一化后的公司身份键） |
| `job` | 岗位主记录 | `dedupe_key` UNIQUE；`status` 只是最近观测镜像 |
| `job_source` | 岗位来源证据 | `(job_id, source_url)` UNIQUE；同一岗位多来源并存 |
| `job_status_history` | 状态观测日志（只追加） | 每次变更一行，含 `previous_status` |
| `forum_post` | 论坛/面经原文 | `(platform, content_hash)` UNIQUE —— 转载不重复计数 |
| `forum_claim` | 从帖子抽取的结构化观点 | `evidence_level` A/B/C/D/U |
| `interview_experience` | 面试经历 | 关联 `post_id` 保留出处 |
| `hiring_requirement` | 招聘要求分层 | `kind ∈ hard/preferred/observed/unverified` |
| `application` / `application_event` | 投递与时间线 | 事件只追加，不覆盖历史 |
| `monitoring_rule` | 监控规则 | `spec` JSON；`last_status/last_error` 可诊断 |
| `notification` | 提醒 | `dedupe_key` UNIQUE —— 同一变化不重复推送 |
| `sync_run` | 采集运行日志 | 崩溃遗留 `running` 在启动时被收尾为 `error` |
| `research_report` | 研究简报 | 同 id 再保存 `version+1` |
| `evidence` | 通用证据台账 | 来源类型/时间/核验状态/摘录 |
| `source_health` | 数据源健康 | 每个 connector 一行，含成功/失败/抓取/去重计数 |
| `match_result` | 匹配结果缓存 | `(job_id, profile_hash)` UNIQUE —— 画像变了才重算 |
| `feedback` | 用户反馈闭环 | 驱动权重/去重/数据源质量建议 |
| `job_fts` | FTS5 虚表 | 触发器与 `job` 同步（insert/update/delete） |

## 证据规范

一条岗位证据写入 `job_source`：

```json
{
  "source_type": "official_careers",
  "source_url": "https://jobs.example.com/position/1001",
  "published_at": null,
  "retrieved_at": "2026-11-16T11:36:39.699Z",
  "verification_status": "verified",
  "claim_type": "job_opening",
  "evidence_excerpt": "该职位已下线",
  "confidence_level": "A"
}
```

只存**短摘录**（≤500 字符），不存整页正文。

## 状态机

```
UNKNOWN ──(第三方线索)──▶ UNVERIFIED
UNKNOWN ──(官方 OPEN)──▶ OPEN
OPEN ──(官方 CLOSED)──▶ CLOSED
OPEN ──(21 天未核验)──▶ STALE
* ──(官方 UPCOMING)──▶ UPCOMING
```

规则：
- `status_verified_at` 只由**官方证据**刷新；
- 第三方证据既不能改 `OPEN`，也不能刷新核验时间；
- 每次真实变更写 `job_status_history`，`job.status` 只是镜像。

## 去重（实体归一化）

按优先级：

1. `job_code`（官方编号）+ 同一公司；
2. `source_url` 已存在于 `job_source`；
3. `dedupe_key = companyKey | titleKey | locationKey`；
4. 同公司 + 标题相似度 ≥ 0.82（字符 bigram 的 Dice 系数）+ 地点兼容。

`companyKey` 会去掉法务后缀（`有限公司`/`Inc`）与地域/企业噪声词（`北京`/`科技`/`集团`…），但**不**去掉品牌词——`腾讯音乐 ≠ 腾讯`。归一化后命中的别名会写入 `company.aliases`，保持可追溯。

`titleKey` 会去掉年份、`暑期实习`/`日常实习`/`实习生`、`急聘`/`内推` 等招聘噪声。
