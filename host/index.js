// CareerOS host plugin: wires the database, repositories, monitoring engine, agent
// tools and the dashboard HTTP API into one Cordis plugin.
//
// Deliberately dependency-free: only `node:` builtins are imported, so the bundle
// installs into a profile without any package resolution step.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CareerDb } from './db.js'
import { runBackup } from './backup.js'
import { Repos } from './repo/index.js'
import {syncKnowledgeIndex} from './knowledge-sync.js'
import { Monitor } from './monitor.js'
import { PanelBus } from './panel.js'
import { Exporter } from './exporter.js'
import { registerCareerTools } from './tools.js'
import { registerRoutes, API_PREFIX } from './routes.js'
import { CONNECTOR_META } from './sources.js'
import { nowIso } from './util.js'
import { buildWorkspaceGuard } from './workspace-scope.js'

export const name = 'dsh-career'
export const inject = ['tools', 'webServer']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULTS = {
  dataDir: 'data',
  // Only expose the career_* tools in sessions whose workspace is this plugin (or workspaceRoots).
  onlyInCareerWorkspace: true,
  workspaceRoots: [],
  httpGapMs: 2500,
  httpTimeoutMs: 20_000,
  panelOpen: false,
  scheduleEnabled: false,
  dailyHour: 9,
  staleAfterDays: 21,
  monitorIntervalHours: 6,
  pythonPath: 'python',
  logLevel: 'info',
}

function resolveDataDir(value) {
  if (!value) return path.join(PACKAGE_ROOT, 'data')
  return path.isAbsolute(value) ? value : path.join(PACKAGE_ROOT, value)
}

function createLogger(dataDir, level = 'info') {
  const dir = path.join(dataDir, 'logs')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* a read-only data dir must not prevent startup */
  }
  const file = path.join(dir, 'career.log')
  const order = { debug: 10, info: 20, warn: 30, error: 40 }
  const threshold = order[level] ?? 20
  const write = (lvl, msg, extra) => {
    if ((order[lvl] ?? 20) < threshold) return
    const line = `${nowIso()} ${lvl.toUpperCase()} ${msg}${extra === undefined ? '' : ` ${safeJson(extra)}`}\n`
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
        fs.renameSync(file, `${file}.1`)
      }
      fs.appendFileSync(file, line, 'utf8')
    } catch {
      /* logging must never throw into a tool call */
    }
  }
  return {
    file,
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
  }
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value)
    return text !== undefined && text.length > 2000 ? `${text.slice(0, 2000)}…` : text
  } catch {
    return '[unserializable]'
  }
}

