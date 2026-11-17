import assert from 'node:assert/strict'
import {it} from 'node:test'
import {makeEnv} from './helpers.mjs'
import {syncKnowledgeIndex} from '../host/knowledge-sync.js'
it('indexes old source records idempotently without resetting organization',()=>{const e=makeEnv();try{
 e.repos.jobs.upsertJob({company:'甲公司',title:'产品经理',jobCode:'1',url:'https://www.zhipin.com/job_detail/1.html',requirements:'SQL'}, {official:false,source:{sourceType:'job_board'}})
 e.repos.intel.addForumPost({platform:'nowcoder',title:'产品面经',url:'https://www.nowcoder.com/discuss/123',content:'用户原始经历文字'})
 assert.equal(syncKnowledgeIndex(e.repos).indexed,2)
 const first=e.repos.knowledge.list({kind:'job'}).items[0];assert.equal(first.platform,'boss')
 e.repos.knowledge.update(first.id,{status:'archived'})
 syncKnowledgeIndex(e.repos);assert.equal(e.repos.knowledge.stats().total,2);assert.equal(e.repos.knowledge.get(first.id).status,'archived')
}finally{e.cleanup()}})
