// Claim aggregation by category, year and department so different cohorts never merge into one "fact".
const text = (v) => (v === null || v === undefined ? '' : String(v).trim())
const norm = (v) => text(v).toLowerCase().replace(/\s+/g, '')

export function aggregateClaims(claims = [], { minSampleForSignal = 3 } = {}) {
  const rows = Array.isArray(claims) ? claims.filter(Boolean) : []
  const byCategory = new Map()
  for (const row of rows) {
    const category = text(row.category) || 'experience'
    if (!byCategory.has(category)) byCategory.set(category, { category, total: 0, byYear: new Map(), byDepartment: new Map(), levels: {}, firstHand: 0, items: [] })
    const bucket = byCategory.get(category)
    bucket.total += 1
    bucket.items.push(row)
    if (row.first_hand === 1 || row.first_hand === true) bucket.firstHand += 1
    const level = text(row.evidence_level) || 'U'
    bucket.levels[level] = (bucket.levels[level] ?? 0) + 1
    const year = text(row.observed_year)
    const yearKey = year || '年份未知'
    bucket.byYear.set(yearKey, (bucket.byYear.get(yearKey) ?? 0) + 1)
    const dept = text(row.department) || '部门未知'
    bucket.byDepartment.set(dept, (bucket.byDepartment.get(dept) ?? 0) + 1)
  }
  const groups = [...byCategory.values()].map((bucket) => {
    // Same normalized claim text with opposite stances is a real conflict, not corroboration.
    const byText = new Map()
    for (const item of bucket.items) {
      const key = norm(item.claim)
      if (!key) continue
      if (!byText.has(key)) byText.set(key, { claim: text(item.claim), stances: new Set(), years: new Set(), departments: new Set() })
      const entry = byText.get(key)
      entry.stances.add(text(item.stance) || 'neutral')
      entry.years.add(text(item.observed_year) || '年份未知')
      entry.departments.add(text(item.department) || '部门未知')
    }
    const conflicts = [...byText.values()].filter((e) => e.stances.has('positive') && e.stances.has('negative'))
      .map((e) => ({ claim: e.claim, stances: [...e.stances], cohorts: [...new Set([...e.years, ...e.departments])] }))
    return {
      category: bucket.category,
      total: bucket.total,
      firstHand: bucket.firstHand,
      levels: bucket.levels,
      byYear: Object.fromEntries([...bucket.byYear.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      byDepartment: Object.fromEntries([...bucket.byDepartment.entries()].sort((a, b) => b[1] - a[1])),
      conflicts,
      sampleAdequate: bucket.total >= Math.max(2, minSampleForSignal),
    }
  }).sort((a, b) => b.total - a.total)
  const unknownYear = groups.reduce((n, g) => n + (g.byYear['年份未知'] ?? 0), 0)
  const unknownDepartment = groups.reduce((n, g) => n + (g.byDepartment['部门未知'] ?? 0), 0)
  return {
    ok: true,
    total: rows.length,
    groups,
    coverage: {
      withYear: rows.filter((r) => text(r.observed_year)).length,
      withDepartment: rows.filter((r) => text(r.department)).length,
      unknownYear,
      unknownDepartment,
    },
    caveats: [
      '论坛自述样本有选择偏差，不能当企业整体事实或录用概率。',
      '不同年份、不同部门的经验分开统计；样本不足只作线索，不升级为规律。',
      '同一条说法出现相反立场时标为冲突，不按票数取多数。',
    ],
  }
}
