import test from 'node:test';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';import {ModelScheduler} from '../lib/scheduler.js';
function fixture(t,opts={}){const events=[],s=new ModelScheduler({idleMs:20,switchMs:0,backgroundMs:20,...opts});t.after(()=>s.close());const driver=(key,extra={})=>({key,name:key,gpu:0,fingerprint:key,load:async()=>{events.push('load '+key);return key;},unload:async()=>events.push('unload '+key),...extra});return {s,events,driver};}
test('FIFO chat switching waits for release then switches immediately; matching model reuses',async t=>{const {s,driver,events}=fixture(t);const a=await s.acquire(driver('a'));let next=false;const b=s.acquire(driver('b')).then(x=>(next=true,x));await delay(25);assert.equal(next,false);a.release();const lease=await b;assert.equal(next,true);assert.deepEqual(events,['load a','unload a','load b']);lease.release();const reused=await s.acquire(driver('b'));assert.equal(events.length,3);reused.release();});
test('aborted queued request never loads; unload explicitly aborts owned active request',async t=>{const {s,driver,events}=fixture(t);const a=await s.acquire(driver('a')),abort=new AbortController();const pending=s.acquire(driver('b'),abort.signal);abort.abort(new Error('cancelled'));await assert.rejects(pending,/cancelled/);await s.unload('a',{force:true});assert.equal(a.signal.aborted,true);assert.deepEqual(events,['load a','unload a']);a.release();});
test('foreground precedes queued background and background yields at document boundary',async t=>{const {s,driver,events}=fixture(t,{yieldMs:50});const background=await s.acquire(driver('background',{priority:'background'}));const other=s.acquire(driver('other',{priority:'background'}));const chat=s.acquire(driver('chat'));background.release();const answer=await chat;assert.deepEqual(events,['load background','unload background','load chat']);answer.release();const b=await other;b.release();});
test('background deadline aborts unfinished work before unloading and admits chat',async t=>{const {s,driver,events}=fixture(t,{yieldMs:15});const background=await s.acquire(driver('background',{priority:'background'}));const pending=s.acquire(driver('chat'));const answer=await pending;assert.equal(background.signal.aborted,true);assert.deepEqual(events,['load background','unload background','load chat']);answer.release();background.release();});
test('failed unload blocks new engine admission and explicit unload can retry',async t=>{let fail=true;const {s,driver,events}=fixture(t,{idleMs:0});const a=await s.acquire(driver('a',{unload:async()=>{if(fail)throw new Error('still owns memory');events.push('unload a');}}));const b=s.acquire(driver('b'));a.release();await assert.rejects(b,/still owns memory/);assert.equal(s.status().devices[0].phase,'unload-failed');assert.deepEqual(events,['load a']);fail=false;await s.unload('a');});
test('closing during a load cancels and unloads; no owned server remains',async t=>{const {s,driver,events}=fixture(t);const loading=s.acquire(driver('a',{load:async signal=>{await delay(50,undefined,{signal});return 'a';}}));await delay(2);const closed=s.close();await assert.rejects(loading);await closed;assert.deepEqual(events,['unload a']);assert.equal(s.status().devices[0].model,null);});

test('interactive reuse of an idle background model promotes its priority',async t=>{const {s,driver}=fixture(t,{yieldMs:5});const b=await s.acquire(driver('same',{priority:'background'}));b.release();const chat=await s.acquire(driver('same'));const pending=s.acquire(driver('different'));await delay(12);assert.equal(chat.signal.aborted,false);assert.equal(s.status().devices[0].priority,'interactive');chat.release();(await pending).release();});

test('exclusive image work bypasses idle grace, releases its worker, and restores the chat model',async t=>{const {s,driver,events}=fixture(t,{idleMs:30000});const chat=await s.acquire(driver('chat'));chat.release();const result=await s.runExclusive(driver('image'),async()=>{events.push('render');return 'png';});assert.deepEqual(events,['load chat','unload chat','load image','render','unload image','load chat']);assert.deepEqual(result,{result:'png',restoration:'loaded'});});
test('failed image generation still releases GPU and restores previous model',async t=>{const {s,driver,events}=fixture(t,{idleMs:30000});(await s.acquire(driver('chat'))).release();await assert.rejects(()=>s.runExclusive(driver('image'),async()=>{throw Error('render failed');}),/render failed/);assert.deepEqual(events,['load chat','unload chat','load image','unload image','load chat']);});
test('an image request never interrupts an active chat',async t=>{const {s,driver,events}=fixture(t,{idleMs:30000});const chat=await s.acquire(driver('chat'));const image=s.runExclusive(driver('image'),async()=> 'png');await delay(10);assert.deepEqual(events,['load chat']);chat.release();await image;});

