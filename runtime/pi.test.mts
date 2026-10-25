import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PiManagement} from './pi.mts';
import {Authentication} from './auth.mts';
import type {AuthInteraction} from '@earendil-works/pi-ai';
import type {ModelRuntime} from '@earendil-works/pi-coding-agent';

test('resource inspection resolves configured paths without extension execution or missing-package installation',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rp-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const marker=join(root,'executed'),extension=join(root,'extension.ts');
  await writeFile(extension,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');export default function(){};`);
  await writeFile(join(root,'settings.json'),JSON.stringify({extensions:[extension],packages:['npm:runtime-inspection-missing-fixture@0.0.0']}));
  await mkdir(join(root,'project'));
  const pi=new PiManagement(root),result=await pi.resources(join(root,'project'));
  assert.equal(result.extensionExecution,false);assert.equal(result.missingPackages,'skipped');assert.ok(result.extensions.some(entry=>entry.path===extension));await assert.rejects(access(marker));
});
test('login uses upstream interaction and never returns the resulting credential',async t=>{
  let promptReady!:()=>void;const ready=new Promise<void>(resolve=>{promptReady=resolve;});let finished!:()=>void;const completed=new Promise<void>(resolve=>{finished=resolve;});
  const auth=new Authentication(async()=>({login:async(_provider:string,_type:string,interaction:AuthInteraction)=>{const result=interaction.prompt({type:'secret',message:'Enter key'});promptReady();assert.equal(await result,'synthetic-secret');finished();return {type:'api_key',key:'synthetic-secret'};}} as unknown as ModelRuntime));t.after(()=>auth.close());
  const started=await auth.start('fixture','api_key');await ready;const pending=auth.poll(started.flowId);assert.ok(pending.prompt);await assert.rejects(auth.logout('fixture'),/Cancel the active login/);assert.throws(()=>auth.respond(started.flowId,'stale','synthetic-secret'),/changed/);
  auth.respond(started.flowId,pending.prompt.id,'synthetic-secret');await completed;await Promise.resolve();assert.equal(JSON.stringify(auth.poll(started.flowId)).includes('synthetic-secret'),false);
});
