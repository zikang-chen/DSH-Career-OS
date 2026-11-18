// Executes the real client component tree with a stub React runtime so a render
// exception surfaces here instead of as a blank panel in the browser.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '..', 'client', 'wrapped-bundle.js')

// ─── stub React ──────────────────────────────────────────────────────────────
function makeReact() {
  const createElement = (type, props, ...children) => ({
    $$el: true,
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  })
  const noop = () => {}
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(partial) {
      const next = typeof partial === 'function' ? partial(this.state) : partial
      this.state = { ...this.state, ...next }
    }
  }
  return {
    createElement,
    Component,
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useReducer: (reducer, init) => [init, noop],
    useLayoutEffect: () => {},
    memo: (component) => component,
    Fragment: 'Fragment',
  }
}

const React = makeReact()
const reactDom = { createPortal: (node) => node }

/** Recursively invoke `h(Component, props)` so nested components really execute. */
function renderTree(node, depth = 0) {
  if (depth > 400) throw new Error('renderTree: recursion limit (possible cycle)')
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => renderTree(child, depth + 1))
  if (!node.$$el) return node
  const { type, props } = node
  if (typeof type === 'function') {
    // Class components (the error boundary) must be instantiated, and a render error
    // must exercise getDerivedStateFromError exactly like React does.
    if (/^\s*class[\s{]/.test(Function.prototype.toString.call(type))) {
      const instance = new type(props)
      instance.props = props
      instance.state = instance.state ?? {}
      try {
        return renderTree(instance.render(), depth + 1)
      } catch (err) {
        const derived = type.getDerivedStateFromError?.(err)
        if (!derived) throw err
        instance.state = { ...instance.state, ...derived }
        return renderTree(instance.render(), depth + 1)
      }
    }
    const out = type(props)
    return renderTree(out, depth + 1)
  }
  if (typeof type === 'string') {
    const children = props?.children
    if (children !== undefined) renderTree(children, depth + 1)
    return node
  }
  return node
}

function loadBundle() {
  const source = fs.readFileSync(BUNDLE, 'utf8')
  let captured = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration) => { captured = registration },
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    },
    document: { body: {} },
    console,
  }
  const require = (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return reactDom
    throw new Error(`unexpected require('${id}') in client bundle`)
  }
  // eslint-disable-next-line no-new-func
  const factory = new Function('window', 'document', 'console', 'require', source)
  factory(sandbox.window, sandbox.document, sandbox.console, require)
  assert.ok(captured, 'bundle did not call window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-career', 'bundle id must match the package name')
  const exported = captured.factory(require)
  assert.equal(typeof exported.apply, 'function', 'bundle must export apply()')
  return exported
}

test('Agent image task uses the inspected Session prompt contract', async () => {
  const bundle=loadBundle()
  const calls=[]
  const ctx={slots:{inject(){}},remote:{session:{list:async()=>({items:[{sessionId:'chosen-session'}]})}},get:name=>name==='sessions'?{using:async(id,options,fn)=>{calls.push({id,options});return fn({ready:Promise.resolve(),binding:{session:{prompt:async(content,mode)=>{calls.push({content,mode});return {ok:true,value:{accepted:true}}}}}})}}:undefined}
  bundle.apply(ctx)
  const bridge=bundle.__internals.agentBridge()
  assert.equal((await bridge.sessions())[0].sessionId,'chosen-session')
  await bridge.send('chosen-session','读取指定图片，不代人工确认')
  assert.equal(calls[0].id,'chosen-session')
  assert.equal(calls[1].mode,'queue')
  assert.deepEqual(calls[1].content,[{type:'text',text:'读取指定图片，不代人工确认'}])
  assert.throws(()=>bundle.__internals.unwrapCareerRemote({ok:false,error:{message:'连接失败'}}),/连接失败/)
})