test('image preflight failure restores the displaced model',async t=>{const {s,driver,events}=fixture(t,{idleMs:30000});(await s.acquire(driver('chat'))).release();await assert.rejects(()=>s.runExclusive(driver('image',{load:async()=>{throw Error('external GPU application');}}),async()=> 'png'),/external GPU application/);assert.deepEqual(events,['load chat','unload chat','unload image','load chat']);});

test('idle retention and waiting-model switch grace are independent',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:300,switchMs:30});
 const first=await s.acquire(driver('first'));first.release();await delay(55);
 assert.deepEqual(events,['load first']); // no contender: retain beyond switch grace
 const second=await s.acquire(driver('second'));assert.deepEqual(events,['load first','unload first','load second']);second.release();
});
test('waiting model switches after the completed request becomes quiet',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500,switchMs:35});
 const first=await s.acquire(driver('first'));const waiting=s.acquire(driver('second'));await delay(45);assert.deepEqual(events,['load first']);first.release();const next=await waiting;next.release();assert.deepEqual(events,['load first','unload first','load second']);
});
test('cancelled contender returns to five-minute-style idle retention; timers are configurable',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:300,switchMs:25});s.turnStarted('session');const first=await s.withSession('session',()=>s.acquire(driver('first')));first.release();
 const abort=new AbortController(),waiting=s.acquire(driver('second'),abort.signal);abort.abort(Error('cancelled'));await assert.rejects(waiting,/cancelled/);await delay(50);assert.deepEqual(events,['load first']);
 s.configure(0.2,0.01);assert.equal(s.status().idleSeconds,0.2);assert.equal(s.status().switchSeconds,0.01);assert.throws(()=>s.configure(300,-1),/Switch delay/);
});
test('new scheduler defaults retain for sixty seconds and switch after five quiet seconds',async t=>{
 const s=new ModelScheduler();t.after(()=>s.close());assert.equal(s.status().idleSeconds,60);assert.equal(s.status().switchSeconds,5);
});

test('keep-warm chat survives idle timeout and configuration changes, but yields to another model',async t=>{
 const {s,events,driver}=fixture(t,{idleMs:5,switchMs:0});
 const warm=driver('warm',{keepWarm:true});
 (await s.acquire(warm)).release();
 await delay(15);
 s.configure(0,0);
 await delay(10);
 assert.deepEqual(events,['load warm']);
 assert.equal(s.status().devices[0].keepWarm,true);
 (await s.acquire(warm)).release();
 assert.deepEqual(events,['load warm']);
 (await s.acquire(driver('other'))).release();
 assert.deepEqual(events.slice(0,3),['load warm','unload warm','load other']);
});

test('keep-warm never blocks image work, explicit unloading, or scheduler shutdown',async t=>{
 const {s,events,driver}=fixture(t,{idleMs:1,switchMs:30000});
 (await s.acquire(driver('warm',{keepWarm:true}))).release();
 await s.runExclusive(driver('image'),async()=>events.push('image work'),{restorePrevious:false});
 assert.deepEqual(events,['load warm','unload warm','load image','image work','unload image']);
 (await s.acquire(driver('warm',{keepWarm:true}))).release();
 await s.unload('warm');
 assert.equal(s.status().devices[0].phase,'unloaded');
});


test('an already quiet model switches when a contender arrives',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500,switchMs:35});s.turnStarted('session');
 const first=await s.withSession('session',()=>s.acquire(driver('first')));first.release();
 await delay(45);assert.deepEqual(events,['load first']);
 const waiting=s.acquire(driver('second'));
 const next=await waiting;assert.deepEqual(events,['load first','unload first','load second']);next.release();
});
test('turn completion preserves the quiet interval',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500,switchMs:25});s.turnStarted('session');
 const first=await s.withSession('session',()=>s.acquire(driver('first')));first.release();
 const waiting=s.acquire(driver('second'));await delay(5);assert.deepEqual(events,['load first']);s.turnEnded('session');
 const next=await waiting;next.release();assert.deepEqual(events,['load first','unload first','load second']);
});
test('a same-turn continuation can run during grace without losing its session identity',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500,switchMs:60});s.turnStarted('session');
 (await s.withSession('session',()=>s.acquire(driver('first')))).release();
 const waiting=s.acquire(driver('second'));const again=await s.withSession('session',()=>s.acquire(driver('first')));
 assert.deepEqual(events,['load first']);again.release();s.turnEnded('session');(await waiting).release();
});
test('stream wrapper preserves events and associates leases using async session context',async t=>{
 const {s,driver}=fixture(t);let session;
 const output=[];for await(const value of s.sessionStream('session',()=> (async function*(){const lease=await s.acquire(driver('a'));session=s.device(0).current.sessionId;try{yield 'first';await delay(1);yield 'second';}finally{lease.release();}})()))output.push(value);
 assert.equal(session,'session');assert.deepEqual(output,['first','second']);
});

