import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { RecoveryInput, Snapshot, TargetIndex, TargetState, UnconfirmedInput } from '../shared/api.ts';
import { exactInput, recoveryName, Recovery } from './recovery.ts';
const originalFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch = originalFetch;});
const input: UnconfirmedInput = {admission: 'unconfirmed', images: [], operationId: 'copy', target: {kind: 'primary', key: 'p', epoch: 1}, text: 'exact whitespace\n  ', mode: 'prompt', submittedDraftRevision: 3, createdAt: '2026-10-08T12:00:00Z', reason: 'unconfirmed'};
test('a complete preview still fetches the authoritative recovery disposition and whitespace', async () => {
  globalThis.fetch = async () => Response.json({ok: true, data: input});
  assert.deepEqual(await exactInput('workspace', input), input);
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

class Node extends EventTarget {
    children: Node[] = []; className = ''; title = ''; attrs: Record<string, string> = {}; private text = '';
    readonly tag: string; constructor(tag: string) {super(); this.tag = tag;}
    set textContent(value: string) {this.text = value; this.children = [];}
    get textContent(): string {return this.text + this.children.map(child => child.textContent).join('');}
    append(...nodes: Node[]) {this.children.push(...nodes);}
    prepend(...nodes: Node[]) {this.children.unshift(...nodes);}
    setAttribute(key: string, value: string) {this.attrs[key] = value;}
    replaceChildren(...nodes: Node[]) {this.text = ''; this.children = nodes;}
    all(predicate: (node: Node) => boolean): Node[] {return [...(predicate(this) ? [this] : []), ...this.children.flatMap(node => node.all(predicate))];}
    querySelector(selector: string): Node | undefined {return this.all(node => node.className.split(' ').includes(selector.slice(1)))[0];}
  }

test('saved-draft list renders each exact preview as inert text with separate counts and truncation disclosure', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'); t.after(() => {if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new Node(tag)}});
  const body = new Node('div'); let token = 0;
  const modal = {body, get token() {return token;}, open() {token++; body.textContent = '';}, owns(value: number) {return token === value;}, async run(fn: () => Promise<void>) {await fn();}};
  const text = ' exact\n  <script>saved draft</script> ';
  const target = {targetKey: 'draft-key', target: {kind: 'agent', identity: 'exact-agent'}, draftRevision: 7, hasDraft: true, draftPreview: text, draftPreviewTruncated: true, unconfirmedOperationIds: ['pending'], retainedInputOperationIds: []} as TargetIndex;
  const snapshot = {workspace: {id: 'w'}, targetIndex: [target], roster: {rows: [{identity: 'exact-agent', name: 'Exact saved owner'}]}} as Snapshot;
  const recovery = new Recovery({snapshot: () => snapshot, reload: async () => {}, modal: modal as unknown as import('./modal.ts').Modal}); recovery.open(); await Promise.resolve(); await Promise.resolve();
  const row = body.children.find(node => node.className === 'options recovery-targets')?.children[0]; assert.ok(row);
  const content = row.children[0]; assert.equal(content.children[0].textContent, 'Exact saved owner'); assert.equal(content.children[1].textContent, text); assert.equal(content.children[1].tag, 'span');
  assert.equal(content.children[2].textContent, 'Preview shortened.'); assert.equal(row.children[1].textContent, 'Saved draft · 1 unconfirmed message'); assert.equal(row.attrs['aria-description'], 'Agent exact-agent');
});
test('recovery discovers all indexed copies and reads full tuples before disposition-specific actions', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'); t.after(() => {if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new Node(tag), createElementNS: (_ns: string, tag: string) => new Node(tag)}});
  const body = new Node('div'), pending: Promise<void>[] = []; let token = 0, confirm: (() => Promise<void>) | undefined;
  const modal = {body, get token() {return token;}, open() {token++; body.textContent = '';}, owns(value: number) {return token === value;}, run(fn: () => Promise<void>) {const result = fn(); pending.push(result); return result;}, confirm(_title: string, _text: string, action: () => Promise<void>) {confirm = action;}};
  const drain = async () => {while (pending.length) await Promise.all(pending.splice(0));};
  const images = [{name: 'one.png', digest: 'a'.repeat(64), mimeType: 'image/png' as const, bytes: 67, width: 1, height: 1}], target = {kind: 'agent' as const, identity: 'owner'};
  const copies = ['unconfirmed', 'queued-image', 'handled-image', 'refused'].map((admission, i) => ({...input, target, images, operationId: `copy-${i}`, admission, text: `complete ${i}
  `, receipt: {kind: 'rpc', disposition: 'queued'}, error: {code: 'unsupported', message: 'Refused input', retry: 'none'}} as RecoveryInput));
  const saved: TargetState = {targetKey: 'owner-key', target, draft: {revision: 4, text: '', mode: 'followUp', images: [], persisted: true}, reading: {revision: 0, anchorId: null, offsetPx: 0, followTail: true}, unconfirmed: [copies[0] as UnconfirmedInput], retainedInputs: [], imageAvailability: [], recoveryPreviewTruncated: true};
  const snapshot = {workspace: {id: 'w'}, roster: {rows: []}, targetIndex: [{targetKey: saved.targetKey, target, hasDraft: false, draftRevision: 4, unconfirmedOperationIds: ['copy-0'], retainedInputOperationIds: copies.slice(1).map(item => item.operationId)}]} as Snapshot;
  const calls: {path: string; method: string; body: unknown}[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url), method = init?.method ?? 'GET'; calls.push({path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined});
    const value = path.endsWith('/targets/owner-key') ? saved : path.endsWith('/restore') ? {...saved.draft, revision: 5, text: copies[1].text, images} : copies.find(item => path.endsWith(`/${item.operationId}`));
    return Response.json({ok: true, data: value ?? {}});
  };
  new Recovery({snapshot: () => snapshot, reload: async () => {}, modal: modal as unknown as import('./modal.ts').Modal}).open(); await drain();
  body.all(node => node.className === 'recovery-target')[0].dispatchEvent(new Event('click')); await drain();
  const rows = body.all(node => node.tag === 'section'); assert.equal(rows.length, 4); assert.match(body.textContent, /previews are omitted/);
  for (const row of rows) {row.all(node => node.textContent === 'Review saved copy')[0].dispatchEvent(new Event('click')); await drain();}
  assert.deepEqual(calls.filter(call => call.method === 'GET' && call.path.includes('/unconfirmed/')).map(call => call.path.split('/').at(-1)), copies.map(item => item.operationId));
  for (const [i, row] of rows.entries()) {assert.match(row.textContent, new RegExp(`complete ${i}`)); assert.match(row.textContent, /one.png/); assert.ok(row.all(node => node.attrs['aria-label'] === 'Copy text only').length);}
  assert.match(rows[1].textContent, /Current queue membership is unknown/); assert.match(rows[2].textContent, /Image delivery is not confirmed/);
  assert.equal(rows[3].all(node => node.textContent === 'Admission receipt').length, 0); assert.match(rows[3].textContent, /Message not sent/);
  rows[1].all(node => node.textContent === 'Restore to this draft')[0].dispatchEvent(new Event('click')); await drain();
  assert.deepEqual(calls.at(-1), {path: '/api/workspaces/w/unconfirmed/copy-1/restore', method: 'POST', body: {expectedDraftRevision: 4}}); assert.match(rows[1].textContent, /No message was sent/);
  rows[0].all(node => node.textContent === 'Retry original message…')[0].dispatchEvent(new Event('click')); assert.ok(confirm); await confirm(); await drain();
  assert.ok(calls.some(call => call.path === '/api/operations/copy-0/reconcile' && JSON.stringify(call.body) === '{"retry":true}')); assert.equal(calls.some(call => call.path.includes('/inputs')), false);
});
test('saved draft rows use exact conversation names without borrowing a newer epoch', () => {
  const index = {targetKey:'draft-key', target:{kind:'primary',key:'p',epoch:7},hasDraft:true,unconfirmedOperationIds:[],retainedInputOperationIds:[]} as TargetIndex;
  const snapshot = {primaries:[{key:'p',epoch:7,sessionName:'Parser cleanup'}],roster:{rows:[{identity:'agent-a',name:'Parser research'}]}} as Snapshot;
  assert.equal(recoveryName(index,snapshot),'Parser cleanup');
  assert.equal(recoveryName({...index,target:{kind:'primary',key:'p',epoch:6}},snapshot),'Primary conversation 6');
  assert.equal(recoveryName({...index,target:{kind:'agent',identity:'agent-a'}},snapshot),'Parser research');
  assert.equal(recoveryName({...index,target:{kind:'agent',identity:'other-agent'}},snapshot),'Agent');
});
