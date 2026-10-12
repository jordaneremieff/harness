import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {LocalHttp,type HttpBackend} from './http.mts';
import {Journal} from './journal.mts';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {AgentError} from '../agents/client.mts';
import {retainedReaderPath} from './agent-start.mts';
import {errorView} from './errors.mts';
import {dispatchAgent} from './routes-agent.mts';
import type {Registry} from './registry.mts';
import type {RequestContext} from './http.mts';

const ID='00000000-0000-4000-8000-000000000001:2';
test('HTTP loss cancels a read and normal response closure does not cancel it',{timeout:2000},async t=> {
  for(const abort of [false,true]) {
    let captured:AbortSignal|undefined;let started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    const backend={journal:new Journal(),dispatch:async(context:RequestContext)=> {
      captured=context.signal;started();
      if(abort) await new Promise<void>(resolve=>{context.signal?.addEventListener('abort',()=>resolve(),{once:true});});
      return {};
    }} as unknown as HttpBackend;
    const http=new LocalHttp(backend,new Map());t.after(()=>{http.auth.close();http.server.removeAllListeners();});
    const request=Object.assign(new EventEmitter(),{headers:{}});
    const response=Object.assign(new EventEmitter(),{writableEnded:false,writeHead:()=>{},end:()=>{response.writableEnded=true;response.emit('close');}});
    const dispatcher=http as unknown as {dispatchRequest(request:IncomingMessage,response:ServerResponse,url:URL,method:string,parts:string[],body:Record<string,unknown>,session:string):Promise<void>};
    const pending=dispatcher.dispatchRequest(request as IncomingMessage,response as unknown as ServerResponse,new URL('http://localhost/api'),'GET',['api','agents',ID,'history'],{},'fixture');
    await ready;if(abort) response.emit('close');await pending;
    assert.equal(captured?.aborted,abort);assert.equal(request.listenerCount('aborted'),0);assert.equal(response.listenerCount('close'),0);
  }
});
test('server resources select one canonical reader without an installed Pi executable or target metadata',async t=> {
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-reader-binding-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const agentDir=join(root,'global');const owner=join(root,'owner');const slice=join(owner,'extensions','agent');
  await Promise.all([mkdir(agentDir),mkdir(slice,{recursive:true})]);
  const entry=join(slice,'index.ts'),reader=join(slice,'retained-read.ts');
  await Promise.all([writeFile(entry,'// inert configured entry'),writeFile(reader,'// inert reader'),
    writeFile(join(owner,'package.json'),JSON.stringify({name:'harness',pi:{extensions:['./extensions']}})),
    writeFile(join(agentDir,'settings.json'),JSON.stringify({extensions:[entry]}))]);
  assert.equal(await retainedReaderPath(agentDir),reader);
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({extensions:[entry,entry]}));
  await assert.rejects(retainedReaderPath(agentDir),{code:'host_unavailable'});
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({extensions:[entry]}));await rm(reader);
  await assert.rejects(retainedReaderPath(agentDir),{code:'host_unavailable'});
});
test('retained refusal preserves read retry policy rather than mutation uncertainty',()=> {
  assert.deepEqual(errorView(new AgentError('source_changed','Source changed',false,true)),{code:'source_changed',message:'Source changed',retry:'read'});
  assert.deepEqual(errorView(new AgentError('not_found','No retained conversation')),{code:'not_found',message:'No retained conversation',retry:'none'});
});
test('history GET preserves empty confirmation, page anchors and cancellation without preparation or Start',async()=> {
  const calls:unknown[][]=[];const controller=new AbortController();
  const registry={agents:{history:async(...args:unknown[])=>{calls.push(args);return {entries:[],partial:false,revision:'retained-empty',nextBefore:null,coverage:{complete:true,entries:0,bytes:0,hiddenExcluded:0,entryLimitReached:false,byteLimitReached:false}};},
    prepare:()=>{throw Error('No preparation');},reconnect:()=>{throw Error('No reconnect');}},
    startAgent:()=>{throw Error('No implicit start');}} as unknown as Registry;
  const context:RequestContext={method:'GET',parts:['api','agents',ID,'history'],body:{},session:'fixture',url:new URL('http://localhost/api?before=9&limit=2'),signal:controller.signal};
  const result=await dispatchAgent(registry,context) as {entries:unknown[];target:unknown;revision:string;nextBefore:number|null};
  assert.deepEqual(result.entries,[]);assert.equal(result.revision,'retained-empty');assert.equal(result.nextBefore,null);
  assert.deepEqual(result.target,{kind:'agent',identity:ID});assert.deepEqual(calls,[[ID,{limit:2,before:9},controller.signal]]);
});
test('history binds communication storage while preserving inherited conversation origins',async()=> {
  const storageId=ID.split(':')[0];
  const value={format:'agent.communication/1',kind:'report',sender:{identity:'00000000-0000-4000-8000-000000000009'},body:{text:'Retained report',complete:true,redacted:false},recordedAt:1,metadata:{sourceId:'report:source',requestId:'report:request'}};
  for(const valid of [true,false]) {
    const communication={state:'ready',recordEntryId:'8',target:{mode:'input',storageId:valid?storageId:'00000000-0000-4000-8000-000000000099',conversationId:1,entryId:'7',submissionId:3,requestId:'native'},value};
    const registry={agents:{history:async()=>({entries:[{id:'7',kind:'pi.user',model:[{role:'user',content:'Retained report'}],communication}],partial:false,revision:'retained',nextBefore:null,coverage:{complete:true,entries:1,bytes:1,hiddenExcluded:1,entryLimitReached:false,byteLimitReached:false}})}} as unknown as Registry;
    const context:RequestContext={method:'GET',parts:['api','agents',ID,'history'],body:{},session:'fixture',url:new URL('http://localhost/api')};
    const page=await dispatchAgent(registry,context) as {entries:{messages:{communication:{state:string}}[]}[]};
    assert.equal(page.entries[0].messages[0].communication.state,valid?'ready':'unavailable');
  }
});
test('missing or unreadable source has no successful empty route response',async()=> {
  for(const code of ['not_found','source_unreadable','source_changed']) {
    const registry={agents:{history:async()=>{throw new AgentError(code,'Retained source unavailable',false,code==='source_changed');}}} as unknown as Registry;
    const context:RequestContext={method:'GET',parts:['api','agents',ID,'history'],body:{},session:'fixture',url:new URL('http://localhost/api')};
    await assert.rejects(dispatchAgent(registry,context),{code});
  }
});
