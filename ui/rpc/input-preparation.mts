import { Worker } from 'node:worker_threads';
import type { BlobReadSpec } from '../server/draft-images.mts';
import { RpcError, type PreparedLine } from './client.mts';

export type PromptEnvelope = {id: string; type: 'prompt'; message: string; streamingBehavior?: 'steer' | 'followUp'};
/** The caller reserves the ordered writer before this owner reads image bytes. */
export function createImagePreparation() {
  let worker: Worker | undefined;
  let stopping: Promise<number> | undefined;
  let rejectActive: ((error: RpcError) => void) | undefined;
  let cancelled = false, released = false, used = false;
  const cancel = () => {
    cancelled = true;
    rejectActive?.(new RpcError('not_ready', 'Image input preparation was cancelled.'));
    stopping ??= worker?.terminate();
  };
  return {
    cancel,
    async prepare(source: BlobReadSpec, envelope: PromptEnvelope): Promise<PreparedLine> {
      if (cancelled || released || used) throw new RpcError('not_ready', 'Image input preparation is no longer available.');
      used = true;
      worker = new Worker(new URL('./input-worker.mts', import.meta.url), {workerData: {source, envelope}});
      const current = worker;
      try {
        return await new Promise<PreparedLine>((resolve, reject) => {
          rejectActive = reject;
          current.once('error', () => reject(new RpcError('image_unavailable', 'Image input preparation failed.')));
          current.once('exit', () => reject(new RpcError('image_unavailable', 'Image input preparation stopped.')));
          current.once('message', (reply: {prepared?: PreparedLine; error?: {code: string; message: string}}) => {
            if (reply.prepared) resolve(reply.prepared);
            else reject(new RpcError(reply.error?.code ?? 'image_unavailable', reply.error?.message ?? 'Image input preparation failed.'));
          });
        });
      } finally { rejectActive = undefined; stopping ??= current.terminate(); await stopping; }
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      cancel();
      await stopping;
    },
  };
}
