import assert from 'node:assert/strict';
import test from 'node:test';
import {toolLabel, toolSentence} from './tool-sentences.ts';
import type {JoinedTool} from './transcript-tools.ts';

test('call preparation stays distinct from queued execution and an unresolved historical result', () => {
  const tool:JoinedTool = {callId:'call',name:'read',owner:'live',slot:'call',status:'preparing',args:{value:{path:'notes.md'},truncated:false}};
  assert.equal(toolLabel(tool), 'Read notes.md');
  assert.equal(toolSentence(tool), 'Preparing call: Read notes.md');
  assert.equal(toolSentence({...tool,status:'pending'}), 'Queued: Read notes.md');
  assert.equal(toolSentence({...tool,status:'working'}), 'Reading notes.md');
  assert.equal(toolSentence({...tool,status:'missing'}), 'No result recorded: Read notes.md');
});
