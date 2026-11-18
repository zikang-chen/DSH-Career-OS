// ─── Interview prep: sourced experiences stay separate from JD practice ───────
function InterviewTab({ focusCode } = {}) {
  const real = useApi(focusCode ? `/interview?jobId=${encodeURIComponent(focusCode)}` : '/interview')
  const [form, setForm] = useState({ jd: '', title: '', company: '' })
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [claimAgg, setClaimAgg] = useState(null)
  useEffect(() => {
    if (!focusCode) { setClaimAgg(null); return }
    let alive = true
    apiGet(`/claims/aggregate?jobId=${encodeURIComponent(focusCode)}`)
      .then((res) => { if (alive) setClaimAgg(res) })
      .catch(() => { if (alive) setClaimAgg(null) })
    return () => { alive = false }
  }, [focusCode])
  useEffect(() => { if (!focusCode) return; let active=true; apiGet(`/job?id=${encodeURIComponent(focusCode)}`).then(res => { const j=res.job; if (active && j) setForm({company:j.company_name||'',title:j.title||'',jd:[j.description,j.requirements].filter(Boolean).join('\n\n')}) }).catch(err=>setError(err.message)); return()=>{active=false} }, [focusCode])
  const set = key => e => { setForm({ ...form, [key]: e.target.value }); setPlan(null); setError(null) }
  const generate = async () => {
    if (!form.jd.trim()) return setError('请先粘贴目标岗位 JD 原文。')
    setBusy(true); setError(null); setPlan(null)
    try { setPlan(await apiPost('/interview/from-jd', { jd: form.jd, jobId:focusCode||undefined, title: form.title || undefined, company: form.company || undefined })) }
    catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return h('div', { style: S.col },
    h('div', { style: { ...S.card, borderColor: T.accent } },
      h('div', { style: S.h1 }, '面试准备'),
      h('div', { style: { ...S.muted, marginTop: 6 } }, '真实面经是有来源的经验样本，AI 练习只是依据 JD 关键词推导的准备方向。两者分区展示，不将练习题冒充真实面试题，也不声称已完成外部研究。')),
    h('div', { style: S.card },
      h('div', { style: S.h2 }, '从目标 JD 制定练习方向'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 10 } },
        h(Field, { label: '公司（可选）' }, h('input', { style: S.input, value: form.company, onChange: set('company'), disabled: busy })),
        h(Field, { label: '岗位（可选）' }, h('input', { style: S.input, value: form.title, onChange: set('title'), disabled: busy }))),
      h('div', { style: { marginTop: 10 } }, h(Field, { label: 'JD 原文', hint: '只分析提供的岗位文本；不自动检索外部面经。' }, h('textarea', { style: { ...S.textarea, minHeight: 150 }, value: form.jd, onChange: set('jd'), disabled: busy, placeholder: '粘贴岗位职责、任职要求…' }))),
      h('div', { style: { marginTop: 10 } }, h(Btn, { kind: 'primary', disabled: busy, onClick: generate }, busy ? '分析 JD…' : '生成 JD 练习方向')),
      error ? h('div', { role: 'alert', style: { ...S.muted, color: T.error, marginTop: 8 } }, error) : null),
    plan ? h('div', { style: { ...S.card, borderColor: T.warn } },
      h('div', { style: S.h2 }, 'AI 练习区 · 不是真实面试题'),
      h('div', { style: S.muted }, `命中 ${plan.counts?.topics ?? 0} 个方向 · ${plan.counts?.practiceQuestions ?? 0} 道练习。知识点仅由提供的 JD 推导，不代表该公司实际会问。`),
      !(plan.questions || []).length ? h(Empty, { title: '未命中可用练习方向', hint: 'JD 可能过短或不包含已支持的关键词，请补充完整文本。' }) : h('div', { style: { ...S.col, marginTop: 10 } }, (plan.knowledgePoints || []).map((topic, i) => h('div', { key: i, style: S.cardTight }, h('div', { style: S.h3 }, topic.topic), (topic.points || []).map((point, n) => h('div', { key: n, style: S.muted }, `· ${point}`)))), (plan.questions || []).map((q, i) => h('div', { key: i, style: S.cardTight }, h(Chip, { tone: 'warn' }, 'AI 练习'), h('div', { style: { ...S.body, marginTop: 4 } }, q.question), h('div', { style: S.muted }, q.category))))) : null,
    claimAgg && (claimAgg.groups ?? []).length
      ? h('div', { style: { ...S.card, marginTop: 10 } },
        h('div', { style: S.h2 }, '面经观点分布（按年份 / 部门，不合并口径）'),
        h('div', { style: S.muted }, `共 ${claimAgg.total} 条自述；有年份 ${claimAgg.coverage.withYear} 条、有部门 ${claimAgg.coverage.withDepartment} 条。`),
        claimAgg.groups.map((g) => h('div', { key: g.category, style: S.cardTight },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('span', { style: { ...S.body, fontWeight: 600 } }, g.category),
            h(Chip, { tone: g.sampleAdequate ? undefined : 'warn' }, `${g.total} 条${g.sampleAdequate ? '' : ' · 样本不足只作线索'}`)),
          h('div', { style: { ...S.row, flexWrap: 'wrap', marginTop: 4 } },
            Object.entries(g.byYear).map(([y, n]) => h(Chip, { key: `y${y}` }, `${y} · ${n}`)),
            Object.entries(g.byDepartment).slice(0, 4).map(([d, n]) => h(Chip, { key: `d${d}` }, `${d} · ${n}`))),
          g.conflicts.length ? h('div', { style: { ...S.muted, color: T.warn, marginTop: 4 } }, `存在相反说法：${g.conflicts.map((c) => c.claim).join('；')}`) : null)),
        h('div', { style: { ...S.muted, fontSize: 11, marginTop: 6 } }, (claimAgg.caveats ?? []).join(' ')))
      : null,
    h('div', { style: S.card },
      h('div', { style: S.h2 }, '真实面经区 · 已导入的来源样本'),
      h('div', { style: { ...S.muted, marginBottom: 8 } }, focusCode ? '以下仅展示明确关联此岗位的结构化面经；没有记录就留空，不拿其他岗位填充。可到知识库检索公司或采集新资料。' : '以下是已导入的结构化面经，尚未选择目标岗位。单一自述通常为 C 级、样本有限；请先从岗位详情进入准备。'),
      real.loading ? h(Loading) : real.error ? h(ErrorBox, { error: real.error, onRetry: real.reload }) : !(real.data?.interviews || []).length ? h(Empty, { title: '还没有真实面经样本', hint: '先在「知识库」导入有来源的面经，再结构化为面试经历；不会用 AI 练习填充这里。' }) : h('div', { style: S.col }, real.data.interviews.map(iv => h('div', { key: iv.id, style: S.cardTight },
        h('div', { style: { ...S.row, justifyContent: 'space-between', flexWrap: 'wrap' } }, h('div', { style: S.h3 }, `${iv.role_title ?? '岗位未标注'} · ${iv.stage ?? '阶段未知'} · ${iv.year ?? '年份未知'}`), h(Chip, { tone: iv.evidence_level === 'A' ? 'success' : undefined }, `真实样本 · ${iv.evidence_level || 'U'} 级`)),
        (iv.topics || []).length ? h('div', { style: { ...S.row, flexWrap: 'wrap', marginTop: 6 } }, iv.topics.map((t, i) => h(Chip, { key: i }, t))) : null,
        (iv.questions || []).length ? h('div', { style: { marginTop: 6 } }, iv.questions.map((q, i) => h('div', { key: i, style: S.muted }, `Q: ${q}`))) : h('div', { style: S.muted }, '未记录具体题目，不根据标题补造。'),
        typeof iv.url === 'string' && /^https?:\/\//i.test(iv.url) ? h('a', { href: iv.url, target: '_blank', rel: 'noopener noreferrer', style: { ...S.muted, color: T.accent } }, '原始面经来源') : h('div', { style: S.muted }, '未附原始链接，请回知识库核对来源。'))))))
}
