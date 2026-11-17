// ─── entry points ────────────────────────────────────────────────────────────
function readOpenState() {
  try {
    return window.localStorage.getItem('careeros:open') === '1'
  } catch {
    return false
  }
}

function FootAction(props) {
  const [open, setOpen] = useState(readOpenState)
  const wide = props?.wide === true
  const toggle = (next) => {
    setOpen(next)
    try {
      window.localStorage.setItem('careeros:open', next ? '1' : '0')
    } catch {
      /* storage may be unavailable */
    }
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
  },
}
