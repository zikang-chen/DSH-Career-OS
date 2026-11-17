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
  // 推荐由 bootstrap 确定：首页只读，不自动请求匹配重算。
  const [pending, setPending] = useState({})
  const [handled, setHandled] = useState({})
  const [feedback, setFeedback] = useState(null)
  const saveTask = async (id, action) => {
    if (!id || pending[id]) return
    setPending((s) => ({ ...s, [id]: true }))
    setFeedback(null)
    try {
      // snooze 默认明天，由后端决定日期和时区。
      await apiPost('/today/task', { id, action })
      setHandled((s) => ({ ...s, [id]: true }))
      setFeedback({ ok: true, text: action === 'done' ? '已完成，记录已保存。' : action === 'snooze' ? '已推迟到明天。' : '已忽略此项。' })
    } catch {
      setFeedback({ ok: false, text: '暂时无法保存，请稍后重试；此项仍保留在列表中。' })
      return
    } finally {
      setPending((s) => ({ ...s, [id]: false }))
    }
    // 刷新失败不冒充保存失败，已确认的任务状态仍保留。
    if (onRefresh) {
      try { await onRefresh() } catch { setFeedback({ ok: false, text: '操作已保存，但工作台刷新失败，请稍后刷新。' }) }
    }
  }
  if (!bootstrap) return h(Loading)
  const list = (value) => Array.isArray(value) ? value : []
  const text = (value) => typeof value === 'string' ? value.replace(/career_[a-z_]+/gi, '相关功能') : ''
  const number = (value) => typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
  const today = bootstrap.today ?? {}
  const profile = today.profile ?? {}
  const health = today.health ?? {}
  const coverage = today.coverage ?? {}
  const priorities = list(today.priorities).filter((item) => item && !handled[item.id]).slice(0, 5)
  const recommendations = list(today.recommendations).filter(Boolean).slice(0, 5)
  const pipeline = list(today.pipeline).filter(Boolean)
  const changes = list(today.changes).filter(Boolean)
  const status = bootstrap.status ?? {}
  const db = status.db ?? {}
  const checks = list(bootstrap.completeness?.checks)
  const errors = bootstrap.errors ?? bootstrap._errors ?? bootstrap.error
  const hasErrors = Array.isArray(errors) ? errors.length > 0 : errors && (typeof errors !== 'object' || Object.keys(errors).length > 0)
  const profileConfirmation = profile.profileConfirmation
  const confirmationText = typeof profileConfirmation === 'string' ? text(profileConfirmation)
    : profileConfirmation === true ? '画像已确认' : profileConfirmation === false ? '画像待确认'
      : text(profileConfirmation?.label || profileConfirmation?.message || profileConfirmation?.status)
  const wrapRow = { ...S.row, flexWrap: 'wrap', gap: 8 }
  const section = { ...S.col, gap: 12, minWidth: 0 }
  const itemStyle = { padding: '12px 0', borderTop: `1px solid ${T.border}`, minWidth: 0 }
  const entryActions = () => h('div', { style: wrapRow },
    h(Btn, { kind: 'primary', onClick: () => onNavigate('radar') }, '找岗位'),
    h(Btn, { onClick: () => onNavigate('resume') }, '补画像'),
    h(Btn, { kind: 'ghost', onClick: () => onNavigate('company') }, '看公司情报'))

  return h('div', { style: { ...S.col, gap: 22 } },
    h('header', { style: section },
      h('div', { style: { ...wrapRow, justifyContent: 'space-between' } },
        h('div', null,
          h('h1', { style: S.h1 }, '今日工作台'),
          h('div', { style: { ...S.muted, marginTop: 4 } }, '先处理要紧的事，再推进值得尝试的机会。')),
        h(Btn, { kind: 'ghost', onClick: onRefresh }, '刷新')),
      h('div', { style: { ...S.cardTight, ...wrapRow, justifyContent: 'space-between' } },
        h('div', { style: { ...S.col, gap: 3, flex: '1 1 230px', minWidth: 0 } },
          h('div', { style: { ...S.body, fontWeight: 600, overflowWrap: 'anywhere' } }, text(profile.headline) || '先明确你的求职目标'),
          h('div', { style: S.muted }, [list(profile.targetRoles).map(text).filter(Boolean).join(' / '), list(profile.cities).map(text).filter(Boolean).join(' / '), profile.gradYear ? `${profile.gradYear} 届` : ''].filter(Boolean).join(' · ') || '目标方向、城市和毕业年份尚未提供。'),
          confirmationText ? h('div', { style: S.muted }, confirmationText) : null),
        h(Btn, { onClick: () => onNavigate('resume') }, '调整目标'))),

    bootstrap.focus?.note ? h('div', { style: { ...S.muted, borderLeft: `3px solid ${T.accent}`, paddingLeft: 10 } }, text(bootstrap.focus.note)) : null,
    hasErrors ? h('div', { role: 'alert', style: { ...S.cardTight, borderColor: T.warn } },
      h('div', { style: S.body }, '部分工作台数据暂未加载，以下内容可能不完整。'),
      h('div', { style: { ...S.muted, marginTop: 4 } }, '可刷新重试；已加载的内容仍可使用。'),
      h(Btn, { kind: 'ghost', onClick: onRefresh }, '重试加载')) : null,
    feedback ? h('div', { role: feedback.ok ? 'status' : 'alert', style: { ...S.muted, color: feedback.ok ? T.success : T.error } }, feedback.text) : null,

    h('section', { style: section },
      h('div', { style: { ...wrapRow, justifyContent: 'space-between' } },
        h('h2', { style: S.h2 }, '优先处理'),
        h('span', { style: S.muted }, '最多 5 项 · 按紧急程度排序')),
      priorities.length ? h('div', null, priorities.map((item, index) => h('article', { key: item.id || index, style: itemStyle },
        h('div', { style: { ...wrapRow, justifyContent: 'space-between', alignItems: 'flex-start' } },
          h('div', { style: { ...S.col, gap: 4, flex: '1 1 240px', minWidth: 0 } },
            h('div', { style: { ...S.body, fontWeight: 600, overflowWrap: 'anywhere' } }, text(item.title) || '待处理事项'),
            item.reason ? h('div', { style: S.muted }, text(item.reason)) : null,
            h('div', { style: S.muted }, [text(item.company), text(item.jobTitle), item.dueAt ? `到期 ${text(item.dueAt)}` : ''].filter(Boolean).join(' · '))),
          item.action?.tab ? h(Btn, { kind: index === 0 ? 'primary' : undefined, onClick: () => onNavigate(item.action.tab, item.action.code) }, text(item.action.label) || '去处理') : null),
        h('div', { style: { ...wrapRow, marginTop: 8 } },
          h(Btn, { kind: 'ghost', disabled: !item.id || !!pending[item.id], onClick: () => saveTask(item.id, 'done') }, pending[item.id] ? '保存中…' : '完成'),
          h(Btn, { kind: 'ghost', disabled: !item.id || !!pending[item.id], onClick: () => saveTask(item.id, 'snooze') }, '明天再看'),
          h(Btn, { kind: 'ghost', disabled: !item.id || !!pending[item.id], onClick: () => saveTask(item.id, 'ignore') }, '忽略')))))
        : h('div', { style: section }, h('div', { style: S.muted }, bootstrap.today ? '暂无待处理的优先事项。可以继续寻找机会，或检查目标是否完整。' : '今日任务暂未提供。你仍可从岗位、画像或公司情报开始。'), entryActions())),

    h('section', { style: section },
      h('div', { style: { ...wrapRow, justifyContent: 'space-between' } },
        h('h2', { style: S.h2 }, '值得推进的机会'),
        h(Btn, { kind: 'ghost', onClick: () => onNavigate('radar') }, '查看岗位列表')),
      h('div', { style: S.muted }, '推荐反映与你目标的契合度，不是录用概率；是否在招需单独看核验信息。'),
      recommendations.length ? h('div', null, recommendations.map((job, index) => h('article', { key: job.id || index, style: itemStyle },
        h('div', { style: { ...wrapRow, justifyContent: 'space-between', alignItems: 'flex-start' } },
          h('div', { style: { ...S.col, gap: 4, flex: '1 1 240px', minWidth: 0 } },
            h('div', { style: { ...S.body, fontWeight: 600, overflowWrap: 'anywhere' } }, [text(job.company), text(job.title)].filter(Boolean).join(' · ') || '岗位信息待补充'),
            h('div', { style: S.muted }, [text(job.location), ({ autumn_campus: '秋招', spring_campus: '春招', summer: '暑期实习', daily: '日常实习', campus: '校招', social: '社招', intern: '实习' })[job.recruitType] || text(job.recruitType), job.deadline ? `截止 ${text(job.deadline)}` : ''].filter(Boolean).join(' · '))),
          h(Btn, { onClick: () => onNavigate('radar', job.id) }, '查看岗位')),
        h('div', { style: { ...wrapRow, marginTop: 8 } },
          h(Chip, { tone: job.fit?.reliable === true ? 'accent' : 'warn' }, job.fit?.reliable === true && typeof job.fit?.score === 'number' ? `目标匹配 ${number(job.fit.score)}` : '匹配信息不足'),
          h('span', { style: S.muted }, text(job.statusDisplay) || '招聘状态待核实'),
          h('span', { style: S.muted }, job.verifiedAt ? `核验于 ${text(job.verifiedAt)}` : '尚无核验时间')),
        list(job.reasons).length ? h('div', { style: { ...S.body, marginTop: 8 } }, '推荐理由：', list(job.reasons).map(text).filter(Boolean).join('；')) : h('div', { style: { ...S.muted, marginTop: 8 } }, '推荐理由尚未提供。'),
        list(job.gaps).length ? h('div', { style: { ...S.muted, marginTop: 4 } }, '待补齐 / 核实：', list(job.gaps).map(text).filter(Boolean).join('；')) : null)))
        : h('div', { style: section }, h('div', { style: S.muted }, '暂无可展示的推荐。先添加岗位、补全画像或查看公司情报，不会为凑数生成推荐。'), entryActions())),

    h('section', { style: section },
      h('div', { style: { ...wrapRow, justifyContent: 'space-between' } },
        h('h2', { style: S.h2 }, '投递进展 · Pipeline'),
        h(Btn, { kind: 'ghost', onClick: () => onNavigate('tracker') }, '管理投递')),
      pipeline.length ? h('div', { style: { ...wrapRow, alignItems: 'stretch' } }, pipeline.map((stage, index) => h('button', {
        key: stage.status || index, type: 'button', onClick: () => onNavigate('tracker'),
        style: { ...S.btn('ghost'), display: 'flex', gap: 12, alignItems: 'center', flex: '1 1 120px', justifyContent: 'space-between', padding: '10px 12px' },
      }, h('span', null, text(stage.label) || text(stage.status)), h('strong', null, number(stage.count)))))
        : h('div', { style: S.muted }, '暂无投递进展数据。到投递管理记录申请与下一步行动。')),

    h('section', { style: section },
      h('h2', { style: S.h2 }, '最近变化'),
      changes.length ? h('div', null, changes.slice(0, 5).map((change, index) => h('div', { key: change.id || index, style: itemStyle },
        h('div', { style: { ...wrapRow, justifyContent: 'space-between' } },
          h('div', { style: { ...S.body, fontWeight: 550 } }, text(change.title) || (typeof change === 'string' ? text(change) : '有新的更新')),
          change.created_at ? h('span', { style: S.muted }, relTime(change.created_at)) : null),
        change.body ? h('div', { style: { ...S.muted, marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, text(change.body)) : null,
        change.job_id ? h(Btn, { kind: 'ghost', onClick: () => onNavigate('radar', change.job_id) }, '查看岗位') : null)))
        : h('div', { style: S.muted }, '暂无新的变化。')),

    h('details', { style: { borderTop: `1px solid ${T.border}`, paddingTop: 12 } },
      h('summary', { style: { ...S.body, cursor: 'pointer', fontWeight: 550 } }, '数据与健康诊断'),
      h('div', { style: { ...S.col, gap: 12, marginTop: 12 } },
        h('div', { style: S.muted }, `${text(coverage.scope) || '已加载的本地数据'}；以下健康指标仅针对本次加载范围，不代表全库。`),
        coverage.loadedJobs != null ? h('div', { style: S.muted }, `本次已加载岗位 ${number(coverage.loadedJobs)}${coverage.maxJobs != null ? `（最多 ${number(coverage.maxJobs)}）` : ''}；申请 ${number(coverage.loadedApplications)}${coverage.maxApplications != null ? `（最多 ${number(coverage.maxApplications)}）` : ''}。`) : null,
        h('div', { style: wrapRow },
          h('span', { style: S.muted }, `岗位 ${number(health.total)}`),
          h('span', { style: S.muted }, `正文完整 ${number(health.textComplete)}`),
          h('span', { style: S.muted }, `核验在招 ${number(health.verifiedOpen)}`),
          h('span', { style: S.muted }, `缺官方链接 ${number(health.missingOfficialLink)}`)),
        checks.length ? h('div', { style: wrapRow }, checks.map((check, index) => h('span', { key: check.key || index, style: S.muted }, `${check.done ? '✓' : '○'} ${text(check.label)}`))) : null,
        h('div', { style: S.muted }, `数据库版本 ${db.schemaVersion ?? '—'} · 当前简历：${text(bootstrap.activeResume?.label) || '未提供'} · 定时监控：${status.scheduleEnabled === true ? '已开启' : status.scheduleEnabled === false ? '未开启' : '未知'}`),
        h('div', { style: wrapRow },
          h(Btn, { onClick: () => onNavigate('settings') }, '数据源与设置'),
          h(Btn, { kind: 'ghost', onClick: () => onNavigate('resume') }, '完善画像')))))
}
