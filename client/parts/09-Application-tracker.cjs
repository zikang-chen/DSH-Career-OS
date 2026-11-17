// ─── Application tracker ─────────────────────────────────────────────────────
function TrackerTab({ bootstrap, onChanged }) {
  const [view, setView] = useState('list')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')

  const load = useCallback(() => {
    const params = new URLSearchParams()
    if (statusFilter) params.set('status', statusFilter)
    if (query) params.set('q', query)
    if (typeFilter) params.set('type', typeFilter)
    if (view === 'list') params.set('sort', 'deadline')
    const qs = params.toString()
    apiGet(`/applications${qs ? `?${qs}` : ''}`).then(setData).catch((err) => setError(err.message))
  }, [statusFilter, query, typeFilter, view])
  useEffect(load, [load])

  const exportCsv = () => {
    const params = new URLSearchParams()
    if (statusFilter) params.set('status', statusFilter)
    if (query) params.set('q', query)
    const qs = params.toString()
    window.open(`${API}/applications/export${qs ? `?${qs}` : ''}`, '_blank')
  }

  const changeStatus = (id, status) => apiPost('/application/update', { id, status }).then(() => { load(); onChanged?.() }).catch((err) => setError(err.message))

  // 投递详情：冻结的 JD + 材料快照 + 状态时间线。点一行就开，不用再翻页面。
  const [appDetail, setAppDetail] = useState(null)
  const [appOpen, setAppOpen] = useState(false)
  const [appLoading, setAppLoading] = useState(false)
  const openApp = useCallback((id) => {
    setAppOpen(true)
    setAppLoading(true)
    setAppDetail(null)
    apiGet(`/application?id=${encodeURIComponent(id)}`)
      .then((res) => setAppDetail(res.application))
      .catch((err) => setError(err.message))
      .finally(() => setAppLoading(false))
  }, [])

  // 校招/实习阶段顺序：用于「推进到下一阶段」这一个按钮。
  const PIPE = ['saved', 'researching', 'resume_todo', 'ready', 'applied', 'assessment', 'written_test', 'interview_1', 'interview_2', 'final', 'hr', 'offer']
  const nextStage = (status) => {
    const index = PIPE.indexOf(status)
    return index >= 0 && index < PIPE.length - 1 ? PIPE[index + 1] : null
  }
  const advance = (id, status) => {
    const next = nextStage(status)
    if (next) changeStatus(id, next)
  }

  // 漏斗 + 网申信息卡：复盘看漏斗，投递时用信息卡。
  const [funnel, setFunnel] = useState(null)
  const [card, setCard] = useState(null)
  const [cardOpen, setCardOpen] = useState(false)
  useEffect(() => {
    apiGet('/funnel').then(setFunnel).catch(() => setFunnel(null))
    apiGet('/apply-card').then(setCard).catch(() => setCard(null))
  }, [data])

  const copyCard = () => {
    if (!card?.text) return
    const done = () => setError(null)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(card.text).then(done).catch(() => setError('复制失败：浏览器拒绝了剪贴板权限'))
    } else {
      setError('当前环境不支持自动复制，请展开后手动选中复制')
    }
  }

  const funnelBlock = funnel && funnel.submitted > 0
    ? h('div', { style: S.card },
      h('div', { style: { ...S.row, justifyContent: 'space-between', alignItems: 'center' } },
        h('div', { style: S.h2 }, '转化漏斗'),
        h('div', { style: S.muted }, `已投 ${funnel.submitted} 条 · 在流程中 ${funnel.inPipeline} 条 · 已拒 ${funnel.rejected} 条`)),
      h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 6, marginTop: 8 } },
        funnel.stages.map((stage) => h('div', {
          key: stage.key,
          style: {
            ...S.cardTight, minWidth: 96, textAlign: 'center',
            borderColor: funnel.choke && funnel.choke.to === stage.label ? T.warn ?? T.error : T.border,
          },
        },
        h('div', { style: { fontSize: 18, fontWeight: 700, color: T.text } }, stage.count),
        h('div', { style: { ...S.muted, fontSize: 11 } }, stage.label),
        h('div', { style: { ...S.mono, fontSize: 11, color: T.muted } },
          stage.passRate === null ? '—' : `${stage.passRate}%`)))),
      funnel.choke
        ? h('div', { style: { ...S.muted, marginTop: 8 } },
          `卡点：「${funnel.choke.from} → ${funnel.choke.to}」掉 ${funnel.choke.dropped} 条，通过率 ${funnel.choke.passRate ?? '—'}%。`)
        : null,
      funnel.stalled?.length
        ? h('div', { style: { ...S.muted, marginTop: 4 } },
          `停滞 ≥14 天：${funnel.stalled.slice(0, 3).map((s) => `${s.company}（${s.days} 天）`).join('、')}${funnel.stalled.length > 3 ? ` 等 ${funnel.stalled.length} 条` : ''}`)
        : null,
      funnel.byChannel?.length
        ? h('div', { style: { ...S.cardTight, marginTop: 8 } },
          h('div', { style: { ...S.muted, fontWeight: 600, fontSize: 11.5 } }, '分渠道转化'),
          funnel.byChannel.map((c) => h('div', { key: c.channel, style: { ...S.row, justifyContent: 'space-between', ...S.muted, fontSize: 11.5 } },
            h('span', null, c.channel),
            h('span', null, `投 ${c.submitted} · 面试 ${c.interviews}（${c.interviewRate ?? '—'}%）· offer ${c.offers}`))))
        : null,
      h('div', { style: { ...S.muted, marginTop: 6, fontSize: 11 } }, funnel.caveat))
    : null

  const cardBlock = card
    ? h('div', { style: S.card },
      h('div', { style: { ...S.row, justifyContent: 'space-between', alignItems: 'center' } },
        h('div', { style: S.h2 }, '网申信息卡'),
        h('div', { style: S.row },
          h(Chip, { tone: card.completeness.percent >= 90 ? 'success' : 'warn' },
            `${card.completeness.filled}/${card.completeness.total} 字段`),
          h(Btn, { kind: 'primary', onClick: copyCard }, '复制全部'),
          h(Btn, { kind: 'ghost', onClick: () => setCardOpen(!cardOpen) }, cardOpen ? '收起' : '展开'))),
      card.missing.length
        ? h('div', { style: { ...S.muted, marginTop: 6 } },
          `还缺 ${card.missing.length} 项：${card.missing.slice(0, 6).map((m) => m.label).join('、')}${card.missing.length > 6 ? ' 等' : ''}`)
        : h('div', { style: { ...S.muted, marginTop: 6, color: T.success } }, '字段齐全，直接复制到网申页面即可。'),
      cardOpen
        ? h('div', { style: { ...S.mono, marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', background: T.bg, padding: 10, borderRadius: 6 } }, card.text)
        : null)
    : null

  const columns = data?.applications
    ? ['saved', 'researching', 'resume_todo', 'ready', 'applied', 'assessment', 'written_test', 'interview_1', 'interview_2', 'final', 'hr', 'offer', 'rejected', 'closed', 'withdrawn']
    : []

  const cellStyle = { padding: '6px 8px', borderBottom: `1px solid ${T.border}`, color: T.text, verticalAlign: 'top' }
  const cell = (content, extra) => h('td', { style: { ...cellStyle, ...(extra ?? {}) } }, content)
  const STATUS_OPTS = ['saved', 'researching', 'resume_todo', 'ready', 'applied', 'assessment', 'written_test', 'interview_1', 'interview_2', 'final', 'hr', 'offer', 'rejected', 'closed', 'withdrawn']
  const statusChipTone = (s) => s === 'offer' ? 'success' : (s === 'rejected' || s === 'closed' || s === 'withdrawn') ? 'error' : s === 'applied' ? 'accent' : (s === 'interview_1' || s === 'interview_2' || s === 'final' || s === 'hr') ? 'warn' : undefined
  const listTable = data
    ? h('div', { style: S.card },
      h('div', { style: { ...S.muted, marginBottom: 8 } },
        '点任意一行看「冻结的 JD + 材料快照 + 状态时间线」；状态下拉可直接改，不用来回切页。'),
      h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 } },
        h('thead', null, h('tr', null,
          ['公司 / 岗位', '批次', '投递地址', '状态（可直接改）', '投递', '截止', '下一步', ''].map((label) =>
            h('th', { key: label, style: { textAlign: 'left', padding: '7px 8px', color: T.muted, borderBottom: `1px solid ${T.border}`, fontWeight: 600, whiteSpace: 'nowrap' } }, label)))),
        h('tbody', null, data.applications.map((a) => h('tr', {
          key: a.id,
          onClick: () => openApp(a.id),
          title: '点击查看详情',
          style: { cursor: 'pointer', background: a.nextActionOverdue ? 'rgba(217,119,6,0.06)' : 'transparent' },
        },
          cell(h('div', { style: { ...S.col, gap: 1 } },
            h('span', { style: { ...S.body, fontWeight: 600 } }, a.company_name),
            h('span', { style: { ...S.muted, fontSize: 11.5 } }, [a.job_title, a.location].filter(Boolean).join(' · ')))),
          cell((data.recruitLabels ?? {})[a.recruit_type] ?? a.recruit_type ?? '—', { color: T.muted, whiteSpace: 'nowrap' }),
          cell(a.apply_url || a.url
            ? h('span', { style: { ...S.row, gap: 6 } },
              h('a', {
                href: a.apply_url || a.url, target: '_blank', rel: 'noreferrer',
                onClick: (e) => e.stopPropagation(), style: { color: T.accent, whiteSpace: 'nowrap' },
              }, '去投递'),
              h('button', {
                type: 'button', title: a.apply_url || a.url,
                onClick: (e) => { e.stopPropagation(); try { navigator.clipboard.writeText(a.apply_url || a.url) } catch { /* blocked */ } },
                style: { ...S.btn('ghost'), padding: '2px 6px', fontSize: 11 },
              }, '复制'))
            : h('span', { style: { color: T.muted } }, '—'), { maxWidth: 110 }),
          cell(h('div', { style: { ...S.row, gap: 4 } },
            h('select', {
              style: { ...S.input, width: 108, fontSize: 11.5, padding: '3px 4px' },
              value: a.status,
              onClick: (e) => e.stopPropagation(),
              onChange: (e) => { e.stopPropagation(); changeStatus(a.id, e.target.value) },
            }, STATUS_OPTS.map((s) => h('option', { key: s, value: s }, (data.labels ?? {})[s] ?? s))),
            nextStage(a.status)
              ? h('button', {
                type: 'button', title: `推进到「${(data.labels ?? {})[nextStage(a.status)] ?? nextStage(a.status)}」`,
                onClick: (e) => { e.stopPropagation(); advance(a.id, a.status) },
                style: { ...S.btn('ghost'), padding: '2px 6px', fontSize: 11, whiteSpace: 'nowrap' },
              }, '推进 ›')
              : null), { whiteSpace: 'nowrap' }),
          cell(fmtDate(a.applied_at), { color: T.muted, whiteSpace: 'nowrap' }),
          cell(fmtDate(a.deadline), { color: T.muted, whiteSpace: 'nowrap' }),
          cell([a.next_action, fmtDate(a.next_action_at)].filter(Boolean).join(' @ ') || '—', { color: a.nextActionOverdue ? T.warn : T.muted }),
          cell(h('span', { style: { ...S.muted, fontSize: 11.5 } }, '详情 ›'), { whiteSpace: 'nowrap' }))))))
    : h(Loading)

  return h('div', { style: S.col },
    error ? h('div', { style: { ...S.card, ...S.muted, color: T.error } }, error) : null,
    funnelBlock,
    cardBlock,
    h('div', { style: { ...S.row, justifyContent: 'space-between' } },
      h('div', { style: S.h1 }, '投递管理'),
      h('div', { style: S.row },
        h(Btn, { kind: view === 'list' ? 'primary' : undefined, onClick: () => setView('list') }, '清单'),
        h(Btn, { kind: view === 'board' ? 'primary' : undefined, onClick: () => setView('board') }, '看板'),
        h(Btn, { kind: 'ghost', onClick: exportCsv }, '导出 CSV'),
        h(Btn, { kind: 'ghost', onClick: load }, '刷新'))),

    h('div', { style: { ...S.card, ...S.row, flexWrap: 'wrap', gap: 8 } },
      h('input', {
        style: { ...S.input, width: 200 }, value: query, placeholder: '搜索公司/岗位/备注',
        onChange: (e) => setQuery(e.target.value),
      }),
      h('select', { style: { ...S.input, width: 140 }, value: statusFilter, onChange: (e) => setStatusFilter(e.target.value) },
        h('option', { value: '' }, '全部状态'),
        ['saved', 'researching', 'resume_todo', 'ready', 'applied', 'assessment', 'written_test', 'interview_1', 'interview_2', 'final', 'hr', 'offer', 'rejected', 'closed', 'withdrawn']
          .map((s) => h('option', { key: s, value: s }, (data?.labels ?? {})[s] ?? s))),
      h('select', { style: { ...S.input, width: 140 }, value: typeFilter, onChange: (e) => setTypeFilter(e.target.value) },
        h('option', { value: '' }, '全部招聘类型'),
        ['autumn_campus', 'spring_campus', 'summer', 'daily', 'other']
          .map((t) => h('option', { key: t, value: t }, (data?.recruitLabels ?? {})[t] ?? t))),
      h(Chip, null, `${data?.applications?.length ?? 0} 条`)),

    data?.followUps && (data.followUps.overdue.length || data.followUps.stale.length)
      ? h('div', { style: { ...S.card, borderColor: T.warn } },
        h('div', { style: S.h3 }, '需要跟进'),
        data.followUps.overdue.map((a) => h('div', { key: a.id, style: S.muted }, `逾期：${a.company_name} · ${a.job_title}（应做 ${a.next_action || '下一步'} @ ${fmtDate(a.next_action_at)}）`)),
        data.followUps.stale.map((a) => h('div', { key: a.id, style: S.muted }, `长期无更新：${a.company_name} · ${a.job_title}（${a.age_days} 天）`)))
      : null,

    !data ? h(Loading) : data.applications.length === 0
      ? h(Empty, {
        title: query || statusFilter || typeFilter ? '没有符合条件的投递记录' : '还没有投递记录',
        hint: '在「岗位雷达」里打开一个岗位点「加入投递」，或让 Agent 用 career_application_create 记录。',
      })
      : view === 'list'
        ? listTable
        : view === 'board'
        ? h('div', { style: { display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 8 } },
          columns.map((status) => {
            const items = data.applications.filter((a) => a.status === status)
            return h('div', { key: status, style: { minWidth: 190, flex: '0 0 auto' } },
              h('div', { style: { ...S.row, justifyContent: 'space-between', marginBottom: 6 } },
                h('span', { style: { ...S.body, fontWeight: 600 } }, data.labels[status] ?? status),
                h(Chip, null, String(items.length))),
              h('div', { style: S.col }, items.map((a) => h('div', {
                key: a.id, style: { ...S.cardTight, cursor: 'pointer' },
                onClick: () => openApp(a.id), title: '点击查看详情',
              },
                h('div', { style: { ...S.body, fontWeight: 600 } }, a.company_name),
                h('div', { style: S.muted }, a.job_title),
                h('select', {
                  style: { ...S.input, marginTop: 6, fontSize: 11, padding: '3px 5px' },
                  value: a.status,
                  onClick: (e) => e.stopPropagation(),
                  onChange: (e) => { e.stopPropagation(); changeStatus(a.id, e.target.value) },
                }, STATUS_OPTS.map((s) => h('option', { key: s, value: s }, data.labels[s] ?? s))),
                a.next_action_at ? h('div', { style: { ...S.muted, fontSize: 11, marginTop: 4 } }, `下一步 ${fmtDate(a.next_action_at)}`) : null))))
          }))
        : listTable,

    // 投递详情弹层：冻结的 JD + 材料快照 + 时间线
    appOpen
      ? h(Modal, {
        title: appDetail ? `${appDetail.company_name} · ${appDetail.job_title}` : '投递详情',
        subtitle: appDetail ? `状态：${(data?.labels ?? {})[appDetail.status] ?? appDetail.status} · 投递 ${fmtDate(appDetail.applied_at)} · 渠道 ${appDetail.channel ?? '未填'}` : '加载中…',
        onClose: () => { setAppOpen(false); setAppDetail(null) },
      },
        appLoading ? h(Loading) : !appDetail ? h(Empty, { title: '没有取到记录' }) : h('div', { style: S.col },

          h('div', { style: { ...S.row, justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 } },
            h('div', { style: S.row },
              h(Chip, { tone: statusChipTone(appDetail.status) }, (data?.labels ?? {})[appDetail.status] ?? appDetail.status),
              appDetail.next_action_overdue || appDetail.nextActionOverdue ? h(Chip, { tone: 'warn' }, '下一步已逾期') : null),
            h('div', { style: S.row },
              h('select', {
                style: { ...S.input, width: 120, fontSize: 12 },
                value: appDetail.status,
                onChange: (e) => apiPost('/application/update', { id: appDetail.id, status: e.target.value })
                  .then(() => { load(); onChanged?.(); openApp(appDetail.id) })
                  .catch((err) => setError(err.message)),
              }, STATUS_OPTS.map((s) => h('option', { key: s, value: s }, (data?.labels ?? {})[s] ?? s))),
              (appDetail.apply_url || appDetail.url)
                ? h('a', { href: appDetail.apply_url || appDetail.url, target: '_blank', rel: 'noreferrer', style: { ...S.btn('primary'), textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, '去投递页')
                : null)),

          h('div', { style: { ...S.cardTight, marginTop: 10 } },
            h('div', { style: S.h3 }, '投递信息'),
            h('div', { style: S.grid(260) },
              h(KV, { label: '公司' }, appDetail.company_name),
              h(KV, { label: '岗位' }, appDetail.job_title),
              h(KV, { label: '工作地点' }, appDetail.location),
              h(KV, { label: '招聘批次' }, (data?.recruitLabels ?? {})[appDetail.recruit_type] ?? appDetail.recruit_type),
              h(KV, { label: '渠道' }, appDetail.channel),
              h(KV, { label: '投递日期' }, appDetail.applied_at ? fmtDate(appDetail.applied_at) : null),
              h(KV, { label: '截止日期' }, appDetail.deadline ? fmtDate(appDetail.deadline) : null),
              h(KV, { label: '结果' }, appDetail.result),
              h(KV, { label: '下一步' }, [appDetail.next_action, appDetail.next_action_at ? fmtDate(appDetail.next_action_at) : null].filter(Boolean).join(' @ ')),
              h(KV, { label: '备注' }, appDetail.notes))),

          // 提交材料快照
          appDetail.submissionSnapshot
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '当时提交了什么'),
              h(KV, { label: '简历版本' }, appDetail.submissionSnapshot.resumeLabel ?? '未指定'),
              h(KV, { label: '附带资料' }, (appDetail.submissionSnapshot.documents ?? []).length
                ? appDetail.submissionSnapshot.documents.map((d) => d.title).join('；')
                : (appDetail.submissionSnapshot.materialsSpecified ? '无' : '当时没有指定材料')),
              h(KV, { label: '记录时间' }, appDetail.submissionSnapshot.capturedAt ? relTime(appDetail.submissionSnapshot.capturedAt) : null))
            : null,

          // 冻结的 JD
          appDetail.submittedJd
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '冻结的 JD（投递当时的要求）'),
              h('div', { style: { ...S.muted, fontSize: 11, marginBottom: 4 } },
                `来源：${appDetail.submittedJd.source === 'user' ? '你粘贴的原文' : '岗位库快照'} · 记录于 ${appDetail.submittedJd.capturedAt ? relTime(appDetail.submittedJd.capturedAt) : '—'}`),
              appDetail.submittedJd.text
                ? h('div', { style: { ...S.body, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' } }, appDetail.submittedJd.text)
                : h('div', { style: S.col },
                  appDetail.submittedJd.description ? h('div', { style: { ...S.body, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' } }, appDetail.submittedJd.description) : null,
                  appDetail.submittedJd.requirements ? h('div', { style: { ...S.body, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', marginTop: 6 } }, appDetail.submittedJd.requirements) : null,
                  !appDetail.submittedJd.description && !appDetail.submittedJd.requirements
                    ? h('div', { style: S.muted }, '这条记录创建时岗位库里没有 JD 正文。')
                    : null))
            : h('div', { style: { ...S.cardTight, marginTop: 10, borderColor: T.warn } },
              h('div', { style: S.h3 }, '冻结的 JD'),
              h('div', { style: S.muted }, '这条投递没有留存 JD 快照（创建时未提供）。建议以后用 career_application_create 时带上 jd 参数，面试前就能回放当时的要求。')),

          // 时间线
          (appDetail.events ?? []).length
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '状态时间线'),
              appDetail.events.map((e) => h('div', { key: e.id, style: { ...S.muted, marginBottom: 4 } },
                `${fmtDate(e.at)} · ${e.from_status ? `${(data?.labels ?? {})[e.from_status] ?? e.from_status} → ` : ''}${(data?.labels ?? {})[e.to_status] ?? e.to_status ?? e.type}${e.note ? ` · ${e.note}` : ''}`)))
            : null,

          // 快捷操作：下一步与结论
          h('div', { style: { ...S.cardTight, marginTop: 10 } },
            h('div', { style: S.h3 }, '快速记录'),
            h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 6, marginTop: 6 } },
              [['assessment', '进笔试'], ['interview_1', '约一面'], ['interview_2', '进二面'], ['final', '进终面'], ['offer', '拿 offer'], ['rejected', '被拒'], ['withdrawn', '我放弃']].map(([s, label]) =>
                h(Btn, {
                  key: s, kind: s === 'offer' ? 'primary' : 'ghost',
                  onClick: () => apiPost('/application/update', { id: appDetail.id, status: s, note: `快捷记录：${label}` })
                    .then(() => { load(); onChanged?.(); openApp(appDetail.id) })
                    .catch((err) => setError(err.message)),
                }, label))))))
      : null)
}
