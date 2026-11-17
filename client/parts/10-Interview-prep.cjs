// ─── Interview prep ──────────────────────────────────────────────────────────
function InterviewTab() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    apiGet('/interview').then(setData).catch((err) => setError(err.message))
  }, [])
  return h('div', { style: S.col },
    error ? h('div', { style: { ...S.card, ...S.muted, color: T.error } }, error) : null,
    h('div', { style: { ...S.card, borderColor: T.accent } },
      h('div', { style: S.h2 }, '面试准备'),
      h('div', { style: S.muted }, '真实面经来自你导入的资料（C 级证据，样本有限）；AI 生成的练习题会单独标注。让 Agent 调用 career_interview_prep 可生成完整准备包。')),
    !data ? h(Loading) : data.interviews.length === 0
      ? h(Empty, { title: '还没有面经资料', hint: '在「论坛情报」导入面经，或让 Agent 用 career_forum_import 结构化整理。' })
      : h('div', { style: S.col }, data.interviews.map((iv) => h('div', { key: iv.id, style: S.card },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: S.h3 }, `${iv.role_title ?? '岗位未标注'} · ${iv.stage ?? '阶段未知'} · ${iv.year ?? '年份未知'}`),
          h(Chip, { tone: iv.evidence_level === 'A' ? 'success' : undefined }, `${iv.evidence_level} 级`)),
        iv.topics.length ? h('div', { style: { ...S.row, flexWrap: 'wrap', marginTop: 6 } }, iv.topics.map((t) => h(Chip, { key: t }, t))) : null,
        iv.questions.length ? h('div', { style: { marginTop: 6 } }, iv.questions.map((q, i) => h('div', { key: i, style: S.muted }, `Q: ${q}`))) : null)))
  )
}
