import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

const source = fs.readFileSync(new URL('../client/parts/06-Internship-Radar.cjs', import.meta.url), 'utf8')
function harness({ get, post } = {}) {
  const states = [], refs = [], calls = [], navigation = []
  let cursor = 0, refCursor = 0
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const symbols = ['Loading', 'Empty', 'Chip', 'Score', 'Field', 'Btn', 'Modal', 'KV']
  const factory = new Function('h', 'useState', 'useRef', 'useCallback', 'useEffect', 'apiGet', 'apiPost', 'S', 'T', 'fmtDate', 'relTime', 'statusTone', ...symbols, source + '\nreturn { RadarTab, radarJD, radarFilter };')
  const api = factory(h,
    (initial) => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (next) => { states[i] = typeof next === 'function' ? next(states[i]) : next }] },
    (initial) => { const i = refCursor++; return refs[i] ?? (refs[i] = { current: initial }) },
    (fn) => fn, () => {},
    async (url) => { calls.push(['GET', url]); return get ? get(url) : { job: { id: 'j1', title: '岗位', application: null } } },
    async (url, body) => { calls.push(['POST', url, body]); return post ? post(url, body) : { application: { id: 'a1' } } },
    { grid: () => ({}), btn: () => ({}) }, {}, (x) => x, (x) => x, () => '', ...symbols)
  return { ...api, states, calls, navigation, render() { cursor = 0; refCursor = 0; return api.RadarTab({ onNavigate: (...args) => navigation.push(args) }) } }
}
function stateIndex(name) { return (source.slice(source.indexOf('function RadarTab'), source.indexOf(`const [${name},`)).match(/const \[/g) ?? []).length }
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.children)] }
function text(tree) { return !tree ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.children) }

test('Radar is a standalone syntactically complete part; browse precedes collapsed add forms', () => {
  const app = harness(); const tree = app.render(); const all = nodes(tree)
  assert.ok(text(tree).indexOf('找岗位') < text(tree).indexOf('添加岗位'))
  const add = all.find((n) => n.type === 'details' && text(n).includes('添加岗位'))
  assert.ok(add); assert.notEqual(add.props.open, true)
  assert.match(text(tree), /本地全库符合/)
  assert.doesNotMatch(source, /仅筛选当前加载页|城市（当前页）/)
  assert.match(text(tree), /不代表全网/)
  assert.match(text(tree), /只看完整 JD/)
  assert.ok(!source.includes('onDoubleClick'))
})

test('legacy JD helpers remain conservative; browse no longer applies the local filter', () => {
  assert.doesNotMatch(source, /const visibleJobs = radarFilter/)
  const { radarJD, radarFilter } = harness()
  assert.equal(radarJD({ description: '职责' }).complete, false)
  assert.equal(radarJD({ description: ' ', requirements: '要求' }).complete, false)
  const jobs = [{ id: 1, location: '北京', recruitType: 'summer', description: '职责', requirements: '要求' }, { id: 2, location: '上海', recruit_type: 'daily' }]
  assert.deepEqual(radarFilter(jobs, { city: '北京', recruit: 'summer', completeOnly: true }).map((j) => j.id), [1])
  assert.equal(radarFilter(jobs, { completeOnly: true }).length, 1)
})

