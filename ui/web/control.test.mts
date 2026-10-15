import assert from 'node:assert/strict';
import test from 'node:test';
import type {ControlAck, ControlRequest} from '../shared/control.ts';
import {BrowserControl, ControlRefusal, controlLayout, controlPaneBox, type ControlPage} from './control.ts';
import {createPaneLayout, paneLeaves, validPaneLayout} from './pane-layout.ts';
import {tabKey} from './tabs.ts';
const space = {width:1600,height:1000,divider:4};
const file = {kind:'file',rootId:'root',path:'readme.md'} as const;
const primary = {kind:'primary'} as const;
test('show, split, resize, swap and focus preserve all tabs and produce only complete layouts',()=> {
  const original = createPaneLayout([primary]);
  const shown = controlLayout(original,{action:'show',rootId:'root',path:'readme.md'},space,()=>space);
  assert.deepEqual(paneLeaves(shown.root).flatMap(pane=>pane.tabs),[primary,file]);
  const split = controlLayout(shown,{action:'split',paneId:'pane-1',axis:'x',view:file},space,()=>space);
  assert.equal(validPaneLayout(split),true);assert.equal(paneLeaves(split.root).length,2);assert.equal(split.root.kind,'split');
  if(split.root.kind !== 'split')throw new Error('Missing split');
  const resized = controlLayout(split,{action:'resize',splitId:split.root.id,ratio:30},space,()=>space);
  assert.equal(resized.root.kind === 'split' && resized.root.ratio,30);
  const swapped = controlLayout(resized,{action:'swap',splitId:split.root.id},space,()=>space);
  assert.deepEqual(paneLeaves(swapped.root).map(pane=>pane.id),paneLeaves(split.root).map(pane=>pane.id).reverse());
  const focused = controlLayout(swapped,{action:'focus',paneId:'pane-1',view:primary},space,()=>space);
  assert.equal(focused.focusedPane,'pane-1');assert.deepEqual(new Set(paneLeaves(focused.root).flatMap(pane=>pane.tabs.map(tabKey))),new Set(['primary',tabKey(file)]));
  assert.deepEqual(original,createPaneLayout([primary]));
});
test('a new split prepares its specified unique view in memory without an empty intermediate write',()=> {
  const next = controlLayout(createPaneLayout([primary]),{action:'split',paneId:'pane-1',axis:'x',view:file},space,()=>space);
  assert.equal(validPaneLayout(next),true);assert.deepEqual(paneLeaves(next.root).map(pane=>pane.tabs),[[primary],[file]]);
});
test('splits retain the original source active owner for new and inactive specified views',()=> {
  const other={kind:'agent',identity:'other'} as const,original=createPaneLayout([primary,other],'primary');
  for(const view of [file,other]) {
    const next=controlLayout(original,{action:'split',paneId:'pane-1',axis:'x',view},space,()=>space);
    assert.equal(paneLeaves(next.root)[0]?.active,'primary');assert.equal(paneLeaves(next.root)[1]?.active,tabKey(view));
  }
});
test('native pane boxes account for ancestor ratios, axes, order, nested splits and sibling minimum sizes',()=> {
  const original=controlLayout(createPaneLayout([primary]),{action:'split',paneId:'pane-1',axis:'x',view:file},space,()=>space);
  assert.equal(original.root.kind,'split');if(original.root.kind !== 'split')throw new Error('Missing split');
  const box=controlPaneBox(original.root,'pane-1',space);assert.deepEqual(box,{x:0,y:0,width:798,height:1000});
  const resized=controlLayout(original,{action:'resize',splitId:original.root.id,ratio:30},space,()=>space);
  const swapped=controlLayout(original,{action:'swap',splitId:original.root.id},space,()=>space);
  assert.deepEqual(controlPaneBox(resized.root,'pane-1',space),{x:0,y:0,width:479,height:1000});
  assert.deepEqual(controlPaneBox(swapped.root,'pane-1',space),{x:802,y:0,width:798,height:1000});
  assert.deepEqual(controlPaneBox({...original.root,axis:'y'},'pane-1',space),{x:0,y:0,width:1600,height:498});
  const nested=controlLayout(original,{action:'split',paneId:'pane-2',axis:'y',view:{kind:'agent',identity:'nested'}},space,()=>space);
  assert.deepEqual(controlPaneBox(nested.root,'pane-1',space),box);
  assert.deepEqual(controlPaneBox(nested.root,'pane-2',space),{x:802,y:0,width:798,height:498});
  const ancestorResize=controlLayout(nested,{action:'resize',splitId:original.root.id,ratio:30},space,()=>space);
  assert.deepEqual(controlPaneBox(ancestorResize.root,'pane-2',space),{x:483,y:0,width:1117,height:498});
  const narrow={...space,width:1200},siblingSplit=controlLayout(original,{action:'split',paneId:'pane-2',axis:'x',view:{kind:'agent',identity:'nested'}},space,()=>space);
  assert.deepEqual(controlPaneBox(original.root,'pane-1',narrow),{x:0,y:0,width:598,height:1000});
  assert.deepEqual(controlPaneBox(siblingSplit.root,'pane-1',narrow),{x:0,y:0,width:552,height:1000});
  assert.equal(controlPaneBox(original.root,'missing',space),undefined);
});
test('missing exact IDs, duplicate owners, empty-source splits and insufficient geometry refuse',()=> {
  const original = createPaneLayout([primary]);
  const refusal = (run:()=>unknown,code:string)=>assert.throws(run,error=>error instanceof ControlRefusal && error.code === code);
  refusal(()=>controlLayout(original,{action:'focus',paneId:'missing'},space,()=>space),'pane_missing');
  refusal(()=>controlLayout(original,{action:'split',paneId:'pane-1',axis:'x',view:primary},space,()=>space),'source_empty');
  refusal(()=>controlLayout(createPaneLayout([]),{action:'split',paneId:'pane-1',axis:'x',view:file},space,()=>space),'source_empty');
  refusal(()=>controlLayout(original,{action:'resize',splitId:'missing',ratio:30},space,()=>space),'split_missing');
  refusal(()=>controlLayout(original,{action:'split',paneId:'pane-1',axis:'x',view:file},space,()=>({...space,width:600})),'geometry');
  const split = controlLayout(original,{action:'split',paneId:'pane-1',axis:'x',view:file},space,()=>space);
  refusal(()=>controlLayout(split,{action:'focus',paneId:'pane-1',view:file},space,()=>space),'view_in_other_pane');
  refusal(()=>controlLayout(split,{action:'focus',paneId:'pane-1'},{...space,width:500},()=>space),'geometry');
});
function fixture(acknowledge?:(ack:ControlAck)=>Promise<void>) {
  let page:ControlPage = {bootId:'boot',workspaceId:'workspace',pageId:'page',connectionId:'stream',revision:4,enabled:true,connected:true};
  const acks:ControlAck[] = [],calls:ControlRequest[] = [];let busy:string|undefined;let apply:(request:ControlRequest)=>Promise<number> = async()=>5;
  const owner = new BrowserControl({page:()=>page,busy:()=>busy,apply:request=> {calls.push(request);return apply(request);},ack:async ack=> {acks.push(ack);await acknowledge?.(ack);},now:()=>100});
  const request:ControlRequest = {requestId:'request',bootId:'boot',workspaceId:'workspace',pageId:'page',connectionId:'stream',expectedRevision:4,expiresAt:1000,actor:'Helper',intent:{action:'focus',paneId:'pane-1'}};
  return {owner,request,acks,calls,page:(next:Partial<ControlPage>)=> {page = {...page,...next};},busy:(value:string)=> {busy=value;},apply:(next:typeof apply)=> {apply=next;}};
}
test('an expired application releases its reload hold without a replay or late acknowledgment',async t=> {
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),pending=Promise.withResolvers<number>();f.apply(()=>pending.promise);
  const work=f.owner.receive(f.request);assert.equal(f.owner.applying,true);t.mock.timers.tick(901);await work;
  assert.equal(f.owner.applying,false);assert.equal(f.acks[0]?.result,'unconfirmed');
  pending.resolve(5);await Promise.resolve();assert.equal(f.acks.length,1);assert.equal(f.calls.length,1);
});
test('an expired unsettled apply refuses the next request until the underlying work resolves or rejects',async t=> {
  t.mock.timers.enable({apis:['setTimeout']});
  for(const reject of [false,true]) {
    const f=fixture(),pending=Promise.withResolvers<number>();f.apply(()=>pending.promise);const first=f.owner.receive(f.request);
    t.mock.timers.tick(901);await first;assert.equal(f.owner.applying,false);assert.equal(f.acks[0]?.result,'unconfirmed');
    await f.owner.receive({...f.request,requestId:'busy-after-deadline'});assert.equal(f.calls.length,1);
    assert.equal(f.acks[1]?.result,'refused');assert.equal(f.acks[1]?.result === 'refused' && f.acks[1].refusalCode,'busy');
    if(reject)pending.reject(new Error('Late application failure'));else pending.resolve(5);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(f.acks.length,2);assert.equal(f.owner.applying,false);
    f.apply(async()=>5);await f.owner.receive({...f.request,requestId:'after-settlement'});assert.equal(f.calls.length,2);assert.equal(f.acks[2]?.result,'applied');
  }
});
test('a previous receipt response never releases a later application hold',async()=> {
  const receipt=Promise.withResolvers<void>(),pending=Promise.withResolvers<number>(),f=fixture(()=>receipt.promise);
  const first=f.owner.receive(f.request);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.owner.applying,false);
  f.apply(()=>pending.promise);const second=f.owner.receive({...f.request,requestId:'second'});assert.equal(f.owner.applying,true);
  receipt.resolve();await first;assert.equal(f.owner.applying,true);
  pending.resolve(5);await second;assert.equal(f.owner.applying,false);assert.deepEqual(f.acks.map(ack=>ack.result),['applied','applied']);
});
test('only an exact connected stream incarnation executes and replays remain inert',async()=> {
  const f = fixture();
  for(const changed of [{bootId:'old'},{workspaceId:'other'},{pageId:'other'},{connectionId:'old'}])await f.owner.receive({...f.request,...changed});
  assert.equal(f.calls.length,0);assert.deepEqual(f.acks,[]);
  await f.owner.receive(f.request);await f.owner.receive(f.request);assert.equal(f.calls.length,1);assert.deepEqual(f.acks.map(ack=>ack.result),['applied']);
  assert.equal(f.acks[0]?.connectionId,'stream');assert.equal(f.acks[0]?.result === 'applied' && f.acks[0].appliedRevision,5);
});
test('disabled, stale, expired and native busy requests refuse without a deferred action',async()=> {
  for(const code of ['disabled','stale_revision','expired','selection']) {
    const f=fixture();if(code==='disabled')f.page({enabled:false});if(code==='stale_revision')f.page({revision:5});if(code==='selection')f.busy('selection');
    await f.owner.receive({...f.request,...(code==='expired'?{expiresAt:100}:{})});assert.equal(f.calls.length,0);assert.equal(f.acks[0]?.result,'refused');assert.equal(f.acks[0]?.result==='refused'&&f.acks[0].refusalCode,code);
  }
});
test('a synchronous safety refusal is refused but save uncertainty and connection replacement are unconfirmed',async()=> {
  const refused=fixture();refused.apply(async()=> {throw new ControlRefusal('native_owner_hidden');});await refused.owner.receive(refused.request);assert.equal(refused.acks[0]?.result,'refused');
  for(const replace of [false,true]) {
    const f=fixture(),pending=Promise.withResolvers<number>();f.apply(()=>pending.promise);const work=f.owner.receive(f.request);assert.equal(f.owner.applying,true);
    await f.owner.receive({...f.request,requestId:'second'});assert.equal(f.acks[0]?.result,'refused');
    if(replace){f.page({connectionId:'new-stream'});pending.resolve(5);}else pending.reject(new Error('Save response lost'));
    await work;assert.equal(f.acks[1]?.result,'unconfirmed');assert.equal(f.owner.applying,false);assert.equal(f.calls.length,1);
  }
});
