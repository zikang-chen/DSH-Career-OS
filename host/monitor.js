// Monitoring engine: incremental checks, change detection, deduped notifications.
// Every rule records a `sync_run` row so failures stay visible with their last
// success time (spec §3.10 / acceptance case I).
import { daysBetween, nowIso } from './util.js'
import { STATUS_LABEL } from './domain.js'
import { htmlToText, parseCareersPage, politeGet, robotsAllows, suggestSocialQueries } from './sources.js'

export class Monitor {
  /**
   * @param {object} deps
   * @param {object} deps.repos Repos instance
   * @param {object} deps.config plugin config
   * @param {object} deps.logger
   * @param {(q:string, n?:number)=>Promise<{ok:boolean,sources:Array,error?:string}>} deps.search
   */
  constructor(deps) {
    this.repos = deps.repos
    this.config = deps.config
    this.logger = deps.logger
    this.search = deps.search
  }

  // ── one rule ───────────────────────────────────────────────────────────────
  async runRule(ruleId) {
    const rule = this.repos.monitor.getRule(ruleId)
    if (!rule) throw new Error(`监控规则不存在：${ruleId}`)
    const runId = this.repos.monitor.startRun(rule.kind, rule.name)
    let outcome
    try {
      outcome = await this.executeRule(rule)
    } catch (err) {
      outcome = { status: 'error', error: String(err?.message ?? err), fetched: 0, inserted: 0, updated: 0, duplicates: 0 }
    }
    this.repos.monitor.finishRun(runId, outcome)
    this.repos.monitor.updateRule(rule.id, {
      lastRunAt: nowIso(),
      lastStatus: outcome.status,
      lastError: outcome.error ?? null,
      stats: { ...(rule.stats ?? {}), ...(outcome.statsPatch ?? {}), lastRunId: runId },
    })
    return { runId, ...outcome }
  }

  async executeRule(rule) {
    switch (rule.kind) {
      case 'careers_page':
        return this.checkCareersPage(rule)
      case 'job_deadline':
        return this.checkDeadlines(rule)
      case 'keyword_search':
        return this.checkKeywordSearch(rule)
      case 'social_watch':
        return this.suggestSocialWatch(rule)
      default:
        return { status: 'error', error: `未知规则类型：${rule.kind}` }
    }
  }

  async checkCareersPage(rule) {
    const url = rule.spec?.url
    if (!url) return { status: 'error', error: '规则缺少 spec.url' }
    const robots = await robotsAllows(url)
    if (!robots.allowed) {
      return {
        status: 'error',
        error: `来源不可用：${robots.reason}。请改用「手动粘贴」导入。`,
        statsPatch: { blocked: true, lastBlockedAt: nowIso() },
      }
    }
    const res = await politeGet(url, {
      timeoutMs: this.config.httpTimeoutMs,
      gapMs: this.config.httpGapMs,
    })
    if (!res.ok) {
      return {
        status: 'error',
        error: res.error ? `请求失败：${res.error}` : `HTTP ${res.status}`,
        fetched: 0,
        statsPatch: { lastHttpStatus: res.status },
      }
    }
    const page = parseCareersPage(res.text, res.url)
    const previous = rule.spec?.lastHash ?? rule.stats?.lastHash ?? null
    const previousCount = rule.spec?.lastLinkCount ?? rule.stats?.linkCount ?? null
    const changed = previous !== null && previous !== page.hash
    const notifications = []

    if (changed) {
      const delta = previousCount === null ? page.links.length : page.links.length - previousCount
      notifications.push({
        kind: 'careers_change',
        title: `${rule.spec?.company ?? rule.name}：招聘页有变化${delta ? `（岗位链接 ${delta > 0 ? '+' : ''}${delta}）` : ''}`,
        body: `页面结构与上次不同。当前识别到 ${page.links.length} 个岗位链接。${page.signals.open ? '页面含在招信号。' : ''}${page.signals.closed ? '页面含结束信号。' : ''}\n核验时间：${nowIso()}`,
        severity: 'info',
        dedupeKey: `careers:${rule.id}:${page.hash}`,
        action: '打开官方招聘页确认后，把岗位导入系统',
      })
    } else if (previous === null) {
      notifications.push({
        kind: 'careers_baseline',
        title: `${rule.spec?.company ?? rule.name}：已建立招聘页基线`,
        body: `首次检查完成，识别到 ${page.links.length} 个岗位链接，后续会对比变化。核验时间：${nowIso()}`,
        severity: 'info',
        dedupeKey: `careers-baseline:${rule.id}`,
        action: '无需操作',
      })
    }

    let inserted = 0
    let duplicates = 0
    if (rule.spec?.autoImport === true && page.links.length) {
      const company = rule.spec?.company
      for (const link of page.links.slice(0, 40)) {
        if (!company) break
        const r = this.repos.jobs.upsertJob(
          { company, title: link.label || '待确认岗位', url: link.url, status: 'UNVERIFIED' },
          { official: false, source: { sourceType: 'official_careers', sourceName: rule.name, url: link.url, excerpt: '招聘页链接' } },
        )
        if (r.created) inserted += 1
        else duplicates += 1
      }
    }

    for (const n of notifications) {
      this.repos.monitor.addNotification({ ...n, ruleId: rule.id })
    }
    return {
      status: 'ok',
      fetched: page.links.length,
      inserted,
      updated: changed ? 1 : 0,
      duplicates,
      meta: { signals: page.signals, hash: page.hash },
      statsPatch: { lastHash: page.hash, linkCount: page.links.length, signals: page.signals, checkedAt: nowIso() },
    }
  }

