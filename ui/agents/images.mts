import type { AgentService } from './service-runtime.mts';
import { AgentError } from './client.mts';
import { imageDigest, imageSource, readImage, type ImageBytes } from '../server/images.mts';

/** Uses the existing bounded snapshot operation, never redacted inspect or host file access. */
export async function nativeImage(service: Pick<AgentService, 'history'>, identity: string, rawSource: unknown, rawDigest: unknown): Promise<ImageBytes> {
  const source = imageSource(rawSource), digest = imageDigest(rawDigest);
  const entry = Number(source.entryId);
  if (!/^[1-9]\d*$/.test(source.entryId) || !Number.isSafeInteger(entry) || entry >= Number.MAX_SAFE_INTEGER) throw new AgentError('invalid_request', 'The native image entry is invalid.');
  const snapshot = await service.history(identity, {before: entry + 1, limit: 1, maxBytes: 65536});
  const row = snapshot.entries.find(row => String(row.id) === source.entryId);
  if (!row) throw new AgentError('stale_revision', 'The image is absent from the retained conversation.');
  return readImage(row, source, digest);
}
