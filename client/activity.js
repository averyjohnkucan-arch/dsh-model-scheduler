function installGenerationIndicators(ctx, require) {
 const {useSyncExternalStore} = React;
 const {StateDot} = require('@deepseek-ai/dsh-client-ui-primitives');
 let snapshot = {directSessionIds:[],activeSessionIds:[],directGeneratingSessionIds:[],generatingSessionIds:[]}, serial='', timer, controller, stopped=false;
 const listeners=new Set();
 const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
 const getSnapshot=()=>snapshot;
 function publish(next){
  const key=JSON.stringify(next);
  if(key===serial)return;
  serial=key;snapshot=next;for(const listener of listeners)listener();
 }
 async function refresh(){
  if(stopped)return;
  if(document.visibilityState==='hidden'){timer=setTimeout(refresh,1500);return;}
  controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),3000);
  try{
   const cfg=window.__DSH_MODEL_SCHEDULER__;
   if(!cfg)throw Error('Scheduler unavailable');
   const response=await fetch(cfg.path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.token},body:JSON.stringify({action:'activity'}),signal:controller.signal});
   if(!response.ok)throw Error('Scheduler unavailable');
   const {result}=await response.json();
   if(!Array.isArray(result?.activeSessionIds)||!Array.isArray(result?.directSessionIds))throw Error('Invalid activity');
   if(!stopped)publish(result);
  }catch{if(!stopped)publish({directSessionIds:[],activeSessionIds:[],directGeneratingSessionIds:[],generatingSessionIds:[]});}
  finally{clearTimeout(timeout);controller=null;if(!stopped)timer=setTimeout(refresh,500);}
 }
 ctx.effect(()=>{refresh();return()=>{stopped=true;clearTimeout(timer);controller?.abort();listeners.clear();};});

 // Only the rotation is animated: a constant-speed compositor transform, with
 // no stepped dash animation. Keep the track dim and the arc unmistakably blue.
 const spinCSS=(selector,fast)=>`${selector}{color:#579bff!important}${selector}>g{animation:dsh-generation-spin ${fast?'.65s':'1.5s'} linear infinite!important;transform-origin:12px 12px;transform-box:view-box}${selector} circle{animation:none!important;stroke:currentColor!important}${selector} circle:first-child{opacity:.22}${selector} circle:last-child{opacity:1;stroke-dasharray:20 40;stroke-dashoffset:0}`;
 ctx.effect(()=>{
  const style=document.createElement('style');style.dataset.plugin='dsh-model-scheduler';
  style.textContent=`@keyframes dsh-generation-spin{to{transform:rotate(360deg)}}${spinCSS('.dsh-generation-working[data-state="ongoing"]',false)}${spinCSS('.dsh-generation-active[data-state="ongoing"]',true)}@media(prefers-reduced-motion:reduce){.dsh-generation-active[data-state="ongoing"]>g,.dsh-generation-working[data-state="ongoing"]>g{animation:none!important}}`;
  document.head.appendChild(style);return()=>style.remove();
 });
 function useActive(useSessions){
  const state=useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
  const catalog=useSessions(s=>s);
  // Client catalog fills lineage for children already running when the plugin
  // was enabled, and propagates activity through nested subagent trees.
  const parents=new Map();
  for(const [id,summary] of Object.entries(catalog.byId??{}))if(summary.origin==='subagent'&&summary.parentId)parents.set(id,summary.parentId);
  for(const [parent,projection] of Object.entries(catalog.projectionsBySession??{}))for(const entry of projection.values?.subagentCatalog??[])if(entry.mode!=='external')parents.set(entry.id,parent);
  const rollup=(all,direct)=>{const result=new Set(all??[]);for(const id of direct??[]){const seen=new Set([id]);let parent=parents.get(id);while(parent&&!seen.has(parent)){result.add(parent);seen.add(parent);parent=parents.get(parent);}}return result;};
  return {working:rollup(state.activeSessionIds,state.directSessionIds),generating:rollup(state.generatingSessionIds,state.directGeneratingSessionIds)};
 }
 function RowActivity({sessionId,useSessions}){
  const activity=useActive(useSessions),fast=activity.generating.has(sessionId);
  if(!activity.working.has(sessionId))return null;
  const selector=`[data-row-key="${CSS.escape('session:'+sessionId)}"]>span:first-child svg[data-state="ongoing"]`;
  return h(React.Fragment,null,h('style',null,spinCSS(selector,fast)+`@media(prefers-reduced-motion:reduce){${selector}>g{animation:none!important}}`),h('span',{style:{position:'absolute',width:1,height:1,overflow:'hidden',clipPath:'inset(50%)'}},fast?'Generating tokens':'Working'));
 }
 ctx.slots.inject('sidebar.workspaces.session.row.action',()=>ctx.slots.register({name:'sidebar.workspaces.session.row.action',id:'dsh-generation-activity',order:1000},RowActivity));

 const ActivityContext=React.createContext({working:new Set(),generating:new Set()});
 function GenerationDot({sessionId,sessionIds=[],state}){
  const active=React.useContext(ActivityContext);
  const ids=[sessionId,...sessionIds],generating=ids.some(id=>active.generating.has(id)),working=ids.some(id=>active.working.has(id));
  return h(StateDot,{state,className:generating?'dsh-generation-active':working?'dsh-generation-working':undefined});
 }
 const views=createSubagentViews(require,GenerationDot);
 // Supported slot priority shadowing keeps all changes in this plugin. The
 // upstream registrations still own navigation injection, locale and lifetime.
 function shadow(name,id,View){
  ctx.slots.inject(name,()=>{
   let source,dispose,updating=false;
   const reconcile=()=>{
    if(updating)return;updating=true;
    try{
     const next=ctx.slots.entries(name).find(entry=>entry.registrant==='@deepseek-ai/dsh-client-ui-subagent'&&(id===undefined||entry.options.id===id));
     if(next===source)return;
     dispose?.();dispose=undefined;source=next;if(!source)return;
     function ActivityView(props){return h(ActivityContext.Provider,{value:useActive(props.useSessions)},h(View,props));}
     dispose=ctx.slots.register({name,...source.options,priority:(source.options.priority??0)-1,inject:source.inject,locale:source.locale},ActivityView);
    }finally{updating=false;}
   };
   const unsubscribe=ctx.slots.subscribe(name,reconcile);reconcile();
   return()=>{unsubscribe();dispose?.();};
  });
 }
 shadow('conversation.session.header.actions','subagent-catalog',views.SubagentCatalogAction);
 shadow('conversation.session.header.lineage',undefined,views.SubagentHeaderLineage);
}
