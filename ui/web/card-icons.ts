import { button, element, setText } from './dom.ts';

export type CardIcon = 'copy' | 'wrap' | 'chevron' | 'success' | 'error' | 'working' | 'unknown' | 'previous' | 'next' | 'restart' | 'close' | 'menu';
const paths: Record<CardIcon, string> = {
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
};
export function cardIcon(name: CardIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); svg.setAttribute('class', `card-icon card-icon-${name}`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name]); svg.append(path); return svg;
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
export function cardDisclosure(summary: HTMLElement): void {
  summary.classList.add('card-disclosure'); summary.prepend(cardIcon('chevron'));
}
