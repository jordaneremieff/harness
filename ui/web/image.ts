import type { ImageView, Target } from '../shared/api.ts';
import { button, element, setText } from './dom.ts';
import {draftImageUrl} from './transport.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** URLs carry only exact transcript or stored attachment identities, never source bytes or filesystem paths. */
export function imageUrl(part: ImageView, target: Target, workspace?: string): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(part.digest)) return undefined;
  if (part.attachment) {
    const {workspaceId, targetKey} = part.attachment;
    if (part.source || typeof workspaceId !== 'string' || typeof targetKey !== 'string' || !UUID.test(workspaceId) || !UUID.test(targetKey)) return undefined;
    return draftImageUrl(workspaceId, targetKey, part.digest);
  }
  if (!part.source) return undefined;
  const query = new URLSearchParams({entry: part.source.entryId, message: String(part.source.message), part: String(part.source.part), digest: part.digest});
  if (workspace) query.set('workspace', workspace);
  if (target.kind === 'primary') query.set('epoch', String(target.epoch));
  const identity = target.kind === 'primary' ? target.key : target.identity;
  return `/api/${target.kind === 'primary' ? 'primaries' : 'agents'}/${encodeURIComponent(identity)}/history/image?${query}`;
}
function safeUrl(url: string | undefined): url is string {
  return typeof url === 'string' && (/^\/api\/(?:primaries|agents)\/[^/?#]+\/history\/image\?[^#]*$/.test(url) || /^\/api\/workspaces\/[a-f0-9-]{36}\/targets\/[a-f0-9-]{36}\/images\/[a-f0-9]{64}$/i.test(url)) && !/[\\\x00-\x20\x7f]/.test(url);
}
type ImageSlot = {release: () => void};
const slots: WeakRef<ImageSlot>[] = [];
function reserve(slot: ImageSlot): void {
  for (let index = slots.length - 1; index >= 0; index--) if (!slots[index]?.deref() || slots[index]?.deref() === slot) slots.splice(index, 1);
  while (slots.length >= 4) slots.shift()?.deref()?.release();
  slots.push(new WeakRef(slot));
}
/** Native lazy loading leaves offscreen bytes with the server; only four elements hold image URLs. */
export function transcriptImage(part: ImageView, url?: string, changed: () => void = () => {}): HTMLElement {
  const figure = element('figure', 'transcript-image');
  const caption = element('figcaption', 'transcript-image-caption', `${part.attachment ? `${part.alt} · ` : ''}${part.mimeType === 'image/png' ? 'PNG' : 'JPEG'} · ${part.width} × ${part.height} · ${Math.ceil(part.bytes / 1024)} KiB`);
  const status = element('p', 'transcript-image-status');
  figure.append(caption, status);
  if (!safeUrl(url)) { setText(status, 'This image is not available.'); return figure; }
  const image = element('img', 'transcript-image-content');
  image.alt = part.alt; image.width = part.width; image.height = part.height;
  image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
  let active = false;
  const clear = () => {
    // Chromium can retain an offscreen image tree if src is cleared without removing the image.
    image.removeAttribute('src'); image.remove(); image.hidden = true;
  };
  const slot: ImageSlot = {release: () => {
    active = false; clear(); retry.hidden = false;
    setText(status, 'Reload this image to view it.'); changed();
  }};
  const activate = () => {
    if (document.activeElement === retry) { figure.tabIndex = -1; figure.focus({preventScroll: true}); }
    reserve(slot); active = true;
    if (image.parentElement !== figure) figure.insertBefore(image, retry);
    image.hidden = false; retry.hidden = true; setText(status, 'Loading image…'); image.src = url; changed();
  };
  const retry = button('Reload image', activate);
  retry.hidden = true;
  image.addEventListener('load', () => { if (!active) return; setText(status, ''); retry.hidden = true; changed(); });
  image.addEventListener('error', () => { if (!active) return; active = false; clear(); setText(status, 'The image could not be loaded.'); retry.hidden = false; changed(); });
  figure.append(image, retry); activate(); return figure;
}
