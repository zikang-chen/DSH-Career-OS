// One-off check: render OverviewTab with the LIVE /bootstrap payload (not a fixture).
import fs from 'node:fs'

const origin = process.argv[2] ?? 'http://127.0.0.1:49152'

function makeReact() {
  const createElement = (type, props, ...children) => ({ $$el: true, type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } })
  const noop = () => {}
  class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(partial) { this.state = { ...this.state, ...(typeof partial === 'function' ? partial(this.state) : partial) } }
  }
  return {
    createElement, Component,
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
    useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }), useReducer: (r, i) => [i, noop], useLayoutEffect: () => {},
    memo: (c) => c, Fragment: 'Fragment',
  }
}
const React = makeReact()

function renderTree(node, depth = 0) {
  if (depth > 400) throw new Error('recursion limit')
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((c) => renderTree(c, depth + 1))
  if (!node.$$el) return node
  const { type, props } = node
  if (typeof type === 'function') {
    if (/^\s*class[\s{]/.test(Function.prototype.toString.call(type))) {
      const inst = new type(props)
      inst.props = props
      inst.state = inst.state ?? {}
      try { return renderTree(inst.render(), depth + 1) } catch (err) {
        const derived = type.getDerivedStateFromError?.(err)
        if (!derived) throw err
        inst.state = { ...inst.state, ...derived }
        return renderTree(inst.render(), depth + 1)
      }
    }
    return renderTree(type(props), depth + 1)
  }
  if (props?.children !== undefined) renderTree(props.children, depth + 1)
  return node
}

function loadBundle() {
  const source = fs.readFileSync('D:\\career_os\\client\\wrapped-bundle.js', 'utf8')
  let captured = null
  const req = (id) => (id === 'react' ? React : id === 'react-dom' ? { createPortal: (n) => n } : (() => { throw new Error(`unexpected require ${id}`) })())
  new Function('window', 'document', 'console', 'require', source)(
    { __ModuleLoader__: { load: (r) => { captured = r } }, localStorage: { getItem: () => null, setItem: () => {} } },
    { body: {} }, console, req,
  )
  return captured.factory(req)
}

const res = await fetch(`${origin}/plugins/dsh-career/api/bootstrap`)
const bootstrap = await res.json()
console.log('live bootstrap: ok =', bootstrap.ok, '| jobs =', bootstrap.digest?.jobStats?.total, '| apps =', bootstrap.digest?.applicationStats?.total)
console.log('top-level keys:', Object.keys(bootstrap).join(','))
console.log('jobStats at top level?', 'jobStats' in bootstrap, '| inside digest?', Boolean(bootstrap.digest?.jobStats))

const I = loadBundle().__internals
for (const [name, el] of [
  ['OverviewTab(live)', React.createElement(I.OverviewTab, { bootstrap, onNavigate: () => {}, onRefresh: () => {} })],
  ['TrackerTab(live)', React.createElement(I.TrackerTab, { bootstrap, onChanged: () => {} })],
  ['ResumeTab(live)', React.createElement(I.ResumeTab, { bootstrap, onChanged: () => {} })],
  ['SettingsTab(live)', React.createElement(I.SettingsTab, { bootstrap, onChanged: () => {} })],
]) {
  try {
    renderTree(el)
    console.log(`PASS ${name}`)
  } catch (err) {
    console.log(`FAIL ${name}: ${err.message}`)
  }
}
