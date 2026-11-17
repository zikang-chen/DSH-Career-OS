// 只读页面可见输入/按钮与公开链接，校准站点真实搜索UI；不读取Cookie或账户资料。
import {ensureBrowser,CdpConnection} from '../host/browser.js'
const site=process.argv[2]??'51job'
const url=site==='51job'?'https://we.51job.com/pc/search?keyword=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&searchType=2':'https://www.offershow.cn/'
const b=await ensureBrowser({dataDir:'D:/career_os/data'})
const v=await fetch(`http://127.0.0.1:${b.port}/json/version`).then(r=>r.json())
const c=await new CdpConnection(v.webSocketDebuggerUrl).connect()
let targetId
try{
 ;({targetId}=await c.send('Target.createTarget',{url:'about:blank'}))
 const {sessionId}=await c.send('Target.attachToTarget',{targetId,flatten:true})
 await c.send('Page.enable',{},sessionId)
 await c.send('Page.navigate',{url},sessionId)
 await new Promise(r=>setTimeout(r,6000))
 const expr=`JSON.stringify({title:document.title,inputs:Array.from(document.querySelectorAll('input')).filter(n=>!['password','tel'].includes(n.type)).map(n=>({type:n.type,placeholder:n.placeholder,className:n.className,id:n.id,value:n.type==='text'?n.value:undefined})),buttons:Array.from(document.querySelectorAll('button,[role=button]')).map(n=>({text:n.innerText,classes:n.className})).filter(n=>n.text).slice(0,40),anchors:Array.from(document.querySelectorAll('a[href]')).filter(n=>/薪|搜索|校招|社区|实习/.test(n.innerText)).slice(0,25).map(n=>({text:n.innerText,url:n.href})),text:document.body.innerText.slice(0,1500)})`
 const out=await c.send('Runtime.evaluate',{expression:expr,returnByValue:true},sessionId)
 console.log(site,out.result?.value)
}finally{if(targetId)await c.send('Target.closeTarget',{targetId}).catch(()=>{});c.close()}
