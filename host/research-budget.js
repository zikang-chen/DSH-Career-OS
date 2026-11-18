// Bounded, cooperative research scope. No hidden retries; same read-only requests share work.
export class ResearchBudget {
  constructor({maxVisits=6,timeoutMs=90000,signal,onProgress}={}){
    if(!Number.isInteger(maxVisits)||maxVisits<1||maxVisits>20)throw new Error('maxVisits must be 1–20')
    this.maxVisits=maxVisits;this.startedAt=Date.now();this.deadline=this.startedAt+Math.min(Math.max(timeoutMs,1000),180000);this.signal=signal;this.visits=0;this.steps=[];this.onProgress=onProgress
  }
  check(){if(this.signal?.aborted)throw new Error('研究已取消');if(Date.now()>=this.deadline)throw new Error('研究已达到时间预算，停止新增访问并保留已有结果')}
  async visit(label,operation){this.check();if(this.visits>=this.maxVisits)throw new Error('研究已达到访问预算，停止继续搜索');this.visits++;const step={label,status:'running',at:new Date().toISOString()};this.steps.push(step);this.notify();try{const result=await operation({timeoutMs:Math.max(1000,this.deadline-Date.now()),signal:this.signal});step.status=result?.ok===false?'partial':'ok';this.notify();return result}catch(e){step.status='error';step.error=e.message;this.notify();throw e}}
  notify(){try{this.onProgress?.(this.summary())}catch{/* audit failures must not launch retries or corrupt capture */}}
  summary(){return {visits:this.visits,maxVisits:this.maxVisits,elapsedMs:Date.now()-this.startedAt,remainingMs:Math.max(0,this.deadline-Date.now()),steps:this.steps}}
}
const inFlight=new Map(),cache=new Map()
export async function boundedResearch(key,operation,{ttlMs=300000,force=false}={}){
 const now=Date.now(),entry=cache.get(key)
 if(!force&&entry&&now-entry.at<ttlMs)return {...structuredClone(entry.value),cache:{hit:true,at:entry.at}}
 if(inFlight.has(key))return inFlight.get(key)
 const promise=Promise.resolve().then(operation).then(value=>{if(value?.ok!==false)cache.set(key,{at:Date.now(),value:structuredClone(value)});return value}).finally(()=>inFlight.delete(key))
 inFlight.set(key,promise)
 if(cache.size>50)cache.delete(cache.keys().next().value)
 return promise
}
