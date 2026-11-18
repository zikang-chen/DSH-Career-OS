// Durable result snapshots exclude session/access credentials. Original content remains in authorized source vault.
const PRIVATE_KEY=/^(?:cookie|authorization|securityId|lid|access_token|refresh_token|xsec_token|token|detailUrl|headers)$/i
export function durableResearchResult(value){
 if(Array.isArray(value))return value.map(durableResearchResult)
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!PRIVATE_KEY.test(k)).map(([k,v])=>[k,durableResearchResult(v)]))
 if(typeof value==='string'&&/^https?:\/\//i.test(value)){try{const u=new URL(value);u.username='';u.password='';for(const k of [...u.searchParams.keys()])if(/token|cookie|security|session|decode__|signature|^lid$/i.test(k))u.searchParams.delete(k);return u.href}catch{return value}}
 return value
}
export function resultSnapshot(value,{maxBytes=1500000}={}){
 const clean=durableResearchResult(value),text=JSON.stringify(clean)
 if(Buffer.byteLength(text)>maxBytes)return {result:null,resultOmitted:'结果超过持久缓存上限；已入库资料仍保留，可减少数量重新预览'}
 return {result:clean,resultOmitted:null}
}
