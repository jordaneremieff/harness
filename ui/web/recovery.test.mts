import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Snapshot, TargetIndex, UnconfirmedInput } from '../shared/api.ts';
import { exactInput, recoveryName, Recovery } from './recovery.ts';
const originalFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch = originalFetch;});
const input: UnconfirmedInput = {operationId: 'copy', target: {kind: 'primary', key: 'p', epoch: 1}, text: 'exact whitespace\n  ', mode: 'prompt', submittedDraftRevision: 3, createdAt: '2026-10-08T12:00:00Z', reason: 'unconfirmed'};
test('an exact retained copy needs no fetch and preserves whitespace', async () => {
  globalThis.fetch = async () => {throw new Error('unneeded fetch');};
  assert.equal(await exactInput('workspace', input), input);
});
test('a shortened snapshot preview fetches its exact captured target copy', async () => {
  globalThis.fetch = async path => {
    assert.equal(path, '/api/workspaces/workspace/unconfirmed/copy');
    return Response.json({ok: true, data: input});
  };
  assert.deepEqual(await exactInput('workspace', {...input, text: 'preview', textTruncated: true}), input);
});
test('exact-copy failure never presents the preview as the complete text', async () => {
  globalThis.fetch = async () => Response.json({ok: false, error: {code: 'unknown_operation', message: 'Copy unavailable', retry: 'read'}}, {status: 404});
  await assert.rejects(exactInput('workspace', {...input, textTruncated: true}), /Copy unavailable/);
});

test('saved-draft list renders each exact preview as inert text with separate counts and truncation disclosure', async t => {
  class Node extends EventTarget {
    children: Node[] = []; className = ''; title = ''; attrs: Record<string, string> = {}; private text = '';
    readonly tag: string; constructor(tag: string) {super(); this.tag = tag;}
    set textContent(value: string) {this.text = value; this.children = [];}
    get textContent(): string {return this.text + this.children.map(child => child.textContent).join('');}
    append(...nodes: Node[]) {this.children.push(...nodes);}
    setAttribute(key: string, value: string) {this.attrs[key] = value;}
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'); t.after(() => {if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new Node(tag)}});
  const body = new Node('div'); let token = 0;
  const modal = {body, get token() {return token;}, open() {token++; body.textContent = '';}, owns(value: number) {return token === value;}, async run(fn: () => Promise<void>) {await fn();}};
  const text = ' exact\n  <script>saved draft</script> ';
  const target = {targetKey: 'draft-key', target: {kind: 'agent', identity: 'exact-agent'}, draftRevision: 7, hasDraft: true, draftPreview: text, draftPreviewTruncated: true, unconfirmedOperationIds: ['pending']} as TargetIndex;
  const snapshot = {workspace: {id: 'w'}, targetIndex: [target], roster: {rows: [{identity: 'exact-agent', name: 'Exact saved owner'}]}} as Snapshot;
  const recovery = new Recovery({snapshot: () => snapshot, reload: async () => {}, modal: modal as unknown as import('./modal.ts').Modal}); recovery.open(); await Promise.resolve(); await Promise.resolve();
  const row = body.children.find(node => node.className === 'options recovery-targets')?.children[0]; assert.ok(row);
  const content = row.children[0]; assert.equal(content.children[0].textContent, 'Exact saved owner'); assert.equal(content.children[1].textContent, text); assert.equal(content.children[1].tag, 'span');
  assert.equal(content.children[2].textContent, 'Preview shortened.'); assert.equal(row.children[1].textContent, 'Saved draft · 1 unconfirmed message'); assert.equal(row.attrs['aria-description'], 'Agent exact-agent');
});
test('saved draft rows use exact conversation names without borrowing a newer epoch', () => {
  const index = {targetKey:'draft-key', target:{kind:'primary',key:'p',epoch:7},hasDraft:true,unconfirmedOperationIds:[]} as TargetIndex;
  const snapshot = {primaries:[{key:'p',epoch:7,sessionName:'Parser cleanup'}],roster:{rows:[{identity:'agent-a',name:'Parser research'}]}} as Snapshot;
  assert.equal(recoveryName(index,snapshot),'Parser cleanup');
  assert.equal(recoveryName({...index,target:{kind:'primary',key:'p',epoch:6}},snapshot),'Primary conversation 6');
  assert.equal(recoveryName({...index,target:{kind:'agent',identity:'agent-a'}},snapshot),'Parser research');
  assert.equal(recoveryName({...index,target:{kind:'agent',identity:'other-agent'}},snapshot),'Agent');
});