test('completion of one shared-model session does not clear another pending turn',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500,switchMs:50});s.turnStarted('one');s.turnStarted('two');
 (await s.withSession('one',()=>s.acquire(driver('first')))).release();
 (await s.withSession('two',()=>s.acquire(driver('first')))).release();
 s.turnEnded('two');const waiting=s.acquire(driver('second'));await delay(8);assert.deepEqual(events,['load first']);
 s.turnEnded('one');(await waiting).release();assert.deepEqual(events,['load first','unload first','load second']);
});

test('a driver that finishes its pending operation does not wait out the remaining grace',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500,switchMs:25});let busy=false;
 (await s.acquire(driver('first',{busy:()=>busy}))).release();busy=true;
 const waiting=s.acquire(driver('second'));await delay(5);assert.deepEqual(events,['load first']);busy=false;
 const next=await Promise.race([waiting,delay(500).then(()=>{throw Error('Completed driver did not hand over promptly')})]);next.release();
 assert.deepEqual(events,['load first','unload first','load second']);
});

test('foreground reservations finish before model load and remain held through inference',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500});let finish;const ready=new Promise(r=>finish=r);
 s.registerResourceGuard('embeddings',async()=>{events.push('yield requested');await ready;events.push('memory released');return()=>events.push('reservation ended');});
 assert.deepEqual(s.status().resourceGuards,['embeddings']);const pending=s.acquire(driver('chat'));await delay(5);assert.deepEqual(events,['yield requested']);finish();
 const lease=await pending;assert.deepEqual(events,['yield requested','memory released','load chat']);lease.release();lease.release();assert.equal(events.filter(x=>x==='reservation ended').length,1);
});
test('image-to-chat restoration reserves foreground memory again before reloading',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500});s.registerResourceGuard('embeddings',async({key})=>{events.push('reserve '+key);return()=>events.push('release '+key);});
 (await s.acquire(driver('chat'))).release();await s.runExclusive(driver('image'),async()=>events.push('render'));
 assert.ok(events.indexOf('reserve image')<events.indexOf('load image'));
 assert.equal(events.filter(x=>x==='reserve chat').length,2);assert.ok(events.lastIndexOf('reserve chat')<events.lastIndexOf('load chat'));
});
test('reservation failure prevents loading and releases earlier reservations',async t=>{
 const {s,driver,events}=fixture(t);s.registerResourceGuard('first',async()=>()=>events.push('released first'));s.registerResourceGuard('second',async()=>{throw Error('memory still busy');});
 await assert.rejects(s.acquire(driver('chat')),/memory still busy/);assert.deepEqual(events,['released first']);
});
test('background admission does not reserve foreground resources',async t=>{
 const {s,driver}=fixture(t);let calls=0;const remove=s.registerResourceGuard('embedding',async()=>{calls++;return()=>{};});(await s.acquire(driver('embedding',{priority:'background'}))).release();assert.equal(calls,0);remove();
});
test('shutdown during reservation cannot launch a model afterward',async t=>{
 const {s,driver,events}=fixture(t);let finish;const ready=new Promise(r=>finish=r);s.registerResourceGuard('embedding',async()=>{await ready;return()=>events.push('released');});
 const pending=s.acquire(driver('chat'));await delay(1);await s.close();finish();await assert.rejects(pending,/disabled/);assert.deepEqual(events,['released']);
});

test('queued OCR does not evict a completed keep-warm chat until the background delay',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500,backgroundMs:60,switchMs:5});
 const chat=await s.acquire(driver('chat',{keepWarm:true}));
 const waiting=s.acquire(driver('ocr',{priority:'background'}));chat.release();
 await delay(20);assert.deepEqual(events,['load chat']);
 (await waiting).release();assert.deepEqual(events,['load chat','unload chat','load ocr']);
});
test('new foreground inference resets the background delay and reuses the resident model',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500,backgroundMs:90});
 (await s.acquire(driver('chat'))).release();
 const waiting=s.acquire(driver('ocr',{priority:'background'}));await delay(55);
 (await s.acquire(driver('chat'))).release();
 await delay(55);assert.deepEqual(events,['load chat']);
 (await waiting).release();assert.deepEqual(events,['load chat','unload chat','load ocr']);
});
test('a tool pause can yield after the background quiet interval',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500,backgroundMs:10,switchMs:5});s.turnStarted('chat');
 (await s.withSession('chat',()=>s.acquire(driver('chat')))).release();
 const waiting=s.acquire(driver('ocr',{priority:'background'}));await delay(3);
 assert.deepEqual(events,['load chat']);s.turnEnded('chat');
 (await waiting).release();assert.deepEqual(events,['load chat','unload chat','load ocr']);
});
test('a different foreground chat bypasses background delay and explicit unload still works',async t=>{
 const {s,driver,events}=fixture(t,{idleMs:500,backgroundMs:60000});
 (await s.acquire(driver('chat'))).release();
 const waiting=s.acquire(driver('ocr',{priority:'background'}));
 const next=await s.acquire(driver('other-chat'));
 assert.deepEqual(events,['load chat','unload chat','load other-chat']);next.release();
 await s.unload('other-chat');(await waiting).release();
 assert.deepEqual(events.slice(-2),['unload other-chat','load ocr']);
 assert.equal(s.status().backgroundSeconds,60);
 s.configure(0.5,0.03,0.12);assert.equal(s.status().backgroundSeconds,0.12);
 assert.throws(()=>s.configure(300,30,-1),/Background delay/);
});

