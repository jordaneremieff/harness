import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ManagementService} from './service.mts';
import {Authentication} from './auth.mts';
import {RUNTIME_PROTOCOL,type RuntimeOperation} from './contract.mts';
import type {ModelRuntime} from '@earendil-works/pi-coding-agent';
import type {AuthInteraction} from '@earendil-works/pi-ai';
import type {dispatchEvolutionOperation} from './evolution.mts';

const wrap=(request:RuntimeOperation)=>({protocol:RUNTIME_PROTOCOL,request});
test('a long maintenance command does not block account responses, configuration or creation',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rs-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let finish!:(value:Awaited<ReturnType<typeof dispatchEvolutionOperation>>)=>void,answered=false;let promptStarted!:()=>void;const started=new Promise<void>(resolve=>{promptStarted=resolve;});
  const authentication=new Authentication(async()=>({login:async(_provider:string,_type:string,interaction:AuthInteraction)=>{const answer=interaction.prompt({type:'secret',message:'Key'});promptStarted();await answer;answered=true;return {type:'api_key'};}} as unknown as ModelRuntime));
  const service=new ManagementService({agentDir:root,stateDir:join(root,'state'),cwd:root,sourceRoot:root,uiStateDir:join(root,'ui'),env:{}},{authentication,evolution:async()=>new Promise(resolve=>{finish=resolve;})});t.after(()=>service.close());
  service.domains.sessions.create=async()=>({protocol:1,state:'completed',identity:'native-test',root,name:null,sourceRoot:root,packageDir:root});
  const held=service.call(wrap({operation:'upstream.update'}));
  const conflict=await service.call(wrap({operation:'evolution.sync',sourceOnly:true}));assert.equal(conflict.ok,false);if(!conflict.ok)assert.equal(conflict.error.code,'busy');
  const login=await service.call(wrap({operation:'auth.login',provider:'fake',type:'api_key'}));assert.equal(login.ok,true);await started;
  const flowId=(login as {ok:true;value:{flowId:string}}).value.flowId;
  const flow=authentication.poll(flowId);assert.ok(flow.prompt);
  assert.equal((await service.call(wrap({operation:'auth.respond',flowId,promptId:flow.prompt.id,value:'synthetic'}))).ok,true);
  const inspected=await service.domains.configuration.inspect('pi');
  assert.equal((await service.call(wrap({operation:'config.apply',target:'pi',values:{defaultModel:'synthetic'},expectedDigest:inspected.digest}))).ok,true);
  assert.equal((await service.call(wrap({operation:'sessions.create',requestId:'independent',cwd:root}))).ok,true);
  await Promise.resolve();assert.equal(answered,true);finish({ok:true,command:[],exitCode:0,stdout:'',stderr:'',truncated:false,timedOut:false,uncertain:false});assert.equal((await held).ok,true);
});
test('runtime protocol rejects unsupported commands and incomplete domain requests',async()=>{
  const service=new ManagementService({agentDir:'/unused',stateDir:'/unused/runtime',cwd:'/unused',sourceRoot:'/unused',uiStateDir:'/unused/ui'});
  await Promise.all([
    service.call({protocol:RUNTIME_PROTOCOL,request:{operation:'shell',command:'no'}}).then(result=>assert.equal(result.ok,false)),
    service.call({protocol:RUNTIME_PROTOCOL,request:{operation:'auth.respond',flowId:'x'}}).then(result=>assert.equal(result.ok,false)),
  ]);
});
