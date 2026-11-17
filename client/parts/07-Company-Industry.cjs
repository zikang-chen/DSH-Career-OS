// ─── Company / Industry ──────────────────────────────────────────────────────
function IndustryTab() {
  const [industries, setIndustries] = useState(null)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [form, setForm] = useState({ name: '', summary: '' })
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    apiGet('/industries').then((res) => setIndustries(res.industries)).catch((err) => setError(err.message))
  }, [])
  useEffect(load, [load])

  const open = (id) => {
    setSelected(id)
    apiGet(`/industry?id=${encodeURIComponent(id)}`).then((res) => setDetail(res.industry)).catch((err) => setError(err.message))
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
          ? h(Empty, { title: '还没有行业档案', hint: '让 Agent 用 career_industry_upsert / career_research_save 生成研究简报后会出现在这里。' })
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
            detail.companies?.length ? h('div', null, h('div', { style: S.h3 }, '相关公司'),
              detail.companies.map((c) => h('div', { key: c.id, style: { ...S.muted } }, c.name))) : null,
            detail.reports?.length ? h('div', null, h('div', { style: S.h3 }, '研究简报'),
              detail.reports.map((r) => h('div', { key: r.id, style: { ...S.muted } }, `${r.title} · v${r.version} · ${fmtDate(r.updated_at)}`))) : null)
          : h(Empty, { title: '选择左侧行业', hint: '行业档案包含产业链、格局、驱动因素与职业路径（由 Agent 研究后写入）。' })))
  )
}

function CompanyTab() {
  const [companies, setCompanies] = useState(null)
  const [detail, setDetail] = useState(null)
  const [form, setForm] = useState({ name: '', careersUrl: '', internUrl: '', cities: '', interest: 'watch' })
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    apiGet('/companies').then((res) => setCompanies(res.companies)).catch((err) => setError(err.message))
  }, [])
  useEffect(load, [load])

  const open = (id) => apiGet(`/company?id=${encodeURIComponent(id)}`).then((res) => setDetail(res.company)).catch((err) => setError(err.message))

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
            h('div', { style: S.h2 }, detail.name),
            h('div', { style: S.muted }, [detail.website, detail.careers_url].filter(Boolean).join(' · ') || '未填写官网'),
            detail.careers_url ? h('a', { href: detail.careers_url, target: '_blank', rel: 'noreferrer', style: { color: T.accent, ...S.body } }, '打开官方招聘页') : null,
            h('div', { style: S.h3, marginTop: 8 }, `在库岗位（${detail.jobs.length}）`),
            detail.jobs.length ? detail.jobs.slice(0, 8).map((j) => h('div', { key: j.id, style: S.muted }, `${j.title} · ${j.status}`)) : h('div', { style: S.muted }, '暂无'),
            h('div', { style: { ...S.h3, marginTop: 8 } }, '论坛观点分布'),
            detail.claimStats?.length
              ? detail.claimStats.map((c, i) => h('div', { key: i, style: S.muted }, `${c.category} · ${c.evidence_level} 级 · ${c.n} 条`))
              : h('div', { style: S.muted }, '暂无（需手动导入论坛内容）'))
          : h(Empty, { title: '选择左侧公司', hint: '公司档案含招聘入口、在库岗位、研究简报与论坛观点统计。' })))
  )
}
