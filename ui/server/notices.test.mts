import assert from 'node:assert/strict';
import test from 'node:test';
import {Journal} from './journal.mts';

 test('notice baseline survives transcript replay eviction and respects workspace visibility',()=> {
  const journal=new Journal({events:2,bytes:4096,queue:4096});
  const target={kind:'primary',key:'primary',epoch:1} as const;
  const global=journal.publish('notice',target,{level:'warning',code:'initialization',message:'Trust confirmation is required.'});
  const local=journal.publish('notice',undefined,{level:'error',code:'save',message:'Draft was not saved.'},'workspace-a');
  journal.publish('extension.request',target,{method:'notify',message:'Tool finished.',notifyType:'info'});
  for(let index=0;index<8;index++) journal.publish('primary.delta',target,{messageId:'reply',index:0,kind:'text',delta:'next'});
  assert.equal(journal.replay(global,'workspace-a').reason,'expired');
  assert.deepEqual(journal.notices('workspace-a').map(item=>item.id),[global,local,`${journal.bootId}:3`]);
  assert.deepEqual(journal.notices('workspace-b').map(item=>item.id),[global,`${journal.bootId}:3`]);
  const copy=journal.notices('workspace-a');copy[0].message='changed';
  assert.equal(journal.notices('workspace-a')[0].message,'Trust confirmation is required.');
 });

 test('retained notices bound count and UTF-8 bytes without timers or mutable source references',()=> {
  const journal=new Journal();
  for(let index=0;index<100;index++) journal.publish('notice',undefined,{level:'warning',code:'large',message:'🙂\u0000'.repeat(3000)});
  const notices=journal.notices('workspace');
  assert.ok(notices.length>0 && notices.length<=32);
  assert.ok(Buffer.byteLength(JSON.stringify(notices))<=16*1024+notices.length+2);
  assert.ok(notices.every(notice=>!notice.message.includes('\u0000') && !notice.message.includes('\ufffd')));
  assert.ok(notices.every(notice=>Buffer.byteLength(notice.message)<=2048));
 });
