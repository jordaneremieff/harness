const paths = {
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-1 5 5',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  agents: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  close: 'm6 6 12 12M6 18 18 6',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17',
  copy: 'M9 9h11v11H9zM5 15H3V3h12v2',
  check: 'm5 12 4 4L19 6',
  stop: 'M6 6h12v12H6z',
  arrowDown: 'M12 4v16m-6-6 6 6 6-6',
  arrowLeft: 'M20 12H4m6-6-6 6 6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
} as const;
export type IconName = keyof typeof paths;
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]); svg.append(path); return svg;
}
export function setIcon(node: HTMLElement, name: IconName, label?: string): void {
  node.replaceChildren(icon(name));
  if (label) node.append(document.createTextNode(label));
  node.classList.add('icon-button');
}
export function installIcons(): void {
  const controls: Array<[string, IconName, string?]> = [
    ['notices-button', 'bell'], ['agents-button', 'agents', 'Agents'], ['session-actions', 'more'],
    ['agent-refresh', 'refresh'], ['agent-close', 'close'], ['agent-detail-close', 'close'],
    ['modal-close', 'close'], ['primary-stop', 'stop', 'Stop'],
    ['primary-latest', 'arrowDown', 'Latest'], ['agent-latest', 'arrowDown', 'Latest'],
    ['agent-back', 'arrowLeft', 'Agents'],
  ];
  for (const [id, name, label] of controls) {
    const node = document.getElementById(id);
    if (!node) continue;
    const badge = id === 'notices-button' ? node.querySelector('#notices-count') : null;
    setIcon(node, name, label); if (badge) node.append(badge);
  }
}
