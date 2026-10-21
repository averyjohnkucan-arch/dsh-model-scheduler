import test from 'node:test';import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {ModelScheduler} from '../lib/scheduler.js';
test('optional public Cordis service attaches and detaches provider without direct engine coupling',async()=>{
 const ctx=new Context(),scheduler=new ModelScheduler(),events=[];
 const provider=ctx.plugin({name:'provider-fixture',apply(scope){scope.inject(['modelScheduler'],active=>{const service=active.get('modelScheduler');active.effect(()=>{events.push('attached');const remove=service.registerProvider('fixture',()=>[{key:'fixture:model',name:'Model',gpu:0}]);return()=>{remove();events.push('detached');};});});}});
 await provider;assert.deepEqual(events,[]);
 const remove=ctx.provide('modelScheduler',scheduler);await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(scheduler.models(),[{key:'fixture:model',name:'Model',gpu:0}]);
 await remove();assert.deepEqual(scheduler.models(),[]);assert.deepEqual(events,['attached','detached']);await ctx.fiber.dispose();
});

test('scheduler plugin tracks public turn events and releases a waiting model at turn end',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'scheduler-hooks-')),prior=process.env.DSH_HOME;process.env.DSH_HOME=root;
 const ctx=new Context();
 try{
  ctx.provide('webServer',{register:()=>()=>{},getOrigin:()=> 'http://127.0.0.1:3080'});
  ctx.provide('llm',{});
  const {apply}=await import('../index.js');
  await ctx.plugin({name:'scheduler-hooks',apply:scope=>apply(scope,{idleSeconds:300,switchSeconds:30})});
  const scheduler=ctx.get('modelScheduler'),events=[];
  const driver=key=>({key,name:key,gpu:0,fingerprint:key,load:async()=>events.push('load '+key),unload:async()=>events.push('unload '+key)});
  ctx.emit('session/event',{id:'s'},{type:'turn/start'});
  (await scheduler.withSession('s',()=>scheduler.acquire(driver('a')))).release();
  const pending=scheduler.acquire(driver('b'));await new Promise(r=>setTimeout(r,5));assert.deepEqual(events,['load a']);
  ctx.emit('session/event',{id:'s'},{type:'turn/end'});
  (await pending).release();assert.deepEqual(events,['load a','unload a','load b']);
 }finally{await ctx.fiber.dispose();if(prior===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=prior;await rm(root,{recursive:true,force:true});}
});
