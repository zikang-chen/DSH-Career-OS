// ─── Settings ────────────────────────────────────────────────────────────────
function SettingsTab({ bootstrap, onChanged }) {
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [posture, setPosture] = useState(false)
  const [deleteToken, setDeleteToken] = useState(null)
  const [ruleForm, setRuleForm] = useState({ kind: 'job_deadline', name: '', url: '', company: '', withinDays: 7 })

  const act = (fn, msg) => fn().then((res) => { setNotice(msg); onChanged?.(); return res }).catch((err) => setError(err.message))

  return h('div', { style: S.col },
    error ? h('div', { style: { ...S.card, ...S.muted, color: T.error } }, error) : null,
    notice ? h('div', { style: { ...S.card, borderColor: T.success, ...S.muted, color: T.success } }, notice) : null,

    h('div', { style: S.card },
      h('div', { style: S.h2 }, '数据源健康'),
      h('div', { style: { ...S.col, gap: 8 } },
        (bootstrap?.sources ?? []).map((s) => h('div', { key: s.id, style: S.cardTight },
          h('div', { style: { ...S.row, justifyContent: 'space-between', flexWrap: 'wrap' } },
            h('div', null,
              h('div', { style: { ...S.body, fontWeight: 600 } }, s.display_name ?? s.connector),
              h('div', { style: S.mono }, `${s.connector} · ${s.access_mode}`)),
            h('div', { style: { ...S.row, gap: 6 } },
              h(Chip, { tone: s.enabled ? 'success' : 'error' }, s.enabled ? '启用' : '不可用'),
              s.needsUser ? h(Chip, { tone: 'warn' }, '需手动') : null)),
          h('div', { style: { ...S.muted, marginTop: 4 } }, s.rate_limit_note),
          h('div', { style: { ...S.muted, fontSize: 11, marginTop: 3 } },
            `最后成功 ${s.last_ok_at ? relTime(s.last_ok_at) : '—'} · 抓取 ${s.fetch_count} · 新增 ${s.insert_count} · 去重 ${s.dedupe_count}`),
          s.last_error ? h('div', { style: { ...S.muted, color: T.error, marginTop: 3 } }, `最后错误：${s.last_error}`) : null)))),

    h('div', { style: S.card },
      h('div', { style: S.h2 }, '监控规则'),
      h('div', { style: S.grid(170) },
        h(Field, { label: '类型' }, h('select', { style: S.input, value: ruleForm.kind, onChange: (e) => setRuleForm({ ...ruleForm, kind: e.target.value }) },
          [['job_deadline', '临近截止'], ['careers_page', '官方招聘页变化'], ['keyword_search', '关键词搜索'], ['social_watch', '论坛线索']].map(([v, l]) => h('option', { key: v, value: v }, l)))),
        h(Field, { label: '名称' }, h('input', { style: S.input, value: ruleForm.name, onChange: (e) => setRuleForm({ ...ruleForm, name: e.target.value }) })),
        ruleForm.kind === 'careers_page'
          ? h(Field, { label: '招聘页 URL' }, h('input', { style: S.input, value: ruleForm.url, onChange: (e) => setRuleForm({ ...ruleForm, url: e.target.value }) }))
          : null,
        ruleForm.kind === 'job_deadline'
          ? h(Field, { label: '提前天数' }, h('input', { style: S.input, value: ruleForm.withinDays, onChange: (e) => setRuleForm({ ...ruleForm, withinDays: e.target.value }) }))
          : h(Field, { label: '公司' }, h('input', { style: S.input, value: ruleForm.company, onChange: (e) => setRuleForm({ ...ruleForm, company: e.target.value }) }))),
      h('div', { style: { ...S.row, marginTop: 8 } },
        h(Btn, { kind: 'primary', onClick: () => act(() => apiPost('/monitor/rule', {
          kind: ruleForm.kind, name: ruleForm.name || ruleForm.kind,
          spec: ruleForm.kind === 'careers_page' ? { url: ruleForm.url, company: ruleForm.company }
            : ruleForm.kind === 'job_deadline' ? { withinDays: Number(ruleForm.withinDays) }
              : ruleForm.kind === 'keyword_search' ? { queries: [`${ruleForm.company} 实习 招聘`] }
                : { company: ruleForm.company },
        }), '规则已创建') }, '创建规则'),
        h(Btn, { onClick: () => act(() => apiPost('/monitor/run', {}).then((r) => setNotice(`已执行 ${r.ran ?? 0} 条规则（成功 ${r.ok ?? 0}，失败 ${r.error ?? 0}）`)), '监控完成') }, '立即执行全部')),

      (bootstrap?.rules ?? []).length
        ? h('div', { style: { ...S.col, marginTop: 10 } }, bootstrap.rules.map((r) => h('div', { key: r.id, style: { ...S.cardTight, ...S.row, justifyContent: 'space-between' } },
          h('div', null,
            h('div', { style: { ...S.body, fontWeight: 600 } }, r.name),
            h('div', { style: S.mono }, `${r.kind} · ${r.cadence} · 上次 ${r.last_run_at ? relTime(r.last_run_at) : '从未'}`),
            r.last_error ? h('div', { style: { ...S.muted, color: T.error } }, r.last_error) : null),
          h('div', { style: S.row },
            h(Chip, { tone: r.last_status === 'ok' ? 'success' : r.last_status === 'error' ? 'error' : undefined }, r.last_status ?? '未运行'),
            h(Btn, { kind: 'ghost', onClick: () => act(() => apiPost('/monitor/run', { id: r.id }), '该规则已执行') }, '执行')))))
        : h('div', { style: { ...S.muted, marginTop: 8 } }, '还没有规则。'),

      (bootstrap?.runs ?? []).length
        ? h('div', { style: { marginTop: 10 } },
          h('div', { style: S.h3 }, '最近运行'),
          bootstrap.runs.slice(0, 6).map((run) => h('div', { key: run.id, style: { ...S.mono } },
            `${fmtDate(run.started_at)} ${run.kind} · ${run.status}${run.error ? ` · ${String(run.error).slice(0, 60)}` : ` · 抓取 ${run.fetched}`}`)))
        : null),

    h('div', { style: S.card },
      h('div', { style: S.h2 }, '数据与隐私'),
      h('div', { style: S.muted }, `所有数据保存在本机：${bootstrap?.status?.dataDir ?? ''}。简历原文与投递记录不会上传第三方；日志不记录简历全文。`),
      h('div', { style: { ...S.row, flexWrap: 'wrap', marginTop: 8 } },
        h(Btn, { onClick: () => act(() => apiPost('/export', {}), '已导出 JSON') }, '导出 JSON'),
        h(Btn, { onClick: () => act(() => apiPost('/backup', {}), '已备份数据库') }, '备份数据库'),
        h(Btn, { kind: 'ghost', onClick: () => apiPost('/data/delete/prepare', {}).then((res) => { setDeleteToken(res); setPosture(true) }).catch((err) => setError(err.message)) }, '删除全部数据')),
      posture && deleteToken
        ? h('div', { style: { ...S.cardTight, borderColor: T.error, marginTop: 8 } },
          h('div', { style: { ...S.body, color: T.error, fontWeight: 600 } }, '确认删除？此操作不可撤销。'),
          h('div', { style: S.muted }, JSON.stringify(deleteToken.counts)),
          h('div', { style: { ...S.row, marginTop: 8 } },
            h(Btn, {
              onClick: () => apiPost('/data/delete/commit', { token: deleteToken.token })
                .then(() => { setNotice('数据已删除'); setPosture(false); setDeleteToken(null); onChanged?.() })
                .catch((err) => setError(err.message)),
            }, '确认删除'),
            h(Btn, { kind: 'ghost', onClick: () => { setPosture(false); setDeleteToken(null) } }, '取消')))
        : null))
}
