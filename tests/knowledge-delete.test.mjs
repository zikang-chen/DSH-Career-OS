import assert from'node:assert/strict'
import{it}from'node:test'
import{makeEnv}from'./helpers.mjs'
it('deletes one knowledge entry with its revisions but keeps the source job',()=>{const e=makeEnv();try{
 const job=e.repos.jobs.upsertJob({company:'甲公司',title:'产品实习',jobCode:'k1'})
 const k=e.repos.knowledge.upsert({kind:'job',title:'产品实习',company:'甲公司',platform:'boss',url:'https://a.example.com/j/1',body:'职责',completeness:'full',evidenceLevel:'C',sourceEntityType:'job',sourceEntityId:job.id})
 e.repos.knowledge.updateMedia(k.id,[{url:'https://cdn.example.com/a.png',ocrStatus:'pending'}])
 const r=e.repos.knowledge.remove(k.id,{reason:'用户要求清理'})
 assert.equal(r.ok,true)
 assert.equal(e.repos.knowledge.get(k.id),null)
 assert.equal(Number(e.db.scalar('SELECT count(*) FROM knowledge_revision WHERE knowledge_id=?',[k.id])),0)
 assert.ok(e.repos.jobs.getJob(job.id),'source job must survive')
 const audit=e.db.get("SELECT * FROM sync_run WHERE kind='knowledge_delete' ORDER BY started_at DESC LIMIT 1")
 assert.ok(audit,'deletion must be audited')
 assert.equal(audit.target,'产品实习')
}finally{e.cleanup()}})
it('reports missing ids instead of pretending a batch delete succeeded',()=>{const e=makeEnv();try{
 const a=e.repos.knowledge.upsert({kind:'interview',title:'面经A',platform:'xhs',body:'正文',completeness:'full',evidenceLevel:'C'})
 const r=e.repos.knowledge.removeMany([a.id,'missing-id'])
 assert.equal(r.removed.length,1);assert.deepEqual(r.missing,['missing-id'])
 assert.match(r.note,/1 条不存在/)
}finally{e.cleanup()}})
it('refuses to delete an unknown entry and leaves counts intact',()=>{const e=makeEnv();try{
 const before=Number(e.db.scalar('SELECT count(*) FROM knowledge'))
 const r=e.repos.knowledge.remove('nope')
 assert.equal(r.ok,false);assert.match(r.error,/不存在/)
 assert.equal(Number(e.db.scalar('SELECT count(*) FROM knowledge')),before)
}finally{e.cleanup()}})
