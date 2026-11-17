// OfferShow公开薪资热榜：只保存页面原始口径，不把“78”等数字猜成年薪/万元。
import {capturePageText} from './browser.js'
export function parseSalaryHighlightsFromText(text) {
  const block=/薪资\s*\n招聘\s*\nWLB\s*\n([\s\S]*?)查看更多/.exec(String(text??''))?.[1]
  if(!block)return []
  const lines=block.split('\n').map(s=>s.trim()).filter(Boolean)
  const rows=[]
  for(let i=0;i+2<lines.length;i++) {
    if(!/^\d+$/.test(lines[i]))continue
    const [company,...role]=lines[i+1].split(/\s+-\s+/)
    if(!company||!role.length)continue
    rows.push({rank:Number(lines[i]),company,title:role.join(' - '),salaryText:lines[i+2],publishedAt:null,sourceUrl:'https://www.offershow.cn/',evidenceLevel:'C',kind:'public-hotlist-snippet'})
    i+=2
  }
  return rows
}
export async function fetchOfferShowSalaryHighlights({dataDir,company,captureText=capturePageText}={}) {
  const page=await captureText({dataDir,url:'https://www.offershow.cn/',timeoutMs:12000})
  if(!page.ok)return {ok:false,error:page.error??'首页薪资热榜不可读'}
  const rows=parseSalaryHighlightsFromText(page.text)
  const selected=company?rows.filter(r=>r.company.toLowerCase().includes(String(company).toLowerCase())):rows
  return {ok:rows.length>0,scope:'仅首页公开薪资热榜，不是完整薪资库或指定岗位搜索',found:rows.length,matched:selected.length,reports:selected,checkedAt:new Date().toISOString(),caveat:'匿名用户原始表述；单位、年份、级别可能缺失，不据此推断目标岗位薪资或官方待遇。'}
}
