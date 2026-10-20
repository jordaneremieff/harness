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

test('thread calls read as sentences by action', () => {
  const call = (action: string, extra: Record<string, unknown> = {}): JoinedTool => ({callId: 'c', name: 'agent_collaborate', owner: 'e', slot: 's', status: 'success', args: {value: {action, threadId: 'a'.repeat(8), ...extra}, truncated: false}});
  assert.equal(toolLabel(call('post', {message: 'Round five is on'})), 'Posted to a thread: “Round five is on”');
  assert.equal(toolLabel(call('read')), 'Read a thread'); assert.equal(toolLabel(call('join')), 'Joined a thread');
  assert.equal(toolLabel({...call('post', {message: 'Hi'}), status: 'working'}), 'Posting to a thread: “Hi”');
  assert.equal(toolLabel(call('create', {title: 'Plan'})), 'Created a thread: “Plan”');
  assert.doesNotMatch(toolSentence(call('post', {message: 'Hi'})), /agent_collaborate|threadId/);
});

test('call quotes use plain words without changing their supplied arguments', () => {
  const call = (name: string, args: Record<string, unknown>): JoinedTool => ({callId: 'q', name, owner: 'e', slot: 's', status: 'success', args: {value: args, truncated: false}});
  const cases = [
    ['Commit `9a852288` is **done**', 'Commit 9a852288 is done'],
    ['__Done__ with *care*', 'Done with care'], ['## Result', 'Result'],
    ['- first item', 'first item'], ['2. second item', 'second item'], ['> quoted words', 'quoted words'],
    ['[Pi](https://example.test)', 'Pi'],
  ];
  for (const [message, expected] of cases) {
    const tool = call('agent_send', {sessionId: 'peer', message});
    assert.equal(toolLabel(tool), `Sent a message to another conversation: “${expected}”`);
    assert.deepEqual(tool.args?.value, {sessionId: 'peer', message});
  }
  const message = '**Done**';
  for (const [name, extra, verb] of [
    ['agent_send', {}, 'Sent a message to'], ['agent_steer', {}, 'Redirected'],
    ['agent_send', {mode: 'steer'}, 'Redirected'], ['agent_send', {mode: 'report'}, 'Reported to'],
    ['agent_send', {deliverAt: '2026-10-21T12:00:00Z'}, 'Scheduled a message to'],
  ] as const) assert.equal(toolLabel(call(name, {sessionId: 'peer', message, ...extra})), `${verb} another conversation: “Done”`);
  for (const [action, verb] of [['post', 'Posted to'], ['create', 'Created'], ['revise', 'Revised']]) {
    assert.equal(toolLabel(call('agent_collaborate', {action, message, title: message})), `${verb} a thread: “Done”`);
  }
});
test('call quotes keep their first-line and 60-character cuts after mark removal', () => {
  const label = (message: unknown) => toolLabel({callId: 'q', name: 'agent_send', owner: 'e', slot: 's', status: 'success', args: {value: {sessionId: 'peer', message}, truncated: false}});
  const head = 'Sent a message to another conversation';
  assert.equal(label(`**${'a'.repeat(60)}**`), `${head}: “${'a'.repeat(60)}”`);
  assert.equal(label(`**${'a'.repeat(61)}**`), `${head}: “${'a'.repeat(60)}…”`);
  assert.equal(label('## Result\r\nNext text'), `${head}: “Result…”`);
  assert.equal(label(''), head); assert.equal(label(undefined), head);
  assert.equal(label(`\`${'😀'.repeat(30)}\``), `${head}: “${'😀'.repeat(30)}”`);
  assert.equal(label(`\`${'😀'.repeat(31)}\``), `${head}: “${'😀'.repeat(30)}…”`);
});

test('a thread call with an unknown or missing action falls back to a generic sentence', () => {
  const call = (args: Record<string, unknown>): JoinedTool => ({callId: 'c', name: 'agent_collaborate', owner: 'e', slot: 's', status: 'success', args: {value: args, truncated: false}});
  assert.equal(toolLabel(call({action: 'rename'})), 'Used a thread'); assert.equal(toolLabel(call({})), 'Used a thread');
  assert.equal(toolLabel(call({action: 'post'})), 'Posted to a thread'); assert.equal(toolLabel({...call({}), args: undefined}), 'Used a thread');
});

