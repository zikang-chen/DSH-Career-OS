// Application calendar: deterministic grouping of known dates. Missing dates are skipped, never guessed.
const DAY = 86400000
const dateOnly = (value) => {
  const text = String(value ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null
}
const shanghaiToday = (now) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)) } catch { return String(now).slice(0, 10) }
}

export function buildApplicationCalendar({ applications = [], now = new Date().toISOString(), days = 30 } = {}) {
  const today = shanghaiToday(now)
  const todayMs = Date.parse(`${today}T00:00:00+08:00`)
  const horizon = Math.max(1, Math.min(120, Number(days) || 30))
  const buckets = new Map()
  const overdue = []
  const undated = []
  const push = (date, item) => {
    if (!buckets.has(date)) buckets.set(date, [])
    buckets.get(date).push(item)
  }
  for (const app of applications) {
    const base = { id: app.id, company: app.company_name ?? null, jobTitle: app.job_title ?? null, status: app.status ?? null, jobId: app.job_id ?? null }
    const events = [
      ['deadline', dateOnly(app.deadline), '投递截止'],
      ['nextAction', dateOnly(app.next_action_at), app.next_action || '计划跟进'],
      ['applied', dateOnly(app.applied_at), '已投递'],
    ]
    let dated = false
    for (const [kind, date, label] of events) {
      if (!date) continue
      dated = true
      const ms = Date.parse(`${date}T00:00:00+08:00`)
      if (kind === 'nextAction' && ms < todayMs) { overdue.push({ ...base, kind, date, label }); continue }
      if (ms > todayMs + horizon * DAY) continue
      push(date, { ...base, kind, label })
    }
    if (!dated) undated.push(base)
  }
  const daysSorted = [...buckets.keys()].sort()
  return {
    ok: true,
    today,
    horizonDays: horizon,
    days: daysSorted.map((date) => ({ date, items: buckets.get(date).sort((a, b) => a.kind.localeCompare(b.kind)) })),
    overdue,
    undated,
    caveats: [
      '只显示记录里已有的日期；缺失不推断。',
      '截止日期来自岗位记录，仍需回到官方页面核实。',
      '逾期仅表示你自己设置的跟进日已过，不代表招聘方有回复。',
    ],
  }
}
