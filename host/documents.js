// 个人资料库：证件/成绩/专利这类「凭据」的归档、按岗位筛选与简历渲染。
//
// 与「经历素材库」分工：
//   - resume_experience 说的是「我做过什么」（叙事，可挑选排序）
//   - personal_document 说的是「我有什么凭据」（事实，可被证明）
// 简历按岗位从两边各取所需：经历给段落，证件给「证书与语言」那一行。

export const DOC_CATEGORIES = ['degree', 'transcript', 'certificate', 'language', 'award', 'patent', 'publication', 'portfolio', 'identity', 'other']

export const DOC_LABEL = {
  degree: '学历学位',
  transcript: '成绩单',
  certificate: '证书/证明',
  language: '语言成绩',
  award: '获奖荣誉',
  patent: '专利',
  publication: '论文',
  portfolio: '作品集',
  identity: '身份证明',
  other: '其他',
}

const RULES = [
  { category: 'language', re: /托福|TOEFL|雅思|IELTS|CET[-\s]?[46]|四六级|大学英语|专业四级|专业八级|专四|专八|GRE|GMAT|JLPT|日语能力/i },
  { category: 'patent', re: /发明专利|实用新型|外观设计|专利|patent|CN\d{9,}/i },
  { category: 'publication', re: /\bSCI\b|\bEI\b|CCF|期刊|论文|accepted|paper|预印本|arXiv/i },
  { category: 'transcript', re: /成绩单|GPA|学分|transcript/i },
  { category: 'degree', re: /学位|毕业证|学历|学士|硕士|博士|在读证明|degree|diploma/i },
  { category: 'award', re: /奖学金|一等奖|二等奖|三等奖|竞赛|获奖|冠军|亚军|honou?r|award/i },
  { category: 'portfolio', re: /作品集|portfolio|github|项目展示/i },
  { category: 'identity', re: /身份证|护照|passport|居民身份/i },
  { category: 'certificate', re: /证书|认证|资格证|实习证明|工作证明|certificate|certified/i },
]

/** 依文件名与正文猜类别；猜不出归 other，不硬塞。 */
export function classifyDocument({ fileName, text } = {}) {
  const haystack = `${fileName ?? ''}\n${String(text ?? '').slice(0, 4000)}`
  for (const rule of RULES) {
    if (rule.re.test(haystack)) return rule.category
  }
  return 'other'
}

/** 从文本里抽分数（托福/雅思/四六级/GPA）。抽不到就返回 null，不猜。 */
export function extractScore(text) {
  const t = String(text ?? '')
  let m = /TOEFL[^\d]{0,12}(\d{2,3})|托福[^\d]{0,8}(\d{2,3})/i.exec(t)
  if (m) return { score: `TOEFL ${m[1] ?? m[2]}`, value: Number(m[1] ?? m[2]), unit: '分', kind: 'TOEFL' }
  m = /IELTS[^\d]{0,10}(\d(?:\.\d)?)|雅思[^\d]{0,8}(\d(?:\.\d)?)/i.exec(t)
  if (m) return { score: `IELTS ${m[1] ?? m[2]}`, value: Number(m[1] ?? m[2]), unit: '分', kind: 'IELTS' }
  m = /CET[-\s]?([46])[^\d]{0,12}(\d{3})/i.exec(t)
  if (m) return { score: `CET-${m[1]} ${m[2]}`, value: Number(m[2]), unit: '分', kind: `CET-${m[1]}` }
  m = /GPA[^\d]{0,8}(\d(?:\.\d{1,2})?)/i.exec(t)
  if (m) return { score: `GPA ${m[1]}`, value: Number(m[1]), unit: 'GPA', kind: 'GPA' }
  return null
}

/** 取标题：尽量保留文件名原样（`CET-6` 里的连字符有意义，只把下划线/多空格压成单空格）。 */
export function titleFromFileName(fileName) {
  const base = String(fileName ?? '').replace(/\.[^.]+$/, '').replace(/[_\s]+/g, ' ').trim()
  return base ? base.slice(0, 120) : '未命名资料'
}

/**
 * 从一份上传文件生成资料候选（需要人确认后才算数）。
 */
export function proposeDocument({ fileName, text, filePath, mime } = {}) {
  const category = classifyDocument({ fileName, text })
  const score = extractScore(`${fileName ?? ''}\n${String(text ?? '').slice(0, 2000)}`)
  return {
    category,
    categoryLabel: DOC_LABEL[category],
    title: titleFromFileName(fileName),
    score: score?.score ?? null,
    scoreValue: score?.value ?? null,
    scoreUnit: score?.unit ?? null,
    filePath: filePath ?? null,
    fileName: fileName ?? null,
    mime: mime ?? null,
    requiresConfirmation: true,
    hint: '标题、颁发机构、取得时间、证书编号需要你核对后补齐；系统不替你猜。',
  }
}

