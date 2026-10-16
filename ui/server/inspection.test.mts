import assert from 'node:assert/strict';
import test from 'node:test';
import {inspectCursor, projectInspection} from './inspection.mts';
const identity='00000000-0000-4000-8000-000000000001:2';
const coverage={complete:false,scannedEntries:22,scannedBytes:65536,omittedEntries:13,entryLimitReached:false,scanByteLimitReached:true,byteLimitReached:true,metadataTruncated:false};
function activity(){return {sessionId:identity,view:'activity',detail:'Bounded read',turns:[{entries:[{id:7,kind:'assistant',source:'assistant',text:'Readable answer',truncated:false}]}],nextCursor:{before:7,nested:{tail:'exact-cursor'}},coverage,metadata:{live:false,owner:'unavailable',operation:null,pending:null,runningTools:[]}};}
test('activity preserves opaque native cursor, IDs and source coverage outside clipped body text',()=>{
  const raw=activity();const entry=raw.turns[0]?.entries[0];assert.ok(entry);entry.text='x'.repeat(20000);
  const out=projectInspection(raw,identity,'now');assert.equal(out.view,'activity');if(out.view!=='activity')return;
  assert.deepEqual(out.nextCursor,raw.nextCursor);assert.deepEqual(out.coverage,coverage);assert.equal(out.entries[0]?.id,7);assert.equal(out.entries[0]?.text.shortened,true);assert.equal(out.entries[0]?.truncated,false);assert.equal(out.metadata.live,false);
  assert.equal(out.entries[0]?.text.text.length<20000,true);assert.equal(out.readAt,'now');
});
test('result selectors and answer-entry IDs survive body budget and secret protection',()=>{
  const out=projectInspection({view:'result',sessionId:identity,status:'done',submissionId:9,requestId:'native:one',operationId:'native-operation',entryId:4,answerEntryId:12,answer:`Bearer abcdefghijklmnop\n${'long '.repeat(20000)}`,usage:{models:{},tools:{}}},identity);
  assert.equal(out.view,'result');if(out.view!=='result')return;
  assert.equal(out.submissionId,9);assert.equal(out.requestId,'native:one');assert.equal(out.operationId,'native-operation');assert.equal(out.answerEntryId,12);assert.equal(out.answer?.protected,true);assert.equal(out.answer?.shortened,true);assert(!out.answer?.text.includes('abcdefghijklmnop'));
});
test('exact paging keeps native UTF-16 offsets despite text protection and refuses extra clipping',()=>{
  const out=projectInspection({view:'exact',sessionId:identity,entryId:12,offset:12000,nextOffset:24000,text:'Bearer abcdefghijklmnop\npage',truncated:true},identity);
  assert.equal(out.view,'exact');if(out.view!=='exact')return;
  assert.equal(out.nextOffset,24000);assert.equal(out.offset,12000);assert.equal(out.text.protected,true);assert.equal(out.text.shortened,false);
  assert.throws(()=>projectInspection({view:'exact',sessionId:identity,entryId:12,offset:0,nextOffset:12000,text:'x'.repeat(50000),truncated:true},identity),{code:'invalid_inspection'});
  assert.throws(()=>projectInspection({view:'exact',sessionId:identity,entryId:12,offset:4,nextOffset:4,text:'page',truncated:true},identity),{code:'invalid_inspection'});
});
test('malformed controls refuse instead of becoming empty history or shortened selectors',()=>{
  assert.throws(()=>projectInspection({...activity(),sessionId:'another'},identity),{code:'invalid_inspection'});
  assert.throws(()=>projectInspection({...activity(),coverage:{...coverage,complete:'no'}},identity),{code:'invalid_inspection'});
  for(const value of [{token:'x'.repeat(5000)},{nested:undefined},{value:Infinity}])assert.throws(()=>inspectCursor(value),{code:'invalid_inspection'});
  assert.deepEqual(inspectCursor({position:[2,'token',null]}),{position:[2,'token',null]});
});
test('valid activity with seventeen running tools uses a separate display omission instead of source refusal',()=>{
  const source=activity(),runningTools=Array.from({length:17},(_,index)=>({name:`tool-${index}`,toolCallId:`call-${index}`}));
  const out=projectInspection({...source,metadata:{...source.metadata,live:true,owner:'here',runningTools}},identity);assert.equal(out.view,'activity');if(out.view!=='activity')return;
  assert.equal(out.metadata.runningTools.length,16);assert.equal(out.metadata.runningToolsOmitted,1);assert.equal(out.metadata.runningTools[15]?.name,'tool-15');assert.deepEqual(out.coverage,source.coverage);assert.equal(out.coverage.metadataTruncated,false);assert.equal(out.entries[0]?.text.text,'Readable answer');
});
test('call-only activity keeps the public native call summary with complete source coverage',()=>{
  const source=activity(),out=projectInspection({...source,coverage:{...source.coverage,complete:true,omittedEntries:0,scanByteLimitReached:false,byteLimitReached:false},turns:[{entries:[{id:7,kind:'assistant',source:'assistant',text:'',truncated:false,toolCalls:[{name:'read',arguments:'{"path":"fixture.ts"}',callId:'call-7',truncated:false}]}]}]},identity);
  assert.equal(out.view,'activity');if(out.view!=='activity')return;const entry=out.entries[0];assert.ok(entry);
  assert.equal(entry.text.text,'');assert.equal(entry.calls[0]?.name.text,'read');assert.equal(entry.calls[0]?.arguments.text,'{"path":"fixture.ts"}');assert.equal(entry.calls[0]?.callId?.text,'call-7');assert.equal(entry.calls[0]?.truncated,false);assert.equal(entry.callsOmitted,0);assert.equal(entry.truncated,false);assert.equal(out.coverage.complete,true);assert.equal(out.displayOmitted,0);
});
test('tool-call names and arguments retain native truncation separately from protected bounded display',()=>{
  const source=activity(),call={name:'Bearer abcdefghijklmnop',arguments:`Bearer abcdefghijklmnop ${'x'.repeat(20000)}`,truncated:true};
  const out=projectInspection({...source,turns:[{entries:[{id:7,kind:'assistant',source:'assistant',text:'',truncated:false,toolCalls:Array.from({length:9},()=>call)}]}]},identity);
  assert.equal(out.view,'activity');if(out.view!=='activity')return;const entry=out.entries[0];assert.ok(entry);
  assert.equal(entry.calls.length,8);assert.equal(entry.callsOmitted,1);assert.equal(entry.calls[0]?.name.protected,true);assert.equal(entry.calls[0]?.arguments.protected,true);assert.equal(entry.calls[0]?.arguments.shortened,true);assert.equal(entry.calls[0]?.truncated,true);assert(!JSON.stringify(entry).includes('abcdefghijklmnop'));
  assert.throws(()=>projectInspection({...source,turns:[{entries:[{id:7,kind:'assistant',source:'assistant',text:'',truncated:false,toolCalls:[{...call,arguments:{path:'not a summary string'}}]}]}]},identity),{code:'invalid_inspection'});
});
test('unavailable result has no invented admission or answer',()=>{
  const out=projectInspection({view:'result',sessionId:identity,status:'unavailable',reason:'No matching result',usage:{models:{},tools:{}}},identity);
  assert.equal(out.view,'result');if(out.view!=='result')return;
  assert.equal(out.submissionId,undefined);assert.equal(out.answer,undefined);assert.equal(out.reason?.text,'No matching result');
});
