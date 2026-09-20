import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as provider from './.generated/client.mjs'

const ok = value => ({ ok: true, value })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const raw = new Uint8Array([0, 255, 128, 13, 10])
function fixture(over = {}) {
  assert.equal(typeof provider.DshRuntimeFiles, 'function', 'public runtime files provider must exist')
  let current = 'a'; const listeners = new Set(); const calls = []
  const session = { getSnapshot: () => ({ nodes: [] }), prompt: async (...args) => { calls.push(['prompt', ...args]); return ok({ accepted: true }) } }
  const sessions = { list: { getSnapshot: () => ({ current, ids: ['a','b'], byId: { a: {}, b: {} } }), subscribe: f => { listeners.add(f); return () => listeners.delete(f) } }, binding: id => ['a','b'].includes(id) ? { session } : undefined }
  const upload = { upload: async (...args) => { calls.push(['upload', ...args]); args[4]?.({ loaded: 5, total: 5 }); return ok({ receiptId: 'host-r1', file: { attachmentId: 'sha256:opaque', name: 'safe.bin', bytes: 5 } }) }, ...over.upload }
  const remote = { stat: async (...args) => { calls.push(['stat', ...args]); return ok({ absolutePath: '/outside/result.bin', version: 'v1', bytes: 5 }) }, readBytes: async (...args) => { calls.push(['readBytes', ...args]); return ok({ absolutePath: '/outside/result.bin', version: 'v1', bytes: 5, offset: 0, data: 'AP+ADQo=', eof: true }) }, ...over.remote }
  const surfaces = { getSnapshot: () => ({ sessionId: current, items: [{ sessionId: current, type: 'file', source: '/outside/result.bin' }] }) }
  const files = new provider.DshRuntimeFiles(sessions, over.noUpload ? undefined : upload, over.noRead ? undefined : remote, surfaces)
  const runtime = new provider.DshAgentRuntimeSession(sessions, {}, files)
  return { files, runtime, calls, session, surfaces, switchTo(id) { current = id; for (const fn of listeners) fn() }, dispose() { runtime.dispose(); files.dispose() } }
}
const uploadInput = () => ({ sessionId: 'a', file: new Blob([raw], { type: 'application/octet-stream' }), name: 'original.bin' })
const readInput = { sessionId: 'a', path: '/outside/result.bin' }

test('file upload uses public positional API and sends only Host receipts in prompt content', async t => {
  const f = fixture(); t.after(() => f.dispose()); const progress = []
  const input = { ...uploadInput(), onProgress: p => progress.push(p) }
  const result = await f.files.upload(input)
  assert.deepEqual(result, ok({ receiptId: 'host-r1', name: 'safe.bin', bytes: 5, mediaType: 'application/octet-stream' }))
  assert.equal(f.calls[0][1], 'a'); assert.equal(f.calls[0][2], input.file); assert.equal(f.calls[0][3], 'original.bin')
  assert.ok(f.calls[0][4] instanceof AbortSignal); assert.deepEqual(progress, [{ loaded: 5, total: 5 }])
  assert.equal((await f.runtime.sendTurn({ sessionId: 'a', content: '', mode: 'queue', files: [result.value] })).ok, true)
  assert.deepEqual(f.calls.at(-1), ['prompt', [{ type: 'file', receiptId: 'host-r1' }], 'queue'])
})

test('receipt ownership and metadata cannot be forged across sessions or after successful send', async t => {
  const f = fixture(); t.after(() => f.dispose()); const receipt = (await f.files.upload(uploadInput())).value
  for (const files of [[{ ...receipt, bytes: 0 }], [{ ...receipt, receiptId: 'invented' }]]) assert.equal((await f.runtime.sendTurn({ sessionId: 'a', content: 'x', mode: 'queue', files })).ok, false)
  assert.equal((await f.runtime.sendTurn({ sessionId: 'b', content: 'x', mode: 'queue', files: [receipt] })).ok, false)
  assert.equal(f.calls.filter(c => c[0] === 'prompt').length, 0)
  assert.equal((await f.runtime.sendTurn({ sessionId: 'a', content: '', mode: 'queue', files: [receipt] })).ok, true)
  assert.equal((await f.runtime.sendTurn({ sessionId: 'a', content: '', mode: 'queue', files: [receipt] })).ok, false)
})

test('admission rejects oversized uploads before transport and accepts empty files', async t => {
  const f = fixture({ upload: { upload: async () => ok({ receiptId: 'empty', file: { attachmentId: 'sha256:empty', name: 'empty.txt', bytes: 0 } }) } }); t.after(() => f.dispose())
  assert.equal((await f.files.upload({ ...uploadInput(), file: new Blob([new Uint8Array(33*1024*1024)]) })).ok, false)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await f.files.upload({ sessionId: 'a', name: 'empty.txt', file: new Blob() }), ok({ receiptId: 'empty', name: 'empty.txt', bytes: 0 }))
})