test('a command title leaves out a leading cd and names a folder only when it is not the conversation folder', () => {
  const cwd = '/work/harness.worktrees/ui-presentation';
  const bash = (command: unknown, status: JoinedTool['status'] = 'success'): JoinedTool => ({callId: 'b', name: 'bash', owner: 'e', slot: 's', status, args: {value: {command}, truncated: false}});
  const label = (command: unknown, status: JoinedTool['status'] = 'success', context: {cwd?: string} = {cwd}) => toolLabel(bash(command, status), context);
  assert.equal(label(`cd ${cwd} && git status --short | head -20`), 'Ran git status --short | head -20');
  assert.equal(label(`cd ${cwd}/ && npm test`), 'Ran npm test');
  assert.equal(label(`cd ${cwd}; npm test`), 'Ran npm test');
  assert.equal(label('cd /elsewhere/place/harness && npm test'), 'Ran npm test in …/place/harness');
  assert.equal(label(`cd ${cwd}/ui && npm test`), 'Ran npm test in ui');
  assert.equal(label('cd "/a b/harness" && npm test'), 'Ran npm test in …/a b/harness');
  assert.equal(label("cd '/a b/harness'; npm test"), 'Ran npm test in …/a b/harness');
  assert.equal(label(`cd "${cwd}" && git log`), 'Ran git log');
  assert.equal(label('cd /elsewhere/place/harness && npm test', 'working'), 'Running npm test in …/place/harness');
  assert.equal(label(`cd ${cwd} && npm test`, 'working'), 'Running npm test');
  assert.equal(label(`cd ${cwd} && npm test`, 'pending'), 'Run npm test');
  assert.equal(toolSentence(bash(`cd ${cwd} && npm test`, 'pending'), {cwd}), 'Queued: Run npm test');
  assert.equal(toolSentence(bash('cd /elsewhere/place/harness && npm test', 'error'), {cwd}), 'Failed: Run npm test in …/place/harness');
});

test('a multi-line command folds to one title line and its arguments keep every line', () => {
  const cwd = '/work/harness';
  const tool = (command: string): JoinedTool => ({callId: 'b', name: 'bash', owner: 'e', slot: 's', status: 'success', args: {value: {command}, truncated: false}});
  const label = (command: string, context: {cwd?: string} = {cwd}) => toolLabel(tool(command), context);
  const script = 'node -e \'const fs=require("fs");\nlet s=fs.readFileSync("a","utf8");\nconsole.log(s)\'';
  assert.equal(label(script), 'Ran node -e \'const fs=require("fs"); let s=fs.readFileSync("a","…');
  assert.match(label(script), /^Ran node -e 'const fs=require/); assert.doesNotMatch(label(script), /\n/);
  assert.equal(label("python3 - <<'EOF'\nimport sys\nprint(sys.argv)\nEOF"), "Ran python3 - <<'EOF' import sys print(sys.argv) EOF");
  assert.equal(label('echo   ok\t\tnow\r\n'), 'Ran echo ok now', 'runs of white space fold and the ends are trimmed');
  assert.equal(label('echo ok'), 'Ran echo ok');
  assert.equal(label(`${'a'.repeat(100)}\n${'b'.repeat(100)}`), `Ran ${'a'.repeat(60)}…`);
  const words = ['word', ...Array.from({length: 100}, () => 'x')].join(' ');
  assert.equal(label(words.replace(/ /g, '\n  ')), `Ran ${words.slice(0, 60)}…`);
  assert.equal(label(`cd ${cwd}/ui && node -e 'one\ntwo'`), "Ran node -e 'one two' in ui");
  assert.equal(label(`cd /elsewhere/place/harness &&\n  npm test\n  --silent`), 'Ran npm test --silent in …/place/harness');
  assert.equal(toolLabel({...tool('a\nb'), status: 'working'}, {cwd}), 'Running a b'); assert.equal(toolLabel({...tool('a\nb'), status: 'pending'}, {cwd}), 'Run a b');
  assert.deepEqual(tool(script).args?.value, {command: script}, 'the tool arguments, which the card shows and Copy copies, keep the full command');
});
test('a command title keeps commands that are only cd or do not start with cd', () => {
  const cwd = '/work/harness';
  const label = (command: unknown, context: {cwd?: string} = {cwd}) => toolLabel({callId: 'b', name: 'bash', owner: 'e', slot: 's', status: 'success', args: {value: {command}, truncated: false}}, context);
  assert.equal(label(`cd ${cwd}`), `Ran cd ${cwd}`); assert.equal(label(`cd ${cwd} &&`), `Ran cd ${cwd} &&`);
  assert.equal(label('git status && cd /x && ls'), 'Ran git status && cd /x && ls');
  assert.equal(label('cdrom --eject'), 'Ran cdrom --eject'); assert.equal(label('echo ok'), 'Ran echo ok');
  assert.equal(label('cd "$HOME/x" && ls'), 'Ran cd "$HOME/x" && ls'); assert.equal(label('cd - && ls'), 'Ran cd - && ls');
  assert.equal(label(undefined), 'Ran a command');
  assert.equal(label(`cd ${cwd} && ${'x'.repeat(70)}`), `Ran ${'x'.repeat(60)}…`);
  assert.equal(label(`cd ${cwd} && printf first\nsecond`), 'Ran printf first second');
  assert.equal(label('cd /elsewhere/place/harness && npm test', {}), 'Ran npm test in …/place/harness');
});
