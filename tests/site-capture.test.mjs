import assert from 'node:assert/strict'
import {describe,it} from 'node:test'
import {captureSite,fetchXhsNoteBody,isSubstantiveNoteText,sourceHealthRows} from '../host/site-capture.js'
import {makeEnv} from './helpers.mjs'
import {CONNECTOR_META} from '../host/sources.js'
const sample={jobName:'数据分析实习生',companyName:'示例科技',jobAreaString:'上海',jobId:'job-1',jobHref:'https://jobs.51job.com/shanghai/job-1.html'}
function deps(env,payload){
  for(const m of CONNECTOR_META)env.repos.monitor.upsertSource(m)
  return {config:{dataDir:env.dir},repos:env.repos,logger:env.logger,panel:{publish(){}},
    captureJson:async args=>({ok:true,captured:{url:'https://we.51job.com/api/job/search-pc',json:payload},page:{url:args.url,title:'搜索'}}),
    fetchDetail:async()=>({ok:true,description:'负责分析真实业务数据并设计可复用的指标体系，支持产品团队定位用户体验的问题，协同推进方案验证。',requirements:'在校本科或硕士，掌握SQL。'}),
  }
}
describe('shared site capture use case',()=>{
  it('previews full JD without inserting jobs, but records a successful fetch',async()=>{
    const e=makeEnv();try{
      const d=deps(e,{items:[sample]})
      const r=await captureSite({site:'51job',keyword:'数据分析',recruitType:'intern',fillJd:true},d)
      assert.equal(r.ok,true);assert.equal(r.jdFilled,1);assert.ok(r.preview[0].description.length>40)
      assert.equal(e.repos.jobs.stats().total,0)
      assert.equal(e.repos.monitor.listSources().find(s=>s.connector==='job_board').fetch_count,1)
    }finally{e.cleanup()}
  })
  it('persists JD and requested type, keeps third party UNVERIFIED, repeated import dedupes',async()=>{
    const e=makeEnv();try{
      const d=deps(e,{items:[sample]});const a={site:'51job',keyword:'数据分析',recruitType:'intern',dryRun:false}
      const one=await captureSite(a,d),two=await captureSite(a,d)
      assert.equal(one.created,1);assert.equal(two.created,0);assert.equal(two.merged,1)
      const j=e.repos.jobs.getJob(one.jobIds[0]);assert.equal(j.recruit_type,'intern');assert.equal(j.status,'UNVERIFIED');assert.ok(j.description.length>40)
      assert.equal(e.repos.jobs.stats().total,1)
    }finally{e.cleanup()}
  })
  it('rejects invalid type before any network call or write',async()=>{
    const e=makeEnv();try{
      const d=deps(e,{items:[sample]});let called=0;d.captureJson=async()=>{called++;throw new Error('should not call')}
      const r=await captureSite({site:'51job',keyword:'data',recruitType:'anything'},d)
      assert.equal(r.stage,'validation');assert.equal(called,0);assert.equal(e.repos.jobs.stats().total,0)
    }finally{e.cleanup()}
  })
  it('never counts unknown recruitment as social',async()=>{
    const e=makeEnv();try{
      const d=deps(e,{items:[{...sample,jobName:'产品经理'}]})
      const r=await captureSite({site:'51job',keyword:'产品',recruitType:'social'},d)
      assert.equal(r.classified.unknown,1);assert.equal(r.matched,0);assert.equal(r.stage,'no_match')
    }finally{e.cleanup()}
  })
  it('reports JD failures separately rather than saving a login wall as JD',async()=>{
    const e=makeEnv();try{
      const d=deps(e,{items:[sample]});d.fetchDetail=async()=>({ok:false,error:'需要登录'})
      const r=await captureSite({site:'51job',keyword:'数据分析',dryRun:false},d)
      assert.equal(r.jdFilled,0);assert.equal(r.jdFailures.length,1)
      assert.equal(e.repos.jobs.getJob(r.jobIds[0]).description,null)
    }finally{e.cleanup()}
  })
  it('propagates auth errors and updates health without inserting anything',async()=>{
    const e=makeEnv();try{
      const d=deps(e,{});d.captureJson=async()=>({ok:false,stage:'login_required',error:'登录已失效'})
      const r=await captureSite({site:'boss',keyword:'产品'},d)
      assert.equal(r.ok,false);assert.equal(r.stage,'login_required');assert.equal(e.repos.jobs.stats().total,0)
      const health=e.repos.monitor.listSources().find(s=>s.connector==='job_board');assert.equal(health.last_ok_at,null);assert.match(health.last_error,/登录/)
    }finally{e.cleanup()}
  })
  it('groups each supported platform under one source card, with separate login entries',()=>{
    const e=makeEnv();try{
      deps(e,{})
      const rows=sourceHealthRows(e.repos)
      assert.equal(rows.length,6);assert.equal(new Set(rows.map(s=>s.connector)).size,6)
      assert.deepEqual(rows.find(s=>s.connector==='job_board').sites.map(s=>s.key),['boss','51job'])
      assert.equal(rows.find(s=>s.connector==='manual').sites.length,0)
    }finally{e.cleanup()}
  })
  it('does not count tag-only image posts as retrieved interview text',async()=>{
    assert.equal(isSubstantiveNoteText('#AI产品经理 #面试 #腾讯 #大厂'),false)
    const r=await fetchXhsNoteBody({id:'n',url:'https://www.xiaohongshu.com/explore/n'}, {
      captureJson:async()=>({ok:false}),captureText:async()=>({ok:true,sections:[{selector:'#detail-desc',text:'#AI产品经理 #面试 #腾讯 #大厂'}]})})
    assert.equal(r.ok,false);assert.match(r.error,/标签|图片/)
  })
  it('reads a matching note detail, never substitutes another note body',async()=>{
    const desc='这是一条真实面试经历：面试官请我解释产品的需求验证方法，并针对业务案例讨论指标选择、用户分层及实验结果的可解释性。'
    const r=await fetchXhsNoteBody({id:'n',url:'https://www.xiaohongshu.com/explore/n'}, {
      captureJson:async()=>({ok:true,captured:{json:{items:[{id:'n',note_card:{title:'面经',desc}}]}}}),captureText:async()=>{throw new Error('must not need DOM fallback')}
    })
    assert.equal(r.ok,true);assert.equal(r.desc,desc)
  })
  it('does not return unrelated OfferShow homepage rows as keyword matches',async()=>{
    const e=makeEnv();try{
      const d=deps(e,{data:{plans:[{company_name:'其他公司',recruit_title:'2027届校园招聘',start_time:'20261113'}]}})
      const r=await captureSite({site:'offershow',keyword:'腾讯'},d)
      assert.equal(r.ok,false);assert.equal(r.stage,'no_match');assert.equal(r.matched,0)
      assert.equal(r.search.keywordSearchVerified,false);assert.equal(e.repos.intel.listEvents().length,0)
    }finally{e.cleanup()}
  })
})
