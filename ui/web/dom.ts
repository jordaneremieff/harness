import { cardIcon } from './card-icons.ts';

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'summary') { node.className = `${node.className} card-disclosure`.trim(); node.prepend(cardIcon('chevron')); }
  return node;
}
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
}
export function button(text: string, action: () => void, className?: string): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
export function setText(node: Node, text: string): void {
  if (typeof (node as HTMLElement).className === 'string' && (node as HTMLElement).className.split(' ').includes('state-glyph')) { statusGlyph(node as HTMLElement, text); return; }
  if (node.textContent !== text) {
    node.textContent = text;
    const css = typeof (node as HTMLElement).className === 'string' ? (node as HTMLElement).className.split(' ') : [];
    if (css.includes('card-disclosure') && !css.includes('icon-button')) (node as HTMLElement).prepend(cardIcon('chevron'));
  }
}
/** Only explicit UI status slots translate authored marks; supplied content stays text. */
export function statusGlyph(node: HTMLElement, glyph: string): void {
  if (node.dataset.glyph === glyph) return;
  const icons = {'✓': 'success', '●': 'working', '○': 'disconnected', '!': 'error', '?': 'unknown'} as const;
  const name = icons[glyph as keyof typeof icons]; node.dataset.glyph = glyph;
  if (name) node.replaceChildren(cardIcon(name, node.ownerDocument)); else node.textContent = glyph;
}
export function announce(text: string): void { setText(byId('announcements'), text); }
export async function copy(text: string, into?: HTMLElement | (() => HTMLElement)): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    announce('Copied'); return true;
  } catch {
    const area = element('textarea', 'copy-fallback');
    area.value = text;
    area.readOnly = true;
    area.setAttribute('aria-label', 'Select and copy text');
    const target = typeof into === 'function' ? into() : into ?? byId('modal-body');
    target.append(area);
    area.focus(); area.select();
    announce('Copy failed. Select and copy the text.'); return false;
  }
}
export { stripControls } from './format.ts';
export function rawText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}
export function empty(text: string): HTMLElement { return element('p', 'empty-state', text); }
export function input(label: string, value = '', multiline = false): {label: HTMLLabelElement; field: HTMLInputElement | HTMLTextAreaElement} {
  const field = multiline ? element('textarea') : element('input');
  field.id = `field-${crypto.randomUUID()}`;
  field.value = value;
  const caption = element('label', undefined, label);
  caption.htmlFor = field.id;
  return {label: caption, field};
}
export function details(title: string, data: string): HTMLDetailsElement {
  const node = element('details');
  node.append(element('summary', undefined, title), element('pre', undefined, data));
  return node;
}
