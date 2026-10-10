import { LIMITS, type ConversationLayout, type ConversationTab, type Target, type Workspace } from '../shared/api.ts';

export const MAX_TABS = LIMITS.conversationTabs;
export const MIN_SPLIT_PANE = 320;
export type SplitGeometry = {width: number; min: number; max: number; primary: number};
export function splitGeometry(container: number, divider: number, ratio: number): SplitGeometry | undefined {
  const width = Math.floor(container - divider);
  if (!Number.isFinite(width) || divider < 0 || width < MIN_SPLIT_PANE * 2) return;
  const min = Math.max(MIN_SPLIT_PANE, Math.ceil(width * .2));
  const max = Math.min(width - MIN_SPLIT_PANE, Math.floor(width * .8));
  return {width, min, max, primary: Math.min(max, Math.max(min, Math.round(width * ratio / 100)))};
}
export function tabKey(tab: ConversationTab): string { return tab.kind === 'primary' ? 'primary' : `agent:${tab.identity}`; }
export function activeTab(layout: ConversationLayout): ConversationTab | undefined { return layout.active === null ? undefined : layout.tabs[layout.active]; }
export function tabForTarget(target: Target): ConversationTab { return target.kind === 'primary' ? {kind: 'primary'} : {kind: 'agent', identity: target.identity, split: false}; }
export function openTab(layout: ConversationLayout, tab: ConversationTab): ConversationLayout {
  const index = layout.tabs.findIndex(item => tabKey(item) === tabKey(tab));
  if (index >= 0) return {...layout, active: index};
  if (layout.tabs.length >= MAX_TABS) throw new Error('Close a conversation tab before opening another. Drafts stay saved.');
  return {...layout, tabs: [...layout.tabs, tab], active: layout.tabs.length};
}
export function workspaceLayout(workspace?: Workspace): ConversationLayout {
  const layout = workspace?.conversationLayout ?? {tabs: [{kind: 'primary'}], active: 0, splitRatio: 50};
  const target = workspace?.selectedTarget; const selected = activeTab(layout);
  if (!target || tabKey(tabForTarget(target)) === (selected ? tabKey(selected) : undefined)) return layout;
  const tab = tabForTarget(target);
  // External session selection must stay reachable even when the tab strip is full.
  if (layout.tabs.length === MAX_TABS && !layout.tabs.some(item => tabKey(item) === tabKey(tab))) {
    const tabs = layout.tabs.slice(); tabs[layout.active ?? 0] = tab;
    return {...layout, tabs, active: layout.active ?? 0};
  }
  return openTab(layout, tab);
}
export function closeTab(layout: ConversationLayout, index: number): ConversationLayout {
  if (!layout.tabs[index]) return layout;
  const tabs = layout.tabs.filter((_, i) => i !== index);
  const active = !tabs.length ? null : layout.active === null ? 0 : layout.active > index ? layout.active - 1 : Math.min(layout.active, tabs.length - 1);
  return {...layout, tabs, active};
}
export function moveTab(layout: ConversationLayout, from: number, to: number): ConversationLayout {
  const moved = layout.tabs[from]; if (!moved || !layout.tabs[to] || from === to) return layout;
  const selected = activeTab(layout); const tabs = layout.tabs.slice();
  tabs.splice(from, 1); tabs.splice(to, 0, moved);
  return {...layout, tabs, active: selected ? tabs.findIndex(tab => tabKey(tab) === tabKey(selected)) : null};
}
export function switchTab(layout: ConversationLayout, direction: number): ConversationLayout {
  if (!layout.tabs.length) return layout;
  return {...layout, active: ((layout.active ?? 0) + direction + layout.tabs.length) % layout.tabs.length};
}
export function toggleSplit(layout: ConversationLayout): ConversationLayout {
  const tab = activeTab(layout); if (tab?.kind !== 'agent') return layout;
  return {...layout, tabs: layout.tabs.map((item, i) => i === layout.active ? {...tab, split: !tab.split} : item)};
}
export function layoutTarget(layout: ConversationLayout, primary?: Target): Target | null {
  const tab = activeTab(layout);
  return !tab ? null : tab.kind === 'primary' ? primary ?? null : {kind: 'agent', identity: tab.identity};
}
export function splitPercent(pixels: number, width: number): number { return Math.max(20, Math.min(80, Math.round(width > 0 ? pixels / width * 100 : 50))); }