test('message admission enforces count, distinct receipts and total bytes with authoritative metadata', async t => {
  let seq = 0
  const f = fixture({ upload: { upload: async (_id, blob, name) => ok({ receiptId: `r${++seq}`, file: { attachmentId: `sha256:${seq}`, name, bytes: blob.size } }) } }); t.after(() => f.dispose())
  const blob = new Blob([new Uint8Array(32*1024*1024)])
  const receipts = []
  for (let i=0;i<11;i++) receipts.push((await f.files.upload({sessionId:'a', file:blob, name:`${i}.bin`})).value)
  for (const files of [receipts, receipts.slice(0,5), [receipts[0], receipts[0]]]) assert.equal((await f.runtime.sendTurn({sessionId:'a',content:'',mode:'queue',files})).ok,false)
  assert.equal(f.calls.length,0)
  assert.equal((await f.runtime.sendTurn({sessionId:'a',content:'',mode:'queue',files:receipts.slice(0,4)})).ok,true)
})

for (const action of ['abort', 'switch', 'dispose']) test(`late upload and progress are fenced on ${action}`, async () => {
  const wait = deferred(); let progressCallback; let transportSignal
  const f = fixture({ upload: { upload: (_id,_file,_name,signal,onProgress) => { transportSignal=signal; progressCallback=onProgress; return wait.promise } } })
  const controller = new AbortController(); const progress = []
  const pending = f.files.upload({...uploadInput(),signal:controller.signal,onProgress:p=>progress.push(p)})
  if(action==='abort') controller.abort(); else if(action==='switch'){f.switchTo('b');f.switchTo('a')} else f.files.dispose()
  progressCallback({loaded:5,total:5}); wait.resolve(ok({receiptId:'late',file:{attachmentId:'hash',name:'late.bin',bytes:5}}))
  assert.equal((await pending).ok,false); assert.equal(transportSignal.aborted,true); assert.deepEqual(progress,[]); f.dispose()
})

test('read uses authorized exact path and preserves binary bytes without text round trips', async t => {
  const f=fixture(); t.after(()=>f.dispose())
  const result=await f.files.read(readInput)
  assert.deepEqual(result,ok({sessionId:'a',path:'/outside/result.bin',name:'result.bin',mediaType:'application/octet-stream',data:raw,bytes:5,version:'v1'}))
  assert.deepEqual(f.calls.map(c=>c.slice(0,3)),[['stat','a','/outside/result.bin'],['readBytes','a','/outside/result.bin']])
  assert.deepEqual(f.calls[1][3],{offset:0,length:5})
  assert.ok(f.calls[1][4] instanceof AbortSignal)
  for(const path of ['/secret.txt','https://user:pass@host/file','javascript:alert(1)']) assert.equal((await f.files.read({...readInput,path})).ok,false)
  assert.equal(f.calls.length,2)
})

test('bounded read rejects large, malformed, changed or unreadable data', async t=>{
  for(const remote of [
    {stat:async()=>ok({absolutePath:'/outside/result.bin',version:'v1',bytes:33554433})},
    {stat:async()=>({ok:false,error:{code:'fs/denied',message:'not readable'}})},
    {readBytes:async()=>ok({absolutePath:'/outside/result.bin',version:'v2',bytes:5,offset:0,data:'AP+ADQo=',eof:true})},
    {readBytes:async()=>ok({absolutePath:'/other.bin',version:'v1',bytes:5,offset:0,data:'AP+ADQo=',eof:true})},
    {readBytes:async()=>ok({absolutePath:'/outside/result.bin',version:'v1',bytes:5,offset:0,data:'broken!',eof:true})},
    {readBytes:async()=>ok({absolutePath:'/outside/result.bin',version:'v1',bytes:5,offset:0,data:'AA==',eof:true})},
  ]){ const f=fixture({remote}); t.after(()=>f.dispose()); assert.equal((await f.files.read(readInput)).ok,false) }
})

for(const action of ['abort','switch','dispose']) test(`late read cannot survive ${action}`,async()=>{
  const wait=deferred(); let signal
  const f=fixture({remote:{readBytes:(_id,_path,_range,s)=>{signal=s;return wait.promise}}})
  const controller=new AbortController(); const pending=f.files.read({...readInput,signal:controller.signal}); await new Promise(r=>setImmediate(r))
  if(action==='abort')controller.abort();else if(action==='switch'){f.switchTo('b');f.switchTo('a')}else f.files.dispose()
  wait.resolve(ok({absolutePath:'/outside/result.bin',version:'v1',bytes:5,offset:0,data:'AP+ADQo=',eof:true}))
  assert.equal((await pending).ok,false);assert.equal(signal.aborted,true);f.dispose()
})

