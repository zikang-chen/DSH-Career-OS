// ─── Company / Industry ──────────────────────────────────────────────────────
function IndustryTab() {
  const [industries, setIndustries] = useState(null)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [form, setForm] = useState({ name: '', summary: '' })
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [researching, setResearching] = useState(false)
  const [plan, setPlan] = useState(null)

  const load = useCallback(() => {
    apiGet('/industries').then((res) => setIndustries(res.industries)).catch((err) => setError(err.message))
  }, [])
  useEffect(load, [load])

  const open = (id) => {
    setSelected(id)
    setPlan(null)
    setNotice(null)
    apiGet(`/industry?id=${encodeURIComponent(id)}`).then((res) => setDetail(res.industry)).catch((err) => setError(err.message))
  }

  const previewPlan = (id) => apiGet(`/industry/plan?id=${encodeURIComponent(id)}`)
    .then((res) => { setPlan(res); setNotice(null) }).catch((err) => setError(err.message))

  const runResearch = (id) => {
    setResearching(true); setError(null); setNotice(null)
    apiPost('/industry/research', { id })
      .then((res) => { setNotice(res.note ?? '已保存检索线索'); setPlan(res.collected ?? plan); open(id) })
      .catch((err) => setError(`检索未完成：${err.message}；没有生成未经核实的结论。`))
      .finally(() => setResearching(false))
  }

  return h('div', { style: S.col },
    error ? h('div', { style: { ...S.card, ...S.muted, color: T.error } }, error) : null,
    h('div', { style: S.card },
      h('div', { style: S.h2 }, '新增行业档案'),
      h('div', { style: S.grid(200) },
        h(Field, { label: '行业名' }, h('input', { style: S.input, value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }), placeholder: '人工智能 / 半导体' })),
        h(Field, { label: '一句话摘要' }, h('input', { style: S.input, value: form.summary, onChange: (e) => setForm({ ...form, summary: e.target.value }) }))),
      h('div', { style: { marginTop: 8 } },
        h(Btn, { kind: 'primary', onClick: () => form.name.trim() && apiPost('/industry', form).then(() => { setForm({ name: '', summary: '' }); load() }).catch((err) => setError(err.message)) }, '创建'))),
    h('div', { style: S.grid(300) },
      h('div', { style: S.card },
        h('div', { style: S.h2 }, `行业目录（${industries?.length ?? 0}）`),
        industries === null ? h(Loading) : industries.length === 0
          ? h('div', { style: S.col },
            h(Empty, { title: '还没有行业档案', hint: '先建一个行业（如「人工智能」），再执行有次数上限的公开检索，结果按来源与日期保存为待核实线索。' }),
            h('div', { style: S.row, flexWrap: 'wrap' },
              ['人工智能', '半导体', '互联网人力资源'].map((name) => h(Btn, { key: name, onClick: () => apiPost('/industry', { name }).then((res) => { load(); return res }).then((res) => { if (res?.industry?.id) open(res.industry.id) }).catch((err) => setError(err.message)) }, `创建「${name}」`))))
          : h('div', { style: S.col }, industries.map((ind) => h('div', {
            key: ind.id, onClick: () => open(ind.id), style: { ...S.cardTight, cursor: 'pointer', borderColor: selected === ind.id ? T.accent : T.border },
          },
            h('div', { style: { ...S.body, fontWeight: 600 } }, ind.name),
            h('div', { style: S.muted }, `${ind.company_count ?? 0} 家公司${ind.summary ? ` · ${String(ind.summary).slice(0, 40)}` : ''}`))))),
      h('div', { style: S.card },
        detail
          ? h('div', { style: S.col },
            h('div', { style: S.h2 }, detail.name),
            detail.summary ? h('div', { style: { ...S.body, whiteSpace: 'pre-wrap' } }, detail.summary) : h('div', { style: S.muted }, '暂无摘要'),
            h('div', { style: { ...S.cardTight, marginTop: 8, borderColor: T.accent } },
              h('div', { style: S.h3 }, '研究这个行业（有限公开检索）'),
              h('div', { style: { ...S.muted, marginBottom: 6 } }, '最多 3 个关键词、每个取少量结果；保存标题、链接与日期。数字与结论需回到原文核实，搜不到就留空。'),
              h('div', { style: S.row, flexWrap: 'wrap' },
                h(Btn, { onClick: () => previewPlan(detail.id) }, '查看检索计划'),
                h(Btn, { kind: 'primary', disabled: researching, onClick: () => runResearch(detail.id) }, researching ? '检索中…' : '执行检索并保存线索')),
              plan?.queries?.length
                ? h('div', { style: { marginTop: 8 } },
                  (plan.queries || []).map((q, i) => h('div', { key: i, style: S.muted }, `· ${typeof q === 'string' ? q : q.query}${q.ok === false ? `（失败：${q.error ?? '未知'}）` : ''}`)),
                  plan.caveats ? plan.caveats.map((c, i) => h('div', { key: `c${i}`, style: { ...S.muted, fontSize: 11 } }, c)) : null)
                : null,
              notice ? h('div', { role: 'status', style: { ...S.muted, color: T.success, marginTop: 6 } }, notice) : null),
            detail.companies?.length ? h('div', null, h('div', { style: S.h3 }, '相关公司'),
              detail.companies.map((c) => h('div', { key: c.id, style: { ...S.muted } }, c.name))) : null,
            detail.reports?.length ? h('div', null, h('div', { style: S.h3 }, '研究简报'),
              detail.reports.map((r) => h('div', { key: r.id, style: { ...S.muted } }, `${r.title} · v${r.version} · ${fmtDate(r.updated_at)}`))) : null)
          : h(Empty, { title: '选择左侧行业', hint: '行业档案汇总公司与研究线索；研究入口有次数上限，结果标来源与日期，不把检索摘要当结论。' })))
  )
}

