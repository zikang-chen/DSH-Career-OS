// Side-by-side job comparison: per-field values, never a single blended score.
import {assessJob360} from './assessment.js'
import {withJobListEvidence} from './job-list-evidence.js'

const DISPLAY = { verified_open: '已核验开放', verified_closed: '已核验关闭', verified_upcoming: '尚未开始', stale: '信息已过期', 'open-unverified': '可能开放·待核验', unknown: '状态未知' }
const text = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim())

export function compareJobs(repos, { ids = [], profile = null } = {}) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].slice(0, 5)
  if (unique.length < 2) return { ok: false, error: '至少选择 2 个岗位进行对比（最多 5 个）' }
  const rows = withJobListEvidence(repos, unique.map((id) => repos.jobs.getJob(id)).filter(Boolean))
  if (rows.length < 2) return { ok: false, error: '所选岗位中不足 2 个有效记录' }
  const jobs = rows.map((job) => {
    const a = assessJob360({ job, profile })
    return {
      id: job.id, company: job.company_name, title: job.title, location: job.location,
      recruitType: job.recruit_type, deadline: job.deadline, salaryText: text(job.salary_text),
      gradeLimit: text(job.grade_limit), daysPerWeek: job.days_per_week ?? null, duration: text(job.duration),
      applyUrl: job.apply_url ?? null,
      statusDisplay: DISPLAY[a.evidence.statusAssessment] ?? '待核验',
      verifiedOpen: a.evidence.verifiedOpen, textComplete: a.evidence.textComplete,
      fitScore: a.fit.score, fitReliable: a.fit.reliable,
      reasons: a.decision.reasons.slice(0, 3), risks: a.decision.risks.slice(0, 3), unknowns: a.unknowns.slice(0, 3),
    }
  })
  const fields = [
    ['company', '公司'], ['title', '岗位'], ['location', '城市'], ['recruitType', '招聘类型'],
    ['statusDisplay', '招聘状态'], ['deadline', '截止'], ['salaryText', '薪酬'], ['gradeLimit', '学历/届别'],
    ['daysPerWeek', '每周出勤'], ['duration', '实习时长'], ['textComplete', 'JD 文字完整'], ['fitScore', '匹配分'],
  ]
  const differences = fields.map(([key, label]) => {
    const values = jobs.map((j) => j[key])
    const known = values.filter((v) => v !== null && v !== undefined && v !== '' && v !== false)
    const distinct = new Set(values.map((v) => JSON.stringify(v ?? null)))
    return { key, label, values, differs: distinct.size > 1, unknownCount: values.filter((v) => v === null || v === undefined || v === '').length, knownCount: known.length }
  })
  return {
    ok: true,
    jobs,
    differences,
    unknownFields: differences.filter((d) => d.unknownCount === jobs.length).map((d) => d.label),
    caveats: [
      '逐字段对比，不给总分排名；匹配分只表示与已提供材料的偏好相符度，不是录用概率。',
      'JD 不完整或匹配不可靠时，该列分数不可作为决策依据。',
      '薪酬、截止等未知表示记录里没有，不代表企业没提供。',
    ],
  }
}
