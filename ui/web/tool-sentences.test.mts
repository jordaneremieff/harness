import assert from 'node:assert/strict';
import test from 'node:test';
import {toolLabel, toolSentence} from './tool-sentences.ts';
import type {JoinedTool} from './transcript-tools.ts';

test('image reads use typed media without guessing a name from the storage path', () => {
  const tool:JoinedTool = {callId:'image',name:'read',owner:'entry',slot:'slot',status:'success',args:{value:{path:'/opaque/storage/digest.bin'},truncated:false},result:[{type:'image',mimeType:'image/png',digest:'a'.repeat(64),bytes:64,width:20,height:10,alt:'Not an established filename'}]};
  assert.equal(toolLabel(tool),'Read image · PNG'); assert.equal(toolLabel({...tool,status:'working'}),'Reading image · PNG');
  assert.equal(toolLabel({...tool,name:'custom'}),'Used custom'); assert.doesNotMatch(toolLabel(tool),/digest|filename|storage/);
});
test('call preparation stays distinct from queued execution and an unresolved historical result', () => {
  const tool:JoinedTool = {callId:'call',name:'read',owner:'live',slot:'call',status:'preparing',args:{value:{path:'notes.md'},truncated:false}};
  assert.equal(toolLabel(tool), 'Read notes.md');
  assert.equal(toolSentence(tool), 'Preparing call: Read notes.md');
  assert.equal(toolSentence({...tool,status:'pending'}), 'Queued: Read notes.md');
  assert.equal(toolSentence({...tool,status:'working'}), 'Reading notes.md');
  assert.equal(toolSentence({...tool,status:'missing'}), 'No result recorded: Read notes.md');
});
