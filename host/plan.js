// 校招作战计划：时间线推算 + 个性化行动清单 + 综合分析简报。
//
// Two hard rules live here:
//   1. The timeline is a *rule*, computed from the user's graduation year — it is not
//      a stored guess. Every window is labelled 经验节奏 and can be overridden by real
//      company events (source: official | user).
//   2. The brief never invents market facts. Anything without evidence is printed in
//      the 未知/待核实 section instead of being smoothed into a conclusion.
import { APPLICATION_LABEL, MATCH_BANDS, RECRUIT_LABEL, STATUS_LABEL } from './domain.js'
import { arr, daysBetween, parseJson, today } from './util.js'

/**
 * Conventional campus-recruiting cadence for a 毕业年份 `gradYear`.
 * These are industry-typical windows (经验值), not published facts — the brief says so
 * and real company events override them.
 */
export function seasonRuleSet(gradYear) {
  // `Number(null)` is 0, which would silently produce a 1970s timeline.
  if (gradYear === null || gradYear === undefined || gradYear === '') return null
  const g = Number(gradYear)
  if (!Number.isFinite(g) || g < 1990 || g > 2100) return null
  const pre = g - 1 // 秋招发生在毕业前一年
  const phases = [
    { key: 'summer_intern_apply', label: '暑期实习网申', season: 'summer', start: `${pre}-03-01`, end: `${pre}-05-31`, hint: '毕业前一年春季投暑期实习，转正是秋招前最好的铺垫' },
    { key: 'autumn_early', label: '秋招提前批', season: 'autumn_campus', start: `${pre}-07-01`, end: `${pre}-08-31`, hint: '提前批竞争小、流程快，很多人忽略' },
    { key: 'autumn_main', label: '秋招正式批', season: 'autumn_campus', start: `${pre}-09-01`, end: `${pre}-11-15`, hint: '网申高峰在 9 月，越晚名额越少' },
    { key: 'autumn_supplement', label: '秋招补录', season: 'autumn_campus', start: `${pre}-11-16`, end: `${g}-01-31`, hint: '补录看运气，别把它当主战场' },
    { key: 'spring_main', label: '春招补招', season: 'spring_campus', start: `${g}-03-01`, end: `${g}-04-30`, hint: '春招岗位更少，多数是补缺或中小公司' },
    { key: 'graduation_window', label: '毕业收尾窗口', season: 'spring_campus', start: `${g}-05-01`, end: `${g}-07-31`, hint: '处理毕业与入职手续，同时留意最后补录' },
  ]
  return { gradYear: g, autumnYear: pre, phases }
}

export function phaseStatus(phase, todayStr) {
  if (todayStr < phase.start) {
    return { status: 'upcoming', daysToStart: daysBetween(todayStr, phase.start), daysToEnd: daysBetween(todayStr, phase.end) }
  }
  if (todayStr > phase.end) {
    return { status: 'past', daysToStart: null, daysToEnd: daysBetween(todayStr, phase.end) }
  }
  return { status: 'current', daysToStart: 0, daysToEnd: daysBetween(todayStr, phase.end) }
}

/** Where the user stands right now, and what follows. */
export function buildTimeline(gradYear, now = today()) {
  const rules = seasonRuleSet(gradYear)
  if (!rules) return null
  const phases = rules.phases.map((phase) => ({ ...phase, ...phaseStatus(phase, now) }))
  const current = phases.find((p) => p.status === 'current') ?? null
  const next = phases.find((p) => p.status === 'upcoming') ?? null
  return {
    gradYear: rules.gradYear,
    autumnYear: rules.autumnYear,
    today: now,
    phases,
    current,
    next,
    position: current
      ? { label: current.label, daysLeft: current.daysToEnd, progress: progressOf(current, now) }
      : next
        ? { label: `尚未进入（下一阶段：${next.label}）`, daysUntil: next.daysToStart }
        : { label: '时间线已全部过去', daysUntil: null },
    caveat: '窗口按行业常规节奏推算（经验值），具体日期以各公司官方公告为准；公司级节点请用 career_event_add 登记。',
  }
}

function progressOf(phase, todayStr) {
  const span = daysBetween(phase.start, phase.end)
  if (!span || span <= 0) return 1
  const elapsed = daysBetween(phase.start, todayStr)
  return Math.max(0, Math.min(1, Number(((elapsed ?? 0) / span).toFixed(3))))
}

/**
 * The actionable plan. Every action cites the number that produced it, so the user can
 * disagree with the premise instead of with the conclusion.
 */
