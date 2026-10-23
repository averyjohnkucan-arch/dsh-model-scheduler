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
test('model loading is slow blue; failed and cancelled leases leave no blue indicator',async t=>{
 const s=new ModelScheduler({idleMs:0});t.after(()=>s.close());let ready;
 const signal=new AbortController();
 const pending=s.withSession('a',()=>s.acquire(driver('slow',{load:()=>new Promise(r=>ready=r)}),signal.signal));
 await new Promise(r=>setImmediate(r));assert.deepEqual(s.activityStatus().activeSessionIds,['a']);assert.deepEqual(s.activityStatus().generatingSessionIds,[]);
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
 const stream=a.open('grandchild');stream.pulse();
 assert.deepEqual(a.snapshot([]).activeSessionIds,['child','grandchild','parent']);
 a.observe({id:'parent'},{type:'subagent/catalog',data:{childId:'parent',mode:'continuable'}});
 assert.deepEqual(a.snapshot([]).activeSessionIds,['child','grandchild','parent']);
 stream.close();a.open('fork');assert.deepEqual(a.snapshot([]).activeSessionIds,['fork']);
});
test('unscheduled providers start slow, accelerate on output, slow on finish and clear on return',async()=>{
 const s=new ModelScheduler();
 const stream=s.sessionStream('remote',async function*(){yield {type:'usage'};yield {type:'text-delta',text:'hi'};yield {type:'finish'};});
 await stream.next();assert.deepEqual(s.activityStatus().activeSessionIds,['remote']);assert.deepEqual(s.activityStatus().generatingSessionIds,[]);
 await stream.next();assert.deepEqual(s.activityStatus().generatingSessionIds,['remote']);
 await stream.next();assert.deepEqual(s.activityStatus().generatingSessionIds,[]);await stream.return();assert.deepEqual(s.activityStatus().activeSessionIds,[]);
 const failed=s.sessionStream('bad',async function*(){yield {type:'reasoning-delta',text:'hi'};throw Error('offline');});
 await failed.next();assert.deepEqual(s.activityStatus().activeSessionIds,['bad']);
 await assert.rejects(failed.next(),/offline/);assert.deepEqual(s.activityStatus().activeSessionIds,[]);
 const stopped=s.sessionStream('stop',async function*(){yield {type:'tool-call-delta'};});
 await stopped.next();await stopped.return();assert.deepEqual(s.activityStatus().activeSessionIds,[]);
 await s.close();
});

test('prefill, token output, token stall, tool wait and completion have distinct states',async t=>{
 const s=new ModelScheduler({idleMs:300000});t.after(()=>s.close());let now=0;
 s.activity=new GenerationActivity({now:()=>now});s.turnStarted('chat');
 const lease=await s.withSession('chat',()=>s.acquire(driver('a'))),stream=s.activity.open('chat');
 assert.deepEqual(s.activityStatus().activeSessionIds,['chat']);assert.deepEqual(s.activityStatus().generatingSessionIds,[]);
 stream.pulse();assert.deepEqual(s.activityStatus().generatingSessionIds,['chat']);
 now=1501;assert.deepEqual(s.activityStatus().generatingSessionIds,[]);assert.deepEqual(s.activityStatus().activeSessionIds,['chat']);
 stream.pulse();assert.deepEqual(s.activityStatus().generatingSessionIds,['chat']);
 stream.close();lease.release();assert.deepEqual(s.activityStatus().activeSessionIds,['chat']);assert.deepEqual(s.activityStatus().generatingSessionIds,[]);
 s.turnEnded('chat');assert.deepEqual(s.activityStatus().activeSessionIds,[]);
});
test('a provider stream queued behind another chat stays grey until admission',async t=>{
 const s=new ModelScheduler({idleMs:300000});t.after(()=>s.close());
 const lease=await s.withSession('first',()=>s.acquire(driver('a')));
 const stream=s.sessionStream('queued',async function*(){const lease=await s.acquire(driver('b'));try{yield {type:'usage'};yield {type:'text-delta',text:'hello'};}finally{lease.release();}});
 const waiting=stream.next();await new Promise(r=>setImmediate(r));
 assert.deepEqual(s.activityStatus().activeSessionIds,['first']);
 lease.release();await waiting;assert.deepEqual(s.activityStatus().activeSessionIds,['queued']);assert.deepEqual(s.activityStatus().generatingSessionIds,[]);
 await stream.next();assert.deepEqual(s.activityStatus().generatingSessionIds,['queued']);await stream.return();
});
test('working and generating states independently roll up to the parent',()=>{
 const a=new GenerationActivity();a.observe({id:'parent'},{type:'subagent/catalog',data:{childId:'child',mode:'continuable'}});
 const stream=a.open('child');assert.deepEqual(a.snapshot([]).activeSessionIds,['child','parent']);assert.deepEqual(a.snapshot([]).generatingSessionIds,[]);
 stream.pulse();assert.deepEqual(a.snapshot([]).generatingSessionIds,['child','parent']);stream.pause();assert.deepEqual(a.snapshot([]).generatingSessionIds,[]);
});
test('an idle model switches immediately even with a 30-second pending-turn grace',async t=>{
 const s=new ModelScheduler({idleMs:300000,switchMs:30000});t.after(()=>s.close());
 s.turnStarted('chat');(await s.withSession('chat',()=>s.acquire(driver('a')))).release();s.turnEnded('chat');s.turnStarted('chat');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('Unexpected switch delay')),250);
 try{const lease=await s.withSession('chat',()=>s.acquire(driver('b'),controller.signal));assert.equal(s.device(0).current.driver.key,'b');lease.release();}finally{clearTimeout(timer);s.turnEnded('chat');}
});
