import assert from 'node:assert/strict';
import test from 'node:test';
import type {ThreadEventView, ThreadPageView} from '../shared/api.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {ThreadReader} from './threads-view.ts';

const {hostDocument, HostResizeObserver, settle} = await createAppFixture();
const event = (sequence: number, kind = 'contribution'): ThreadEventView => ({sequence, kind, at: 1000, sender: 'builder', origin: 'model', message: 'Exact post', source: '', replyTo: null, revision: 1, notify: []});
const page: ThreadPageView = {storageId: 'root', events: [event(1), event(2, 'carried-authority')], nextBefore: null, pending: 0, coverage: {complete: true}, observedAt: '',
  thread: {id: 'root/thread', title: 'Plan', purpose: 'Read the purpose first', authority: 'Operator', source: 'Decision', restrictions: 'Read only', acceptance: 'All facts remain', integrator: 'builder', creator: 'builder', createdAt: 1000, updatedAt: 1000, revision: 1, closed: false, sequence: 2,
    members: [{identity: 'builder', contribution: 'Build the reader', joinedAt: 1000}]}};
function readerAt(initialWidth: number) {
  let width = initialWidth;
  const opened: string[] = [];
  const reader = new ThreadReader({page: async id => ({...page, thread: {...page.thread, id}}), name: () => 'Builder with a long name', openMember: identity => {opened.push(identity);}, back() {},
    profile: () => ({handle: '@builder', role: 'Build the reader', model: {provider: 'sample', modelId: 'long-model-name', thinkingLevel: 'high'}})});
  const node = reader.node as unknown as HostNode, scroller = reader.scrollNode as unknown as HostNode;
  const rect = scroller.getBoundingClientRect.bind(scroller);
  scroller.getBoundingClientRect = () => ({...rect(), width, right: width});
  hostDocument.body.append(node);
  const members = () => {const value = node.querySelector('.thread-members'); assert.ok(value); return value;};
  const resize = (next: number) => {
    width = next;
    for (const observer of HostResizeObserver.instances) if (observer.observed.has(node)) observer.callback();
  };
  return {reader, node, members, resize, opened, close() {reader.destroy(); node.remove();}};
}

test('Participants starts closed in narrow readers, stays open wide, and retains the narrow choice across resize and navigation', async t => {
  const view = readerAt(390); t.after(() => view.close());
  view.reader.open({id: page.thread.id}); await settle();
  assert.equal(view.members().open, false);
  assert.equal(view.members().querySelector('summary')?.textContent, 'Participants · 1');
  assert.equal(view.members().querySelector('summary')?.tabIndex, 0);
  assert.match(view.node.querySelector('.thread-purpose')?.textContent ?? '', /Read the purpose first/);
  view.resize(1000); assert.equal(view.members().open, true); assert.equal(view.members().querySelector('summary')?.tabIndex, -1);
  view.members().querySelector('summary')?.click(); assert.equal(view.members().open, true);
  assert.equal(view.reader.captureReload().participants, false);
  view.resize(999); assert.equal(view.members().open, false);
  view.members().querySelector('summary')?.click(); assert.equal(view.members().open, true);
  view.resize(1200); view.resize(390); assert.equal(view.members().open, true);
  view.reader.close(); view.reader.open({id: 'root/other'}); await settle(); assert.equal(view.members().open, true);
  view.members().querySelector('summary')?.click(); assert.equal(view.members().open, false);
  view.reader.close(); view.reader.open({id: page.thread.id}); await settle(); assert.equal(view.members().open, false);
});

test('reload captures the narrow choice rather than the forced wide state, and restores it at either width', async t => {
  const source = readerAt(1200); t.after(() => source.close());
  source.reader.open({id: page.thread.id}); await settle();
  for (const expanded of [false, true]) {
    source.resize(390);
    if (source.members().open !== expanded) source.members().querySelector('summary')?.click();
    source.resize(1200); assert.equal(source.members().open, true);
    const checkpoint = source.reader.captureReload(); assert.equal(checkpoint.participants, expanded);
    for (const width of [390, 1200]) {
      const restored = readerAt(width);
      try {
        restored.reader.restoreReload(checkpoint);
        assert.equal(restored.members().open, width >= 1000 || expanded);
        assert.equal(restored.reader.captureReload().participants, expanded);
        restored.resize(390); assert.equal(restored.members().open, expanded);
        restored.resize(1200); assert.equal(restored.members().open, true);
      } finally {restored.close();}
    }
  }
});

test('collapsed participants retain every fact and link, and post headers retain sender, profile, time, authority and anchor controls', async t => {
  const view = readerAt(390); t.after(() => view.close());
  view.reader.open({id: page.thread.id}); await settle();
  assert.equal(view.members().open, false);
  for (const fact of ['Builder with a long name', '@builder · sample/long-model-name · high', 'Build the reader', 'Holds: Build the reader', '2 posts here']) assert.ok(view.members().textContent.includes(fact), fact);
  view.members().querySelector('summary')?.click();
  view.members().querySelector('.thread-person')?.click(); assert.deepEqual(view.opened, ['builder']);
  for (const sequence of [1, 2]) {
    const head = view.node.querySelector(`#thread-post-${sequence} .thread-event-head`); assert.ok(head);
    assert.equal(head.querySelector('.thread-sender')?.textContent, 'Builder with a long name');
    assert.equal(head.querySelector('.thread-author-profile')?.textContent, '@builder · sample/long-model-name · high');
    assert.ok(head.querySelector('.thread-time')?.title);
    assert.equal(head.querySelector('.thread-anchor')?.textContent, `#${sequence}`);
    assert.equal(head.querySelector('.thread-anchor')?.title, `Copy post #${sequence} anchor`);
    assert.equal(head.querySelector('.thread-kind')?.textContent, sequence === 2 ? 'Carried authority' : undefined);
    head.querySelector('.thread-sender')?.click();
  }
  assert.deepEqual(view.opened, ['builder', 'builder', 'builder']);
});