export function buildPlan({ profile, completeness, jobs, applications, followUps, events, now = today() }) {
  const timeline = buildTimeline(profile?.grad_year, now)
  const actions = []
  const add = (priority, title, why, how) => actions.push({ priority, title, why, how })

  if (!profile?.grad_year) {
    add(1, '先填毕业年份', '没有毕业年份就无法判断你在秋招还是春招的第几阶段。', 'career_profile_update 传 gradYear')
  }
  if ((completeness?.percent ?? 0) < 70) {
    add(1, '补齐画像', `当前完成度 ${completeness?.percent ?? 0}%，匹配和筛选都建立在画像上。`, '面板「简历与画像」补学历/时间/城市/目标')
  }
  if (!completeness?.checks?.find((c) => c.key === 'resume')?.done) {
    add(1, '导入一版简历', '没有简历就无法做 JD × 简历的缺口分析。', 'career_resume_import 传 path 或 text')
  }

  const openJobs = (jobs ?? []).filter((j) => j.status === 'OPEN')
  if (!openJobs.length) {
    add(2, '先攒岗位池', '库里没有在招岗位，任何排序都没有意义。', 'career_jobs_crawl 抓官方招聘页，或粘贴 JD')
  }

  const closingSoon = openJobs
    .filter((j) => j.deadline && daysBetween(now, j.deadline) !== null && daysBetween(now, j.deadline) >= 0 && daysBetween(now, j.deadline) <= 14)
    .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)))
  if (closingSoon.length) {
    const first = closingSoon.slice(0, 3).map((j) => `${j.company_name}·${j.title}（${j.deadline}）`).join('；')
    add(1, `本周投掉 ${closingSoon.length} 个 14 天内截止的岗位`, `这些岗位已经进入倒计时。`, first)
  }

  const appliedCount = (applications ?? []).filter((a) => ['applied', 'assessment', 'written_test', 'interview_1', 'interview_2', 'final', 'hr'].includes(a.status)).length
  const targetApplied = timeline?.current?.key === 'autumn_main' ? 12 : 5
  if (timeline?.current && appliedCount < targetApplied) {
    add(2, `把在投数量提到 ${targetApplied} 个`, `当前在流程中 ${appliedCount} 个，${timeline.current.label}阶段样本太少会放大运气。`, '从匹配分最高的岗位开始，一天投 1–2 个，边投边改简历')
  }

  if ((followUps?.overdue ?? []).length) {
    add(1, `处理 ${followUps.overdue.length} 个逾期的下一步`, '逾期说明计划落后于实际，先清理再排新计划。', '面板「投递管理 → 已投递清单」按截止排序')
  }
  if ((followUps?.stale ?? []).length) {
    add(3, `跟进 ${followUps.stale.length} 个 14 天没动静的投递`, '长期无更新要么被挂起，要么需要一次礼貌询问。', 'career_application_update 记一条备注并设下一步日期')
  }

  const upcomingEvents = (events ?? [])
    .filter((e) => e.starts_at >= now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  for (const event of upcomingEvents.slice(0, 5)) {
    add(2, `${event.company_name ? `${event.company_name}：` : ''}${event.title}`, `节点日期 ${event.starts_at}（来源：${event.source === 'official' ? '官方公布' : event.source === 'user' ? '你填写' : '经验估计'}）`, event.note || '按节点倒排准备时间')
  }

  const byBand = {}
  for (const job of jobs ?? []) {
    const band = job.band ?? null
    if (band) byBand[band] = (byBand[band] ?? 0) + 1
  }
  if ((byBand.hard_mismatch ?? 0) > 0) {
    add(3, `${byBand.hard_mismatch} 个岗位硬条件不符`, '这些不用再花时间，删掉或归档能减少干扰。', '面板岗位列表按状态筛「暂不符合硬条件」后归档')
  }

  actions.sort((a, b) => a.priority - b.priority)
  return {
    timeline,
    actions,
    readiness: {
      profilePercent: completeness?.percent ?? 0,
      hasResume: Boolean(completeness?.checks?.find((c) => c.key === 'resume')?.done),
      openJobs: openJobs.length,
      appliedCount,
      targetApplied,
      closingSoon: closingSoon.length,
    },
    caveat: '动作清单由你的画像、岗位池与在投数量推算；数字变了清单就会变，不是固定套路。',
  }
}

// ─── 综合分析简报 ────────────────────────────────────────────────────────────
const LEVEL_LABEL = { A: 'A 官方一手', B: 'B 多源印证', C: 'C 单一可溯源', D: 'D 未证实/冲突', U: 'U 信息不足' }

function groupSignals(signals) {
  const groups = { positive: [], neutral: [], negative: [] }
  for (const signal of signals ?? []) (groups[signal.direction] ??= []).push(signal)
  return groups
}

function fmtSignal(signal) {
  const level = LEVEL_LABEL[signal.evidence_level] ?? signal.evidence_level
  const horizon = signal.horizon ? `，时限 ${signal.horizon}` : ''
  const source = signal.source || '未注明来源'
  return `- [${level}${horizon}] ${signal.claim}（${source}${signal.as_of ? `，${signal.as_of}` : ''}）`
}

