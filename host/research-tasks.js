// Managed UI research jobs. Persistent audit uses existing sync_run; in-flight controls remain process local.
import {createHash}from'node:crypto'
import {ResearchBudget}from'./research-budget.js'
import {captureSite}from'./site-capture.js'
const running=new Map(),results=new Map()
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function createResearchTasks(deps,{capture=captureSite}={}){
 const {repos,panel}=deps
 return {
  start(args={}){
   const key=digest([deps.config.dataDir,args.site,args.keyword,args.city,args.recruitType,args.dryRun!==false,args.limit,args.fillJdLimit,args.bodyLimit,args.autoOcr])
   const existing=[...running.values()].find(t=>t.key===key)
   if(existing)return {ok:true,id:existing.id,duplicate:true,status:'running'}
   const id=repos.monitor.startRun('research_task',args.site??'unknown'),controller=new AbortController()
   const budget=new ResearchBudget({maxVisits:6,timeoutMs:90000,signal:controller.signal})
   const task={id,key,controller,budget,startedAt:new Date().toISOString()};running.set(id,task)
   const persist=()=>repos.db.run('UPDATE sync_run SET meta=? WHERE id=?',[{site:args.site,keyword:args.keyword,mode:args.dryRun===false?'import':'preview',budget:budget.summary()},id])
   persist()
   task.promise=Promise.resolve().then(()=>capture(args,{...deps,budget,signal:controller.signal})).then(result=>{
    const cancelled=controller.signal.aborted
    const safe=cancelled?{...result,ok:false,stage:'cancelled',error:'用户已取消；已完成的步骤保留，未继续追加访问'}:result
    results.set(id,safe)
    repos.monitor.finishRun(id,{status:cancelled?'cancelled':safe.ok?'ok':'error',fetched:safe.found??0,inserted:safe.created??safe.saved??0,error:safe.error,meta:{site:args.site,keyword:args.keyword,budget:budget.summary(),resultAvailable:true}})
   }).catch(error=>{const result={ok:false,stage:controller.signal.aborted?'cancelled':'error',error:error.message,budget:budget.summary()};results.set(id,result);repos.monitor.finishRun(id,{status:controller.signal.aborted?'cancelled':'error',error:error.message,meta:{budget:budget.summary(),resultAvailable:true}})}).finally(()=>{running.delete(id);panel?.publish({kind:'sources'});if(results.size>30)results.delete(results.keys().next().value)})
   return {ok:true,id,status:'running',budget:{maxVisits:6,maxMs:90000}}
  },
  get(id){const live=running.get(id),record=repos.db.get('SELECT * FROM sync_run WHERE id=? AND kind=?',[id,'research_task']);if(!record)return {ok:false,error:'任务不存在'};return {ok:true,id,status:live?'running':record.status,startedAt:record.started_at,finishedAt:record.finished_at,budget:live?.budget.summary(),result:results.get(id)??null,error:record.error,resultNote:!live&&!results.has(id)?'进程重启后结果不在内存；运行审计保留，可按需要重新预览，不自动重跑':null}},
  cancel(id){const task=running.get(id);if(!task)return {ok:true,id,cancelled:false,note:'任务已结束或当前进程未运行，不会自动重试'};task.controller.abort();return {ok:true,id,cancelled:true,note:'取消已请求；正在清理本任务资源，已入库部分不会回滚删除'}},
  dispose(){for(const task of running.values())task.controller.abort()},
 }
}
