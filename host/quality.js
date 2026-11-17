// 简历质量检查：只报「可核对的问题」，不生成内容、不评判优劣。
//
// 设计原则：
//   - 每条问题必须指向具体数据（哪段经历、哪个字段、哪条 JD 要求）；
//   - 分三档：error（会直接影响投递）/ warn（建议修）/ info（可选）；
//   - 缺数据就说缺，不推断。
import { extractSkills } from './domain.js'
import { canonicalSkill } from './tailor.js'

function hasMetric(text) {
  return /\d+(\.\d+)?\s*(%|万|亿|倍|×|人|天|小时|篇|项|个|款|次|ms|s\b)/i.test(String(text ?? '')) || /\d+\s*\/\s*\d+/.test(String(text ?? ''))
}

/** 从文本里抠出「YYYY-MM」「YYYY.MM」「YYYY年M月」等时间。 */
export function parsePeriod(text) {
  const raw = String(text ?? '')
  const m = /(\d{4})[\s\-./年]?(\d{1,2})?/.exec(raw)
  if (!m) return null
  const year = Number(m[1])
  if (year < 1990 || year > 2100) return null
  return { year, month: m[2] ? Number(m[2]) : null }
}

/**
 * @param {{profile:object, experiences?:Array, documents?:Array, job?:object}} input
 * @returns {{ok:boolean, issues:Array<{level:'error'|'warn'|'info', code:string, message:string, target?:string}>, summary:{error:number,warn:number,info:number}}}
 */
export function checkResumeQuality({ profile = {}, experiences = [], documents = [], job = null } = {}) {
  const issues = []
  const add = (level, code, message, target) => issues.push({ level, code, message, ...(target ? { target } : {}) })

  // ① 联系方式
  if (!String(profile.phone ?? '').trim()) add('error', 'missing-phone', '画像里没有手机号，网申/简历都需要', 'profile.phone')
  if (!String(profile.email ?? '').trim()) add('error', 'missing-email', '画像里没有邮箱', 'profile.email')

  // ② 教育核心字段
  const edu = experiences.filter((e) => e.kind === 'education')
  if (!edu.length) add('error', 'missing-education', '素材库里没有教育经历', 'experiences')
  for (const row of edu) {
    if (!row.start_at || !row.end_at) add('warn', 'education-missing-date', `教育经历「${row.organization ?? '?'}」缺少起止时间`, row.id)
  }

  // ③ 同一机构多段（可能重复录入）
  const byOrg = new Map()
  for (const exp of experiences) {
    const key = String(exp.organization ?? '').trim()
    if (!key) continue
    if (!byOrg.has(key)) byOrg.set(key, [])
    byOrg.get(key).push(exp)
  }
  for (const [org, rows] of byOrg) {
    if (rows.length > 1) add('warn', 'duplicate-organization', `「${org}」有 ${rows.length} 段经历，确认不是重复录入`, org)
  }

  // ④ 时间倒挂
  for (const exp of experiences) {
    const a = parsePeriod(exp.start_at)
    const b = parsePeriod(exp.end_at)
    if (a && b) {
      const av = a.year * 100 + (a.month ?? 0)
      const bv = b.year * 100 + (b.month ?? 0)
      if (bv < av) add('warn', 'date-inverted', `「${exp.organization ?? '?'}」结束时间早于开始时间`, exp.id)
    }
  }

  // ⑤ 无要点的经历（对出稿没用）
  for (const exp of experiences) {
    if (!(exp.bullets ?? []).length) add('info', 'empty-bullets', `「${exp.organization ?? exp.role ?? '?'}」没有要点，出稿时用不上`, exp.id)
  }

  // ⑥ 有数字要点的比例（只是提示，不是硬性）
  const withBullets = experiences.filter((e) => (e.bullets ?? []).length)
  if (withBullets.length) {
    const quantified = withBullets.filter((e) => (e.bullets ?? []).some(hasMetric)).length
    if (quantified === 0) add('info', 'no-metrics', '所有经历要点都没有量化数字，面试时容易被追问「效果如何」')
  }

  // ⑦ 未确认的经历
  const unverified = experiences.filter((e) => e.verified === false).length
  if (unverified) add('info', 'unverified-experience', `${unverified} 段经历还没标「确认属实」，出稿前建议核对`, 'experiences')

  // ⑧ 技能没有证据（个人资料库里没有对应凭据，且经历里也没提到）
  const experienceText = experiences.map((e) => [e.organization, e.role, ...(e.bullets ?? [])].join(' ')).join('\n')
  const docText = documents.map((d) => [d.title, d.score, d.issuer].join(' ')).join('\n')
  const allText = `${experienceText}\n${docText}`
  const skills = (profile.skills ?? []).map((s) => (typeof s === 'string' ? s : s.name)).filter(Boolean)
  // 用项目自带的技能词典从「经历 + 资料」里抽取实际出现的技能，
  // 再做同义归并（英语←TOEFL/CET、大模型←LLM/LoRA…），避免因为措辞不同就误报「没依据」。
  const supported = new Set(extractSkills(allText).map(canonicalSkill))
  for (const name of skills) {
    const needle = String(name).toLowerCase()
    if (needle.length >= 2 && allText.toLowerCase().includes(needle)) supported.add(canonicalSkill(name))
  }
  const reallyUnsupported = skills.filter((name) => !supported.has(canonicalSkill(name)))
  if (reallyUnsupported.length) {
    add('warn', 'skill-without-evidence', `这些技能在经历和资料库里都找不到依据：${reallyUnsupported.join('、')}`, 'profile.skills')
  }

  // ⑨ 针对特定岗位：JD 要求里没被覆盖的
  if (job) {
    const jobText = [job.title, job.description, job.requirements, (job.skills ?? []).join(' ')].filter(Boolean).join('\n').toLowerCase()
    const gaps = []
    for (const raw of job.skills ?? []) {
      const needle = String(raw).toLowerCase()
      if (needle.length >= 2 && !allText.toLowerCase().includes(needle)) gaps.push(String(raw))
    }
    if (!String(job.description ?? '').trim() && !String(job.requirements ?? '').trim()) {
      add('warn', 'jd-incomplete', '这个岗位没有 JD 正文，匹配与缺口判断可能不完整（建议先补 JD）', job.id)
    }
    if (gaps.length) add('warn', 'jd-gap', `岗位要求里有、你素材库中找不到依据的：${[...new Set(gaps)].join('、')}`, job.id)
  }

  const summary = {
    error: issues.filter((i) => i.level === 'error').length,
    warn: issues.filter((i) => i.level === 'warn').length,
    info: issues.filter((i) => i.level === 'info').length,
  }
  return {
    ok: summary.error === 0,
    issues,
    summary,
    note: '只是可核对的问题清单，不替你补内容、不评判好坏。error 会直接影响投递，warn 建议修，info 可选。',
  }
}
