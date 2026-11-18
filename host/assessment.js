// Pure v2 assessment. No repository, network, browser, or persistence dependencies.
import { analyzeMatch, parseDaysPerWeek } from './domain.js'

const text = (v) => typeof v === 'string' ? v.trim() : ''
const list = (v) => Array.isArray(v) ? v : []
const pick = (o, snake, camel) => o?.[snake] ?? o?.[camel] ?? null
const number = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null
const DAY = 86400000
function date(v) {
  if (!text(v) || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(v)) return null
  const n = Date.parse(v)
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== v.slice(0, 10)) return null
  return n
}
function url(v) {
  try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && Boolean(u.hostname) } catch { return false }
}
const sourceType = (s) => pick(s, 'source_type', 'sourceType')
const sourceUrl = (s) => pick(s, 'source_url', 'sourceUrl') ?? s?.url
const official = (s) => sourceType(s) === 'official_careers' && url(sourceUrl(s))
const sentences = (s) => text(s).split(/[\n。；;!?！？]+/).map((v) => v.trim()).filter(Boolean)
const preferred = (s) => /优先|加分|preferred|nice.to.have/i.test(s)
function years(s) {
  const result = new Set()
  for (const m of s.matchAll(/(20\d{2})\s*(?:年|届)?\s*[-—–~～至到]\s*(20\d{2})/g)) {
    const a = Number(m[1]), b = Number(m[2])
    if (b >= a && b - a <= 20) for (let y = a; y <= b; y++) result.add(y)
  }
  for (const m of s.matchAll(/20\d{2}/g)) result.add(Number(m[0]))
  return [...result].sort()
}
const degrees = ['专科', '本科', '硕士', '博士']
function degreeRank(s) {
  if (/博士|doctor|ph\.?d/i.test(s)) return 3
  if (/硕士|研究生|master/i.test(s)) return 2
  if (/本科|学士|bachelor/i.test(s)) return 1
  if (/专科|大专|associate/i.test(s)) return 0
  return null
}
function eligibility(job, profile, body) {
  const checks = []
  const add = (key, label, requirement, actual, comparison) => checks.push({
    key, label, requirement: requirement ?? null, actual: actual ?? null,
    status: comparison === null ? 'unknown' : 'provisional',
    comparison: comparison === null ? 'unknown' : comparison ? 'match' : 'mismatch',
    profileConfirmation: 'unconfirmed',
    reason: comparison === null ? `${label}：岗位要求或个人信息缺失/无法可靠解析，待核实` : `${label}：按自述${comparison ? '暂符合' : '可能不符'}，尚未确认`,
  })
  const grade = text(pick(job, 'grade_limit', 'gradeLimit')) || sentences(body).filter((s) => /毕业|应届|届/.test(s) && !preferred(s)).join('；')
  const allowedYears = years(grade)
  const grad = number(pick(profile, 'grad_year', 'gradYear'))
  add('graduationYear', '毕业年份', grade || null, grad, allowedYears.length && grad !== null ? allowedYears.includes(grad) : null)
  checks.at(-1).allowedYears = allowedYears

  const degreeText = text(pick(job, 'degree_limit', 'degreeLimit')) || sentences(body).filter((s) => /学历|本科|硕士|博士|研究生|专科/.test(s) && !preferred(s)).join('；')
  const ranks = degrees.map((d, i) => degreeText.includes(d) ? i : null).filter((v) => v !== null)
  if (degreeText.includes('研究生') && !ranks.includes(2)) ranks.push(2)
  const actualDegree = text(profile.degree), rank = degreeRank(actualDegree)
  // Only minimums and explicit alternatives are interpreted. Ambiguous prose stays unknown.
  const degreeMatch = !ranks.length || rank === null ? null : /以上|及以上|至少|不低于/.test(degreeText) ? rank >= Math.min(...ranks) : ranks.includes(rank)
  add('degree', '学历', degreeText || null, actualDegree || null, degreeMatch)

  const daysText = sentences(body).filter((s) => !preferred(s)).join('\n')
  const days = number(pick(job, 'days_per_week', 'daysPerWeek')) ?? parseDaysPerWeek(daysText)
  const available = number(pick(profile, 'weekly_days', 'weeklyDays'))
  add('weeklyDays', '每周出勤', days, available, days > 0 && days <= 7 && available > 0 && available <= 7 ? available >= days : null)

  const start = pick(job, 'start_date', 'startDate'), availableStart = pick(profile, 'availability_start', 'availabilityStart')
  const availableEnd = pick(profile, 'availability_end', 'availabilityEnd')
  const startMs = date(start), fromMs = date(availableStart), endMs = date(availableEnd)
  add('startDate', '到岗时间', start, availableStart, startMs !== null && fromMs !== null ? fromMs <= startMs && (endMs === null || endMs >= startMs) : null)

  const duration = text(job.duration) || sentences(daysText).find((s) => /(?:至少|不少于|实习|持续).{0,8}\d+\s*(?:个?月|周|天)/.test(s)) || ''
  const m = /(\d+)\s*(个?月|周|天)/.exec(duration)
  let durationMatch = null
  const base = startMs ?? fromMs
  if (m && base !== null && endMs !== null && fromMs !== null) {
    const requiredEnd = new Date(base)
    if (/月/.test(m[2])) {
      // Clamp month-end instead of silently overflowing e.g. January 31 into March.
      const day = requiredEnd.getUTCDate()
      requiredEnd.setUTCDate(1)
      requiredEnd.setUTCMonth(requiredEnd.getUTCMonth() + Number(m[1]))
      const monthEnd = new Date(Date.UTC(requiredEnd.getUTCFullYear(), requiredEnd.getUTCMonth() + 1, 0)).getUTCDate()
      requiredEnd.setUTCDate(Math.min(day, monthEnd))
    } else requiredEnd.setTime(base + Number(m[1]) * (/周/.test(m[2]) ? 7 : 1) * DAY)
    durationMatch = fromMs <= base && endMs >= requiredEnd.getTime()
  }
  add('duration', '可实习时长', duration || null, availableStart || availableEnd ? { start: availableStart, end: availableEnd } : null, durationMatch)
  return {
    status: checks.some((c) => c.status === 'provisional') ? 'provisional' : 'unknown',
    profileConfirmation: 'unconfirmed',
    confirmationNote: '当前 user_profile schema 没有毕业年份/学历/出勤/时间确认字段；onboarded、完整度和技能 verified 不证明这些资格已核实。',
    checks,
  }
}

