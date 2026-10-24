import assert from 'node:assert/strict';
import test from 'node:test';
import {toolKind, toolKindIcon, toolKindName} from './tool-kind.ts';

test('every tool belongs to one kind with an icon and a spoken name', () => {
  const expected: Record<string, string> = {bash: 'shell', read: 'read', edit: 'edit', write: 'edit', grep: 'search', find: 'search', web_search: 'web', web_read: 'web', agent_send: 'agent', agent_await: 'agent', memory_search: 'memory', stash_write: 'memory', history_read: 'memory', mcp__radius: 'other', custom: 'other', toString: 'other'};
  for (const [name, kind] of Object.entries(expected)) assert.equal(toolKind(name), kind, name);
  for (const kind of ['shell', 'read', 'edit', 'search', 'web', 'agent', 'memory', 'other'] as const) {
    assert.ok(toolKindIcon(kind)); assert.match(toolKindName(kind), /^[A-Z][a-z]+$/);
  }
});
