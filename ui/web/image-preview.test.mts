import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { openImagePreview, type ImagePreviewHost } from './image-preview.ts';
import { imageUrl, transcriptImage } from './image.ts';
import type { ImageView } from '../shared/api.ts';

class FakeNode extends EventTarget {
  tag: string; children: FakeNode[] = []; className = ''; hidden = false; parentElement: FakeNode | null = null; private text = '';
  attributes = new Map<string, string>(); tabIndex = -1; src = ''; alt = ''; width = 0; height = 0; decoding = ''; referrerPolicy = ''; loading = '';
  complete = false; naturalWidth = 0; naturalHeight = 0; calls: string[] = []; connected = true; clicks = 0;
  constructor(tag: string) { super(); this.tag = tag; }
  get isConnected(): boolean { return this.parentElement?.isConnected ?? this.connected; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.calls.push(`remove:${name}`); if (name === 'src') this.src = ''; }
  append(...nodes: FakeNode[]): void { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
  insertBefore(node: FakeNode, before: FakeNode): void { node.remove(); this.children.splice(this.children.indexOf(before), 0, node); node.parentElement = this; }
  remove(): void { this.calls.push('remove'); if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  closest(): null { return null; }
  find(tag: string, label?: string): FakeNode | undefined {
    for (const child of this.children) {
      if (child.tag === tag && (label === undefined || child.textContent === label)) return child;
      const nested = child.find(tag, label); if (nested) return nested;
    }
    return undefined;
  }
  findAll(tag: string): FakeNode[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.findAll(tag)]); }
}
const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
function dom(): void {
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {activeElement: null, hidden: false, createElement: (tag: string) => new FakeNode(tag), createElementNS: (_ns: string, tag: string) => new FakeNode(tag)}});
}
const image: ImageView = {type: 'image', mimeType: 'image/png', digest: 'a'.repeat(64), bytes: 2048, width: 1440, height: 1000, alt: 'Transcript image (PNG, 1440 × 1000)', source: {entryId: '4551', message: 0, part: 0}};
type Dialog = {host: ImagePreviewHost; body: FakeNode; opened: string[]; focus: FakeNode[]; closeDialog: () => void; isOpen: () => boolean; variants: Array<string | undefined>};
function dialog(): Dialog {
  let body = new FakeNode('div'), closed: (() => void) | undefined, open = false, revision = 0;
  const opened: string[] = [], focus: FakeNode[] = [], variants: Array<string | undefined> = [];
  const finish = (): void => { if (!open) return; open = false; const callback = closed; closed = undefined; callback?.(); };
  const host: ImagePreviewHost = {
    open: (title, _cancel, onClosed, variant) => { const replaced = closed; closed = undefined; replaced?.(); revision++; open = true; closed = onClosed; opened.push(title); variants.push(variant); body = new FakeNode('div'); return body as unknown as HTMLElement; },
    restoreFocus: node => { focus.push(node as unknown as FakeNode); },
    close: () => finish(),
    get token() { return revision; },
    owns: token => open && token === revision,
  };
  return {host, get body() { return body; }, opened, focus, closeDialog: finish, isOpen: () => open, variants};
}
const url = imageUrl(image, {kind: 'primary', key: 'key', epoch: 1}) as string;
function previewImage(state: Dialog): FakeNode { const node = state.body.find('img'); assert.ok(node); return node; }

test('the preview shows the validated URL fitted by default and reveals natural pixels through Actual size', () => {
  dom(); const state = dialog(); const invoker = new FakeNode('button');
  openImagePreview(state.host, image, url, invoker as unknown as HTMLElement);
  assert.deepEqual(state.opened, ['Image preview']); assert.deepEqual(state.variants, ['image']); assert.deepEqual(state.focus, [invoker]);
  const img = previewImage(state); assert.equal(img.src, url); assert.equal(img.referrerPolicy, 'no-referrer'); assert.equal(img.loading, '');
  assert.equal(img.width, 0); assert.equal(img.height, 0);
  const root = state.body.children[0]; assert.ok(root); assert.match(root.className, /image-preview-fit/);
  const fit = state.body.find('button', 'Fit'), actual = state.body.find('button', 'Actual size'); assert.ok(fit && actual);
  assert.equal(fit.attributes.get('aria-pressed'), 'true'); assert.equal(actual.attributes.get('aria-pressed'), 'false');
  assert.match(state.body.textContent, /PNG · 1440 × 1000 · 2 KiB/); assert.match(state.body.textContent, /Loading image…/);
  img.dispatchEvent(new Event('load')); assert.doesNotMatch(state.body.textContent, /Loading image…/);
  actual.dispatchEvent(new Event('click')); assert.match(root.className, /image-preview-actual/); assert.equal(actual.attributes.get('aria-pressed'), 'true'); assert.equal(fit.attributes.get('aria-pressed'), 'false');
  assert.equal(previewImage(state), img); assert.equal(img.src, url);
  fit.dispatchEvent(new Event('click')); assert.match(root.className, /image-preview-fit/);
});

