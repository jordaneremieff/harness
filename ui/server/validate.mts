import { LIMITS, type Target } from '../shared/api.ts';
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
