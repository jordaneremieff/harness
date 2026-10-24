import assert from 'node:assert/strict';
import test from 'node:test';
import {quietTextResult, toolLabel, toolSentence, toolSubjectParts} from './tool-sentences.ts';
import type {JoinedTool} from './transcript-tools.ts';

const publicCall = (name: string, value: Record<string, unknown> = {}, status: JoinedTool['status'] = 'success'): JoinedTool => ({callId: 'public-call', name, owner: 'entry', slot: 'slot', status, args: {value, truncated: false}});

test('quiet plain-text result flags use only named public call facts', () => {
  for (const name of ['registry', 'agent_steer', 'agent_place', 'agent_reset', 'agent_configure', 'agent_fork', 'agent_rewind', 'agent_compact', 'stash_write', 'stash_edit', 'stash_complete', 'stash_rotate', 'memory_retire', 'clipboard_copy']) {
    assert.equal(quietTextResult(publicCall(name)), true, name);
  }
  for (const name of ['bash', 'read', 'write', 'edit', 'web_read', 'web_search', 'history_read', 'history_search', 'stash_read', 'stash_list', 'memory_read', 'memory_search', 'agent_send', 'agent_await', 'agent_inspect', 'agent_status', 'agent_collaborate', 'custom', 'toString']) {
    assert.equal(quietTextResult(publicCall(name)), false, name);
  }
  const call = {...publicCall('agent_profile', {action: 'update'}), result: [{type: 'text' as const, text: 'Unrelated output'}]};
  assert.equal(quietTextResult(call), true);
  for (const args of [{value: {action: 'read'}, truncated: false}, {value: {}, truncated: false}, {value: {action: 'update'}, truncated: true}, undefined]) {
    assert.equal(quietTextResult({...call, args}), false);
  }
  const accessor = Object.defineProperty({}, 'action', {enumerable: true, get: () => {throw new Error('Do not evaluate argument getters');}});
  assert.equal(quietTextResult({...call, args: {value: accessor, truncated: false}}), false);
});

test('public call arguments supply tool sentences without result interpretation', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['registry', {search: 'sample_query', name: 'ignored', kind: 'tool'}, 'Searched tools and resources for “sample_query”'],
    ['registry', {name: 'sample_resource', kind: 'tool'}, 'Looked up sample_resource'],
    ['registry', {kind: 'skill'}, 'Listed skills'],
    ['registry', {}, 'Checked the model and context'],
    ['history_search', {query: 'sample_query'}, 'Searched this conversation for “sample_query”'],
    ['history_search', {}, 'Listed recent conversation entries'],
    ['history_read', {entryId: 42}, 'Read conversation entry 42'],
    ['history_read', {entryId: '43'}, 'Read conversation entry 43'],
    ['stash_write', {title: 'Sample handover'}, 'Saved a handover: “Sample handover”'],
    ['stash_write', {title: 'Sample checkpoint', checkpoint: true}, 'Saved a checkpoint: “Sample checkpoint”'],
    ['stash_list', {query: 'sample_query'}, 'Searched handovers for “sample_query”'],
    ['stash_list', {}, 'Listed handovers'],
    ['stash_read', {id: 'sample'}, 'Read a handover'],
    ['stash_edit', {id: 'sample', edits: []}, 'Edited a handover'],
    ['stash_complete', {id: 'sample', outcome: 'Done'}, 'Closed a handover'],
    ['stash_rotate', {id: 'sample'}, 'Archived a handover'],
    ['agent_place', {area: '/work/sample_folder/', prompt: 'Check it'}, 'Sent work to the owner of sample_folder'],
    ['agent_place', {area: '/work/sample_folder'}, 'Found the owner of sample_folder'],
    ['agent_place', {prompt: 'Check it'}, 'Sent work to the owner of this folder'],
    ['agent_place', {}, 'Found the owner of this folder'],
    ['agent_profile', {action: 'update'}, 'Updated the profile of this agent'],
    ['agent_profile', {action: 'read'}, 'Read the profile of this agent'],
    ['agent_reset', {sessionId: 'unknown'}, 'Reset another conversation'],
    ['agent_configure', {sessionId: 'unknown'}, 'Changed settings of another conversation'],
    ['agent_fork', {sessionId: 'unknown'}, 'Forked another conversation'],
    ['agent_rewind', {sessionId: 'unknown', entryId: '42', correction: 'Use the source'}, 'Rewound another conversation'],
    ['agent_compact', {sessionId: 'unknown'}, 'Compacted another conversation'],
    ['memory_history', {slug: 'sample-note'}, 'Listed versions of memory note sample-note'],
    ['memory_retire', {slug: 'sample-note'}, 'Retired memory note sample-note'],
    ['pillars_usage', {}, 'Checked pillar usage'],
    ['clipboard_copy', {content: 'Raw content'}, 'Copied to the clipboard'],
    ['clipboard_copy', {content: 'Raw content', label: 'sample_label'}, 'Copied to the clipboard: “sample_label”'],
    ['twitter_search', {query: 'sample_query'}, 'Searched X for “sample_query”'],
    ['twitter_feed', {feed: 'following'}, 'Read the X feed'],
  ];
  for (const [name, args, expected] of cases) {
    const tool = {...publicCall(name, args), result: [{type: 'text' as const, text: 'Unrelated output: another_name'}]};
    const before = structuredClone(tool);
    assert.equal(toolLabel(tool), expected, name); assert.equal(toolSentence(tool), expected, name);
    assert.deepEqual(tool, before, `${name} keeps its raw arguments and output`);
  }
});

