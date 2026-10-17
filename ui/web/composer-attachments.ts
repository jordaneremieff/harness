import { LIMITS, sameDraftImages } from '../shared/api.ts';
import type { DraftImage, Target } from '../shared/api.ts';
import { ApiError, draftImageUrl, uploadDraftImage } from './transport.ts';
import { button, element } from './dom.ts';

export function previewAttachment(workspace: string, targetKey: string, image: DraftImage, invoker: HTMLElement): void {
  const dialog = element('dialog', 'attachment-dialog'); dialog.setAttribute('aria-label', `Preview ${image.name}`);
  const picture = element('img'); picture.src = draftImageUrl(workspace, targetKey, image.digest); picture.alt = image.name;
  picture.decoding = 'async'; picture.referrerPolicy = 'no-referrer';
  const error = element('p', 'warning'); picture.addEventListener('error', () => {error.textContent = 'The image is unavailable. Its saved reference is unchanged.';});
  dialog.append(element('p', 'attachment-name', image.name), picture, error, button('Close preview', () => dialog.close()));
  dialog.addEventListener('close', () => {dialog.remove(); if (invoker.isConnected) invoker.focus({preventScroll: true});}, {once: true});
  document.body.append(dialog); dialog.showModal();
}
export function attachmentSummary(workspace: string, targetKey: string, images: readonly DraftImage[]): HTMLElement {
  const list = element('ul', 'attachment-summary');
  for (const image of images) {
    const row = element('li'); const preview = button(`Preview ${image.name}`, () => previewAttachment(workspace, targetKey, image, preview));
    row.append(element('span', 'attachment-name', image.name), element('code', 'attachment-digest', image.digest), preview); list.append(row);
  }
  return list;
}
export type AttachmentTarget = {workspace: string; targetKey: string; target: Target};
export type AttachmentItem = {id: number; name: string; file?: File; state: 'preparing' | 'including' | 'failed' | 'text'; prepared?: string; error?: string; abort: AbortController};
export type AttachmentReloadState = {items:Array<Omit<AttachmentItem,'abort'>&{lastModified?:number}>;local:Array<{file:Blob;image:DraftImage}>};
type AttachmentHooks = {images: () => readonly DraftImage[]; add: (image: DraftImage) => void; changed: () => void; refusal: () => string | undefined};
const fileJobs: (() => Promise<void>)[] = [];
let activeFiles = 0;
function pumpFiles(): void {
  while (activeFiles < LIMITS.imageUploads && fileJobs.length) {
    const job = fileJobs.shift(); if (!job) return;
    activeFiles++;
    void job().finally(() => {activeFiles--; pumpFiles();});
  }
}
function fileJob(run: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (fileJobs.length >= LIMITS.imagesPerDraft * LIMITS.imageUploads) {reject(new Error('Attachment preparation is full. Retry after other files finish.')); return;}
    fileJobs.push(async () => {try {await run(); resolve();} catch (error) {reject(error);}}); pumpFiles();
  });
}
function imageType(bytes: Uint8Array): DraftImage['mimeType'] | undefined {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  return undefined;
}
export function attachmentName(name: string): string {
  if (!name || [...name].length > LIMITS.imageNameCodePoints || /[\x00-\x1f\x7f/\\]/.test(name)) throw new Error('The filename is empty, too long, or contains unsupported characters.');
  return name;
}
function dimensions(width: number, height: number): {width: number; height: number} {
  if (!width || !height || width > LIMITS.imageEdge || height > LIMITS.imageEdge || width * height > LIMITS.imagePixels) throw new Error('Image dimensions exceed the attachment limit.');
  return {width, height};
}
function pngSize(bytes: Uint8Array, view: DataView): {width: number; height: number} {
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 45 || view.getUint32(8) !== 13 || tag(12) !== 'IHDR') throw new Error('Invalid PNG header.');
  const size = dimensions(view.getUint32(16), view.getUint32(20));
  let offset = 8, chunks = 0, data = false;
  while (offset + 12 <= bytes.length && ++chunks <= 65536) {
    const length = view.getUint32(offset), type = tag(offset + 4);
    if (length > bytes.length - offset - 12 || type === 'acTL') throw new Error('Animated or malformed PNG is not supported.');
    if (type === 'IDAT') data = true;
    offset += length + 12;
    if (type === 'IEND') {if (!data || length !== 0 || offset !== bytes.length) throw new Error('Invalid PNG container.'); return size;}
  }
  throw new Error('Invalid PNG container.');
}
function jpegSegment(bytes: Uint8Array, view: DataView, start: number): {offset: number; marker: number; length: number} {
  let offset = start;
  if (bytes[offset++] !== 255) throw new Error('Invalid JPEG header.');
  while (bytes[offset] === 255) offset++;
  const marker = bytes[offset++];
  if (marker === undefined || offset + 2 > bytes.length) throw new Error('Invalid JPEG header.');
  const length = view.getUint16(offset);
  if (length < 2 || offset + length > bytes.length) throw new Error('Invalid JPEG segment.');
  return {offset, marker, length};
}
function jpegSize(bytes: Uint8Array, view: DataView): {width: number; height: number} {
  if (bytes.length < 4 || view.getUint16(bytes.length - 2) !== 0xffd9) throw new Error('Invalid JPEG container.');
  let offset = 2;
  while (offset + 4 <= bytes.length && offset < 65536) {
    const segment = jpegSegment(bytes, view, offset), {marker, length} = segment; offset = segment.offset;
    if (marker === 0xda || marker === 0xd9) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw new Error('Invalid JPEG dimensions.');
      return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    offset += length;
  }
  throw new Error('JPEG dimensions are unavailable within the header limit.');
}
/** Matches the server's bounded container policy; browser decoding is a separate check. */
export function attachmentMetadata(bytes: Uint8Array): Omit<DraftImage, 'digest' | 'name'> {
  if (!bytes.length || bytes.length > LIMITS.imageBytes) throw new Error('An image must contain at most 8 MiB.');
  const mimeType = imageType(bytes); if (!mimeType) throw new Error('Only PNG and JPEG images are supported.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {mimeType, bytes: bytes.length, ...(mimeType === 'image/png' ? pngSize(bytes, view) : jpegSize(bytes, view))};
}
export function includedText(bytes: Uint8Array, name: string): string {
  attachmentName(name);
  if (bytes.length > LIMITS.textFileBytes) throw new Error('Text files must contain at most 32 KiB.');
  let text: string;
  try {text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);} catch {throw new Error('This file is not valid UTF-8 text.');}
  if (text.includes('\0')) throw new Error('Text files must not contain NUL characters.');
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `File: ${JSON.stringify(name)}\n${fence}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n`;
}
export function missingImageIndexes(error: unknown, targetKey: string, images: readonly DraftImage[]): number[] | undefined {
  if (!(error instanceof ApiError) || error.view.code !== 'unknown_image_digest' || error.view.details?.truncated) return undefined;
  const value = error.view.details?.value;
  if (!value || typeof value !== 'object' || !('targetKey' in value) || value.targetKey !== targetKey || !('missingIndexes' in value) || !Array.isArray(value.missingIndexes)) return undefined;
  const indexes = value.missingIndexes;
  if (!indexes.length || indexes.length > images.length || new Set(indexes).size !== indexes.length || indexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= images.length)) return undefined;
  return indexes;
}
/** Local files are transient preparation state, never an additional draft revision or delivery queue. */
export class ComposerAttachments {
  readonly items: AttachmentItem[] = [];
  private serial = 0;
  private local = new Map<string, {file: Blob; image: DraftImage}>();
  private target: AttachmentTarget;
  private hooks: AttachmentHooks;
  private disposed = false;
  private running = false;
  private renewals = new Set<AbortController>();
  constructor(target: AttachmentTarget, hooks: AttachmentHooks) {this.target = {...target, target: {...target.target}}; this.hooks = hooks;}
  captureReload(): AttachmentReloadState {
    this.suspend();
    return {items:this.items.map(({abort: _abort,...item})=>({...item,lastModified:item.file?.lastModified})),local:[...this.local.values()].map(value=>({...value,image:{...value.image}}))};
  }
  restoreReload(value: AttachmentReloadState): void {
    if(this.pending||this.local.size||!Array.isArray(value.items)||value.items.length>LIMITS.imagesPerDraft||!Array.isArray(value.local)||value.local.length>LIMITS.imagesPerDraft)throw new Error('Attachment preservation state changed.');
    for(const item of value.items)if(!Number.isSafeInteger(item.id)||item.id<1||typeof item.name!=='string'||!item.file||!(item.file instanceof Blob)||!['failed','text'].includes(item.state))throw new Error('Attachment preservation bytes are unavailable.');
    for(const item of value.local)if(!(item.file instanceof Blob)||typeof item.image?.digest!=='string')throw new Error('Image preservation bytes are unavailable.');
    for(const item of value.items){this.serial=Math.max(this.serial,item.id);this.items.push({...item,file:new File([item.file as Blob],item.name,{type:item.file?.type,lastModified:item.lastModified}),abort:new AbortController()});}
    for(const item of value.local)this.local.set(item.image.digest,{file:item.file,image:{...item.image}});
  }
  get pending(): boolean {return this.items.length > 0;}
  get busy(): boolean {return this.items.some(item => item.state === 'preparing' || item.state === 'including');}
  add(files: readonly File[]): void {
    if (files.length > LIMITS.imagesPerDraft || this.items.length + files.length > LIMITS.imagesPerDraft) throw new Error('Choose at most four files at once. Remove unfinished files before adding more.');
    for (const file of files) {
      const item: AttachmentItem = {id: ++this.serial, name: file.name, file, state: 'preparing', abort: new AbortController()};
      this.items.push(item);
    }
    this.hooks.changed(); this.run();
  }
  private run(): void {
    if (this.running || this.disposed) return;
    const item = this.items.find(item => item.state === 'preparing' && !item.abort.signal.aborted); if (!item) return;
    this.running = true; const attempt = item.abort;
    void fileJob(() => this.prepare(item, attempt)).catch(error => {
      if (this.owns(item, attempt)) {item.state = 'failed'; item.error = error instanceof Error ? error.message : 'Attachment preparation failed.';}
    }).finally(() => {this.running = false; this.hooks.changed(); this.run();});
  }
  private owns(item: AttachmentItem, attempt = item.abort): boolean {return !this.disposed && this.items.includes(item) && item.abort === attempt && !attempt.signal.aborted;}
  private require(item: AttachmentItem, attempt: AbortController): void {
    if (!this.owns(item, attempt)) throw new Error('Attachment preparation stopped.');
    const refusal = this.hooks.refusal(); if (refusal) throw new Error(refusal);
  }
  private async prepare(item: AttachmentItem, attempt: AbortController): Promise<void> {
    try {
      const file = item.file; if (!this.owns(item, attempt) || !file) return;
      const image = await this.readFile(file, item, attempt); if (!image) return;
      this.require(item, attempt); this.admit(image);
      const uploaded = await uploadDraftImage(this.target.workspace, this.target.targetKey, this.target.target, image, file, attempt.signal);
      this.require(item, attempt);
      if (uploaded.targetKey !== this.target.targetKey || JSON.stringify(uploaded.target) !== JSON.stringify(this.target.target) || !sameDraftImages([image], [uploaded.image])) throw new Error('The uploaded image does not match the captured file and recipient.');
      this.admit(image);
      this.local.set(image.digest, {file, image}); this.hooks.add(image);
      this.items.splice(this.items.indexOf(item), 1);
    } catch (error) {
      if (this.items.includes(item) && item.abort === attempt) {item.state = 'failed'; item.error = error instanceof Error ? error.message : 'Attachment preparation failed.';}
    } finally {this.hooks.changed();}
  }
  private async readFile(file: File, item: AttachmentItem, attempt: AbortController): Promise<DraftImage | undefined> {
    attachmentName(item.name);
    if (file.size > LIMITS.imageBytes) throw new Error('This file exceeds the 8 MiB image limit.');
    const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!this.owns(item, attempt)) return;
    if (!imageType(header)) {
      if (file.type.startsWith('image/')) throw new Error('Only valid PNG and JPEG images are supported.');
      if (file.size > LIMITS.textFileBytes) throw new Error('Non-image files must be valid UTF-8 text of at most 32 KiB.');
      includedText(new Uint8Array(await file.arrayBuffer()), item.name);
      if (this.owns(item, attempt)) item.state = 'text'; return;
    }
    this.require(item, attempt);
    if (this.hooks.images().length >= LIMITS.imagesPerDraft || file.size + this.hooks.images().reduce((sum, image) => sum + image.bytes, 0) > LIMITS.draftImageBytes) throw new Error('A draft accepts four images totaling at most 8 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const metadata = attachmentMetadata(bytes);
    this.require(item, attempt);
    const bitmap = await createImageBitmap(file);
    try {dimensions(bitmap.width, bitmap.height);} finally {bitmap.close();}
    this.require(item, attempt);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    this.require(item, attempt);
    return {...metadata, digest, name: item.name};
  }
  private admit(image: DraftImage): void {
    const images = this.hooks.images();
    if (images.some(existing => existing.digest === image.digest)) throw new Error('This image is already attached.');
    if (images.length >= LIMITS.imagesPerDraft) throw new Error('A draft accepts at most four images.');
    if (image.bytes + images.reduce((sum, existing) => sum + existing.bytes, 0) > LIMITS.draftImageBytes) throw new Error('The images in one draft must total at most 8 MiB.');
  }
  retry(item: AttachmentItem): void {
    if (!this.items.includes(item) || item.state === 'preparing' || item.state === 'including') return;
    item.abort = new AbortController(); item.error = undefined; item.state = 'preparing'; this.run(); this.hooks.changed();
  }
  remove(item: AttachmentItem): void {
    const index = this.items.indexOf(item); if (index < 0) return;
    item.abort.abort(); item.file = undefined; this.items.splice(index, 1); this.hooks.changed();
  }
  forget(digest: string): void {this.local.delete(digest);}
  suspend(): void {
    let changed = false;
    for (const controller of this.renewals) controller.abort();
    for (const item of this.items) if (item.state === 'preparing' || item.state === 'including') {changed = true; item.abort.abort(); item.state = 'failed'; item.error = 'Preparation stopped. Retry after access returns, or remove this file.';}
    if (changed) this.hooks.changed();
  }
  clear(): void {this.suspend(); for (const item of [...this.items]) this.remove(item); this.local.clear();}
  destroy(): void {this.disposed = true; this.clear();}
  async reacquire(images: readonly DraftImage[], indexes: readonly number[]): Promise<void> {
    if (this.hooks.refusal()) throw new Error('Image upload is unavailable. Your local files are unchanged.');
    for (const index of indexes) {
      const image = images[index], local = image && this.local.get(image.digest);
      if (!image || !local || !sameDraftImages([image], [local.image])) throw new Error('The image lease expired. Reattach the named image from its original file.');
      const controller = new AbortController(); this.renewals.add(controller);
      try {
        await fileJob(async () => {
          controller.signal.throwIfAborted();
          if (this.hooks.refusal() || this.disposed) throw new Error('Image upload is unavailable.');
          const result = await uploadDraftImage(this.target.workspace, this.target.targetKey, this.target.target, image, local.file, controller.signal);
          if (controller.signal.aborted || this.hooks.refusal() || result.targetKey !== this.target.targetKey || JSON.stringify(result.target) !== JSON.stringify(this.target.target) || !sameDraftImages([image], [result.image])) throw new Error('The renewed image does not match this draft.');
        });
      } finally {this.renewals.delete(controller);}
    }
  }
}
