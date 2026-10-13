import { LIMITS, type DraftImage, type Target } from '../shared/api.ts';
import { ApiError } from './errors.mts';
export function fields(body: Record<string, unknown>, allowed: string[], required: string[] = []) {
  if (Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !(key in body))) throw new ApiError('invalid_request', 'The request fields are invalid.');
}
export function string(value: unknown, name: string, max: number = LIMITS.idChars) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError('invalid_request', `The ${name} is invalid.`);
  return value;
}
export function text(value: unknown, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new ApiError('invalid_request', 'The input text is empty or invalid.');
  if (Buffer.byteLength(value) > LIMITS.textBytes) throw new ApiError('payload_too_large', 'The input text exceeds the size bound.', 413);
  return value;
}
export function integer(value: unknown, name: string, min = 0) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new ApiError('invalid_request', `The ${name} is invalid.`);
  return value;
}
export function boolean(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw new ApiError('invalid_request', `The ${name} is invalid.`); return value;
}
export function choice<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new ApiError('invalid_request', `The ${name} is invalid.`); return value as T;
}
export function target(value: unknown): Target {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_request', 'The target is invalid.');
  const body = value as Record<string, unknown>;
  if (body.kind === 'primary') { fields(body, ['kind', 'key', 'epoch'], ['key','epoch']); return {kind: 'primary', key: string(body.key, 'primary key'), epoch: integer(body.epoch, 'epoch')}; }
  if (body.kind === 'agent') { fields(body, ['kind', 'identity'], ['identity']); return {kind: 'agent', identity: string(body.identity, 'agent identity')}; }
  throw new ApiError('invalid_request', 'The target kind is invalid.');
}
export function limit(url: URL, defaultValue = 50) {
  const raw = url.searchParams.get('limit');
  if (raw === null) return defaultValue;
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.pageItems) throw new ApiError('invalid_request', 'The page limit is invalid.');
  return value;
}
export function cursor(value: string | null) {
  if (value && Buffer.byteLength(value) > LIMITS.cursorBytes) throw new ApiError('invalid_request', 'The cursor exceeds the size bound.'); return value ?? undefined;
}
export function imageName(value: unknown): string {
  if (typeof value !== 'string' || !value || Array.from(value).length > LIMITS.imageNameCodePoints || /[\u0000-\u001f\u007f-\u009f/\\\uD800-\uDFFF]/u.test(value)) throw new ApiError('invalid_image_reference', 'The image name is invalid.');
  return value;
}
export function normalizeDraftImages(value: unknown): DraftImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.imagesPerDraft) throw new ApiError('invalid_image_reference', 'The image list exceeds its bound.');
  let bytes = 0, encoded = 0; const digests = new Set<string>();
  const result = value.map(raw => {
    if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype) throw new ApiError('invalid_image_reference', 'Image metadata must be an object.');
    fields(raw, ['digest', 'mimeType', 'bytes', 'width', 'height', 'name'], ['digest', 'mimeType', 'bytes', 'width', 'height', 'name']);
    if (typeof raw.digest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.digest) || digests.has(raw.digest)) throw new ApiError('invalid_image_reference', 'The image digest is invalid or duplicated.');
    digests.add(raw.digest);
    const mimeType = choice(raw.mimeType, ['image/png', 'image/jpeg'], 'image type');
    const size = integer(raw.bytes, 'image bytes', 1), width = integer(raw.width, 'image width', 1), height = integer(raw.height, 'image height', 1);
    if (size > LIMITS.imageBytes || width > LIMITS.imageEdge || height > LIMITS.imageEdge || width * height > LIMITS.imagePixels) throw new ApiError('invalid_image_reference', 'Image metadata exceeds its bounds.');
    bytes += size; encoded += 4 * Math.ceil(size / 3);
    return {digest: raw.digest, mimeType, bytes: size, width, height, name: imageName(raw.name)};
  });
  if (bytes > LIMITS.draftImageBytes || encoded > LIMITS.imageBase64Bytes) throw new ApiError('invalid_image_reference', 'The image list exceeds its byte bound.');
  return result;
}
