import assert from'node:assert/strict'
import fs from'node:fs'
import path from'node:path'
import{it}from'node:test'
import{makeEnv}from'./helpers.mjs'
import{deleteKnowledgeCascade,mediaFilesOf}from'../host/knowledge-delete.js'
it('can delete the linked job together with the entry',()=>{const e=makeEnv();try{
 const job=e.repos.jobs.upsertJob({company:'甲',title:'产品实习',jobCode:'j1'})
 const k=e.repos.knowledge.upsert({kind:'job',title:'产品实习',company:'甲',platform:'boss',body:'职责',completeness:'full',evidenceLevel:'C',sourceEntityType:'job',sourceEntityId:job.id})
 const r=deleteKnowledgeCascade({repos:e.repos,config:{dataDir:e.dir}},{id:k.id,deleteSource:true,reason:'清理'})
 assert.equal(r.ok,true);assert.equal(r.source.deleted,true)
 assert.equal(e.repos.jobs.getJob(job.id),null,'linked job should be gone')
 assert.equal(e.repos.knowledge.get(k.id),null)
}finally{e.cleanup()}})
it('can delete the forum post and its claims together with the entry',()=>{const e=makeEnv();try{
 const post=e.repos.intel.addForumPost({platform:'xiaohongshu',content:'面经正文内容足够长',url:'https://x.example.com/1',title:'面经'})
 e.repos.intel.addClaim?.({postId:post.id,category:'interview',claim:'常考SQL',evidenceLevel:'C'})
 const k=e.repos.knowledge.upsert({kind:'interview',title:'面经',platform:'xiaohongshu',body:'正文',completeness:'full',evidenceLevel:'C',sourceEntityType:'forum_post',sourceEntityId:post.id})
 const r=deleteKnowledgeCascade({repos:e.repos,config:{dataDir:e.dir}},{id:k.id,deleteSource:true})
 assert.equal(r.source.type,'forum_post')
 assert.equal(Number(e.db.scalar('SELECT count(*) FROM forum_post WHERE id=?',[post.id])),0)
}finally{e.cleanup()}})
it('keeps the source when the user does not ask to delete it',()=>{const e=makeEnv();try{
 const job=e.repos.jobs.upsertJob({company:'甲',title:'实习',jobCode:'j2'})
 const k=e.repos.knowledge.upsert({kind:'job',title:'实习',company:'甲',platform:'boss',body:'x',completeness:'summary',evidenceLevel:'C',sourceEntityType:'job',sourceEntityId:job.id})
 const r=deleteKnowledgeCascade({repos:e.repos,config:{dataDir:e.dir}},{id:k.id})
 assert.equal(r.source.deleted,false)
 assert.ok(e.repos.jobs.getJob(job.id),'job must survive')
}finally{e.cleanup()}})
it('deletes only downloaded files inside the data dir',()=>{const e=makeEnv();try{
 const dir=path.join(e.dir,'knowledge-media');fs.mkdirSync(dir,{recursive:true})
 const inside=path.join(dir,'abc.png');fs.writeFileSync(inside,'x')
 const outside=path.join(e.dir,'..','outside.png');fs.writeFileSync(outside,'x')
 const k=e.repos.knowledge.upsert({kind:'interview',title:'图',platform:'xhs',body:'x',completeness:'full',evidenceLevel:'C',media:[{url:'https://a.example.com/1.png',filePath:inside,sha256:'abc'},{url:'https://a.example.com/2.png',filePath:outside}]})
 const r=deleteKnowledgeCascade({repos:e.repos,config:{dataDir:e.dir}},{id:k.id,deleteMedia:true})
 assert.equal(fs.existsSync(inside),false,'inside data dir should be removed')
 assert.equal(fs.existsSync(outside),true,'outside data dir must be kept')
 assert.equal(r.media.kept.length,1)
 fs.unlinkSync(outside)
}finally{e.cleanup()}})
it('keeps files when deleteMedia is not requested',()=>{const e=makeEnv();try{
 const dir=path.join(e.dir,'knowledge-media');fs.mkdirSync(dir,{recursive:true})
 const file=path.join(dir,'keep.png');fs.writeFileSync(file,'x')
 const k=e.repos.knowledge.upsert({kind:'interview',title:'图',platform:'xhs',body:'x',completeness:'full',evidenceLevel:'C',media:[{url:'https://a.example.com/1.png',filePath:file}]})
 deleteKnowledgeCascade({repos:e.repos,config:{dataDir:e.dir}},{id:k.id})
 assert.equal(fs.existsSync(file),true)
 fs.unlinkSync(file)
}finally{e.cleanup()}})
it('reports media paths outside the data dir instead of touching them',()=>{const r=mediaFilesOf({media:[{filePath:'C:/Windows/system32/x.png'}]},'D:/career_os/data');assert.deepEqual(r.files,[]);assert.equal(r.outside.length,1)})