test('empty quoted search objects keep plain forms without a dangling preposition', () => {
  for (const [name, key, subject] of [
    ['registry', 'search', 'tools and resources'], ['history_search', 'query', 'this conversation'],
    ['stash_list', 'query', 'handovers'], ['twitter_search', 'query', 'X'],
  ]) {
    for (const query of ['', '   ', '**', 42]) {
      const call = publicCall(name, {[key]: query});
      assert.equal(toolLabel(call), `Searched ${subject}`);
      assert.equal(toolLabel({...call, status: 'working'}), `Searching ${subject}`);
      assert.equal(toolLabel({...call, status: 'pending'}), `Search ${subject}`);
    }
  }
});

test('new sentence templates preserve active, action and separate outcome words', () => {
  const call = publicCall('history_search', {query: 'sample_query'});
  assert.equal(toolLabel({...call, status: 'working'}), 'Searching this conversation for “sample_query”');
  assert.equal(toolLabel({...call, status: 'pending'}), 'Search this conversation for “sample_query”');
  for (const [status, expected] of [
    ['preparing', 'Preparing call: Search'], ['error', 'Failed: Search'], ['pending', 'Queued: Search'],
    ['ended', 'Ended without a result: Search'], ['available', 'Result available: Search'], ['missing', 'No result recorded: Search'],
  ] as const) assert.equal(toolSentence({...call, status}), `${expected} this conversation for “sample_query”`);
  assert.equal(toolLabel({...call, status: 'working', args: undefined, argumentText: '{'}), 'Preparing');
});

test('new agent sentences use public captions and keep unknown destinations unnamed', () => {
  const context = {subject: (identity: string) => identity === 'known:42' ? {text: 'Sample agent · 42', name: 'Sample agent', provenance: 'supplied' as const} : undefined};
  for (const [name, extra, verb] of [
    ['agent_profile', {action: 'read'}, 'Read the profile of'], ['agent_profile', {action: 'update'}, 'Updated the profile of'],
    ['agent_reset', {}, 'Reset'], ['agent_configure', {}, 'Changed settings of'], ['agent_fork', {}, 'Forked'],
    ['agent_rewind', {}, 'Rewound'], ['agent_compact', {}, 'Compacted'],
  ] as const) {
    assert.equal(toolLabel(publicCall(name, {sessionId: 'known:42', ...extra}), context), `${verb} Sample agent · 42`);
    assert.equal(toolLabel(publicCall(name, {sessionId: 'unknown', ...extra}), context), `${verb} another conversation`);
  }
  assert.equal(toolLabel(publicCall('agent_profile', {action: 'read', sessionId: 'unverified'}), {subject: () => ({text: 'Unverified name', name: 'Unverified name'})}), 'Read the profile of another conversation');
});

test('function name separators become words without rewriting literal arguments', () => {
  assert.equal(toolLabel(publicCall('custom')), 'Used custom');
  assert.equal(toolLabel(publicCall('some_new-tool')), 'Used some new tool');
  assert.equal(toolLabel(publicCall('mcp__srv__tool')), 'Used mcp srv tool');
  assert.equal(toolLabel(publicCall('mcp_-_srv--tool')), 'Used mcp srv tool');
  assert.equal(toolLabel(publicCall('some_new_tool')), 'Used some new tool');
  assert.equal(toolLabel(publicCall('some_new_tool', {}, 'working')), 'Using some new tool');
  assert.equal(toolLabel(publicCall('some_new_tool', {}, 'pending')), 'Use some new tool');
  assert.equal(toolLabel(publicCall('registry', {name: 'sample_resource-name'})), 'Looked up sample_resource-name');
  assert.equal(toolLabel(publicCall('history_search', {query: 'sample_query-name'})), 'Searched this conversation for “sample_query-name”');
  assert.equal(toolLabel(publicCall('clipboard_copy', {label: 'sample_label-name', content: 'unchanged'})), 'Copied to the clipboard: “sample_label-name”');
});