test('closing the dialog removes the image and clears its source, and late events change nothing', () => {
  dom(); const state = dialog(); openImagePreview(state.host, image, url, new FakeNode('button') as unknown as HTMLElement);
  const img = previewImage(state); img.calls = []; state.closeDialog();
  assert.deepEqual(img.calls, ['remove:src', 'remove']); assert.equal(img.src, ''); assert.equal(img.parentElement, null);
  const text = state.body.textContent; img.dispatchEvent(new Event('error')); img.dispatchEvent(new Event('load')); assert.equal(state.body.textContent, text);
});

test('another dialog replacing the preview releases its image', () => {
  dom(); const state = dialog(); openImagePreview(state.host, image, url, new FakeNode('button') as unknown as HTMLElement);
  const img = previewImage(state); state.host.open('Other');
  assert.equal(img.src, ''); assert.equal(img.parentElement, null);
});

test('the returned closer closes only the dialog it opened', () => {
  dom(); const state = dialog(); const close = openImagePreview(state.host, image, url, new FakeNode('button') as unknown as HTMLElement);
  const img = previewImage(state); close(); assert.equal(state.isOpen(), false); assert.equal(img.src, '');
  const later = openImagePreview(state.host, image, url, new FakeNode('button') as unknown as HTMLElement); state.host.open('Other'); later(); assert.equal(state.isOpen(), true);
});

test('a failed load reports itself and Reload makes one fresh attempt', () => {
  dom(); const state = dialog(); openImagePreview(state.host, image, url, new FakeNode('button') as unknown as HTMLElement);
  const first = previewImage(state); first.dispatchEvent(new Event('error'));
  assert.match(state.body.textContent, /The image could not be loaded\./); assert.equal(state.body.findAll('img').length, 0);
  const reload = state.body.find('button', 'Reload image'); assert.ok(reload); assert.equal(reload.hidden, false);
  reload.dispatchEvent(new Event('click')); const second = previewImage(state); assert.notEqual(second, first); assert.equal(second.src, url); assert.equal(reload.hidden, true);
  first.dispatchEvent(new Event('error')); assert.equal(previewImage(state), second);
  second.dispatchEvent(new Event('load')); assert.doesNotMatch(state.body.textContent, /could not be loaded/);
});

test('natural dimensions that differ from the supplied ones are stated', () => {
  dom(); const state = dialog(); openImagePreview(state.host, image, url, new FakeNode('button') as unknown as HTMLElement);
  const img = previewImage(state); img.naturalWidth = 720; img.naturalHeight = 500; img.dispatchEvent(new Event('load'));
  assert.match(state.body.textContent, /loaded 720 × 500/);
});

test('each transcript image opens its own exact URL, in supplied order', () => {
  dom(); const state = dialog(); const second: ImageView = {...image, digest: 'b'.repeat(64), source: {entryId: '4551', message: 0, part: 1}};
  const target = {kind: 'primary', key: 'key', epoch: 1} as const;
  const urls = [imageUrl(image, target), imageUrl(second, target)] as string[];
  const open = (shown: ImageView, source: string, invoker: HTMLElement): void => { openImagePreview(state.host, shown, source, invoker); };
  const figures = [transcriptImage(image, urls[0], () => {}, open), transcriptImage(second, urls[1], () => {}, open)] as unknown as FakeNode[];
  const buttons = figures.map(figure => figure.find('button', 'Preview image')); assert.ok(buttons[0] && buttons[1]);
  buttons[1].dispatchEvent(new Event('click')); assert.equal(previewImage(state).src, urls[1]); assert.notEqual(urls[0], urls[1]);
  assert.equal(state.focus.at(-1), buttons[1]); state.closeDialog();
  buttons[0].dispatchEvent(new Event('click')); assert.equal(previewImage(state).src, urls[0]);
});

test('the inline image opens the same preview as the button and unavailable images offer none', () => {
  dom(); const calls: Array<{url: string; invoker: unknown}> = [];
  const figure = transcriptImage(image, url, () => {}, (_part, source, invoker) => { calls.push({url: source, invoker}); }) as unknown as FakeNode;
  const button = figure.find('button', 'Preview image'); assert.ok(button); const img = figure.find('img'); assert.ok(img);
  assert.match(img.className, /transcript-image-previewable/);
  button.dispatchEvent(new Event('click')); img.dispatchEvent(new Event('click'));
  assert.deepEqual(calls.map(call => call.url), [url, url]); assert.ok(calls.every(call => call.invoker === button));
  const missing = transcriptImage({...image, source: undefined}, undefined, () => {}, () => { assert.fail('unavailable image opened a preview'); }) as unknown as FakeNode;
  assert.equal(missing.find('button'), undefined); assert.match(missing.textContent, /This image is not available/);
  const plain = transcriptImage(image, url) as unknown as FakeNode; assert.equal(plain.find('button', 'Preview image'), undefined);
});
