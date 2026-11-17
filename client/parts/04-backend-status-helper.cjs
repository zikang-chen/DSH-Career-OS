// ─── backend status helper ───────────────────────────────────────────────────
function useBackend() {
  const [state, setState] = useState({ ok: null, error: null, busy: false })
  const call = useCallback(async (fn) => {
    setState((s) => ({ ...s, busy: true }))
    try {
      const result = await fn()
      setState({ ok: true, error: null, busy: false })
      return result
    } catch (err) {
      setState({ ok: false, error: err.message, busy: false })
      throw err
    }
  }, [])
  return { ...state, call, setError: (error) => setState({ ok: false, error, busy: false }) }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tabs
// ═════════════════════════════════════════════════════════════════════════════

function OverviewTab({ bootstrap, onNavigate, onRefresh }) {
  // 推荐机会：调后端的匹配排序（硬条件过滤 + 六维加权），不是按入库时间凑数
  const [recs, setRecs] = useState(null)
  useEffect(() => {
    let alive = true
    apiPost('/match/rank', {}).then((r) => { if (alive) setRecs(r) }).catch(() => { if (alive) setRecs(null) })
    return () => { alive = false }
  }, [])
  if (!bootstrap) return h(Loading)
  // `/bootstrap` nests jobStats / applicationStats / unreadNotifications inside
  // `digest`, and any of them can be missing on a partial payload. Read defensively:
  // an undefined read here used to throw and take the whole panel down.
  const dig = bootstrap.digest ?? {}
  const jobStats = dig.jobStats ?? {}
  const applicationStats = dig.applicationStats ?? {}
  const closing = dig.closing ?? []
  const newlyFound = dig.newlyFound ?? []
  const follow = dig.followUps ?? {}
  const completeness = bootstrap.completeness ?? { checks: [], done: 0, total: 0, percent: 0 }
  const checks = completeness.checks ?? []
  const done = completeness.done ?? 0
  const total = completeness.total ?? 0
  const percent = completeness.percent ?? 0
  const notifications = bootstrap.notifications ?? []
  const status = bootstrap.status ?? {}
  const db = status.db ?? {}
  const activeResume = bootstrap.activeResume ?? null
  const focus = bootstrap.focus ?? null
  const cards = [
    { label: '在库岗位', value: jobStats.total ?? 0, hint: '只统计本机数据库' },
    { label: '官方确认在招', value: (jobStats.byStatus ?? {}).OPEN ?? 0, hint: '需近期核验过' },
    { label: '待核验', value: (jobStats.byStatus ?? {}).UNVERIFIED ?? 0, hint: '来自第三方线索' },
    { label: '数据过期', value: (jobStats.byStatus ?? {}).STALE ?? 0, hint: '超期需重新核验' },
    { label: '投递记录', value: applicationStats.total ?? 0, hint: '含全部阶段' },
    { label: '未读提醒', value: dig.unreadNotifications ?? 0, hint: '来自监控规则' },
  ]
  return h('div', { style: S.col },
    focus && focus.note ? h('div', { style: { ...S.cardTight, borderColor: T.accent, background: 'rgba(37,99,235,0.06)' } },
      h('div', { style: { ...S.body, fontWeight: 550 } }, `Agent 提示：${focus.note}`),
      focus.code ? h('div', { style: S.mono }, `聚焦对象 ${focus.code}`) : null) : null,

    h('div', { style: S.grid(170) }, cards.map((c) => h('div', { key: c.label, style: S.card },
      h('div', { style: { ...S.muted, fontSize: 11.5 } }, c.label),
      h('div', { style: { fontSize: 22, fontWeight: 700, color: T.text, margin: '2px 0' } }, String(c.value ?? 0)),
      h('div', { style: { ...S.muted, fontSize: 11 } }, c.hint)))),

    // 行动入口：首页不是统计报表，每个按钮都要能立刻去做事
    h('div', { style: S.card },
      h('div', { style: S.h2 }, '开始做事'),
      h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 8 } },
        h(Btn, { kind: 'primary', onClick: () => onNavigate('radar') }, '找岗位'),
        h(Btn, { onClick: () => onNavigate('tracker') }, '看投递'),
        h(Btn, { onClick: () => onNavigate('resume') }, '改简历'),
        h(Btn, { onClick: () => onNavigate('plan') }, '看计划'),
        h(Btn, { kind: 'ghost', onClick: () => onNavigate('settings') }, '数据源与监控'))),

    // 推荐机会：按匹配度排序，四要素分开显示，不把「匹配度」和「在招状态」混为一谈
    h('div', { style: S.card },
      h('div', { style: { ...S.row, justifyContent: 'space-between' } },
        h('div', { style: S.h2 }, '推荐机会（按匹配度）'),
        h(Btn, { kind: 'ghost', onClick: () => onNavigate('radar') }, '去岗位雷达')),
      h('div', { style: { ...S.muted, marginTop: 4 } },
        '匹配度 = 与你的偏好的契合度，不是录用概率；在招状态与核验时间是另一回事，分开看。'),
      recs?.top?.length
        ? h('div', { style: S.col },
          recs.top.filter((r) => r.band !== 'hard_mismatch').slice(0, 5).map((r) => h('div', {
            key: r.id, style: { ...S.cardTight, cursor: 'pointer' }, onClick: () => onNavigate('radar'),
          },
            h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 8 } },
              h('span', { style: { ...S.body, fontWeight: 600 } }, `${r.company} · ${r.title}`),
              h(Chip, { tone: r.score >= 80 ? 'success' : r.score >= 65 ? 'accent' : undefined }, `匹配 ${r.score}`)),
            h('div', { style: { ...S.muted, fontSize: 11 } }, r.bandLabel || r.band))))
        : h('div', { style: S.muted }, recs ? '还没有可推荐的岗位（先抓岗位或补画像）。' : '正在计算匹配…')),

    h('div', { style: S.grid(300) },
      h('div', { style: S.card },
        h('div', { style: S.h2 }, '引导完成度'),
        h('div', { style: { ...S.row, justifyContent: 'space-between', marginBottom: 6 } },
          h('span', { style: S.body }, `${done}/${total}`),
          h(Chip, { tone: percent >= 70 ? 'success' : 'warn' }, `${percent}%`)),
        h(Bar, { value: percent, tone: percent >= 70 ? T.success : T.warn }),
        h('div', { style: { ...S.col, gap: 4, marginTop: 10 } },
          checks.map((c) => h('div', { key: c.key, style: { ...S.row, gap: 6, ...S.muted } },
            h('span', { style: { color: c.done ? T.success : T.muted, width: 12 } }, c.done ? '✓' : '○'),
            h('span', null, c.label)))),
        percent < 100
          ? h('div', { style: { marginTop: 10 } }, h(Btn, { kind: 'primary', onClick: () => onNavigate('resume') }, '去完善画像'))
          : null),

      h('div', { style: S.card },
        h('div', { style: S.h2 }, '今日待办'),
        (closing.length || follow.overdue || follow.interviews)
          ? h('div', { style: S.col },
            follow.overdue ? h('div', { style: S.row },
              h(Chip, { tone: 'warn' }, '逾期'), h('span', { style: S.body }, `${follow.overdue} 个投递待跟进`)) : null,
            follow.interviews ? h('div', { style: S.row },
              h(Chip, { tone: 'accent' }, '面试'), h('span', { style: S.body }, `${follow.interviews} 个岗位进入面试阶段`)) : null,
            closing.slice(0, 5).map((job) => h('div', { key: job.id, style: { ...S.row, justifyContent: 'space-between', gap: 6 } },
              h('span', { style: { ...S.body, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${job.company_name} · ${job.title}`),
              h(Chip, { tone: job.daysLeft <= 2 ? 'error' : 'warn' }, `${job.daysLeft} 天`))))
          : h('div', { style: S.muted }, '暂无紧急事项。'),

        h('div', { style: { ...S.h2, marginTop: 14 } }, '最近发现的岗位'),
        newlyFound.length
          ? h('div', { style: S.col }, newlyFound.slice(0, 5).map((j) => h('div', { key: j.id, style: { ...S.row, justifyContent: 'space-between', gap: 6 } },
            h('span', { style: { ...S.body, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${j.company_name} · ${j.title}`),
            h(Chip, null, j.location || '地点未知'))))
          : h('div', { style: S.muted }, '还没有新岗位。去「岗位雷达」粘贴 JD，或在「设置」登记官方招聘页。')),

      h('div', { style: S.card },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: S.h2 }, '提醒'),
          h(Btn, { kind: 'ghost', onClick: onRefresh }, '刷新')),
        notifications.length
          ? h('div', { style: S.col }, notifications.slice(0, 8).map((n) => h('div', { key: n.id, style: S.cardTight },
            h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 6 } },
              h('span', { style: { ...S.body, fontWeight: 600 } }, n.title),
              h(Chip, { tone: n.severity === 'high' ? 'error' : n.severity === 'low' ? undefined : 'warn' }, relTime(n.created_at))),
            n.body ? h('div', { style: { ...S.muted, marginTop: 4, whiteSpace: 'pre-wrap' } }, n.body) : null,
            n.action ? h('div', { style: { ...S.muted, marginTop: 4, color: T.accent } }, `建议：${n.action}`) : null)))
          : h('div', { style: S.muted }, '暂无提醒。监控规则触发后会出现在这里。')),

      h('div', { style: S.card },
        h('div', { style: S.h2 }, '系统状态'),
        h('div', { style: { ...S.col, gap: 5 } },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } }, h('span', { style: S.muted }, '数据库'), h('span', { style: S.mono }, `schema v${db.schemaVersion ?? '?'} · ${db.ftsMode ?? '?'}`)),
          h('div', { style: { ...S.row, justifyContent: 'space-between' } }, h('span', { style: S.muted }, '数据目录'), h('span', { style: { ...S.mono, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, status.dataDir)),
          h('div', { style: { ...S.row, justifyContent: 'space-between' } }, h('span', { style: S.muted }, '定时监控'), h(Chip, { tone: status.scheduleEnabled ? 'success' : undefined }, status.scheduleEnabled ? '已开启' : '关闭（手动触发）')),
          h('div', { style: { ...S.row, justifyContent: 'space-between' } }, h('span', { style: S.muted }, '当前简历'), h('span', { style: S.body }, activeResume ? activeResume.label : '未导入')))),
    ))
}
