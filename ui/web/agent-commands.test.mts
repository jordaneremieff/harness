import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentCommandList } from '../shared/api.ts';
import { AgentCommandInventory, COMMAND_RETRY_MS, type CommandSource } from './agent-commands.ts';

const list: AgentCommandList = {items: [{name: 'ping', description: 'Reply', source: 'alpha'}], incomplete: false};
const live: CommandSource = {live: true, supported: true, epoch: 3};
const turn = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function fixture(load: () => Promise<AgentCommandList> = async () => list) {
  let clock = 0, loads = 0, changes = 0;
  const inventory = new AgentCommandInventory(async () => { loads++; return load(); }, () => { changes++; }, () => clock);
  return {inventory, loads: () => loads, changes: () => changes, advance: (ms: number) => { clock += ms; }};
}
test('the first deliberate slash loads the list once and the same connection epoch reuses it', async () => {
  const f = fixture();
  assert.equal(f.inventory.inventory(live, false).state, 'loading'); assert.equal(f.loads(), 0, 'a read that is not a slash never requests');
  assert.equal(f.inventory.inventory(live, true).state, 'loading'); assert.equal(f.inventory.inventory(live, true).state, 'loading'); assert.equal(f.loads(), 1);
  await turn(); assert.equal(f.changes(), 1);
  const ready = f.inventory.inventory(live, true); assert.equal(ready.state, 'ready'); assert.deepEqual(ready.items, list.items);
  const first = ready.items[0]; assert.ok(first); first.name = 'changed'; assert.equal(f.inventory.inventory(live, false).items[0]?.name, 'ping', 'callers cannot change the cached list');
  f.inventory.inventory(live, true); assert.equal(f.loads(), 1);
});
test('a new connection epoch, a lost host and an unsupported host each drop the cached list', async () => {
  const f = fixture(); f.inventory.inventory(live, true); await turn();
  assert.equal(f.inventory.inventory({...live, epoch: 4}, false).state, 'loading'); f.inventory.inventory({...live, epoch: 4}, true); assert.equal(f.loads(), 2);
  await turn();
  const stored = f.inventory.inventory({live: false, supported: true, epoch: 4}, true);
  assert.equal(stored.state, 'unavailable'); assert.equal(stored.message, 'Start the agent to run commands.'); assert.equal(f.loads(), 2);
  const none = f.inventory.inventory({live: true, supported: false, epoch: 4}, true);
  assert.equal(none.state, 'unavailable'); assert.equal(none.message, 'This agent host does not offer commands this UI supports.');
  assert.equal(f.inventory.inventory(live, true).state, 'loading'); assert.equal(f.loads(), 3, 'a live host asks again after a lost one');
});
test('a failed read says so and is tried again only by a later deliberate slash after the retry delay', async () => {
  let fail = true; const f = fixture(async () => { if (fail) throw new Error('Host unavailable.'); return list; });
  f.inventory.inventory(live, true); await turn();
  const failed = f.inventory.inventory(live, true); assert.equal(failed.state, 'unavailable'); assert.match(failed.message ?? '', /^Commands could not be read\. Host unavailable\./);
  for (let index = 0; index < 5; index++) f.inventory.inventory(live, true); assert.equal(f.loads(), 1, 'keystrokes do not repeat a failed read');
  f.advance(COMMAND_RETRY_MS); assert.equal(f.inventory.inventory(live, false).state, 'unavailable'); assert.equal(f.loads(), 1, 'only a slash retries');
  fail = false; assert.equal(f.inventory.inventory(live, true).state, 'loading'); await turn();
  assert.equal(f.inventory.inventory(live, true).state, 'ready'); assert.equal(f.loads(), 2);
});
test('an answer from a dropped epoch changes nothing', async () => {
  let release: (value: AgentCommandList) => void = () => {}; const f = fixture(() => new Promise<AgentCommandList>(resolve => { release = resolve; }));
  f.inventory.inventory(live, true); f.inventory.inventory({...live, epoch: 9}, false); release(list); await turn();
  assert.equal(f.changes(), 0); assert.equal(f.inventory.inventory({...live, epoch: 9}, false).state, 'loading');
});
test('incomplete lists keep their mark', async () => {
  const f = fixture(async () => ({...list, incomplete: true})); f.inventory.inventory(live, true); await turn();
  assert.equal(f.inventory.inventory(live, true).incomplete, true);
});
