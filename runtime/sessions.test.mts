import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionSources,type NativeSource} from './sessions.mts';

async function sourceFixture(root:string,name:string) {
  const source=join(root,name),packageDir=join(source,'node_modules','@earendil-works','pi-coding-agent');await mkdir(join(packageDir,'dist'),{recursive:true});
  await writeFile(join(packageDir,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',type:'module',exports:{'.':{import:'./dist/index.js'}}}));await writeFile(join(packageDir,'dist','index.js'),'export {};');
  await mkdir(join(source,'extensions','agent'),{recursive:true});await writeFile(join(source,'extensions','agent','create-conversation.ts'),'export {};');await writeFile(join(source,'extensions','agent','namespace-recovery.ts'),'export {};');
  return {source,packageDir};
}
test('source placement survives management replacement and content-bound creation does not repeat effects',async t=>{
  const root=await realpath(await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rn-')));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;const fixture=await sourceFixture(root,'first');
  const options={stateDir:root,sourceRoot:fixture.source,agentDir:join(root,'agent')};
  const sources=new SessionSources(options,async(_exe,args)=>{calls++;const metadata=JSON.parse(args[1]);assert.notEqual(metadata.root,join(options.agentDir,'agent-sessions'));assert.match(metadata.root,/sessions/);assert.equal(metadata.packageDir,fixture.packageDir);return {exitCode:0,uncertain:false,value:{protocol:1,state:'completed',identity:'native-id',name:'Example',sourceRoot:fixture.source,root:metadata.root,packageDir:metadata.packageDir}};});
  const request={operation:'sessions.create' as const,requestId:'stable-request',cwd:root,name:'Example'};
  const created=await sources.create(request);assert.equal(created.identity,'native-id');assert.equal(calls,1);
  const reopened=new SessionSources(options,async()=>{throw new Error('No replay');});
  assert.equal((await reopened.create(request)).identity,'native-id');assert.equal((await reopened.source('native-id:2')).state,'bound');
  assert.equal((await reopened.source('other-id')).state,'absent');assert.equal((await reopened.list()).roots[0].root,created.root);
  await assert.rejects(reopened.create({...request,name:'Different'}),/different content/);
});
test('uncertain native creation remains inspectable and never replays after restart',async t=>{
  const root=await realpath(await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rn-')));t.after(()=>rm(root,{recursive:true,force:true}));const fixture=await sourceFixture(root,'first'),options={stateDir:root,sourceRoot:fixture.source,agentDir:root};let calls=0;
  const sources=new SessionSources(options,async()=>{calls++;return {exitCode:null,uncertain:true,value:null};});
  const request={operation:'sessions.create' as const,requestId:'uncertain',cwd:root};await assert.rejects(sources.create(request),/did not confirm/);
  const reopened=new SessionSources(options,async()=>{calls++;throw new Error('Unexpected replay');});await assert.rejects(reopened.create(request),/unconfirmed/);assert.equal(calls,1);assert.equal((await reopened.list()).complete,true);
});
test('retained source generations keep distinct dependency installations and expose earlier routes to the Agent',async t=>{
  const root=await realpath(await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rn-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const first=await sourceFixture(root,'first'),second=await sourceFixture(root,'second'),ordinary=await sourceFixture(root,'ordinary');
  const existingSource:NativeSource={root:join(root,'ordinary-root'),sourceRoot:ordinary.source,packageDir:ordinary.packageDir};
  const options={stateDir:root,agentDir:root,existingSource};
  const initial=new SessionSources({...options,sourceRoot:first.source});const firstPlacement=(await initial.list()).roots[0];
  const changedRuntimeOptions={...options,sourceRoot:second.source,piExecutable:join(root,'changed-active-pi')};
  const next=new SessionSources(changedRuntimeOptions,async(_exe,args)=>{
    const metadata=JSON.parse(args[1]);assert.equal(metadata.packageDir,second.packageDir);assert.deepEqual(new Map(metadata.existingSources.map((item:NativeSource)=>[item.root,item])),new Map([{root:firstPlacement.root,sourceRoot:first.source,packageDir:first.packageDir},existingSource].map(item=>[item.root,item])));
    return {exitCode:0,uncertain:false,value:{protocol:1,state:'completed',identity:'reused-expert',name:'Expert',root:firstPlacement.root,sourceRoot:first.source,packageDir:first.packageDir}};
  });
  const selected=await next.create({operation:'sessions.create',requestId:'selected-route',cwd:root});assert.equal(selected.packageDir,first.packageDir);assert.equal(selected.root,firstPlacement.root);
  const roots=(await next.list()).roots;assert.equal(roots.find(item=>item.sourceRoot===first.source)?.packageDir,first.packageDir);assert.equal(roots.find(item=>item.sourceRoot===second.source)?.packageDir,second.packageDir);
  assert.deepEqual(await next.source('reused-expert:2'),{state:'bound',root:firstPlacement.root,sourceRoot:first.source,packageDir:first.packageDir});
});
