
const fadeLabels='.row-title,.row-name,.row-preview,.tab-label,.tab-identity,.tool-name,.tool-name-directory,.tool-state-word,.conversation-name,.conversation-identity,.project-context,.file-name,.source-language,.extension-status-preview,.composer-state-label,.composer-setting-label,.communication-line-preview,.communication-line-kind,.communication-sender,.message-role,.desk-row-title,.desk-agent,.thread-purpose,.thread-line-note,.thread-reply,.notice-block-title,.response-failure-preview,.thinking-preview,.command-name,.command-desc,#workbench-scope,.workbench-activity-text,.agent-live-state,.agent-live-tool,.agent-live-model';
const pendingLabels=new Set<HTMLElement>(),labelTitles=new WeakMap<HTMLElement,string>();
let labelFrame:number|undefined;
/** Measure painted labels together; full text and explicit source tooltips stay unchanged. Hosts whose nodes cannot match selectors have no painted labels to measure. */
function queueLabel(node:HTMLElement,text?:string):void {
  if(typeof node.matches!=='function'||!node.matches(fadeLabels))return;
  if(text!==undefined&&(!node.title||node.title===labelTitles.get(node))){node.title=text;labelTitles.set(node,text);}
  pendingLabels.add(node);
  if(labelFrame!==undefined)return;
  labelFrame=requestAnimationFrame(()=>{labelFrame=undefined;for(const label of pendingLabels)if(label.isConnected)label.dataset.labelOverflow=String(label.scrollWidth>label.clientWidth);pendingLabels.clear();});
}
export function refreshLabelFades(root:ParentNode=document):void {for(const label of root.querySelectorAll<HTMLElement>(fadeLabels))queueLabel(label);}
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'summary') { node.className = `${node.className} card-disclosure`.trim(); }
  queueLabel(node,text);
  return node;
}
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
}
/** A connected native editor tree must keep its physical ancestry, even when moveBefore exists. */
export function placeRetained(node: HTMLElement, parent: HTMLElement, before: Node | null = null): void {
  if (node.parentElement === parent && node.nextSibling === before) return;
  if (node.isConnected && (node.tagName.toLowerCase() === 'textarea' || node.querySelector('textarea'))) throw new Error('This browser cannot preserve editing when moving this conversation.');
  parent.insertBefore(node, before);
}
export function button(text: string, action: () => void, className?: string): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
/** Callers outside a browser document, such as nodes without a DOM host, have no HTMLElement global and skip the label fade. */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) {
    node.textContent = text;
  }
  if(typeof HTMLElement!=='undefined'&&node instanceof HTMLElement)queueLabel(node,text);
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