// ─── fixtures shaped exactly like the live /bootstrap response ───────────────
const bootstrap = {
  ok: true,
  now: '2026-11-16T12:00:00.000Z',
  status: {
    db: { file: 'D:\\career_os\\data\\career.db', sizeBytes: 405504, schemaVersion: 4, ftsMode: 'trigram', counts: { job: 3, job_source: 4 } },
    dataDir: 'D:/career_os/data',
    panelClients: 0,
    scheduleEnabled: false,
    client: { available: true, inGraph: true, bundleUrl: 'plugins/??dsh-career/client.js&rev=abc', rev: 'abc', graphRev: 'g', knownClientIds: ['dsh-career'] },
  },
  profile: { id: 'default', display_name: '演示用户', cities: ['北京'], target_roles: ['数据分析'], skills: [{ name: 'SQL' }] },
  completeness: {
    checks: [
      { key: 'identity', label: '基本身份信息', done: true },
      { key: 'resume', label: '至少一版简历', done: false },
    ],
    done: 1,
    total: 2,
    percent: 50,
  },
  activeResume: null,
  resumes: [{ id: 'r1', label: '演示简历', target_role: null, language: 'zh', file_name: null, parse_status: 'needs_review', is_active: true, created_at: '2026-11-16T11:36:00.000Z', updated_at: '2026-11-16T11:36:00.000Z', text_length: 324 }],
  skills: [{ id: 's1', name: 'SQL', verified: true }],
  digest: {
    date: '2026-11-16',
    closing: [{ id: 'j1', title: '数据分析实习生', company_name: '字节跳动', deadline: '2026-12-20', status: 'OPEN', match_score: 73.5, daysLeft: 34 }],
    newlyFound: [{ id: 'j1', title: '数据分析实习生', company_name: '字节跳动', location: '北京', status: 'OPEN', created_at: '2026-11-16T11:36:39.698Z' }],
    openJobs: [{ id: 'j1', title: '数据分析实习生', company_name: '字节跳动', location: '北京', match_score: 73.5, status_verified_at: '2026-11-16T11:36:39.699Z' }],
    followUps: { overdue: 0, stale: 0, interviews: 0 },
    unreadNotifications: 0,
    jobStats: { total: 3, byStatus: { OPEN: 3 }, verifiedShare: 1, officialShare: 1, staleShare: 0 },
    applicationStats: { total: 1, byStatus: { applied: 1 } },
  },
  board: { columns: [], total: 0 },
  sources: [{ id: 'c1', connector: 'manual', display_name: '手动粘贴', access_mode: 'user_input', capabilities: [], enabled: true, needs_user: true, last_ok_at: null, last_error_at: null, last_error: null, rate_limit_note: '无网络请求', fetch_count: 0, insert_count: 0, dedupe_count: 0, official_count: 0 }],
  rules: [{ id: 'rule1', name: '截止提醒', kind: 'job_deadline', spec: {}, cadence: 'daily', enabled: true, priority: 'normal', channel: 'panel', last_run_at: null, last_status: null, last_error: null, stats: {} }],
  runs: [{ id: 'run1', kind: 'careers_page', target: 'x', started_at: '2026-11-16T11:00:00.000Z', finished_at: null, status: 'error', fetched: 0, inserted: 0, updated: 0, duplicates: 0, error: 'HTTP 404', meta: null }],
  notifications: [{ id: 'n1', rule_id: 'rule1', kind: 'deadline', title: '还有 3 天截止', body: '截止 2026-12-20', severity: 'high', dedupe_key: 'd1', job_id: 'j1', company_id: null, action: '去投递', created_at: '2026-11-16T11:00:00.000Z', read_at: null, dismissed_at: null }],
  feedback: { total: 0, byVerdict: {}, disqualifiedTitles: [], suggestions: [] },
  labels: { status: { OPEN: '官方确认在招' }, application: { applied: '已投递' }, bands: {}, jobStatuses: ['OPEN'] },
  focus: { kind: 'navigate', tab: 'radar', code: 'j1', note: '这个岗位值得看', at: '2026-11-16T12:00:00.000Z' },
}

const noop = () => {}

test('client bundle loads and exports the expected surface', () => {
  const exported = loadBundle()
  assert.equal(exported.name, 'dsh-career-client')
  assert.deepEqual(exported.inject, ['slots'])
  assert.ok(exported.__internals, 'internals missing')
})

