import type {CardIcon} from './card-icons.ts';

/** The families a tool call falls into. Each has one icon, one color token and one spoken name. */
export type ToolKind = 'shell' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'memory' | 'other';

const kinds: Record<string, ToolKind> = {
  bash: 'shell', codemode: 'shell',
  read: 'read', ls: 'read',
  edit: 'edit', write: 'edit',
  grep: 'search', find: 'search', registry: 'search',
  web_search: 'web', web_read: 'web', twitter_search: 'web', twitter_feed: 'web',
};
const prefixes: readonly [string, ToolKind][] = [
  ['agent_', 'agent'], ['memory_', 'memory'], ['history_', 'memory'], ['stash_', 'memory'], ['pillars', 'memory'], ['clipboard_', 'other'],
];

export function toolKind(name: string): ToolKind {
  if (Object.hasOwn(kinds, name)) return kinds[name] as ToolKind;
  return prefixes.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 'other';
}

const icons: Record<ToolKind, CardIcon> = {shell: 'terminal', read: 'file', edit: 'edit', search: 'search', web: 'web', agent: 'agent', memory: 'memory', other: 'plug'};
export function toolKindIcon(kind: ToolKind): CardIcon { return icons[kind]; }

const names: Record<ToolKind, string> = {shell: 'Shell', read: 'Read', edit: 'Edit', search: 'Search', web: 'Web', agent: 'Agent', memory: 'Memory', other: 'Tool'};
/** Read by assistive technology in front of the call subject; the chip itself shows no word. */
export function toolKindName(kind: ToolKind): string { return names[kind]; }
