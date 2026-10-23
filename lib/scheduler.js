import { AsyncLocalStorage } from 'node:async_hooks';
import { GenerationActivity } from './activity.js';
/** FIFO admission and idle unloading. Drivers own their servers; no PID guessing. */
export class ModelScheduler {
 constructor({idleMs=300000,switchMs=30000,backgroundMs=120000,yieldMs=30000,onChange=()=>{}}={}){this.idleMs=idleMs;this.switchMs=switchMs;this.backgroundMs=backgroundMs;this.yieldMs=yieldMs;this.onChange=onChange;this.providers=new Map();this.devices=new Map();this.closed=false;this.requestContext=new AsyncLocalStorage();this.turns=new Set();this.resourceGuards=new Map();}
 withSession(sessionId,operation){return this.requestContext.run(sessionId,operation);}
 activity=new GenerationActivity();
 activityStatus(){return this.activity.snapshot(this.devices.values(),this.turns);}
 turnStarted(sessionId){this.turns.add(sessionId);}
 turnEnded(sessionId){this.turns.delete(sessionId);for(const d of this.devices.values())if(d.current?.sessions?.delete(sessionId))void this.pump(d);}
 async *sessionStream(sessionId,next,signal){
  const iterator=this.withSession(sessionId,()=>next()[Symbol.asyncIterator]());
  const activity=this.activity.open(sessionId),stop=()=>activity.close();
  signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  try{while(true){const item=await this.withSession(sessionId,()=>iterator.next());if(item.done)return;
   // Prefill/tool waits stay slow blue; only real output deltas accelerate it.
   if(!signal?.aborted&&['text-delta','reasoning-delta','tool-call-delta'].includes(item.value.type))activity.pulse();
   if(item.value.type==='finish')activity.pause();
   yield item.value;
  }}
  finally{stop();signal?.removeEventListener('abort',stop);if(iterator.return)await this.withSession(sessionId,()=>iterator.return());}
 }
 registerResourceGuard(id,enter){if(this.resourceGuards.has(id))throw Error('Resource guard already registered.');this.resourceGuards.set(id,enter);return()=>this.resourceGuards.delete(id);}
 async reserveForeground(driver,signal){
  if(driver.priority==='background')return()=>{};
  const releases=[];let done=false;const release=()=>{if(done)return;done=true;for(const fn of releases.reverse())fn();};
  try{for(const enter of this.resourceGuards.values()){const leave=await enter({gpu:driver.gpu,key:driver.key,signal});if(typeof leave==='function')releases.push(leave);signal.throwIfAborted();}return release;}catch(error){release();throw error;}
 }
 registerProvider(id,list){if(this.providers.has(id))throw new Error('Scheduling provider already registered.');this.providers.set(id,list);this.onChange();return()=>{this.providers.delete(id);this.onChange();};}
 models(){return [...this.providers.values()].flatMap(list=>list()).map(({key,name,gpu})=>({key,name,gpu}));}
 async runExclusive(driver,operation,{signal,restorePrevious=true}={}){
  const device=this.device(driver.gpu),previous=device.current?.driver;
  let lease,result,error,resume;
  try{lease=await this.acquire({...driver,immediate:true},signal);result=await operation(lease.state,lease.signal);}catch(e){error=e;}
  finally{
   // Reserve the originating chat continuation before releasing the tool GPU.
   // Otherwise a queued background job can acquire it between render exit and
   // restoration and make the waiting conversation pay another yield delay.
   if(lease&&restorePrevious&&(driver.handoffSessionId||driver.priority!=='background')&&previous&&previous.key!==driver.key&&!this.closed&&device.queue.every(q=>q.driver.priority==='background')){
    resume=this.acquire({...previous,immediate:true,priority:'interactive'});
    resume.catch(()=>{});
   }
   lease?.release();
   // Confirm the renderer has released its process tree before another model loads.
   if(lease)await this.unload(driver.key,{force:true});
  }
  let restoration='not-needed';
  if(resume){try{const resumed=await resume;resumed.release();restoration='loaded';}catch(e){restoration='failed: '+e.message;}}
  else if(restorePrevious&&previous&&previous.key!==driver.key&&!this.closed){
   if(device.queue.length||device.current)restoration='deferred-to-next-chat';
   else{try{const resumed=await this.acquire({...previous,immediate:true});resumed.release();restoration='loaded';}catch(e){restoration='failed: '+e.message;}}
  }
  if(error)throw error;
  return {result,restoration};
 }
 async load(key,signal){const driver=[...this.providers.values()].flatMap(list=>list()).find(d=>d.key===key);if(!driver)throw new Error('No registered engine owns this model.');const lease=await this.acquire(driver,signal);lease.release();return {loaded:true};}
 device(gpu){const key=String(gpu);if(!this.devices.has(key))this.devices.set(key,{gpu:key,queue:[],current:null,pumping:false,timer:null});return this.devices.get(key);}
 status(){return {resourceGuards:[...this.resourceGuards.keys()],idleSeconds:this.idleMs/1000,switchSeconds:this.switchMs/1000,backgroundSeconds:this.backgroundMs/1000,gpuProcesses:this.gpuProcesses||[],telemetryError:this.telemetryError||null,models:this.models(),devices:[...this.devices.values()].map(d=>({gpu:d.gpu,model:d.current?.driver.name??null,key:d.current?.driver.key??null,priority:d.current?.driver.priority??'interactive',keepWarm:d.current?.driver.keepWarm===true,yieldDeadline:d.current?.yieldDeadline??null,phase:d.current?.phase??'unloaded',active:d.current?.active??0,idleUntil:Number.isFinite(d.current?.idleUntil)?d.current.idleUntil:null,error:d.current?.error??null,queue:d.queue.map(q=>({key:q.driver.key,name:q.driver.name}))}))};}
 configure(seconds,switchSeconds=this.switchMs/1000,backgroundSeconds=this.backgroundMs/1000){for(const [name,value]of [['Idle timeout',seconds],['Switch delay',switchSeconds],['Background delay',backgroundSeconds]])if(!Number.isFinite(value)||value<0||value>86400)throw new Error(name+' must be between 0 and 86400 seconds.');this.idleMs=seconds*1000;this.switchMs=switchSeconds*1000;this.backgroundMs=backgroundSeconds*1000;for(const d of this.devices.values()){if(d.current&&!d.current.active){d.current.idleSince=Date.now();d.current.idleUntil=d.current.idleSince+this.idleMs;}void this.pump(d);}this.onChange();}
 acquire(driver,signal){
  // A conversation-blocking tool request is foreground inference, regardless
  // of a legacy provider label. Queue it ahead of background ingestion.
  if(driver.handoffSessionId)driver={...driver,priority:'interactive'};
  if(this.closed)return Promise.reject(new Error('Model scheduler is disabled.'));signal?.throwIfAborted();
  const d=this.device(driver.gpu),controller=new AbortController();
  return new Promise((resolve,reject)=>{
   const q={driver,controller,resolve,reject,sessionId:this.requestContext.getStore()??driver.handoffSessionId,queuedAt:Date.now(),settled:false,cleanup:()=>signal?.removeEventListener('abort',abort)};
   const abort=()=>{controller.abort(signal.reason);const i=d.queue.indexOf(q);if(i>=0){d.queue.splice(i,1);q.cleanup();reject(signal.reason??new Error('Cancelled'));}void this.pump(d);};
   signal?.addEventListener('abort',abort,{once:true});if(driver.priority==='background')d.queue.push(q);else{const index=d.queue.findIndex(item=>item.driver.priority==='background');if(index<0)d.queue.push(q);else d.queue.splice(index,0,q);}this.onChange();void this.pump(d);
  });
 }
 arm(d,ms){clearTimeout(d.timer);d.timer=setTimeout(()=>{d.timer=null;void this.pump(d);},Math.max(1,ms));if(!d.queue.length)d.timer.unref?.();}
 async pump(d){
  if(d.pumping)return;d.pumping=true;clearTimeout(d.timer);d.timer=null;
  try{
   while(true){
    const c=d.current;
    let q=d.queue[0];
    // During the grace a pending tool result may continue its current turn.
    // Its continuation cannot reset the first contender's original deadline.
    if(c&&!c.active&&[...c.sessions??[]].some(id=>this.turns.has(id))&&q&&Date.now()<q.queuedAt+this.switchMs){
     const continuation=d.queue.findIndex(item=>c.sessions?.has(item.sessionId)&&this.turns.has(item.sessionId)&&item.driver.key===c.driver.key&&item.driver.fingerprint===c.driver.fingerprint);
     if(continuation>0){const [item]=d.queue.splice(continuation,1);d.queue.unshift(item);q=item;}
    }
    if(c?.active){
     if(c.driver.priority==='background'&&q&&q.driver.priority!=='background'){
      if(!c.yieldDeadline){c.yieldDeadline=Date.now()+this.yieldMs;c.yieldTimer=setTimeout(()=>{c.stopRequested=true;c.controller?.abort(new Error('Yield GPU to waiting chat; retry this document on CPU.'));c.active=0;void this.pump(d);},this.yieldMs);this.onChange();}
     }else if(c.yieldDeadline){clearTimeout(c.yieldTimer);c.yieldDeadline=null;}
     return;
    }
    if(c){
     const reuse=q&&q.driver.key===c.driver.key&&q.driver.fingerprint===c.driver.fingerprint&&!c.stopRequested;
     if(!reuse){
      // Keep a conversation's cache alive while idle, without blocking queued work or Stop.
      if(!q&&c.driver.keepWarm===true&&!c.stopRequested)return;
      const busy=c.driver.busy?.()===true,turnPending=!![...c.sessions??[]].some(id=>this.turns.has(id));
      c.phase=turnPending?'waiting-turn':'idle';
      // A completed/stopped turn has no switch delay. Idle retention is only
      // for keeping a model warm when there is no competing request.
      // Background ingestion must not evict a chat between steps or immediately
      // after its answer. Each foreground lease renews this separate quiet period.
      const ownToolHandoff=q?.driver.immediate===true&&q.driver.handoffSessionId&&c.sessions?.has(q.driver.handoffSessionId)&&![...c.sessions].some(id=>id!==q.driver.handoffSessionId&&this.turns.has(id));
      const backgroundWait=q?.driver.priority==='background'&&c.driver.priority!=='background'&&!ownToolHandoff;
      if(backgroundWait&&!c.stopRequested&&(turnPending||busy)){this.arm(d,500);return;}
      const deadline=q?(backgroundWait?c.idleSince+this.backgroundMs:ownToolHandoff&&!busy?0:turnPending||busy?q.queuedAt+this.switchMs:0):c.idleUntil;
      if(!c.stopRequested&&Date.now()<deadline){this.arm(d,busy?Math.min(100,deadline-Date.now()):deadline-Date.now());return;}
      if(busy&&!q&&!c.stopRequested){this.arm(d,500);return;}
      c.phase='unloading';this.onChange();
      try{await c.driver.unload();c.releaseResources?.();d.current=null;for(const w of c.waiters)w.resolve();}
      catch(error){c.phase='unload-failed';c.error=error.message;for(const w of c.waiters)w.reject(error);c.waiters=[];for(const waiting of d.queue.splice(0)){waiting.cleanup();waiting.reject(error);}return;}
      this.onChange();continue;
     }
    }
    if(!q)return;
    d.queue.shift();
    if(q.controller.signal.aborted){q.cleanup();q.reject(q.controller.signal.reason);continue;}
    let releaseResources;d.admitting=q;
    try{releaseResources=await this.reserveForeground(q.driver,q.controller.signal);q.controller.signal.throwIfAborted();}
    catch(error){releaseResources?.();d.admitting=null;q.cleanup();q.reject(error);continue;}
    d.admitting=null;
    if(!d.current){
     const state={driver:q.driver,sessionId:q.sessionId,phase:'loading',active:0,idleUntil:Infinity,waiters:[],controller:q.controller,releaseResources};d.current=state;this.onChange();
     try{state.value=await q.driver.load(q.controller.signal);q.controller.signal.throwIfAborted();state.phase='ready';}
     catch(error){try{await q.driver.unload();releaseResources();d.current=null;for(const w of state.waiters)w.resolve();}catch(stopError){state.phase='unload-failed';state.error=stopError.message;for(const w of state.waiters)w.reject(stopError);}q.cleanup();q.reject(error);this.onChange();if(d.current)return;continue;}
    }
    const current=d.current;current.releaseResources=releaseResources;current.driver=q.driver;current.sessionId=q.sessionId;current.sessions??=new Set();if(q.sessionId)current.sessions.add(q.sessionId);current.active=1;current.controller=q.controller;current.phase='answering';this.onChange();let released=false;
    q.resolve({state:current.value,signal:q.controller.signal,release:()=>{if(released)return;released=true;q.cleanup();releaseResources();current.active=0;current.controller=null;current.phase='idle';clearTimeout(current.yieldTimer);current.yieldDeadline=null;if(current.driver.priority==='background'&&d.queue.some(item=>item.driver.priority!=='background'))current.stopRequested=true;current.idleSince=Date.now();current.idleUntil=current.idleSince+this.idleMs;this.onChange();void this.pump(d);}});
    return;
   }
  }finally{d.pumping=false;}
 }
 async unload(key,{force=false}={}){
  const pending=[];
  for(const d of this.devices.values()){
   for(const q of [...d.queue])if(q.driver.key===key){d.queue.splice(d.queue.indexOf(q),1);q.controller.abort(new Error('Model unload requested.'));q.cleanup();q.reject(q.controller.signal.reason);}
   const c=d.current;if(c?.driver.key!==key)continue;
   c.stopRequested=true;clearTimeout(c.yieldTimer);if(c.phase==='loading'||force)c.controller?.abort(new Error('Model unload requested.'));if(force&&c.phase!=='loading')c.active=0;
   pending.push(new Promise((resolve,reject)=>c.waiters.push({resolve,reject})));void this.pump(d);
  }
  await Promise.all(pending);this.onChange();return {unloaded:true};
 }
 async close(){this.closed=true;this.activity.clear();for(const d of this.devices.values())d.admitting?.controller.abort(new Error('Model scheduler is disabled.'));this.turns.clear();const keys=new Set([...this.devices.values()].flatMap(d=>[...(d.current?[d.current.driver.key]:[]),...d.queue.map(q=>q.driver.key)]));await Promise.all([...keys].map(key=>this.unload(key,{force:true})));for(const d of this.devices.values())clearTimeout(d.timer);}
}
