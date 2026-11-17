// ─── theme ───────────────────────────────────────────────────────────────────
// 颜色优先级：宿主 token（--dsw-alias-*） > 本插件的作用域兜底（--careeros-*） > 浅色 hex。
// --careeros-* 在 GlobalStyles 里按浅色/深色定义，所以宿主不提供 token 时也能跟随系统深色。
const V = (name, key, fallback) => `var(${name}, var(--careeros-${key}, ${fallback}))`
const T = {
  bg: V('--dsw-alias-bg-base', 'bg', '#ffffff'),
  surface: V('--dsw-alias-bg-layer-1', 'surface', '#f7f8fa'),
  surface2: V('--dsw-alias-bg-layer-2', 'surface2', '#eef0f3'),
  overlay: V('--dsw-alias-bg-overlay', 'overlay', '#ffffff'),
  border: V('--dsw-alias-border-l1', 'border', '#e3e5e8'),
  border2: V('--dsw-alias-border-l2', 'border2', '#cfd3d8'),
  text: V('--dsw-alias-label-primary', 'text', '#111827'),
  muted: V('--dsw-alias-label-secondary', 'muted', '#6b7280'),
  accent: V('--dsw-alias-brand-primary', 'accent', '#2563eb'),
  error: V('--dsw-alias-state-error-primary', 'error', '#dc2626'),
  warn: V('--dsw-alias-state-warn-primary', 'warn', '#d97706'),
  success: V('--dsw-alias-state-success-primary', 'success', '#059669'),
  idle: V('--dsw-alias-state-idle-primary', 'idle', '#9ca3af'),
}

const S = {
  card: { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14 },
  cardTight: { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 10 },
  h1: { margin: 0, fontSize: 17, fontWeight: 650, color: T.text, letterSpacing: 0.2 },
  h2: { margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: T.text },
  h3: { margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: T.text },
  body: { fontSize: 13, lineHeight: 1.6, color: T.text },
  muted: { fontSize: 12, lineHeight: 1.55, color: T.muted },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: T.muted },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  col: { display: 'flex', flexDirection: 'column', gap: 10 },
  grid: (min) => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 10 }),
  input: {
    width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: 13, fontFamily: 'inherit',
    color: T.text, background: T.overlay, border: `1px solid ${T.border}`, borderRadius: 8, outline: 'none',
  },
  textarea: {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit',
    color: T.text, background: T.overlay, border: `1px solid ${T.border}`, borderRadius: 8,
    minHeight: 78, resize: 'vertical', outline: 'none', lineHeight: 1.55,
  },
  btn: (kind) => ({
    appearance: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 550,
    padding: '7px 12px', borderRadius: 8, border: `1px solid ${kind === 'primary' ? T.accent : T.border}`,
    background: kind === 'primary' ? T.accent : kind === 'ghost' ? 'transparent' : T.overlay,
    color: kind === 'primary' ? '#fff' : T.text, whiteSpace: 'nowrap',
  }),
  chip: (tone) => ({
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 999,
    fontSize: 11, fontWeight: 550, lineHeight: 1.7, whiteSpace: 'nowrap',
    color: tone === 'error' ? T.error : tone === 'warn' ? T.warn : tone === 'success' ? T.success : tone === 'accent' ? T.accent : T.muted,
    background: tone === 'error' ? 'rgba(220,38,38,0.10)' : tone === 'warn' ? 'rgba(217,119,6,0.12)' : tone === 'success' ? 'rgba(5,150,105,0.12)' : tone === 'accent' ? 'rgba(37,99,235,0.12)' : 'rgba(107,114,128,0.12)',
    border: '1px solid transparent',
  }),
}