test('unsupported services and public business errors remain explicit',async t=>{
  const f=fixture({noUpload:true,noRead:true});t.after(()=>f.dispose())
  assert.equal((await f.files.upload(uploadInput())).error.kind,'unsupported');assert.equal((await f.files.read(readInput)).error.kind,'unsupported')
  const g=fixture({upload:{upload:async()=>({ok:false,error:{code:'session/attachment-invalid',message:'denied',details:{reason:'FILE_NOT_STAGED'}}})}});t.after(()=>g.dispose())
  assert.deepEqual((await g.files.upload(uploadInput())).error,{kind:'provider',code:'session/attachment-invalid',message:'denied',details:{reason:'FILE_NOT_STAGED'}})
})

test('large binary preview uses contiguous bounded pages and supports empty files', async t => {
  const bytes = new Uint8Array(2*1024*1024+3); bytes[0]=255; bytes[2097152]=128; bytes[2097154]=13
  const ranges=[]
  const f=fixture({remote:{
    stat:async()=>ok({absolutePath:'/outside/result.bin',version:'large',bytes:2097155}),
    readBytes:async(id,path,range)=>{assert.equal(id,'a');assert.equal(path,'/outside/result.bin');ranges.push(range);return ok({absolutePath:path,version:'large',bytes:2097155,offset:range.offset,data:Buffer.from(bytes.slice(range.offset,range.offset+range.length)).toString('base64'),eof:range.offset+range.length>=2097155})},
  }});t.after(()=>f.dispose())
  const result=await f.files.read(readInput);assert.equal(result.ok,true);assert.deepEqual(result.value.data,bytes)
  assert.deepEqual(ranges,[{offset:0,length:2097152},{offset:2097152,length:3}])
  const g=fixture({remote:{stat:async()=>ok({absolutePath:'/outside/result.bin',version:'empty',bytes:0}),readBytes:async()=>ok({absolutePath:'/outside/result.bin',version:'empty',bytes:0,offset:0,data:'',eof:true})}});t.after(()=>g.dispose())
  const empty=await g.files.read(readInput);assert.equal(empty.ok,true);assert.equal(empty.value.data.byteLength,0)
})

test('adapter integrates with actual upstream FileUploadRuntime fallback and local workspace byte reader', async t => {
  const { register } = await import('../../../runtime/DSH/node_modules/tsx/dist/esm/api/index.mjs')
  register({ tsconfig: fileURLToPath(new URL('../../../runtime/DSH/tsconfig.base.json', import.meta.url)) })
  const { openWorkspace } = await import('../../../runtime/DSH/packages/api/workspace-files/tests/harness.ts')
  const { FileUploadRuntime } = await import('../../../runtime/DSH/packages/client/file-upload/src/client/runtime.ts')
  const harness = await openWorkspace('xiaoshe-product-files-'); t.after(()=>harness.dispose())
  const path = join(harness.outside, '合法材料.bin'); await writeFile(path, raw)
  const endpoint = harness.endpoint(); const calls=[]
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis,'location')
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://fixture.test',search:'?fixture'}})
  t.after(()=>{if(previousLocation)Object.defineProperty(globalThis,'location',previousLocation);else delete globalThis.location})
  harness.ctx.provide('remote',{fileUploads:{upload:async(id,request,signal)=>{calls.push([id,request,signal]);return ok({receiptId:'actual-runtime',file:{attachmentId:'sha256:opaque',name:'safe.bin',bytes:5}})}}})
  const uploadFiber=await harness.ctx.plugin(FileUploadRuntime);t.after(()=>uploadFiber.dispose())
  const rpc=operation=>operation.then(ok,error=>({ok:false,error}))
  const sessions={list:{getSnapshot:()=>({current:'a'}),subscribe:()=>()=>{}},binding:()=>({})}
  const files=new provider.DshRuntimeFiles(sessions,harness.ctx.fileUpload,{stat:(id,name,signal)=>rpc(endpoint.stat({...harness.scope,sessionId:id},name,signal)),readBytes:(id,name,range,signal)=>rpc(endpoint.readBytes({...harness.scope,sessionId:id},name,range,signal))},{getSnapshot:()=>({sessionId:'a',items:[{sessionId:'a',type:'file',source:path}]})});t.after(()=>files.dispose())
  const uploaded=await files.upload(uploadInput());assert.equal(uploaded.ok,true)
  assert.equal(calls[0][0],'a');assert.deepEqual(calls[0][1],{data:'AP+ADQo=',name:'original.bin'});assert.ok(calls[0][2] instanceof AbortSignal)
  const read=await files.read({sessionId:'a',path});assert.equal(read.ok,true);assert.deepEqual(read.value.data,raw)
})
