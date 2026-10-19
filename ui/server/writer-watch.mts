import {watch,type FSWatcher} from 'node:fs';
import {join} from 'node:path';
import {writerState} from './ordinary-presence.mts';

type Held = {id: string; path: string};
/**
 * Reports when a terminal session releases a saved file this backend has seen held.
 * It watches the published-record directory without a timer and stops when nothing is held. The platform
 * can drop a directory event that lands as the watch starts and never report it later, so every `track`
 * call (each saved-list read) also re-checks the held files. A publisher that crashed leaves its record
 * behind and produces no event; that case is proven at the next read or open.
 */
export class WriterWatch {
  readonly #root: string;
  readonly #released: (ids: string[]) => void;
  readonly #held = new Map<string, string>();
  #watcher?: FSWatcher;
  #running?: Promise<void>;
  #again = false;
  #closed = false;
  readonly #open: typeof watch;
  constructor(root: string, released: (ids: string[]) => void, open: typeof watch = watch) { this.#root = root; this.#released = released; this.#open = open; }
  get active(): boolean { return this.#watcher !== undefined; }
  /** Remembers the files a terminal holds, starts watching when there are any, and re-checks every held file. */
  track(held: readonly Held[]): void {
    if (this.#closed) return;
    for (const item of held) this.#held.set(item.id, item.path);
    if (!this.#held.size) return;
    if (this.#watcher) this.#check(); else this.#start();
  }
  close(): void { this.#closed = true; this.#stop(); this.#held.clear(); }
  #start(): void {
    try {
      this.#watcher = this.#open(join(this.#root, '.primaries'), {persistent: false}, () => this.#check());
      this.#watcher.on('error', () => { this.#stop(); this.#check(); });
    } catch { /* A missing directory holds no records: the check below proves release. */ }
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
