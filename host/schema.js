// Versioned schema migrations. Each entry runs exactly once, inside a transaction,
// and is recorded in `schema_migrations`. Never edit an applied migration — append a
// new one instead, so existing databases keep their history and user data.

export const SCHEMA_VERSION = 13

/**
 * @type {Array<{version:number,name:string,sql:string}>}
 *
 * Design notes
 * - Every row carries a stable `id` (UUID) so records survive re-import and re-sync.
 * - Mutable facts (job status) are never overwritten: `job_status_history` keeps the
 *   observation log and `job.status` only mirrors the latest verified value.
 * - `evidence` / `job_source` hold provenance for anything that can be wrong.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'core',
    sql: `
-- ─── user profile & preferences ───────────────────────────────────────────────
CREATE TABLE user_profile (
  id               TEXT PRIMARY KEY,
  display_name     TEXT,
  headline         TEXT,
  school           TEXT,
  degree           TEXT,
  major            TEXT,
  grad_year        INTEGER,
  availability_start TEXT,
  availability_end   TEXT,
  weekly_days      INTEGER,
  internship_types TEXT,      -- JSON string[]
  cities           TEXT,      -- JSON string[]
  remote_pref      TEXT,      -- onsite | remote | hybrid | any
  target_industries TEXT,     -- JSON string[]
  target_roles     TEXT,      -- JSON string[]
  target_companies TEXT,      -- JSON string[]
  excluded         TEXT,      -- JSON string[] (hard exclusions, e.g. 销售/单休)
  salary_min       INTEGER,
  skills           TEXT,      -- JSON [{name,level,years,verified}]
  preferences      TEXT,      -- JSON scoring weights & knobs
  onboarded        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE resume_version (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  target_role    TEXT,
  language       TEXT,             -- zh | en
  file_name      TEXT,
  file_path      TEXT,
  mime           TEXT,
  raw_text       TEXT,
  parsed         TEXT,             -- JSON structured proposal (never auto-committed)
  parse_status   TEXT,             -- ok | needs_review | unsupported
  parse_notes    TEXT,
  is_active      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE skill (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,
  category      TEXT,
  level         TEXT,             -- beginner | intermediate | advanced | expert
  years         REAL,
  verified      INTEGER NOT NULL DEFAULT 0,   -- verified by the user, not inferred
  evidence      TEXT,
  source_resume_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (name_key)
);

-- ─── industry / company ──────────────────────────────────────────────────────
CREATE TABLE industry (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,
  parent_id   TEXT,
  summary     TEXT,
  data        TEXT,               -- JSON structured research
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE company (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL UNIQUE,
  aliases      TEXT,              -- JSON string[]
  industry_id  TEXT,
  website      TEXT,
  careers_url  TEXT,
  intern_url   TEXT,
  cities       TEXT,              -- JSON string[]
  size         TEXT,
  tags         TEXT,              -- JSON string[]
  notes        TEXT,
  data         TEXT,              -- JSON structured research
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_company_industry ON company(industry_id);

-- ─── jobs ────────────────────────────────────────────────────────────────────
CREATE TABLE job (
  id                TEXT PRIMARY KEY,
  dedupe_key        TEXT NOT NULL UNIQUE,
  company_id        TEXT,
  company_name      TEXT NOT NULL,
  title             TEXT NOT NULL,
  title_key         TEXT NOT NULL,
  job_code          TEXT,
  department        TEXT,
  business_unit     TEXT,
  location          TEXT,
  remote_type       TEXT,           -- onsite | remote | hybrid
  internship_type   TEXT,           -- daily | summer | winter | long | short | other
  description       TEXT,
  requirements      TEXT,
  skills            TEXT,           -- JSON string[]
  grade_limit       TEXT,
  major_limit       TEXT,
  language_req      TEXT,
  duration          TEXT,
  start_date        TEXT,
  days_per_week     INTEGER,
  salary_text       TEXT,
  conversion_possible INTEGER,      -- null = unknown, never guessed
  published_at      TEXT,
  deadline          TEXT,
  status            TEXT NOT NULL DEFAULT 'UNKNOWN',
  status_verified_at TEXT,          -- last time the STATUS was actually checked
  status_source     TEXT,
  confidence        TEXT,           -- high | medium | low
  match_score       REAL,
  tags              TEXT,           -- JSON string[]
  notes             TEXT,
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_job_company ON job(company_id);
CREATE INDEX idx_job_status ON job(status);
CREATE INDEX idx_job_deadline ON job(deadline);
CREATE INDEX idx_job_titlekey ON job(title_key);

CREATE TABLE job_source (
  id                  TEXT PRIMARY KEY,
  job_id              TEXT NOT NULL,
  source_type         TEXT NOT NULL,   -- official_careers | job_board | forum | manual | search
  source_name         TEXT,
  source_url          TEXT NOT NULL,
  published_at        TEXT,
  retrieved_at        TEXT NOT NULL,
  verification_status TEXT,            -- verified | unverified | stale | conflicting
  claim_type          TEXT,            -- job_opening | job_closed | job_detail
  evidence_excerpt    TEXT,
  confidence_level    TEXT,            -- A | B | C | D | U
  raw_hash            TEXT,
  created_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_job_source_url ON job_source(job_id, source_url);
CREATE INDEX idx_job_source_job ON job_source(job_id);

CREATE TABLE job_status_history (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL,
  status          TEXT NOT NULL,
  previous_status TEXT,
  source_type     TEXT,
  source_url      TEXT,
  evidence        TEXT,
  verified_at     TEXT NOT NULL,
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_jsh_job ON job_status_history(job_id, verified_at DESC);

-- ─── social / forum intelligence ─────────────────────────────────────────────
CREATE TABLE forum_post (
  id             TEXT PRIMARY KEY,
  platform       TEXT NOT NULL,     -- xiaohongshu | nowcoder | zhihu | maimai | v2ex | 1point3acres | github | other
  url            TEXT,
  title          TEXT,
  author_handle  TEXT,              -- public handle only, never a person profile
  published_at   TEXT,
  retrieved_at   TEXT NOT NULL,
  content_excerpt TEXT,             -- short excerpt within fair-use limits
  content_hash   TEXT,
  access_mode    TEXT NOT NULL,     -- manual_import | user_export | public_page | search_snippet
  company_id     TEXT,
  job_id         TEXT,
  license_note   TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_forum_post_hash ON forum_post(platform, content_hash);

CREATE TABLE forum_claim (
  id              TEXT PRIMARY KEY,
  post_id         TEXT,
  category        TEXT NOT NULL,   -- bar | interview | experience | salary | process
  claim           TEXT NOT NULL,
  stance          TEXT,            -- positive | negative | neutral
  evidence_level  TEXT NOT NULL,   -- A | B | C | D | U
  sample_size     INTEGER,
  observed_year   INTEGER,
  department      TEXT,
  company_id      TEXT,
  job_id          TEXT,
  corroboration   TEXT,            -- JSON: [{url, note}] independent corroboration only
  first_hand      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_forum_claim_company ON forum_claim(company_id, category);

CREATE TABLE interview_experience (
  id             TEXT PRIMARY KEY,
  company_id     TEXT,
  job_id         TEXT,
  role_title     TEXT,
  year           INTEGER,
  stage          TEXT,             -- resume | written | tech1 | tech2 | hr | offer
  source_post_id TEXT,
  source_url     TEXT,
  topics         TEXT,             -- JSON string[]
  questions      TEXT,             -- JSON string[]
  timeline       TEXT,
  outcome        TEXT,
  evidence_level TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE hiring_requirement (
  id             TEXT PRIMARY KEY,
  company_id     TEXT,
  job_id         TEXT,
  kind           TEXT NOT NULL,    -- hard | preferred | observed | unverified
  text           TEXT NOT NULL,
  source_type    TEXT,
  source_url     TEXT,
  evidence_level TEXT,
  observed_count INTEGER,
  note           TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_hiring_req_job ON hiring_requirement(job_id, kind);

-- ─── applications CRM ────────────────────────────────────────────────────────
CREATE TABLE application (
  id                TEXT PRIMARY KEY,
  job_id            TEXT,
  company_name      TEXT NOT NULL,
  job_title         TEXT NOT NULL,
  url               TEXT,
  status            TEXT NOT NULL,
  channel           TEXT,
  resume_version_id TEXT,
  applied_at        TEXT,
  next_action       TEXT,
  next_action_at    TEXT,
  notes             TEXT,
  result            TEXT,
  retro             TEXT,
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_app_status ON application(status);
CREATE INDEX idx_app_next ON application(next_action_at);

CREATE TABLE application_event (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  type           TEXT NOT NULL,    -- status | note | interview | mail | retro
  from_status    TEXT,
  to_status      TEXT,
  at             TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_app_event ON application_event(application_id, at);

-- ─── monitoring & notifications ──────────────────────────────────────────────
CREATE TABLE monitoring_rule (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,      -- careers_page | job_deadline | social_watch | keyword_search
  spec         TEXT NOT NULL,      -- JSON
  cadence      TEXT NOT NULL DEFAULT 'daily',
  enabled      INTEGER NOT NULL DEFAULT 1,
  priority     TEXT NOT NULL DEFAULT 'normal',
  channel      TEXT NOT NULL DEFAULT 'panel',
  last_run_at  TEXT,
  last_status  TEXT,
  last_error   TEXT,
  stats        TEXT,               -- JSON counters
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE notification (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  severity     TEXT NOT NULL DEFAULT 'info',
  dedupe_key   TEXT NOT NULL UNIQUE,
  job_id       TEXT,
  company_id   TEXT,
  action       TEXT,
  created_at   TEXT NOT NULL,
  read_at      TEXT,
  dismissed_at TEXT
);

CREATE TABLE sync_run (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  target      TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running', -- running | ok | error | skipped
  fetched     INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  duplicates  INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  meta        TEXT
);
CREATE INDEX idx_sync_started ON sync_run(started_at DESC);

-- ─── research & evidence ─────────────────────────────────────────────────────
CREATE TABLE research_report (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,       -- industry | company | bar | interview | summary
  title       TEXT NOT NULL,
  industry_id TEXT,
  company_id  TEXT,
  body        TEXT NOT NULL,
  sources     TEXT,                -- JSON string[]
  data_as_of  TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_report_subject ON research_report(kind, company_id, industry_id);

CREATE TABLE evidence (
  id                  TEXT PRIMARY KEY,
  subject_type        TEXT NOT NULL,
  subject_id          TEXT,
  source_type         TEXT NOT NULL,
  source_url          TEXT,
  published_at        TEXT,
  retrieved_at        TEXT NOT NULL,
  verification_status TEXT,
  claim_type          TEXT,
  evidence_excerpt    TEXT,
  confidence_level    TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_evidence_subject ON evidence(subject_type, subject_id);

CREATE TABLE feedback (
  id           TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,      -- job | source | match | company
  subject_id   TEXT NOT NULL,
  verdict      TEXT NOT NULL,      -- interested | not_interested | wrong | stale | applied | disqualified | research
  note         TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'full-text-search',
    // FTS5 index over jobs. `tokenize='trigram'` is required for CJK substring
    // search; when the SQLite build lacks trigram this migration is applied by the
    // caller through `migration2Alternative` (unicode61) instead.
    sql: `
CREATE VIRTUAL TABLE job_fts USING fts5(
  job_id UNINDEXED,
  title,
  company_name,
  location,
  body,
  tokenize='trigram'
);

CREATE TRIGGER job_ai AFTER INSERT ON job BEGIN
  INSERT INTO job_fts(job_id, title, company_name, location, body)
  VALUES (new.id, new.title, new.company_name, coalesce(new.location,''),
          coalesce(new.title,'') || ' ' || coalesce(new.description,'') || ' ' || coalesce(new.requirements,''));
END;

CREATE TRIGGER job_au AFTER UPDATE ON job BEGIN
  DELETE FROM job_fts WHERE job_id = old.id;
  INSERT INTO job_fts(job_id, title, company_name, location, body)
  VALUES (new.id, new.title, new.company_name, coalesce(new.location,''),
          coalesce(new.title,'') || ' ' || coalesce(new.description,'') || ' ' || coalesce(new.requirements,''));
END;

CREATE TRIGGER job_ad AFTER DELETE ON job BEGIN
  DELETE FROM job_fts WHERE job_id = old.id;
END;
`,
  },
  {
    version: 3,
    name: 'match-and-views',
    sql: `
CREATE TABLE match_result (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  score        REAL NOT NULL,
  band         TEXT NOT NULL,
  breakdown    TEXT NOT NULL,   -- JSON dimension scores
  reasons      TEXT,            -- JSON {matched,missing,unknown,highlight}
  created_at   TEXT NOT NULL,
  UNIQUE (job_id, profile_hash)
);
CREATE INDEX idx_match_score ON match_result(score DESC);

CREATE TABLE source_health (
  id             TEXT PRIMARY KEY,
  connector      TEXT NOT NULL UNIQUE,
  display_name   TEXT,
  access_mode    TEXT,
  capabilities   TEXT,          -- JSON string[]
  enabled        INTEGER NOT NULL DEFAULT 1,
  needs_user     INTEGER NOT NULL DEFAULT 0,
  last_ok_at     TEXT,
  last_error_at  TEXT,
  last_error     TEXT,
  rate_limit_note TEXT,
  fetch_count    INTEGER NOT NULL DEFAULT 0,
  insert_count   INTEGER NOT NULL DEFAULT 0,
  dedupe_count   INTEGER NOT NULL DEFAULT 0,
  official_count INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);
`,
  },
  {
    version: 4,
    name: 'onboarding-seeds',
    sql: `
CREATE TABLE job_note (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  body       TEXT NOT NULL,
  author     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_job_note ON job_note(job_id, created_at DESC);

CREATE TABLE company_watch (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL UNIQUE,
  interest   TEXT NOT NULL DEFAULT 'watch',  -- watch | target | exclude
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 5,
    name: 'campus-recruiting',
    // 秋招/春招 needs a recruitment channel that is orthogonal to internship_type
    // (a 2027 秋招 posting is a campus hire, not necessarily an internship), and the
    // application list needs its own copy of the apply URL / location / deadline so a
    // record survives even if the source job row is archived.
    sql: `
ALTER TABLE job ADD COLUMN recruit_type TEXT;      -- autumn_campus | spring_campus | summer | daily | other
ALTER TABLE job ADD COLUMN apply_url TEXT;         -- 投递地址（去重后用于直接打开申请页）
ALTER TABLE application ADD COLUMN apply_url TEXT;
ALTER TABLE application ADD COLUMN location TEXT;
ALTER TABLE application ADD COLUMN deadline TEXT;
ALTER TABLE application ADD COLUMN recruit_type TEXT;
CREATE INDEX idx_job_recruit ON job(recruit_type);
CREATE INDEX idx_app_company ON application(company_name);
`,
  },
  {
    version: 6,
    name: 'campaign-planning',
    sql: `
-- 校招时间线事件：既有通用节奏，也有公司级/自定义节点（提前批、网申截止、笔试面试）。
-- source 区分「官方公布」「用户填写」「经验估计」，避免把估计当事实。
CREATE TABLE recruit_event (
  id             TEXT PRIMARY KEY,
  season         TEXT NOT NULL,   -- autumn_campus | spring_campus | summer | daily
  stage          TEXT NOT NULL,   -- apply_open | apply_close | written_test | interview | offer | onboard
  title          TEXT NOT NULL,
  company_id     TEXT,
  company_name   TEXT,
  starts_at      TEXT NOT NULL,
  ends_at        TEXT,
  source         TEXT NOT NULL DEFAULT 'estimate',  -- official | user | estimate
  source_url     TEXT,
  evidence_level TEXT,             -- A | B | C | D | U
  note           TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_recruit_event_time ON recruit_event(starts_at);
CREATE INDEX idx_recruit_event_company ON recruit_event(company_id);

-- 业务部门档案：一个岗位在哪个部门、这个部门是核心还是边缘、有什么增长信号。
CREATE TABLE company_unit (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  business       TEXT,             -- 业务方向
  strategic_role TEXT,             -- core | growth | support | declining
  headcount_note TEXT,
  growth_signals TEXT,             -- JSON [{claim, source, asOf, level}]
  risks          TEXT,             -- JSON [{claim, source, asOf, level}]
  data_as_of     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (company_id, name)
);

-- 市场/行业/公司前景信号：一条断言一条证据，带方向、时限与证据等级。
CREATE TABLE market_signal (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,    -- industry | company | unit
  industry_id    TEXT,
  company_id     TEXT,
  unit_id        TEXT,
  topic          TEXT,             -- 需求 | 政策 | 技术 | 竞争 | 资本 | 人才
  claim          TEXT NOT NULL,
  direction      TEXT,             -- positive | neutral | negative
  horizon        TEXT,             -- 0-6m | 6-18m | 18m+
  evidence_level TEXT NOT NULL,    -- A | B | C | D | U
  source         TEXT,
  source_url     TEXT,
  as_of          TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_market_signal_scope ON market_signal(scope, industry_id, company_id);
`,
  },
  {
    version: 7,
    name: 'resume-vault-and-latex',
    sql: `
-- 简历版本谱系：谁是从哪一版改出来的、针对哪个岗位、LaTeX 源码在哪。
-- 这样「在上一版基础上针对某岗位微调」是可追溯的，而不是覆盖式修改。
ALTER TABLE resume_version ADD COLUMN source_type TEXT;      -- upload | paste | tailored | latex
ALTER TABLE resume_version ADD COLUMN parent_version_id TEXT;
ALTER TABLE resume_version ADD COLUMN target_job_id TEXT;
ALTER TABLE resume_version ADD COLUMN tex_source TEXT;

-- 经历素材库：所有详细经历的唯一事实来源。简历版本只是从这里「挑选+排序」。
CREATE TABLE resume_experience (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,   -- education|internship|project|research|activity|award|certificate|skill
  organization     TEXT,
  role             TEXT,
  start_at         TEXT,
  end_at           TEXT,
  location         TEXT,
  bullets          TEXT,            -- JSON string[]
  tags             TEXT,            -- JSON string[]
  skills           TEXT,            -- JSON string[]
  links            TEXT,            -- JSON string[]
  evidence         TEXT,            -- 可核验说明（没有就不填，不编）
  verified         INTEGER NOT NULL DEFAULT 0,
  source_resume_id TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_exp_kind ON resume_experience(kind, sort_order);
CREATE INDEX idx_exp_org ON resume_experience(organization);
`,
  },
  {
    version: 8,
    name: 'personal-document-vault',
    // 个人资料总库：学历证明、成绩单、四六级/托福、专利、获奖、实习证明……
    // 与「经历素材库」分开：经历是叙事，证件是凭据，两者按岗位组合成简历。
    sql: `
CREATE TABLE personal_document (
  id            TEXT PRIMARY KEY,
  category      TEXT NOT NULL,   -- degree|transcript|certificate|language|award|patent|publication|portfolio|identity|other
  title         TEXT NOT NULL,
  issuer        TEXT,            -- 颁发机构
  issued_at     TEXT,            -- 取得时间 YYYY-MM
  expires_at    TEXT,
  credential_id TEXT,            -- 证书编号/专利号/成绩单编号
  score         TEXT,            -- 分数原文，如「TOEFL 105（读30 听28 说22 写25）」
  score_value   REAL,            -- 便于排序/筛选
  score_unit    TEXT,            -- 分 / 级 / GPA
  file_path     TEXT,
  file_name     TEXT,
  mime          TEXT,
  raw_text      TEXT,            -- 提取出的文本（脱敏后用于检索/核对）
  tags          TEXT,            -- JSON string[]
  verified      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_document_category ON personal_document(category);
CREATE INDEX idx_document_issued ON personal_document(issued_at);
`,
  },
  {
    version: 9,
    name: 'apply-card-and-submission-proof',
    // 两件事：
    //  1) 网申信息卡需要联系方式等字段（之前 profile 只存了学历/意向，没有电话邮箱）；
    //  2) 投递必须留证据：冻结当时的 JD，并记录提交了哪版简历、哪些资料。
    //     岗位下架或 sync 刷新之后，投递记录仍然能回答「我当时投的是什么」。
    sql: `
ALTER TABLE user_profile ADD COLUMN phone TEXT;
ALTER TABLE user_profile ADD COLUMN email TEXT;
ALTER TABLE user_profile ADD COLUMN birth_date TEXT;
ALTER TABLE user_profile ADD COLUMN gender TEXT;
ALTER TABLE user_profile ADD COLUMN political_status TEXT;
ALTER TABLE user_profile ADD COLUMN hometown TEXT;
ALTER TABLE user_profile ADD COLUMN current_city TEXT;
ALTER TABLE user_profile ADD COLUMN gpa TEXT;
ALTER TABLE user_profile ADD COLUMN rank_text TEXT;

ALTER TABLE application ADD COLUMN submitted_jd TEXT;
ALTER TABLE application ADD COLUMN submission_snapshot TEXT;
ALTER TABLE application ADD COLUMN jd_url TEXT;
`,
  },
  {
    version: 10,
    name: 'capture-state-and-jd-history',
    // 岗位列表一直在变，所以每次抓取都要留痕：
    //   company_capture 记住「哪家公司、什么时候、用什么筛选范围、抓到多少」，
    //   用于 7 天过期判断和两次抓取之间的 diff；
    //   jd_snapshot 记住每个岗位当时的标题/地点/截止/JD 正文，
    //   用于发现「同一个岗位要求变严了」——这对改简历是重要信号。
    sql: `
CREATE TABLE company_capture (
  id           TEXT PRIMARY KEY,
  company_key  TEXT NOT NULL,
  company_name TEXT,
  source_url   TEXT,
  scope        TEXT,
  scope_key    TEXT,
  captured_at  TEXT NOT NULL,
  found        INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL DEFAULT 0,
  merged       INTEGER NOT NULL DEFAULT 0,
  stats        TEXT,
  note         TEXT
);
CREATE INDEX idx_capture_company ON company_capture(company_key, captured_at DESC);

CREATE TABLE jd_snapshot (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL,
  company_key  TEXT,
  captured_at  TEXT NOT NULL,
  title        TEXT,
  location     TEXT,
  deadline     TEXT,
  description  TEXT,
  requirements TEXT,
  content_hash TEXT
);
CREATE INDEX idx_jd_job ON jd_snapshot(job_id, captured_at DESC);
CREATE INDEX idx_jd_company ON jd_snapshot(company_key, captured_at DESC);
`,
  },
  {
    version: 11,
    name: 'capture-seen-codes',
    // 「下架」只能跟「上一次同范围抓取看到的那批」比。
    // 之前拿整个公司岗位库当基准，换个筛选范围再抓就会把别的批次的岗位全报成下架。
    // 这里把每轮看到的岗位编号存下来，diff 才有正确基准。
    sql: `
ALTER TABLE company_capture ADD COLUMN seen_codes TEXT;
`,
  },
  {
    version: 12,
    name: 'job-post-id-and-jd-fetch',
    // 有些站点（腾讯）列表接口只给标题/地点，正文要另调详情接口，而详情接口用的是
    // 另一个 id（postId），不是列表里的岗位 id。把 postId 存下来，才能按需补 JD 正文。
    sql: `
ALTER TABLE job ADD COLUMN post_id TEXT;
CREATE INDEX idx_job_post_id ON job(post_id);
`,
  },
  {
    version: 13,
    name: 'capture-completeness',
    // 采集完整性：列表接口常报一个总数（字节 count=6559），但一次只取 10 条。
    // 不记录这个差距，就无法区分「只抓到一部分」和「岗位就是这么多」，
    // 也会把「没抓到」误当成「已关闭」。这里把总数、实际观测数、是否完整都记下来。
    sql: `
ALTER TABLE company_capture ADD COLUMN reported_total INTEGER;
ALTER TABLE company_capture ADD COLUMN observed_count INTEGER;
ALTER TABLE company_capture ADD COLUMN is_complete INTEGER;
ALTER TABLE company_capture ADD COLUMN parse_warnings TEXT;
`,
  },
]

export const UNICODE_FTS_MIGRATION = {
  version: 2,
  name: 'full-text-search',
  sql: `
CREATE VIRTUAL TABLE job_fts USING fts5(
  job_id UNINDEXED,
  title,
  company_name,
  location,
  body,
  tokenize='unicode61'
);

CREATE TRIGGER job_ai AFTER INSERT ON job BEGIN
  INSERT INTO job_fts(job_id, title, company_name, location, body)
  VALUES (new.id, new.title, new.company_name, coalesce(new.location,''),
          coalesce(new.title,'') || ' ' || coalesce(new.description,'') || ' ' || coalesce(new.requirements,''));
END;

CREATE TRIGGER job_au AFTER UPDATE ON job BEGIN
  DELETE FROM job_fts WHERE job_id = old.id;
  INSERT INTO job_fts(job_id, title, company_name, location, body)
  VALUES (new.id, new.title, new.company_name, coalesce(new.location,''),
          coalesce(new.title,'') || ' ' || coalesce(new.description,'') || ' ' || coalesce(new.requirements,''));
END;

CREATE TRIGGER job_ad AFTER DELETE ON job BEGIN
  DELETE FROM job_fts WHERE job_id = old.id;
END;
`,
}
