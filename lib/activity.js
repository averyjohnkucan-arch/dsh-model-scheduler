/** Read-only activity tracking. A running turn or queued lease is not generation. */
export class GenerationActivity {
 constructor(){this.streams=new Map();this.parents=new Map();}
 observe(session,event){
  if(session.header?.origin==='subagent'&&session.header.parentSession)this.parents.set(session.id,session.header.parentSession);
  if(event.type==='subagent/catalog'&&event.data?.mode!=='external'&&event.data?.childId)this.parents.set(event.data.childId,session.id);
 }
 begin(sessionId){
  if(!sessionId)return()=>{};
  const token=Symbol();this.streams.set(token,sessionId);
  return()=>this.streams.delete(token);
 }
 snapshot(devices){
  const direct=new Set(this.streams.values());
  for(const d of devices){const c=d.current;
   if(c?.active&&c.phase==='answering'&&c.driver.priority!=='background'&&!c.controller?.signal.aborted&&c.sessionId)direct.add(c.sessionId);
  }
  const active=new Set(direct);
  for(const id of direct){const visited=new Set([id]);let parent=this.parents.get(id);
   while(parent&&!visited.has(parent)){active.add(parent);visited.add(parent);parent=this.parents.get(parent);}
  }
  return {directSessionIds:[...direct].sort(),activeSessionIds:[...active].sort()};
 }
 clear(){this.streams.clear();this.parents.clear();}
}
