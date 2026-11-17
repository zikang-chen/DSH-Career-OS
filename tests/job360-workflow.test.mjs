import assert from'node:assert/strict'
import{it}from'node:test'
import{makeEnv}from'./helpers.mjs'
import{buildJob360}from'../host/job360.js'
it('job360 to selected-resume draft to first submission keeps job and immutable material facts',()=>{const e=makeEnv();try{
 const j=e.repos.jobs.upsertJob({company:'甲公司',title:'产品实习',jobCode:'a',description:'负责整理用户反馈与撰写需求文档。',requirements:'2027届本科，每周4天',url:'https://example.com/job'})
 const r=e.repos.profile.addResume({label:'岗位版',text:'真实经历原文',rawText:'真实经历原文'})
 const before=buildJob360(e.repos,j.id);assert.ok(before.job360.resumeVersions.some(v=>v.id===r.id))
 const a=e.repos.applications.create({jobId:j.id,status:'saved',resumeVersionId:r.id,channel:'官网',nextActionAt:'2026-12-01'})
 const during=buildJob360(e.repos,j.id);assert.equal(during.job360.application.id,a.id)
 const submitted=e.repos.applications.update(a.id,{status:'applied'})
 assert.equal(submitted.submissionSnapshot.resumeVersionId,r.id);assert.equal(submitted.submissionSnapshot.frozen,true)
 e.db.run('UPDATE job SET description=? WHERE id=?',['新职责',j.id])
 assert.equal(e.repos.applications.get(a.id).submittedJd.description,'负责整理用户反馈与撰写需求文档。')
}finally{e.cleanup()}})
