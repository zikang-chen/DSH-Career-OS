// ─── entry points ────────────────────────────────────────────────────────────
function readOpenState() {
  try {
    return window.localStorage.getItem('careeros:open') === '1'
  } catch {
    return false
  }
}

// Pull the active workspace path out of whichever snapshot shape the host hook provides.
// Unknown shapes return null, and the caller keeps the button (fail-open) rather than
// hiding a working entry point on a guess.
function activeWorkspacePath(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const list = Array.isArray(snapshot.items) ? snapshot.items
    : Array.isArray(snapshot.workspaces) ? snapshot.workspaces
      : Array.isArray(snapshot.list) ? snapshot.list : []
  const activeId = snapshot.activeId ?? snapshot.activeWorkspaceId ?? snapshot.selectedId
    ?? snapshot.currentWorkspaceId ?? snapshot.current ?? null
  const pick = (entry) => (entry && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : null)
  if (Array.isArray(list) && list.length) {
    if (activeId) {
      const hit = list.find((w) => w && (w.workspaceId === activeId || w.id === activeId))
      const path = pick(hit)
      if (path) return path
    }
    const flagged = list.find((w) => w && (w.active === true || w.selected === true))
    const flaggedPath = pick(flagged)
    if (flaggedPath) return flaggedPath
  }
  const direct = snapshot.activePath ?? snapshot.currentPath ?? snapshot.path ?? snapshot.cwd
  return typeof direct === 'string' ? direct : null
}

// CareerOS only belongs in its own workspace; re-check whenever the workspace changes.
function useCareerWorkspace(useWorkspaces) {
  const [state, setState] = useState({ checked: false, inCareer: true })
  let snapshot = null
  try {
    snapshot = typeof useWorkspaces === 'function' ? useWorkspaces((value) => value) : null
  } catch {
    snapshot = null
  }
  const path = activeWorkspacePath(snapshot)
  useEffect(() => {
    if (!path) return
    let alive = true
    apiGet(`/scope?path=${encodeURIComponent(path)}`)
      .then((res) => { if (alive) setState({ checked: true, inCareer: res?.inCareer !== false }) })
      .catch(() => { if (alive) setState({ checked: false, inCareer: true }) })
    return () => { alive = false }
  }, [path])
  return state
}

function FootAction(props) {
  const [open, setOpen] = useState(readOpenState)
  const scope = useCareerWorkspace(props?.useWorkspaces)
  const wide = props?.wide === true
  const toggle = (next) => {
    setOpen(next)
    try {
      window.localStorage.setItem('careeros:open', next ? '1' : '0')
    } catch {
      /* storage may be unavailable */
    }
  }
  // Outside the career workspace: render nothing (and close an already-open panel).
  if (scope.checked && !scope.inCareer) {
    if (open) {
      try { window.localStorage.setItem('careeros:open', '0') } catch { /* ignore */ }
      setOpen(false)
    }
    return null
  }
  return h('div', null,
    h('button', {
      type: 'button', title: '求职面板 CareerOS', onClick: () => toggle(!open),
      style: {
        display: 'flex', alignItems: 'center', boxSizing: 'border-box', cursor: 'pointer',
        border: 'none', overflow: 'hidden', fontFamily: 'inherit',
        background: open ? T.surface2 : 'transparent', color: T.text,
        ...(wide
          ? { gap: 8, width: 'calc(100% + 4px)', height: 42, margin: '4px -2px', padding: '0 10px 0 8px', borderRadius: 12, fontSize: 14, lineHeight: '22px', justifyContent: 'flex-start' }
          : { gap: 0, width: 36, height: 36, margin: '8px 0 10px', padding: 0, borderRadius: '50%', justifyContent: 'center' }),
      },
    }, h('span', { style: { fontSize: wide ? 15 : 17, lineHeight: 1 } }, '🎯'), wide ? h('span', { style: { overflow: 'hidden', whiteSpace: 'nowrap' } }, '求职面板') : null),
    open ? h(Panel, { onClose: () => toggle(false) }) : null)
}

function SettingsCard() {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, fontSize: 13, color: T.text } },
    h('h3', { style: { margin: 0 } }, 'CareerOS'),
    h('p', { style: { margin: 0, ...S.muted } }, '个人求职情报与实习管理系统：简历与画像、岗位雷达、可解释匹配、投递 CRM、公司与行业研究、论坛情报、面试准备与监控提醒。'),
    h('p', { style: { margin: 0, ...S.muted } }, '所有数据保存在本机 SQLite；不会自动投递简历或对外发信。支持专用浏览器登录与低频采集；来源、JD、图片待识别与采集失败会明确区分，不绕过登录或会员限制。'))
}

const name = 'dsh-career-client'
const inject = ['slots']

function apply(ctx) {
  careerAgentBridge = {
    async sessions() { return unwrapCareerRemote(await ctx.remote.session.list({})).items || [] },
    async send(sessionId,text) {
      const controller=ctx.get ? ctx.get('sessions') : ctx.sessions
      if(!controller)throw new Error('当前客户端未提供会话服务，请复制指令到对话')
      return controller.using(sessionId,{source:'controllerOperation'},async ref=>{
        await ref.ready
        return unwrapCareerRemote(await ref.binding.session.prompt([{type:'text',text}], 'queue'))
      })
    },
  }
  const safe = (label, fn) => {
    try {
      fn()
    } catch (err) {
      try {
        console.warn(`[dsh-career] ${label} failed`, err)
      } catch {
        /* ignore */
      }
    }
  }

  safe('sidebar.footer.action', () => {
    ctx.slots.inject('sidebar.footer.action', function* () {
      yield ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-career' }, (props) => h(FootAction, props))
    })
  })

  safe('settings.plugins.tab', () => {
    ctx.slots.inject('settings.plugins.tab', function* () {
      yield ctx.slots.register({ name: 'settings.plugins.tab', id: 'dsh-career', order: 30, label: 'CareerOS' }, () => h(SettingsCard, null))
    })
  })
}

module.exports = {
  name,
  inject,
  apply,
  // Test hooks: lets tests/render.test.mjs execute the real component tree with a
  // stub React runtime (no browser needed) so a render error is caught before ship.
  __internals: {
    Panel,
    PanelErrorBoundary,
    FootAction,
    SettingsCard,
    OverviewTab,
    PlanTab,
    StudioTab,
    ResumeTab,
    RadarTab,
    TrackerTab,
    CompanyTab,
    IndustryTab,
    SocialTab,
    InterviewTab,
    SettingsTab,
    TABS,
    WORKSPACES,
    unwrapCareerRemote,
    agentBridge: () => careerAgentBridge,
  },
}
