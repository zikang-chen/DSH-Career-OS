// 站点采集配置与解析器（小红书/BOSS/51job/OfferShow）。全部离线，用合成样本。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SITE_PROFILES, classifyRecruitType, filterByRecruitType, getSiteProfile, loginUrlForConnector, normalizeRecruitType, parse51Jobs, parseBossJobs, parseOffershow, parseOffershowPlans, parseXhsNotes } from '../host/sites.js'

describe('site profiles', () => {
  it('exposes the four sites with login url and search url builder', () => {
    for (const key of ['xhs', 'boss', '51job', 'offershow']) {
      const p = getSiteProfile(key)
      assert.ok(p, `${key} profile missing`)
      assert.ok(p.loginUrl.startsWith('http'))
      assert.ok(p.searchUrl({ keyword: '测试', city: '北京' }).includes('keyword') || p.searchUrl({ keyword: '测试' }).includes('?') || p.searchUrl({ keyword: '测试', city: '101020100' }).includes('query'))
      assert.ok(Array.isArray(p.patterns) && p.patterns.length)
    }
    assert.equal(getSiteProfile('unknown'), null)
  })

  it('accepts only search/notes responses for XHS search results, not homefeed', () => {
    const { prefer, patterns } = SITE_PROFILES.xhs
    assert.match('https://edith.xiaohongshu.com/api/sns/web/v1/search/notes', new RegExp(prefer))
    for (const url of ['https://edith.xiaohongshu.com/api/sns/web/v1/homefeed', 'https://example.test/feed']) {
      assert.doesNotMatch(url, new RegExp(prefer))
      assert.ok(!patterns.some((pattern) => url.includes(pattern)))
    }
  })

  it('labels BOSS/51job recruit-type search as keyword fallback with strict post-filtering', () => {
    for (const site of ['boss', '51job']) {
      const profile = SITE_PROFILES[site]
      for (const [type, suffix] of [['intern', '实习'], ['campus', '校招']]) {
        const plan = profile.searchPlan({ keyword: 'AI 产品', city: '101010100', recruitType: type })
        const url = new URL(plan.url)
        assert.equal(url.searchParams.get(site === 'boss' ? 'query' : 'keyword'), `AI 产品 ${suffix}`)
        assert.equal(plan.searchKeyword, `AI 产品 ${suffix}`)
        assert.equal(plan.keyword, 'AI 产品')
        assert.equal(plan.recruitType, type)
        assert.equal(plan.keywordSearchVerified, true)
        assert.equal(plan.keywordApplied, true)
        assert.equal(plan.nativeRecruitTypeFilter, false)
        assert.equal(plan.requiresStrictRecruitTypeFilter, true)
        assert.match(plan.notes.join(' '), /不是站点原生过滤/)
        assert.equal(profile.searchUrl({ keyword: 'AI 产品', city: '101010100', recruitType: type }), plan.url)
        assert.equal(url.searchParams.has('recruitType'), false)
      }
      assert.equal(profile.searchPlan({ keyword: '产品实习', recruitType: 'intern' }).searchKeyword, '产品实习')
      assert.equal(profile.searchPlan({ keyword: '产品校招', recruitType: 'campus' }).searchKeyword, '产品校招')
      assert.equal(profile.searchPlan({ keyword: '产品', recruitType: 'social' }).searchKeyword, '产品')
    }
    assert.equal(new URL(SITE_PROFILES.boss.searchUrl({ keyword: '产品', city: '101010100' })).searchParams.get('city'), '101010100')
  })

  it('does not claim OfferShow homepage keyword parameters reach its backend', () => {
    for (const [site, profile] of Object.entries(SITE_PROFILES)) {
      assert.equal(typeof profile.keywordSearchVerified, 'boolean')
      const plan = profile.searchPlan({ keyword: '腾讯' })
      assert.equal(plan.keywordSearchVerified, site !== 'offershow')
      assert.equal(plan.keywordApplied, site !== 'offershow')
    }
    const plan = SITE_PROFILES.offershow.searchPlan({ keyword: '腾讯' })
    assert.equal(plan.keywordApplied, false)
    assert.match(plan.notes.join(' '), /本地严格相关性过滤/)
    assert.match(SITE_PROFILES.offershow.note, /不能宣称.*搜索成功/)
    for (const profile of Object.values(SITE_PROFILES)) {
      assert.throws(() => profile.searchPlan({ keyword: 'AI', recruitType: 'all' }), TypeError)
      assert.throws(() => profile.searchUrl({ keyword: 'AI', recruitType: 1 }), TypeError)
    }
  })
})

