import assert from 'node:assert/strict'
import {describe,it} from 'node:test'
import {makeEnv,sampleProfile} from './helpers.mjs'
import {analyzeMatch} from '../host/domain.js'

describe('job truth and identity across the career pipeline',()=>{
  it('preserves original JD requirements and exposes hiring rules under a distinct field',()=>{
    const e=makeEnv();try{
      const x=e.repos.jobs.upsertJob({company:'示例公司',title:'工程师',requirements:'掌握Python；硕士及以上'})
      const j=e.repos.jobs.getJob(x.id)
      assert.equal(j.requirements,'掌握Python；硕士及以上');assert.ok(Array.isArray(j.hiringRequirements))
    }finally{e.cleanup()}
  })
  it('does not promote a missing JD when reading the detail projection',()=>{
    const e=makeEnv();try{
      const x=e.repos.jobs.upsertJob({company:'示例公司',title:'岗位'})
      const j=e.repos.jobs.getJob(x.id),raw=e.db.get('SELECT * FROM job WHERE id = ?',[x.id])
      const p=sampleProfile();const listed=e.repos.jobs.listJobs({}).find(it=>it.id===x.id);assert.equal(analyzeMatch(p,j).band,analyzeMatch(p,listed).band)
      assert.equal(analyzeMatch(p,j).band,'insufficient_info')
    }finally{e.cleanup()}
  })
  it('keeps distinct code IDs apart even with identical company/title/location',()=>{
    const e=makeEnv();try{
      const a=e.repos.jobs.upsertJob({company:'示例公司',title:'产品经理',location:'北京',jobCode:'A'})
      const b=e.repos.jobs.upsertJob({company:'示例公司',title:'产品经理',location:'北京',jobCode:'B'})
      assert.notEqual(a.id,b.id);assert.equal(e.repos.jobs.stats().total,2)
    }finally{e.cleanup()}
  })
  it('never uses a shared listing URL as identity for different jobs/companies',()=>{
    const e=makeEnv();try{
      const rows=[['甲公司','产品经理','北京'],['甲公司','Java工程师','上海'],['乙公司','产品经理','北京']]
      const ids=rows.map(([company,title,location])=>e.repos.jobs.upsertJob({company,title,location,url:'https://example.com/list'}).id)
      assert.equal(new Set(ids).size,3);assert.equal(e.repos.jobs.getJob(ids[0]).location,'北京')
      assert.equal(e.repos.jobs.upsertJob({company:'甲公司',title:'产品经理',location:'北京',url:'https://example.com/list'}).id,ids[0])
    }finally{e.cleanup()}
  })
  it('lets third party fill missing fields, never overwrite official JD while leaving OPEN',()=>{
    const e=makeEnv();try{
      const x=e.repos.jobs.upsertJob({company:'示例公司',title:'产品经理',jobCode:'A',description:'官方职责',requirements:'官方要求',applyUrl:'https://official.test/job',recruitType:'campus',status:'OPEN'},
        {official:true,source:{sourceType:'official_careers'}})
      e.repos.jobs.upsertJob({company:'示例公司',title:'产品经理',jobCode:'A',description:'第三方旧职责',requirements:'第三方要求',url:'https://third.test/job',applyUrl:'https://third.test/job',location:'上海',recruitType:'intern'},
        {official:false,source:{sourceType:'job_board'}})
      const j=e.repos.jobs.getJob(x.id)
      assert.equal(j.description,'官方职责');assert.equal(j.requirements,'官方要求');assert.equal(j.apply_url,'https://official.test/job');assert.equal(j.recruit_type,'campus');assert.equal(j.status,'OPEN');assert.equal(j.location,'上海')
      assert.ok(j.sources.some(s=>s.source_type==='job_board'))
    }finally{e.cleanup()}
  })
})
