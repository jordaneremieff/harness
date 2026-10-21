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
/** Format, source dimensions and size, led by the attachment name when the image is a stored attachment. */
export function imageCaption(part: ImageView): string {
  return `${part.attachment ? `${part.alt} · ` : ''}${part.mimeType === 'image/png' ? 'PNG' : 'JPEG'} · ${part.width} × ${part.height} · ${Math.ceil(part.bytes / 1024)} KiB`;
}
/** Opens the preview for one validated image URL; the invoker receives focus again when the preview closes. */
export type ImagePreviewOpen = (part: ImageView, url: string, invoker: HTMLElement) => void;
/** Native lazy loading leaves offscreen bytes with the server; only four elements hold image URLs. */
export function transcriptImage(part: ImageView, url?: string, changed: () => void = () => {}, preview?: ImagePreviewOpen): HTMLElement {
  const figure = element('figure', 'transcript-image');
  const caption = element('figcaption', 'transcript-image-caption', imageCaption(part));
  const status = element('p', 'transcript-image-status');
  figure.append(caption, status);
  if (!safeUrl(url)) { setText(status, 'Preview unavailable in this view'); return figure; }
  const previewUrl = url;
  const openPreview = (): void => { if (preview && invoker) preview(part, previewUrl, invoker); };
  const invoker: HTMLButtonElement | undefined = preview ? button('Preview image', openPreview) : undefined;
  if (invoker) caption.append(invoker);
  type AttemptKind = 'initial' | 'automatic' | 'manual';
  type Outcome = {time:string; attempt:number; kind:AttemptKind; outcome:'started'|'load'|'error'|'release'; complete:boolean; naturalWidth:number; naturalHeight:number};
  const disclosure = element('details','transcript-image-details'), log = element('pre','transcript-image-diagnostics'); disclosure.hidden = true;
  disclosure.append(element('summary',undefined,'Load details'),log);
  const outcomes:Outcome[] = []; let omitted = 0, errors = 0, serial = 0, kind:AttemptKind = 'initial', result = 'loading';
  let image:HTMLImageElement|undefined, active = false, automaticUsed = false;
  const record = (outcome:Outcome['outcome'], observed:HTMLImageElement):void => {
    outcomes.push({time:new Date().toISOString(),attempt:serial,kind,outcome,complete:observed.complete,naturalWidth:observed.naturalWidth,naturalHeight:observed.naturalHeight});
    if (outcomes.length > 8) {outcomes.shift(); omitted++;}
    disclosure.hidden = errors === 0;
    log.textContent = JSON.stringify({url,digest:part.digest,result,errors,cause:errors ? 'The image error event did not expose an HTTP or decode cause.' : undefined,omitted,outcomes},null,2);
  };
  const clear = ():void => {
    const previous = image; image = undefined;
    // Chromium can retain an offscreen image tree if src is cleared without removing the image.
    if (previous) {previous.removeAttribute('src'); previous.remove(); previous.hidden = true;}
  };
  const slot:ImageSlot = {release:()=> {
    if (!active || !image) return;
    result = 'released'; record('release',image); active = false; clear(); retry.hidden = false;
    setText(status,'Reload this image to view it.'); changed();
  }};
  const activate = (attemptKind:AttemptKind):void => {
    if (attemptKind === 'manual' && document.activeElement === retry) {figure.tabIndex = -1; figure.focus({preventScroll:true});}
    clear(); reserve(slot); active = true; kind = attemptKind; serial++; result = attemptKind === 'automatic' ? 'retrying' : 'loading';
    const attempt = element('img',invoker ? 'transcript-image-content transcript-image-previewable' : 'transcript-image-content'); image = attempt;
    attempt.alt = part.alt; attempt.width = part.width; attempt.height = part.height;
    if (invoker) attempt.addEventListener('click',openPreview);
    attempt.loading = 'lazy'; attempt.decoding = 'async'; attempt.referrerPolicy = 'no-referrer';
    attempt.addEventListener('load',()=> {if (!active || image !== attempt) return; result = 'loaded'; record('load',attempt); setText(status,''); retry.hidden = true; changed();});
    attempt.addEventListener('error',()=> {
      if (!active || image !== attempt) return;
      result = 'error'; errors++; record('error',attempt);
      const automatic = attemptKind === 'initial' && !automaticUsed && figure.isConnected && !figure.closest('[hidden],[inert]') && !document.hidden;
      active = false; clear();
      if (automatic) {automaticUsed = true; activate('automatic');}
      else {setText(status,'The image could not be loaded.'); retry.hidden = false; changed();}
    });
    record('started',attempt); figure.insertBefore(attempt,retry); retry.hidden = true;
    setText(status,attemptKind === 'automatic' ? 'Retrying image' : 'Loading image'); attempt.src = url; changed();
  };
  const retry = button('Reload image',()=>activate('manual')); retry.hidden = true;
  figure.append(retry,disclosure); activate('initial'); return figure;
}