function CompanyTab({ onNavigate } = {}) {
  const [companies, setCompanies] = useState(null)
  const [detail, setDetail] = useState(null)
  const [form, setForm] = useState({ name: '', careersUrl: '', internUrl: '', cities: '', interest: 'watch' })
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    apiGet('/companies').then((res) => setCompanies(res.companies)).catch((err) => setError(err.message))
  }, [])
  useEffect(load, [load])

  const open = (id) => apiGet(`/company?id=${encodeURIComponent(id)}`).then((res) => setDetail(res)).catch((err) => setError(err.message))
  const adoptCareers = (company, url) => apiPost('/company', { id: company.id, name: company.name, careersUrl: url })
    .then(() => { setError(null); open(company.id); load() })
    .catch((err) => setError(`采用招聘入口失败（简历与岗位数据未改动）：${err.message}`))

  return h('div', { style: S.col },
    error ? h('div', { style: { ...S.card, ...S.muted, color: T.error } }, error) : null,
    h('div', { style: S.card },
      h('div', { style: S.h2 }, '登记目标公司'),
      h('div', { style: { ...S.muted, marginBottom: 8 } }, '填了官方招聘页地址，系统才能对其做变化监控（会先读 robots.txt）。'),
      h('div', { style: S.grid(200) },
        h(Field, { label: '公司名' }, h('input', { style: S.input, value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) })),
        h(Field, { label: '官方招聘页' }, h('input', { style: S.input, value: form.careersUrl, onChange: (e) => setForm({ ...form, careersUrl: e.target.value }), placeholder: 'https://jobs.example.com/campus' })),
        h(Field, { label: '实习页' }, h('input', { style: S.input, value: form.internUrl, onChange: (e) => setForm({ ...form, internUrl: e.target.value }) })),
        h(Field, { label: '办公城市' }, h('input', { style: S.input, value: form.cities, onChange: (e) => setForm({ ...form, cities: e.target.value }) }))),
      h('div', { style: { marginTop: 8 } },
        h(Btn, { kind: 'primary', onClick: () => form.name.trim() && apiPost('/company', { ...form, cities: form.cities }).then(() => { setForm({ name: '', careersUrl: '', internUrl: '', cities: '', interest: 'watch' }); load() }).catch((err) => setError(err.message)) }, '保存公司'))),
    h('div', { style: S.grid(320) },
      h('div', { style: S.card },
        h('div', { style: S.h2 }, `公司列表（${companies?.length ?? 0}）`),
        companies === null ? h(Loading) : companies.length === 0
          ? h(Empty, { title: '还没有公司档案', hint: '先登记几家目标公司，再去做招聘页监控。' })
          : h('div', { style: S.col }, companies.map((c) => h('div', {
            key: c.id, onClick: () => open(c.id), style: { ...S.cardTight, cursor: 'pointer' },
          },
            h('div', { style: { ...S.body, fontWeight: 600 } }, c.name),
            h('div', { style: S.muted }, [c.careers_url ? '有招聘页' : '无招聘页', (c.cities ?? []).join('/') || '城市未知'].join(' · ')))))),
      h('div', { style: S.card },
        detail
          ? h('div', { style: S.col },
            h('div', { style: S.h2 }, detail.company.name),
            h('div', { style: S.muted }, [detail.company.website, detail.company.careers_url, detail.industry?.name].filter(Boolean).join(' · ') || '未填写官网'),
            detail.company.careers_url ? h('a', { href: detail.company.careers_url, target: '_blank', rel: 'noreferrer', style: { color: T.accent, ...S.body } }, '打开官方招聘页') : null,
            detail.diagnosis?.careersEntryMissing && detail.diagnosis.officialSourceOrigins?.length
              ? h('div', { style: { ...S.cardTight, borderColor: T.warn, marginTop: 8 } },
                h('div', { style: S.h3 }, '档案关联诊断'),
                h('div', { style: { ...S.muted, whiteSpace: 'pre-wrap' } }, detail.diagnosis.note),
                detail.diagnosis.officialSourceOrigins.map((url) => h('div', { key: url, style: { ...S.row, flexWrap: 'wrap' } },
                  h('a', { href: url, target: '_blank', rel: 'noreferrer', style: { ...S.muted, color: T.accent } }, url),
                  detail.diagnosis.candidateCareersUrl === url
                    ? h(Btn, { onClick: () => adoptCareers(detail.company, url) }, '采用为招聘入口')
                    : h('span', { style: { ...S.muted, fontSize: 11 } }, '多个来源，请手动选择'))))
              : null,
            h('div', { style: S.h3, marginTop: 8 }, `在库岗位（${(detail.jobs ?? []).length}）`),
            (detail.jobs ?? []).length
              ? detail.jobs.slice(0, 8).map((j) => h('div', { key: j.id, style: { ...S.row, justifyContent: 'space-between', padding: '2px 0' } },
                h('span', { style: S.muted }, `${j.title} · ${j.statusDisplay ?? j.status}`),
                h(Btn, { kind: 'ghost', onClick: () => onNavigate?.('radar', j.id) }, '查看岗位')))
              : h('div', { style: S.muted }, '暂无关联岗位。若该企业确有招聘页，先登记入口再抓取岗位。'),
            (detail.units ?? []).length
              ? h('div', null, h('div', { style: S.h3, marginTop: 8 }, '业务部门'), detail.units.map((u, i) => h('div', { key: i, style: S.muted }, `${u.name}${u.strategic_role ? ` · ${u.strategic_role}` : ''}`)))
              : null,
            (detail.reports ?? []).length
              ? h('div', null, h('div', { style: S.h3, marginTop: 8 }, '研究简报'),
                detail.reports.map((r) => h('div', { key: r.id, style: S.muted }, `${r.title} · ${fmtDate(r.updated_at ?? r.data_as_of)}`)))
              : h('div', { style: { ...S.muted, marginTop: 8 } }, '还没有公司研究。可在对话里让我基于公开资料整理，并标注来源与时间。'),
            h('div', { style: S.h3, marginTop: 8 }, '论坛观点分布'),
            detail.company.claimStats?.length
              ? detail.company.claimStats.map((c, i) => h('div', { key: i, style: S.muted }, `${c.category} · ${c.evidence_level} 级 · ${c.n} 条`))
              : h('div', { style: S.muted }, '暂无（需导入有来源的论坛内容）'))
          : h(Empty, { title: '选择左侧公司', hint: '公司档案汇总招聘入口、在库岗位、业务部门、研究简报与论坛观点；岗位状态按证据显示，不沿用历史标签。' })))
  )
}
