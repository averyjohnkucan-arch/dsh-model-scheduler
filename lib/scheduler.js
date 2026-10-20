/** FIFO admission and idle unloading. Drivers own their servers; no PID guessing. */
export class ModelScheduler {
 constructor({idleMs=30000,yieldMs=30000,onChange=()=>{}}={}){this.idleMs=idleMs;this.yieldMs=yieldMs;this.onChange=onChange;this.providers=new Map();this.devices=new Map();this.closed=false;}
 registerProvider(id,list){if(this.providers.has(id))throw new Error('Scheduling provider already registered.');this.providers.set(id,list);this.onChange();return()=>{this.providers.delete(id);this.onChange();};}
 models(){return [...this.providers.values()].flatMap(list=>list()).map(({key,name,gpu})=>({key,name,gpu}));}
 async load(key,signal){const driver=[...this.providers.values()].flatMap(list=>list()).find(d=>d.key===key);if(!driver)throw new Error('No registered engine owns this model.');const lease=await this.acquire(driver,signal);lease.release();return {loaded:true};}
 device(gpu){const key=String(gpu);if(!this.devices.has(key))this.devices.set(key,{gpu:key,queue:[],current:null,pumping:false,timer:null});return this.devices.get(key);}
 status(){return {idleSeconds:this.idleMs/1000,models:this.models(),devices:[...this.devices.values()].map(d=>({gpu:d.gpu,model:d.current?.driver.name??null,key:d.current?.driver.key??null,priority:d.current?.driver.priority??'interactive',yieldDeadline:d.current?.yieldDeadline??null,phase:d.current?.phase??'unloaded',active:d.current?.active??0,idleUntil:d.current?.idleUntil??null,error:d.current?.error??null,queue:d.queue.map(q=>({key:q.driver.key,name:q.driver.name}))}))};}
 configure(seconds){if(!Number.isFinite(seconds)||seconds<0||seconds>86400)throw new Error('Idle timeout must be between 0 and 86400 seconds.');this.idleMs=seconds*1000;for(const d of this.devices.values()){if(d.current&&!d.current.active)d.current.idleUntil=Date.now()+this.idleMs;void this.pump(d);}this.onChange();}
 acquire(driver,signal){
  if(this.closed)return Promise.reject(new Error('Model scheduler is disabled.'));signal?.throwIfAborted();
  const d=this.device(driver.gpu),controller=new AbortController();
  return new Promise((resolve,reject)=>{
   const q={driver,controller,resolve,reject,settled:false,cleanup:()=>signal?.removeEventListener('abort',abort)};
   const abort=()=>{controller.abort(signal.reason);const i=d.queue.indexOf(q);if(i>=0){d.queue.splice(i,1);q.cleanup();reject(signal.reason??new Error('Cancelled'));}void this.pump(d);};
   signal?.addEventListener('abort',abort,{once:true});if(driver.priority==='background')d.queue.push(q);else{const index=d.queue.findIndex(item=>item.driver.priority==='background');if(index<0)d.queue.push(q);else d.queue.splice(index,0,q);}this.onChange();void this.pump(d);
  });
 }
 arm(d,ms){clearTimeout(d.timer);d.timer=setTimeout(()=>{d.timer=null;void this.pump(d);},Math.max(1,ms));if(!d.queue.length)d.timer.unref?.();}
 async pump(d){
  if(d.pumping)return;d.pumping=true;clearTimeout(d.timer);d.timer=null;
  try{
   while(true){
    const c=d.current,q=d.queue[0];
    if(c?.active){
     if(c.driver.priority==='background'&&q&&q.driver.priority!=='background'){
      if(!c.yieldDeadline){c.yieldDeadline=Date.now()+this.yieldMs;c.yieldTimer=setTimeout(()=>{c.stopRequested=true;c.controller?.abort(new Error('Yield GPU to waiting chat; retry this document on CPU.'));c.active=0;void this.pump(d);},this.yieldMs);this.onChange();}
     }else if(c.yieldDeadline){clearTimeout(c.yieldTimer);c.yieldDeadline=null;}
     return;
    }
    if(c){
     const reuse=q&&q.driver.key===c.driver.key&&q.driver.fingerprint===c.driver.fingerprint&&!c.stopRequested;
     if(!reuse){
      if(!c.stopRequested&&Date.now()<c.idleUntil){this.arm(d,c.idleUntil-Date.now());return;}
      if(c.driver.busy?.()&&!c.stopRequested){this.arm(d,500);return;}
      c.phase='unloading';this.onChange();
      try{await c.driver.unload();d.current=null;for(const w of c.waiters)w.resolve();}
      catch(error){c.phase='unload-failed';c.error=error.message;for(const w of c.waiters)w.reject(error);c.waiters=[];for(const waiting of d.queue.splice(0)){waiting.cleanup();waiting.reject(error);}return;}
      this.onChange();continue;
     }
    }
    if(!q)return;
    d.queue.shift();
    if(q.controller.signal.aborted){q.cleanup();q.reject(q.controller.signal.reason);continue;}
    if(!d.current){
     const state={driver:q.driver,phase:'loading',active:0,idleUntil:Infinity,waiters:[],controller:q.controller};d.current=state;this.onChange();
     try{state.value=await q.driver.load(q.controller.signal);q.controller.signal.throwIfAborted();state.phase='ready';}
     catch(error){try{await q.driver.unload();d.current=null;for(const w of state.waiters)w.resolve();}catch(stopError){state.phase='unload-failed';state.error=stopError.message;for(const w of state.waiters)w.reject(stopError);}q.cleanup();q.reject(error);this.onChange();if(d.current)return;continue;}
    }
    const current=d.current;current.driver=q.driver;current.active=1;current.controller=q.controller;current.phase='answering';this.onChange();let released=false;
    q.resolve({state:current.value,signal:q.controller.signal,release:()=>{if(released)return;released=true;q.cleanup();current.active=0;current.controller=null;current.phase='idle';clearTimeout(current.yieldTimer);current.yieldDeadline=null;if(current.driver.priority==='background'&&d.queue.some(item=>item.driver.priority!=='background'))current.stopRequested=true;current.idleUntil=Date.now()+this.idleMs;this.onChange();void this.pump(d);}});
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
 async close(){this.closed=true;const keys=new Set([...this.devices.values()].flatMap(d=>[...(d.current?[d.current.driver.key]:[]),...d.queue.map(q=>q.driver.key)]));await Promise.all([...keys].map(key=>this.unload(key,{force:true})));for(const d of this.devices.values())clearTimeout(d.timer);}
}
