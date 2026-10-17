const DATABASE = 'ui-reload-state';
const STORE = 'snapshots';
const MAX_NODES = 4096;
const MAX_METADATA = 4 * 1024 * 1024;
const MAX_BLOBS = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Container = Record<string, unknown> | unknown[];
type Visit = {kind: 'visit'; value: unknown; parent: Container; key: string};
type Frame = Visit | {kind: 'leave'; value: object};

function validateKey(key: string): void {
  if (typeof key !== 'string' || key.length !== 36 || !UUID.test(key)) throw new TypeError('Reload state requires a UUID key.');
}

/** Metadata counts UTF-8 text, fixed scalar/container costs, property names and File metadata, not binary bodies. */
class Snapshot {
  private nodes = 1;
  private metadata = 0;
  private blobs = 0;
  private copies = new Map<object, Container>();
  private active = new Set<object>();
  private encoder = new TextEncoder();
  private charge(bytes: number): void {
    this.metadata += bytes;
    if (this.metadata > MAX_METADATA) throw new RangeError('Reload state exceeds 4 MiB of metadata.');
  }
  private text(value: string): void {
    if (value.length > MAX_METADATA - this.metadata) throw new RangeError('Reload state exceeds 4 MiB of metadata.');
    this.charge(this.encoder.encode(value).byteLength);
  }
  private primitive(value: unknown): void {
    switch (typeof value) {
      case 'string': this.text(value); return;
      case 'bigint': this.text(value.toString()); return;
      case 'undefined': case 'boolean': case 'number': return;
      default: if (value !== null) throw new TypeError('Reload state contains an unsupported value.');
    }
  }
  private binary(value: Blob): void {
    this.blobs += Reflect.get(Blob.prototype, 'size', value) as number;
    if (this.blobs > MAX_BLOBS) throw new RangeError('Reload state exceeds 32 MiB of Blob data.');
    this.text(Reflect.get(Blob.prototype, 'type', value) as string);
    if (typeof File !== 'undefined' && value instanceof File) {
      this.text(Reflect.get(File.prototype, 'name', value) as string); this.charge(8);
    }
  }
  private properties(value: Container): Array<{key: string; value: unknown}> {
    const array = Array.isArray(value), keys = Reflect.ownKeys(value);
    if (keys.length > MAX_NODES - this.nodes + Number(array)) throw new RangeError('Reload state exceeds 4096 nodes.');
    const entries: Array<{key: string; value: unknown}> = []; let indexes = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('Reload state requires enumerable data properties.');
      if (array && String(Number(key)) === key && Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < value.length) indexes++;
      this.text(key); this.charge(8); entries.push({key, value: descriptor.value});
    }
    this.nodes += entries.length + (array ? value.length - indexes : 0);
    if (this.nodes > MAX_NODES) throw new RangeError('Reload state exceeds 4096 nodes.');
    return entries;
  }
  private container(frame: Visit, stack: Frame[]): void {
    const value = frame.value as object, array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError('Reload state requires plain objects or arrays.');
    if (this.active.has(value)) throw new TypeError('Reload state contains a cycle.');
    const previous = this.copies.get(value);
    if (previous) {this.assign(frame, previous); return;}
    const entries = this.properties(value as Container);
    const copy: Container = array ? new Array(value.length) : {};
    this.copies.set(value, copy); this.active.add(value); this.assign(frame, copy);
    stack.push({kind: 'leave', value});
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]; if (entry) stack.push({kind: 'visit', ...entry, parent: copy});
    }
  }
  private assign(frame: Visit, value: unknown): void {
    Object.defineProperty(frame.parent, frame.key, {value, enumerable: true, configurable: true, writable: true});
  }
  copy(value: unknown): unknown {
    const root = {value: undefined}; const stack: Frame[] = [{kind: 'visit', value, parent: root, key: 'value'}];
    while (stack.length) {
      const frame = stack.pop(); if (!frame) break;
      if (frame.kind === 'leave') {this.active.delete(frame.value); continue;}
      this.charge(8);
      if (frame.value !== null && typeof frame.value === 'object') {
        if (frame.value instanceof Blob) {this.binary(frame.value); this.assign(frame, frame.value);}
        else this.container(frame, stack);
      } else {this.primitive(frame.value); this.assign(frame, frame.value);}
    }
    return root.value;
  }
}

function openDatabase(signal?: AbortSignal): Promise<IDBDatabase> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1); let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const fail = (error: unknown) => {if (!settled) {settled = true; cleanup(); reject(error);}};
    const abort = () => {
      try {request.transaction?.abort();} catch { /* The opening request may already have completed. */ }
      fail(signal?.reason);
    };
    request.onerror = () => fail(request.error ?? new Error('Reload storage could not open.'));
    request.onblocked = () => fail(new Error('Reload storage is blocked.'));
    request.onupgradeneeded = () => {
      if (settled || signal?.aborted) {request.transaction?.abort(); return;}
      try {request.result.createObjectStore(STORE);} catch (error) {request.transaction?.abort(); fail(error);}
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled || signal?.aborted) {database.close(); fail(signal?.reason); return;}
      settled = true; cleanup(); database.onversionchange = () => database.close(); resolve(database);
    };
    signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort();
  });
}

function transaction(database: IDBDatabase, mode: IDBTransactionMode, signal: AbortSignal | undefined,
  issue: (store: IDBObjectStore) => IDBRequest, read: boolean): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode); let value: unknown, failure: unknown;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => {try {tx.abort();} catch { /* A completed transaction is already committed. */ }};
    tx.oncomplete = () => {cleanup(); resolve(value);};
    tx.onabort = () => {cleanup(); reject(failure ?? signal?.reason ?? tx.error ?? new Error('Reload storage transaction aborted.'));};
    signal?.addEventListener('abort', abort, {once: true});
    try {
      signal?.throwIfAborted(); const request = issue(tx.objectStore(STORE));
      request.onerror = () => {failure = request.error;};
      request.onsuccess = () => {
        if (!read) return;
        try {value = new Snapshot().copy(request.result);} catch (error) {failure = error; abort();}
      };
    } catch (error) {failure = error; abort();}
  });
}

async function withStore(mode: IDBTransactionMode, signal: AbortSignal | undefined,
  issue: (store: IDBObjectStore) => IDBRequest, read = false): Promise<unknown> {
  const database = await openDatabase(signal);
  try {return await transaction(database, mode, signal, issue, read);} finally {database.close();}
}

/** Captures caller data synchronously; IndexedDB preserves the immutable File/Blob bytes through structured clone. */
export async function writeReloadState(key: string, value: unknown, signal: AbortSignal): Promise<void> {
  validateKey(key); signal.throwIfAborted(); const snapshot = new Snapshot().copy(value);
  await withStore('readwrite', signal, store => store.put(snapshot, key));
}

/** Absence returns undefined; caller-owned payload identity and target checks remain outside this store. */
export async function readReloadState(key: string, signal: AbortSignal): Promise<unknown> {
  validateKey(key); signal.throwIfAborted();
  return withStore('readonly', signal, store => store.get(key), true);
}

export async function deleteReloadState(key: string): Promise<void> {
  validateKey(key); await withStore('readwrite', undefined, store => store.delete(key));
}
