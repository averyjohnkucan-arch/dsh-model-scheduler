import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import z from '@deepseek-ai/schemastery';
import { ModelScheduler } from './lib/scheduler.js';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
export const inject=['webServer'];
export const Config=z.object({idleSeconds:z.number().min(0).max(86400).default(30)});
export async function apply(ctx,config){
 const root=join(process.env.DSH_HOME||join(homedir(),'.dsh'),'dsh-model-scheduler');await mkdir(root,{recursive:true,mode:0o700});
 let idleSeconds=config.idleSeconds;try{const saved=JSON.parse(await readFile(join(root,'settings.json'),'utf8'));if(Number.isFinite(saved.idleSeconds)&&saved.idleSeconds>=0&&saved.idleSeconds<=86400)idleSeconds=saved.idleSeconds;}catch(e){if(e.code!=='ENOENT')throw e;}
 const scheduler=new ModelScheduler({idleMs:idleSeconds*1000}),token=randomBytes(32).toString('hex');
 ctx.provide('modelScheduler',scheduler);
 ctx.on('webserver/index-inject',table=>table.push({kind:'global',name:'__DSH_MODEL_SCHEDULER__',value:{path:'/plugins/dsh-model-scheduler/action',token}}));
 let writeQueue=Promise.resolve(),telemetryAt=0,telemetryPromise;
 async function telemetry(){if(Date.now()-telemetryAt<5000)return;if(telemetryPromise)return telemetryPromise;telemetryPromise=promisify(execFile)('nvidia-smi',['--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory','--format=csv,noheader,nounits'],{timeout:2000,maxBuffer:65536,windowsHide:true}).then(({stdout})=>{scheduler.gpuProcesses=stdout.trim().split('\n').filter(Boolean).map(line=>{const parts=line.split(',').map(x=>x.trim());return {gpu:parts[0],pid:Number(parts[1]),name:parts.slice(2,-1).join(','),memoryMiB:Number(parts.at(-1))};});scheduler.telemetryError=null;}).catch(e=>{scheduler.telemetryError=e.message;scheduler.gpuProcesses=[];}).finally(()=>{telemetryAt=Date.now();telemetryPromise=null;});return telemetryPromise;}

 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/plugins/dsh-model-scheduler/action',handler:async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
  const a=Buffer.from((req.headers.authorization||'').replace(/^Bearer /,'')),b=Buffer.from(token);
  if(a.length!==b.length||!timingSafeEqual(a,b)){res.writeHead(401);res.end(JSON.stringify({error:'Owner capability required.'}));return;}
  if(req.method!=='POST'||!String(req.headers['content-type']).startsWith('application/json')){res.writeHead(405);res.end('{}');return;}
  if(req.headers.origin&&req.headers.origin!==ctx.webServer.getOrigin()){res.writeHead(403);res.end('{}');return;}
  try{let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)throw new Error('Request too large.');body+=chunk;}const {action,payload={}}=JSON.parse(body);let result;
   if(action==='list'){await telemetry();result=scheduler.status();}
   else if(action==='configure'){scheduler.configure(Number(payload.idleSeconds));writeQueue=writeQueue.catch(()=>{}).then(async()=>{const path=join(root,'settings.json'),tmp=path+'.tmp';await writeFile(tmp,JSON.stringify({idleSeconds:scheduler.idleMs/1000}),{mode:0o600});await rename(tmp,path);});await writeQueue;result=scheduler.status();}
   else if(action==='load')result=await scheduler.load(payload.key);
   else if(action==='unload')result=await scheduler.unload(payload.key,{force:!!payload.force});
   else throw new Error('Unknown scheduler operation.');res.end(JSON.stringify({result}));
  }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}
 }}));
 ctx.effect(()=>()=>scheduler.close());
}
