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
