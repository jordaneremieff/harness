import assert from 'node:assert/strict';
import test from 'node:test';
import {HostLink} from './client.mts';
import {decodeInput,decodeResponse,type JsonObject} from './contract.mts';
import {FakeHost,STORAGE,CHILD,configurationReply,deferred} from './fake-host.mts';

test('configuration decodes applied, refused and uncertain host results with complete selection',()=> {
  for(const state of ['applied','failed','uncertain']) {
    const result=configurationReply(CHILD);
    if(state!=='applied'){result.outcome='failed';result.error='Host refused this change';}
    if(state==='uncertain')(result.persistence as JsonObject).nativeWrites='uncertain';
    const decoded=decodeResponse('configure',result,{identity:CHILD});
    assert.equal(decoded.sessionId,CHILD);assert.deepEqual(decoded.selection,result.selection);assert.equal(decoded.after.model,'fixture/new');
  }
  const result=configurationReply();
  assert.throws(()=>decodeResponse('configure',result,{identity:CHILD}),/target/);
  (result.selection as JsonObject).extra=true;assert.throws(()=>decodeResponse('configure',result),/Unsupported field/);
  delete (result.selection as JsonObject).extra;(result.selection as JsonObject).inputDigest='invalid';assert.throws(()=>decodeResponse('configure',result),/digest|string/);
});
test('configuration requests admit only concrete current fields and exact identities',()=> {
  const base={sessionId:STORAGE,requestId:'ui:op'};
  for(const patch of [{model:{provider:'fixture',modelId:'new'}},{thinkingLevel:'max'},{name:''},{preset:'worker'}])assert.deepEqual(decodeInput('configure',{...base,...patch}),{...base,...patch});
  for(const patch of [{},{model:null},{model:'fixture/new'},{model:{provider:'fixture/wrong',modelId:'model'}},{model:{provider:'fixture',modelId:'bad\u0000model'}},{thinkingLevel:'unknown'},{name:null},{preset:'Bad Name'},{extra:true}])assert.throws(()=>decodeInput('configure',{...base,...patch}));
});
test('configure uses the exact operation once and treats lost or malformed replies as uncertain without replay',async t=> {
  const gate=deferred<JsonObject>();
  const host=await FakeHost.start({handler:call=>call.member==='configure'?gate.promise:undefined});t.after(()=>host.close());
  const link=await HostLink.connect(host.endpoint);t.after(()=>link.close());assert.equal(link.supports('configure'),true);
  const pending=link.request('configure',{sessionId:CHILD,requestId:'ui:one',thinkingLevel:'high'},{identity:CHILD,requestId:'ui:one',wireRequestId:'ui:one'});
  await host.waitForCall(call=>call.member==='configure');
  gate.resolve({...configurationReply(CHILD),selection:{invalid:true}});
  await assert.rejects(pending,(error:unknown)=>{assert.equal((error as {uncertain:boolean}).uncertain,true);return true;});
  assert.equal(host.calls.length,1);assert.equal(host.calls[0].wireRequestId,'ui:one');assert.equal(link.supports('configure'),false);
});
