import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRow } from '../shared/api.ts';
import { IdentityLookup } from './identity-lookup.ts';

const row = (identity: string, name?: string): AgentRow => ({identity, storageId: identity, cwd: '/w', modifiedAt: 0, state: 'idle', owner: 'unknown', availability: 'stored', partial: false, ...(name ? {name} : {})});
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(known: string[] = [], catalog: AgentRow[] = []) {
  const calls: string[][] = []; let changes = 0, failing = false;
  const lookup = new IdentityLookup(async identities => {
    calls.push(identities); if (failing) throw new Error('offline');
    return catalog.filter(item => identities.includes(item.identity));
  }, () => { changes++; }, identity => known.includes(identity));
  return {lookup, calls, changes: () => changes, fail: (value: boolean) => { failing = value; }};
}

test('identities wanted in one turn go in one request and a loaded identity goes in none', async () => {
  const {lookup, calls, changes} = setup(['loaded'], [row('a', 'Alpha')]);
  lookup.want('a'); lookup.want('b'); lookup.want('a'); lookup.want('loaded');
  assert.deepEqual(calls, []);
  await turn();
  assert.deepEqual(calls, [['a', 'b']]);
  assert.equal(lookup.get('a')?.name, 'Alpha'); assert.equal(changes(), 1); assert.equal(lookup.revision, 1);
  assert.deepEqual([...lookup.rows()].map(item => item.identity), ['a']);
});

test('at most 16 identities go in one request', async () => {
  const {lookup, calls} = setup();
  for (let index = 0; index < 40; index++) lookup.want(`id-${index}`);
  await turn();
  assert.deepEqual(calls.map(batch => batch.length), [16, 16, 8]);
  assert.equal(new Set(calls.flat()).size, 40);
});

test('an identity the server does not hold is not asked again until forget', async () => {
  const {lookup, calls, changes} = setup([], [row('named', 'Named')]);
  lookup.want('named'); lookup.want('missing'); await turn();
  assert.equal(lookup.get('missing'), undefined); assert.equal(changes(), 1);
  lookup.want('missing'); lookup.want('named'); await turn();
  assert.equal(calls.length, 1);
  lookup.forget(); lookup.want('missing'); lookup.want('named'); await turn();
  assert.deepEqual(calls, [['named', 'missing'], ['missing']]);
});

test('a failed request leaves its identities asked until forget and never reports a change', async () => {
  const {lookup, calls, changes, fail} = setup([], [row('a', 'Alpha')]);
  fail(true); lookup.want('a'); await turn();
  lookup.want('a'); await turn();
  assert.equal(calls.length, 1); assert.equal(changes(), 0);
  fail(false); lookup.forget(); lookup.want('a'); await turn();
  assert.equal(calls.length, 2); assert.equal(lookup.get('a')?.name, 'Alpha'); assert.equal(changes(), 1);
});

test('a row the server returns for an identity that was not asked is ignored', async () => {
  const lookup = new IdentityLookup(async () => [row('other', 'Other')], () => {}, () => false);
  lookup.want('asked'); await turn();
  assert.equal(lookup.get('other'), undefined); assert.equal(lookup.revision, 0);
});
