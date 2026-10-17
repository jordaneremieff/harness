import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DraftImage, ImageView, ImageSource, MessageView, PartView } from '../shared/api.ts';
import { ApiError } from './errors.mts';

export type SentImageReceipt = {targetKey: string; images: DraftImage[]; messageDigest: string};
export function imageReferenceLines(images: readonly DraftImage[], paths: readonly string[]): string[] {
  return images.map((image, index) => `Attached image ${JSON.stringify(image.name)} (${image.mimeType}): ${paths[index]}`);
}
export function imageReferenceMessage(text: string, images: readonly DraftImage[], paths: readonly string[]): string {
  return [text, ...imageReferenceLines(images, paths)].filter(Boolean).join('\n\n');
}
export function imageMessageDigest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
/** Only a complete admitted user message owns display ranges; raw text remains unchanged. */
export function sentImageAttachments(message: MessageView, receipt: SentImageReceipt, root: string, workspaceId: string): MessageView['attachments'] {
  if (message.role !== 'user' || message.state !== 'final' || !message.coverage.complete || message.coverage.truncated || message.coverage.omitted || message.parts.length !== 1) return;
  const part = message.parts[0];
  if (part.type !== 'text' || part.redacted || part.more || part.structured?.truncated || imageMessageDigest(part.text) !== receipt.messageDigest) return;
  const lines = imageReferenceLines(receipt.images, receipt.images.map(image => join(root, 'images', receipt.targetKey, `${image.digest}.bin`)));
  const suffix = lines.join('\n\n');
  if (!part.text.endsWith(suffix)) return;
  let start = part.text.length - suffix.length;
  if (start !== 0 && part.text.slice(start - 2, start) !== '\n\n') return;
  return receipt.images.map((image, index) => {
    const range = {part: 0, start, end: start + lines[index].length, image: {type: 'image' as const, mimeType: image.mimeType, digest: image.digest,
      bytes: image.bytes, width: image.width, height: image.height, alt: image.name, attachment: {workspaceId, targetKey: receipt.targetKey}}};
    start = range.end + 2; return range;
  });
}