describe('xiaohongshu notes', () => {
  it('parses note cards inside a list envelope and builds explore url', () => {
    const payload = { data: { items: [
      { id: '66aa', note_card: { display_title: '腾讯 AI 产品面经', desc: '三轮面试', user: { nickname: '小红薯' }, interact_info: { liked_count: '120' } } },
      { id: '66bb', note_card: { display_title: '字节 产品 一面', desc: '问了 RAG' } },
      { foo: 'bar' },
    ] } }
    const notes = parseXhsNotes(payload)
    assert.equal(notes.length, 2)
    assert.equal(notes[0].title, '腾讯 AI 产品面经')
    assert.equal(notes[0].author, '小红薯')
    assert.equal(notes[0].url, 'https://www.xiaohongshu.com/explore/66aa')
    assert.equal(notes[1].title, '字节 产品 一面')
  })

  it('builds native token links from only response-provided xsec_token/xsecToken', () => {
    const notes = parseXhsNotes({ data: { items: [
      { id: 'snake', xsec_token: 'abc+/= secret', xsec_source: 'pc_search', note_card: { display_title: '面经' } },
      { id: 'camel', noteCard: { displayTitle: '二面', xsecToken: 'camel-real-token' } },
      { id: 'plain', note_card: { display_title: '无token', xsec_token: 42 } },
    ] } })
    const snake = new URL(notes[0].url)
    assert.equal(snake.pathname, '/explore/snake')
    assert.equal(snake.searchParams.get('xsec_token'), 'abc+/= secret')
    assert.equal(snake.searchParams.get('xsec_source'), 'pc_search')
    assert.equal(new URL(notes[1].url).searchParams.get('xsec_token'), 'camel-real-token')
    assert.equal(notes[2].url, 'https://www.xiaohongshu.com/explore/plain')
    assert.equal(new URL(notes[2].url).searchParams.has('xsec_token'), false)
  })

  it('does not re-identify inner cards or metadata as a second note', () => {
    const notes = parseXhsNotes({ items: [{
      id: 'search-wrapper', xsecToken: 'real-token',
      note_card: { id: 'actual-note', title: '实际笔记', user: { id: 'user', title: '用户头衔' }, interact_info: { id: 'likes', title: '互动' } },
    }] })
    assert.equal(notes.length, 1)
    assert.equal(notes[0].id, 'actual-note')
    assert.equal(new URL(notes[0].url).searchParams.get('xsec_token'), 'real-token')
  })

  it('normalizes known dates and epoch timestamps without fabricating relative dates', () => {
    const cases = [
      [1700000000, '2023-11-14T22:13:20.000Z'],
      [1700000000000, '2023-11-14T22:13:20.000Z'],
      ['1700000000000', '2023-11-14T22:13:20.000Z'],
      ['2026-11-17T08:30:00+08:00', '2026-11-17T00:30:00.000Z'],
      ['2026-11-17', '2026-11-17'],
      ['2026/1/2', '2026-01-02'],
      ['2026年11月17日', '2026-11-17'],
      ['20261117', '2026-11-17'],
      ['2026-11-17 08:30:00', '2026-11-17'],
      ['2024-02-29', '2024-02-29'],
      ['昨天', null], ['刚刚', null], ['11-17', null], ['2026-02-30', null],
      ['2026-02-29', null], ['2026-11-17T24:00:00Z', null],
      ['2026-11-17 99:30:00', null], [0, null], ['0000000000', null], [null, null],
    ]
    for (const [time, expected] of cases) {
      const [note] = parseXhsNotes({ id: 'note', note_card: { title: '日期测试', time } })
      assert.equal(note.publishedAt, expected, String(time))
    }
    const [fallback] = parseXhsNotes({ id: 'note', publish_time: 1700000000, note_card: { title: '完整时间优先于无效相对时间', time: '昨天' } })
    assert.equal(fallback.publishedAt, '2023-11-14T22:13:20.000Z')
  })
})

