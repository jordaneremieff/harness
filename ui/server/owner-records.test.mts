import assert from 'node:assert/strict';
import test from 'node:test';
import {OwnerRecords} from './owner-records.mts';
import type {OwnerBaseline,OwnerDescriptor} from '../shared/owner.ts';
const descriptor:OwnerDescriptor={key:'primary',epoch:1,cwd:'/fixture',executable:'fake',recoveryWorkspaceId:'workspace',exited:false,available:true,synchronized:true,sequence:0,stderr:'',recoveryPending:false};
function snapshot(records:OwnerRecords,attachment='backend',token=records.begin(attachment).token):OwnerBaseline {
  const meta=records.finish(attachment,token,descriptor);const pages=Array.from({length:meta.pages},(_,index)=>Buffer.from(records.page(attachment,token,index).data,'base64'));
  return JSON.parse(Buffer.concat(pages).toString('utf8')) as OwnerBaseline;
}
test('actual RPC wire delta tape captures overlap once and releases only the suffix',()=> {
  const records=new OwnerRecords();
  records.advance({type:'message_start',message:{role:'assistant',timestamp:1,content:[]}});
  const capture=records.begin('backend');
  records.advance({type:'message_update',usage:{input:1},assistantMessageEvent:{type:'text_start',contentIndex:0}});
  records.advance({type:'message_update',usage:{input:1},assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'retained'}});
  const baseline=snapshot(records,'backend',capture.token);
  assert.equal(baseline.complete,true);assert.equal(baseline.activeMessage?.events.length,3);assert.equal(baseline.overlap.length,2);
  assert.equal('message' in (baseline.activeMessage?.events[2]?.record??{}),false);
  records.advance({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' later'}});
  assert.deepEqual(records.ack('backend',capture.token).map(value=>value.seq),[4]);
});
test('a bounded delta tape reports missing partials, then recovers after a complete final message',()=> {
  const records=new OwnerRecords({tapeBytes:180});records.advance({type:'message_start',message:{role:'assistant',content:[]}});
  for(let index=0;index<20;index++)records.advance({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'long text'}});
  const baseline=snapshot(records);assert.equal(baseline.complete,false);assert.deepEqual(baseline.reasons,['active-message-overflow']);assert.equal(baseline.activeMessage?.events.length,1);
  records.detach('backend');records.advance({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'final'}]}});
  assert.equal(snapshot(records).complete,true);
});
test('assistant end before capture seal retains a start from before capture begin',()=> {
  const records=new OwnerRecords({ringRecords:1,tapeBytes:1});
  const start=records.advance({type:'message_start',message:{role:'assistant',content:[]}});
  const capture=records.begin('backend');
  const raw={type:'message_end',message:{role:'assistant',content:[{type:'text',text:'final'}]}};
  const event=records.advance(raw),baseline=snapshot(records,'backend',capture.token);
  assert.equal(baseline.activeMessage,null);assert.equal(baseline.complete,true);assert.equal(baseline.overlap.length,1);
  assert.equal(baseline.overlap[0]?.messageStartSequence,start.seq);assert.equal(event.messageStartSequence,start.seq);
  assert.deepEqual(event.record,raw);assert.deepEqual(baseline.overlap[0]?.record,raw);
  assert.deepEqual(records.ack('backend',capture.token),[]);
});
test('assistant end after capture seal retains its start in the ordered suffix',()=> {
  const records=new OwnerRecords();const start=records.advance({type:'message_start',message:{role:'assistant',content:[]}});
  const capture=records.begin('backend'),baseline=snapshot(records,'backend',capture.token);
  const raw={type:'message_end',message:{role:'assistant',content:[{type:'text',text:'final'}]}};
  const end=records.advance(raw);assert.equal(baseline.activeMessage?.startSequence,start.seq);
  assert.deepEqual(records.ack('backend',capture.token),[end]);assert.equal(end.messageStartSequence,start.seq);
  assert.equal(end.seq,baseline.cursor+1);assert.deepEqual(end.record,raw);
});
test('assistant end metadata never invents or reuses an absent start',()=> {
  const records=new OwnerRecords(),raw={type:'message_end',message:{role:'assistant',content:[]}};
  assert.equal('messageStartSequence' in records.advance(raw),false);
  records.advance({type:'message_start',message:{role:'assistant',content:[]}});
  const user=records.advance({type:'message_end',message:{role:'user',content:[]}});assert.equal('messageStartSequence' in user,false);
  assert.equal(records.advance(raw).messageStartSequence,2);
  assert.equal('messageStartSequence' in records.advance(raw),false);
  records.advance({type:'message_start',message:{role:'assistant',content:[]}});records.reset();
  assert.equal('messageStartSequence' in records.advance(raw),false);
});
test('tool partials are latest supplied values and raw keyed state honors deletion',()=> {
  const records=new OwnerRecords();records.advance({type:'tool_execution_start',toolCallId:'tool',toolName:'read',args:{}});
  records.advance({type:'tool_execution_update',toolCallId:'tool',toolName:'read',args:{},partialResult:{content:[{type:'text',text:'first'}]}});
  records.advance({type:'tool_execution_update',toolCallId:'tool',toolName:'read',args:{},partialResult:{content:[{type:'text',text:'last'}]}});
  records.advance({type:'extension_ui_request',id:'s',method:'setStatus',statusKey:'status',statusText:'yes'});
  records.advance({type:'extension_ui_request',id:'s2',method:'setStatus',statusKey:'status'});
  const baseline=snapshot(records);assert.equal(baseline.tools.length,1);assert.deepEqual(baseline.tools[0]?.latest?.record.partialResult,{content:[{type:'text',text:'last'}]});assert.equal(baseline.state.length,0);
});
test('dialog restore keeps receipt deadline and Pi zero-timeout semantics',()=> {
  let now=1000;const records=new OwnerRecords({},()=>now);
  records.advance({type:'extension_ui_request',id:'timed',method:'input',title:'Input',timeout:100});
  records.advance({type:'extension_ui_request',id:'zero',method:'confirm',title:'Question',timeout:0});
  assert.equal(records.pendingDialogs()[0]?.expiresAt,1100);now=1100;
  assert.equal(records.hasDialog('timed'),false);assert.equal(records.hasDialog('zero'),true);
  records.answered('zero');assert.equal(records.pendingDialogs().length,0);
});
test('full refresh clears protocol reasons without inventing active or unknown raw coverage',()=> {
  const records=new OwnerRecords({tapeBytes:1});records.incomplete('unknown-response');
  records.advance({type:'message_start',message:{role:'assistant',content:[]}});
  const capture=records.begin('backend');records.resynchronize('backend',capture.token);
  assert.deepEqual(snapshot(records,'backend',capture.token).reasons,['active-message-overflow']);
  records.detach('backend');records.advance({type:'message_end',message:{role:'assistant',content:[]}});
  assert.equal(snapshot(records).complete,true);records.detach('backend');
  records.incomplete('invalid-rpc-record');const lost=records.begin('backend');records.resynchronize('backend',lost.token);
  assert.deepEqual(snapshot(records,'backend',lost.token).reasons,['raw-event-loss']);
});
test('a fresh protocol loss invalidates an in-progress refresh even for the same reason',()=> {
  const records=new OwnerRecords();records.incomplete('unknown-response');const capture=records.begin('backend');
  records.incomplete('unknown-response');assert.throws(()=>records.resynchronize('backend',capture.token),/refresh-invalidated/);
  assert.throws(()=>records.resynchronize('other',capture.token),/capture-unavailable/);
  const next=records.begin('backend');records.resynchronize('backend',next.token);assert.equal(snapshot(records,'backend',next.token).complete,true);
  assert.throws(()=>records.resynchronize('backend',next.token),/refresh-invalidated/);
});
test('omitted dialog coverage clears only after its known deadline or explicit answer',()=> {
  let now=1000;const records=new OwnerRecords({dialogs:1},()=>now);
  records.advance({type:'extension_ui_request',id:'retained',method:'input',timeout:0});
  records.advance({type:'extension_ui_request',id:'omitted',method:'confirm',timeout:100});
  assert.deepEqual(snapshot(records).reasons,['dialog-limit']);records.detach('backend');
  const refresh=records.begin('backend');records.resynchronize('backend',refresh.token);
  assert.equal(snapshot(records,'backend',refresh.token).complete,false);records.detach('backend');
  records.answered('retained');assert.equal(snapshot(records).complete,false);records.detach('backend');
  now=1100;assert.equal(snapshot(records).complete,true);records.detach('backend');
  records.advance({type:'extension_ui_request',id:'invalid',method:'input',timeout:-1});
  assert.equal(records.hasDialog('invalid'),true);assert.deepEqual(snapshot(records).reasons,['invalid-dialog-timeout']);records.detach('backend');
  records.answered('invalid');assert.equal(snapshot(records).complete,true);
});
test('untracked dialog overflow stays incomplete rather than inventing its expiry',()=> {
  let now=1000;const records=new OwnerRecords({dialogs:1},()=>now);
  for(const id of ['retained','tracked','untracked'])records.advance({type:'extension_ui_request',id,method:'input',timeout:1});
  now=2000;const capture=records.begin('backend');records.resynchronize('backend',capture.token);
  assert.deepEqual(snapshot(records,'backend',capture.token).reasons,['dialog-coverage-unavailable']);
});
test('capture overflow and expired suffix refuse complete reconstruction without discarding new records',()=> {
  const records=new OwnerRecords({ringRecords:2});const capture=records.begin('one');
  records.advance({type:'agent_start'});records.advance({type:'queue_update',steering:[],followUp:[]});records.advance({type:'agent_settled'});
  const baseline=snapshot(records,'one',capture.token);assert.equal(baseline.complete,false);assert.ok(baseline.reasons.includes('capture-overflow'));
  records.advance({type:'agent_start'});records.advance({type:'agent_settled'});records.advance({type:'agent_start'});
  assert.throws(()=>records.ack('one',capture.token),/suffix-expired/);assert.equal(records.cursor,6);
});
test('snapshot pages stay immutable while later records arrive',()=> {
  const records=new OwnerRecords({capturePageBytes:32});const token=records.begin('one').token;records.advance({type:'agent_start'});
  const meta=records.finish('one',token,descriptor);const first=records.page('one',token,0);records.advance({type:'agent_settled'});
  assert.deepEqual(records.page('one',token,0),first);assert.deepEqual(records.finish('one',token,descriptor),meta);
  assert.throws(()=>records.page('other',token,0),/capture-unavailable/);
});
