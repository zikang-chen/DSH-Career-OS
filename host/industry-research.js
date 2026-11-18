// Industry research entry: deterministic plan + bounded public-search snippets.
// Snippets are leads with source and date. They are never presented as verified industry conclusions.
const MAX_QUERIES = 3
const MAX_RESULTS = 5

export function buildIndustryResearchPlan({ industry = {}, companies = [], jobs = [] } = {}) {
  const name = String(industry.name ?? '').trim() || '目标行业'
  const roles = [...new Set(jobs.map((j) => j.title).filter(Boolean))].slice(0, 5)
  const skills = [...new Set(jobs.flatMap((j) => Array.isArray(j.skills) ? j.skills : []))].slice(0, 8)
  const employerNames = [...new Set(companies.map((c) => c.name).filter(Boolean))].slice(0, 5)
  const queries = [
    `${name} 产业链 上中下游 2026`,
    `${name} 行业 市场规模 增速 数据`,
    ...(employerNames.length ? [`${employerNames.slice(0, 3).join(' ')} 招聘 岗位`] : []),
    ...(roles.length ? [`${name} ${roles.slice(0, 2).join(' ')} 能力要求`] : []),
  ].slice(0, MAX_QUERIES)
  return {
    ok: true,
    name,
    queries,
    localEvidence: { companies: employerNames, roles, skills },
    officialSources: [
      '国家统计局 / 工信部 / 行业协会公开统计',
      '上市公司年报与招股书中的行业章节',
      '目标企业官方招聘页的岗位与要求原文',
    ],
    caveats: [
      '以下只执行限定次数的公开检索，保存标题、链接与摘要，不代表已核实行业结论。',
      '规模、增速等数字必须回到原始统计口径；搜不到就留空。',
      '本地岗位与公司只用于框定研究范围，不当作行业事实。',
    ],
  }
}

/** Execute at most MAX_QUERIES searches; each failure is reported, not hidden. */
export async function collectIndustrySnippets({ name, queries, search, maxQueries = MAX_QUERIES } = {}) {
  if (typeof search !== 'function') return { ok: false, error: '当前未配置搜索提供方，无法检索；可手动粘链接或到设置检查搜索来源' }
  const limited = (Array.isArray(queries) ? queries : []).map((q) => String(q ?? '').trim()).filter(Boolean).slice(0, Math.max(1, Math.min(MAX_QUERIES, Number(maxQueries) || MAX_QUERIES)))
  if (!limited.length) return { ok: false, error: '缺少检索关键词' }
  const results = []
  let failures = 0
  for (const query of limited) {
    try {
      const res = await search(query, MAX_RESULTS)
      const sources = (res?.sources ?? []).slice(0, MAX_RESULTS).map((s) => ({ title: s.title ?? null, url: s.url ?? null, snippet: s.snippet ?? null })).filter((s) => s.url)
      if (res?.ok === false) failures += 1
      results.push({ query, ok: res?.ok !== false, sources, error: res?.ok === false ? (res.error ?? '检索失败') : null })
    } catch (err) { failures += 1; results.push({ query, ok: false, sources: [], error: String(err?.message ?? err) }) }
  }
  return {
    ok: results.some((r) => r.sources.length > 0),
    name,
    queries: results,
    resultCount: results.reduce((n, r) => n + r.sources.length, 0),
    failures,
    caveats: ['检索摘要为线索，未逐条打开核实；引用数字前必须回到原文。', '未收录的内容不代表不存在，只代表本次未检索到。'],
  }
}

/** Markdown body keeps source links and the retrieval date; no inferred numbers. */
export function renderIndustryResearchNote({ name, collected, at = new Date().toISOString() }) {
  const lines = [`# ${name} · 公开检索线索`, '', `检索时间：${at.slice(0, 10)}；共 ${collected.resultCount ?? 0} 条结果，失败 ${collected.failures ?? 0} 次。`, '', '> 以下仅为检索摘要线索，未经逐条核实，不构成行业结论。', '']
  for (const group of collected.queries ?? []) {
    lines.push(`## 关键词：${group.query}${group.ok ? '' : `（失败：${group.error ?? '未知原因'}）`}`, '')
    if (!group.sources.length) { lines.push('未检索到可用结果。', ''); continue }
    for (const s of group.sources) lines.push(`- [${s.title ?? s.url}](${s.url})${s.snippet ? ` — ${s.snippet}` : ''}`)
    lines.push('')
  }
  lines.push('## 待核实', '- 行业规模、增速等数字的原始统计口径与发布日期', '- 目标企业是否真的在该业务线招聘', '- 岗位要求与真实工作内容是否一致')
  return lines.join('\n')
}
