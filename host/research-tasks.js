// Managed UI research jobs. Persistent audit uses existing sync_run; in-flight controls remain process local.
import {createHash}from'node:crypto'
import {ResearchBudget}from'./research-budget.js'
import {captureSite}from'./site-capture.js'
import {parseJson}from'./util.js'
import {resultSnapshot}from'./research-result.js'
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function createResearchTasks(deps,{capture=captureSite}={}){
 const {repos,panel}=deps
 const running=new Map(),results=new Map()
 return {
  start(args={}){
   const key=digest([deps.config.dataDir,args.site,args.keyword,args.url,args.city,args.recruitType,args.dryRun!==false,args.limit,args.fillJd,args.fillJdLimit,args.fillBody,args.bodyLimit,args.autoOcr,args.useOpenTab,args.company,args.role,args.timeoutMs])
   const existing=[...running.values()].find(t=>t.key===key)
   if(existing)return {ok:true,id:existing.id,duplicate:true,status:'running'}
   if(args.dryRun!==false && args.force!==true){
     const recent=repos.db.all("SELECT id,meta,finished_at FROM sync_run WHERE kind='research_task' AND status='ok' ORDER BY started_at DESC LIMIT 50")
     const cached=recent.find(row=>{const m=parseJson(row.meta,{});return m.key===key&&m.result&&Date.now()-Date.parse(row.finished_at)<300000})
     if(cached)return {ok:true,id:cached.id,status:'ok',cacheHit:true,note:'复用5分钟内相同条件的持久预览结果，未访问外部站点'}
   }
   const id=repos.monitor.startRun('research_task',args.site??'unknown'),controller=new AbortController()
   const budget=new ResearchBudget({maxVisits:6,timeoutMs:90000,signal:controller.signal})
   const task={id,key,controller,budget,startedAt:new Date().toISOString()};running.set(id,task)
   const persist=()=>repos.db.run('UPDATE sync_run SET meta=? WHERE id=?',[{site:args.site,keyword:args.keyword,key,mode:args.dryRun===false?'import':'preview',budget:budget.summary()},id])
   persist()
   task.promise=Promise.resolve().then(()=>capture(args,{...deps,budget,signal:controller.signal})).then(result=>{
    const cancelled=controller.signal.aborted
    const safe=cancelled?{...result,ok:false,stage:'cancelled',error:'用户已取消；已完成的步骤保留，未继续追加访问'}:result
    results.set(id,safe)
    repos.monitor.finishRun(id,{status:cancelled?'cancelled':safe.ok?'ok':'error',fetched:safe.found??0,inserted:safe.created??safe.saved??0,error:safe.error,meta:{key,site:args.site,keyword:args.keyword,mode:args.dryRun===false?'import':'preview',budget:budget.summary(),...resultSnapshot(safe),resultAvailable:true}})
   }).catch(error=>{const result={ok:false,stage:controller.signal.aborted?'cancelled':'error',error:error.message,budget:budget.summary()};results.set(id,result);repos.monitor.finishRun(id,{status:controller.signal.aborted?'cancelled':'error',error:error.message,meta:{key,site:args.site,keyword:args.keyword,budget:budget.summary(),...resultSnapshot(result),resultAvailable:true}})}).finally(()=>{running.delete(id);panel?.publish({kind:'sources'});if(results.size>30)results.delete(results.keys().next().value)})
   return {ok:true,id,status:'running',budget:{maxVisits:6,maxMs:90000}}
  },
  get(id){const live=running.get(id),record=repos.db.get('SELECT * FROM sync_run WHERE id=? AND kind=?',[id,'research_task']);if(!record)return {ok:false,error:'任务不存在'};const meta=parseJson(record.meta,{}),result=results.get(id)??meta.result??null;return {ok:true,id,status:live?'running':record.status,startedAt:record.started_at,finishedAt:record.finished_at,budget:live?.budget.summary()??meta.budget,result,error:record.error,resultNote:!live&&!result?(meta.resultOmitted??'旧任务没有持久结果；保留审计，不自动重跑'):null}},
   list({limit=20}={}){return {ok:true,items:repos.db.all("SELECT id,target,status,started_at,finished_at,error,meta FROM sync_run WHERE kind='research_task' ORDER BY started_at DESC LIMIT ?",[Math.max(1,Math.min(100,Number(limit)||20))]).map(row=>{const meta=parseJson(row.meta,{});return {id:row.id,site:row.target,status:running.has(row.id)?'running':row.status,keyword:meta.keyword,startedAt:row.started_at,finishedAt:row.finished_at,error:row.error,resultAvailable:results.has(row.id)||Boolean(meta.result)}})}},
  cancel(id){const task=running.get(id);if(!task)return {ok:true,id,cancelled:false,note:'任务已结束或当前进程未运行，不会自动重试'};task.controller.abort();return {ok:true,id,cancelled:true,note:'取消已请求；正在清理本任务资源，已入库部分不会回滚删除'}},
  dispose(){for(const task of running.values())task.controller.abort()},
 }
}
