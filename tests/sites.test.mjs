// 站点采集配置与解析器（小红书/BOSS/51job/OfferShow）。全部离线，用合成样本。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SITE_PROFILES, getSiteProfile, parse51Jobs, parseBossJobs, parseOffershow, parseXhsNotes } from '../host/sites.js'

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

describe('parsers never throw on junk', () => {
  it('returns empty arrays for non-matching payloads', () => {
    for (const fn of [parseXhsNotes, parseBossJobs, parse51Jobs, parseOffershow]) {
      assert.deepEqual(fn(null), [])
      assert.deepEqual(fn({ a: 1, b: [1, 2, 3] }), [])
    }
  })
})
