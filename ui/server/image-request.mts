import type { ImageSource } from '../shared/api.ts';
import { ApiError } from './errors.mts';
import { imageDigest, imageSource } from './images.mts';

export function isImageRoute(method: string, parts: string[]): boolean {
  return method === 'GET' && parts.length === 5 && parts[3] === 'history' && parts[4] === 'image';
}
export function imageRequest(url: URL, primary: boolean): {source: ImageSource; digest: string; epoch?: number} {
  const allowed = ['entry', 'message', 'part', 'digest', 'workspace', ...(primary ? ['epoch'] : [])];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new ApiError('invalid_request', 'The image request fields are invalid.');
  const integer = (name: string) => {
    const value = url.searchParams.get(name);
    if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ApiError('invalid_request', `The image ${name} is invalid.`);
    return Number(value);
  };
  const source = imageSource({entryId: url.searchParams.get('entry'), message: integer('message'), part: integer('part')}), digest = imageDigest(url.searchParams.get('digest'));
  if (!primary && (!/^[1-9]\d*$/.test(source.entryId) || !Number.isSafeInteger(Number(source.entryId)) || Number(source.entryId) >= Number.MAX_SAFE_INTEGER)) throw new ApiError('invalid_request', 'The native image entry is invalid.');
  return {source, digest, ...(primary ? {epoch: integer('epoch')} : {})};
}