// ─── 按岗位筛选 ─────────────────────────────────────────────────────────────
const JOB_HINTS = {
  language: /英语|英文|English|TOEFL|雅思|IELTS|海外|国际化|出海|跨境/i,
  degree: /硕士|博士|研究生|本科及以上|985|211|学历/i,
  publication: /科研|研究|论文|算法|publication|paper|SCI|CCF|大模型/i,
  patent: /专利|发明|知识产权|技术创新/i,
  award: /竞赛|获奖|奖学金|优秀/i,
  transcript: /GPA|成绩|学业/i,
  certificate: /证书|认证|资质/i,
  portfolio: /作品集|portfolio|案例/i,
  identity: /（一般不需要）/,
  other: /./,
}

/** 这份资料对这个岗位有多相关（0..1）+ 理由。 */
export function scoreDocumentForJob(doc, job = {}) {
  const jobText = [job.title, job.description, job.requirements, (job.skills ?? []).join(' ')].filter(Boolean).join('\n')
  const reasons = []
  let score = 0.2
  const hint = JOB_HINTS[doc.category]
  if (hint && hint.test(jobText)) {
    score += 0.5
    reasons.push(`岗位文本提到与「${DOC_LABEL[doc.category] ?? doc.category}」相关的要求`)
  }
  if (doc.verified) {
    score += 0.15
    reasons.push('已确认属实')
  }
  if (doc.score_value !== null && doc.score_value !== undefined) {
    score += 0.1
    reasons.push('有可量化分数')
  }
  if (doc.category === 'identity') score = Math.min(score, 0.2)
  return { score: Number(Math.min(1, score).toFixed(2)), reasons }
}

/**
 * 按岗位挑出该展示的资料。
 * @returns {{selected:Array, unused:Array, note:string}}
 */
export function planDocumentSelection({ documents = [], job = {}, max = 8, categories } = {}) {
  const allow = categories ? new Set(categories) : null
  const scored = documents
    .filter((doc) => !allow || allow.has(doc.category))
    .map((doc) => ({ doc, ...scoreDocumentForJob(doc, job) }))
    .sort((a, b) => b.score - a.score)
  const selected = scored.slice(0, max)
  const unused = scored.slice(max).map((row) => ({ id: row.doc.id, title: row.doc.title, category: row.doc.category, score: row.score }))
  return {
    selected: selected.map((row) => ({
      id: row.doc.id,
      category: row.doc.category,
      categoryLabel: DOC_LABEL[row.doc.category] ?? row.doc.category,
      title: row.doc.title,
      score: row.score,
      reasons: row.reasons,
      line: documentLine(row.doc),
    })),
    unused,
    note: documents.length
      ? '只按岗位相关性排序，不判断真伪——资料是否属实以你的确认为准。'
      : '资料库为空：先用 career_doc_ingest 上传学历/成绩/证书文件。',
  }
}

/** 一条资料压成简历里的一行。 */
export function documentLine(doc) {
  if (doc.category === 'language' && doc.score) return doc.score
  const parts = [doc.title]
  if (doc.score && doc.score !== doc.title) parts.push(doc.score)
  if (doc.issuer) parts.push(doc.issuer)
  if (doc.issued_at) parts.push(String(doc.issued_at))
  return parts.filter(Boolean).join(' · ')
}

/** 把选中的资料渲染成「证书与语言」小节条目（去重、按类别分组）。 */
export function renderDocumentLines(documents = []) {
  const order = ['language', 'degree', 'publication', 'patent', 'award', 'certificate', 'transcript', 'portfolio', 'other']
  const seen = new Set()
  const byCategory = new Map()
  for (const doc of documents) {
    const line = documentLine(doc)
    if (!line || seen.has(line)) continue
    seen.add(line)
    const category = DOC_CATEGORIES.includes(doc.category) ? doc.category : 'other'
    if (!byCategory.has(category)) byCategory.set(category, [])
    byCategory.get(category).push(line)
  }
  const groups = []
  for (const category of order) {
    const lines = byCategory.get(category)
    if (!lines?.length) continue
    groups.push({ category, label: DOC_LABEL[category] ?? category, lines })
  }
  return groups
}
