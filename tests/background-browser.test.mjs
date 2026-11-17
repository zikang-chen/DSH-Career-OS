import fs from 'node:fs'
import assert from 'node:assert/strict'
import {it}from'node:test'
it('research targets opt into background and only login activates a window',()=>{
 const source=fs.readFileSync(new URL('../host/browser.js',import.meta.url),'utf8')
 const research=source.slice(source.indexOf('export async function capturePageJson'),source.indexOf('export async function openForLogin'))
 assert.ok(!research.includes('Target.activateTarget'))
 const targets=[...research.matchAll(/Target\.createTarget[^\n]+/g)].map(m=>m[0]);assert.ok(targets.length>=2);assert.ok(targets.every(line=>line.includes('background: true')))
 assert.match(source,/foreground = false/);assert.match(source,/--start-minimized/)
 const login=source.slice(source.indexOf('export async function openForLogin'));assert.match(login,/foreground: true/);assert.match(login,/Target.activateTarget/)
 const ocr=fs.readFileSync(new URL('../host/ocr.js',import.meta.url),'utf8');assert.match(ocr,/Target.createTarget.*background:true/)
})
