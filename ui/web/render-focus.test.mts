import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
import {Transcript} from './render.ts';
import type {EntryView, PartView} from '../shared/api.ts';
const browser = await createAppFixture();

test('retained message controls keep focus and identity and show current tool output without obsolete prose in either row order', async () => {
  for (const order of ['before', 'after'] as const) {
    const root = new browser.HostNode('div'), latest = new browser.HostNode('button'); browser.hostDocument.body.append(root, latest);
    const view = new Transcript({transcript: root as unknown as HTMLElement, latest: latest as unknown as HTMLElement}, {reading() {}, presentation() {}});
    const source = (prose: boolean): EntryView => {
      const tools: PartView[] = [{type: 'toolCall', callId: 'current-call', name: 'custom', arguments: {value: {}, truncated: false}},
        {type: 'toolResult', callId: 'current-call', name: 'custom', isError: false, parts: [{type: 'text', text: prose ? 'Prior result' : 'Current tool output'}]}];
      const text: PartView = {type: 'text', text: 'Obsolete prose'};
      return {id: `current-${order}`, kind: 'message', messages: [{id: 'current-message', role: 'assistant', state: 'final', coverage: browser.coverage,
        parts: prose ? order === 'before' ? [text, ...tools] : [...tools, text] : tools}]};
    };
    view.set([source(true)]); await browser.settle();
    const message = root.querySelector('.message'), menu = message?.querySelector('.message-menu'); assert.ok(message); assert.ok(menu);
    menu.focus(); view.set([source(false)]); await browser.settle();
    assert.equal(browser.hostDocument.activeElement, menu); assert.equal(root.querySelector('.message'), message);
    assert.doesNotMatch(message.textContent, /Obsolete prose|Prior result/); assert.equal(root.querySelectorAll('.tool-shell').length, 1);
    view.set([]); await browser.settle(); assert.equal(root.querySelector('.message-actions'), null);
    view.reset(); root.remove(); latest.remove();
  }
});
