import {watch,type FSWatcher} from 'node:fs';
import {join} from 'node:path';
import {writerState} from './ordinary-presence.mts';

type Held = {id: string; path: string};
/**
 * Reports when a terminal session releases a saved file this backend has seen held.
 * It watches the published-record directory without a timer, checks the held files once when the
 * watch starts (the platform can drop early events), and stops when nothing is held. A publisher that
 * crashed leaves its record behind and produces no event; that case is proven at the next read or open.
 */
export class WriterWatch {
  readonly #root: string;
  readonly #released: (ids: string[]) => void;
  readonly #held = new Map<string, string>();
  #watcher?: FSWatcher;
  #running?: Promise<void>;
  #again = false;
  #closed = false;
  constructor(root: string, released: (ids: string[]) => void) { this.#root = root; this.#released = released; }
  get active(): boolean { return this.#watcher !== undefined; }
  /** Remembers the files a terminal holds and starts watching when there are any. */
  track(held: readonly Held[]): void {
    if (this.#closed) return;
    for (const item of held) this.#held.set(item.id, item.path);
    if (this.#held.size && !this.#watcher) this.#start();
  }
  close(): void { this.#closed = true; this.#stop(); this.#held.clear(); }
  #start(): void {
    try {
      this.#watcher = watch(join(this.#root, '.primaries'), {persistent: false}, () => this.#check());
      this.#watcher.on('error', () => this.#stop());
    } catch { return; }
    this.#check();
  }
  #stop(): void { this.#watcher?.close(); this.#watcher = undefined; }
  #check(): void {
    if (this.#running) { this.#again = true; return; }
    this.#running = this.#run().finally(() => { this.#running = undefined; if (this.#again && !this.#closed) { this.#again = false; this.#check(); } });
  }
  async #run(): Promise<void> {
    const released: string[] = [];
    for (const [id, path] of [...this.#held]) {
      if (this.#closed) return;
      if (await writerState(this.#root, id, path) === 'none') { this.#held.delete(id); released.push(id); }
    }
    if (!this.#held.size) this.#stop();
    if (released.length && !this.#closed) this.#released(released);
  }
}
