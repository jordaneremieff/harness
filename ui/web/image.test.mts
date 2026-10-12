import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { imageUrl, transcriptImage } from './image.ts';
import type { ImageView } from '../shared/api.ts';
class FakeNode extends EventTarget {
  tag: string; children: FakeNode[] = []; className = ''; hidden = false; private text = '';
  src = ''; alt = ''; width = 0; height = 0; loading = ''; decoding = ''; referrerPolicy = '';
  constructor(tag: string) { super(); this.tag = tag; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: FakeNode[]): void { this.children.push(...nodes); }
  removeAttribute(name: string): void { if (name === 'src') this.src = ''; }
}
const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
const image: ImageView = {type: 'image', mimeType: 'image/png', digest: 'a'.repeat(64), bytes: 1024, width: 300, height: 200, alt: 'Transcript image (PNG, 300 × 200)', source: {entryId: '42', message: 0, part: 1}};
function dom() { Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new FakeNode(tag)}}); }
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
  // Expectations use the display labels while preserving source and action checks.
  img.dispatchEvent(new Event('error')); assert.equal(img.hidden, true); assert.equal(retry.hidden, false); assert.match(figure.textContent, /The image could not be loaded/);
  retry.dispatchEvent(new Event('click')); assert.equal(img.hidden, false); assert.equal(retry.hidden, true);
  img.dispatchEvent(new Event('load')); assert.equal(changes, 4);
  assert.equal(figure.children.find(node => node.className === 'transcript-image-status')?.textContent, '');
});
test('only four image elements retain source URLs and eviction exposes a reload control', () => {
  dom(); const url = imageUrl(image, {kind: 'primary', key: 'key', epoch: 1});
  const figures = Array.from({length: 6}, () => transcriptImage(image, url) as unknown as FakeNode);
  const images = figures.map(figure => { const image = figure.children.find(node => node.tag === 'img'); assert.ok(image); return image; });
  assert.equal(images.filter(image => image.src).length, 4); assert.equal(images[0]?.src, '');
  const first = figures[0]; assert.ok(first); assert.match(first.textContent, /Reload this image to view it/);
  const retry = first.children.find(node => node.tag === 'button'); assert.ok(retry); assert.equal(retry.hidden, false);
  const firstImage = images[0]; assert.ok(firstImage); firstImage.dispatchEvent(new Event('error')); assert.equal(retry.hidden, false);
  retry.dispatchEvent(new Event('click')); assert.equal(images[0]?.src, url);
  assert.equal(images.filter(image => image.src).length, 4);
});
test('missing source and foreign, inline, and malformed URLs never create an image node', () => {
  dom();
  for (const url of [undefined, 'https://example.test/image.png', '//example.test/x', 'data:image/png;base64,AAAA', 'blob:test', '/api/primaries/key/history/image?x=1#fragment']) {
    const figure = transcriptImage(image, url) as unknown as FakeNode;
    assert.ok(!figure.children.some(node => node.tag === 'img')); assert.match(figure.textContent, /This image is not available/);
  }
});
