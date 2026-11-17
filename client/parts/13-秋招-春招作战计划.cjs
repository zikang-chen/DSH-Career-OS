// ─── 秋招 / 春招作战计划 ─────────────────────────────────────────────────────
function PlanTab({ onChanged }) {
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState(null)
  const [brief, setBrief] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ title: '', startsAt: '', company: '', source: 'official' })

  const load = useCallback(() => {
    apiGet('/plan').then(setPlan).catch((err) => setError(err.message))
  }, [])
  useEffect(load, [load])

  const makeBrief = () => {
    setBusy(true)
    setError(null)
    apiPost('/plan/brief', {})
      .then((res) => { setBrief(res); onChanged?.() })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false))
  }

  const addEvent = () => {
    if (!draft.title.trim() || !draft.startsAt) {
      setError('节点需要标题与日期')
      return
    }
    apiPost('/event', {
      title: draft.title.trim(),
      startsAt: draft.startsAt,
      company: draft.company.trim() || undefined,
      source: draft.source,
    })
      .then(() => { setDraft({ title: '', startsAt: '', company: '', source: 'official' }); load() })
      .catch((err) => setError(err.message))
  }

  if (!plan && !error) return h(Loading, { label: '正在推算你的时间线…' })

  const timeline = plan?.timeline
  const readiness = plan?.readiness ?? {}
  const current = timeline?.current
  const next = timeline?.next

  return h('div', { style: S.col },
    error ? h(ErrorBox, { error, onRetry: () => setError(null) }) : null,

    h('div', { style: { ...S.card, borderColor: T.accent } },
      h('div', { style: { ...S.row, justifyContent: 'space-between' } },
        h('div', { style: S.h2 }, '你现在处在哪个阶段'),
        h(Btn, { kind: 'primary', disabled: busy, onClick: makeBrief }, busy ? '生成中…' : '生成综合简报')),
      current
        ? h('div', { style: S.col },
          h('div', { style: { ...S.row, gap: 8 } },
            h(Chip, { tone: 'accent' }, '进行中'),
            h('span', { style: { ...S.h1 } }, current.label),
            h(Chip, { tone: current.daysToEnd <= 14 ? 'warn' : undefined }, `还剩 ${current.daysToEnd} 天`)),
          h(Bar, { value: (timeline.position?.progress ?? 0) * 100 }),
          h('div', { style: S.muted }, current.hint))
        : next
          ? h('div', { style: S.col },
            h('div', { style: { ...S.row, gap: 8 } },
              h(Chip, null, '尚未开始'),
              h('span', { style: { ...S.h1 } }, next.label),
              h(Chip, { tone: 'accent' }, `还有 ${next.daysToStart} 天`)),
            h('div', { style: S.muted }, next.hint))
          : h('div', { style: S.muted }, '缺毕业年份，无法推算；先到「简历与画像」填毕业年份。'),
      timeline ? h('div', { style: { ...S.muted, fontSize: 11, marginTop: 6 } }, timeline.caveat) : null),

    h('div', { style: S.grid(300) },
      h('div', { style: S.card },
        h('div', { style: S.h2 }, '春招秋招时间线'),
        timeline
          ? h('div', { style: S.col }, timeline.phases.map((phase) => h('div', {
            key: phase.key,
            style: {
              ...S.cardTight,
              borderColor: phase.status === 'current' ? T.accent : T.border,
              background: phase.status === 'current' ? 'rgba(37,99,235,0.06)' : T.surface,
              opacity: phase.status === 'past' ? 0.55 : 1,
            },
          },
            h('div', { style: { ...S.row, justifyContent: 'space-between' } },
              h('span', { style: { ...S.body, fontWeight: 600 } }, phase.label),
              h(Chip, {
                tone: phase.status === 'current' ? 'accent' : phase.status === 'past' ? undefined : 'success',
              }, phase.status === 'current' ? '进行中' : phase.status === 'past' ? '已过' : `还有 ${phase.daysToStart} 天`)),
            h('div', { style: S.mono }, `${phase.start} ~ ${phase.end}`))))
          : h('div', { style: S.muted }, '缺毕业年份。')),

      h('div', { style: S.col },
        h('div', { style: S.card },
          h('div', { style: S.h2 }, '按优先级该做的事'),
          (plan?.actions ?? []).length
            ? h('div', { style: S.col }, plan.actions.map((action, i) => h('div', {
              key: i,
              style: { ...S.cardTight, borderLeft: `3px solid ${action.priority === 1 ? T.error : action.priority === 2 ? T.warn : T.border2}` },
            },
              h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 6 } },
                h('span', { style: { ...S.body, fontWeight: 600 } }, action.title),
                h(Chip, { tone: action.priority === 1 ? 'error' : action.priority === 2 ? 'warn' : undefined }, `P${action.priority}`)),
              h('div', { style: { ...S.muted, marginTop: 3 } }, action.why),
              action.how ? h('div', { style: { ...S.muted, fontSize: 11, opacity: 0.85 } }, `→ ${action.how}`) : null)))
            : h('div', { style: S.muted }, '暂无待办。')),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, '就绪度'),
          h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 6 } },
            h(Chip, { tone: readiness.profilePercent >= 70 ? 'success' : 'warn' }, `画像 ${readiness.profilePercent ?? 0}%`),
            h(Chip, { tone: readiness.hasResume ? 'success' : 'error' }, readiness.hasResume ? '简历已导入' : '缺简历'),
            h(Chip, null, `在招 ${readiness.openJobs ?? 0}`),
            h(Chip, {
              tone: (readiness.appliedCount ?? 0) >= (readiness.targetApplied ?? 0) ? 'success' : 'warn',
            }, `在投 ${readiness.appliedCount ?? 0}/${readiness.targetApplied ?? 0}`),
            h(Chip, { tone: readiness.closingSoon ? 'warn' : undefined }, `14 天内截止 ${readiness.closingSoon ?? 0}`)),

          h('div', { style: { ...S.h3, marginTop: 12 } }, '登记一个节点'),
          h('div', { style: S.grid(140) },
            h(Field, { label: '标题' }, h('input', { style: S.input, value: draft.title, onChange: (e) => setDraft({ ...draft, title: e.target.value }), placeholder: '字节跳动 秋招网申截止' })),
            h(Field, { label: '日期' }, h('input', { style: { ...S.input, type: 'date' }, value: draft.startsAt, onChange: (e) => setDraft({ ...draft, startsAt: e.target.value }) })),
            h(Field, { label: '公司' }, h('input', { style: S.input, value: draft.company, onChange: (e) => setDraft({ ...draft, company: e.target.value }) })),
            h(Field, { label: '来源' }, h('select', { style: S.input, value: draft.source, onChange: (e) => setDraft({ ...draft, source: e.target.value }) },
              h('option', { value: 'official' }, '官方公告'),
              h('option', { value: 'user' }, '我自己填'),
              h('option', { value: 'estimate' }, '经验估计')))),
          h('div', { style: { marginTop: 8 } }, h(Btn, { onClick: addEvent }, '添加节点')),

          (plan?.events ?? []).length
            ? h('div', { style: { marginTop: 10 } }, plan.events.slice(0, 8).map((ev) => h('div', { key: ev.id, style: S.muted },
              `${ev.starts_at} · ${ev.company_name ? `${ev.company_name} · ` : ''}${ev.title}`,
              h(Chip, { tone: ev.source === 'official' ? 'success' : undefined }, ev.source === 'official' ? '官方' : ev.source === 'user' ? '自填' : '估计'))))
            : h('div', { style: { ...S.muted, marginTop: 8 } }, '还没有登记公司级节点。'))) ),

    brief
      ? h('div', { style: S.card },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: S.h2 }, '综合分析简报'),
          h(Btn, { kind: 'ghost', onClick: () => setBrief(null) }, '收起')),
        brief.reportId ? h('div', { style: S.muted }, `已存入研究简报库（id ${brief.reportId}）`) : null,
        brief.missing?.length
          ? h('div', { style: { ...S.cardTight, borderColor: T.warn, marginTop: 8 } },
            h('div', { style: S.h3 }, '缺什么（这些没有数据，简报里不会编）'),
            brief.missing.map((m, i) => h('div', { key: i, style: S.muted }, `· ${m}`)))
          : null,
        h('pre', {
          style: {
            marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.65,
            color: T.text, background: T.surface2, borderRadius: 10, padding: 12, maxHeight: 460, overflow: 'auto',
            fontFamily: 'inherit',
          },
        }, brief.markdown))
      : null)
}