test('background exclusive tool can hand off its own idle conversation without ending the turn',async t=>{
 const {s,driver,events}=fixture(t,{backgroundMs:300000,switchMs:30000});
 s.turnStarted('video-conversation');const chat=await s.withSession('video-conversation',()=>s.acquire(driver('chat')));chat.release();
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(Error('deadlocked waiting for its own turn')),200);
 try{await s.runExclusive(driver('video',{priority:'background',handoffSessionId:'video-conversation'}),async()=>events.push('video'),{signal:abort.signal});}
 finally{clearTimeout(timer);s.turnEnded('video-conversation');}
 assert.deepEqual(events,['load chat','unload chat','load video','video','unload video','load chat']);
});

test('own-turn video handoff bypasses queued background work that is waiting for that same turn',async t=>{
 const {s,driver,events}=fixture(t,{backgroundMs:300000,switchMs:30000});
 s.turnStarted('video-conversation');const chat=await s.withSession('video-conversation',()=>s.acquire(driver('chat')));chat.release();
 const ingestion=s.acquire(driver('ingestion',{priority:'background'}));
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(Error('video blocked behind queued ingestion')),200);
 try{const result=await s.runExclusive(driver('video',{priority:'background',handoffSessionId:'video-conversation'}),async()=>events.push('video'),{signal:abort.signal,restorePrevious:false});assert.equal(result.restoration,'not-needed');}
 finally{clearTimeout(timer);s.turnEnded('video-conversation');}
 assert.deepEqual(events.slice(0,5),['load chat','unload chat','load video','video','unload video']);(await ingestion).release();
});

test('own-turn video handoff does not interrupt a background job that is already running',async t=>{
 const {s,driver,events}=fixture(t,{backgroundMs:300000,switchMs:30000});
 const ingestion=await s.acquire(driver('ingestion',{priority:'background'}));
 const waiting=s.runExclusive(driver('video',{priority:'background',handoffSessionId:'video-conversation'}),async()=>events.push('video'),{restorePrevious:false});
 await delay(15);assert.deepEqual(events,['load ingestion']);assert.equal(ingestion.signal.aborted,false);ingestion.release();await waiting;
 assert.deepEqual(events,['load ingestion','unload ingestion','load video','video','unload video']);
});

test('a chat-blocking tool restores its main model before queued background ingestion',async t=>{
 const {s,driver,events}=fixture(t,{backgroundMs:300000,switchMs:30000});s.turnStarted('conversation');
 (await s.withSession('conversation',()=>s.acquire(driver('chat')))).release();
 const controller=new AbortController(),background=s.acquire(driver('ingestion',{priority:'background'}),controller.signal);background.catch(()=>{});
 const result=await s.runExclusive(driver('video',{priority:'background',handoffSessionId:'conversation'}),async()=>events.push('video'));
 controller.abort();(await background.catch(()=>null))?.release();s.turnEnded('conversation');
 assert.equal(result.restoration,'loaded');assert.deepEqual(events.slice(0,6),['load chat','unload chat','load video','video','unload video','load chat']);
});

test('foreground exclusive inference also reserves chat restoration ahead of background work',async t=>{
 const {s,driver,events}=fixture(t,{backgroundMs:300000});(await s.acquire(driver('chat'))).release();
 const controller=new AbortController(),background=s.acquire(driver('ingestion',{priority:'background'}),controller.signal);background.catch(()=>{});
 const result=await s.runExclusive(driver('image',{priority:'interactive'}),async()=>events.push('render'));
 controller.abort();(await background.catch(()=>null))?.release();
 assert.equal(result.restoration,'loaded');assert.deepEqual(events.slice(0,6),['load chat','unload chat','load image','render','unload image','load chat']);
});
