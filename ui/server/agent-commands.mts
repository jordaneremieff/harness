import { RESERVED_COMMANDS } from '../agents/contract.mts';
import type { HostInventory } from '../agents/index.mts';
import { COMMAND_RESULT_BYTES } from '../shared/api.ts';
import type { AgentCommandList } from '../shared/api.ts';
import { safeText } from './projection.mts';

const MAX_COMMANDS = 512;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

/** Flattens a host inventory for the slash list. Names the UI cannot send, reserved host commands and repeats are left out; a cut or a skipped entry marks the list incomplete. */
export function projectCommandList(inventory: HostInventory): AgentCommandList {
  const items: AgentCommandList['items'] = [], seen = new Set<string>();
  let incomplete = (inventory.failed?.length ?? 0) > 0;
  for (const contribution of inventory.contributions) {
    const source = safeText(contribution.name, 128);
    for (const command of contribution.commands) {
      if (RESERVED_COMMANDS.includes(command.name) || seen.has(command.name)) continue;
      if (!NAME.test(command.name) || items.length >= MAX_COMMANDS) { incomplete = true; continue; }
      seen.add(command.name); items.push({name: command.name, description: safeText(command.description, 400), source});
    }
  }
  return {items, incomplete};
}
/** Keeps the first bytes of a command result on a character boundary. The result is shown once, so it is cut rather than paged. */
export function boundCommandResult(text: string): {text: string; truncated: boolean} {
  const clean = safeText(text, Number.MAX_SAFE_INTEGER);
  const bytes = Buffer.from(clean);
  if (bytes.length <= COMMAND_RESULT_BYTES) return {text: clean, truncated: false};
  let end = COMMAND_RESULT_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {text: bytes.subarray(0, end).toString('utf8'), truncated: true};
}
