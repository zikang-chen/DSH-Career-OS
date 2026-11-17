// 网申信息卡：把投递表单要填的字段一次性摊平，缺的标出来。
//
// 为什么值得单独做：投一家公司要在网申页面手抄姓名/学校/专业/毕业时间/电话/邮箱/排名/
// 证书编号十几个字段，投 50 家就是 500 次重复劳动。这里只是把已有事实按表单顺序排好，
// **不产生任何新事实**：字段没填就是空，并明确告诉你去哪个页面补。
import { DOC_LABEL, extractScore } from './documents.js'

const DEGREE_RANK = { 博士: 3, 硕士: 2, 本科: 1, 大专: 0, 专科: 0 }

function list(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('、')
  return value === null || value === undefined ? '' : String(value)
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

/** 学历最高的一段（博士 > 硕士 > 本科），用于「在读时间/起止」这类字段。 */
export function pickEducation(experiences = []) {
  const rows = experiences.filter((exp) => exp.kind === 'education')
  if (!rows.length) return null
  return [...rows].sort((a, b) => {
    const ra = DEGREE_RANK[String(a.role ?? '').includes('博士') ? '博士' : String(a.role ?? '').includes('硕士') ? '硕士' : '本科'] ?? 0
    const rb = DEGREE_RANK[String(b.role ?? '').includes('博士') ? '博士' : String(b.role ?? '').includes('硕士') ? '硕士' : '本科'] ?? 0
    if (ra !== rb) return rb - ra
    return String(b.start_at ?? '').localeCompare(String(a.start_at ?? ''))
  })[0]
}

/** 从经历要点里捞排名/GPA（学校常写在简历正文里，而不是结构化字段）。 */
function scanEducationFacts(experiences = []) {
  const joined = experiences.map((exp) => (exp.bullets ?? []).join('\n')).join('\n')
  const rank = /\d+\s*\/\s*\d+/.test(joined) ? (/\d+\s*\/\s*\d+/.exec(joined)?.[0] ?? '') : ''
  const gpa = /GPA[^\d]{0,8}(\d(?:\.\d{1,2})?(?:\s*\/\s*\d(?:\.\d{1,2})?)?)/i.exec(joined)?.[1] ?? ''
  return { rank, gpa }
}

/** 语言成绩：优先资料库（有凭证），没有再扫经历正文。 */
function collectLanguage({ documents = [], experiences = [] }) {
  const fromDocs = documents
    .filter((doc) => doc.category === 'language')
    .map((doc) => ({ line: doc.score || doc.title, source: `资料库：${doc.title}`, verified: Boolean(doc.verified) }))
  if (fromDocs.length) return fromDocs
  const lines = []
  for (const exp of experiences) {
    for (const bullet of exp.bullets ?? []) {
      const score = extractScore(bullet)
      if (score) lines.push({ line: score.score, source: `经历正文：${exp.organization ?? ''}`, verified: false })
    }
  }
  const seen = new Set()
  return lines.filter((row) => {
    if (seen.has(row.line)) return false
    seen.add(row.line)
    return true
  })
}

/**
 * 生成投递信息卡。
 * @param {{profile:object, documents?:Array, experiences?:Array, versions?:Array}} input
 */
export function buildApplyCard({ profile = {}, documents = [], experiences = [], versions = [] } = {}) {
  const edu = pickEducation(experiences)
  const scanned = scanEducationFacts(experiences)
  const languages = collectLanguage({ documents, experiences })
  const activeVersion = versions.find((v) => v.is_active) ?? versions[0] ?? null
  const verifiedDocs = documents.filter((doc) => doc.verified)

  const groups = []
  const push = (key, label, fields) => groups.push({ key, label, fields })

  const field = (key, label, value, source, hint) => ({
    key,
    label,
    value: text(value),
    missing: !text(value),
    source: text(value) ? source : null,
    hint: text(value) ? null : hint ?? null,
  })

  push('basic', '基本信息', [
    field('displayName', '姓名', profile.display_name, '画像', '在「设置」填姓名'),
    field('phone', '手机号', profile.phone, '画像'),
    field('email', '邮箱', profile.email, '画像'),
    field('birthDate', '出生日期', profile.birth_date, '画像'),
    field('gender', '性别', profile.gender, '画像'),
    field('politicalStatus', '政治面貌', profile.political_status, '画像'),
    field('hometown', '籍贯', profile.hometown, '画像'),
    field('currentCity', '现居城市', profile.current_city, '画像'),
  ])

  push('education', '教育背景', [
    field('degree', '最高学历', profile.degree, '画像'),
    field('school', '学校', profile.school, '画像'),
    field('major', '专业', profile.major, '画像'),
    field('gradYear', '毕业年份', profile.grad_year, '画像'),
    field('studyPeriod', '在读起止', edu ? [edu.start_at, edu.end_at].filter(Boolean).join(' – ') : '', '素材库：教育经历', '在「素材库」补教育经历'),
    field('rank', '专业排名', profile.rank_text || scanned.rank, profile.rank_text ? '画像' : '素材库：教育经历要点'),
    field('gpa', 'GPA', profile.gpa || scanned.gpa, profile.gpa ? '画像' : '素材库：教育经历要点'),
  ])

  push('language', '语言与证书', [
    field('language', '外语成绩', languages.map((row) => row.line).join('；'), '资料库/经历正文', '在「资料库」上传四六级/托福成绩单'),
    field('certificates', '其他证书', documents.filter((doc) => ['certificate', 'patent', 'publication'].includes(doc.category)).map((doc) => doc.title).join('；'), '资料库', '在「资料库」上传专利/论文/证书文件'),
  ])

  push('intent', '求职意向', [
    field('targetRoles', '目标岗位', list(profile.target_roles), '画像'),
    field('targetIndustries', '目标行业', list(profile.target_industries), '画像'),
    field('cities', '期望城市', list(profile.cities), '画像'),
    field('availability', '可实习时间', [profile.availability_start, profile.availability_end].filter(Boolean).join(' – '), '画像'),
    field('weeklyDays', '每周出勤', profile.weekly_days ? `${profile.weekly_days} 天` : '', '画像'),
    field('internshipTypes', '实习类型', list(profile.internship_types), '画像'),
  ])

  push('skills', '技能', [field('skills', '技能', list((profile.skills ?? []).map((s) => s.name ?? s)), '画像')])

  push('attachments', '投递附件', [
    field('resume', '简历版本', activeVersion ? activeVersion.label : '', '简历库',
      '还没有简历版本：先上传或用 career_resume_build 生成'),
    field('verifiedDocs', '已确认资料', verifiedDocs.length ? `${verifiedDocs.length} 条（${verifiedDocs.map((d) => DOC_LABEL[d.category] ?? d.category).join('、')}）` : '',
      '资料库', '资料库里的条目默认「未确认」，确认后才建议写进简历'),
  ])

  const fields = groups.flatMap((group) => group.fields)
  const missing = fields.filter((f) => f.missing).map((f) => ({ key: f.key, label: f.label, hint: f.hint }))
  const filled = fields.length - missing.length

  return {
    groups,
    missing,
    completeness: { filled, total: fields.length, percent: fields.length ? Math.round((filled / fields.length) * 100) : 0 },
    note: missing.length
      ? '空白字段是「本机没有这条事实」，不是让你现编——去画像/资料库补，补完这张卡自动更新。'
      : '所有字段都有数据。投递前记得确认简历版本是最新的。',
    caveat: '界面字段名各家不同（如「毕业时间」有的要年月、有的要年份），复制后按对方表单要求微调。',
  }
}

/** 纯文本版，直接粘到网申页面。 */
export function renderApplyCardText(card) {
  const lines = []
  for (const group of card.groups) {
    const rows = group.fields.filter((f) => f.value)
    if (!rows.length) continue
    lines.push(`【${group.label}】`)
    for (const f of rows) lines.push(`${f.label}：${f.value}`)
    lines.push('')
  }
  return lines.join('\n').trim()
}
