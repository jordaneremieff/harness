import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { imageUrl, transcriptImage } from './image.ts';
import type { ImageView } from '../shared/api.ts';
class FakeNode extends EventTarget {
  tag: string; children: FakeNode[] = []; className = ''; hidden = false; private text = '';
  parentElement: FakeNode | null = null; calls: string[] = []; tabIndex = -1; focusOptions?: FocusOptions;
  src = ''; alt = ''; width = 0; height = 0; loading = ''; decoding = ''; referrerPolicy = '';
  constructor(tag: string) { super(); this.tag = tag; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: FakeNode[]): void { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
  insertBefore(node: FakeNode, before: FakeNode): void {
    node.remove(); const index = this.children.indexOf(before); assert.ok(index >= 0);
    this.children.splice(index, 0, node); node.parentElement = this;
  }
  remove(): void {
    this.calls.push('remove');
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
  }
  removeAttribute(name: string): void { this.calls.push(`remove:${name}`); if (name === 'src') this.src = ''; }
  focus(options?: FocusOptions): void { Object.assign(document, {activeElement: this}); this.focusOptions = options; }
}
const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
const image: ImageView = {type: 'image', mimeType: 'image/png', digest: 'a'.repeat(64), bytes: 1024, width: 300, height: 200, alt: 'Transcript image (PNG, 300 × 200)', source: {entryId: '42', message: 0, part: 1}};
function dom() { Object.defineProperty(globalThis, 'document', {configurable: true, value: {activeElement: null, createElement: (tag: string) => new FakeNode(tag)}}); }
test('image URLs bind target epoch or identity and contain no payload', () => {
  const url = imageUrl(image, {kind: 'primary', key: 'primary', epoch: 3}, 'workspace'); assert.ok(url);
  const parsed = new URL(url, 'http://localhost'); assert.equal(parsed.pathname, '/api/primaries/primary/history/image');
  assert.equal(parsed.searchParams.get('epoch'), '3'); assert.equal(parsed.searchParams.get('part'), '1');
  assert.equal(imageUrl({...image, source: undefined}, {kind: 'agent', identity: 'agent'}), undefined);
  assert.match(imageUrl(image, {kind: 'agent', identity: 'storage:9'}) ?? '', /agents\/storage%3A9\/history\/image/);
});
test('image renderer uses lazy same-origin image with size, alt, failure and retry states', () => {
  dom(); let changes = 0; const url = imageUrl(image, {kind: 'primary', key: 'key', epoch: 1});
  const figure = transcriptImage(image, url, () => { changes++; }) as unknown as FakeNode;
  const img = figure.children.find(node => node.tag === 'img'); const retry = figure.children.find(node => node.tag === 'button'); assert.ok(img && retry);
  assert.equal(img.loading, 'lazy'); assert.equal(img.decoding, 'async'); assert.equal(img.src, url); assert.equal(img.alt, image.alt);
  assert.deepEqual([img.width, img.height], [300, 200]); assert.match(figure.textContent, /300 × 200 · 1 KiB/);
  assert.match(figure.textContent, /Loading image…/);
  img.calls = [];
  img.dispatchEvent(new Event('error')); assert.equal(img.hidden, true); assert.equal(retry.hidden, false); assert.match(figure.textContent, /The image could not be loaded/);
  assert.deepEqual(img.calls, ['remove:src', 'remove']); assert.equal(img.parentElement, null); assert.equal(img.src, '');
  retry.dispatchEvent(new Event('click')); assert.equal(img.hidden, false); assert.equal(retry.hidden, true);
  assert.equal(img.parentElement, figure); assert.equal(img.loading, 'lazy'); assert.equal(img.src, url);
  assert.equal(figure.children.indexOf(img) + 1, figure.children.indexOf(retry));
  img.dispatchEvent(new Event('load')); assert.equal(changes, 4);
  assert.equal(figure.children.find(node => node.className === 'transcript-image-status')?.textContent, '');
});
test('only four image elements retain source URLs and eviction exposes a reload control', () => {
  dom(); const url = imageUrl(image, {kind: 'primary', key: 'key', epoch: 1});
  const images: FakeNode[] = [];
  const figures = Array.from({length: 6}, () => {
    const figure = transcriptImage(image, url) as unknown as FakeNode;
    const img = figure.children.find(node => node.tag === 'img'); assert.ok(img); img.calls = []; images.push(img); return figure;
  });
  assert.equal(images.filter(image => image.src).length, 4); assert.equal(images[0]?.src, '');
  const first = figures[0]; assert.ok(first); assert.match(first.textContent, /Reload this image to view it/);
  const retry = first.children.find(node => node.tag === 'button'); assert.ok(retry); assert.equal(retry.hidden, false);
  const firstImage = images[0]; assert.ok(firstImage); assert.equal(firstImage.parentElement, null);
  assert.deepEqual(firstImage.calls, ['remove:src', 'remove']);
  const releasedText = first.textContent; firstImage.dispatchEvent(new Event('error')); firstImage.dispatchEvent(new Event('load'));
  assert.equal(first.textContent, releasedText); assert.equal(retry.hidden, false);
  retry.dispatchEvent(new Event('click')); assert.equal(images[0]?.src, url); assert.equal(firstImage.parentElement, first);
  assert.equal(images.filter(image => image.src).length, 4);
});
test('detached figures release images and reload the same lazy element across repeated failures', () => {
  dom(); const url = imageUrl(image, {kind: 'primary', key: 'key', epoch: 1});
  const figure = transcriptImage(image, url) as unknown as FakeNode;
  const img = figure.children.find(node => node.tag === 'img'), retry = figure.children.find(node => node.tag === 'button'); assert.ok(img && retry);
  const container = new FakeNode('div'); container.append(figure); figure.remove();
  for (let cycle = 0; cycle < 4; cycle++) {
    img.calls = []; img.dispatchEvent(new Event('error'));
    assert.deepEqual(img.calls, ['remove:src', 'remove']); assert.equal(img.parentElement, null); assert.equal(img.src, '');
    const status = figure.textContent; img.dispatchEvent(new Event('load')); img.dispatchEvent(new Event('error')); assert.equal(figure.textContent, status);
    retry.dispatchEvent(new Event('click')); assert.equal(img.parentElement, figure); assert.equal(img.loading, 'lazy'); assert.equal(img.src, url);
    assert.equal(figure.children.filter(node => node.tag === 'img').length, 1); assert.equal(figure.parentElement, null);
  }
});
test('reload preserves its button focus in the figure without moving unrelated focus', () => {
  dom(); const sentinel = new FakeNode('input'); sentinel.focus();
  const url = imageUrl(image, {kind: 'primary', key: 'key', epoch: 1});
  const figure = transcriptImage(image, url) as unknown as FakeNode;
  const img = figure.children.find(node => node.tag === 'img'), retry = figure.children.find(node => node.tag === 'button'); assert.ok(img && retry);
  assert.equal(document.activeElement, sentinel); assert.equal(figure.focusOptions, undefined);
  img.dispatchEvent(new Event('error')); assert.equal(document.activeElement, sentinel);
  retry.focus(); retry.dispatchEvent(new Event('click'));
  assert.equal(document.activeElement, figure); assert.equal(figure.tabIndex, -1); assert.deepEqual(figure.focusOptions, {preventScroll: true});
  assert.equal(retry.hidden, true); assert.equal(img.parentElement, figure);
  img.dispatchEvent(new Event('load')); assert.equal(document.activeElement, figure);
  sentinel.focus(); img.dispatchEvent(new Event('error')); const status = figure.textContent;
  img.dispatchEvent(new Event('error')); img.dispatchEvent(new Event('load'));
  assert.equal(figure.textContent, status); assert.equal(document.activeElement, sentinel);
  retry.dispatchEvent(new Event('click')); assert.equal(document.activeElement, sentinel);
  for (let index = 0; index < 5; index++) transcriptImage(image, url);
  assert.equal(document.activeElement, sentinel);
});
test('stored attachment URLs bind verified workspace and target identities without paths or queries', () => {
  dom(); const attachment = {workspaceId: '11111111-1111-1111-1111-111111111111', targetKey: '22222222-2222-2222-2222-222222222222'};
  const stored: ImageView = {...image, source: undefined, attachment, alt: 'Blue sample.png'};
  const url = imageUrl(stored, {kind: 'agent', identity: 'storage:9'}, 'other-workspace'); assert.ok(url);
  assert.equal(url, `/api/workspaces/${attachment.workspaceId}/targets/${attachment.targetKey}/images/${image.digest}`);
  const figure = transcriptImage(stored, url) as unknown as FakeNode;
  const img = figure.children.find(node => node.tag === 'img'); assert.ok(img);
  assert.equal(img.src, url); assert.equal(img.alt, 'Blue sample.png'); assert.equal(img.loading, 'lazy');
  assert.match(figure.textContent, /Blue sample.png/);
  assert.equal(imageUrl({...stored, source: image.source}, {kind: 'agent', identity: 'storage:9'}), undefined);
  for (const targetKey of ['../../file', 'x?path=/private/file', '22222222-2222-2222-2222-222222222222/extra']) {
    assert.equal(imageUrl({...stored, attachment: {...attachment, targetKey}}, {kind: 'agent', identity: 'storage:9'}), undefined);
  }
  for (const unsafe of [`${url}?path=/private/file`, `${url}#fragment`, `/api/workspaces/${attachment.workspaceId}/targets/${attachment.targetKey}/images/other.bin`]) {
    const refused = transcriptImage(stored, unsafe) as unknown as FakeNode;
    assert.ok(!refused.children.some(node => node.tag === 'img'));
  }
});
test('missing source and foreign, inline, and malformed URLs never create an image node', () => {
  dom();
  for (const url of [undefined, 'https://example.test/image.png', '//example.test/x', 'data:image/png;base64,AAAA', 'blob:test', '/api/primaries/key/history/image?x=1#fragment']) {
    const figure = transcriptImage(image, url) as unknown as FakeNode;
    assert.ok(!figure.children.some(node => node.tag === 'img')); assert.match(figure.textContent, /This image is not available/);
  }
});
