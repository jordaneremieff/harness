import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import test from 'node:test';
import ts from 'typescript';
import { Journal, type Measure } from './journal.mts';

type Span = {stage: string; id: string; at: number; bytes?: number};
class Sink extends EventEmitter {
  writableLength = 0; writable = true; writes: string[] = [];
  get http() { return this as unknown as ServerResponse; }
  writeHead() {} flushHeaders() {} end() {}
  write(wire: string) { this.writes.push(wire); return this.writable; }
}

test('deterministic burst publishes and measures every delta before returning', context => {
  let clock = 0; context.mock.method(performance, 'now', () => ++clock);
  const spans: Span[] = [];
  const measure: Measure = (stage, id, at, bytes) => { spans.push({stage, id, at, bytes}); };
  const journal = new Journal(undefined, measure); const sink = new Sink();
  journal.attach(sink.http, 'a', 'session', journal.cursor); spans.length = 0; sink.writes.length = 0;
  const cut = journal.cursor; const ids: string[] = [];
  for (let i = 0; i < 512; i++) {
    const receipt = ++clock;
    const id = journal.publish('primary.delta', {kind: 'primary', key: 'p', epoch: 1}, {messageId: 'm', index: 0, kind: 'text', delta: `Δ${i}`});
    const returned = ++clock; ids.push(id);
    const event = spans.slice(-2);
    assert.deepEqual(event.map(s => [s.stage, s.id]), [['sse.enqueue', id], ['sse.write', id]]);
    assert.ok(event.every(s => s.at > receipt && s.at < returned));
    assert.equal(event[0]?.bytes, Buffer.byteLength(sink.writes[i] ?? ''));
    assert.equal(event[1]?.bytes, event[0]?.bytes);
    assert.equal(sink.writes.length, i + 1);
  }
  assert.deepEqual(journal.replay(cut, 'a').records.map(r => r.id), ids);
  assert.equal(spans.length, ids.length * 2); journal.close();
});

test('drain instrumentation correlates each queued write to its own event ID', context => {
  let clock = 0; context.mock.method(performance, 'now', () => ++clock);
  const spans: Span[] = []; const sink = new Sink();
  const journal = new Journal(undefined, (stage, id, at, bytes) => spans.push({stage, id, at, bytes}));
  journal.attach(sink.http, 'a', 'session', journal.cursor); spans.length = 0; sink.writes.length = 0;
  sink.writable = false;
  const ids = Array.from({length: 4}, (_, i) => journal.publish('notice', undefined, {level: 'info', message: `event ${i}`}));
  assert.deepEqual(spans.filter(s => s.stage === 'sse.enqueue').map(s => s.id), ids);
  assert.deepEqual(spans.filter(s => s.stage === 'sse.write').map(s => s.id), [ids[0]]);
  sink.writable = true; sink.emit('drain');
  assert.deepEqual(spans.filter(s => s.stage === 'sse.write').map(s => s.id), ids);
  for (const id of ids) {
    const enqueue = spans.find(s => s.stage === 'sse.enqueue' && s.id === id);
    const write = spans.find(s => s.stage === 'sse.write' && s.id === id);
    assert.ok(enqueue && write); assert.ok(write.at >= enqueue.at); assert.equal(write.bytes, enqueue.bytes);
  }
  journal.close();
});

test('publish and per-client delivery contain no timers, source scans, or replay scans', async () => {
  const source = await readFile(new URL('./journal.mts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('journal.mts', source, ts.ScriptTarget.Latest, true);
  const hot = new Set(['publish', 'enqueue', 'flush']); const found = new Set<string>(); const forbidden: string[] = [];
  const calls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(tree);
      if (/^(?:setTimeout|setInterval|replay|readdir|opendir|readFile|stat|lstat|exec|spawn|filter|sort|map|flatMap)/.test(name)) forbidden.push(name);
    }
    if (ts.isAwaitExpression(node)) forbidden.push('await');
    ts.forEachChild(node, calls);
  };
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && hot.has(node.name.getText(tree))) {
      found.add(node.name.getText(tree)); if (node.body) calls(node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.deepEqual([...found].sort(), [...hot].sort()); assert.deepEqual(forbidden, []);
});