describe('boss jobs', () => {
  it('parses jobName/brandName/salaryDesc and builds job_detail url', () => {
    const payload = { zpData: { jobList: [
      { jobName: 'AI 产品经理', brandName: '腾讯', cityName: '北京', salaryDesc: '20-35K·15薪', encryptJobId: 'abc123', jobExperience: '3-5年', jobDegree: '本科' },
      { jobName: '数据分析', brandName: '字节跳动', cityName: '上海', salaryDesc: '18-30K' },
    ] } }
    const jobs = parseBossJobs(payload)
    assert.equal(jobs.length, 2)
    assert.equal(jobs[0].title, 'AI 产品经理')
    assert.equal(jobs[0].company, '腾讯')
    assert.equal(jobs[0].salaryText, '20-35K·15薪')
    assert.equal(jobs[0].url, 'https://www.zhipin.com/job_detail/abc123.html')
    assert.equal(jobs[0].experience, '3-5年')
    assert.equal(jobs[0].degree, '本科')
  })

  it('retains JD fields and explicit enum evidence but never guesses numeric jobType codes', () => {
    const jobs = parseBossJobs({ data: [
      { jobName: '产品助理', companyName: 'A', recruitType: 'campus', jobDescription: '设计产品\n推动上线', jobRequirements: '熟悉 SQL', jobExperience: '经验不限', jobDegree: '本科', publishTime: '2026-11-17 10:30:00' },
      { jobName: '产品助理', companyName: 'B', jobType: 2, jobExperience: 3, jobDegree: 4 },
    ] })
    assert.equal(jobs[0].description, '设计产品\n推动上线')
    assert.equal(jobs[0].requirements, '熟悉 SQL')
    assert.equal(jobs[0].experience, '经验不限')
    assert.equal(jobs[0].degree, '本科')
    assert.equal(jobs[0].publishedAt, '2026-11-17')
    assert.equal(jobs[0].recruitType, 'campus')
    assert.equal(classifyRecruitType(jobs[0]), 'campus')
    assert.equal(jobs[1].recruitType, null)
    assert.equal(jobs[1].recruitTypeText, '2')
    assert.equal(classifyRecruitType(jobs[1]), 'unknown')
  })

  it('keeps native detail access context in memory but out of public URLs and JSON output', () => {
    const [job] = parseBossJobs({ jobName: '产品经理', brandName: 'A', encryptJobId: 'code', securityId: 'real-secret', lid: 'real-list-id', encryptBossId: 'boss-id', sessionId: 'session-secret' })
    assert.equal(job.url, 'https://www.zhipin.com/job_detail/code.html')
    assert.equal(new URL(job.detailUrl).searchParams.get('securityId'), 'real-secret')
    assert.equal(new URL(job.detailUrl).searchParams.get('lid'), 'real-list-id')
    assert.equal(job.securityId, 'real-secret')
    assert.equal(job.lid, 'real-list-id')
    assert.equal(job.encryptBossId, 'boss-id')
    const serialized = JSON.stringify(job)
    for (const value of ['real-secret', 'real-list-id', 'boss-id', 'session-secret', 'detailUrl', 'securityId']) assert.ok(!serialized.includes(value))
    assert.equal(Object.getOwnPropertyDescriptor(job, 'detailUrl').enumerable, false)
    const [supplied] = parseBossJobs({ jobName: '产品经理', brandName: 'B', encryptJobId: 'wrong', jobUrl: '/job_detail/native.html?ka=search&securityId=url-secret&lid=url-list&sessionId=url-session', securityId: 'field-secret' })
    assert.equal(supplied.url, 'https://www.zhipin.com/job_detail/native.html?ka=search')
    assert.equal(new URL(supplied.detailUrl).searchParams.get('securityId'), 'url-secret')
    assert.ok(!JSON.stringify(supplied).includes('url-secret'))
    const [sessions] = parseBossJobs({ jobName: '产品经理', brandName: 'D', jobUrl: 'https://user:password@www.zhipin.com/job_detail/native.html?__zp_stoken__=cookie-secret&accessToken=access-secret&ka=search' })
    assert.equal(sessions.url, 'https://www.zhipin.com/job_detail/native.html?ka=search')
    for (const secret of ['password', 'cookie-secret', 'access-secret']) assert.ok(!JSON.stringify(sessions).includes(secret))
    const [plain] = parseBossJobs({ jobName: '产品经理', brandName: 'C', encryptJobId: 'plain' })
    assert.equal(plain.detailUrl, plain.url)
    assert.equal(new URL(plain.detailUrl).searchParams.size, 0)
  })

  it('does not parse a matched job inner card twice', () => {
    const [job, ...extra] = parseBossJobs({ jobName: '外层岗位', brandName: 'A', card: { jobName: '内层卡片', brandName: 'A' } })
    assert.equal(job.title, '外层岗位')
    assert.equal(extra.length, 0)
  })
})

