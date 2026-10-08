import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { UnconfirmedInput } from '../shared/api.ts';
import { exactInput } from './recovery.ts';
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
