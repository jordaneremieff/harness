import assert from 'node:assert/strict';
import test from 'node:test';
import {LIMITS} from '../shared/api.ts';
import type {CachedRoster} from '../shared/api.ts';
import {ApiError} from './errors.mts';
import type {RequestContext} from './http.mts';
import type {Registry} from './registry.mts';
import {dispatchAgent} from './routes-agent.mts';

const catalogRow = (id: string, name?: string) => ({id, storageId: id.split(':')[0], cwd: '/work', modifiedAt: 5, state: 'idle', claim: 'dead', owner: 'unknown', partial: false, ...(name ? {name} : {}), firstMessage: `Start of ${id}`});
const scan = {state: 'ready', complete: true, visited: 3, skipped: 0, omitted: 0};
const rows = new Map([['a', catalogRow('a', 'Alpha')], ['b', catalogRow('b')], ['c:2', catalogRow('c:2', 'Child')]]);
function registry() {
  const calls = {roster: [] as unknown[], row: [] as string[], lookup: [] as string[][]};
  const agents = {
    roster: (options: unknown) => {calls.roster.push(options); return {rows: [...rows.values()].slice(0, 1), nextCursor: 'next', coverage: {complete: false, omitted: 0}, observedAt: 'now', stale: false, scan};},
    rosterRow: (identity: string) => {calls.row.push(identity); return rows.get(identity);},
    lookup: async (identities: string[]) => {calls.lookup.push(identities);},
  };
  return {registry: {agents} as unknown as Registry, calls};
}
const get = (query: string): RequestContext => ({parts: ['api', 'agents'], body: {}, method: 'GET', url: new URL(`http://localhost/api/agents${query}`)});
const lookup = (target: Registry, query: string) => dispatchAgent(target, get(query)) as Promise<CachedRoster & {coverage: unknown}>;

test('an identity lookup returns the catalog rows for exactly those identities, in request order, and none for an identity the catalog lacks', async () => {
  const {registry: target, calls} = registry();
  const result = await lookup(target, '?identity=c%3A2&identity=missing&identity=a&identity=c%3A2');
  assert.deepEqual(result.rows.map(row => [row.identity, row.name]), [['c:2', 'Child'], ['a', 'Alpha']]);
  assert.deepEqual(calls.row, ['c:2', 'missing', 'a', 'missing'], 'cached identities are read once and a miss is checked after its named read');
  assert.deepEqual(calls.lookup, [['missing']]);
  assert.equal(result.nextCursor, null);
});

test('a row without a name still carries its first message for the page to use', async () => {
  const result = await lookup(registry().registry, '?identity=b');
  assert.deepEqual(result.rows.map(row => [row.identity, row.name, row.firstMessage]), [['b', undefined, 'Start of b']]);
});

test('an identity lookup cannot page and names at most the batch limit', async () => {
  const {registry: target} = registry();
  const invalid = (error: unknown) => error instanceof ApiError && error.code === 'invalid_request';
  await assert.rejects(lookup(target, '?identity=a&limit=5'), invalid);
  await assert.rejects(lookup(target, '?identity=a&cursor=abc'), invalid);
  await assert.rejects(lookup(target, '?identity='), invalid);
  const many = (count: number) => `?${Array.from({length: count}, (_, index) => `identity=id-${index}`).join('&')}`;
  await assert.rejects(lookup(target, many(LIMITS.identityLookup + 1)), invalid);
  assert.equal((await lookup(target, many(LIMITS.identityLookup))).rows.length, 0);
});

test('the roster page without an identity field still pages as before', async () => {
  const {registry: target, calls} = registry();
  const page = await lookup(target, '?limit=1');
  assert.equal(page.nextCursor, 'next'); assert.deepEqual(calls.roster, [{cursor: undefined, limit: 1}]); assert.deepEqual(calls.row, []);
});