describe('51job jobs', () => {
  it('parses jobName/companyName/jobAreaString/provideSalaryString', () => {
    const payload = { resultbody: { job: { items: [
      { jobName: '产品经理', companyName: '某科技', jobAreaString: '北京·朝阳区', provideSalaryString: '15-25K', jobId: '123456', jobHref: 'https://jobs.51job.com/123456.html' },
    ] } } }
    const jobs = parse51Jobs(payload)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].company, '某科技')
    assert.equal(jobs[0].location, '北京·朝阳区')
    assert.equal(jobs[0].salaryText, '15-25K')
    assert.equal(jobs[0].url, 'https://jobs.51job.com/123456.html')
  })

  it('preserves JD, public education/experience and known recruit fields without inventing URLs', () => {
    const jobs = parse51Jobs({ items: [
      { jobName: '产品助理', companyName: 'A', jobId: 'no-href', workYearString: '无需经验', degreeString: '硕士', jobDescribe: '职责：数据分析', jobRequirement: '要求：SQL', recruit_type: 'intern', issueDateString: '2026/11/17' },
      { jobName: '产品助理', companyName: 'B', jobId: 'regional', jobHref: 'https://jobs.51job.com/shanghai/123456.html', workYear: 2, degree: 3, recruitType: 1, issueDate: '昨天' },
    ] })
    assert.equal(jobs[0].description, '职责：数据分析')
    assert.equal(jobs[0].requirements, '要求：SQL')
    assert.equal(jobs[0].experience, '无需经验')
    assert.equal(jobs[0].degree, '硕士')
    assert.equal(jobs[0].recruitType, 'intern')
    assert.equal(jobs[0].publishedAt, '2026-11-17')
    assert.equal(jobs[0].url, null)
    assert.equal(jobs[1].url, 'https://jobs.51job.com/shanghai/123456.html')
    assert.equal(jobs[1].experience, '2')
    assert.equal(jobs[1].degree, '3')
    assert.equal(jobs[1].recruitType, null)
    assert.equal(jobs[1].publishedAt, null)
    assert.equal(classifyRecruitType(jobs[1]), 'unknown')
  })

  it('never promotes unknown type codes or undocumented fields into recruitment evidence', () => {
    const [job] = parse51Jobs({ jobName: '产品经理', companyName: 'A', workYear: 3, degree: 4, type: 'campus', jobType: 1 })
    assert.equal(job.recruitType, null)
    assert.equal(classifyRecruitType(job), 'unknown')
    assert.equal(parse51Jobs({ jobName: '产品', companyName: 'A', jobId: 1, jobHref: 'javascript:alert(1)' })[0].url, null)
  })
})

describe('offershow salaries', () => {
  it('parses company + position + salary reports', () => {
    const payload = { data: { list: [
      { company: '腾讯', position: 'AI产品经理', salary: '25k*16', city: '深圳', degree: '硕士', year: '2026' },
      { companyName: '字节跳动', positionName: '产品经理', monthSalary: '22k', city: '北京' },
      { company: '只有公司没有薪资' },
    ] } }
    const reports = parseOffershow(payload)
    assert.equal(reports.length, 2)
    assert.equal(reports[0].company, '腾讯')
    assert.equal(reports[0].salary, '25k*16')
    assert.equal(reports[1].company, '字节跳动')
  })
})

describe('offershow recruit plans', () => {
  it('parses recruit plans (company + title + dates + notice url)', () => {
    const payload = { code: 200001, data: { plans: [
      { company_name: '腾讯', recruit_title: '腾讯2027届校园招聘', recruit_city: '北京 | 上海', recruit_year: '2027届', start_time: '20261113', end_time: '20270513', notice_url: 'https://mp.weixin.qq.com/s/abc' },
      { company_name: '字节跳动', recruit_title: '字节 2027 提前批', recruit_city: '北京', start_time: '20260701' },
    ] } }
    const plans = parseOffershowPlans(payload)
    assert.equal(plans.length, 2)
    assert.equal(plans[0].company, '腾讯')
    assert.equal(plans[0].title, '腾讯2027届校园招聘')
    assert.equal(plans[0].startsAt, '2026-11-13')
    assert.equal(plans[0].endsAt, '2027-05-13')
    assert.equal(plans[0].url, 'https://mp.weixin.qq.com/s/abc')
  })

  it('offershow profile is a plan kind and its parse prefers plans', () => {
    assert.equal(getSiteProfile('offershow').kind, 'plan')
    const plans = getSiteProfile('offershow').parse({ data: { plans: [{ company_name: 'X', recruit_title: 'Y', start_time: '20270101' }] } })
    assert.equal(plans.length, 1)
  })

  it('rejects impossible plan dates instead of inventing a valid timeline date', () => {
    const [plan] = parseOffershowPlans({ company_name: 'A', recruit_title: '计划', start_time: '20260230', end_time: '昨天' })
    assert.equal(plan.startsAt, null)
    assert.equal(plan.endsAt, null)
    assert.equal(plan.publishedAt, null)
  })
})