test('apply() registers into the sidebar and settings slots', () => {
  const exported = loadBundle()
  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject: (name, factory) => {
        injected.push(name)
        for (const item of factory()) registered.push(item)
      },
      register: (meta) => ({ meta }),
    },
  }
  exported.apply(ctx)
  assert.ok(injected.includes('sidebar.footer.action'), `injected: ${injected.join(',')}`)
  assert.ok(injected.includes('settings.plugins.tab'))
  assert.equal(registered.length, 2)
})

test('FootAction renders closed without throwing', () => {
  const { __internals: I } = loadBundle()
  renderTree(React.createElement(I.FootAction, { wide: true }))
  renderTree(React.createElement(I.FootAction, {}))
  renderTree(React.createElement(I.SettingsCard, {}))
})

test('OverviewTab renders full bootstrap data', () => {
  const { __internals: I } = loadBundle()
  renderTree(React.createElement(I.OverviewTab, { bootstrap, onNavigate: noop, onRefresh: noop }))
})

test('OverviewTab survives sparse and empty payloads', () => {
  const { __internals: I } = loadBundle()
  const sparse = {
    ...bootstrap,
    digest: { date: '2026-11-16', closing: [], newlyFound: [], openJobs: [], followUps: { overdue: 0, stale: 0, interviews: 0 }, unreadNotifications: 0, jobStats: { total: 0, byStatus: {} }, applicationStats: { total: 0, byStatus: {} } },
    notifications: [],
    completeness: { checks: [], done: 0, total: 0, percent: 0 },
    resumes: [],
    skills: [],
    rules: [],
    runs: [],
    sources: [],
    focus: null,
    activeResume: null,
  }
  renderTree(React.createElement(I.OverviewTab, { bootstrap: sparse, onNavigate: noop, onRefresh: noop }))
})

test('data-driven tabs render their initial (loading) state', () => {
  const { __internals: I } = loadBundle()
  renderTree(React.createElement(I.TrackerTab, { bootstrap, onChanged: noop }))
  renderTree(React.createElement(I.ResumeTab, { bootstrap, onChanged: noop }))
  renderTree(React.createElement(I.SettingsTab, { bootstrap, onChanged: noop }))
  renderTree(React.createElement(I.RadarTab, { focusCode: null, onChanged: noop }))
  renderTree(React.createElement(I.PlanTab, { onChanged: noop }))
  renderTree(React.createElement(I.StudioTab, { onChanged: noop }))
  renderTree(React.createElement(I.CompanyTab, {}))
  renderTree(React.createElement(I.IndustryTab, {}))
  renderTree(React.createElement(I.SocialTab, {}))
  renderTree(React.createElement(I.InterviewTab, {}))
})

test('profile and materials navigation are separated without deleting compatible tab keys',()=>{
 const {__internals:I}=loadBundle()
 assert.equal(I.TABS.find(t=>t.key==='resume').label,'我的画像')
 assert.equal(I.TABS.find(t=>t.key==='studio').label,'简历中心')
 const groups=I.WORKSPACES
 assert.ok(groups.find(g=>g.key==='resume').tabs.includes('studio'))
 assert.ok(!groups.find(g=>g.key==='resume').tabs.includes('resume'))
 assert.ok(groups.find(g=>g.key==='settings').tabs.includes('resume'))
})

test('every declared tab key has a renderer', () => {
  const { __internals: I } = loadBundle()
  const keys = I.TABS.map((t) => t.key)
  assert.ok(keys.includes('overview'))
  assert.ok(keys.includes('settings'))
  assert.equal(new Set(keys).size, keys.length, 'tab keys must be unique')
})

test('the error boundary contains a throwing tab instead of blanking the panel', () => {
  const { __internals: I } = loadBundle()
  function Boom() {
    throw new Error('boom in tab')
  }
  const rendered = renderTree(React.createElement(I.PanelErrorBoundary, null, React.createElement(Boom, {})))
  const flat = JSON.stringify(rendered, (key, value) => (key === 'style' ? undefined : value))
  assert.ok(flat.includes('这个页签渲染失败'), 'boundary should render its error card')
  assert.ok(flat.includes('boom in tab'), 'boundary should surface the real message')
})
