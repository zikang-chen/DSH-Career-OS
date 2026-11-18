// ─── Internship Radar ────────────────────────────────────────────────────────
// All browse conditions are applied by /jobs to the local database before pagination.
const radarStatusLabels = { OPEN: '官方在招', UPCOMING: '即将开放', UNVERIFIED: '待核实', STALE: '待重新核验', CLOSED: '已关闭', UNKNOWN: '状态未知' }
const radarRecruitLabels = { autumn_campus: '秋招', spring_campus: '春招', summer: '暑期实习', daily: '日常实习', campus: '校招', social: '社招', intern: '实习', other: '其他' }
function radarValue(job, camel, snake = camel) { return job[camel] ?? job[snake] }
function radarText(value) { return typeof value === 'string' && value.trim() ? value.trim() : '未知' }
function radarJD(job) {
  const description = radarText(job.description) !== '未知'
  const requirements = radarText(job.requirements) !== '未知'
  return { complete: description && requirements, label: description && requirements ? 'JD 完整（职责 + 要求）' : description || requirements ? 'JD 不完整（缺职责或要求）' : 'JD 未知（未存正文）' }
}
function radarFilter(jobs, { city = '', recruit = '', completeOnly = false } = {}) {
  return jobs.filter((job) => (!city || String(job.location ?? '').toLowerCase().includes(city.trim().toLowerCase()))
    && (!recruit || radarValue(job, 'recruitType', 'recruit_type') === recruit)
    && (!completeOnly || radarJD(job).complete))
}
function radarAssessmentText(value) {
  if (value === null || value === undefined || value === '') return '未知'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.length ? value.map(radarAssessmentText).join('；') : '未知'
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${radarAssessmentText(item)}`).join(' · ') || '未知'
  return String(value)
}
// Job360 renders bounded, human-readable fields only; never dump backend payloads.
function radarStatus(job) {
  return typeof job.statusDisplay === 'string' && job.statusDisplay.trim() ? job.statusDisplay : job.status === 'OPEN' ? '历史记录在招（当前待核实）' : radarStatusLabels[job.status] ?? '状态未知'
}
function radarSafeUrl(value) { return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null }
function radarItems(value) { return Array.isArray(value) ? value : [] }
function radarNote(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return value && typeof value === 'object' ? [value.label ?? value.title ?? value.message ?? value.issue ?? value.skill ?? value.name, value.explanation ?? value.suggestion ?? value.advice ?? value.reason ?? value.text].filter((v) => typeof v === 'string').join(' · ') || '有待核对的准备事项，请到简历工作室查看' : '未记录'
}
function radarJob360Company(data, detail, navigate) {
  const company = data?.company
  const action = h(Btn, { onClick: () => navigate?.('social', detail.id) }, '去知识库检索（需手动输入公司 / 岗位）')
  const missing = (title) => h('div', { style: S.cardTight }, h('div', { style: S.muted }, `${title}：未研究 / 暂无已入库资料，不代表不存在。`), action)
  const link = (url, label) => radarSafeUrl(url) ? h('a', { href: url, target: '_blank', rel: 'noreferrer', style: { color: T.accent } }, label) : null
  return h('details', { style: S.cardTight, 'data-job360': 'intelligence' },
    h('summary', { style: { ...S.h3, cursor: 'pointer' } }, '公司与情报聚合'),
    company ? h('section', { style: S.cardTight }, h('div', { style: S.h3 }, company.name || '公司档案'),
      h('div', { style: S.body }, radarNote(company.business || '主营业务尚未研究')),
      h('div', { style: S.muted }, `行业：${radarNote(company.industry || '未研究')}`), link(company.careersUrl, '官方招聘入口'),
      h(Btn, { onClick: () => navigate?.('company', company.id) }, '查看公司档案')) : missing('公司档案'),
    h('div', { style: S.h3 }, '业务部门'),
    radarItems(company?.units).length ? radarItems(company.units).map((unit, i) => h('div', { key: unit.id || i, style: S.cardTight }, h('div', { style: S.body }, unit.name || '未命名部门'), h('div', { style: S.muted }, radarNote(unit.business || unit.summary || '业务职责未研究')))) : missing('业务部门'),
    h('div', { style: S.h3 }, '公司研究简报'),
    radarItems(company?.reports).length ? radarItems(company.reports).map((report, i) => h('div', { key: report.id || i, style: S.cardTight }, h('div', { style: S.body }, report.title || '未命名简报'), h('div', { style: S.muted }, radarNote(report.summary || report.body || '无摘要，请查看公司档案').slice(0, 500)), h(Btn, { onClick: () => navigate?.('company', company.id) }, '查看研究简报'))) : missing('公司研究'),
    h('div', { style: S.h3 }, '相关知识库资料'),
    radarItems(data?.knowledge).length ? radarItems(data.knowledge).map((item, i) => h('article', { key: item.id || i, style: S.cardTight }, h('div', { style: S.h3 }, item.title || '未命名资料'),
      h('div', { style: S.muted }, `${radarNote(item.kind)} · ${radarNote(item.platform)} · 完整度 ${radarNote(item.completeness)} · ${item.publishedAt ? fmtDate(item.publishedAt) : '发布时间未知'}`),
      h('div', { style: { ...S.body, whiteSpace: 'pre-wrap' } }, typeof item.body === 'string' && item.body.trim() ? item.body.slice(0, 700) : '正文未取得，请检索资料或打开来源核对。'), link(item.url, '核对原文'), action)) : missing('相关情报'),
    h('div', { style: S.muted }, '以上仅聚合本地已有资料，未执行 AI 研究；来源缺失或正文不全需另行核对。'), action,
    data?.sourceHealth ? h('div', { style: S.muted }, `数据源：${radarNote(data.sourceHealth.summary || data.sourceHealth.status || '请到数据源设置核对覆盖与失败情况')}`) : null,
    h(Btn, { kind: 'ghost', onClick: () => navigate?.('settings') }, '查看数据源与覆盖'))
}
function radarJob360Preparation(data, detail, form, setForm, saveDraft, busy, navigate) {
  const plan = data?.resumePlan
  const application = data?.application || detail.application
  const studio = (label) => h(Btn, { onClick: () => navigate?.('studio', detail.id) }, label)
  const list = (title, values, empty) => h('section', { style: S.cardTight }, h('div', { style: S.h3 }, title), radarItems(values).length ? radarItems(values).map((value, i) => h('div', { key: i, style: S.muted }, radarNote(value))) : h('div', { style: S.muted }, empty), studio('去简历工作室核对'))
  return h('details', { style: S.cardTight, 'data-job360': 'preparation' },
    h('summary', { style: { ...S.h3, cursor: 'pointer' } }, '申请准备'),
    h('div', { style: S.muted }, '仅保存本地申请草稿，不会向外部网站投递，也不会标记为已投递。'),
    h('section', { style: S.cardTight }, h('div', { style: S.h3 }, '建议展示的真实经历'),
      radarItems(plan?.selected).length ? radarItems(plan.selected).map((entry, i) => h('div', { key: entry.id || i, style: S.cardTight }, h('div', { style: S.body }, [entry.organization, entry.role].filter(Boolean).join(' · ') || '经历待核对'), typeof entry.bullets === 'number' ? h('div', { style: S.muted }, `建议保留 ${entry.bullets} 条已存要点；请到工作室核对原文。`) : radarItems(entry.bullets).map((bullet, j) => h('div', { key: j, style: S.muted }, `· ${radarNote(bullet)}`)))) : h('div', { style: S.muted }, '尚无可用经历方案，未完成简历准备；请先导入并确认真实经历。'), studio('完善此岗位简历')),
    list('待补缺口', plan?.gaps, '暂无已记录缺口，不代表已满足全部要求。'),
    list('简历质量检查', plan?.quality?.issues || plan?.quality, '暂无质量检查结果，请到简历工作室检查。'),
    h('section', { style: S.cardTight }, h('div', { style: S.h3 }, '要点改写建议'),
      plan?.skillAdvice?.summary ? h('div', { style: S.muted }, radarNote(plan.skillAdvice.summary)) : null,
      radarItems(plan?.skillAdvice?.perBullet).length ? radarItems(plan.skillAdvice.perBullet).map((item, i) => h('div', { key: i, style: S.cardTight }, h('div', { style: S.body }, radarNote(item.bullet)),
        radarItems(item.issues).length ? radarItems(item.issues).map((issue, j) => h('div', { key: j, style: S.muted }, radarNote(issue))) : h('div', { style: S.muted }, '此要点未记录诊断问题，仍需人工核对。'))) : radarItems(plan?.skillAdvice).length ? radarItems(plan.skillAdvice).map((advice, i) => h('div', { key: i, style: S.muted }, radarNote(advice))) : h('div', { style: S.muted }, '暂无逐条要点诊断，请核对真实素材；不补造经历。'),
      h('div', { style: S.muted }, `JD 待覆盖关键词：${radarItems(plan?.skillAdvice?.jdCoverage?.missing).map(radarNote).join('、') || '暂无已记录结果，不代表全部覆盖'}`),
      plan?.skillAdvice?.jdCoverage?.note ? h('div', { style: S.muted }, radarNote(plan.skillAdvice.jdCoverage.note)) : null,
      studio('去工作室检查要点与关键词')),
    application ? h('div', { style: S.cardTight }, h('div', { style: S.muted }, '此岗位已有申请记录，请在进度页继续维护，避免重复创建。'), h(Btn, { kind: 'primary', onClick: () => navigate?.('tracker', detail.id) }, '定位已有申请记录')) : h('div', { style: S.col },
      h(Field, { label: '选择简历版本（申请草稿）' }, h('select', { 'aria-label': '申请草稿简历版本', style: S.input, value: form.resumeVersionId, onChange: (e) => setForm({ ...form, resumeVersionId: e.target.value }) }, h('option', { value: '' }, '请选择已保存的简历版本'), radarItems(data?.resumeVersions).map((version) => h('option', { key: version.id, value: version.id }, version.label || version.id)))),
      !radarItems(data?.resumeVersions).length ? h('div', null, h('div', { style: S.muted }, '暂无已保存简历，请先在工作室保存版本；也可用顶部「加入投递」仅收藏岗位。'), studio('创建简历版本')) : null,
      h(Field, { label: '投递渠道' }, h('input', { 'aria-label': '申请草稿渠道', style: S.input, value: form.channel, onChange: (e) => setForm({ ...form, channel: e.target.value }), placeholder: '如官网 / 内推（仅记录）' })),
      h(Field, { label: '下一步日期' }, h('input', { 'aria-label': '申请草稿下一步日期', type: 'date', style: S.input, value: form.nextActionAt, onChange: (e) => setForm({ ...form, nextActionAt: e.target.value }) })),
      h(Field, { label: '准备备注' }, h('textarea', { 'aria-label': '申请草稿备注', style: S.textarea, value: form.notes, onChange: (e) => setForm({ ...form, notes: e.target.value }) })),
      h(Btn, { kind: 'primary', disabled: busy || !form.resumeVersionId, onClick: saveDraft }, busy ? '保存草稿中…' : '保存申请草稿')))
}
function RadarTab({ focusCode, onChanged, onNavigate }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [minScore, setMinScore] = useState('')
  const [city, setCity] = useState('')
  const [recruit, setRecruit] = useState('')
  const [completeOnly, setCompleteOnly] = useState(false)
  const [remoteType, setRemoteType] = useState('')
  const [gradYear, setGradYear] = useState('')
  const [daysPerWeekMax, setDaysPerWeekMax] = useState('')
  const [offset, setOffset] = useState(0)
  const limit = 20
  const [viewMode, setViewMode] = useState('table')
  const [assessment, setAssessment] = useState(null)
  const [job360, setJob360] = useState(null)
  const [draftForm, setDraftForm] = useState({ resumeVersionId: '', channel: '', nextActionAt: '', notes: '' })
  const [verifySourceUrl, setVerifySourceUrl] = useState('')
  const [verifyEvidence, setVerifyEvidence] = useState('')
  const changeCondition = (setter, value) => { setOffset(0); setter(value) }
  const tracking = useRef(false)
  const detailRequest = useRef(0)
  const [trackingBusy, setTrackingBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const loadRequest = useRef(0)
  const [list, setList] = useState(null)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [compareIds, setCompareIds] = useState([])
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareData, setCompareData] = useState(null)
  const [compareError, setCompareError] = useState(null)
  const [confirmDeleteJob, setConfirmDeleteJob] = useState(false)
  const [deletingJob, setDeletingJob] = useState(false)
  const deleteThisJob = async () => {
    if (!detail?.id) return
    setDeletingJob(true)
    try {
      await apiPost('/jobs/delete', { id: detail.id })
      detailRequest.current++
      setDetailOpen(false); setSelected(null); setDetail(null); setConfirmDeleteJob(false)
      load()
    } catch (err) { setError(`删除岗位失败：${err.message}`) } finally { setDeletingJob(false) }
  }
  const [form, setForm] = useState({ company: '', title: '', jdText: '', url: '', official: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [crawlUrl, setCrawlUrl] = useState('')
  const [crawlCompany, setCrawlCompany] = useState('')
  const [crawlRecruit, setCrawlRecruit] = useState('')
  const [crawlResult, setCrawlResult] = useState(null)
  const [crawling, setCrawling] = useState(false)

  const load = useCallback(() => {
    const params = new URLSearchParams()
    if (query) params.set('query', query)
    if (status) params.set('status', status)
    if (minScore) params.set('minScore', minScore)
    if (city.trim()) params.set('location', city.trim())
    if (recruit) params.set('recruitType', recruit)
    if (completeOnly) params.set('jdComplete', 'true')
    if (remoteType) params.set('remoteType', remoteType)
    if (gradYear) params.set('gradYear', gradYear)
    if (daysPerWeekMax) params.set('daysPerWeekMax', daysPerWeekMax)
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    setError(null)
    setLoading(true)
    const request = ++loadRequest.current
    apiGet(`/jobs?${params.toString()}`).then((res) => {
      if (request === loadRequest.current) setList(res)
    }).catch((err) => { if (request === loadRequest.current) setError(err.message) })
      .finally(() => { if (request === loadRequest.current) setLoading(false) })
  }, [query, status, minScore, city, recruit, completeOnly, remoteType, gradYear, daysPerWeekMax, offset])

  useEffect(load, [load])

  const openDetail = useCallback((id) => {
    setSelected(id)
    setDetail(null)
    setAssessment(null)
    setJob360(null)
    setDraftForm({ resumeVersionId: '', channel: '', nextActionAt: '', notes: '' })
    setError(null)
    setVerifySourceUrl('')
    setVerifyEvidence('')
    setDetailOpen(true)
    const request = ++detailRequest.current
    apiGet(`/job?id=${encodeURIComponent(id)}`).then((res) => {
      if (request === detailRequest.current) { setDetail(res.job); setAssessment(res.assessment ?? null); setJob360(res.job360 ?? null) }
    }).catch((err) => { if (request === detailRequest.current) setError(err.message) })
  }, [])

  useEffect(() => {
    if (focusCode) openDetail(focusCode)
  }, [focusCode, openDetail])

  const saveJob = async () => {
    if (!form.company.trim() || !form.title.trim()) return setError('公司与岗位名必填')
    setBusy(true)
    setError(null)
    try {
      const res = await apiPost('/job/save', form)
      setForm({ company: '', title: '', jdText: '', url: '', official: false })
      load()
      onChanged?.()
      if (res.job?.id) openDetail(res.job.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const verify = async (nextStatus, official) => {
    if (!selected) return
    if (official && (!/^https:\/\/\S+$/i.test(verifySourceUrl.trim()) || !verifyEvidence.trim())) {
      setError('官方状态核验需要 HTTPS 官方来源链接与原文证据摘录；尚未修改状态。')
      return
    }
    try {
      const res = await apiPost('/job/verify', { id: selected, status: nextStatus, official, sourceUrl: verifySourceUrl.trim() || undefined, evidence: verifyEvidence.trim() || undefined })
      const warning = res.warning ?? res.result?.warning
      if (warning) { setError(warning); return }
      setError(null)
      openDetail(selected)
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  const track = async (draft = false) => {
    if (!detail) return
    if (detail.application || job360?.application) { onNavigate?.('tracker', detail.id); return }
    if (draft && (!draftForm.resumeVersionId || !radarItems(job360?.resumeVersions).some((version) => version.id === draftForm.resumeVersionId))) { setError('请先选择一个已保存的简历版本；仅收藏可用顶部「加入投递」。'); return }
    if (tracking.current) return
    tracking.current = true
    const request = detailRequest.current
    setTrackingBusy(true)
    setError(null)
    try {
      // Recheck before creating: another view may already have added this job.
      const fresh = await apiGet(`/job?id=${encodeURIComponent(detail.id)}`)
      if (request !== detailRequest.current) return
      if (fresh.job.application || fresh.job360?.application) {
        if (request === detailRequest.current) { setDetail({ ...fresh.job, application: fresh.job.application || fresh.job360.application }); setJob360(fresh.job360 ?? null); onNavigate?.('tracker', detail.id) }
        return
      }
      const res = await apiPost('/application', { jobId: detail.id, status: 'saved', ...(draft ? { resumeVersionId: draftForm.resumeVersionId, channel: draftForm.channel.trim() || undefined, nextActionAt: draftForm.nextActionAt || undefined, notes: draftForm.notes.trim() || undefined } : {}) })
      setDetail((current) => current?.id === detail.id ? { ...current, application: res.application ?? { status: 'saved' } } : current)
      setJob360((current) => current && detailRequest.current === request ? { ...current, application: res.application ?? { status: 'saved' } } : current)
      onChanged?.()
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      tracking.current = false
      setTrackingBusy(false)
    }
  }

  const visibleJobs = list?.jobs ?? []
  const total = list?.total ?? 0
  const pageOffset = list?.offset ?? offset
  const pageCount = list?.count ?? visibleJobs.length
  const cellStyle = { padding: '8px 10px', textAlign: 'left', verticalAlign: 'top', borderBottom: `1px solid ${T.border}` }
  const tableBody = h('div', { className: 'career-radar-table', style: { overflowX: 'auto', display: viewMode === 'table' ? 'block' : 'none' } },
    h('table', { style: { width: '100%', minWidth: 920, borderCollapse: 'collapse', ...S.body } },
      h('thead', null, h('tr', null, ['对比', '公司', '岗位', '类型', '城市', '状态', '截止', 'JD', '核验 / 操作'].map((label) => h('th', { key: label, scope: 'col', style: cellStyle }, label)))),
      h('tbody', null, visibleJobs.map((job) => h('tr', { key: job.id, style: { background: selected === job.id ? 'rgba(37,99,235,0.05)' : undefined } },
        h('td', { style: cellStyle }, h('input', {
          type: 'checkbox', checked: compareIds.includes(job.id), 'aria-label': `选择 ${radarText(job.title)} 加入对比`,
          onChange: () => setCompareIds((prev) => prev.includes(job.id) ? prev.filter((id) => id !== job.id) : (prev.length >= 5 ? prev : [...prev, job.id])),
        })),
        h('td', { style: cellStyle }, radarText(job.company ?? job.company_name)),
        h('td', { style: cellStyle }, h('button', { type: 'button', onClick: () => openDetail(job.id), style: { border: 0, background: 'none', color: T.accent, cursor: 'pointer', textAlign: 'left', padding: 0 } }, radarText(job.title))),
        h('td', { style: cellStyle }, radarRecruitLabels[radarValue(job, 'recruitType', 'recruit_type')] ?? '未知'),
        h('td', { style: cellStyle }, radarText(job.location)),
        h('td', { style: cellStyle }, h(Chip, { tone: job.status === 'OPEN' && !job.statusDisplay ? 'warn' : statusTone(job.status) }, radarStatus(job)), job.statusEvidenceLevel ? h('div', { style: S.muted }, `证据等级 ${radarNote(job.statusEvidenceLevel)}`) : null),
        h('td', { style: cellStyle }, job.deadline ? fmtDate(job.deadline) : '未知'),
        h('td', { style: cellStyle }, radarJD(job).label),
        h('td', { style: cellStyle }, h('div', { style: S.muted }, job.statusVerifiedAt || job.status_verified_at ? relTime(job.statusVerifiedAt ?? job.status_verified_at) : '核验未知'), h(Btn, { kind: 'ghost', onClick: () => openDetail(job.id) }, '详情 / 核验')))))))
  const listBody = list === null
    ? (error ? h(Empty, { title: '岗位加载失败', hint: '请刷新重试；没有把请求失败当作零岗位。' }) : h(Loading))
    : visibleJobs.length === 0
      ? h(Empty, { title: total === 0 ? '本地岗位库没有符合条件的岗位' : '本页暂无岗位', hint: '可调整条件重新检索或返回上一页；仅覆盖已入库的本地岗位，不代表全网没有岗位。' })
      : h('div', { className: `career-radar-results career-radar-view-${viewMode}` }, tableBody, h('div', { className: 'career-radar-cards', style: { ...S.col, display: viewMode === 'card' ? 'flex' : 'none' } }, visibleJobs.map((job) => h('div', {
          key: job.id,
          role: 'button', tabIndex: 0,
          onClick: () => openDetail(job.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(job.id) } },
          title: '查看岗位详情',
          style: {
            ...S.cardTight,
            cursor: 'pointer',
            borderColor: selected === job.id ? T.accent : T.border,
            background: selected === job.id ? 'rgba(37,99,235,0.05)' : T.surface,
          },
        },
          h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 8 } },
            h('div', { style: { ...S.col, gap: 2, minWidth: 0 } },
              h('div', { style: { ...S.body, fontSize: 16, fontWeight: 700 } }, radarText(job.title)),
              h('div', { style: S.body }, radarText(job.company ?? job.company_name)),
              h('div', { style: S.muted }, `地点 ${radarText(job.location)} · 薪酬 ${radarText(radarValue(job, 'salaryText', 'salary_text'))} · ${radarRecruitLabels[radarValue(job, 'recruitType', 'recruit_type')] ?? '招聘类型未知'}`),
              h('div', { style: S.muted }, `学历 / 毕业要求 ${radarText(radarValue(job, 'gradeLimit', 'grade_limit'))} · 每周 ${radarValue(job, 'daysPerWeek', 'days_per_week') ? `${radarValue(job, 'daysPerWeek', 'days_per_week')} 天` : '出勤未知'} · 时长 ${radarText(job.duration)}`),
              h('div', { style: { ...S.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }, title: radarText(job.requirementsSummary ?? job.requirements) }, `要求：${radarText(job.requirementsSummary ?? job.requirements)}`),
              h('div', { style: S.muted }, `截止 ${job.deadline ? fmtDate(job.deadline) : '未知'} · 来源 ${radarText(job.sourceName ?? job.source_name ?? job.sources?.[0]?.source_name ?? job.sources?.[0]?.source_type)} · 核验 ${job.statusVerifiedAt || job.status_verified_at ? relTime(job.statusVerifiedAt ?? job.status_verified_at) : '未知'}`),
              h('div', { style: { ...S.muted, color: radarJD(job).complete ? T.success : T.warn } }, radarJD(job).label)),
            h('div', { style: { ...S.row, gap: 6 } },
              h(Chip, { tone: job.status === 'OPEN' && !job.statusDisplay ? 'warn' : statusTone(job.status) }, radarStatus(job)),
              job.statusEvidenceLevel ? h(Chip, null, `证据 ${radarNote(job.statusEvidenceLevel)}`) : null,
              job.matchReliable === false ? h(Chip, { tone: 'warn' }, '匹配待核对（信息不足）') : h(Score, { value: job.matchScore }))),
        ))))

  // Comparison renders as arrays to keep nesting shallow and reviewable.
  const compareCellText = (v) => (v === null || v === undefined || v === '' ? '未知' : v === true ? '是' : v === false ? '否' : String(v))
  const compareTable = (() => {
    if (!compareData) return h(Loading, { label: '对比中…' })
    const header = h('tr', null, [
      h('th', { key: 'field', scope: 'col', style: cellStyle }, '字段'),
      ...compareData.jobs.map((j) => h('th', { key: j.id, scope: 'col', style: cellStyle }, `${j.company} · ${j.title}`)),
    ])
    const fieldRows = compareData.differences.map((d) => h('tr', { key: d.key, style: { background: d.differs ? undefined : 'rgba(0,0,0,0.02)' } }, [
      h('th', { key: 'l', scope: 'row', style: cellStyle }, d.label),
      ...d.values.map((v, i) => h('td', { key: i, style: cellStyle }, compareCellText(v))),
    ]))
    const reasonRow = h('tr', { key: 'reasons' }, [
      h('th', { key: 'l', scope: 'row', style: cellStyle }, '主要理由'),
      ...compareData.jobs.map((j) => h('td', { key: j.id, style: cellStyle }, (j.reasons ?? []).length
        ? (j.reasons ?? []).map((r, i) => h('div', { key: i, style: S.muted }, `· ${r}`))
        : '暂无')),
    ])
    const riskRow = h('tr', { key: 'risks' }, [
      h('th', { key: 'l', scope: 'row', style: cellStyle }, '风险 / 未确认'),
      ...compareData.jobs.map((j) => h('td', { key: j.id, style: cellStyle }, [...(j.risks ?? []), ...(j.unknowns ?? [])].slice(0, 3).map((r, i) => h('div', { key: i, style: S.muted }, `· ${r}`)))),
    ])
    return h('div', { style: { overflowX: 'auto' } },
      h('table', { style: { width: '100%', minWidth: 640, borderCollapse: 'collapse', ...S.body } },
        h('thead', null, header),
        h('tbody', null, fieldRows, reasonRow, riskRow)),
      h('div', { style: { ...S.muted, marginTop: 8, fontSize: 11 } }, (compareData.caveats ?? []).join(' ')))
  })()

  return h('div', { style: S.col },
    error ? h('div', { style: { ...S.card, borderColor: T.error, ...S.muted, color: T.error } }, error) : null,

    h('header', null, h('div', { style: S.h2 }, '找岗位'),
      h('div', { style: S.muted }, '本地岗位池 · 搜索仅覆盖已入库岗位，不代表全网在招；未覆盖未采集的招聘官网与第三方平台。')),

    h('div', { style: S.card },
      h('div', { style: { ...S.row, flexWrap: 'wrap', justifyContent: 'space-between' } },
        h('div', { style: S.h2 }, '岗位库'),
        h('div', { style: { ...S.row, flexWrap: 'wrap' } },
          h('input', { style: { ...S.input, width: 190 }, value: query, onChange: (e) => changeCondition(setQuery, e.target.value), placeholder: '搜索公司/岗位/JD 关键词' }),
          h('select', { style: { ...S.input, width: 130 }, value: status, onChange: (e) => changeCondition(setStatus, e.target.value) },
            h('option', { value: '' }, '全部状态'),
            ['OPEN', 'UPCOMING', 'UNVERIFIED', 'STALE', 'CLOSED', 'UNKNOWN'].map((s) => h('option', { key: s, value: s }, radarStatusLabels[s]))),
          h('input', { 'aria-label': '城市（全库，可逗号分隔）', style: { ...S.input, width: 160 }, value: city, onChange: (e) => changeCondition(setCity, e.target.value), placeholder: '城市：北京,上海' }),
          h('select', { 'aria-label': '招聘类型（全库）', style: { ...S.input, width: 140 }, value: recruit, onChange: (e) => changeCondition(setRecruit, e.target.value) },
            h('option', { value: '' }, '全部招聘类型'),
            Object.entries(radarRecruitLabels).map(([key, label]) => h('option', { key, value: key }, label))),
          h('label', { style: { ...S.row, ...S.muted } }, h('input', { type: 'checkbox', checked: completeOnly, onChange: (e) => changeCondition(setCompleteOnly, e.target.checked) }), '只看完整 JD'),
          h('input', { 'aria-label': '最低匹配分', style: { ...S.input, width: 100 }, value: minScore, onChange: (e) => changeCondition(setMinScore, e.target.value), placeholder: '最低分' }),
          h('select', { 'aria-label': '用工形式', style: { ...S.input, width: 120 }, value: remoteType, onChange: (e) => changeCondition(setRemoteType, e.target.value) },
            h('option', { value: '' }, '全部用工形式'), [['onsite', '现场'], ['remote', '远程'], ['hybrid', '混合']].map(([value, label]) => h('option', { key: value, value }, label))),
          h('input', { 'aria-label': '毕业年份', type: 'number', style: { ...S.input, width: 110 }, value: gradYear, onChange: (e) => changeCondition(setGradYear, e.target.value), placeholder: '毕业年份' }),
          h('input', { 'aria-label': '每周最多出勤天数', type: 'number', min: 1, max: 7, style: { ...S.input, width: 140 }, value: daysPerWeekMax, onChange: (e) => changeCondition(setDaysPerWeekMax, e.target.value), placeholder: '每周最多天数' }),
          h(Btn, { kind: 'ghost', onClick: load }, '刷新'),
          h(Btn, {
            disabled: compareIds.length < 2,
            onClick: () => {
              setCompareError(null); setCompareOpen(true); setCompareData(null)
              apiGet(`/jobs/compare?ids=${encodeURIComponent(compareIds.join(','))}`)
                .then((res) => setCompareData(res))
                .catch((err) => setCompareError(`对比失败：${err.message}`))
            },
          }, `对比选中（${compareIds.length}/5）`))),
      h('div', { style: { ...S.row, flexWrap: 'wrap', margin: '6px 0', justifyContent: 'space-between' } },
        h('div', { style: S.muted, role: 'status' }, loading ? '正在更新岗位…' : `本地全库符合 ${total} 条 · 本页 ${pageCount} 条 · 当前范围 ${pageCount ? pageOffset + 1 : 0}–${pageOffset + pageCount}；每页 ${limit} 条。`),
        h('div', { style: S.row },
          h(Btn, { kind: 'ghost', 'aria-pressed': viewMode === 'table', onClick: () => setViewMode('table') }, '紧凑表格'),
          h(Btn, { kind: 'ghost', 'aria-pressed': viewMode === 'card', onClick: () => setViewMode('card') }, '卡片'))),
      h('div', { style: S.muted }, list?.scope ?? '所有条件由本地岗位全库检索后分页；未访问第三方招聘平台，不代表全网。'),
      listBody,
      h('nav', { 'aria-label': '岗位分页', style: { ...S.row, justifyContent: 'flex-end', marginTop: 10 } },
        h(Btn, { kind: 'ghost', disabled: loading || offset === 0, onClick: () => setOffset(Math.max(0, offset - limit)) }, '上一页'),
        h('span', { style: S.muted }, `第 ${Math.floor(offset / limit) + 1} / ${Math.max(1, Math.ceil(total / limit))} 页`),
        h(Btn, { kind: 'ghost', disabled: loading || offset + limit >= total, onClick: () => setOffset(offset + limit) }, '下一页'))),

    h('details', { style: S.card },
      h('summary', { style: { ...S.h3, cursor: 'pointer' } }, '添加岗位'),
      h('div', { style: { ...S.muted, margin: '8px 0' } }, '先浏览与筛选；需要补充岗位时，再选择平台采集、粘贴 JD 或高级公开页抓取。'),
      h(Btn, { onClick: () => onNavigate?.('social') }, '去平台采集'),
    h('div', { style: S.card },
      h('div', { style: S.h2 }, '高级：从公开招聘页抓取'),
      h('div', { style: { ...S.muted, marginBottom: 8 } },
        '贴上公司校招/社招列表页地址，系统会解析 JSON-LD、页面内嵌数据或岗位链接，自动带出岗位名、工作地点、投递地址与截止日期。先预览再入库。只抓 robots.txt 允许的公开页面；纯前端渲染的站点会提示改用手动粘贴。'),
      h('div', { style: S.grid(200) },
        h(Field, { label: '列表页 URL' },
          h('input', {
            style: S.input, value: crawlUrl,
            placeholder: 'https://jobs.example.com/campus',
            onChange: (e) => setCrawlUrl(e.target.value),
          })),
        h(Field, { label: '公司名（可留空，页面有则用页面的）' },
          h('input', { style: S.input, value: crawlCompany, onChange: (e) => setCrawlCompany(e.target.value) })),
        h(Field, { label: '招聘类型' },
          h('select', { style: S.input, value: crawlRecruit, onChange: (e) => setCrawlRecruit(e.target.value) },
            h('option', { value: '' }, '自动判断'),
            h('option', { value: 'autumn_campus' }, '秋招'),
            h('option', { value: 'spring_campus' }, '春招'),
            h('option', { value: 'summer' }, '暑期实习'),
            h('option', { value: 'daily' }, '日常实习')))),
      h('div', { style: { ...S.row, marginTop: 8 } },
        h(Btn, {
          kind: 'primary',
          disabled: crawling || !crawlUrl.trim(),
          onClick: () => {
            setCrawling(true)
            setError(null)
            apiPost('/crawl', {
              url: crawlUrl.trim(), company: crawlCompany.trim() || undefined,
              recruitType: crawlRecruit || undefined, dryRun: true,
            })
              .then(setCrawlResult)
              .catch((err) => setError(err.message))
              .finally(() => setCrawling(false))
          },
        }, crawling ? '抓取中…' : '抓取预览'),
        crawlResult
          ? h(Btn, {
            onClick: () => {
              setCrawling(true)
              apiPost('/crawl', {
                url: crawlUrl.trim(), company: crawlCompany.trim() || undefined,
                recruitType: crawlRecruit || undefined, dryRun: false,
              })
                .then((res) => { setCrawlResult(res); load(); onChanged?.() })
                .catch((err) => setError(err.message))
                .finally(() => setCrawling(false))
            },
          }, '确认入库')
          : null),
      crawlResult
        ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
          h('div', { style: S.muted },
            `共识别 ${crawlResult.results.reduce((n, r) => n + (r.count ?? 0), 0)} 条；`
            + `新建 ${crawlResult.totals.created}，合并 ${crawlResult.totals.merged}`
            + (crawlResult.dryRun ? '（预览，未写入）' : '')),
          crawlResult.results.map((res) => h('div', { key: res.url, style: { marginTop: 8 } },
            h('div', { style: { ...S.mono, wordBreak: 'break-all' } }, `${res.url} · ${res.ok ? res.strategy : '失败'}`),
            res.ok === false ? h('div', { style: { ...S.muted, color: T.error } }, res.error) : null,
            (res.warnings ?? []).map((w, i) => h('div', { key: i, style: { ...S.muted, color: T.warn } }, `! ${w}`)),
            (res.postings ?? []).slice(0, 12).map((p, i) => h('div', {
              key: `p${i}`,
              style: { ...S.row, justifyContent: 'space-between', gap: 6, marginTop: 3 },
            },
              h('span', { style: { ...S.body, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                `${p.company ? `${p.company} · ` : ''}${p.title}`),
              h('span', { style: { ...S.row, gap: 6 } },
                h(Chip, null, p.location || '地点未知'),
                p.applyUrl
                  ? h('a', {
                    href: p.applyUrl, target: '_blank', rel: 'noreferrer',
                    style: { ...S.muted, color: T.accent },
                  }, '投递页')
                  : null))))))
        : null),

    h('div', { style: S.card },
      h('div', { style: S.h2 }, '新增岗位'),
      h('div', { style: { ...S.muted, marginBottom: 8 } }, '粘贴 JD 原文即可自动解析地点/技能/截止日；同一岗位从不同来源重复保存会自动合并。'),
      h('div', { style: S.grid(180) },
        h(Field, { label: '公司 *' }, h('input', { style: S.input, value: form.company, onChange: (e) => setForm({ ...form, company: e.target.value }) })),
        h(Field, { label: '岗位 *' }, h('input', { style: S.input, value: form.title, onChange: (e) => setForm({ ...form, title: e.target.value }) })),
        h(Field, { label: '原始链接' }, h('input', { style: S.input, value: form.url, onChange: (e) => setForm({ ...form, url: e.target.value }) }))),
      h('div', { style: { marginTop: 8 } },
        h(Field, { label: 'JD 原文（可选，强烈建议）' },
          h('textarea', { style: S.textarea, value: form.jdText, onChange: (e) => setForm({ ...form, jdText: e.target.value }), placeholder: '粘贴岗位描述与要求…' }))),
      h('div', { style: { ...S.row, marginTop: 8, justifyContent: 'space-between' } },
        h('label', { style: { ...S.row, ...S.muted, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: form.official, onChange: (e) => setForm({ ...form, official: e.target.checked }) }),
          '此信息来自官方招聘页（可更新招聘状态）'),
        h(Btn, { kind: 'primary', disabled: busy, onClick: saveJob }, busy ? '保存中…' : '保存岗位')))),

    compareOpen
      ? h(Modal, {
        title: '岗位对比', subtitle: '逐字段对比，不给总分排名；未知表示记录里没有，不代表企业没提供。', width: 980,
        onClose: () => { setCompareOpen(false); setCompareData(null); setCompareError(null) },
      },
        compareError ? h('div', { role: 'alert', style: { ...S.card, color: T.error } }, compareError) : null,
        compareTable)
      : null,

    detailOpen
      ? h(Modal, {
        title: detail ? `${radarText(detail.title)} · ${radarText(detail.company_name)}` : '岗位详情',
        subtitle: detail
          ? `状态核验：${detail.status_verified_at ? relTime(detail.status_verified_at) : '从未核验'} · 来源 ${detail.sources?.length ?? 0} 条 · 状态变更 ${detail.history?.length ?? 0} 次`
          : '加载中…',
        onClose: () => { detailRequest.current++; setDetailOpen(false); setSelected(null) },
      },
        !detail ? (error ? h('div', { style: S.col }, h('div', { role: 'alert', style: { ...S.muted, color: T.error } }, error), h(Btn, { onClick: () => openDetail(selected) }, '重试岗位详情')) : h(Loading)) : h('div', { style: S.col },
          error ? h('div', { role: 'alert', style: { ...S.muted, color: T.error } }, error) : null,
          // ① 顶部：状态 + 关键动作
          h('div', { style: { ...S.row, justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 } },
            h('div', { style: S.row },
              h(Chip, { tone: statusTone(detail.status) }, radarStatus(detail)),
              detail.deadlineInDays !== null && detail.deadlineInDays !== undefined
                ? h(Chip, { tone: detail.deadlineInDays < 0 ? 'error' : detail.deadlineInDays <= 7 ? 'warn' : undefined },
                  detail.deadlineInDays < 0 ? `已过截止 ${Math.abs(detail.deadlineInDays)} 天` : `距截止 ${detail.deadlineInDays} 天`)
                : null),
            h('div', { style: S.row },
              detail.apply_url || detail.sources?.[0]?.source_url
                ? h('a', {
                  href: detail.apply_url || detail.sources[0].source_url, target: '_blank', rel: 'noreferrer',
                  style: { ...S.muted, color: T.accent },
                }, '原始招聘页')
                : null,
              h(Btn, { onClick: () => onNavigate?.('studio', detail.id) }, '准备简历'),
              h(Btn, { onClick: () => onNavigate?.('interview', detail.id) }, 'JD 面试准备'),
              h(Btn, { kind: 'primary', disabled: trackingBusy, onClick: () => track(false) }, trackingBusy ? '处理中…' : detail.application || job360?.application ? '查看投递进度' : '加入投递'),
              h(Btn, { disabled: deletingJob, onClick: () => confirmDeleteJob ? deleteThisJob() : setConfirmDeleteJob(true) }, deletingJob ? '删除中…' : confirmDeleteJob ? '再次点击确认删除岗位' : '删除岗位'))),
          confirmDeleteJob ? h('div', { style: { ...S.muted, color: T.warn } }, '将删除该岗位及其来源、状态历史、匹配与笔记；已有投递保留但解除绑定，知识库条目不会被自动删除。不可撤销。') : null,

          h('div', { style: S.muted }, `来源状态：${radarStatus(detail)} · 证据等级 ${radarNote(detail.statusEvidenceLevel || '未知')} · 核验 ${detail.status_verified_at ? relTime(detail.status_verified_at) : '未知'} · ${radarJD(detail).label}`),
          h('div', { style: S.muted }, `主要来源：${radarText(detail.sources?.[0]?.source_name ?? detail.sources?.[0]?.source_type)}；${detail.sources?.[0]?.verification_status ?? '核验状态未知'}`),
          h('div', { style: { ...S.muted, whiteSpace: 'pre-wrap' } }, `硬条件（仅展示已记录事实）：学历 / 毕业要求 ${radarText(detail.grade_limit)} · 专业 ${radarText(detail.major_limit)} · 每周出勤 ${detail.days_per_week ? `${detail.days_per_week} 天` : '未知'} · 时长 ${radarText(detail.duration)}`),

          h('details', { style: S.cardTight, 'data-job360': 'match' },
            h('summary', { style: { ...S.h3, cursor: 'pointer' } }, '个人匹配 · Eligibility / Fit / Evidence · 资格、偏好与证据'),
            !assessment ? h('div', null, h('div', { style: S.muted }, '尚无个人匹配评估，请确认画像并补全 JD 后重新检查。'), h(Btn, { onClick: () => onNavigate?.('resume') }, '完善求职画像')) : null,
            h('div', { style: S.muted }, `画像确认：${radarAssessmentText(assessment?.profileConfirmation)}；资格、偏好分与证据可靠性分别展示，匹配分不是录用概率。`),
            h('div', { style: S.grid(240) },
              h('section', null, h('div', { style: S.h3 }, 'Eligibility · 硬性资格'),
                h('div', { style: S.muted }, `结论：${radarAssessmentText(assessment?.eligibility?.status)}`),
                (assessment?.eligibility?.checks ?? []).map((check, i) => h('div', { key: i, style: { ...S.muted, marginTop: 6 } },
                  `${radarAssessmentText(check.label)} · ${radarAssessmentText(check.status)} · ${radarAssessmentText(check.explanation)}`,
                  h('div', null, `岗位依据：${radarAssessmentText(check.jobEvidence)}`),
                  h('div', null, `画像依据：${radarAssessmentText(check.profileEvidence)}`)))),
              h('section', null, h('div', { style: S.h3 }, 'Fit · 偏好匹配'),
                h('div', { style: S.muted }, `匹配分：${radarAssessmentText(assessment?.fit?.score)}${assessment?.fit?.reliable === false ? '（不可靠，仅供参考，请补全画像 / JD）' : ''} · 可靠：${radarAssessmentText(assessment?.fit?.reliable)}`),
                h('div', { style: S.muted }, radarAssessmentText(assessment?.fit?.scoreMeaning)),
                h('div', { style: S.muted }, `维度：${radarAssessmentText(assessment?.fit?.breakdown)}`),
                h('div', { style: S.muted }, `理由：${radarAssessmentText(assessment?.fit?.reasons)}`),
                h('div', { style: S.muted }, `不确定性：${radarAssessmentText(assessment?.fit?.uncertainty)}`)),
              h('section', null, h('div', { style: S.h3 }, 'Evidence · 证据可靠性'),
                h('div', { style: S.muted }, `JD 完整：${radarAssessmentText(assessment?.evidence?.textComplete)}`),
                h('div', { style: S.muted }, `官方来源：${radarAssessmentText(assessment?.evidence?.officialSource)}`),
                h('div', { style: S.muted }, `状态评估：${radarAssessmentText(assessment?.evidence?.statusAssessment)}`),
                h('div', { style: S.muted }, `最近观测：${radarAssessmentText(assessment?.evidence?.latestObservation)}`))),
            h('div', { style: { ...S.muted, marginTop: 8 } }, `未知信息：${radarAssessmentText(assessment?.unknowns)}`),
            h('div', { style: S.h3 }, '任务分析（保留来源标签，不代表官方结论）'),
            (assessment?.taskAnalysis?.tasks ?? []).map((task, i) => h('div', { key: i, style: S.muted }, `${radarAssessmentText(task.text)} · ${radarAssessmentText(task.label)} · 来源字段 ${radarAssessmentText(task.sourceField)}`)),
            h('div', { style: S.muted }, `任务分析未知项：${radarAssessmentText(assessment?.taskAnalysis?.unknowns)}`),
            h('div', { style: S.muted }, `理由：${radarAssessmentText(assessment?.decision?.reasons)}`),
            h('div', { style: S.muted }, `风险：${radarAssessmentText(assessment?.decision?.risks)}`),
            h('div', { style: S.muted }, `决策未知项：${radarAssessmentText(assessment?.decision?.unknowns)}`),
            h('div', { style: S.muted }, `下一步：${radarAssessmentText(assessment?.decision?.nextActions)}`)),

          radarJob360Company(job360, detail, onNavigate),
          radarJob360Preparation(job360, detail, draftForm, setDraftForm, () => track(true), trackingBusy, onNavigate),

          h('details', { style: S.cardTight, open: true, 'data-job360': 'job' },
          h('summary', { style: { ...S.h3, cursor: 'pointer' } }, '岗位信息 · 职责与硬条件'),
          // ④ JD 正文（没有就诚实说明，并指路）
          detail.description || detail.requirements
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '工作职责'),
              detail.description
                ? h('div', { style: { ...S.body, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' } }, detail.description)
                : h('div', { style: S.muted }, '工作职责未知：未存入正文。'),
              detail.requirements
                ? h('div', { style: { marginTop: 8 } },
                  h('div', { style: { ...S.muted, fontWeight: 600 } }, '任职要求'),
                  h('div', { style: { ...S.body, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' } }, detail.requirements))
                : h('div', { style: S.muted }, '任职要求未知：未存入正文。'))
            : h('div', { style: { ...S.cardTight, marginTop: 10, borderColor: T.warn } },
              h('div', { style: S.h3 }, '岗位描述'),
              h('div', { style: S.muted }, 'JD 正文未知：尚未存入职责与任职要求，无法判断具体缺失原因；请到原始招聘页核对或补充正文。'),
              h('div', { style: { ...S.muted, marginTop: 4 } },
                detail.apply_url ? '点上方「原始招聘页」核对完整 JD。' : '建议到官网搜索该岗位编号查看完整 JD。'),
              h(Btn, { onClick: () => onNavigate?.('social', detail.id) }, '去知识库补充岗位正文')),

          // ② 基本信息（未知显式呈现）
          h('div', { style: { ...S.cardTight, marginTop: 10 } },
            h('div', { style: S.h3 }, '基本信息'),
            h('div', { style: S.grid(260) },
              h(KV, { label: '公司' }, radarText(detail.company_name)),
              h(KV, { label: '岗位' }, radarText(detail.title)),
              h(KV, { label: '岗位编号' }, radarText(detail.job_code)),
              h(KV, { label: '招聘批次' }, radarRecruitLabels[detail.recruit_type] ?? '未知'),
              h(KV, { label: '工作地点' }, radarText(detail.location)),
              h(KV, { label: '部门/业务线' }, radarText(detail.department || detail.business_unit)),
              h(KV, { label: '实习类型' }, radarText(detail.internship_type)),
              h(KV, { label: '用工形式' }, radarText(detail.remote_type)),
              h(KV, { label: '截止日期' }, detail.deadline ? fmtDate(detail.deadline) : '未知'),
              h(KV, { label: '发布时间' }, detail.published_at ? fmtDate(detail.published_at) : '未知'),
              h(KV, { label: '学历要求' }, radarText(detail.grade_limit)),
              h(KV, { label: '专业要求' }, radarText(detail.major_limit)),
              h(KV, { label: '语言要求' }, radarText(detail.language_req)),
              h(KV, { label: '实习时长' }, radarText(detail.duration)),
              h(KV, { label: '每周出勤' }, detail.days_per_week ? `${detail.days_per_week} 天` : '未知'),
              h(KV, { label: '预计开始' }, detail.start_date ? fmtDate(detail.start_date) : '未知'),
              h(KV, { label: '薪酬' }, radarText(detail.salary_text)),
              h(KV, { label: '可转正' }, detail.conversion_possible === true ? '公开说明可转正' : '未知（未记录明确转正承诺）'))),
          (detail.skills ?? []).length
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '技能要求'),
              h('div', { style: { ...S.row, flexWrap: 'wrap', marginTop: 4 } }, detail.skills.map((s) => h(Chip, { key: s }, s))))
            : null),

          // ③ 匹配解释
          detail.match?.reasons || detail.match?.score !== undefined && detail.match?.score !== null
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '匹配解释'),
              h('div', { style: S.muted }, detail.matchReliable === false || assessment?.fit?.reliable === false ? '匹配信息不足，历史分数不作为可靠结论；请核对个人匹配评估。' : `匹配分 ${detail.match?.score ?? '未评分'}（与偏好的匹配度，不是录用概率）`),
              (detail.match?.reasons?.matched ?? []).slice(0, 6).map((m, i) => h('div', { key: `m${i}`, style: { ...S.muted, color: T.success } }, `✓ ${m}`)),
              (detail.match?.reasons?.missing ?? []).slice(0, 6).map((m, i) => h('div', { key: `x${i}`, style: { ...S.muted, color: T.warn } }, `! ${m}`)),
              (detail.match?.reasons?.unknown ?? []).slice(0, 4).map((m, i) => h('div', { key: `u${i}`, style: S.muted }, `? ${m}`)))
            : null,

          // Secondary evidence and administrative controls remain available, collapsed by default.
          h('details', { style: S.cardTight },
            h('summary', { style: { ...S.h3, cursor: 'pointer' } }, '来源证据、历史与状态维护'),
          // ⑤ 来源与历史
          detail.sources?.length
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '来源证据'),
              detail.sources.map((s) => h('div', { key: s.id, style: { ...S.muted, marginBottom: 4, wordBreak: 'break-all' } },
                h(Chip, { tone: s.confidence_level === 'A' ? 'success' : undefined }, s.confidence_level ?? '未知'),
                ` ${s.source_type} · ${s.verification_status ?? 'unverified'} · ${fmtDate(s.retrieved_at)}`,
                s.source_url ? h('a', { href: s.source_url, target: '_blank', rel: 'noreferrer', style: { color: T.accent, marginLeft: 6 } }, '打开') : null)))
            : null,
          detail.history?.length
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '状态历史'),
              detail.history.map((row) => h('div', { key: row.id, style: { ...S.muted, marginBottom: 3 } },
                `${fmtDate(row.verified_at)} · ${row.previous_status ?? '—'} → ${row.status}${row.evidence ? ` · ${row.evidence}` : ''}`)))
            : null,
          (detail.notes ?? []).length
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '备注'),
              detail.notes.map((n) => h('div', { key: n.id, style: { ...S.muted, marginBottom: 4 } }, `${fmtDate(n.created_at)} · ${n.body}`)))
            : null,

          // ⑥ 状态标记
          h('div', { style: { ...S.cardTight, marginTop: 10 } },
            h('div', { style: S.h3 }, '标记招聘状态'),
            error ? h('div', { role: 'alert', style: { ...S.muted, color: T.error } }, error) : null,
            h(Field, { label: '官方来源链接（HTTPS）' }, h('input', { 'aria-label': '核验官方来源链接', style: S.input, value: verifySourceUrl, placeholder: 'https://公司官方招聘页', onChange: (e) => setVerifySourceUrl(e.target.value) })),
            h(Field, { label: '原文证据摘录' }, h('textarea', { 'aria-label': '核验证据摘录', style: S.textarea, value: verifyEvidence, placeholder: '粘贴支持该状态的官方原文摘录', onChange: (e) => setVerifyEvidence(e.target.value) })),
            h('div', { style: { ...S.row, flexWrap: 'wrap' } },
              [['OPEN', true], ['CLOSED', true], ['UPCOMING', true], ['UNVERIFIED', false], ['STALE', false]].map(([s, off]) =>
                h(Btn, { key: s, kind: 'ghost', onClick: () => verify(s, off) }, `${radarStatusLabels[s]}${off ? '（官方）' : ''}`))),
            h('div', { style: { ...S.muted, marginTop: 6 } }, '只有 HTTPS 官方来源链接及证据摘录通过核验后，才可改为 OPEN/CLOSED/UPCOMING；非官方来源最多把 UNKNOWN 升为 UNVERIFIED。')))))
      : null)
}