export const IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_PIXELS = 16 * 1024 * 1024;
export const IMAGE_EDGE = 8192;
const ENCODED_BYTES = 4 * Math.ceil(IMAGE_BYTES / 3);
export type ImageBytes = {mimeType: ImageView['mimeType']; data: Uint8Array};
/** Only this server-owned wrapper permits a same-origin binary HTTP response. */
export class ImageResponse {
  readonly image: ImageBytes;
  constructor(image: ImageBytes) { this.image = image; }
}
function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}
function invalid(message = 'Image is malformed or unsupported.'): never { throw new ApiError('invalid_request', message, 422); }
function dimensions(width: number, height: number): {width: number; height: number} {
  if (width <= 0 || height <= 0 || width > IMAGE_EDGE || height > IMAGE_EDGE || width * height > IMAGE_PIXELS) invalid('Image dimensions exceed the display limit.');
  return {width, height};
}
function png(bytes: Buffer): {width: number; height: number} {
  if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid();
  const size = dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  let offset = 8, chunks = 0, data = false;
  while (offset + 12 <= bytes.length && ++chunks <= 65536) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || type === 'acTL') invalid('Animated or malformed PNG is unavailable.');
    if (type === 'IDAT') data = true;
    offset += length + 12;
    if (type === 'IEND') { if (!data || length !== 0 || offset !== bytes.length) invalid(); return size; }
  }
  return invalid();
}
function jpegSegment(bytes: Buffer, start: number): {marker: number; offset: number; length: number} {
  let offset = start;
  if (bytes[offset++] !== 0xff) invalid();
  while (bytes[offset] === 0xff) offset++;
  const marker = bytes[offset++];
  if (marker === undefined || offset + 2 > bytes.length) invalid();
  const length = bytes.readUInt16BE(offset);
  if (length < 2 || offset + length > bytes.length) invalid();
  return {marker, offset, length};
}
function jpeg(bytes: Buffer): {width: number; height: number} {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) invalid();
  let offset = 2;
  while (offset + 4 <= bytes.length && offset < 65536) {
    const segment = jpegSegment(bytes, offset); const {marker, length} = segment; offset = segment.offset;
    if (marker === 0xda || marker === 0xd9) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) invalid();
      return dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  return invalid('JPEG dimensions are unavailable within the header limit.');
}
export type ValidatedImage = Omit<DraftImage, 'name'>;
/** Binary policy is shared with transcript decoding; callers run it in workers. */
export function validateImageBytes(raw: Uint8Array, mimeType: DraftImage['mimeType']): ValidatedImage {
  const data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (!data.length || data.length > IMAGE_BYTES || !['image/png', 'image/jpeg'].includes(mimeType)) invalid('Image bytes or type exceed the allowed bounds.');
  const size = mimeType === 'image/png' ? png(data) : jpeg(data);
  return {digest: createHash('sha256').update(data).digest('hex'), mimeType, bytes: data.length, ...size};
}
function decode(raw: unknown): {view: ImageView; data: Buffer} {
  const part = record(raw);
  if (part.type !== 'image' || !['image/png', 'image/jpeg'].includes(String(part.mimeType))) invalid('Only static PNG and JPEG images are supported.');
  if (typeof part.data !== 'string' || !part.data.length || part.data.length > ENCODED_BYTES) invalid('Image data exceeds the 8 MiB limit or is absent.');
  if (part.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) invalid('Image base64 is invalid.');
  const data = Buffer.from(part.data, 'base64');
  if (data.length > IMAGE_BYTES || data.toString('base64') !== part.data) invalid('Image base64 is invalid or exceeds the limit.');
  const mimeType = part.mimeType as ImageView['mimeType'];
  const image = validateImageBytes(data, mimeType);
  return {view: {type: 'image', ...image, alt: `Transcript image (${mimeType === 'image/png' ? 'PNG' : 'JPEG'}, ${image.width} × ${image.height})`}, data};
}
/** Projection emits metadata only and never retains the encoded or decoded image. */
export function imagePart(raw: unknown): PartView {
  try {
    const part = record(raw);
    if (part.type === 'image' && !('data' in part)) {
      if (!['image/png', 'image/jpeg'].includes(String(part.mimeType)) || !Number.isSafeInteger(part.bytes) || Number(part.bytes) < 1 || Number(part.bytes) > IMAGE_BYTES || !Number.isSafeInteger(part.width) || !Number.isSafeInteger(part.height)) invalid();
      const size = dimensions(Number(part.width), Number(part.height));
      return {type: 'image', mimeType: part.mimeType as ImageView['mimeType'], digest: imageDigest(part.digest), bytes: Number(part.bytes), ...size,
        alt: `Transcript image (${part.mimeType === 'image/png' ? 'PNG' : 'JPEG'}, ${size.width} × ${size.height})`, ...(part.source !== undefined ? {source: imageSource(part.source)} : {})};
    }
    return decode(raw).view;
  }
  catch (error) { return {type: 'omitted', label: error instanceof ApiError ? error.message : 'Image is unavailable.'}; }
}
export function imageSource(raw: unknown): ImageSource {
  const value = record(raw);
  if (typeof value.entryId !== 'string' || !value.entryId || value.entryId.length > 256 || /[\x00-\x1f\x7f]/.test(value.entryId) || !Number.isSafeInteger(value.message) || Number(value.message) < 0 || Number(value.message) >= 8 || !Number.isSafeInteger(value.part) || Number(value.part) < 0 || Number(value.part) >= 100) throw new ApiError('invalid_request', 'The image source is invalid.');
  return {entryId: value.entryId, message: Number(value.message), part: Number(value.part)};
}
export function imageDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ApiError('invalid_request', 'The image identity is invalid.');
  return value;
}
function imageMessages(value: Record<string, unknown>): unknown[] {
  if (value.type === 'custom_message') return [value];
  if (value.message !== undefined) return [value.message];
  if (Array.isArray(value.messages)) return value.messages;
  return Array.isArray(value.model) ? value.model : [];
}
/** Re-read an exact source part and reject changed content rather than substituting another image. */
export function readImage(entry: unknown, source: ImageSource, digest: string): ImageBytes {
  imageSource(source); imageDigest(digest);
  const value = record(entry);
  if (String(value.id) !== source.entryId || (value.type === 'custom_message' && value.display === false)) throw new ApiError('stale_revision', 'The image entry is unavailable.', 409, 'read');
  const message = record(imageMessages(value)[source.message]);
  if (message.role === 'custom' && message.display === false) invalid('Hidden image content is unavailable.');
  const content = Array.isArray(message.content) ? message.content : Array.isArray(message.parts) ? message.parts : [];
  const result = decode(content[source.part]);
  if (result.view.digest !== digest) throw new ApiError('stale_revision', 'The image source changed; reload the transcript.', 409, 'read');
  return {mimeType: result.view.mimeType, data: result.data};
}
