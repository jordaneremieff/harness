export interface LayoutItem { id: string; index: number; top: number; height: number; bottom: number }
export interface VirtualLayout { items: LayoutItem[]; byId: ReadonlyMap<string, LayoutItem>; totalHeight: number }
export interface Anchor { id: string; offsetPx: number }
export interface VirtualSpan { start: number; end: number; top: number; bottom: number; items: LayoutItem[] }
export interface VirtualWindow { items: LayoutItem[]; spans: VirtualSpan[]; top: number; bottom: number; totalHeight: number }

export function layoutItems(ids: readonly string[], heights: ReadonlyMap<string, number>, estimate = 80): VirtualLayout {
  if (!Number.isFinite(estimate) || estimate <= 0) throw new RangeError('The estimated height must be positive.');
  const byId = new Map<string, LayoutItem>();
  const items: LayoutItem[] = [];
  let top = 0;
  for (const id of ids) {
    if (byId.has(id)) throw new Error(`Duplicate virtual item: ${id}`);
    const measured = heights.get(id);
    const height = measured !== undefined && Number.isFinite(measured) && measured > 0 ? measured : estimate;
    const item = { id, index: items.length, top, height, bottom: top + height };
    items.push(item);
    byId.set(id, item);
    top += height;
  }
  return { items, byId, totalHeight: top };
}
function firstAfter(layout: VirtualLayout, position: number): number {
  let lo = 0;
  let hi = layout.items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const item = layout.items[mid];
    if (item && item.bottom <= position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function clampScroll(layout: VirtualLayout, position: number, viewportHeight: number): number {
  return Math.max(0, Math.min(Number.isFinite(position) ? position : 0,
    Math.max(0, layout.totalHeight - Math.max(0, viewportHeight))));
}
function spansFor(items: LayoutItem[]): VirtualSpan[] {
  const spans: VirtualSpan[] = [];
  for (const item of items) {
    const previous = spans[spans.length - 1];
    if (previous && previous.end === item.index) {
      previous.end++;
      previous.bottom = item.bottom;
      previous.items.push(item);
    } else spans.push({ start: item.index, end: item.index + 1, top: item.top, bottom: item.bottom, items: [item] });
  }
  return spans;
}
/** Separate spans retain distant pins without mounting every intervening block. */
export function visibleWindow(layout: VirtualLayout, scrollTop: number, viewportHeight: number,
  options: { overscanPx?: number; pins?: ReadonlySet<string> } = {}): VirtualWindow {
  const height = Math.max(0, viewportHeight);
  const top = clampScroll(layout, scrollTop, height);
  const overscan = Math.max(0, options.overscanPx ?? height * 2);
  const lower = Math.max(0, top - overscan);
  const upper = top + height + overscan;
  const selected = new Map<number, LayoutItem>();
  for (let i = firstAfter(layout, lower); i < layout.items.length; i++) {
    const item = layout.items[i];
    if (!item || item.top >= upper) break;
    selected.set(i, item);
  }
  for (const id of options.pins ?? []) {
    const item = layout.byId.get(id);
    if (item) selected.set(item.index, item);
  }
  const items = [...selected.values()].sort((a, b) => a.index - b.index);
  const spans = spansFor(items);
  return { items, spans, top: items[0]?.top ?? 0,
    bottom: Math.max(0, layout.totalHeight - (items[items.length - 1]?.bottom ?? 0)), totalHeight: layout.totalHeight };
}
export function captureAnchor(layout: VirtualLayout, scrollTop: number): Anchor | null {
  if (!layout.items.length) return null;
  const top = Math.max(0, Math.min(scrollTop, layout.totalHeight - 1));
  const item = layout.items[firstAfter(layout, top)];
  return item ? { id: item.id, offsetPx: top - item.top } : null;
}
export function restoreAnchor(layout: VirtualLayout, anchor: Anchor | null, viewportHeight: number, fallback = 0): number {
  const item = anchor ? layout.byId.get(anchor.id) : undefined;
  const position = item && anchor ? item.top + Math.max(0, Math.min(anchor.offsetPx, item.height - 1)) : fallback;
  return clampScroll(layout, position, viewportHeight);
}
export function followsTail(scrollTop: number, viewportHeight: number, totalHeight: number,
  options: { explicitlyAway?: boolean; selection?: boolean; threshold?: number } = {}): boolean {
  return !options.explicitlyAway && !options.selection &&
    totalHeight - scrollTop - viewportHeight <= (options.threshold ?? 48);
}
/** Drop measurements for removed keys. A change of order never changes a measurement's owner. */
export function measureItems(heights: ReadonlyMap<string, number>, measurements: ReadonlyMap<string, number>, ids: readonly string[]): ReadonlyMap<string, number> {
  const next = new Map<string, number>();
  for (const id of ids) {
    const value = measurements.get(id) ?? heights.get(id);
    if (value !== undefined && Number.isFinite(value) && value > 0) next.set(id, value);
  }
  return next;
}
