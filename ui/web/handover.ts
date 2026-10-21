export type HandoverPickup = {id: string; note: string; terminal: boolean};

/** Parses only the documented pickup text supplied by the user, never stored artifact content. */
export function handoverPickup(value: string): HandoverPickup | undefined {
  let text = value.trim(), terminal = false;
  const quoted = /^pi[ \t]+(["'])([\s\S]*)\1$/.exec(text);
  if (quoted) {
    terminal = true; text = quoted[2] ?? '';
    if (quoted[1] === '"') text = text.replace(/\\([\\"$`])/g, '$1');
  }
  const command = /^\/stash[ \t]+get[ \t]+([A-Za-z0-9._-]+)(?:[ \t]+([\s\S]*))?$/.exec(text);
  if (command) return {id: command[1] ?? '', note: command[2] ?? '', terminal};
  return !terminal && /^[A-Za-z0-9._-]+$/.test(text) ? {id: text, note: '', terminal: false} : undefined;
}
export function pickupInput(pickup: Pick<HandoverPickup, 'id' | 'note'>): string {
  return `/stash get ${pickup.id}${pickup.note ? ` ${pickup.note}` : ''}`;
}
/** Double quotes retain the familiar terminal form; shell expansion characters stay literal. */
export function pickupTerminal(pickup: Pick<HandoverPickup, 'id' | 'note'>): string {
  return `pi "${pickupInput(pickup).replace(/[\\"$`]/g, '\\$&')}"`;
}
