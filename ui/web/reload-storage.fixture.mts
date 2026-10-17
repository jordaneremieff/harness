import assert from 'node:assert/strict';

// The double models transaction ordering and browser File cloning, not a native IndexedDB implementation.
function clone(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof File) return new File([value], value.name, {type: value.type, lastModified: value.lastModified});
  if (value instanceof Blob) return value.slice(0, value.size, value.type);
  const result = Array.isArray(value) ? new Array(value.length) : {};
  seen.set(value, result);
  for (const key of Object.keys(value)) Object.defineProperty(result, key, {value: clone(Reflect.get(value, key), seen), enumerable: true, writable: true, configurable: true});
  return result;
}
class Request {
  result: unknown; error: Error | null = null;
  onsuccess: (() => void) | null = null; onerror: (() => void) | null = null;
  onblocked: (() => void) | null = null; onupgradeneeded: (() => void) | null = null;
  transaction: Transaction | null = null;
}
type Operation = {kind: 'put' | 'get' | 'delete'; key: string; value?: unknown};
export class Transaction {
  oncomplete: (() => void) | null = null; onabort: (() => void) | null = null;
  error: Error | null = null; state = 'active'; aborts = 0;
  request = new Request(); operation?: Operation; succeeded = false;
  readonly factory: Factory; readonly mode: string;
  constructor(factory: Factory, mode: string) {this.factory = factory; this.mode = mode;}
  objectStore(name: string) {
    assert.equal(name, 'snapshots');
    return {put: (value: unknown, key: string) => this.issue({kind: 'put', value: clone(value), key}),
      get: (key: string) => this.issue({kind: 'get', key}), delete: (key: string) => this.issue({kind: 'delete', key})};
  }
  private issue(operation: Operation) {
    if (this.factory.issueFailure) throw this.factory.issueFailure;
    this.operation = operation;
    if (this.factory.automatic) queueMicrotask(() => {this.success(); queueMicrotask(() => this.commit());});
    return this.request;
  }
  success() {
    if (this.state !== 'active' || this.succeeded) return;
    this.succeeded = true;
    if (this.operation?.kind === 'get') this.request.result = clone(this.factory.records.get(this.operation.key));
    this.request.onsuccess?.();
  }
  commit() {
    if (this.state !== 'active') return;
    if (this.factory.commitFailure) {this.error = this.factory.commitFailure; this.abort(); return;}
    this.success(); if (this.state !== 'active') return;
    if (this.operation?.kind === 'put') this.factory.records.set(this.operation.key, this.operation.value);
    if (this.operation?.kind === 'delete') this.factory.records.delete(this.operation.key);
    this.state = 'committed'; this.oncomplete?.();
  }
  fail(error: Error) {this.error = error; this.request.error = error; this.request.onerror?.(); this.abort();}
  abort() {
    if (this.state !== 'active') throw new Error('Inactive transaction');
    this.aborts++; this.state = 'aborted'; queueMicrotask(() => this.onabort?.());
  }
}
export class Database {
  closes = 0; onversionchange: (() => void) | null = null;
  readonly factory: Factory;
  constructor(factory: Factory) {this.factory = factory;}
  createObjectStore(name: string) {assert.equal(name, 'snapshots'); this.factory.created++;}
  transaction(name: string, mode: string) {
    assert.equal(name, 'snapshots'); const tx = new Transaction(this.factory, mode); this.factory.transactions.push(tx); return tx;
  }
  close() {this.closes++;}
}
export class Factory {
  records = new Map<string, unknown>(); transactions: Transaction[] = [];
  opens: Request[] = []; databases: Database[] = []; created = 0;
  automatic = true; holdOpen = false; openFailure?: Error; issueFailure?: Error; commitFailure?: Error;
  open(name: string, version: number) {
    assert.equal(name, 'ui-reload-state'); assert.equal(version, 1);
    const request = new Request(); this.opens.push(request);
    if (!this.holdOpen) queueMicrotask(() => this.finishOpen(request));
    return request;
  }
  finishOpen(request: Request) {
    if (this.openFailure) {request.error = this.openFailure; request.onerror?.(); return;}
    const db = new Database(this); this.databases.push(db); request.result = db; request.onsuccess?.();
  }
  latest() {const tx = this.transactions.at(-1); assert.ok(tx); return tx;}
}
