export type CommandOption = {name: string; description: string; source: string};
export type CommandInventory = {items: CommandOption[]; state: 'ready' | 'loading' | 'unavailable'; incomplete?: boolean};
export type CommandMatch = {item: CommandOption; rank: number; marks: number[]};
export type CommandToken = {name: string; end: number};
export type MenuState = {token?: CommandToken; matches: CommandMatch[]; open: boolean; active: number; suppressed?: string; inventory: CommandInventory['state']; incomplete?: boolean};
export const emptyMenu = (): MenuState => ({matches: [], open: false, active: 0, inventory: 'unavailable'});
export function commandToken(text: string, start: number, end = start): CommandToken | undefined {
  if (!text.startsWith('/') || start !== end || start < 1) return undefined;
  const tokenEnd = text.search(/\s/); const boundary = tokenEnd < 0 ? text.length : tokenEnd;
  if (start > boundary) return undefined;
  return {name: text.slice(1, boundary), end: boundary};
}
function sequence(name: string, query: string): number[] | undefined {
  const marks: number[] = []; let from = 0;
  for (const char of query) { const index = name.indexOf(char, from); if (index < 0) return undefined; marks.push(index); from = index + 1; }
  return marks;
}
function nameMarks(query: string, start = 0): number[] { return Array.from({length: query.length}, (_, index) => start + index); }
function matchCommand(item: CommandOption, query: string): CommandMatch | undefined {
  const name = item.name.toLowerCase();
  if (name === query) return {item, rank: 0, marks: nameMarks(query)};
  if (name.startsWith(query)) return {item, rank: 1, marks: nameMarks(query)};
  const segment = [...name.matchAll(/[-:]/g)].map(match => (match.index ?? 0) + 1).find(index => name.startsWith(query, index));
  if (segment !== undefined) return {item, rank: 2, marks: nameMarks(query, segment)};
  const marks = sequence(name, query);
  if (marks) return {item, rank: 3, marks};
  if (item.description.toLowerCase().includes(query)) return {item, rank: 4, marks: []};
  return undefined;
}
export function rankCommands(items: CommandOption[], query: string): CommandMatch[] {
  return items.map(item => matchCommand(item, query.toLowerCase())).filter((match): match is CommandMatch => !!match)
    .sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name));
}
export function updateMenu(previous: MenuState, text: string, start: number, end: number, inventory: CommandInventory, composing = false): MenuState {
  const token = commandToken(text, start, end);
  const suppressed = !token || token.name === previous.suppressed ? previous.suppressed : undefined;
  const matches = token && inventory.state === 'ready' ? rankCommands(inventory.items, token.name) : [];
  const selected = previous.token?.name === token?.name ? previous.matches[previous.active]?.item.name : undefined;
  const active = Math.max(0, matches.findIndex(match => match.item.name === selected));
  return {token, matches, suppressed, active, inventory: inventory.state, incomplete: inventory.incomplete,
    open: !!token && inventory.state !== 'unavailable' && suppressed !== token.name && !composing};
}
export type MenuKey = {key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean};
function arrowStep(key: string): number { return key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0; }
export function menuKey(state: MenuState, key: MenuKey): {state: MenuState; action: 'native' | 'handled' | 'accept'} {
  if (key.isComposing || key.keyCode === 229 || (key.repeat && !arrowStep(key.key)) || key.ctrlKey || key.metaKey || key.altKey || !state.open) return {state, action: 'native'};
  if (key.key === 'Escape') return {state: {...state, open: false, suppressed: state.token?.name}, action: 'handled'};
  if (key.key === 'Enter' && key.shiftKey) return {state: {...state, open: false, suppressed: state.token?.name}, action: 'native'};
  if (key.shiftKey) return {state, action: 'native'};
  const direction = arrowStep(key.key);
  if (direction && state.matches.length) return {state: {...state, active: Math.max(0, Math.min(state.matches.length - 1, state.active + direction))}, action: 'handled'};
  if (key.key === 'Enter') {
    const active = state.matches[state.active];
    return {state, action: active ? 'accept' : 'handled'};
  }
  if (key.key === 'Tab' && state.matches.length) return {state, action: 'accept'};
  return {state, action: 'native'};
}
export function acceptCommand(text: string, token: CommandToken, name: string): {text: string; caret: number} {
  const suffix = text.slice(token.end); const prefix = `/${name} `;
  return {text: prefix + (suffix.startsWith(' ') ? suffix.slice(1) : suffix), caret: prefix.length};
}
