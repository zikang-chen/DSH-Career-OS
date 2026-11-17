// ─── api ─────────────────────────────────────────────────────────────────────
async function apiGet(path) {
  const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`接口返回异常（HTTP ${res.status}）：${text.slice(0, 160)}`)
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 HTTP ${res.status}`)
  return data
}

async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`接口返回异常（HTTP ${res.status}）：${text.slice(0, 160)}`)
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 HTTP ${res.status}`)
  return data
}

function useApi(path, deps) {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const reload = useCallback(() => {
    let alive = true
    setState((prev) => ({ ...prev, loading: true, error: null }))
    apiGet(path)
      .then((data) => alive && setState({ loading: false, error: null, data }))
      .catch((err) => alive && setState({ loading: false, error: err.message, data: null }))
    return () => {
      alive = false
    }
  }, [path])
  useEffect(reload, [path, ...(deps ?? [])])
  return { ...state, reload }
}

// 构建标记：面板标题里显示，用于确认浏览器加载的是不是最新 bundle。
// 改了 client 之后手动改这个字符串，方便一眼判断有没有缓存。
const CLIENT_BUILD = 'v2026-11-17.5'


function Chip({ tone, children }) {
  return h('span', { style: S.chip(tone) }, children)
}

function Btn({ kind, onClick, children, disabled, title }) {
  return h('button', { type: 'button', title, disabled, onClick, style: { ...S.btn(kind), opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' } }, children)
}

function Field({ label, hint, children }) {
  return h('label', { style: { ...S.col, gap: 4 } },
    h('span', { style: { ...S.muted, fontWeight: 550 } }, label),
    children,
    hint ? h('span', { style: { ...S.muted, fontSize: 11, opacity: 0.8 } }, hint) : null)
}

function Empty({ title, hint, action }) {
  return h('div', { style: { ...S.card, textAlign: 'center', padding: 26, color: T.muted } },
    h('div', { style: { fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 6 } }, title),
    hint ? h('div', { style: S.muted }, hint) : null,
    action ? h('div', { style: { marginTop: 12 } }, action) : null)
}

function Loading({ label }) {
  return h('div', { style: { ...S.muted, padding: 18, display: 'flex', alignItems: 'center', gap: 8 } },
    h('span', { style: { width: 12, height: 12, borderRadius: 999, border: `2px solid ${T.border2}`, borderTopColor: T.accent, animation: 'careeros-spin 0.8s linear infinite' } }),
    label ?? '加载中…')
}

function ErrorBox({ error, onRetry }) {
  return h('div', { style: { ...S.card, borderColor: T.error } },
    h('div', { style: { ...S.h3, color: T.error } }, '加载失败'),
    h('div', { style: S.muted }, error),
    onRetry ? h('div', { style: { marginTop: 10 } }, h(Btn, { onClick: onRetry }, '重试')) : null)
}

/**
 * 弹层：双击岗位 / 点开投递详情时用。
 * 独立于面板的 portal，所以即使面板本身是弹层也能正常叠在上面。
 */
function Modal({ title, subtitle, onClose, children, width = 760 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    h('div', {
      onClick: onClose,
      style: {
        position: 'fixed', inset: 0, zIndex: 2147483600, background: 'rgba(15,23,42,0.42)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto',
      },
    },
      h('div', {
        onClick: (e) => e.stopPropagation(),
        style: {
          width: '100%', maxWidth: width, background: T.bg, borderRadius: 12, border: `1px solid ${T.border}`,
          boxShadow: '0 24px 60px rgba(15,23,42,0.30)', overflow: 'hidden',
        },
      },
        h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 10, padding: '11px 14px', borderBottom: `1px solid ${T.border}`, background: T.surface, position: 'sticky', top: 0, zIndex: 1 } },
          h('div', { style: { ...S.col, gap: 2, minWidth: 0 } },
            h('div', { style: { ...S.body, fontWeight: 700, fontSize: 14, color: T.text } }, title),
            subtitle ? h('div', { style: { ...S.muted, fontSize: 11 } }, subtitle) : null),
          h(Btn, { kind: 'ghost', onClick: onClose }, '关闭')),
        h('div', { style: { padding: 14 } }, children))),
    document.body)
}

/** 详情里的一行「标签：值」，空值直接跳过（不显示成 空/undefined）。 */
function KV({ label, children }) {
  if (children === null || children === undefined || children === '') return null
  return h('div', { style: { ...S.row, gap: 8, alignItems: 'baseline', marginBottom: 4 } },
    h('span', { style: { ...S.muted, minWidth: 74, flex: '0 0 auto', fontSize: 11.5 } }, label),
    h('span', { style: { ...S.body, minWidth: 0, wordBreak: 'break-word' } }, children))
}

function statusTone(status) {
  if (status === 'OPEN') return 'success'
  if (status === 'CLOSED') return 'error'
  if (status === 'UPCOMING') return 'accent'
  if (status === 'STALE') return 'warn'
  return undefined
}

function fmtDate(value) {
  if (!value) return '—'
  return String(value).slice(0, 10)
}

function relTime(iso) {
  if (!iso) return '—'
  const diff = Date.now() - Date.parse(iso)
  if (Number.isNaN(diff)) return String(iso).slice(0, 16)
  const min = Math.round(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function Bar({ value, max = 100, tone }) {
  const pct = Math.max(0, Math.min(100, (Number(value) / max) * 100))
  return h('div', { style: { height: 6, borderRadius: 999, background: T.surface2, overflow: 'hidden' } },
    h('div', { style: { width: `${pct}%`, height: '100%', background: tone ?? T.accent, borderRadius: 999 } }))
}

function Score({ value }) {
  if (value === null || value === undefined) return h('span', { style: S.muted }, '未评分')
  const tone = value >= 80 ? T.success : value >= 65 ? T.accent : value >= 50 ? T.warn : T.muted
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
    h('span', { style: { fontSize: 13, fontWeight: 700, color: tone } }, String(value)),
    h('span', { style: { width: 44 } }, h(Bar, { value, tone })))
}