function assessEvidence(job, nowMs, knowledge) {
  const sources = list(job.sources)
  const history = list(job.history).filter((h) => h && typeof h === 'object')
    .map((h) => ({ row: h, at: date(pick(h, 'verified_at', 'verifiedAt')) }))
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity))
  const latest = history[0]
  const h = latest?.row
  const ageDays = latest?.at !== null && latest?.at !== undefined && nowMs !== null ? (nowMs - latest.at) / DAY : null
  const observationValid = Boolean(h && official(h) && text(h.evidence) && ageDays !== null && ageDays >= 0)
  const fresh = observationValid && ageDays <= 7
  const status = text(h?.status).toUpperCase()
  const stored = text(job.status).toUpperCase()
  const storedAt = date(pick(job, 'status_verified_at', 'statusVerifiedAt'))
  const storedAge = storedAt !== null && nowMs !== null ? (nowMs - storedAt) / DAY : null
  let statusAssessment = 'unknown'
  if (fresh && status === 'OPEN') statusAssessment = 'verified_open'
  else if (fresh && status === 'CLOSED') statusAssessment = 'verified_closed'
  else if (fresh && status === 'UPCOMING') statusAssessment = 'verified_upcoming'
  else if (stored === 'STALE' || (ageDays !== null && ageDays > 7) || (storedAge !== null && storedAge > 7)) statusAssessment = 'stale'
  else if (stored === 'OPEN' || status === 'OPEN' || stored === 'UNVERIFIED') statusAssessment = 'open-unverified'
  return {
    textComplete: Boolean(text(job.description) && text(job.requirements)),
    hasJdText: Boolean(text(job.description) || text(job.requirements)),
    officialSource: sources.some(official),
    sourceCount: sources.length,
    statusAssessment,
    verifiedOpen: statusAssessment === 'verified_open',
    latestObservation: h ? { status: h.status ?? null, sourceType: sourceType(h), sourceUrl: sourceUrl(h) ?? null, evidence: text(h.evidence) || null, verifiedAt: pick(h, 'verified_at', 'verifiedAt'), ageDays: ageDays === null ? null : Number(ageDays.toFixed(3)), valid: observationValid } : null,
    knowledgeCount: list(knowledge).length,
    caveat: '来源站点存在、JD 文本完整或知识库收录均不等于仍开放；仅最近一条状态记录的官方链接、证据文本及 7 天内时间可确认开放。',
  }
}

/**
 * Read-only contract for routes: accepts getJob()/mapProfile() shapes (snake_case),
 * with camelCase aliases. Checks use unknown | provisional and comparison
 * unknown | match | mismatch; no profile-confirmed pass/fail is invented.
 * Fit is rounded preference fit, NOT probability; source/status evidence is separate.
 */
