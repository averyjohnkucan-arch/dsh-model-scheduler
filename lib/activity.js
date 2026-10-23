/** Read-only activity tracking: queued, working, and currently streaming tokens. */
export class GenerationActivity {
 constructor({now=Date.now,tokenWindowMs=1500}={}){this.streams=new Map();this.parents=new Map();this.now=now;this.tokenWindowMs=tokenWindowMs;}
 observe(session,event){
  if(session.header?.origin==='subagent'&&session.header.parentSession)this.parents.set(session.id,session.header.parentSession);
  if(event.type==='subagent/catalog'&&event.data?.mode!=='external'&&event.data?.childId)this.parents.set(event.data.childId,session.id);
 }
 open(sessionId){
  if(!sessionId)return {pulse:()=>{},pause:()=>{},close:()=>{}};
  const token=Symbol(),stream={sessionId,lastToken:null};this.streams.set(token,stream);
  return {pulse:()=>{stream.lastToken=this.now();},pause:()=>{stream.lastToken=null;},close:()=>this.streams.delete(token)};
 }
 snapshot(devices,turns=new Set()){
  const direct=new Set(),generating=new Set(),queued=new Set(),owners=new Set();
  for(const d of devices){
   for(const q of d.queue??[])if(q.sessionId)queued.add(q.sessionId);
   const q=d.admitting;
   if(q?.sessionId&&q.driver.priority!=='background'&&!q.controller.signal.aborted)owners.add(q.sessionId);
   const c=d.current;
   if(c?.sessionId&&c.driver.priority!=='background'&&!c.stopRequested&&!c.controller?.signal.aborted&&
      (c.phase==='loading'||c.active||(['idle','waiting-turn'].includes(c.phase)&&turns.has(c.sessionId))))owners.add(c.sessionId);
  }
  for(const stream of this.streams.values()){
   // A provider stream can be waiting for the scheduler. Only admission earns blue.
   if(queued.has(stream.sessionId)&&!owners.has(stream.sessionId))continue;
   direct.add(stream.sessionId);
   if(stream.lastToken!==null&&this.now()-stream.lastToken<this.tokenWindowMs)generating.add(stream.sessionId);
  }
  for(const id of owners)direct.add(id);
  const rollup=ids=>{
   const result=new Set(ids);
   for(const id of ids){const visited=new Set([id]);let parent=this.parents.get(id);
    while(parent&&!visited.has(parent)){result.add(parent);visited.add(parent);parent=this.parents.get(parent);}
   }
   return [...result].sort();
  };
  return {directSessionIds:[...direct].sort(),activeSessionIds:rollup(direct),directGeneratingSessionIds:[...generating].sort(),generatingSessionIds:rollup(generating)};
 }
 clear(){this.streams.clear();this.parents.clear();}
}
