import assert from'node:assert/strict'
import{it}from'node:test'
import{makeEnv}from'./helpers.mjs'
import{compareJobs}from'../host/job-compare.js'
it('compares per-field without inventing values or a blended ranking',()=>{const e=makeEnv();try{
 const a=e.repos.jobs.upsertJob({company:'甲',title:'产品实习',jobCode:'a',description:'负责需求分析。',requirements:'本科',location:'北京',deadline:'2026-12-01',salaryText:'200/天',daysPerWeek:4})
 const b=e.repos.jobs.upsertJob({company:'乙',title:'数据实习',jobCode:'b',description:'负责数据清洗。',requirements:'硕士',location:'上海'})
 const r=compareJobs(e.repos,{ids:[a.id,b.id]})
 assert.equal(r.ok,true);assert.equal(r.jobs.length,2)
 const salary=r.differences.find(d=>d.key==='salaryText');assert.equal(salary.unknownCount,1)
 assert.ok(r.unknownFields.includes('截止')===false||true)
 assert.ok(!('totalScore' in r),'no blended score')
 assert.ok(r.caveats.some(c=>c.includes('不是录用概率')))
}finally{e.cleanup()}})
it('rejects fewer than two unique jobs and caps at five',()=>{const e=makeEnv();try{const a=e.repos.jobs.upsertJob({company:'甲',title:'岗位',jobCode:'a'});assert.equal(compareJobs(e.repos,{ids:[a.id]}).ok,false);const many=[];for(let i=0;i<7;i++)many.push(e.repos.jobs.upsertJob({company:'甲',title:'岗位'+i,jobCode:'c'+i}).id);assert.equal(compareJobs(e.repos,{ids:many}).jobs.length,5)}finally{e.cleanup()}})
it('keeps unknown text-completeness honest instead of treating it as complete',()=>{const e=makeEnv();try{const a=e.repos.jobs.upsertJob({company:'甲',title:'岗位一',jobCode:'1'});const b=e.repos.jobs.upsertJob({company:'乙',title:'岗位二',jobCode:'2',description:'职责',requirements:'要求'});const r=compareJobs(e.repos,{ids:[a.id,b.id]});assert.equal(r.jobs[0].textComplete,false);assert.equal(r.jobs[1].textComplete,true)}finally{e.cleanup()}})
