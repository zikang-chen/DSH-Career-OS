// ─── global styles (mounted once by the panel) ───────────────────────────────
function GlobalStyles() {
  return h('style', null, `
@keyframes careeros-spin { to { transform: rotate(360deg) } }
.careeros-root {
  --careeros-bg: #ffffff; --careeros-surface: #f7f8fa; --careeros-surface2: #eef0f3; --careeros-overlay: #ffffff;
  --careeros-border: #e3e5e8; --careeros-border2: #cfd3d8; --careeros-text: #111827; --careeros-muted: #6b7280;
  --careeros-accent: #2563eb; --careeros-error: #dc2626; --careeros-warn: #d97706; --careeros-success: #059669; --careeros-idle: #9ca3af;
}
@media (prefers-color-scheme: dark) {
  .careeros-root {
    --careeros-bg: #0f1115; --careeros-surface: #171a21; --careeros-surface2: #1f232c; --careeros-overlay: #1b1f27;
    --careeros-border: #2a2f3a; --careeros-border2: #3a4050; --careeros-text: #e6e9ef; --careeros-muted: #9aa4b2;
    --careeros-accent: #6ea8fe; --careeros-error: #f87171; --careeros-warn: #fbbf24; --careeros-success: #34d399; --careeros-idle: #6b7280;
  }
}
.careeros-root * { box-sizing: border-box }
.careeros-root input:focus, .careeros-root textarea:focus, .careeros-root select:focus { border-color: ${T.accent} }
.careeros-root ::-webkit-scrollbar { width: 9px; height: 9px }
.careeros-root ::-webkit-scrollbar-thumb { background: ${T.border2}; border-radius: 8px }
.careeros-nav button { text-align: left; width: 100% }
`)
}
