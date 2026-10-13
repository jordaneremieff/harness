import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {AgentError} from '../agents/index.mts';
import {RpcError} from '../rpc/client.mts';
import {execute} from './dispatch.mts';
import {Operations} from './operations.mts';
import type {Registry} from './registry.mts';
import {StateStore} from './state.mts';

for (const ErrorType of [RpcError, AgentError]) {
  test(`${ErrorType.name} preserves explicit uncertainty for image refusal codes`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'ui-dispatch-errors-')); const store = await StateStore.open(root);
    t.after(async () => {await store.close(); await rm(root, {recursive: true, force: true});});
    const operations = new Operations(store); const registry = {store, operations, options: {}} as Registry;
    const workspaceId = (await store.workspace()).id;
    for (const code of ['image_unavailable', 'image_storage_unavailable', 'payload_too_large', 'host_unavailable']) {
      if (code === 'host_unavailable' && ErrorType === RpcError) continue;
      for (const uncertain of [false, true]) {
        const target = {kind: 'primary' as const, key: 'fixture', epoch: 1};
        const operation = await operations.reserve(workspaceId, 'primary.control', target);
        const result = await execute(registry, operation.id, {workspaceId, kind: 'primary.control', target, body: {action: 'stats'}},
          async () => {throw new ErrorType(code, 'Native input refusal.', uncertain);});
        assert.equal(result.state, uncertain ? 'uncertain' : 'rejected', `${code}:${uncertain}`);
      }
    }
  });
}
