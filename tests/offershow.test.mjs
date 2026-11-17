import assert from 'node:assert/strict'
import {describe,it} from 'node:test'
import {parseSalaryHighlightsFromText,fetchOfferShowSalaryHighlights} from '../host/offershow.js'
const page='招聘导航\n薪资\n招聘\nWLB\n1\n网易互娱 - 游戏开发\n总包70多\n2\n腾讯 - 算法\n78\n查看更多 >\n其他页面内容'
describe('OfferShow public salary evidence boundaries',()=>{
 it('keeps salary strings and unknown units verbatim',()=>{const r=parseSalaryHighlightsFromText(page);assert.equal(r.length,2);assert.equal(r[1].salaryText,'78');assert.equal(r[1].publishedAt,null);assert.equal(r[1].title,'算法')})
 it('does not mistake recruitment plans for salary',()=>{assert.deepEqual(parseSalaryHighlightsFromText('腾讯2027校园招聘\n开始日期20261113'),[])})
 it('filters public snippets but does not claim full-company search',async()=>{const r=await fetchOfferShowSalaryHighlights({company:'腾讯',captureText:async()=>({ok:true,text:page})});assert.equal(r.matched,1);assert.match(r.scope,/不是完整薪资库/)})
})
