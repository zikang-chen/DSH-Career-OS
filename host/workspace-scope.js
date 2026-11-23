// Workspace scoping: decide whether this session belongs to a CareerOS workspace.
import path from 'node:path'

/** Normalise a Windows/POSIX path for comparison (case-insensitive on Windows). */
export function normalisePath(value) {
  const text = String(value ?? '').trim().replace(/^["']|["']$/g, '')
  if (!text) return ''
  const slashed = text.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/** True when `target` is `root` itself or inside it — never a sibling with a shared prefix. */
export function isUnder(target, roots) {
  const child = normalisePath(target)
  if (!child) return false
  const list = Array.isArray(roots) ? roots : [roots]
  for (const root of list) {
    const parent = normalisePath(root)
    if (!parent) continue
    if (child === parent) return true
    if (child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)) return true
  }
  return false
}

export function resolveScopeRoots(config, packageRoot) {
  const configured = Array.isArray(config?.workspaceRoots) ? config.workspaceRoots.filter(Boolean) : []
  return configured.length ? configured : [packageRoot]
}

/**
 * Build the step-time activation predicate for `ctx.tools.register(definition, { when })`.
 * Returns undefined when scoping is off or the sessions service is unavailable (fail-open),
 * so a missing service can never hide every tool permanently.
 */
export function buildWorkspaceGuard({ ctx, config, packageRoot, logger }) {
  if (config?.onlyInCareerWorkspace === false) return { when: undefined, reason: 'disabled-by-config' }
  const sessions = ctx.get?.('sessions')
  if (!sessions?.get) return { when: undefined, reason: 'no-sessions-service' }
  const roots = resolveScopeRoots(config, packageRoot)
  let warned = false
  const when = (context) => {
    try {
      const session = sessions.get(context?.agent?.id)
      const cwd = session?.header?.cwd
      // Unknown cwd (brand-new session, restored header without cwd) keeps the tools available.
      if (!cwd) return true
      return isUnder(cwd, roots)
    } catch (err) {
      if (!warned) {
        warned = true
        logger?.warn?.('career workspace scope check failed; keeping tools available', { error: String(err?.message ?? err) })
      }
      return true
    }
  }
  return { when, roots, reason: 'scoped', resolveCwd: (sessionId) => {
    try { return sessions.get?.(sessionId)?.header?.cwd ?? null } catch { return null }
  } }
}

/** Same rule for UI surfaces that only receive a path string. */
export const pathInCareerWorkspace = (cwd, roots) => !cwd || isUnder(cwd, roots)

export const CAREER_SCOPE_DEFAULT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