  async checkDeadlines(rule) {
    const withinDays = Number(rule.spec?.withinDays ?? 7)
    const todayStr = nowIso().slice(0, 10)
    const rows = this.repos.db.all(
      "SELECT id, title, company_name, deadline, status FROM job WHERE archived = 0 AND deadline IS NOT NULL AND status <> 'CLOSED'",
    )
    let count = 0
    for (const row of rows) {
      const left = daysBetween(todayStr, row.deadline)
      if (left === null || left < 0 || left > withinDays) continue
      this.repos.monitor.addNotification({
        ruleId: rule.id,
        kind: 'deadline',
        title: `${row.company_name} · ${row.title} 还有 ${left} 天截止`,
        body: `截止日期 ${row.deadline}（${STATUS_LABEL[row.status] ?? row.status}）。请确认是否投递。`,
        severity: left <= 2 ? 'high' : 'normal',
        dedupeKey: `deadline:${row.id}:${row.deadline}:${left <= 2 ? 'urgent' : 'soon'}`,
        jobId: row.id,
        action: '在「投递管理」里推进这条岗位',
      })
      count += 1
    }
    return { status: 'ok', fetched: rows.length, updated: count, meta: { withinDays, notified: count } }
  }

  async checkKeywordSearch(rule) {
    const queries = Array.isArray(rule.spec?.queries) ? rule.spec.queries : [rule.spec?.query].filter(Boolean)
    if (!queries.length) return { status: 'error', error: '规则缺少 spec.queries' }
    if (!this.search) return { status: 'error', error: '搜索能力不可用（Harness 未提供 web 服务）' }
    let fetched = 0
    let notified = 0
    const errors = []
    for (const query of queries.slice(0, 5)) {
      const res = await this.search(query, Number(rule.spec?.maxResults ?? 8))
      if (!res.ok) {
        errors.push(`${query}: ${res.error}`)
        continue
      }
      fetched += res.sources.length
      for (const src of res.sources) {
        const key = `search:${rule.id}:${src.url}`
        const added = this.repos.monitor.addNotification({
          ruleId: rule.id,
          kind: 'search_hit',
          title: src.title ?? src.url,
          body: `${src.snippet ?? '（无摘要）'}\n查询：${query}\n注意：搜索结果只是线索，未核实招聘状态。`,
          severity: 'low',
          dedupeKey: key,
          action: '打开链接确认，必要时手动粘贴入库',
        })
        if (!added.duplicate) notified += 1
      }
    }
    if (!fetched && errors.length) {
      return { status: 'error', error: `搜索全部失败：${errors.slice(0, 2).join(' | ')}` }
    }
    return { status: 'ok', fetched, updated: notified, meta: { queries: queries.length, notified, errors } }
  }

  async suggestSocialWatch(rule) {
    const suggestion = suggestSocialQueries({
      company: rule.spec?.company,
      role: rule.spec?.role,
      year: rule.spec?.year,
    })
    this.repos.monitor.addNotification({
      ruleId: rule.id,
      kind: 'social_suggestion',
      title: `${rule.spec?.company ?? rule.name}：论坛线索入口已更新`,
      body: `${suggestion.note}\n\n建议搜索词：${suggestion.queries.join(' / ')}`,
      severity: 'low',
      dedupeKey: `social:${rule.id}:${nowIso().slice(0, 10)}`,
      action: '打开链接浏览，把有用内容粘贴进「论坛情报」',
    })
    return { status: 'ok', fetched: suggestion.links.length, updated: 1, meta: { queries: suggestion.queries } }
  }

  // ── batch ──────────────────────────────────────────────────────────────────
  async runAll({ kinds = null } = {}) {
    const rules = this.repos.monitor.listRules({ onlyEnabled: true }).filter((r) => !kinds || kinds.includes(r.kind))
    const results = []
    for (const rule of rules) {
      // Sequential on purpose: never burst a public site.
      results.push({ rule: rule.name, ruleId: rule.id, kind: rule.kind, ...(await this.runRule(rule.id)) })
    }
    const stale = this.repos.jobs.expireStale(Number(this.config.staleAfterDays ?? 21))
    return {
      ran: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      error: results.filter((r) => r.status === 'error').length,
      staleMarked: stale,
      results,
    }
  }

  /** Daily digest used by the dashboard and the `career_digest` tool. */
  buildDigest() {
    const todayStr = nowIso().slice(0, 10)
    const closing = this.repos.db.all(
      `SELECT id, title, company_name, deadline, status, match_score FROM job
       WHERE archived = 0 AND deadline IS NOT NULL AND deadline >= ? AND status <> 'CLOSED'
       ORDER BY deadline LIMIT 10`, [todayStr])
    const fresh = this.repos.db.all(
      "SELECT id, title, company_name, location, status, created_at FROM job WHERE archived = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT 10",
      [`${todayStr}T00:00:00.000Z`])
    const openJobs = this.repos.db.all(
      "SELECT id, title, company_name, location, match_score, status_verified_at FROM job WHERE archived = 0 AND status = 'OPEN' ORDER BY coalesce(match_score,0) DESC LIMIT 10")
    const follow = this.repos.applications.followUps()
    const digest = {
      date: todayStr,
      closing: closing.map((r) => ({ ...r, daysLeft: daysBetween(todayStr, r.deadline) })),
      newlyFound: fresh,
      openJobs,
      followUps: { overdue: follow.overdue.length, stale: follow.stale.length, interviews: follow.interviews.length },
      unreadNotifications: this.repos.monitor.unreadCount(),
      jobStats: this.repos.jobs.stats(),
      applicationStats: this.repos.applications.stats(),
    }
    return digest
  }
}