test('default table exposes all columns and cards retain facts and keyboard access', () => {
  const app = harness(); app.render()
  // Find list state by the actual declaration order rather than coupling to a generated bundle.
  const listIndex = (source.slice(source.indexOf('function RadarTab'), source.indexOf('const [list,')).match(/const \[/g) ?? []).length
  app.states[listIndex] = { jobs: [{ id: 'j1', title: '产品实习', company: '公司' }] }
  let tree = app.render()
  assert.ok(nodes(tree).find((n) => n.type === 'table'))
  assert.deepEqual(nodes(tree).filter((n) => n.type === 'th').map(text), ['对比', '公司', '岗位', '类型', '城市', '状态', '截止', 'JD', '核验 / 操作'])
  nodes(tree).find((n) => n.type === 'Btn' && text(n) === '卡片').props.onClick()
  tree = app.render(); assert.match(text(tree), /薪酬 未知/); assert.match(text(tree), /来源 未知/)
  const card = nodes(tree).find((n) => n.props.role === 'button'); assert.equal(card.props.tabIndex, 0)
  card.props.onClick(); assert.equal(app.calls.filter(([method]) => method === 'GET').length, 1)
})

test('server conditions reset pagination and requests carry every full-library condition', async () => {
  const app = harness({ get: () => ({ total: 45, offset: 20, count: 1, jobs: [{ id: 'j1', location: '深圳', title: '服务端结果' }], scope: '本地全库' }) })
  app.render()
  const values = { query: '产品', status: 'OPEN', minScore: '60', city: '北京,上海', recruit: 'summer', completeOnly: true, remoteType: 'hybrid', gradYear: '2027', daysPerWeekMax: '4', offset: 20 }
  for (const [key, value] of Object.entries(values)) app.states[stateIndex(key)] = value
  let tree = app.render()
  await nodes(tree).find((n) => n.type === 'Btn' && text(n) === '刷新').props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const params = new URL(app.calls[0][1], 'http://local').searchParams
  assert.deepEqual(Object.fromEntries(params), { query: '产品', status: 'OPEN', minScore: '60', location: '北京,上海', recruitType: 'summer', jdComplete: 'true', remoteType: 'hybrid', gradYear: '2027', daysPerWeekMax: '4', limit: '20', offset: '20' })
  tree = app.render()
  assert.match(text(tree), /本地全库符合 45 条 · 本页 1 条 · 当前范围 21–21/)
  assert.match(text(tree), /服务端结果/) // No second client-side city/type/JD filtering.
  const button = (label) => nodes(tree).find((n) => n.type === 'Btn' && text(n) === label)
  button('下一页').props.onClick(); assert.equal(app.states[stateIndex('offset')], 40)
  tree = app.render(); button('上一页').props.onClick(); assert.equal(app.states[stateIndex('offset')], 20)
  for (const label of ['城市（全库，可逗号分隔）', '招聘类型（全库）', '最低匹配分', '用工形式', '毕业年份', '每周最多出勤天数']) {
    app.states[stateIndex('offset')] = 20; tree = app.render()
    nodes(tree).find((n) => n.props['aria-label'] === label).props.onChange({ target: { value: '' } })
    assert.equal(app.states[stateIndex('offset')], 0, label)
  }
  for (const field of ['query', 'status', 'completeOnly']) {
    app.states[stateIndex('offset')] = 20; tree = app.render()
    const control = nodes(tree).find((n) => field === 'query' ? n.props.placeholder === '搜索公司/岗位/JD 关键词' : field === 'status' ? n.type === 'select' && n.props.value === 'OPEN' : n.props.type === 'checkbox')
    control.props.onChange({ target: { value: '', checked: false } })
    assert.equal(app.states[stateIndex('offset')], 0, field)
  }
  app.states[stateIndex('offset')] = 40; tree = app.render(); assert.equal(button('下一页').props.disabled, true)
  app.states[stateIndex('offset')] = 0; tree = app.render(); assert.equal(button('上一页').props.disabled, true)
  assert.match(source, /\[query, status, minScore, city, recruit, completeOnly, remoteType, gradYear, daysPerWeekMax, offset\]/)
})

test('late list and detail responses do not overwrite newer requests or assessments', async () => {
  const pending = []
  const app = harness({ get: (url) => new Promise((resolve) => pending.push({ url, resolve })) })
  let tree = app.render()
  const refresh = () => nodes(tree).find((n) => n.type === 'Btn' && text(n) === '刷新').props.onClick()
  refresh(); refresh()
  pending[1].resolve({ total: 1, jobs: [{ id: 'new', title: '新结果' }] }); await new Promise((resolve) => setImmediate(resolve))
  pending[0].resolve({ total: 1, jobs: [{ id: 'old', title: '旧结果' }] }); await new Promise((resolve) => setImmediate(resolve))
  assert.equal(app.states[stateIndex('list')].jobs[0].id, 'new')
  tree = app.render()
  nodes(tree).find((n) => n.type === 'button').props.onClick()
  nodes(tree).find((n) => n.type === 'button').props.onClick()
  pending[3].resolve({ job: { id: 'new' }, assessment: { version: 2 } }); await new Promise((resolve) => setImmediate(resolve))
  pending[2].resolve({ job: { id: 'old' }, assessment: { version: 1 } }); await new Promise((resolve) => setImmediate(resolve))
  assert.equal(app.states[stateIndex('detail')].id, 'new')
  assert.equal(app.states[stateIndex('assessment')].version, 2)
})

test('assessment stays separate, collapsed and explicit about unknowns and provenance', async () => {
  const assessment = { profileConfirmation: 'unconfirmed', eligibility: { status: 'unknown', checks: [{ label: '毕业年份', status: 'unknown', explanation: '需核对', jobEvidence: '2027届' }] }, fit: { score: 72, reliable: false }, evidence: { statusAssessment: 'open-unverified' }, taskAnalysis: { tasks: [{ text: '访谈', label: 'JD抽取', sourceField: 'description' }] }, unknowns: ['专业未确认'] }
  const app = harness({ get: () => ({ job: { id: 'j1', title: '测试岗位' }, assessment }) }); app.render()
  app.states[stateIndex('list')] = { total: 1, count: 1, jobs: [{ id: 'j1', title: '测试岗位' }] }
  let tree = app.render(); nodes(tree).find((n) => n.type === 'button').props.onClick(); await Promise.resolve(); await Promise.resolve()
  tree = app.render()
  assert.deepEqual(app.states[stateIndex('assessment')], assessment)
  const section = nodes(tree).find((n) => n.type === 'details' && text(n).includes('Eligibility / Fit / Evidence'))
  assert.ok(section); assert.notEqual(section.props.open, true)
  assert.match(text(section), /匹配分：72/); assert.match(text(section), /岗位依据：2027届/)
  assert.match(text(section), /画像依据：未知/); assert.match(text(section), /open-unverified/)
  assert.match(text(section), /专业未确认/); assert.match(text(section), /访谈 · JD抽取 · 来源字段 description/)
})

test('official verification requires source and excerpt and displays server warnings without fake success', async () => {
  const app = harness({ post: () => ({ warning: '证据未通过核验，状态未改' }) }); app.render()
  app.states[stateIndex('selected')] = 'j1'
  app.states[stateIndex('detailOpen')] = true
  app.states[stateIndex('detail')] = { id: 'j1', title: '岗位' }
  let tree = app.render()
  const verify = () => nodes(tree).find((n) => n.type === 'Btn' && text(n) === '官方在招（官方）').props.onClick()
  await verify(); assert.equal(app.calls.length, 0)
  assert.match(app.states[stateIndex('error')], /尚未修改状态/)
  tree = app.render()
  nodes(tree).find((n) => n.props['aria-label'] === '核验官方来源链接').props.onChange({ target: { value: 'https://jobs.example.com/j1' } })
  nodes(tree).find((n) => n.props['aria-label'] === '核验证据摘录').props.onChange({ target: { value: '该岗位正在招聘' } })
  tree = app.render(); await verify()
  assert.deepEqual(app.calls[0], ['POST', '/job/verify', { id: 'j1', status: 'OPEN', official: true, sourceUrl: 'https://jobs.example.com/j1', evidence: '该岗位正在招聘' }])
  assert.equal(app.calls.length, 1)
  assert.match(app.states[stateIndex('error')], /证据未通过核验/)
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

const flush = () => new Promise((resolve) => setImmediate(resolve))
async function openJob(app, id = 'j1') {
  app.render()
  app.states[stateIndex('list')] = { jobs: [{ id, title: '岗位' }] }
  nodes(app.render()).find((n) => n.type === 'button').props.onClick()
  await flush()
  return app.render()
}

test('Job360 integrates company intelligence and resume preparation without replacing main detail', async () => {
  const job360 = {
    company: { id: 'c1', name: '某公司', business: '企业服务', industry: '软件', careersUrl: 'https://example.com/jobs', units: [{ id: 'u1', name: '核心部门', business: '协作产品' }], reports: [{ id: 'r1', title: '公司简报', body: '公开研究事实' }] },
    knowledge: [{ id: 'k1', title: '真实面经', kind: 'interview', platform: 'nowcoder', completeness: 'full', publishedAt: '2026-10-01', body: '面试过程摘录', url: 'https://example.com/interview' }],
    resumePlan: { selected: [{ id: 'e1', organization: '实习公司', role: '产品实习', bullets: 3 }], gaps: ['待确认到岗日期'], quality: { issues: [{ message: '教育时间缺失' }] }, skillAdvice: { summary: '突出真实成果', perBullet: [{ bullet: '完成用户调研', issues: ['补充真实样本规模'], skillIds: ['quantify'] }], jdCoverage: { missing: ['SQL'], note: '仅按已存JD比对' } } },
    application: null, resumeVersions: [{ id: 'v1', label: '产品版' }],
  }
  const app = harness({ get: () => ({ job: { id: 'j1', title: '产品岗位', description: '岗位职责正文', requirements: '学历条件' }, assessment: {}, job360 }) })
  const tree = await openJob(app)
  assert.deepEqual(app.states[stateIndex('job360')], job360)
  assert.deepEqual(nodes(tree).filter((n) => n.props['data-job360']).map((n) => n.props['data-job360']).sort(), ['intelligence', 'job', 'match', 'preparation'])
  for (const value of ['岗位职责正文', '学历条件', '企业服务', '核心部门', '公司简报', '真实面经', '面试过程摘录', '实习公司', '建议保留 3 条', '待确认到岗日期', '教育时间缺失', '突出真实成果', '完成用户调研', '补充真实样本规模', 'JD 待覆盖关键词：SQL']) assert.ok(text(tree).includes(value), value)
  assert.match(text(tree), /不会向外部网站投递/)
  assert.ok(nodes(tree).find((n) => n.type === 'option' && n.props.value === 'v1'))
  assert.doesNotMatch(text(tree), /\[object Object\]|\{"/)
})

test('Job360 draft submits selected version and user fields once, then locates existing application', async () => {
  const job360 = { application: null, resumeVersions: [{ id: 'v1', label: '产品版' }] }
  const app = harness({ get: (url) => url.startsWith('/job?') ? { job: { id: 'j1', title: '岗位' }, job360 } : { jobs: [] } })
  let tree = await openJob(app)
  const button = (label) => nodes(tree).find((n) => n.type === 'Btn' && text(n) === label)
  assert.equal(button('保存申请草稿').props.disabled, true)
  for (const [label, value] of [['申请草稿简历版本', 'v1'], ['申请草稿渠道', ' 官网 '], ['申请草稿下一步日期', '2026-11-20'], ['申请草稿备注', ' 先核对JD ']]) {
    nodes(tree).find((n) => n.props['aria-label'] === label).props.onChange({ target: { value } }); tree = app.render()
  }
  const save = button('保存申请草稿').props.onClick
  await Promise.all([save(), save()])
  const posts = app.calls.filter(([method, url]) => method === 'POST' && url === '/application')
  assert.deepEqual(posts, [['POST', '/application', { jobId: 'j1', status: 'saved', resumeVersionId: 'v1', channel: '官网', nextActionAt: '2026-11-20', notes: '先核对JD' }]])
  tree = app.render(); button('定位已有申请记录').props.onClick()
  assert.deepEqual(app.navigation.at(-1), ['tracker', 'j1'])
})

test('Job360 missing research has explicit navigation actions, preserving job context without pretending a search ran', async () => {
  const app = harness(); const tree = await openJob(app)
  for (const type of ['intelligence', 'preparation', 'match', 'job']) {
    const section = nodes(tree).find((n) => n.props['data-job360'] === type)
    assert.ok(section, type); assert.ok(nodes(section).some((n) => n.type === 'Btn'), `${type} empty state action`)
  }
  assert.match(text(tree), /未研究/); assert.match(text(tree), /未执行 AI 研究/); assert.match(text(tree), /尚无可用经历方案/)
  nodes(tree).find((n) => n.type === 'Btn' && text(n).startsWith('去知识库检索')).props.onClick()
  assert.deepEqual(app.navigation.at(-1), ['social', 'j1'])
  assert.match(text(tree), /需手动输入公司 \/ 岗位/)
})

test('Job360 state and draft fields clear immediately on job switch; late response cannot restore old company', async () => {
  const pending = []
  const app = harness({ get: (url) => new Promise((resolve) => pending.push({ url, resolve })) })
  app.render(); app.states[stateIndex('list')] = { jobs: [{ id: 'j1', title: '岗位一' }, { id: 'j2', title: '岗位二' }] }
  let tree = app.render()
  const buttons = () => nodes(tree).filter((n) => n.type === 'button')
  buttons()[0].props.onClick()
  app.states[stateIndex('job360')] = { company: { name: '旧公司' } }
  app.states[stateIndex('draftForm')] = { resumeVersionId: 'old', channel: '旧渠道', nextActionAt: '', notes: '旧备注' }
  buttons()[1].props.onClick()
  assert.equal(app.states[stateIndex('job360')], null)
  assert.deepEqual(app.states[stateIndex('draftForm')], { resumeVersionId: '', channel: '', nextActionAt: '', notes: '' })
  pending[1].resolve({ job: { id: 'j2' }, job360: { company: { name: '新公司' } } }); await flush()
  pending[0].resolve({ job: { id: 'j1' }, job360: { company: { name: '旧公司' } } }); await flush()
  assert.equal(app.states[stateIndex('job360')].company.name, '新公司')
  assert.equal(app.states[stateIndex('detail')].id, 'j2')
})

test('server status display and evidence override historical OPEN; unreliable matches are not bare scores', () => {
  const app = harness(); app.render()
  app.states[stateIndex('list')] = { jobs: [{ id: 'j1', title: '岗位', status: 'OPEN', statusDisplay: '过期，需重新核验', statusEvidenceLevel: 'C', matchScore: 99, matchReliable: false }, { id: 'j2', status: 'OPEN' }] }
  const tree = app.render()
  assert.match(text(tree), /过期，需重新核验/); assert.match(text(tree), /证据等级 C/)
  assert.match(text(tree), /历史记录在招（当前待核实）/); assert.match(text(tree), /匹配待核对/)
  assert.ok(!nodes(tree).some((n) => n.type === 'Score' && n.props.value === 99))
})

test('fresh Job360 application prevents duplicate drafts even when detail.application is absent', async () => {
  let fresh = false
  const app = harness({ get: (url) => url.startsWith('/job?') ? { job: { id: 'j1' }, job360: { application: fresh ? { id: 'a-existing' } : null, resumeVersions: [{ id: 'v1', label: '版本' }] } } : { jobs: [] } })
  let tree = await openJob(app)
  nodes(tree).find((n) => n.props['aria-label'] === '申请草稿简历版本').props.onChange({ target: { value: 'v1' } })
  fresh = true; tree = app.render()
  await nodes(tree).find((n) => n.type === 'Btn' && text(n) === '保存申请草稿').props.onClick()
  assert.ok(!app.calls.some(([method]) => method === 'POST'))
  assert.deepEqual(app.navigation.at(-1), ['tracker', 'j1'])
})
