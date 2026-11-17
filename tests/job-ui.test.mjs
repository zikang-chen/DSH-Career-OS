import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

const source = fs.readFileSync(new URL('../client/parts/06-Internship-Radar.cjs', import.meta.url), 'utf8')
function harness() {
  const states = [], refs = [], calls = [], navigation = []
  let cursor = 0, refCursor = 0
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const symbols = ['Loading', 'Empty', 'Chip', 'Score', 'Field', 'Btn', 'Modal', 'KV']
  const factory = new Function('h', 'useState', 'useRef', 'useCallback', 'useEffect', 'apiGet', 'apiPost', 'S', 'T', 'fmtDate', 'relTime', 'statusTone', ...symbols, source + '\nreturn { RadarTab, radarJD, radarFilter };')
  const api = factory(h,
    (initial) => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (next) => { states[i] = typeof next === 'function' ? next(states[i]) : next }] },
    (initial) => { const i = refCursor++; return refs[i] ?? (refs[i] = { current: initial }) },
    (fn) => fn, () => {},
    async (url) => { calls.push(['GET', url]); return { job: { id: 'j1', title: '岗位', application: null } } },
    async (url, body) => { calls.push(['POST', url, body]); return { application: { id: 'a1' } } },
    { grid: () => ({}), btn: () => ({}) }, {}, (x) => x, (x) => x, () => '', ...symbols)
  return { ...api, states, calls, navigation, render() { cursor = 0; refCursor = 0; return api.RadarTab({ onNavigate: (...args) => navigation.push(args) }) } }
}
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.children)] }
function text(tree) { return !tree ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.children) }

test('Radar is a standalone syntactically complete part; browse precedes collapsed add forms', () => {
  const app = harness(); const tree = app.render(); const all = nodes(tree)
  assert.ok(text(tree).indexOf('找岗位') < text(tree).indexOf('添加岗位'))
  const add = all.find((n) => n.type === 'details' && text(n).includes('添加岗位'))
  assert.ok(add); assert.notEqual(add.props.open, true)
  assert.match(text(tree), /当前加载页/)
  assert.match(text(tree), /只看完整 JD/)
  assert.ok(!source.includes('onDoubleClick'))
})

test('JD filter is conservative, missing values never become a complete JD', () => {
  const { radarJD, radarFilter } = harness()
  assert.equal(radarJD({ description: '职责' }).complete, false)
  assert.equal(radarJD({ description: ' ', requirements: '要求' }).complete, false)
  const jobs = [{ id: 1, location: '北京', recruitType: 'summer', description: '职责', requirements: '要求' }, { id: 2, location: '上海', recruit_type: 'daily' }]
  assert.deepEqual(radarFilter(jobs, { city: '北京', recruit: 'summer', completeOnly: true }).map((j) => j.id), [1])
  assert.equal(radarFilter(jobs, { completeOnly: true }).length, 1)
})

test('job cards show core facts, unknown salary/source, and keyboard access', () => {
  const app = harness(); app.render()
  // Find list state by the actual declaration order rather than coupling to a generated bundle.
  const listIndex = (source.slice(source.indexOf('function RadarTab'), source.indexOf('const [list,')).match(/const \[/g) ?? []).length
  app.states[listIndex] = { jobs: [{ id: 'j1', title: '产品实习', company: '公司' }] }
  const tree = app.render(); assert.match(text(tree), /薪酬 未知/); assert.match(text(tree), /来源 未知/)
  const card = nodes(tree).find((n) => n.props.role === 'button'); assert.equal(card.props.tabIndex, 0)
  card.props.onClick(); assert.equal(app.calls.filter(([method]) => method === 'GET').length, 1)
})

test('existing application navigates with job context; repeated create clicks share a lock', async () => {
  const app = harness(); app.render()
  const stateIndex = (name) => (source.slice(source.indexOf('function RadarTab'), source.indexOf(`const [${name},`)).match(/const \[/g) ?? []).length
  app.states[stateIndex('detailOpen')] = true
  app.states[stateIndex('detail')] = { id: 'j1', title: '岗位', description: '设计需求', requirements: '熟悉原型', application: { id: 'a1' } }
  let tree = app.render()
  assert.ok(text(tree).indexOf('工作职责') < text(tree).indexOf('基本信息'))
  assert.ok(text(tree).indexOf('任职要求') < text(tree).indexOf('基本信息'))
  const metadata = nodes(tree).find((n) => n.type === 'details' && text(n).includes('来源证据、历史与状态维护'))
  assert.ok(metadata); assert.notEqual(metadata.props.open, true)
  const findAction = (label) => nodes(tree).find((n) => n.type === 'Btn' && text(n) === label)
  await findAction('查看投递进度').props.onClick()
  assert.deepEqual(app.navigation, [['tracker', 'j1']]); assert.equal(app.calls.length, 0)
  findAction('准备简历').props.onClick(); findAction('JD 面试准备').props.onClick()
  assert.deepEqual(app.navigation.slice(1), [['studio', 'j1'], ['interview', 'j1']])
  app.states[stateIndex('detail')] = { id: 'j1', title: '岗位', application: null }; tree = app.render()
  const track = findAction('加入投递').props.onClick
  await Promise.all([track(), track()])
  assert.equal(app.calls.filter(([method, url]) => method === 'POST' && url === '/application').length, 1)
  assert.ok(text(tree).indexOf('工作职责') < text(tree).indexOf('基本信息') || text(tree).includes('JD 正文未知'))
})
