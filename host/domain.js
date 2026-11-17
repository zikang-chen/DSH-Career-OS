// Domain logic: job normalization, entity resolution (dedupe), JD parsing and the
// explainable match engine. Pure functions where possible so they are unit-testable
// without a database or network.
import {
  arr,
  companyKey,
  daysBetween,
  normKey,
  num,
  similarity,
  str,
  titleKey,
  today,
} from './util.js'

// ─── vocabularies ─────────────────────────────────────────────────────────────
export const JOB_STATUSES = ['OPEN', 'CLOSED', 'UPCOMING', 'UNVERIFIED', 'STALE', 'UNKNOWN']

export const STATUS_LABEL = {
  OPEN: '官方确认在招',
  CLOSED: '官方确认结束',
  UPCOMING: '官方确认未开启',
  UNVERIFIED: '有线索未证实',
  STALE: '信息已过期',
  UNKNOWN: '信息不足',
}

export const APPLICATION_STATUSES = [
  'saved', 'researching', 'resume_todo', 'ready', 'applied', 'assessment', 'written_test',
  'interview_1', 'interview_2', 'final', 'hr', 'offer', 'rejected', 'closed', 'withdrawn',
]

export const APPLICATION_LABEL = {
  saved: '收藏', researching: '待研究', resume_todo: '待改简历', ready: '待投递',
  applied: '已投递', assessment: '在线测评', written_test: '笔试', interview_1: '一面',
  interview_2: '二面', final: '终面', hr: 'HR 面', offer: 'Offer',
  rejected: '被拒绝', closed: '已关闭', withdrawn: '主动放弃',
}

export const INTERNSHIP_TYPES = ['daily', 'summer', 'winter', 'long', 'short', 'other']
export const INTERNSHIP_LABEL = {
  daily: '日常实习', summer: '暑期实习', winter: '寒假实习',
  long: '长期实习', short: '短期项目', other: '其他',
}

export const EVIDENCE_LEVELS = { A: '官方一手', B: '多源印证', C: '单一可溯源', D: '未证实/冲突', U: '信息不足' }

/** Skill lexicon used to extract requirements from free text (JD, 面经, 简历). */
export const SKILL_LEXICON = [
  // 技术
  'Python', 'Java', 'C++', 'C', 'Go', 'Rust', 'JavaScript', 'TypeScript', 'SQL', 'R', 'MATLAB', 'Scala', 'Shell',
  'React', 'Vue', 'Node.js', 'Spring', 'Django', 'Flask', 'FastAPI', 'Kafka', 'Redis', 'MySQL', 'PostgreSQL',
  'MongoDB', 'Hadoop', 'Spark', 'Flink', 'Hive', 'ClickHouse', 'Docker', 'Kubernetes', 'Linux', 'Git',
  'PyTorch', 'TensorFlow', 'Transformers', '机器学习', '深度学习', '自然语言处理', '计算机视觉', '推荐系统', '大模型',
  '微调', 'LLM', 'AIGC', '数据分析', '数据挖掘', '数据可视化', '爬虫', '算法', '数据结构', '概率统计',
  'Android', 'iOS', '前端开发', '后端开发', '测试开发', '运维', '网络安全', '嵌入式', 'ROS', '自动驾驶',
  // 产品与业务
  '产品设计', '需求分析', '用户研究', '原型设计', 'Axure', 'Figma', 'Sketch', '数据分析工具',
  '竞品分析', '增长', '商业化', '运营', '内容运营', '用户增长', '项目管理', 'PRD', 'A/B测试',
  // 金融与研究
  '财务建模', '估值', 'DCF', '行业研究', '公司研究', 'Wind', 'Bloomberg', '彭博', 'Choice', 'Excel',
  'PPT', '路演', '尽职调查', '投行', '行研', '量化', '因子分析', '回测', '会计', 'CPA', 'CFA',
  // 通用
  '沟通', '英语', '雅思', '托福', 'TOEFL', 'IELTS', 'CET-4', 'CET-6', '四六级', '演讲', '跨部门协作', '商务谈判',
]