test('unavailable public arguments never use result data for new sentences', () => {
  const call = {...publicCall('registry', {search: 'hidden_query'}), result: [{type: 'text' as const, text: 'search: guessed_query'}]};
  assert.equal(toolLabel({...call, args: {value: {search: 'hidden_query'}, truncated: true}}), 'Checked the model and context');
  assert.equal(toolLabel({...call, args: undefined}), 'Checked the model and context');
  assert.equal(toolLabel(publicCall('history_read')), 'Read conversation entry');
  assert.equal(toolLabel(publicCall('memory_history')), 'Listed versions of memory note');
});

test('image reads use typed media without guessing a name from the storage path', () => {
  const tool:JoinedTool = {callId:'image',name:'read',owner:'entry',slot:'slot',status:'success',args:{value:{path:'/opaque/storage/digest.bin'},truncated:false},result:[{type:'image',mimeType:'image/png',digest:'a'.repeat(64),bytes:64,width:20,height:10,alt:'Not an established filename'}]};
  assert.equal(toolLabel(tool),'Read image · PNG digest.bin  /opaque/storage'); assert.equal(toolLabel({...tool,status:'working'}),'Reading image · PNG digest.bin  /opaque/storage');
  assert.equal(toolLabel({...tool,name:'custom'}),'Used custom'); assert.doesNotMatch(toolLabel(tool),/filename|Not an established/);
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
  assert.equal(toolLabel(call('post', {message: 'Round five is on'})), 'Posted to Thread · aaaaaaaa: “Round five is on”');
  assert.equal(toolLabel(call('read')), 'Read a thread'); assert.equal(toolLabel(call('join')), 'Joined a thread');
  assert.equal(toolLabel({...call('post', {message: 'Hi'}), status: 'working'}), 'Posting to Thread · aaaaaaaa: “Hi”');
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
  for (const [action, sentence] of [['post', 'Posted a message'], ['create', 'Created a thread'], ['revise', 'Revised a thread']]) {
    assert.equal(toolLabel(call('agent_collaborate', {action, message, title: message})), `${sentence}: “Done”`);
  }
  assert.equal(toolLabel(call('agent_collaborate', {action: 'post', message, threadId: 'abcdefgh12345678'})), 'Posted to Thread · 12345678: “Done”');
});
test('call quotes keep their first line after mark removal and are not cut by length', () => {
  const label = (message: unknown) => toolLabel({callId: 'q', name: 'agent_send', owner: 'e', slot: 's', status: 'success', args: {value: {sessionId: 'peer', message}, truncated: false}});
  const head = 'Sent a message to another conversation';
  assert.equal(label(`**${'a'.repeat(60)}**`), `${head}: “${'a'.repeat(60)}”`);
  assert.equal(label(`**${'a'.repeat(61)}**`), `${head}: “${'a'.repeat(61)}”`);
  assert.equal(label('## Result\r\nNext text'), `${head}: “Result”`);
  assert.equal(label(''), head); assert.equal(label(undefined), head);
  assert.equal(label(`\`${'😀'.repeat(30)}\``), `${head}: “${'😀'.repeat(30)}”`);
  assert.equal(label(`\`${'😀'.repeat(31)}\``), `${head}: “${'😀'.repeat(31)}”`);
});

test('a thread call with an unknown or missing action falls back to a generic sentence', () => {
  const call = (args: Record<string, unknown>): JoinedTool => ({callId: 'c', name: 'agent_collaborate', owner: 'e', slot: 's', status: 'success', args: {value: args, truncated: false}});
  assert.equal(toolLabel(call({action: 'rename'})), 'Used a thread'); assert.equal(toolLabel(call({})), 'Used a thread');
  assert.equal(toolLabel(call({action: 'post'})), 'Posted a message'); assert.equal(toolLabel({...call({}), args: undefined}), 'Used a thread');
});

test('a command title leaves out a leading cd and names a folder only when it is not the conversation folder', () => {
  const cwd = '/work/harness.worktrees/ui-presentation';
  const bash = (command: unknown, status: JoinedTool['status'] = 'success'): JoinedTool => ({callId: 'b', name: 'bash', owner: 'e', slot: 's', status, args: {value: {command}, truncated: false}});
  const label = (command: unknown, status: JoinedTool['status'] = 'success', context: {cwd?: string} = {cwd}) => toolLabel(bash(command, status), context);
  assert.equal(label(`cd ${cwd} && git status --short | head -20`), 'Ran git status --short | head -20');
  assert.equal(label(`cd ${cwd}/ && npm test`), 'Ran npm test');
  assert.equal(label(`cd ${cwd}; npm test`), 'Ran npm test');
  assert.equal(label('cd /elsewhere/place/harness && npm test'), 'Ran npm test in ../../../elsewhere/place/harness');
  assert.equal(label(`cd ${cwd}/ui && npm test`), 'Ran npm test in ui');
  assert.equal(label('cd "/a b/harness" && npm test'), 'Ran npm test in ../../../a b/harness');
  assert.equal(label("cd '/a b/harness'; npm test"), 'Ran npm test in ../../../a b/harness');
  assert.equal(label(`cd "${cwd}" && git log`), 'Ran git log');
  assert.equal(label('cd /elsewhere/place/harness && npm test', 'working'), 'Running npm test in ../../../elsewhere/place/harness');
  assert.equal(label(`cd ${cwd} && npm test`, 'working'), 'Running npm test');
  assert.equal(label(`cd ${cwd} && npm test`, 'pending'), 'Run npm test');
  assert.equal(toolSentence(bash(`cd ${cwd} && npm test`, 'pending'), {cwd}), 'Queued: Run npm test');
  assert.equal(toolSentence(bash('cd /elsewhere/place/harness && npm test', 'error'), {cwd}), 'Failed: Run npm test in ../../../elsewhere/place/harness');
});

