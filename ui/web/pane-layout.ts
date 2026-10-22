import {validLayoutData, validWorkspaceTab, type ConversationLayout, type WorkspaceTab as ConversationTab, type PaneNode} from '../shared/api.ts';
import { MAX_TABS, tabKey } from './tabs.ts';

export type { PaneNode } from '../shared/api.ts';
export type PaneLayout = ConversationLayout;
export type PaneLeaf = Extract<PaneNode, {kind: 'pane'}>;
export type PaneAxis = 'x' | 'y';
export type PaneSpace = {width: number; height: number; divider: number};
export type PaneSize = {width: number; height: number};
export const MAX_PANES = 4;
export const MIN_PANE_WIDTH = 320;
export const MIN_PANE_HEIGHT = 240;
export const PANE_DIVIDER = 4;

export function paneLeaves(node: PaneNode): PaneLeaf[] {
  return node.kind === 'pane' ? [node] : [...paneLeaves(node.first), ...paneLeaves(node.second)];
}
export function paneById(layout: PaneLayout, id: string): PaneLeaf | undefined {
  return paneLeaves(layout.root).find(pane => pane.id === id);
}
export function paneForTab(layout: PaneLayout, key: string): PaneLeaf | undefined {
  return paneLeaves(layout.root).find(pane => pane.tabs.some(tab => tabKey(tab) === key));
}
export function createPaneLayout(tabs: ConversationTab[], active: string | null = tabs[0] ? tabKey(tabs[0]) : null): PaneLayout {
  const layout: PaneLayout = {root: {kind: 'pane', id: 'pane-1', tabs: [...tabs], active}, focusedPane: 'pane-1'};
  if (!validPaneLayout(layout)) throw new Error('The pane layout is invalid or exceeds its tab limit.');
  return layout;
}
/** Allocation identity is not a revision: unsaved layouts are reconstructed on each read. */
export function samePaneLayout(a: PaneLayout, b: PaneLayout): boolean {
  const sameNode = (left: PaneNode, right: PaneNode): boolean => {
    if (left.kind !== right.kind || left.id !== right.id) return false;
    if (left.kind === 'pane' && right.kind === 'pane') return left.active === right.active && JSON.stringify(left.tabs) === JSON.stringify(right.tabs);
    return left.kind === 'split' && right.kind === 'split' && left.axis === right.axis && left.ratio === right.ratio && sameNode(left.first, right.first) && sameNode(left.second, right.second);
  };
  return a.focusedPane === b.focusedPane && sameNode(a.root, b.root);
}
function mapPanes(node: PaneNode, update: (pane: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === 'pane') return update(node);
  const first = mapPanes(node.first, update); const second = mapPanes(node.second, update);
  return first === node.first && second === node.second ? node : {...node, first, second};
}
function prune(node: PaneNode, ids: Set<string>): PaneNode | undefined {
  if (node.kind === 'pane') return ids.has(node.id) ? undefined : node;
  const first = prune(node.first, ids); const second = prune(node.second, ids);
  return !first ? second : !second ? first : first === node.first && second === node.second ? node : {...node, first, second};
}
function withRoot(layout: PaneLayout, root: PaneNode, focusedPane = layout.focusedPane): PaneLayout {
  const panes = paneLeaves(root); const next = panes.some(pane => pane.id === focusedPane) ? focusedPane : panes[0]?.id ?? focusedPane;
  return root === layout.root && next === layout.focusedPane ? layout : {...layout, root, focusedPane: next};
}
function withoutTab(pane: PaneLeaf, key: string): PaneLeaf {
  const index = pane.tabs.findIndex(tab => tabKey(tab) === key); if (index < 0) return pane;
  const tabs = pane.tabs.filter(tab => tabKey(tab) !== key); const adjacent = tabs[Math.min(index, tabs.length - 1)];
  return {...pane, tabs, active: pane.active === key ? adjacent ? tabKey(adjacent) : null : pane.active};
}
export function focusPaneLayout(layout: PaneLayout, id: string): PaneLayout {
  return paneById(layout, id) ? withRoot(layout, layout.root, id) : layout;
}
export function activatePaneTab(layout: PaneLayout, id: string, key: string): PaneLayout {
  const pane = paneById(layout, id); if (!pane?.tabs.some(tab => tabKey(tab) === key)) return layout;
  const root = mapPanes(layout.root, item => item.id === id && item.active !== key ? {...item, active: key} : item);
  return withRoot(layout, root, id);
}
export function canSplitPane(layout: PaneLayout, id: string, axis: PaneAxis, space: PaneSpace): boolean {
  if (!paneById(layout, id) || paneLeaves(layout.root).length >= MAX_PANES || !Number.isFinite(space.width) || !Number.isFinite(space.height) || !Number.isFinite(space.divider) || space.divider < 0) return false;
  return axis === 'x' ? space.width - space.divider >= MIN_PANE_WIDTH * 2 && space.height >= MIN_PANE_HEIGHT :
    axis === 'y' && space.height - space.divider >= MIN_PANE_HEIGHT * 2 && space.width >= MIN_PANE_WIDTH;
}
/** A sole-tab split is provisional until the chooser supplies a unique conversation. */
export function splitPane(layout: PaneLayout, id: string, axis: PaneAxis, space: PaneSpace, addressed?: string): PaneLayout {
  const source = paneById(layout, id); if (!source || !canSplitPane(layout, id, axis, space)) return layout;
  if (addressed !== undefined && !source.tabs.some(tab => tabKey(tab) === addressed)) return layout;
  const ids = new Set<string>(); const collect = (node: PaneNode): void => {ids.add(node.id); if (node.kind === 'split') {collect(node.first); collect(node.second);}}; collect(layout.root);
  const nextId = (prefix: string): string => {let number = 1; while (ids.has(`${prefix}-${number}`)) number++; const value = `${prefix}-${number}`; ids.add(value); return value;};
  const destination = nextId('pane'); const splitId = nextId('split'); const key = source.tabs.length > 1 ? addressed ?? source.active : null;
  const tab = key ? source.tabs.find(tab => tabKey(tab) === key) : undefined;
  const next: PaneLeaf = {kind: 'pane', id: destination, tabs: tab ? [tab] : [], active: key};
  const replace = (node: PaneNode): PaneNode => {
    if (node.kind === 'pane') return node.id === id ? {kind: 'split', id: splitId, axis, ratio: 50, first: key ? withoutTab(node, key) : node, second: next} : node;
    const first = replace(node.first); const second = replace(node.second); return first === node.first && second === node.second ? node : {...node, first, second};
  };
  return withRoot(layout, replace(layout.root), destination);
}
/** Opens new targets locally; an already-open target activates its existing owner. */
export function openPaneTab(layout: PaneLayout, id: string, tab: ConversationTab): PaneLayout {
  const key = tabKey(tab); const owner = paneForTab(layout, key); if (owner) return activatePaneTab(layout, owner.id, key);
  if (!paneById(layout, id)) return layout;
  if (tab.kind !== 'file' && paneLeaves(layout.root).reduce((count, pane) => count + pane.tabs.filter(item=>item.kind !== 'file').length, 0) >= MAX_TABS) throw new Error('This window has reached its tab limit. Close a tab to continue.');
  return withRoot(layout, mapPanes(layout.root, pane => pane.id === id ? {...pane, tabs: [...pane.tabs, tab], active: key} : pane), id);
}
export function movePaneTab(layout: PaneLayout, key: string, destination: string, index?: number): PaneLayout {
  const source = paneForTab(layout, key); const target = paneById(layout, destination); const tab = source?.tabs.find(tab => tabKey(tab) === key);
  if (!source || !target || !tab || index !== undefined && (!Number.isInteger(index) || index < 0 || index > target.tabs.length)) return layout;
  if (source.id === destination && source.tabs.findIndex(tab => tabKey(tab) === key) === index) return layout;
  let root = mapPanes(layout.root, pane => {
    const without = withoutTab(pane, key); if (pane.id !== destination) return without;
    const tabs = [...without.tabs]; tabs.splice(Math.min(index ?? tabs.length, tabs.length), 0, tab);
    return {...without, tabs, active: source.id === destination ? source.active : key};
  });
  if (source.id !== destination && source.tabs.length === 1) root = prune(root, new Set([source.id])) ?? root;
  return withRoot(layout, root, source.id === destination ? layout.focusedPane : destination);
}
export function closePaneTab(layout: PaneLayout, key: string): PaneLayout {
  const source = paneForTab(layout, key); if (!source || source.tabs.some(tab=>tabKey(tab)===key&&tab.kind==='session')) return layout;
  let root = mapPanes(layout.root, pane => withoutTab(pane, key));
  if (source.tabs.length === 1 && paneLeaves(root).length > 1) root = prune(root, new Set([source.id])) ?? root;
  return withRoot(layout, root);
}
function sibling(node: PaneNode, id: string): PaneLeaf | undefined {
  if (node.kind === 'pane') return;
  if (node.first.kind === 'pane' && node.first.id === id) return paneLeaves(node.second)[0];
  if (node.second.kind === 'pane' && node.second.id === id) return paneLeaves(node.first).at(-1);
  return sibling(node.first, id) ?? sibling(node.second, id);
}
/** Closing a group moves its tabs to its nearest sibling without losing content. */
export function closePane(layout: PaneLayout, id: string): PaneLayout {
  const source = paneById(layout, id); const target = sibling(layout.root, id); if (!source || !target) return layout;
  const merged = !source.tabs.length ? layout.root : mapPanes(layout.root, pane => pane.id === target.id ? {...pane, tabs: [...pane.tabs, ...source.tabs], active: layout.focusedPane === id ? source.active ?? pane.active : pane.active ?? source.active} : pane);
  return withRoot(layout, prune(merged, new Set([id])) ?? merged, layout.focusedPane === id ? target.id : layout.focusedPane);
}
export function resizePaneSplit(layout: PaneLayout, id: string, ratio: number): PaneLayout {
  if (!Number.isFinite(ratio)) return layout;
  const update = (node: PaneNode): PaneNode => {
    if (node.kind === 'pane') return node;
    if (node.id === id) { const value = Math.max(20, Math.min(80, Math.round(ratio))); return value === node.ratio ? node : {...node, ratio: value}; }
    const first = update(node.first); const second = update(node.second);
    return first === node.first && second === node.second ? node : {...node, first, second};
  };
  return withRoot(layout, update(layout.root));
}
type Validation = {ids: Set<string>; tabs: Set<string>; leaves: Set<string>; conversations: number; nodes: number; empty: number};
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function validTab(value: unknown): value is ConversationTab {
  return validWorkspaceTab(value);
}
function validateLeaf(node: Record<string, unknown>, state: Validation): boolean {
  if (!['kind','id','tabs','active'].every(key=>Object.hasOwn(node,key)) || !Array.isArray(node.tabs) || !('active' in node)) return false;
  for (const tab of node.tabs) {
    if (!validTab(tab)) return false; const key = tabKey(tab); if (state.tabs.has(key)) return false; state.tabs.add(key);if (tab.kind !== 'file') state.conversations++;
  }
  const selected = node.tabs.length ? typeof node.active === 'string' && node.tabs.some(tab => tabKey(tab as ConversationTab) === node.active) : node.active === null;
  if (!selected || state.conversations > MAX_TABS) return false;
  state.leaves.add(node.id as string); if (!node.tabs.length) state.empty++;
  return state.leaves.size <= MAX_PANES;
}
function splitShape(node: Record<string, unknown>): boolean {
  return node.kind === 'split' && ['kind','id','axis','ratio','first','second'].every(key=>Object.hasOwn(node,key)) && (node.axis === 'x' || node.axis === 'y') && typeof node.ratio === 'number' && Number.isInteger(node.ratio) && node.ratio >= 20 && node.ratio <= 80;
}
function validateNode(value: unknown, depth: number, state: Validation): boolean {
  if (++state.nodes > MAX_PANES * 2 - 1 || depth > MAX_PANES - 1) return false;
  const node = record(value); if (!node) return false;
  if (typeof node.id !== 'string' || !node.id || node.id.length > 64 || state.ids.has(node.id)) return false;
  state.ids.add(node.id);
  if (node.kind === 'pane') return validateLeaf(node, state);
  return splitShape(node) && validateNode(node.first, depth + 1, state) && validateNode(node.second, depth + 1, state);
}
function validate(value: unknown, provisional: boolean): value is PaneLayout {
  const object = record(value); if (!object || !validLayoutData(value) || !('root' in object) || typeof object.focusedPane !== 'string') return false;
  const state: Validation = {ids: new Set(), tabs: new Set(), leaves: new Set(), conversations: 0, nodes: 0, empty: 0};
  return validateNode(object.root, 0, state) && state.leaves.has(object.focusedPane) && (provisional || state.empty === 0 || state.leaves.size === 1);
}
/** Durable validation rejects provisional empty groups and never reads flat records. */
export function validPaneLayout(value: unknown): value is PaneLayout { return validate(value, false); }
export function normalizePaneLayout(layout: PaneLayout): PaneLayout {
  if (!validate(layout, true)) throw new Error('The pane layout is invalid.');
  const leaves = paneLeaves(layout.root); const empty = new Set(leaves.filter(pane => !pane.tabs.length).map(pane => pane.id));
  if (empty.size === leaves.length) empty.delete(leaves[0]?.id ?? '');
  const next = withRoot(layout, prune(layout.root, empty) ?? layout.root);
  if (!validPaneLayout(next)) throw new Error('The pane layout is invalid.');
  return next;
}
export function minimumPaneSize(node: PaneNode, divider = PANE_DIVIDER): PaneSize {
  if (node.kind === 'pane') return {width: MIN_PANE_WIDTH, height: MIN_PANE_HEIGHT};
  const a = minimumPaneSize(node.first, divider); const b = minimumPaneSize(node.second, divider);
  return node.axis === 'x' ? {width: Math.ceil(Math.max(a.width + b.width, a.width / .8, b.width / .8)) + divider, height: Math.max(a.height, b.height)} :
    {width: Math.max(a.width, b.width), height: Math.ceil(Math.max(a.height + b.height, a.height / .8, b.height / .8)) + divider};
}
export function paneSplitGeometry(node: PaneNode, space: PaneSpace): {extent: number; min: number; max: number; first: number} | undefined {
  if (node.kind !== 'split' || !Number.isFinite(space.width) || !Number.isFinite(space.height) || !Number.isFinite(space.divider) || space.divider < 0) return;
  const a = minimumPaneSize(node.first, space.divider); const b = minimumPaneSize(node.second, space.divider);
  const axis = node.axis === 'x' ? 'width' : 'height'; const other = node.axis === 'x' ? 'height' : 'width';
  const extent = Math.floor(space[axis] - space.divider); const min = Math.max(a[axis], Math.ceil(extent * .2)); const max = Math.min(extent - b[axis], Math.floor(extent * .8));
  if (min > max || space[other] < Math.max(a[other], b[other])) return;
  return {extent, min, max, first: Math.max(min, Math.min(max, Math.round(extent * node.ratio / 100)))};
}
