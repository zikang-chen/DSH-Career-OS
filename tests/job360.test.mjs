import assert from'node:assert/strict'
import{it}from'node:test'
import{makeEnv}from'./helpers.mjs'
import{buildJob360,assessJobDisplay}from'../host/job360.js'
it('composes job company related evidence resume choices and application without modifying facts',()=>{const e=makeEnv();try{
 const x=e.repos.jobs.upsertJob({company:'甲公司',title:'产品实习',jobCode:'a',description:'协助收集用户需求，分析产品数据并撰写文档。',requirements:'2027届本科，每周4天',url:'https://example.com/a'})
 e.repos.knowledge.upsert({kind:'interview',title:'某部门面经',company:'甲公司',platform:'manual',url:'https://example.com/post',body:'经验自述，不同年份部门不一定相同',completeness:'partial'})
 const before=e.repos.jobs.getJob(x.id);const v=buildJob360(e.repos,x.id)
 assert.equal(v.job.id,x.id);assert.equal(v.job360.company.name,'甲公司');assert.equal(v.job360.company.business,null);assert.equal(v.relatedKnowledge.length,1);assert.ok(Array.isArray(v.job360.resumeVersions));assert.ok(v.assessment.eligibility);assert.equal(e.repos.jobs.getJob(x.id).status,before.status)
 const app=e.repos.applications.create({jobId:x.id,status:'saved'});assert.equal(buildJob360(e.repos,x.id).job360.application.id,app.id)
}finally{e.cleanup()}})
it('displays historical open without excerpt as pending not freshly verified',()=>{const e=makeEnv();try{const x=e.repos.jobs.upsertJob({company:'甲',title:'岗位'});e.db.run("UPDATE job SET status='OPEN',status_verified_at=? WHERE id=?",[new Date().toISOString(),x.id]);const r=assessJobDisplay(e.repos.jobs.getJob(x.id),{});assert.equal(r.statusDisplay,'可能开放·待核验');assert.equal(r.statusEvidenceLevel,'unverified');assert.equal(r.matchReliable,false)}finally{e.cleanup()}})