describe('login entry mapping', () => {
  it('maps connectors to a login url', () => {
    assert.match(loginUrlForConnector('job_board'), /zhipin\.com/)
    assert.match(loginUrlForConnector('social_platform'), /xiaohongshu\.com/)
    assert.match(loginUrlForConnector('51job'), /51job\.com/)
    assert.match(loginUrlForConnector('offershow'), /offershow\.cn/)
    assert.equal(loginUrlForConnector('manual'), null)
  })
})

describe('recruit type classification', () => {
  it('uses explicit canonical markers, clear titles and numeric-year experience only', () => {
    for (const type of ['campus', 'social', 'intern']) assert.equal(classifyRecruitType({ title: '产品助理', recruitType: type }), type)
    for (const title of ['2027届校园招聘-产品经理', '秋招产品经理', '产品校招', '2027 届研发', 'New Grad Engineer']) assert.equal(classifyRecruitType({ title }), 'campus', title)
    for (const title of ['社会招聘-产品经理', '产品经理（社招）']) assert.equal(classifyRecruitType({ title }), 'social', title)
    for (const experience of ['3年及以上', '1-3年', '3–5年', '2年以上', '2+ years', '3-5 years', '工作经验1.5年']) assert.equal(classifyRecruitType({ title: '产品经理', experience }), 'social', experience)
  })

  it('gives internship precedence over campus/social evidence', () => {
    for (const item of [
      { title: '2027届校园招聘-实习生', recruitType: 'campus' },
      { title: '产品实习生', recruitType: 'social', experience: '3年' },
      { title: '校园招聘-产品', recruitType: 'intern' },
      { title: 'AI Product Intern' },
      { title: 'Data internship' },
    ]) assert.equal(classifyRecruitType(item), 'intern')
  })

  it('does not call missing evidence, education, training roles or fresh-grad-eligible jobs social/campus', () => {
    const unknowns = [
      {}, null, { title: '高级产品经理' }, { title: '管培生' }, { title: '管理培训生' },
      { title: '产品经理（应届可投）' }, { title: '产品经理（接受应届）' },
      { title: 'International Product Manager' }, { title: 'Internal Tools Engineer' },
      { title: '产品', experience: '经验不限', degree: '本科' },
      { title: '产品', degree: '硕士应届毕业生' },
      { title: '产品', experience: '无需工作经验' },
      { title: '产品', experience: '3年优先，应届可投' },
      { title: '产品', experience: '0-1年' }, { title: '产品', experience: '0年' },
      { title: '产品', experience: 'No experience required' },
      { title: '产品', recruitType: 1, experience: '3', degree: '4' },
      { title: '产品', recruitType: '1', recruitTypeText: '管培' },
    ]
    for (const item of unknowns) assert.equal(classifyRecruitType(item), 'unknown', JSON.stringify(item))
  })

  it('strictly filters and leaves unknown out of social results', () => {
    const items = [{ title: '实习产品助理' }, { title: '2027届校招' }, { title: '产品经理', experience: '3年' }, { title: '高级产品经理', experience: '经验不限' }]
    assert.deepEqual(filterByRecruitType(items, 'intern'), [items[0]])
    assert.deepEqual(filterByRecruitType(items, 'campus'), [items[1]])
    assert.deepEqual(filterByRecruitType(items, 'social'), [items[2]])
    for (const absent of [null, undefined, '']) assert.equal(filterByRecruitType(items, absent), items)
  })

  it('validates enums rather than silently accepting invalid or coerced types', () => {
    for (const valid of ['campus', 'social', 'intern']) assert.equal(normalizeRecruitType(valid), valid)
    for (const absent of [null, undefined, '']) assert.equal(normalizeRecruitType(absent), null)
    for (const invalid of ['all', 'unknown', 'daily', 'summer', 'CAMPUS', '社招', ' social ', ' ', 1, 0, false, [], {}, ['intern']]) {
      assert.throws(() => normalizeRecruitType(invalid), TypeError)
      assert.throws(() => filterByRecruitType([], invalid), TypeError)
    }
  })
})

describe('parsers never throw on junk', () => {
  it('returns empty arrays for non-matching payloads', () => {
    for (const fn of [parseXhsNotes, parseBossJobs, parse51Jobs, parseOffershow]) {
      assert.deepEqual(fn(null), [])
      assert.deepEqual(fn({ a: 1, b: [1, 2, 3] }), [])
    }
  })
})