export function assessJob360({ job = {}, profile = {}, experiences = [], knowledge = [], now = new Date().toISOString() } = {}) {
  job ??= {}; profile ??= {}
  const nowMs = date(now)
  const body = [text(job.description), text(job.requirements)].filter(Boolean).join('\n')
  const evidence = assessEvidence(job, nowMs, knowledge)
  const elig = eligibility(job, profile, body)
  const experienceText = list(experiences).map((e) => [text(e.organization), text(e.role), ...list(e.bullets).map(text)].filter(Boolean).join('\n')).join('\n')
  const matchProfile = { ...profile, resumeDigest: [text(profile.resumeDigest), experienceText].filter(Boolean).join('\n') }
  for (const [snake, camel] of [['target_industries', 'targetIndustries'], ['target_roles', 'targetRoles'], ['target_companies', 'targetCompanies']]) matchProfile[snake] = pick(profile, snake, camel) ?? []
  // Freshness belongs to Evidence, not Fit. Clear timestamps so analyzeMatch does not
  // read wall-clock-dependent ages. Ignore its legacy hardBlocks/band entirely.
  const match = analyzeMatch(matchProfile, { ...job, status_verified_at: null, statusVerifiedAt: null, updated_at: null, updatedAt: null, created_at: null, createdAt: null }, { freshness: 0 })
  const breakdown = { ...match.breakdown }; delete breakdown.freshness
  const uncertainty = [...match.reasons.unknown, '画像资格信息为自述，尚未确认；分数不是录用概率。']
  if (!evidence.hasJdText) uncertainty.unshift('JD 无正文：无法可靠判断任务及能力要求。')
  else if (!evidence.textComplete) uncertainty.unshift('JD 职责或要求缺段，匹配结论可能偏保守。')
  const fit = { score: Math.round(match.score), breakdown, reasons: match.reasons, reliable: evidence.hasJdText, uncertainty, scoreMeaning: '偏好与已提供材料的匹配度，不是录用概率', weights: { ...match.weights, freshness: 0 } }
  const tasks = sentences(job.description).map((s) => s.replace(/^(?:[\d一二三四五六七八九十]+[、.)）\s]+|[-*•]\s*)/, '').replace(/^(?:岗位职责|工作职责|职责描述|工作内容)[:：]\s*/, ''))
    .filter((s) => /负责|参与|协助|完成|设计|开发|维护|分析|研究|推进|支持|搭建|优化|撰写|执行|跟进|管理|策划|制作|implement|develop|design|maintain|analy[sz]e|support|responsib/i.test(s) && !/优先|学历|毕业|熟悉|掌握|具备/.test(s))
    .slice(0, 5).map((s) => ({ text: s, label: evidence.officialSource ? 'official-jd' : 'source-jd', sourceField: 'description' }))
  const taskUnknowns = tasks.length ? [] : ['JD 中没有可明确抽取的任务句子，未按岗位标题推测任务。']
  const unknowns = [...new Set([
    ...elig.checks.filter((c) => c.status === 'unknown').map((c) => c.reason),
    '个人资格信息尚未确认。',
    ...(!evidence.verifiedOpen ? ['岗位当前是否仍开放尚未核实。'] : []),
    ...(!evidence.textComplete ? ['JD 职责和要求尚未两段齐全。'] : []),
    ...(nowMs === null ? ['评估时间无效，不能判断证据时效。'] : []),
    ...taskUnknowns,
  ])]
  const risks = elig.checks.filter((c) => c.comparison === 'mismatch').map((c) => c.reason)
  if (evidence.statusAssessment === 'stale') risks.push('状态证据已过 7 天，不能沿用旧 OPEN 断言仍在招。')
  if (!fit.reliable) risks.push('JD 无正文，匹配分仅为不可依赖的材料占位计算。')
  if (evidence.statusAssessment === 'verified_closed') risks.push('最近有效官方记录显示岗位已关闭。')
  const nextActions = ['核对并补齐个人毕业年份、学历、出勤与实习时间；当前仅为自述。']
  if (!evidence.verifiedOpen) nextActions.push('在官方岗位页重新核验开放状态，保留链接、原文摘录和核验时间。')
  if (!evidence.textComplete) nextActions.push('补充 JD 职责与要求原文后重新评估。')
  if (risks.length) nextActions.push('逐项核实暂不匹配条件，不凭未确认画像直接判定淘汰。')
  return {
    version: '2.0', jobId: job.id ?? null, assessedAt: now,
    profileConfirmation: 'unconfirmed', eligibility: elig, fit, evidence,
    taskAnalysis: { tasks, unknowns: taskUnknowns }, unknowns,
    decision: { reasons: [...match.reasons.matched, ...elig.checks.filter((c) => c.comparison === 'match').map((c) => c.reason)], risks, unknowns: [...unknowns], nextActions },
  }
}
