import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelScheduler} from '../lib/scheduler.js';
import {GenerationActivity} from '../lib/activity.js';

const driver=(key,extra={})=>({key,name:key,gpu:0,fingerprint:key,load:async()=>{},unload:async()=>{},...extra});
test('only the admitted chat is blue; queued, idle and background work are excluded',async t=>{
 const s=new ModelScheduler({idleMs:0,backgroundMs:0});t.after(()=>s.close());
 const first=await s.withSession('chat-a',()=>s.acquire(driver('model')));
 const second=s.withSession('chat-b',()=>s.acquire(driver('model')));
 assert.deepEqual(s.activityStatus().activeSessionIds,['chat-a']);
 first.release();const b=await second;
 assert.deepEqual(s.activityStatus().activeSessionIds,['chat-b']);
 b.release();assert.deepEqual(s.activityStatus().activeSessionIds,[]);
 const bg=await s.withSession('knowledge',()=>s.acquire(driver('ocr',{priority:'background'})));
 assert.deepEqual(s.activityStatus().activeSessionIds,[]);bg.release();
});
test('model loading is grey; failed and cancelled leases leave no blue indicator',async t=>{
 const s=new ModelScheduler({idleMs:0});t.after(()=>s.close());let ready;
 const signal=new AbortController();
 const pending=s.withSession('a',()=>s.acquire(driver('slow',{load:()=>new Promise(r=>ready=r)}),signal.signal));
 await new Promise(r=>setImmediate(r));assert.deepEqual(s.activityStatus().activeSessionIds,[]);
 ready();const lease=await pending;assert.deepEqual(s.activityStatus().activeSessionIds,['a']);
 signal.abort();assert.deepEqual(s.activityStatus().activeSessionIds,[]);lease.release();
 await assert.rejects(s.withSession('b',()=>s.acquire(driver('bad',{load:async()=>{throw Error('failed');}}))),/failed/);
 assert.deepEqual(s.activityStatus().activeSessionIds,[]);
});
test('media jobs inherit tool session identity only while holding the lease',async t=>{
 const s=new ModelScheduler({idleMs:0});t.after(()=>s.close());
 await s.withSession('image-chat',()=>s.runExclusive(driver('image'),async()=>{
  assert.deepEqual(s.activityStatus().activeSessionIds,['image-chat']);
 },{restorePrevious:false}));
 assert.deepEqual(s.activityStatus().activeSessionIds,[]);
 const video=await s.acquire(driver('video',{handoffSessionId:'video-chat'}));
 assert.deepEqual(s.activityStatus().activeSessionIds,['video-chat']);video.release();
});
test('generation rolls up through subagents, never ordinary chat forks, and handles cycles',()=>{
 const a=new GenerationActivity();
 a.observe({id:'child',header:{origin:'subagent',parentSession:'parent'}},{type:'turn/start'});
 a.observe({id:'grandchild',header:{origin:'subagent',parentSession:'child'}},{type:'turn/start'});
 a.observe({id:'fork',header:{parentSession:'unrelated'}},{type:'turn/start'});
 const end=a.begin('grandchild');
 assert.deepEqual(a.snapshot([]).activeSessionIds,['child','grandchild','parent']);
 a.observe({id:'parent'},{type:'subagent/catalog',data:{childId:'parent',mode:'continuable'}});
 assert.deepEqual(a.snapshot([]).activeSessionIds,['child','grandchild','parent']);
 end();a.begin('fork');assert.deepEqual(a.snapshot([]).activeSessionIds,['fork']);
});
test('unscheduled providers light up on actual output, and clear on finish, error or early return',async()=>{
 const s=new ModelScheduler();
 const stream=s.sessionStream('remote',async function*(){yield {type:'usage'};yield {type:'text-delta',text:'hi'};yield {type:'finish'};});
 await stream.next();assert.deepEqual(s.activityStatus().activeSessionIds,[]);
 await stream.next();assert.deepEqual(s.activityStatus().activeSessionIds,['remote']);
 await stream.next();assert.deepEqual(s.activityStatus().activeSessionIds,[]);await stream.return();
 const failed=s.sessionStream('bad',async function*(){yield {type:'reasoning-delta',text:'hi'};throw Error('offline');});
 await failed.next();assert.deepEqual(s.activityStatus().activeSessionIds,['bad']);
 await assert.rejects(failed.next(),/offline/);assert.deepEqual(s.activityStatus().activeSessionIds,[]);
 const stopped=s.sessionStream('stop',async function*(){yield {type:'tool-call-delta'};});
 await stopped.next();await stopped.return();assert.deepEqual(s.activityStatus().activeSessionIds,[]);
 await s.close();
});
