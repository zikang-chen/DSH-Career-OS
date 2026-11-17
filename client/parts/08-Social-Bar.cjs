// ─── Social & Bar ────────────────────────────────────────────────────────────
function SocialTab() {
  const [posts, setPosts] = useState(null)
  const [claims, setClaims] = useState(null)
  const [bar, setBar] = useState(null)
  const [queries, setQueries] = useState(null)
  const [form, setForm] = useState({ platform: 'xiaohongshu', url: '', title: '', content: '', company: '', claim: '', category: 'interview', evidenceLevel: 'C' })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    apiGet('/social').then((res) => { setPosts(res.posts); setClaims(res.claims) }).catch((err) => setError(err.message))
  }, [])
  useEffect(load, [load])

  const submit = async () => {
    if (!form.content.trim()) return setError('请粘贴正文或核心摘录')
    setBusy(true)
    setError(null)
    try {
      await apiPost('/social/import', {
        platform: form.platform, url: form.url || undefined, title: form.title || undefined,
        content: form.content, company: form.company || undefined, accessMode: 'manual_import',
        claims: form.claim.trim() ? [{ category: form.category, claim: form.claim, evidenceLevel: form.evidenceLevel }] : undefined,
      })
      setForm({ ...form, url: '', title: '', content: '', claim: '' })
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const set = (key) => (ev) => setForm({ ...form, [key]: ev.target.value })

  return h('div', { style: S.col },
    error ? h('div', { style: { ...S.card, ...S.muted, color: T.error } }, error) : null,
    h('div', { style: { ...S.card, borderColor: T.warn } },
      h('div', { style: S.h2 }, '关于可采集范围'),
      h('div', { style: S.muted }, '小红书 / 脉脉 / 牛客 / 知乎 等平台需登录且禁止自动化采集。系统不会抓取这些平台的正文；这里的内容全部来自你自己粘贴或合法导出的资料。单条自述按 C 级证据处理，只有独立来源互相印证才升为 B 级。')),
    h('div', { style: S.card },
      h('div', { style: S.h2 }, '导入一条经验/面经'),
      h('div', { style: S.grid(170) },
        h(Field, { label: '平台' }, h('select', { style: S.input, value: form.platform, onChange: set('platform') },
          ['xiaohongshu', 'nowcoder', 'zhihu', 'maimai', 'v2ex', '1point3acres', 'github', 'other'].map((p) => h('option', { key: p, value: p }, p)))),
        h(Field, { label: '关联公司' }, h('input', { style: S.input, value: form.company, onChange: set('company') })),
        h(Field, { label: '标题' }, h('input', { style: S.input, value: form.title, onChange: set('title') })),
        h(Field, { label: '原链接' }, h('input', { style: S.input, value: form.url, onChange: set('url') }))),
      h('div', { style: { marginTop: 8 } },
        h(Field, { label: '正文或核心摘录（必填）' }, h('textarea', { style: S.textarea, value: form.content, onChange: set('content'), placeholder: '粘贴你看到的内容…' }))),
      h('div', { style: { ...S.grid(170), marginTop: 8 } },
        h(Field, { label: '抽取一条观点（可选）' }, h('input', { style: S.input, value: form.claim, onChange: set('claim'), placeholder: '三轮面试先问项目' })),
        h(Field, { label: '类别' }, h('select', { style: S.input, value: form.category, onChange: set('category') },
          ['bar', 'interview', 'experience', 'salary', 'process'].map((c) => h('option', { key: c, value: c }, c)))),
        h(Field, { label: '证据等级' }, h('select', { style: S.input, value: form.evidenceLevel, onChange: set('evidenceLevel') },
          ['A', 'B', 'C', 'D', 'U'].map((l) => h('option', { key: l, value: l }, l))))),
      h('div', { style: { marginTop: 8 } }, h(Btn, { kind: 'primary', disabled: busy, onClick: submit }, busy ? '导入中…' : '导入'))),

    h('div', { style: S.grid(320) },
      h('div', { style: S.card },
        h('div', { style: S.h2 }, `已导入资料（${posts?.length ?? 0}）`),
        posts === null ? h(Loading) : posts.length === 0
          ? h(Empty, { title: '还没有导入资料', hint: '在牛客/小红书看到有用内容，复制正文粘贴到上面即可。' })
          : h('div', { style: S.col }, posts.map((p) => h('div', { key: p.id, style: S.cardTight },
            h('div', { style: { ...S.row, justifyContent: 'space-between' } },
              h('span', { style: { ...S.body, fontWeight: 600 } }, p.title || `${p.platform} 内容`),
              h(Chip, null, p.platform)),
            h('div', { style: S.muted }, `${p.access_mode} · ${fmtDate(p.retrieved_at)}`),
            p.url ? h('a', { href: p.url, target: '_blank', rel: 'noreferrer', style: { ...S.muted, color: T.accent } }, '原帖') : null)))),

      h('div', { style: S.card },
        h('div', { style: S.h2 }, '观点汇总'),
        claims === null ? h(Loading) : claims.total === 0
          ? h('div', { style: S.muted }, '暂无结构化观点。导入资料时勾选「抽取观点」或在对话里让 Agent 抽取。')
          : h('div', { style: S.col },
            h('div', { style: { ...S.muted, fontStyle: 'italic' } }, claims.caveat),
            claims.groups.map((g) => h('div', { key: g.category, style: S.cardTight },
              h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                h('span', { style: { ...S.body, fontWeight: 600 } }, g.category),
                h('span', { style: S.muted }, `${g.sample} 条`)),
              Object.entries(g.levels).map(([lv, n]) => h(Chip, { key: lv, tone: lv === 'A' ? 'success' : lv === 'D' ? 'error' : undefined }, `${lv} 级 ×${n}`)),
              g.items.slice(0, 4).map((it) => h('div', { key: it.id, style: { ...S.muted, marginTop: 4 } }, `· ${it.claim}`))))),

        h('div', { style: { marginTop: 12 } },
          h('div', { style: S.h3 }, '招聘 Bar 速览'),
          h('div', { style: S.row },
            h(Btn, { kind: 'ghost', onClick: () => apiGet('/bar').then(setBar).catch((err) => setError(err.message)) }, '计算'),
            h(Btn, { kind: 'ghost', onClick: () => apiPost('/bar/requirement', { kind: 'hard', text: '在此填写官方硬性要求', evidenceLevel: 'A' }).then(() => apiGet('/bar').then(setBar)).catch((err) => setError(err.message)) }, '用对话补充'))),
          bar ? h('div', { style: { ...S.cardTight, marginTop: 8 } },
            h('div', { style: { ...S.muted, fontSize: 11 } }, bar.disclaimer),
            ['hard', 'preferred', 'observed', 'unverified'].map((k) => h('div', { key: k, style: { marginTop: 6 } },
              h('div', { style: S.h3 }, `${k}（${bar[k].length}）`),
              bar[k].slice(0, 5).map((r) => h('div', { key: r.id, style: S.muted }, `· ${r.text}`))))) : null),

      h('div', { style: S.card },
        h('div', { style: S.h2 }, '搜索入口生成'),
        h('div', { style: { ...S.muted, marginBottom: 6 } }, '系统不抓取这些平台；这里只给你可直接打开的搜索链接。'),
        h('div', { style: S.grid(150) },
          h(Field, { label: '公司' }, h('input', { style: S.input, value: form.company, onChange: set('company') })),
          h(Field, { label: '岗位' }, h('input', { style: S.input, value: form.title, onChange: set('title') }))),
        h('div', { style: { marginTop: 8 } },
          h(Btn, { onClick: () => apiPost('/search/web', { query: `${form.company} ${form.title} 实习 面经` }).then((res) => setQueries({ web: res.sources })).catch((err) => setError(err.message)) }, '用搜索引擎找线索')),
        queries?.web?.length
          ? h('div', { style: { ...S.col, marginTop: 8 } }, queries.web.map((s) => h('div', { key: s.url, style: S.cardTight },
            h('a', { href: s.url, target: '_blank', rel: 'noreferrer', style: { ...S.body, color: T.accent } }, s.title || s.url),
            s.snippet ? h('div', { style: { ...S.muted, marginTop: 3 } }, s.snippet) : null)))
          : null))
  )
}
