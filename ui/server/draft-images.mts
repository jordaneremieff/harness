import { Worker } from 'node:worker_threads';
import type { DraftImage } from '../shared/api.ts';
import type { ImageBytes, ValidatedImage } from './images.mts';
import { ApiError } from './errors.mts';

export type BlobReference = {targetKey: string; image: ValidatedImage; draft: boolean; unresolvedOperationIds: string[]; retainedOperationIds: string[]; leaseExpiresAt?: string};
export type BlobReferenceGraph = {targetKeys: string[]; references: BlobReference[]};
export type BlobReadSpec = {root: string; targetKey: string; images: DraftImage[]};
export type BlobEntry = {targetKey: string; image: ValidatedImage};
export type BlobIndex = {directories: string[]; entries: BlobEntry[]; temps: {targetKey: string; id: string; bytes: number}[]; error?: string; unavailable?: {targetKey: string; digest: string}[]};
export type UploadReservation = {id: string; workspaceId: string; targetKey: string; target: import('../shared/api.ts').Target; mimeType: DraftImage['mimeType']; name: string; maxBytes: number; declaredBytes?: number; receiveDeadlineAt: number};
export type BlobIntake = {write(chunk: Uint8Array): Promise<void>; finish(): Promise<ValidatedImage>; cancel(): Promise<void>};
export function sameImageContent(a: ValidatedImage, b: ValidatedImage): boolean {
  return a.digest === b.digest && a.mimeType === b.mimeType && a.bytes === b.bytes && a.width === b.width && a.height === b.height;
}
/** Binary work has no authority to interpret target or operation state files. */
export class DraftImages {
  private worker: Worker;
  private next = 0;
  private pending = new Map<number, {resolve(value: unknown): void; reject(error: unknown): void}>();
  private closed = false;
  constructor(root: string) {
    this.worker = new Worker(new URL('./draft-images-worker.mts', import.meta.url), {workerData: {root}});
    this.worker.on('message', (reply: {id: number; value?: unknown; error?: {code: string; message: string; status: number}}) => {
      const item = this.pending.get(reply.id); if (!item) return;
      this.pending.delete(reply.id);
      if (reply.error) item.reject(new ApiError(reply.error.code, reply.error.message, reply.error.status)); else item.resolve(reply.value);
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => this.fail());
  }
  private fail(): void {
    this.closed = true;
    for (const item of this.pending.values()) item.reject(new ApiError('image_storage_unavailable', 'Image storage worker is unavailable.', 503));
    this.pending.clear();
  }
  private request<T>(action: string, body: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new ApiError('image_storage_unavailable', 'Image storage is closed.', 503));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {resolve: value => resolve(value as T), reject});
      try { this.worker.postMessage({id, action, body}); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  scan(graph: BlobReferenceGraph): Promise<BlobIndex> { return this.request('scan', graph); }
  async begin(reservation: UploadReservation): Promise<BlobIntake> {
    await this.request('begin', reservation);
    let finished = false, writing = false;
    return {
      write: async chunk => {
        if (finished || writing) throw new ApiError('invalid_request', 'Image intake requires one acknowledged chunk at a time.');
        writing = true;
        try {
          for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) await this.request('write', {id: reservation.id, data: chunk.slice(offset, offset + 64 * 1024)});
        } catch (error) { finished = true; throw error; } finally { writing = false; }
      },
      finish: async () => {
        if (finished || writing) throw new ApiError('invalid_request', 'Image intake is not ready to finish.');
        const value = await this.request<ValidatedImage>('finish', {id: reservation.id}); finished = true; return value;
      },
      cancel: async () => { finished = true; await this.request('cancel', {id: reservation.id, targetKey: reservation.targetKey}); },
    };
  }
  publish(reservation: UploadReservation, image: ValidatedImage): Promise<void> { return this.request('publish', {reservation, image}); }
  cancel(reservation: UploadReservation): Promise<void> { return this.request('cancel', {id: reservation.id, targetKey: reservation.targetKey}); }
  verify(targetKey: string, image: ValidatedImage): Promise<void> { return this.request('verify', {targetKey, image}); }
  read(targetKey: string, image: ValidatedImage): Promise<ImageBytes> { return this.request('read', {targetKey, image}); }
  reference(targetKey: string, image: ValidatedImage): Promise<string> { return this.request('reference', {targetKey, image}); }
  remove(entry: {targetKey: string; image?: ValidatedImage; id?: string}): Promise<void> { return this.request('remove', entry); }
  async close(): Promise<void> {
    if (this.pending.size) throw new ApiError('not_ready', 'Image storage still has active work.', 503);
    this.closed = true; await this.worker.terminate();
  }
}
/** File references use the verified target-bound blob retained by the input receipt. */
export async function verifiedImageReferences(spec: BlobReadSpec): Promise<string[]> {
  const worker = new DraftImages(spec.root);
  try {
    const references:string[]=[];
    for(const image of spec.images) references.push(await worker.reference(spec.targetKey,image));
    return references;
  } finally {await worker.close();}
}
/** Dispatch workers read only explicit target-bound references, never a state ledger. */
export async function readVerifiedDraftImages(spec: BlobReadSpec): Promise<ImageBytes[]> {
  const worker = new DraftImages(spec.root);
  try {
    const result: ImageBytes[] = [];
    for (const image of spec.images) result.push(await worker.read(spec.targetKey, image));
    return result;
  } finally { await worker.close(); }
}
