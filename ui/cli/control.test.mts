import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ControlDiscovery} from '../server/control-discovery.mts';
import {HELP,parseArgs,runControl} from './control.mts';

test('the small CLI parser accepts only layout or one closed JSON intent',()=> {
  assert.equal(parseArgs(['--help']).help,true);assert.match(HELP,/not verified authorship/);assert.match(HELP,/never retry/);assert.equal(parseArgs(['layout'],{PI_CODING_AGENT_DIR:'/private/agent'}).stateDir,'/private/agent/ui');assert.deepEqual(parseArgs(['--state-dir','./state','--actor','Agent','--workspace','w','{"action":"notice","text":"Hi"}']).intent,{action:'notice',text:'Hi'});
  for(const args of [[],['--unknown','x','layout'],['--workspace'],['layout','layout'],['{"action":"notice","text":"Hi"}'],['--workspace','w','bad-json'],['--workspace','w','{"action":"input","text":"No"}'],['--actor','one','--actor','two','layout']])assert.throws(()=>parseArgs(args));
});

test('the CLI uses exact origin, credential-free discovery, no redirects and one bounded receipt wait',async t=> {
  const directory=await mkdtemp(join(tmpdir(),'ui-control-cli-')),discovery=new ControlDiscovery();await discovery.publish(directory,'http://127.0.0.1:4318',randomUUID());t.after(async()=>{await discovery.close();await rm(directory,{recursive:true,force:true});});
  const calls:{url:string;init:RequestInit}[]=[];const receipt={requestId:'request',workspaceId:'workspace',actor:'actor',action:'notice',state:'pending',createdAt:new Date().toISOString()};
  const transport:typeof fetch=async(input,init)=> {calls.push({url:String(input),init:init??{}});return new Response(JSON.stringify({ok:true,data:calls.length===1?receipt:{...receipt,state:'applied',appliedRevision:1}}),{status:calls.length===1?202:200});};
  const output=await runControl({stateDir:directory,workspaceId:'workspace',actor:'actor',intent:{action:'notice',text:'Hi'}},transport);assert.equal('state'in output&&output.state,'applied');assert.equal(calls.length,2);assert.equal(calls[0]?.url,'http://127.0.0.1:4318/api/control/requests');assert.equal(calls[1]?.url,'http://127.0.0.1:4318/api/control/requests/request?wait=1');for(const call of calls){assert.equal(call.init.redirect,'error');assert.equal((call.init.headers as Record<string,string>).Origin,'http://127.0.0.1:4318');assert.equal((call.init.headers as Record<string,string>).Authorization,undefined);assert.ok(call.init.signal);assert.equal((call.init.headers as Record<string,string>).Cookie,undefined);}assert.doesNotMatch(JSON.stringify(output),/credential|Bearer/);
});

test('lost POST or receipt transport is unconfirmed and never retries a mutation',async t=> {
  const directory=await mkdtemp(join(tmpdir(),'ui-control-cli-loss-')),discovery=new ControlDiscovery();await discovery.publish(directory,'http://127.0.0.1:4318',randomUUID());t.after(async()=>{await discovery.close();await rm(directory,{recursive:true,force:true});});
  for(const loseReceipt of [false,true]) {let calls=0;const output=await runControl({stateDir:directory,workspaceId:'workspace',intent:{action:'notice',text:'Hi'}},async()=>{calls++;if(loseReceipt&&calls===1)return new Response(JSON.stringify({ok:true,data:{requestId:'request',state:'pending'}}),{status:202});throw new Error('transport');});assert.equal('state'in output&&output.state,'unconfirmed');assert.equal(calls,loseReceipt?2:1);assert.match(JSON.stringify(output),/Read layout/);}
});

test('a known API refusal is not reported as application or retried',async t=> {
  const directory=await mkdtemp(join(tmpdir(),'ui-control-cli-refusal-')),discovery=new ControlDiscovery();await discovery.publish(directory,'http://127.0.0.1:4318',randomUUID());t.after(async()=>{await discovery.close();await rm(directory,{recursive:true,force:true});});let calls=0;
  await assert.rejects(()=>runControl({stateDir:directory,workspaceId:'workspace',intent:{action:'notice',text:'Hi'}},async()=>{calls++;return new Response(JSON.stringify({ok:false,error:{code:'control_disabled',message:'Do not echo server text'}}),{status:403});}),/refused this request \(control_disabled\)/);assert.equal(calls,1);
});