/**
 * Assemble the whole picture into one Markdown brief. Sections that lack data say so
 * explicitly instead of being dropped.
 * @returns {{markdown:string, missing:string[], stats:object}}
 */
export function buildBrief({ profile, completeness, plan, jobs, applications, signals, units, companies, bar, now = today() }) {
  const missing = []
  const L = []
  const push = (...lines) => L.push(...lines)

  push(`# 求职作战计划 · ${now}`, '')
  push('> 本简报由本机数据自动汇总。**时间窗口是行业常规节奏（经验值）**，具体以公司官方公告为准；', '> 市场与前景部分逐条标注证据等级，没有证据的内容会列在「未知与待核实」，不会当成结论。', '')

  // 1. 结论摘要
  const readiness = plan?.readiness ?? {}
  push('## 一、现在该做什么（结论）', '')
  if (plan?.timeline?.current) {
    push(`- **当前阶段：${plan.timeline.current.label}**，还剩 ${plan.timeline.current.daysToEnd} 天。`)
  } else if (plan?.timeline?.next) {
    push(`- 尚未进入任何招聘窗口；下一阶段 **${plan.timeline.next.label}**，还有 ${plan.timeline.next.daysToStart} 天。`)
  } else {
    push('- 时间线已全部过去，请核对毕业年份是否正确。')
    missing.push('毕业年份可能填错（时间线已全部过去）')
  }
  const top = (plan?.actions ?? []).slice(0, 3)
  if (top.length) {
    push('', '按优先级取前三件事：')
    top.forEach((action, i) => push(`${i + 1}. **${action.title}** — ${action.why}`))
  } else {
    push('- 暂无待办：若你确实已经投满，可把注意力转到笔试/面试准备。')
  }
  push('')

  // 2. 时间线
  push('## 二、春招秋招时间线', '')
  if (plan?.timeline) {
    push(`以你 **${plan.timeline.gradYear} 届** 毕业推算，秋招年份为 **${plan.timeline.autumnYear}**。`, '')
    push('| 阶段 | 窗口 | 状态 |', '| --- | --- | --- |')
    for (const phase of plan.timeline.phases) {
      const status = phase.status === 'current' ? '**进行中**' : phase.status === 'past' ? '已过' : `还有 ${phase.daysToStart} 天`
      push(`| ${phase.label} | ${phase.start} ~ ${phase.end} | ${status} |`)
    }
    push('')
    if (plan.timeline.current?.hint) push(`> ${plan.timeline.current.label}：${plan.timeline.current.hint}`, '')
  } else {
    push('- 缺少毕业年份，无法推算时间线。')
    missing.push('毕业年份')
  }

  // 3. 个人情况与意愿
  push('## 三、你的情况与求职意愿', '')
  if (profile) {
    push(`- 学历：${[profile.school, profile.degree, profile.major].filter(Boolean).join(' · ') || '未填'}`)
    push(`- 可实习：${profile.availability_start ?? '未填'} 起，每周 ${profile.weekly_days ?? '未填'} 天`)
    push(`- 目标城市：${arr(profile.cities).join('、') || '未填'}｜目标岗位：${arr(profile.target_roles).join('、') || '未填'}`)
    push(`- 目标行业：${arr(profile.target_industries).join('、') || '未填'}｜排除：${arr(profile.excluded).join('、') || '无'}`)
    push(`- 画像完成度：**${completeness?.percent ?? 0}%**`)
    for (const gap of (completeness?.checks ?? []).filter((c) => !c.done)) missing.push(`画像缺：${gap.label}`)
  } else {
    missing.push('求职画像')
    push('- 还没有画像。')
  }
  push('')

  // 4. 岗位池
  push('## 四、岗位池与优先级', '')
  const jobList = (jobs ?? []).filter((j) => !j.archived)
  if (!jobList.length) {
    missing.push('岗位池（为空）')
    push('- 库里还没有岗位。先抓官方招聘页或粘贴 JD。')
  } else {
    const scored = jobList.filter((j) => j.match_score !== null && j.match_score !== undefined).sort((a, b) => b.match_score - a.match_score)
    push(`共 ${jobList.length} 个岗位，其中 ${scored.length} 个已评分。按匹配分取前 8：`, '')
    push('| 岗位 | 地点 | 类型 | 状态 | 匹配分 | 截止 | 投递地址 |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const job of scored.slice(0, 8)) {
      const url = job.apply_url || ''
      push(`| ${job.company_name} · ${job.title} | ${job.location ?? '—'} | ${RECRUIT_LABEL[job.recruit_type] ?? job.internship_type ?? '—'} | ${STATUS_LABEL[job.status] ?? job.status} | ${job.match_score} | ${job.deadline ?? '—'} | ${url ? '有' : '缺'} |`)
    }
    if (!scored.length) {
      push('- 还没有评分：运行 career_match_rank。')
      missing.push('岗位匹配评分')
    }
    const noUrl = jobList.filter((j) => !j.apply_url).length
    if (noUrl) missing.push(`${noUrl} 个岗位缺少投递地址`)
  }
  push('')

  // 5. 招聘门槛
  push('## 五、招聘门槛（Bar）', '')
  if (bar && (bar.hard?.length || bar.preferred?.length || bar.observed?.length || bar.unverified?.length)) {
    push(`- 官方硬性要求 ${bar.hard?.length ?? 0} 条，官方加分项 ${bar.preferred?.length ?? 0} 条`)
    push(`- 公开经验规律 ${bar.observed?.length ?? 0} 条，未经证实 ${bar.unverified?.length ?? 0} 条`)
    for (const item of (bar.hard ?? []).slice(0, 5)) push(`  - 【硬性】${item.text}`)
    for (const item of (bar.observed ?? []).slice(0, 3)) push(`  - 【经验】${item.text}`)
    push('')
    push('> 经验规律来自公开自述，有样本偏差；不能当绝对门槛，也不构成录取概率。')
  } else {
    missing.push('招聘门槛数据（hard/preferred/observed 均空）')
    push('- 还没有门槛数据。用 career_bar_analyze 或 career_forum_import 导入面经后汇总。')
  }
  push('')

  // 6. 市场与行业前景
  push('## 六、市场与行业前景', '')
  if ((signals ?? []).length) {
    const groups = groupSignals(signals)
    const label = { positive: '偏正面', neutral: '中性/待观察', negative: '偏负面' }
    for (const key of ['positive', 'neutral', 'negative']) {
      if (!groups[key]?.length) continue
      push(`**${label[key]}**`, '')
      for (const signal of groups[key].slice(0, 8)) push(fmtSignal(signal))
      push('')
    }
    push(`> 以上 ${signals.length} 条信号按证据等级标注，A/B 才可作为结论依据，C 仅供参考，D/U 需标注为不确定。`)
  } else {
    missing.push('市场与行业前景信号（一条都没有）')
    push('- 还没有任何市场信号。让 Agent 用 career_outlook_add 逐条登记（要求带来源与日期），或先做一次行业检索。')
  }
  push('')

  // 7. 业务部门
  push('## 七、业务部门与成长', '')
  if ((units ?? []).length) {
    for (const unit of units.slice(0, 12)) {
      push(`- **${unit.name}**${unit.business ? `（${unit.business}）` : ''} · 定位：${unit.strategic_role ?? '未知'}${unit.data_as_of ? ` · 数据时点 ${unit.data_as_of}` : ''}`)
      const signalsForUnit = (signals ?? []).filter((s) => s.unit_id === unit.id)
      for (const signal of signalsForUnit.slice(0, 3)) push(`  - ${fmtSignal(signal)}`)
      const growth = parseJson(unit.growth_signals, [])
      for (const item of growth.slice(0, 3)) push(`  - 增长信号：${item?.claim ?? item}`)
      const risks = parseJson(unit.risks, [])
      for (const item of risks.slice(0, 3)) push(`  - 风险：${item?.claim ?? item}`)
    }
  } else {
    missing.push('业务部门档案（company_unit 为空）')
    push('- 还没有部门档案。岗位写在哪个部门、这个部门是不是核心，需要用 career_unit_upsert 记录。')
  }
  push('')

  // 8. 风险与未知
  push('## 八、未知与待核实', '')
  if (missing.length) for (const item of [...new Set(missing)]) push(`- ${item}`)
  else push('- 暂无结构性缺口。')
  push('')
  push('## 九、未来 4 周动作', '')
  const fourWeeks = (plan?.actions ?? []).slice(0, 6)
  if (fourWeeks.length) {
    fourWeeks.forEach((action, i) => push(`${i + 1}. **${action.title}**（优先级 ${action.priority}）`, `   - 为什么：${action.why}`, `   - 怎么做：${action.how}`))
  } else {
    push('- 暂无。')
  }
  push('')
  push('---', `数据时点：${now}｜岗位 ${(jobs ?? []).length} 个｜投递 ${(applications ?? []).length} 条｜市场信号 ${(signals ?? []).length} 条｜部门 ${(units ?? []).length} 个`)

  return {
    markdown: L.join('\n'),
    missing: [...new Set(missing)],
    stats: {
      jobs: (jobs ?? []).length,
      applications: (applications ?? []).length,
      signals: (signals ?? []).length,
      units: (units ?? []).length,
    },
  }
}

export { APPLICATION_LABEL, MATCH_BANDS }
