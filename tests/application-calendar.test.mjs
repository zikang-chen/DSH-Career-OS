import assert from'node:assert/strict'
import{it}from'node:test'
import{buildApplicationCalendar}from'../host/application-calendar.js'
const app=(extra)=>({id:extra.id??'a1',company_name:'甲',job_title:'实习',status:'applied',...extra})
it('groups deadline, next action and applied dates and keeps overdue separate',()=>{const c=buildApplicationCalendar({now:'2026-11-18T02:00:00Z',applications:[app({id:'a1',deadline:'2026-11-20',next_action_at:'2026-11-25',applied_at:'2026-11-17'}),app({id:'a2',next_action_at:'2026-11-10'})]});assert.equal(c.days.length,3);assert.deepEqual(c.days.map(d=>d.date),['2026-11-17','2026-11-20','2026-11-25']);assert.equal(c.overdue.length,1);assert.equal(c.overdue[0].kind,'nextAction')})
it('does not invent dates and lists undated records honestly',()=>{const c=buildApplicationCalendar({now:'2026-11-18T02:00:00Z',applications:[app({id:'a3'})]});assert.equal(c.days.length,0);assert.equal(c.undated.length,1);assert.equal(c.undated[0].id,'a3')})
it('excludes far-future dates under the horizon but never edits them',()=>{const c=buildApplicationCalendar({now:'2026-11-18T02:00:00Z',days:7,applications:[app({id:'a4',deadline:'2027-06-01'})]});assert.equal(c.days.length,0);assert.equal(c.horizonDays,7)})
it('uses the Shanghai day for today, not the UTC day',()=>{const a=buildApplicationCalendar({now:'2026-11-17T16:30:00Z',applications:[app({id:'a5',next_action_at:'2026-11-18'})]});assert.equal(a.today,'2026-11-18');assert.equal(a.days[0].date,'2026-11-18')})
