import { button, element, setText } from './dom.ts';

export type CardIcon = 'copy' | 'wrap' | 'chevron' | 'success' | 'error' | 'working' | 'unknown' | 'previous' | 'next' | 'restart' | 'close' | 'menu' | 'plus' | 'search' | 'info' | 'folder' | 'folder-open' | 'navigation' | 'agent' | 'latest' | 'earlier' | 'message' | 'more' | 'commands' | 'notifications' | 'appearance' | 'send' | 'stop' | 'disconnected' | 'file';
const paths: Record<CardIcon, string> = {
  file: 'M3 2h6l4 4v8H3Z M9 2v4h4 M5 9h6 M5 11h4',
  copy: 'M6 5V2h8v9h-3 M2 5h8v9H2Z',
  wrap: 'M2 3h12 M2 7h9a3 3 0 0 1 0 6H7 M9 11l-2 2 2 2 M2 11h2',
  chevron: 'M6 3l5 5-5 5',
  success: 'M3 8l3 3 7-7',
  error: 'M8 2v7 M8 12v1',
  working: 'M8 2a6 6 0 1 1-6 6',
  unknown: 'M5 5a3 3 0 0 1 6 0c0 2-3 2-3 4 M8 12v1',
  previous: 'M10 3L5 8l5 5',
  next: 'M6 3l5 5-5 5',
  restart: 'M3 6a5 5 0 1 1 0 5 M3 2v4h4',
  close: 'M4 4l8 8 M12 4l-8 8',
  menu: 'M3 8h.01 M8 8h.01 M13 8h.01',
  more: 'M8 3h.01 M8 8h.01 M8 13h.01',
  send: 'M8 14V2 M3 7l5-5 5 5',
  stop: 'M3 3h10v10H3Z',
  disconnected: 'M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M4 4l8 8',
  commands: 'M2 4l4 4-4 4 M9 12h5',
  notifications: 'M3 11h10l-1-2V6a4 4 0 0 0-8 0v3Z M6 13a2 2 0 0 0 4 0 M8 1v1',
  appearance: 'M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M8 2v12 M8 5h5 M8 8h6 M8 11h5',
  plus: 'M8 3v10 M3 8h10',
  search: 'M10.5 10.5L14 14 M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
  info: 'M8 7v5 M8 4h.01 M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0',
  folder: 'M2 4h5l2 2h5v7H2Z M2 4V3h5l2 3',
  'folder-open': 'M2 13V3h5l2 2h5v2 M2 13l2-6h11l-2 6Z',
  navigation: 'M2 3h12v10H2Z M6 3v10',
  agent: 'M8.5 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0 M2 13v-1a4 4 0 0 1 8 0v1 M13 5v6 M10 8h6',
  latest: 'M8 2v9 M4 7l4 4 4-4 M3 14h10',
  earlier: 'M8 14V5 M4 9l4-4 4 4 M3 2h10',
  message: 'M2 3h12v8H6l-4 3Z M5 6h6 M5 8h4',
};
export function cardIcon(name: CardIcon, doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); svg.setAttribute('class', `card-icon card-icon-${name}`);
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name]); svg.append(path); return svg;
}
/** Apply the shared action geometry without replacing the control or its listeners. */
export function controlIcon(node: HTMLElement, name: CardIcon, label: string): void {
  node.classList.add('icon-button');
  node.replaceChildren(cardIcon(name, node.ownerDocument), element('span', 'sr-only', label));
  node.setAttribute('aria-label', label); node.title = label;
}
/** Accessible action text stays separate from the fixed-size glyph. */
export function cardAction(name: CardIcon, label: string, action: () => void, className = ''): HTMLButtonElement {
  const node = button('', action, `${className} card-action`.trim());
  node.append(cardIcon(name), element('span', 'sr-only card-action-label', label)); cardActionLabel(node, label); return node;
}
export function cardActionLabel(node: HTMLButtonElement, label: string, description = label): void {
  const text = node.querySelector('.card-action-label'); if (text) setText(text, label);
  node.setAttribute('aria-label', description); node.title = description;
}
/** A summary is its own control: the row or card carries the affordance, so no mark is drawn. */
export function cardDisclosure(summary: HTMLElement): void {
  summary.classList.add('card-disclosure');
}
