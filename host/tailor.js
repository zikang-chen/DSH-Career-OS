// 针对目标岗位「微调上一版简历」的算法。
//
// 关键约束：这里只做「挑选 + 排序」，**不重写任何事实**。素材库里的 bullet 原样进入新
// 版本；岗位要求里没有对应素材的，进 gaps（缺什么），而不是编一条经历出来。
import { extractSkills } from './domain.js'
import { normKey } from './util.js'

export const EXPERIENCE_KINDS = ['education', 'internship', 'project', 'research', 'activity', 'award', 'certificate', 'skill']

export const KIND_LABEL = {
  education: '教育背景',
  internship: '实习经历',
  project: '项目经历',
  research: '科研经历',
  activity: '校园经历',
  award: '奖项荣誉',
  certificate: '证书与技能',
  skill: '技能',
}

/** Default section order for a Chinese one-page CV. */
export const KIND_ORDER = ['education', 'internship', 'project', 'research', 'activity', 'award', 'certificate', 'skill']

/**
 * 同义技能组：岗位写「英语」，简历里可能写「TOEFL 105 / 英文论文」；岗位写「大模型」，
 * 简历可能写「LoRA / VLM / 推理优化」。
 *
 * 只收**真正等价**的说法。刻意不合并的东西（合并会掩盖真实缺口）：
 *   - SQL / Python → 数据分析：会工具不等于做过分析
 *   - Java / Python → 编程：语言之间不可互相顶替
 *   - 协调 / 推进 → 项目管理：措辞太泛
 *   - A/B测试 → 数据分析：没做过实验设计就是缺口，不能算有
 */
const SKILL_GROUPS = [
  ['大模型', 'LLM', 'VLM', '多模态', 'LoRA', 'Transformer', '微调', '推理优化', '大语言模型'],
  ['英语', '英文', 'TOEFL', 'IELTS', 'CET', 'CET-4', 'CET-6', '托福', '雅思', '四六级', '英语六级', '英语四级'],
]

const CANON = new Map()
for (const group of SKILL_GROUPS) {
  const key = normKey(group[0])
  for (const token of group) CANON.set(normKey(token), key)
}

/** 归一到同义组代表；没有对应组的保持原样。 */
export function canonicalSkill(token) {
  const key = normKey(token)
  return CANON.get(key) ?? key
}

/**
 * 推荐章节顺序：产品/市场岗把实操经历（校园/实习）提到研究前面，
 * 研究/算法岗则相反。依据岗位文本里的关键词判断，判断不出用默认顺序。
 */
export function suggestKindOrder(job = {}) {
  const title = String(job.title ?? '')
  const body = [job.description, job.requirements, (job.skills ?? []).join(' ')].filter(Boolean).join('\n')
  const PRODUCT = ['education', 'internship', 'activity', 'project', 'research', 'award', 'certificate', 'skill']
  const RESEARCH = ['education', 'research', 'project', 'internship', 'award', 'certificate', 'activity', 'skill']

  // 标题是最强的信号：叫「产品经理」就该把实操经历放前面，别被 JD 里的「论文/算法」带偏。
  const productTitle = /产品|运营|市场|增长|商业化|解决方案|咨询/i.test(title)
  const researchTitle = /算法|研究|科学家|研究员|scientist|research|engineer/i.test(title)
  if (productTitle && !researchTitle) return PRODUCT
  if (researchTitle && !productTitle) return RESEARCH

  const productish = /产品|运营|市场|增长|商业化|用户研究|PRD|解决方案|咨询/i.test(body)
  const researchish = /科研|研究|算法|论文|SCI|CCF|模型训练|推理优化/i.test(body)
  if (productish && !researchish) return PRODUCT
  if (researchish && !productish) return RESEARCH
  return KIND_ORDER
}

function textOfExperience(exp) {
  return [exp.organization, exp.role, exp.location, ...(exp.bullets ?? []), ...(exp.tags ?? [])].filter(Boolean).join(' ')
}

function hasMetric(text) {
  return /\d/.test(String(text ?? ''))
}

/**
 * Score every experience against a target job and decide what to keep.
 *
 * @param {object} input
 * @param {Array} input.experiences 素材库条目
 * @param {object} input.job 目标岗位（title/description/requirements/skills）
 * @param {number} [input.maxEntries] 最多保留几段经历
 * @param {number} [input.bulletsPerEntry] 每段最多保留几条 bullet
 * @returns {{selected:Array, omitted:Array, gaps:string[], matchedSkills:string[], rationale:string[], warnings:string[]}}
 */
