import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const parts=await Promise.all(['client/settings.js','client/activity.js','client/subagent-views.js'].map(path=>readFile(new URL(path,root),'utf8')));
await writeFile(new URL('client.js',root),parts[0].replace('/* GENERATION_UI */',parts.slice(1).join('\n')));
