// 投递漏斗：求职复盘唯一硬指标是「哪一关在漏人」，不是「投了多少家」。
//
// 口径说明（重要，避免误读）：
//   - 阶段按国内校招常规划分，不同公司叫法不同（测评/笔试、群面/一面…）；
//   - 只统计「真的投出去了」的记录（applied_at 有值，或状态历史里出现过 applied）；
//   - 到达率取「该投递达到过的最高阶段」，所以被拒不影响它曾经到过第几关；
//   - 样本小的时候转化率极不稳定，n<10 时不要拿它下结论。

export const FUNNEL_STAGES = [
  { key: 'applied', label: '投递', statuses: ['applied'] },
  { key: 'assessment', label: '测评/笔试', statuses: ['assessment', 'written_test'] },
  { key: 'interview_1', label: '一面', statuses: ['interview_1'] },
  { key: 'interview_2', label: '二面', statuses: ['interview_2'] },
  { key: 'final', label: '终面/HR', statuses: ['final', 'hr'] },
  { key: 'offer', label: 'Offer', statuses: ['offer'] },
]

const STAGE_OF = new Map()
FUNNEL_STAGES.forEach((stage, index) => {
  for (const status of stage.statuses) STAGE_OF.set(status, index)
})

/** 投递前状态：这些不算「投出去」。 */
const PRE_SUBMIT = new Set(['saved', 'researching', 'resume_todo', 'ready'])

export function stageIndexOf(status) {
  return STAGE_OF.has(String(status)) ? STAGE_OF.get(String(status)) : -1
}

/** 这条投递走到过的最高阶段（当前状态与历史状态取最大）。 */
export function maxStageOf(application, events = []) {
  let best = stageIndexOf(application.status)
  for (const event of events) {
    const index = stageIndexOf(event.to_status)
    if (index > best) best = index
  }
  return best
}

/** 是否真的投出去了。 */
export function isSubmitted(application, events = []) {
  if (application.applied_at) return true
  if (PRE_SUBMIT.has(String(application.status))) return false
  if (stageIndexOf(application.status) >= 0) return true
  return events.some((event) => event.to_status === 'applied')
}

function rate(numerator, denominator) {
  if (!denominator) return null
  return Number(((numerator / denominator) * 100).toFixed(1))
}

/**
 * @param {{applications:Array, events:Array, now?:string}} input
 */
export function computeFunnel({ applications = [], events = [], now = new Date().toISOString() } = {}) {
  const byApplication = new Map()
  for (const event of events) {
    if (!event.application_id) continue
    if (!byApplication.has(event.application_id)) byApplication.set(event.application_id, [])
    byApplication.get(event.application_id).push(event)
  }

  const submitted = []
  for (const app of applications) {
    const own = byApplication.get(app.id) ?? []
    if (!isSubmitted(app, own)) continue
    submitted.push({ app, maxStage: maxStageOf(app, own), events: own })
  }

  const total = submitted.length
  const counts = FUNNEL_STAGES.map((_, index) => submitted.filter((row) => row.maxStage >= index).length)

  const stages = FUNNEL_STAGES.map((stage, index) => ({
    key: stage.key,
    label: stage.label,
    count: counts[index],
    // 相对上一阶段的留存：这一关过了多少人
    passRate: index === 0 ? null : rate(counts[index], counts[index - 1]),
    // 相对总投递的到达率
    reachRate: rate(counts[index], total),
  }))

  // 卡点：相邻两关之间流失最多的一跳，直接告诉人「问题出在简历还是面试」。
  // 没有任何投递时不报卡点——空管道不存在「卡在哪一关」。
  let choke = null
  if (total > 0) {
    for (let index = 1; index < stages.length; index += 1) {
      const dropped = counts[index - 1] - counts[index]
      if (!choke || dropped > choke.dropped) {
        choke = {
          from: stages[index - 1].label,
          to: stages[index].label,
          dropped,
          passRate: stages[index].passRate,
        }
      }
    }
  }

  const byChannelMap = new Map()
  for (const row of submitted) {
    const channel = row.app.channel || '未填写'
    if (!byChannelMap.has(channel)) byChannelMap.set(channel, { channel, submitted: 0, interviews: 0, offers: 0 })
    const bucket = byChannelMap.get(channel)
    bucket.submitted += 1
    if (row.maxStage >= 2) bucket.interviews += 1
    if (row.maxStage >= 5) bucket.offers += 1
  }
  const byChannel = [...byChannelMap.values()]
    .map((bucket) => ({
      ...bucket,
      interviewRate: rate(bucket.interviews, bucket.submitted),
      offerRate: rate(bucket.offers, bucket.submitted),
    }))
    .sort((a, b) => b.submitted - a.submitted)

  const rejected = submitted.filter((row) => row.app.status === 'rejected').length
  const withdrawn = submitted.filter((row) => ['withdrawn', 'closed'].includes(row.app.status)).length
  const todayStr = String(now).slice(0, 10)
  const stalled = submitted
    .filter((row) => ['applied', 'assessment', 'written_test'].includes(row.app.status))
    .map((row) => {
      const since = String(row.app.applied_at ?? row.app.created_at ?? '').slice(0, 10)
      const days = since && /^\d{4}-\d{2}-\d{2}$/.test(since)
        ? Math.round((new Date(`${todayStr}T00:00:00Z`) - new Date(`${since}T00:00:00Z`)) / 86400000)
        : null
      return { id: row.app.id, company: row.app.company_name, title: row.app.job_title, status: row.app.status, days }
    })
    .filter((row) => row.days !== null && row.days >= 14)
    .sort((a, b) => b.days - a.days)

  return {
    submitted: total,
    beforeSubmit: applications.length - total,
    stages,
    choke,
    rejected,
    withdrawn,
    inPipeline: submitted.filter((row) => !['offer', 'rejected', 'closed', 'withdrawn'].includes(row.app.status)).length,
    stalled,
    byChannel,
    caveat: total < 10
      ? `样本只有 ${total} 条，转化率不稳定，先攒到 10 条以上再据此调整策略。`
      : '阶段划分是常规口径；只有你记录过的状态才会被计入，漏记会让漏斗偏低。',
    basis: '按「达到过的最高阶段」统计，被拒不影响它曾经到过第几关。',
  }
}