test('a multi-line command folds to one title line and its arguments keep every line', () => {
  const cwd = '/work/harness';
  const tool = (command: string): JoinedTool => ({callId: 'b', name: 'bash', owner: 'e', slot: 's', status: 'success', args: {value: {command}, truncated: false}});
  const label = (command: string, context: {cwd?: string} = {cwd}) => toolLabel(tool(command), context);
  const script = 'node -e \'const fs=require("fs");\nlet s=fs.readFileSync("a","utf8");\nconsole.log(s)\'';
  assert.equal(label(script), 'Ran node -e \'const fs=require("fs"); let s=fs.readFileSync("a","utf8"); console.log(s)\'');
  assert.match(label(script), /^Ran node -e 'const fs=require/); assert.doesNotMatch(label(script), /\n/);
  assert.equal(label("python3 - <<'EOF'\nimport sys\nprint(sys.argv)\nEOF"), "Ran python3 - <<'EOF' import sys print(sys.argv) EOF");
  assert.equal(label('echo   ok\t\tnow\r\n'), 'Ran echo ok now', 'runs of white space fold and the ends are trimmed');
  assert.equal(label('echo ok'), 'Ran echo ok');
  assert.equal(label(`${'a'.repeat(100)}\n${'b'.repeat(100)}`), `Ran ${'a'.repeat(100)} ${'b'.repeat(100)}`);
  const words = ['word', ...Array.from({length: 100}, () => 'x')].join(' ');
  assert.equal(label(words.replace(/ /g, '\n  ')), `Ran ${words}`);
  assert.equal(label(`cd ${cwd}/ui && node -e 'one\ntwo'`), "Ran node -e 'one two' in ui");
  assert.equal(label(`cd /elsewhere/place/harness &&\n  npm test\n  --silent`), 'Ran npm test --silent in ../../elsewhere/place/harness');
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
  assert.equal(label(`cd ${cwd} && ${'x'.repeat(70)}`), `Ran ${'x'.repeat(70)}`);
  assert.equal(label(`cd ${cwd} && printf first\nsecond`), 'Ran printf first second');
  assert.equal(label('cd /elsewhere/place/harness && npm test', {}), 'Ran npm test in /elsewhere/place/harness');
});

const subject = (name: string, value: Record<string, unknown> = {}, cwd?: string) => toolSubjectParts(publicCall(name, value), {cwd}).map(part => part.text).join('');
test('the visible subject names what a call acts on, without a verb', () => {
  assert.equal(subject('bash', {command: 'git status --short\n  && git diff'}), 'git status --short && git diff');
  assert.deepEqual(toolSubjectParts(publicCall('bash', {command: 'npm test'})), [{text: 'npm', role: 'command'}, {text: ' test', role: 'scope'}]);
  assert.equal(subject('bash', {command: 'cd /work/app && npm test'}, '/work/app'), 'npm test');
  assert.equal(subject('bash', {command: 'x'.repeat(5000)}).length, 400);
  assert.equal(subject('read', {path: '/work/app/src/a.ts'}, '/work/app'), 'a.ts  src');
  assert.equal(subject('grep', {pattern: 'splitChunks', path: 'src'}), 'splitChunks src');
  assert.equal(subject('find', {pattern: '*.config.*'}), '*.config.*');
  assert.equal(subject('web_read', {url: 'https://vitejs.dev/guide/build.html'}), 'vitejs.dev /guide/build.html');
  assert.equal(subject('web_search', {query: 'vite build workers'}), 'vite build workers');
  assert.equal(subject('agent_spawn', {name: 'Build reviewer', prompt: 'Review it.'}), 'Build reviewer');
  assert.equal(subject('memory_read', {slug: 'web-ui-visual-direction'}), 'web-ui-visual-direction');
  assert.equal(subject('mcp__radius'), 'mcp__radius');
});
