import type { ServerResponse } from 'node:http';

export const STREAM_KEEPALIVE_MS = 30_000;

/**
 * Writes an SSE comment line on a fixed period and enables TCP keep-alive, so a peer that vanished
 * without closing (sleeping device, lost network) produces a write error or close instead of
 * looking live forever. Browsers ignore comment lines; they never reach an EventSource listener.
 * `ready` lets an owner skip a tick while it has queued frames of its own. Returns a stop function.
 */
export function keepStreamAlive(response: ServerResponse, ready: () => boolean = () => true, period = STREAM_KEEPALIVE_MS): () => void {
  response.socket?.setKeepAlive?.(true, period);
  const timer = setInterval(() => {
    if (response.destroyed || response.writableEnded || !ready()) return;
    try { response.write(': keepalive\n\n'); } catch { response.destroy(); }
  }, period);
  timer.unref();
  const stop = () => clearInterval(timer);
  response.once('close', stop);
  response.once('error', stop);
  return stop;
}
