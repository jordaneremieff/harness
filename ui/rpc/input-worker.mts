import { parentPort, workerData } from 'node:worker_threads';
import { readVerifiedDraftImages, type BlobReadSpec } from '../server/draft-images.mts';
import { LIMITS } from '../shared/api.ts';
import type { PromptEnvelope } from './input-preparation.mts';

const port = parentPort;
if (!port) throw new Error('Input preparation requires a worker port.');
try {
  const {source, envelope} = workerData as {source: BlobReadSpec; envelope: PromptEnvelope};
  if (!Array.isArray(source.images) || !source.images.length || source.images.length > LIMITS.imagesPerDraft ||
      source.images.some(image => !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > LIMITS.imageBytes) ||
      source.images.reduce((sum, image) => sum + image.bytes, 0) > LIMITS.draftImageBytes)
    throw new Error('Image input exceeds its compressed byte or image count limit.');
  const verified = await readVerifiedDraftImages(source);
  let encodedBytes = 0;
  const images = verified.map(image => {
    const data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString('base64');
    encodedBytes += data.length;
    if (encodedBytes > LIMITS.imageBase64Bytes) throw new Error('Image input exceeds its encoded byte limit.');
    return {type: 'image', data, mimeType: image.mimeType};
  });
  const line = `${JSON.stringify({...envelope, images})}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > LIMITS.inputFrameBytes || bytes > LIMITS.preparedInputBytes) throw new Error('Image input exceeds its native frame limit.');
  port.postMessage({prepared: {line, bytes}});
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'image_unavailable';
  port.postMessage({error: {code, message: 'Image input could not be verified or encoded within its limits.'}});
} finally { port.close(); }
