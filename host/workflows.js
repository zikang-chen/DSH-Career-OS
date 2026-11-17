// 高层任务工作流：把「几十个原子工具」收敛成「三个常用任务」。
//
// Agent 不应该每次都要手工组合 career_profile_get + career_job_search + career_match_rank +
// career_funnel + career_resume_build + career_resume_quality 才能回答一个普通问题。
// 这里只做**编排**：调用已有的纯函数，不复制业务逻辑，也不绕过任何安全检查。
import { analyzeMatch } from './domain.js'
import { computeFunnel } from './funnel.js'
import { planTailor } from './tailor.js'
import { checkResumeQuality } from './quality.js'
import { analyzeBullets } from './resume_skills.js'

/** 判断 JD 完整性：有正文才算完整，只有标题/地点算「仅列表摘要」。 */
export function jdCompleteness(job = {}) {
  const hasDesc = Boolean(String(job.description ?? '').trim())
  const hasReq = Boolean(String(job.requirements ?? '').trim())
  if (hasDesc && hasReq) return { level: 'complete', label: '完整 JD' }
  if (hasDesc || hasReq) return { level: 'partial', label: '部分 JD' }
  if (job.apply_url || job.url) return { level: 'summary-only', label: '仅列表摘要（有详情入口）' }
  return { level: 'missing', label: 'JD 缺失' }
}

/**
 * 「帮我找适合的岗位」。
 * @param {{profile:object, jobs:Array, limit?:number}} input
 */
export function findJobsForMe({ profile, jobs = [], limit = 10 } = {}) {
  if (!profile) return { ok: false, error: '还没有画像，无法匹配（先填画像）' }
  if (!jobs.length) return { ok: true, count: 0, recommendations: [], note: '岗位库是空的：先去「岗位雷达」抓或粘 JD。' }

  const scored = jobs.map((job) => {
    const match = analyzeMatch(profile, job)
    return {
      job,
      match,
      completeness: jdCompleteness(job),
    }
  })

  // 排序：硬性不符的沉底；其余按分数；同分时 JD 更完整的靠前。
  const order = { complete: 0, partial: 1, 'summary-only': 2, missing: 3 }
  scored.sort((a, b) => {
    const aHard = a.match.band === 'hard_mismatch' ? 1 : 0
    const bHard = b.match.band === 'hard_mismatch' ? 1 : 0
    if (aHard !== bHard) return aHard - bHard
    if (b.match.score !== a.match.score) return b.match.score - a.match.score
    return (order[a.completeness.level] ?? 9) - (order[b.completeness.level] ?? 9)
  })

  const recommendations = scored.slice(0, Math.min(limit, 50)).map(({ job, match, completeness }) => ({
    id: job.id,
    company: job.company_name,
    title: job.title,
    location: job.location,
    status: job.status,
    matchScore: match.score,
    band: match.band,
    bandLabel: match.bandLabel,
    jd: completeness.label,
    reasons: {
      matched: (match.reasons?.matched ?? []).slice(0, 4),
      missing: (match.reasons?.missing ?? []).slice(0, 4),
      unknown: (match.reasons?.unknown ?? []).slice(0, 3),
    },
    hardBlocks: match.hardBlocks ?? [],
  }))

  const incomplete = scored.filter((s) => s.completeness.level !== 'complete').length
  return {
    ok: true,
    considered: scored.length,
    count: recommendations.length,
    recommendations,
    caveats: [
      '匹配分反映的是「与你的偏好契合度」，不是录用概率。',
      incomplete ? `${incomplete} 个岗位 JD 不完整（只有列表摘要），匹配结论可能偏保守。` : null,
    ].filter(Boolean),
  }
}

/**
 * 「我的投递进展怎么样」。
 */
export function summarizeApplications({ applications = [], events = [], now } = {}) {
  const funnel = computeFunnel({ applications, events, now })
  const active = applications.filter((a) => !['rejected', 'closed', 'withdrawn', 'offer'].includes(a.status))
  const today = String(now ?? new Date().toISOString()).slice(0, 10)
  const needsAction = applications
    .filter((a) => !['rejected', 'closed', 'withdrawn', 'offer'].includes(a.status))
    .map((a) => {
      const due = a.next_action_at ? String(a.next_action_at).slice(0, 10) : null
      const overdue = due ? due <= today : false
      const stale = ['applied', 'assessment', 'written_test'].includes(a.status)
        ? Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${String(a.applied_at ?? a.created_at ?? today).slice(0, 10)}T00:00:00Z`)) / 86400000) >= 14
        : false
      return { id: a.id, company: a.company_name, title: a.job_title, status: a.status, nextAction: a.next_action ?? null, nextActionAt: due, overdue, stale }
    })
    .filter((row) => row.overdue || row.stale || row.nextAction)

  return {
    ok: true,
    total: applications.length,
    active: active.length,
    funnel: { submitted: funnel.submitted, stages: funnel.stages, choke: funnel.choke, caveat: funnel.caveat },
    needsAction: needsAction.slice(0, 30),
    note: needsAction.length ? '这些投递有下一步或已停滞，建议优先处理。' : '目前没有需要立刻处理的投递。',
  }
}

/**
 * 「为这个岗位准备简历」：只出方案与缺口，不生成事实。
 */
export function prepResumeForJob({ profile, experiences = [], documents = [], job, maxEntries = 6, bulletsPerEntry = 3 } = {}) {
  if (!job) return { ok: false, error: '没有目标岗位' }
  const completeness = jdCompleteness(job)
  const plan = planTailor({ experiences, job, maxEntries, bulletsPerEntry })
  const quality = checkResumeQuality({ profile, experiences, documents, job })
  // 简历优化 skill：对挑中的要点做诊断（不新造内容）
  const skillAdvice = analyzeBullets({
    bullets: plan.selected.flatMap((s) => s.bullets ?? []),
    jdText: [job.description, job.requirements].filter(Boolean).join('\n'),
  })
  return {
    ok: true,
    job: { id: job.id, company: job.company_name, title: job.title },
    jdCompleteness: completeness,
    // JD 不完整时，匹配与缺口都不该被当成确定结论
    caveat: completeness.level === 'complete'
      ? null
      : '这个岗位 JD 不完整，仅凭标题/摘要做的挑选与缺口判断可能失真，建议先补 JD 再定稿。',
    selection: {
      keep: plan.selected.map((s) => ({ id: s.experienceId, organization: s.organization, role: s.role, bullets: s.bullets.length })),
      drop: plan.omitted.map((o) => ({ id: o.experienceId, organization: o.organization, reason: o.reason })),
    },
    gaps: plan.gaps,
    quality: { summary: quality.summary, issues: quality.issues },
    skillAdvice: { summary: skillAdvice.summary, perBullet: skillAdvice.perBullet, jdCoverage: skillAdvice.jdCoverage, skills: skillAdvice.skills.map((s) => s.name) },
    next: '只挑选与排序，没有编造任何内容。确认后再调用 career_resume_build 出稿并编译 PDF。',
  }
}
