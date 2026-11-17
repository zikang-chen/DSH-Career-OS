import assert from'node:assert/strict'
import{it}from'node:test'
import{parseDaysPerWeek}from'../host/domain.js'
import{assessJob360}from'../host/assessment.js'
it('extracts explicitly stated weekly full attendance without inventing missing fields',()=>{assert.equal(parseDaysPerWeek('预计入职：尽快，每周全勤5天'),5);const r=assessJob360({job:{requirements:'本科及以上；每周全勤5天'},profile:{degree:'硕士',weekly_days:4}});const c=r.eligibility.checks.find(c=>c.key==='weeklyDays');assert.equal(c.requirement,5);assert.equal(c.comparison,'mismatch');assert.equal(c.status,'provisional')})