export function planTailor({ experiences = [], job = {}, maxEntries = 6, bulletsPerEntry = 4, includeIds = [], excludeIds = [] } = {}) {
  const warnings = []
  const excludeSet = new Set((excludeIds ?? []).filter(Boolean).map(String))
  const includeSet = new Set((includeIds ?? []).filter(Boolean).map(String))
  if (excludeSet.size) experiences = experiences.filter((exp) => !excludeSet.has(String(exp.id)))
  const jobText = [job.title, job.description, job.requirements, (job.skills ?? []).join(' ')].filter(Boolean).join('\n')
  const jobSkills = new Set()
  // Keep the original spelling so gaps read `A/B测试`, not the normalized `ab测试`.
  const displaySkill = new Map()
  for (const raw of [...(job.skills ?? []), ...extractSkills(jobText)]) {
    const canonical = canonicalSkill(raw)
    jobSkills.add(canonical)
    if (!displaySkill.has(canonical)) displaySkill.set(canonical, String(raw))
  }
  const show = (key) => displaySkill.get(key) ?? key

  if (!experiences.length) {
    warnings.push('素材库里没有任何经历。先在「素材库」里把实习/项目/科研逐条录入，才能做针对性微调。')
    return { selected: [], omitted: [], gaps: [...jobSkills].map(show), matchedSkills: [], rationale: [], warnings }
  }
  if (!jobSkills.size) warnings.push('目标岗位没有可识别的技能关键词，本次排序主要依据经历的新近程度。')

  const allExperienceSkills = new Set()
  const scored = experiences.map((exp) => {
    const expSkills = new Set()
    for (const skill of [...(exp.skills ?? []), ...extractSkills(textOfExperience(exp))]) {
      const canonical = canonicalSkill(skill)
      expSkills.add(canonical)
      allExperienceSkills.add(canonical)
    }
    const matched = [...jobSkills].filter((s) => expSkills.has(s)).map(show)
    const bulletScores = (exp.bullets ?? []).map((bullet) => {
      const bulletSkills = extractSkills(bullet).map(canonicalSkill)
      const hits = bulletSkills.filter((s) => jobSkills.has(s)).length
      return { bullet, hits, hasNumber: hasMetric(bullet) }
    })
    // Relevance first (skill overlap dominates), then recency, then keep education pinned.
    const relevance = matched.length * 3 + bulletScores.reduce((sum, b) => sum + b.hits, 0)
    const recency = String(exp.end_at ?? '')
    const pinned = exp.kind === 'education' || includeSet.has(String(exp.id))
    return { exp, matched, bulletScores, relevance, recency, pinned, forced: includeSet.has(String(exp.id)) }
  })

  scored.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (b.relevance !== a.relevance) return b.relevance - a.relevance
    return b.recency.localeCompare(a.recency)
  })

  const kept = []
  const omitted = []
  let budget = Math.max(1, maxEntries)
  for (const row of scored) {
    if (row.pinned) {
      kept.push(row)
      continue
    }
    if (budget > 1 || kept.length === 0) {
      kept.push(row)
      budget -= 1
      continue
    }
    omitted.push({
      experienceId: row.exp.id,
      organization: row.exp.organization ?? null,
      role: row.exp.role ?? null,
      location: row.exp.location ?? null,
      bullets: (row.exp.bullets ?? []).slice(0, bulletsPerEntry),
      matchedSkills: row.matched,
      reason: row.relevance > 0 ? '与岗位相关的技能命中少于已选经历' : '与目标岗位缺乏可对齐的关键词',
      relevance: row.relevance,
    })
  }

  const selected = kept.map((row) => {
    const ordered = row.bulletScores
      .slice()
      .sort((a, b) => (b.hits - a.hits) || (Number(b.hasNumber) - Number(a.hasNumber)))
    const bullets = ordered.slice(0, Math.max(1, bulletsPerEntry)).map((b) => b.bullet)
    const dropped = ordered.slice(Math.max(1, bulletsPerEntry)).map((b) => b.bullet)
    return {
      experienceId: row.exp.id,
      kind: row.exp.kind,
      kindLabel: KIND_LABEL[row.exp.kind] ?? row.exp.kind,
      organization: row.exp.organization ?? null,
      role: row.exp.role ?? null,
      startAt: row.exp.start_at ?? null,
      endAt: row.exp.end_at ?? null,
      period: [row.exp.start_at, row.exp.end_at].filter(Boolean).join(' – '),
      location: row.exp.location ?? null,
      bullets,
      droppedBullets: dropped,
      matchedSkills: row.matched,
      relevance: row.relevance,
    }
  })

  const matchedSkills = [...new Set(selected.flatMap((s) => s.matchedSkills))]
  const gaps = [...jobSkills].filter((s) => !allExperienceSkills.has(s)).map(show)

  const rationale = []
  if (matchedSkills.length) {
    rationale.push(`按岗位关键词命中排序：优先保留能对上 ${matchedSkills.join('、')} 的经历。`)
  }
  if (omitted.length) {
    rationale.push(`移出 ${omitted.length} 段与岗位关联较弱的经历（仍保留在素材库，随时可加回）。`)
  }
  const trimmedBullets = selected.reduce((sum, s) => sum + (s.droppedBullets?.length ?? 0), 0)
  if (trimmedBullets) rationale.push(`共精简 ${trimmedBullets} 条与岗位关联较弱的要点，让一页更聚焦。`)
  if (gaps.length) {
    rationale.push(`岗位要求里有 ${gaps.length} 项在你的素材库中找不到对应经历——这些是真实缺口，不会替你编。`)
  }

  return { selected, omitted, gaps, matchedSkills, rationale, warnings }
}

/** Group a selection into LaTeX/report sections in the given (or default) order. */
export function sectionsFromSelection(selected, kindOrder = KIND_ORDER) {
  const byKind = new Map()
  for (const item of selected) {
    const kind = EXPERIENCE_KINDS.includes(item.kind) ? item.kind : 'project'
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind).push(item)
  }
  const sections = []
  for (const kind of kindOrder) {
    const items = byKind.get(kind)
    if (!items?.length) continue
    sections.push({
      kind,
      label: KIND_LABEL[kind] ?? kind,
      items: items.map((item) => ({
        org: item.organization,
        role: item.role,
        period: item.period,
        location: item.location,
        bullets: item.bullets,
      })),
    })
  }
  return sections
}
