// 验证OfferShow页面的公开薪资入口，遇到会员墙停止，不调用未授权接口。
import {ensureBrowser,CdpConnection,watchJsonResponses,publicBrowserUrl} from '../host/browser.js'
const b=await ensureBrowser({dataDir:'D:/career_os/data'})
const v=await fetch(`http://127.0.0.1:${b.port}/json/version`).then(r=>r.json())
const c=await new CdpConnection(v.webSocketDebuggerUrl).connect()
let targetId,w
try{
 ;({targetId}=await c.send('Target.createTarget',{url:'about:blank'}))
 const {sessionId}=await c.send('Target.attachToTarget',{targetId,flatten:true})
 await c.send('Page.enable',{},sessionId);await c.send('Network.enable',{},sessionId)
 w=watchJsonResponses(c,sessionId,{patterns:['api','salary','list','search'],validateJson:()=>true})
 await c.send('Page.navigate',{url:'https://www.offershow.cn/'},sessionId)
 await new Promise(r=>setTimeout(r,5500))
 const click=await c.send('Runtime.evaluate',{expression:`(()=>{const n=Array.from(document.querySelectorAll('button.tab-btn')).find(n=>n.innerText.trim()==='薪资');if(n){n.click();return true}return false})()`,returnByValue:true},sessionId)
 console.log('salary-tab-clicked',click.result?.value)
 await new Promise(r=>setTimeout(r,4500))
 const r=await c.send('Runtime.evaluate',{expression:`JSON.stringify({url:location.href,title:document.title,text:document.body.innerText.slice(0,2800),inputs:Array.from(document.querySelectorAll('input[type=text]')).map(n=>({placeholder:n.placeholder,id:n.id}))})`,returnByValue:true},sessionId)
 console.log(r.result?.value)
 const shape=(j,d=0)=>{if(d>2)return typeof j;if(Array.isArray(j))return {count:j.length,first:shape(j[0],d+1)};if(j&&typeof j==='object')return Object.fromEntries(Object.entries(j).slice(0,30).map(([k,v])=>[k,shape(v,d+1)]));return typeof j}
 for(const n of w.responses.values())if(n.json && /get_top_interest_list/.test(n.url)) console.log(JSON.stringify({url:publicBrowserUrl(n.url),shape:shape(n.json),sample:n.json?.data?.list?.[0]??n.json?.data?.[0]??n.json?.data}))
}finally{w?.dispose();if(targetId)await c.send('Target.closeTarget',{targetId}).catch(()=>{});c.close()}