// ─── text parsing ─────────────────────────────────────────────────────────────
const CN_DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function parseCnNumber(token) {
  if (!token) return null
  if (/^\d+$/.test(token)) return Number(token)
  if (token === '十') return 10
  const m = /^([一二三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(token)
  if (!m) return null
  const [, a, ten, b] = m
  let n = 0
  if (ten) n += 10
  if (a) n += CN_DIGIT[a] ?? 0
  if (b) n += CN_DIGIT[b] ?? 0
  return n || null
}

export function parseInternshipType(text) {
  const t = String(text ?? '')
  if (/暑期|summer/i.test(t)) return 'summer'
  if (/寒假|winter/i.test(t)) return 'winter'
  if (/日常实习|日常/.test(t)) return 'daily'
  if (/长期实习|长期/.test(t)) return 'long'
  if (/短期|项目制/.test(t)) return 'short'
  return null
}

export const RECRUIT_TYPES = ['autumn_campus', 'spring_campus', 'summer', 'daily', 'other']

export const RECRUIT_LABEL = {
  autumn_campus: '秋招',
  spring_campus: '春招',
  summer: '暑期实习',
  daily: '日常实习',
  other: '其他',
}

/**
 * Recruitment channel, orthogonal to internship_type: a 2027 秋招 posting can be a
 * campus hire or a summer internship, so it gets its own field.
 */
export function parseRecruitType(text) {
  const t = String(text ?? '')
  if (/秋招|秋季校园招聘|秋季招聘|autumn\s*(campus|recruit)/i.test(t)) return 'autumn_campus'
  if (/春招|春季校园招聘|春季招聘|spring\s*(campus|recruit)/i.test(t)) return 'spring_campus'
  if (/暑期实习|summer\s*intern/i.test(t)) return 'summer'
  if (/日常实习/.test(t)) return 'daily'
  if (/校园招聘|校招|campus\s*(hire|recruit)/i.test(t)) return 'autumn_campus'
  return null
}

export function parseRemoteType(text) {
  const t = String(text ?? '')
  if (/远程|线上办公|在家办公|remote/i.test(t)) return 'remote'
  if (/混合|hybrid|可远程可线下/.test(t)) return 'hybrid'
  if (/线下|onsite|坐班|实地/.test(t)) return 'onsite'
  return null
}

export function parseDaysPerWeek(text) {
  const t = String(text ?? '')
  const filler = '(?:需|须|要求|出勤|到岗|至少|不少于|保证|每周|可|能|上|工作日|\\s)*'
  const patterns = [
    new RegExp(`每周${filler}([0-9一二三四五六七])\\s*[-~到至]\\s*([0-9一二三四五六七])\\s*天`),
    new RegExp(`每周${filler}([0-9一二三四五六七八九十]+)\\s*天`),
    /([0-9])\s*days?\s*(?:per|\/)\s*week/i,
    new RegExp(`一周${filler}([0-9一二三四五六七]+)\\s*天`),
    /(\d)\s*天\s*\/\s*周/,
  ]
  for (const p of patterns) {
    const m = p.exec(t)
    if (m) {
      const first = parseCnNumber(m[1])
      if (first) return first
    }
  }
  if (/全职实习/.test(t)) return 5
  return null
}

export function parseGradeLimit(text) {
  const t = String(text ?? '')
  const m = /(20\d{2})\s*(?:届|年毕业|年应届)/.exec(t)
  if (m) return `${m[1]}届`
  if (/应届/.test(t)) return '应届'
  const s = /(大[一二三四]|研[一二三]|硕士在读|博士在读|本科在读)/.exec(t)
  return s ? s[1] : null
}

/** Deadlines appear as `2026-03-01`, `26年3月1日` or `3月1日`. */
export function parseDeadline(text, nowIsoString = today()) {
  const t = String(text ?? '')
  let m = /(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(t)
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  m = /(\d{1,2})月(\d{1,2})日/.exec(t)
  if (m) {
    const year = nowIsoString.slice(0, 4)
    return `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
  }
  m = /(?:截止|deadline)[^\d]{0,6}(20\d{2})-(\d{2})-(\d{2})/i.exec(t)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return null
}

const SHORT_ASCII_SKILL = /^[A-Za-z]{1,2}\+{0,2}$/

export function extractSkills(text, extraLexicon = []) {
  const t = String(text ?? '')
  if (!t) return []
  const normalized = normKey(t)
  const found = new Set()
  for (const skill of [...SKILL_LEXICON, ...extraLexicon]) {
    const key = normKey(skill)
    if (!key) continue
    // `C`, `R`, `Go` must match as standalone tokens — otherwise "React"/"PyTorch"
    // would silently satisfy a C requirement.
    if (SHORT_ASCII_SKILL.test(skill)) {
      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const boundary = new RegExp(`(^|[^A-Za-z0-9+#])${escaped}($|[^A-Za-z0-9+#])`)
      if (boundary.test(t)) found.add(skill)
      continue
    }
    if (normalized.includes(key)) found.add(skill)
  }
  return [...found]
}

export function extractCity(text) {
  const t = String(text ?? '')
  const cities = ['北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '西安', '苏州', '天津', '重庆',
    '长沙', '青岛', '合肥', '厦门', '郑州', '济南', '东莞', '佛山', '宁波', '无锡', '珠海', '香港', '新加坡',
    '远程', '全国']
  const hits = cities.filter((c) => t.includes(c))
  return hits.length ? hits.join('/') : str(text, 60)
}

// ─── job normalization ────────────────────────────────────────────────────────
/**
 * Turn one raw job payload (from a connector, a paste, or the agent) into the
 * canonical column set. Unknown fields stay null — never invented.
 */
export function normalizeJob(input = {}) {
  const title = str(input.title ?? input.jobTitle ?? input.name, 300)
  const companyName = str(input.company ?? input.companyName ?? input.employer, 200)
  if (!title) throw new Error('岗位缺少 title')
  if (!companyName) throw new Error('岗位缺少 company')

  const description = str(input.description ?? input.jd ?? input.detail, 20000)
  const requirements = str(input.requirements ?? input.qualification, 20000)
  const haystack = [title, description, requirements, input.department, input.notes].filter(Boolean).join('\n')

  const internshipType = str(input.internshipType ?? input.internship_type, 20) ?? parseInternshipType(haystack)
  const location = str(input.location ?? input.city, 200) ?? extractCity(haystack)
  const remoteType = str(input.remoteType ?? input.remote_type, 20) ?? parseRemoteType(haystack)
  const daysPerWeek = num(input.daysPerWeek ?? input.days_per_week) ?? parseDaysPerWeek(haystack)
  const skills = arr(input.skills).length ? arr(input.skills) : extractSkills(haystack)
  const deadline = str(input.deadline, 40) ?? parseDeadline(haystack)
  const status = JOB_STATUSES.includes(String(input.status)) ? String(input.status) : 'UNKNOWN'

  return {
    companyName,
    companyKey: companyKey(companyName),
    title,
    titleKey: titleKey(title),
    jobCode: str(input.jobCode ?? input.job_id ?? input.code, 120),
    postId: str(input.postId ?? input.post_id, 120),
    department: str(input.department ?? input.team, 200),
    businessUnit: str(input.businessUnit ?? input.business_unit ?? input.bu, 200),
    location,
    remoteType: remoteType ?? 'onsite',
    internshipType: internshipType ?? 'other',
    description,
    requirements,
    skills,
    gradeLimit: str(input.gradeLimit ?? input.grade_limit, 120) ?? parseGradeLimit(haystack),
    majorLimit: str(input.majorLimit ?? input.major_limit, 200),
    languageReq: str(input.languageReq ?? input.language_req, 120),
    duration: str(input.duration, 120),
    startDate: str(input.startDate ?? input.start_date, 40),
    daysPerWeek,
    salaryText: str(input.salaryText ?? input.salary, 200),
    conversionPossible: input.conversionPossible === true ? 1 : input.conversionPossible === false ? 0 : null,
    publishedAt: str(input.publishedAt ?? input.published_at, 40),
    deadline,
    recruitType: str(input.recruitType ?? input.recruit_type, 40) ?? parseRecruitType(haystack),
    applyUrl: str(input.applyUrl ?? input.apply_url, 1000) ?? str(input.url ?? input.sourceUrl, 1000),
    status,
    statusSource: str(input.statusSource ?? input.source_url, 500),
    confidence: str(input.confidence, 20),
    notes: str(input.notes, 4000),
    tags: arr(input.tags),
    url: str(input.url ?? input.applyUrl ?? input.sourceUrl, 1000),
  }
}

/** Stable identity key for the same posting seen from several places. */
export function computeDedupeKey(job) {
  if (job.jobCode) return `code:${job.companyKey}|${normKey(job.jobCode)}`
  const loc = normKey(job.location ?? '')
  return `tk:${job.companyKey}|${job.titleKey}|${loc}`
}

/**
 * Entity resolution against what is already stored. Order matters: an official job
 * code beats a URL, which beats a fuzzy title match. Returns null when the posting
 * is new.
 */
export function findJobIdentity(db, job, candidates) {
  if (job.jobCode) {
    const row = db.get('SELECT id, title, company_name FROM job WHERE company_id IS ? AND job_code IS ?', [job.companyId ?? null, job.jobCode])
    if (row) return { id: row.id, reason: 'job_code' }
  }
  // 有岗位编号时不按 URL 相认：一次列表抓取里所有岗位共用同一个 pageUrl，
  // 若拿它当身份，整页岗位会被合并成一条。编号已是更强的身份，跳过这一层。
  if (job.url && !job.jobCode) {
    const row = db.get('SELECT job_id AS id FROM job_source WHERE source_url = ? LIMIT 1', [job.url])
    if (row) return { id: row.id, reason: 'source_url' }
  }
  const exact = db.get('SELECT id FROM job WHERE dedupe_key = ?', [computeDedupeKey(job)])
  if (exact) return { id: exact.id, reason: 'dedupe_key' }

  // Fuzzy: same company (by key) + similar normalized title + compatible location.
  const pool = candidates ?? db.all(
    'SELECT id, title, title_key, location FROM job WHERE company_name = ? OR company_id = ? LIMIT 60',
    [job.companyName, job.companyId ?? null],
  )
  for (const row of pool) {
    const sim = similarity(row.title ?? '', job.title)
    const locA = normKey(row.location ?? '')
    const locB = normKey(job.location ?? '')
    const locOk = !locA || !locB || locA === locB || locA.includes(locB) || locB.includes(locA)
    if (sim >= 0.82 && locOk) return { id: row.id, reason: 'fuzzy_title', similarity: Number(sim.toFixed(3)) }
  }
  return null
}

// ─── match engine ─────────────────────────────────────────────────────────────
export const DEFAULT_WEIGHTS = {
  qualification: 30,
  experience: 20,
  interest: 20,
  logistics: 15,
  growth: 10,
  freshness: 5,
}

export const MATCH_BANDS = {
  high_priority: '高优先级申请',
  worth_trying: '值得尝试',
  needs_strengthening: '需要补强',
  hard_mismatch: '暂不符合硬条件',
  insufficient_info: '信息不足，待研究',
}

const SENIOR_SKILL_HINT = /(高级|资深|senior|lead|专家)/i

/** Job rows come from SQLite as snake_case but connectors feed camelCase. Read both. */
function jf(job, snake, camel, fallback = null) {
  if (job[snake] !== undefined && job[snake] !== null) return job[snake]
  if (job[camel] !== undefined && job[camel] !== null) return job[camel]
  return fallback
}

/**
 * Hard filters run before any scoring. A disqualified job still returns its reasons
 * so the user can see exactly which constraint failed.
 */
export function applyHardFilters(profile, job) {
  const reasons = []
  if (!profile) return reasons
  const text = [job.title, job.description, job.requirements].filter(Boolean).join('\n')

  for (const word of arr(profile.excluded)) {
    if (word && text.includes(word)) reasons.push(`命中排除条件「${word}」`)
  }

  const gradYear = num(profile.grad_year ?? profile.gradYear)
  const gradeLimit = jf(job, 'grade_limit', 'gradeLimit')
  if (gradYear && gradeLimit) {
    const m = /(20\d{2})/.exec(gradeLimit)
    if (m && Number(m[1]) !== gradYear) reasons.push(`岗位限 ${gradeLimit}，你的毕业年份是 ${gradYear}`)
    if (!m && /应届/.test(gradeLimit) && gradeLimit !== '应届') reasons.push('岗位限应届')
  }

  const days = num(jf(job, 'days_per_week', 'daysPerWeek'))
  const available = num(profile.weekly_days ?? profile.weeklyDays)
  if (days && available && days > available) reasons.push(`要求每周 ${days} 天，你只能出勤 ${available} 天`)

  const cities = arr(profile.cities)
  const remotePref = profile.remote_pref ?? profile.remotePref ?? 'any'
  const location = jf(job, 'location', 'location')
  const remoteType = jf(job, 'remote_type', 'remoteType')
  if (cities.length && location && remotePref !== 'remote' && remoteType !== 'remote') {
    const hit = cities.some((c) => location.includes(c) || c.includes(String(location).split('/')[0]))
    if (!hit && !/远程/.test(location)) reasons.push(`工作地点「${location}」不在你的目标城市`)
  }

  const types = arr(profile.internship_types ?? profile.internshipTypes)
  const internshipType = jf(job, 'internship_type', 'internshipType')
  if (types.length && internshipType && internshipType !== 'other' && !types.includes(internshipType)) {
    reasons.push(`实习类型「${INTERNSHIP_LABEL[internshipType] ?? internshipType}」不在你的选择内`)
  }

  const startAt = str(profile.availability_start ?? profile.availabilityStart, 20)
  const startDate = jf(job, 'start_date', 'startDate')
  if (startAt && startDate && startDate < startAt) reasons.push(`岗位开始时间 ${startDate} 早于你可实习时间`)
  return reasons
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n))
}

/**
 * Explainable multi-dimensional score. The number measures fit against the user's
 * stated preferences — it is NOT an admission probability and never claims to be.
 */
export function analyzeMatch(profile, job, weightsOverride) {
  const weights = { ...DEFAULT_WEIGHTS, ...(profile?.preferences?.weights ?? {}), ...(weightsOverride ?? {}) }
  const hardBlocks = applyHardFilters(profile, job)
  const breakdown = {}
  const matched = []
  const missing = []
  const unknown = []

  // 1) qualification — official requirements vs verified skills
  const profileSkills = new Map()
  const rawSkills = Array.isArray(profile?.skills) ? profile.skills : []
  for (const s of rawSkills) {
    const name = typeof s === 'string' ? s : s?.name
    if (name) profileSkills.set(normKey(name), typeof s === 'object' ? s : { name })
  }
  const jobSkills = arr(job.skills)
  const jobText = [job.description, job.requirements].filter(Boolean).join('\n')
  const requiredSkills = jobSkills.length ? jobSkills : extractSkills(jobText)
  let hit = 0
  for (const skill of requiredSkills) {
    if (profileSkills.has(normKey(skill))) {
      hit += 1
      matched.push(`技能匹配：${skill}`)
    } else {
      missing.push(`缺技能：${skill}`)
    }
  }
  const qual = requiredSkills.length ? hit / requiredSkills.length : 0.5
  if (!requiredSkills.length) unknown.push('岗位未列出明确技能要求，技能维度按中性计分')
  breakdown.qualification = Number((qual * weights.qualification).toFixed(2))

  // 2) experience —项目/实习经历关键词覆盖
  const expSignals = arr(profile?.preferences?.experienceKeywords).length
    ? arr(profile.preferences.experienceKeywords)
    : requiredSkills.slice(0, 8)
  let expHit = 0
  const resumeText = String(profile?.resumeDigest ?? '')
  for (const sig of expSignals) if (resumeText && normKey(resumeText).includes(normKey(sig))) expHit += 1
  const expRatio = expSignals.length ? expire(expHit, expSignals.length) : 0.5
  breakdown.experience = Number((expRatio * weights.experience).toFixed(2))
  if (expRatio >= 0.6) matched.push(`简历中已有 ${expHit}/${expSignals.length} 项相关经历线索`)
  else if (expSignals.length) missing.push(`简历中相关经历线索仅 ${expHit}/${expSignals.length} 项`)

  // 3) interest — industry / role / company target
  let interest = 0
  const industries = arr(profile?.target_industries)
  const roles = arr(profile?.target_roles)
  const companies = arr(profile?.target_companies)
  const companyText = `${jf(job, 'company_name', 'companyName', '')} ${jf(job, 'business_unit', 'businessUnit', '')}`
  const titleText = `${job.title} ${job.department ?? ''}`
  if (companies.some((c) => companyText.includes(c))) {
    interest += 0.5
    matched.push(`目标企业：${jf(job, 'company_name', 'companyName', '') || '命中目标企业'}`)
  }
  if (industries.some((i) => jobText.includes(i) || companyText.includes(i))) interest += 0.3
  if (roles.some((r) => titleText.includes(r) || normKey(titleText).includes(normKey(r)))) {
    interest += 0.2
    matched.push(`岗位方向命中：${job.title}`)
  } else if (roles.length) missing.push(`岗位方向与目标（${roles.join('/')}）不完全一致`)
  breakdown.interest = Number((clamp01(interest) * weights.interest).toFixed(2))

  // 4) logistics — city / remote / days / time
  let logistics = 1
  const cities = arr(profile?.cities)
  const location = jf(job, 'location', 'location')
  const remoteType = jf(job, 'remote_type', 'remoteType')
  const remotePref = profile?.remote_pref ?? profile?.remotePref ?? 'any'
  if (cities.length && location) {
    const ok = cities.some((c) => location.includes(c)) || remoteType === 'remote'
    logistics *= ok ? 1 : 0.35
  }
  const days = num(jf(job, 'days_per_week', 'daysPerWeek'))
  const avail = num(profile?.weekly_days ?? profile?.weeklyDays)
  if (days && avail) logistics *= days <= avail ? 1 : 0.3
  if (remoteType === 'remote' && remotePref === 'onsite') logistics *= 0.6
  breakdown.logistics = Number((clamp01(logistics) * weights.logistics).toFixed(2))

  // 5) growth — transparency of team/scope plus conversion signal
  const conversion = jf(job, 'conversion_possible', 'conversionPossible')
  let growth = 0.4
  if (jf(job, 'department', 'department')) growth += 0.15
  if (jf(job, 'business_unit', 'businessUnit')) growth += 0.1
  if (job.description && job.description.length > 200) growth += 0.15
  if (conversion === 1 || conversion === true) growth += 0.2
  if (conversion === null || conversion === undefined) unknown.push('转正机会未公开，未知')
  breakdown.growth = Number((clamp01(growth) * weights.growth).toFixed(2))

  // 6) freshness — how recently the status itself was verified
  const verifiedAt = jf(job, 'status_verified_at', 'statusVerifiedAt', jf(job, 'updated_at', 'updatedAt', jf(job, 'created_at', 'createdAt')))
  const age = daysBetween(verifiedAt)
  const fresh = age === null ? 0.3 : age <= 3 ? 1 : age <= 7 ? 0.8 : age <= 30 ? 0.5 : 0.2
  breakdown.freshness = Number((fresh * weights.freshness).toFixed(2))
  if (age !== null && age > 30) missing.push(`招聘状态已 ${age} 天未核验`)

  const totalMax = Object.values(weights).reduce((a, b) => a + b, 0) || 1
  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0)
  const score = Number(((raw / totalMax) * 100).toFixed(1))

  let band
  if (hardBlocks.length) band = 'hard_mismatch'
  else if (!job.description && !job.requirements && !requiredSkills.length) band = 'insufficient_info'
  else if (score >= 80) band = 'high_priority'
  else if (score >= 65) band = 'worth_trying'
  else band = 'needs_strengthening'

  const highlight = requiredSkills
    .filter((s) => profileSkills.has(normKey(s)))
    .slice(0, 5)
    .map((s) => `简历里突出与「${s}」相关的项目/实习`)
  if (SENIOR_SKILL_HINT.test(job.title)) missing.push('岗位标题含资深/高级字样，注意资历要求')

  return {
    score,
    band,
    bandLabel: MATCH_BANDS[band],
    breakdown,
    weights,
    reasons: { matched, missing, unknown, highlight },
    hardBlocks,
  }
}

function expire(hit, total) {
  if (!total) return 0.5
  return clamp01(hit / total)
}

/** Count of days until the deadline (negative = already passed). */
export function deadlineInDays(job) {
  if (!job.deadline) return null
  return daysBetween(today(), job.deadline)
}

export function statusAgeDays(job) {
  return daysBetween(job.statusVerifiedAt ?? job.createdAt)
}
