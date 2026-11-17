// ─── Internship Radar ────────────────────────────────────────────────────────
function RadarTab({ focusCode, onChanged }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [minScore, setMinScore] = useState('')
  const [list, setList] = useState(null)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailOpen, setDetailOpen] = useState(false)
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
    params.set('limit', '120')
    setError(null)
    apiGet(`/jobs?${params.toString()}`).then(setList).catch((err) => setError(err.message))
  }, [query, status, minScore])

  useEffect(load, [load])

  const openDetail = useCallback((id) => {
    setSelected(id)
    setDetail(null)
    setDetailOpen(true)
    apiGet(`/job?id=${encodeURIComponent(id)}`).then((res) => setDetail(res.job)).catch((err) => setError(err.message))
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
    try {
      await apiPost('/job/verify', { id: selected, status: nextStatus, official })
      openDetail(selected)
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  const track = async () => {
    if (!detail) return
    try {
      await apiPost('/application', { jobId: detail.id, status: 'saved', channel: '官网' })
      onChanged?.()
      openDetail(detail.id)
    } catch (err) {
      setError(err.message)
    }
  }

  const listBody = list === null
    ? h(Loading)
    : list.jobs.length === 0
      ? h(Empty, { title: '没有符合条件的结果', hint: '换个关键词，或先保存/同步岗位。空白默认表示「未筛选」，不是「没有岗位」。' })
      : h('div', { style: S.col }, list.jobs.map((job) => h('div', {
          key: job.id,
          onClick: () => openDetail(job.id),
          onDoubleClick: () => openDetail(job.id),
          title: '单击或双击查看完整岗位详情',
          style: {
            ...S.cardTight,
            cursor: 'pointer',
            borderColor: selected === job.id ? T.accent : T.border,
            background: selected === job.id ? 'rgba(37,99,235,0.05)' : T.surface,
          },
        },
          h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 8 } },
            h('div', { style: { ...S.col, gap: 2, minWidth: 0 } },
              h('div', { style: { ...S.body, fontWeight: 600 } }, `${job.company} · ${job.title}`),
              h('div', { style: { ...S.muted } }, [job.location || '地点未知', job.department, `截止 ${fmtDate(job.deadline)}`].filter(Boolean).join(' · ')),
              h('div', { style: { ...S.muted, fontSize: 11 } },
                [
                  `匹配 ${job.matchScore ?? '未评分'}`,
                  `证据 ${job.confidence ?? job.confidence_level ?? '—'}`,
                  `状态 ${job.statusLabel ?? job.status}`,
                  `核验 ${relTime(job.statusVerifiedAt ?? job.status_verified_at) || '从未'}`,
                ].join(' · '))),
            h('div', { style: { ...S.row, gap: 6 } },
              h(Chip, { tone: statusTone(job.status) }, job.statusLabel),
              h(Score, { value: job.matchScore }))),
        )))

  return h('div', { style: S.col },
    error ? h('div', { style: { ...S.card, borderColor: T.error, ...S.muted, color: T.error } }, error) : null,

    h('div', { style: S.card },
      h('div', { style: S.h2 }, '从招聘页批量抓取（秋招/校招）'),
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
        h(Btn, { kind: 'primary', disabled: busy, onClick: saveJob }, busy ? '保存中…' : '保存岗位'))),

    h('div', { style: S.card },
      h('div', { style: { ...S.row, flexWrap: 'wrap', justifyContent: 'space-between' } },
        h('div', { style: S.h2 }, '岗位库'),
        h('div', { style: { ...S.row, flexWrap: 'wrap' } },
          h('input', { style: { ...S.input, width: 190 }, value: query, onChange: (e) => setQuery(e.target.value), placeholder: '搜索公司/岗位/JD 关键词' }),
          h('select', { style: { ...S.input, width: 130 }, value: status, onChange: (e) => setStatus(e.target.value) },
            h('option', { value: '' }, '全部状态'),
            ['OPEN', 'UPCOMING', 'UNVERIFIED', 'STALE', 'CLOSED', 'UNKNOWN'].map((s) => h('option', { key: s, value: s }, s))),
          h('input', { style: { ...S.input, width: 100 }, value: minScore, onChange: (e) => setMinScore(e.target.value), placeholder: '最低分' }),
          h(Btn, { kind: 'ghost', onClick: load }, '刷新'))),
      h('div', { style: { ...S.muted, margin: '6px 0' } }, list?.scope ?? '仅检索本地库；未访问第三方招聘平台。'),
      listBody),

    detailOpen
      ? h(Modal, {
        title: detail ? `${detail.company_name} · ${detail.title}` : '岗位详情',
        subtitle: detail
          ? `状态核验：${detail.status_verified_at ? relTime(detail.status_verified_at) : '从未核验'} · 来源 ${detail.sources?.length ?? 0} 条 · 状态变更 ${detail.history?.length ?? 0} 次`
          : '加载中…',
        onClose: () => { setDetailOpen(false); setSelected(null) },
      },
        !detail ? h(Loading) : h('div', { style: S.col },

          // ① 顶部：状态 + 关键动作
          h('div', { style: { ...S.row, justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 } },
            h('div', { style: S.row },
              h(Chip, { tone: statusTone(detail.status) }, detail.statusLabel ?? detail.status),
              detail.deadlineInDays !== null && detail.deadlineInDays !== undefined
                ? h(Chip, { tone: detail.deadlineInDays < 0 ? 'error' : detail.deadlineInDays <= 7 ? 'warn' : undefined },
                  detail.deadlineInDays < 0 ? `已过截止 ${Math.abs(detail.deadlineInDays)} 天` : `距截止 ${detail.deadlineInDays} 天`)
                : null),
            h('div', { style: S.row },
              detail.apply_url || detail.sources?.[0]?.source_url
                ? h('a', {
                  href: detail.apply_url || detail.sources[0].source_url, target: '_blank', rel: 'noreferrer',
                  style: { ...S.btn('primary'), textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
                }, '去投递页')
                : null,
              h(Btn, { kind: 'primary', onClick: track }, detail.application ? '已在投递中' : '加入投递'))),

          // ② 基本信息（空值自动跳过，不显示成 —）
          h('div', { style: { ...S.cardTight, marginTop: 10 } },
            h('div', { style: S.h3 }, '基本信息'),
            h('div', { style: S.grid(260) },
              h(KV, { label: '公司' }, detail.company_name),
              h(KV, { label: '岗位' }, detail.title),
              h(KV, { label: '岗位编号' }, detail.job_code),
              h(KV, { label: '招聘批次' }, (detail.recruit_type ? ({ autumn_campus: '秋招', spring_campus: '春招', summer: '暑期实习', daily: '日常实习', other: '其他' }[detail.recruit_type] ?? detail.recruit_type) : null)),
              h(KV, { label: '工作地点' }, detail.location),
              h(KV, { label: '部门/业务线' }, detail.department || detail.business_unit),
              h(KV, { label: '实习类型' }, detail.internship_type),
              h(KV, { label: '用工形式' }, detail.remote_type),
              h(KV, { label: '截止日期' }, detail.deadline ? fmtDate(detail.deadline) : null),
              h(KV, { label: '发布时间' }, detail.published_at ? fmtDate(detail.published_at) : null),
              h(KV, { label: '学历要求' }, detail.grade_limit),
              h(KV, { label: '专业要求' }, detail.major_limit),
              h(KV, { label: '语言要求' }, detail.language_req),
              h(KV, { label: '实习时长' }, detail.duration),
              h(KV, { label: '每周出勤' }, detail.days_per_week ? `${detail.days_per_week} 天` : null),
              h(KV, { label: '预计开始' }, detail.start_date ? fmtDate(detail.start_date) : null),
              h(KV, { label: '薪酬' }, detail.salary_text),
              h(KV, { label: '可转正' }, detail.conversion_possible === true ? '公开说明可转正' : (detail.conversion_possible === false ? '未说明' : null)))),
          (detail.skills ?? []).length
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '技能要求'),
              h('div', { style: { ...S.row, flexWrap: 'wrap', marginTop: 4 } }, detail.skills.map((s) => h(Chip, { key: s }, s))))
            : null,

          // ③ 匹配解释
          detail.match?.reasons || detail.match?.score !== undefined && detail.match?.score !== null
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '匹配解释'),
              h('div', { style: S.muted }, `匹配分 ${detail.match?.score ?? '未评分'}（与偏好的匹配度，不是录用概率）`),
              (detail.match?.reasons?.matched ?? []).slice(0, 6).map((m, i) => h('div', { key: `m${i}`, style: { ...S.muted, color: T.success } }, `✓ ${m}`)),
              (detail.match?.reasons?.missing ?? []).slice(0, 6).map((m, i) => h('div', { key: `x${i}`, style: { ...S.muted, color: T.warn } }, `! ${m}`)),
              (detail.match?.reasons?.unknown ?? []).slice(0, 4).map((m, i) => h('div', { key: `u${i}`, style: S.muted }, `? ${m}`)))
            : null,

          // ④ JD 正文（没有就诚实说明，并指路）
          detail.description || detail.requirements
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '岗位描述'),
              detail.description
                ? h('div', { style: { ...S.body, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' } }, detail.description)
                : h('div', { style: S.muted }, '没有存到描述正文。'),
              detail.requirements && detail.requirements !== detail.description
                ? h('div', { style: { marginTop: 8 } },
                  h('div', { style: { ...S.muted, fontWeight: 600 } }, '任职要求'),
                  h('div', { style: { ...S.body, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' } }, detail.requirements))
                : null)
            : h('div', { style: { ...S.cardTight, marginTop: 10, borderColor: T.warn } },
              h('div', { style: S.h3 }, '岗位描述'),
              h('div', { style: S.muted }, '这个岗位没有 JD 正文。原因：它的列表接口只返回标题、地点和批次，正文要点进详情页才有。'),
              h('div', { style: { ...S.muted, marginTop: 4 } },
                detail.apply_url ? '点右上角「去投递页」查看完整 JD。' : '建议到官网搜索该岗位编号查看完整 JD。')),

          // ⑤ 来源与历史
          detail.sources?.length
            ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
              h('div', { style: S.h3 }, '来源证据'),
              detail.sources.map((s) => h('div', { key: s.id, style: { ...S.muted, marginBottom: 4, wordBreak: 'break-all' } },
                h(Chip, { tone: s.confidence_level === 'A' ? 'success' : undefined }, s.confidence_level ?? 'C'),
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
            h('div', { style: { ...S.row, flexWrap: 'wrap' } },
              [['OPEN', true], ['CLOSED', true], ['UPCOMING', true], ['UNVERIFIED', false], ['STALE', false]].map(([s, off]) =>
                h(Btn, { key: s, kind: 'ghost', onClick: () => verify(s, off) }, `${s}${off ? '（官方）' : ''}`))),
            h('div', { style: { ...S.muted, marginTop: 6 } }, '只有官方证据能把状态改成 OPEN/CLOSED；非官方来源最多把 UNKNOWN 升为 UNVERIFIED。'))))
      : null)
}