/** Adapt the Harness `ctx.web.search` seam into the shape the monitor expects. */
function makeSearchAdapter(ctx) {
  const web = ctx.get ? ctx.get('web') : ctx.web
  if (!web || typeof web.search !== 'function') return null
  return async (query, maxResults = 8) => {
    try {
      const result = await web.search({ query, maxResults })
      return {
        ok: true,
        sources: (result.sources ?? []).map((s) => ({ url: s.url, title: s.title, snippet: s.snippet ?? s.summary })),
        truncated: result.truncated === true,
      }
    } catch (err) {
      return { ok: false, sources: [], error: String(err?.message ?? err) }
    }
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  config.dataDir = resolveDataDir(config.dataDir)
  fs.mkdirSync(config.dataDir, { recursive: true })

  const logger = createLogger(config.dataDir, config.logLevel)
  logger.info('career plugin apply', { dataDir: config.dataDir, node: process.version, config: { ...config, dataDir: '<dir>' } })

  const db = new CareerDb(path.join(config.dataDir, 'career.db'), logger).open()
  logger.info('career database ready', db.info())

  // 每天最多备份一次；失败不影响主流程。
  try {
    runBackup({ db, dataDir: config.dataDir, logger, retain: 7, intervalHours: 20 })
  } catch (err) {
    logger.warn('auto backup skipped', { error: String(err?.message ?? err) })
  }

  const repos = new Repos(db, logger)
  try { logger.info('knowledge index reconciled',syncKnowledgeIndex(repos)) } catch(err) { logger.warn('knowledge index reconcile failed',{error:err.message}) }
  const interrupted = repos.monitor.reconcileRuns()
  if (interrupted) logger.warn('closed interrupted sync runs', { count: interrupted })

  // 让每个数据源都在「数据源健康」里可见（含需要登录的）。
  for (const meta of CONNECTOR_META) {
    repos.monitor.upsertSource({
      connector: meta.connector,
      displayName: meta.displayName,
      accessMode: meta.accessMode,
      capabilities: meta.capabilities,
      enabled: meta.enabled !== false,
      needsUser: meta.needsUser === true,
      rateLimitNote: meta.rateLimitNote,
    })
  }
  // 清理历史遗留/已合并的 connector 行，避免面板出现重复数据源。
  try {
    // 仅处理本插件已合并的旧别名，绝不清空未来/第三方注册的其他 connector。
    repos.db.run('DELETE FROM source_health WHERE connector IN (?, ?, ?)', ['xhs', 'boss', '51job'])
  } catch (err) {
    logger.warn('source_health cleanup skipped', { error: String(err?.message ?? err) })
  }

  const exporter = new Exporter({ db, repos, config, logger })
  exporter.cleanupOldExports(20)

  const panel = new PanelBus()
  const search = makeSearchAdapter(ctx)
  const webService = ctx.get ? ctx.get('web') : ctx.web
  const monitor = new Monitor({ repos, config, logger, search })
  // Optional: lets the panel and `career_status` report whether the browser half of
  // this bundle is actually in the Web boot graph (installation alone proves nothing).
  const clientModules = ctx.get ? ctx.get('clientModules') : undefined
  const clientHealth = () => {
    try {
      if (!clientModules?.graph) return { available: false, reason: 'clientModules service unavailable' }
      const graph = clientModules.graph()
      // WebBootGraph { rev, entries: WebBootEntry[] } — see the clientModules contract.
      const entries = Array.isArray(graph?.entries) ? graph.entries : []
      const ids = entries.map((entry) => entry?.id).filter(Boolean)
      const mine = entries.find((entry) => entry?.id === 'dsh-career')
      return {
        available: true,
        inGraph: Boolean(mine),
        bundleUrl: mine?.url ?? null,
        rev: mine?.rev ?? null,
        graphRev: graph?.rev ?? null,
        knownClientIds: ids.slice(0, 120),
      }
    } catch (err) {
      return { available: false, reason: String(err?.message ?? err) }
    }
  }

  // Agent activity indicator: the panel shows what the agent is doing right now.
  try {
    ctx.on('tools/execute', async (exec, next) => {
      const tool = String(exec?.name ?? '')
      if (tool.startsWith('career_')) {
        try { panel.publish({ kind: 'agent', phase: 'start', tool, at: nowIso() }) } catch { /* ignore */ }
      }
      try {
        return await next()
      } finally {
        if (tool.startsWith('career_')) {
          try { panel.publish({ kind: 'agent', phase: 'done', tool, at: nowIso() }) } catch { /* ignore */ }
        }
      }
    })
  } catch (err) {
    logger.warn('could not hook tool activity', { error: String(err?.message ?? err) })
  }

  const scoped = buildWorkspaceGuard({ ctx, config, packageRoot: PACKAGE_ROOT, logger })
  logger.info('career workspace scope', { mode: scoped.reason, roots: scoped.roots ?? null })
  const toolNames = registerCareerTools(ctx, { repos, config, monitor, panel, logger, exporter, webService, clientHealth, scopeWhen: scoped.when })
  const routes = registerRoutes({ webServer: ctx.webServer, repos, monitor, panel, exporter, config, logger, search, clientHealth, webService, db, workspaceScope: scoped })

  // ── scheduler (opt-in) ─────────────────────────────────────────────────────
  let scheduleTimer = null
  if (config.scheduleEnabled === true) {
    const intervalMs = Math.max(1, Number(config.monitorIntervalHours) || 6) * 3600_000
    let running = false
    scheduleTimer = setInterval(async () => {
      if (running) return
      running = true
      try {
        const result = await monitor.runAll()
        logger.info('scheduled monitor run', { ran: result.ran, ok: result.ok, error: result.error })
        panel.publish({ kind: 'monitor', result: { ran: result.ran, ok: result.ok, error: result.error } })
      } catch (err) {
        logger.error('scheduled monitor run failed', { error: String(err?.message ?? err) })
      } finally {
        running = false
      }
    }, intervalMs)
    if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref()
    logger.info('monitor scheduler enabled', { intervalHours: config.monitorIntervalHours })
  } else {
    logger.info('monitor scheduler disabled (config.scheduleEnabled=false)')
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  ctx.effect(() => () => {
    if (scheduleTimer) clearInterval(scheduleTimer)
    try {
      routes.dispose()
    } catch {
      /* already gone */
    }
    db.close()
    logger.info('career plugin disposed')
  })

  logger.info('career plugin ready', { tools: toolNames.length, routes: routes.routes, db: db.file })
  return {
    config,
    db,
    repos,
    monitor,
    panel,
    exporter,
    toolNames,
    apiPrefix: API_PREFIX,
  }
}
