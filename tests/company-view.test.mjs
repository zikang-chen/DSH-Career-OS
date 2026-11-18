import assert from'node:assert/strict'
import{it}from'node:test'
import{makeEnv}from'./helpers.mjs'
import{buildCompanyView}from'../host/company-view.js'
it('surfaces a single official origin as an explicit careers candidate without writing it',()=>{const e=makeEnv();try{
 const c=e.repos.jobs.resolveCompany('甲公司')
 e.repos.jobs.upsertJob({company:'甲公司',title:'产品实习',jobCode:'a',url:'https://careers.example.com/job/1'},{official:true,source:{sourceType:'official_careers'}})
 const v=buildCompanyView(e.repos,c.id,{})
 assert.equal(v.diagnosis.careersEntryMissing,true)
 assert.equal(v.diagnosis.candidateCareersUrl,'https://careers.example.com')
 assert.equal(e.repos.jobs.getCompany(c.id).careers_url,null,'diagnosis must not silently write the entry')
 assert.equal(v.jobs[0].statusDisplay,'可能开放·待核验')
}finally{e.cleanup()}})
it('does not invent a candidate when multiple official origins conflict',()=>{const e=makeEnv();try{
 const c=e.repos.jobs.resolveCompany('乙公司')
 e.repos.jobs.upsertJob({company:'乙公司',title:'岗位一',jobCode:'1',url:'https://a.example.com/j/1'},{official:true,source:{sourceType:'official_careers'}})
 e.repos.jobs.upsertJob({company:'乙公司',title:'岗位二',jobCode:'2',url:'https://b.example.com/j/2'},{official:true,source:{sourceType:'official_careers'}})
 const v=buildCompanyView(e.repos,c.id,{})
 assert.equal(v.diagnosis.officialSourceOrigins.length,2)
 assert.equal(v.diagnosis.candidateCareersUrl,null)
}finally{e.cleanup()}})
it('shows an honest empty related-job state',()=>{const e=makeEnv();try{const c=e.repos.jobs.resolveCompany('丙公司');const v=buildCompanyView(e.repos,c.id,{});assert.deepEqual(v.jobs,[]);assert.equal(v.diagnosis.careersEntryMissing,true);assert.equal(v.diagnosis.note,null)}finally{e.cleanup()}})
