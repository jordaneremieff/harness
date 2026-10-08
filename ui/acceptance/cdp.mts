import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Socket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void;
}
export type SocketFactory = (url: string) => Socket;
type Json = Record<string, unknown>;
export type SocketEvent = { data?: unknown };
type CdpMessage = { id?: number; method?: string; sessionId?: string; params?: Json; result?: unknown; error?: {code: number; message: string} };
type WaitOptions = { sessionId?: string; timeoutMs?: number; signal?: AbortSignal };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
type Waiter = Pending & { method: string; sessionId?: string; predicate(value: Json): boolean };

export class CDP {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private waiters = new Set<Waiter>();
  private failure?: Error;
  private readonly message = (event: SocketEvent) => {
    try {
      if (typeof event.data !== "string") throw new Error("Non-text CDP frame");
      const data = JSON.parse(event.data) as CdpMessage;
      if (!data || typeof data !== "object") throw new Error("Invalid CDP frame");
      if (typeof data.id === "number") this.response(data, data.id);
      else if (typeof data.method === "string") this.event(data);
      else throw new Error("Invalid CDP frame");
    } catch (error) { this.fail(asError(error)); }
  };
  private response(data: CdpMessage, id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    if (data.error) pending.reject(new Error(`CDP ${data.error.code}: ${data.error.message}`));
    else pending.resolve(data.result);
  }
  private event(data: CdpMessage): void {
    for (const waiter of this.waiters) {
      if (data.method !== waiter.method || data.sessionId !== waiter.sessionId) continue;
      try {
        if (!waiter.predicate(data.params ?? {})) continue;
        this.waiters.delete(waiter);
        waiter.cleanup();
        waiter.resolve(data.params ?? {});
      } catch (error) {
        this.waiters.delete(waiter);
        waiter.cleanup();
        waiter.reject(asError(error));
      }
    }
  }
  private readonly closed = () => this.fail(new Error("CDP socket closed"));
  private readonly errored = () => this.fail(new Error("CDP socket error"));

  private socket: Socket;
  private timeoutMs: number;
  constructor(socket: Socket, timeoutMs = 10_000) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    socket.addEventListener("message", this.message);
    socket.addEventListener("close", this.closed);
    socket.addEventListener("error", this.errored);
  }

  static async connect(url: string, factory: SocketFactory = (address) => new WebSocket(address) as unknown as Socket, timeoutMs = 10_000): Promise<CDP> {
    validateEndpoint(url);
    const socket = factory(url);
    const cdp = new CDP(socket, timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          socket.removeEventListener("open", opened);
          socket.removeEventListener("error", failed);
          socket.removeEventListener("close", failed);
        };
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error("CDP connection failed")); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("CDP connection timeout")); }, timeoutMs);
        socket.addEventListener("open", opened);
        socket.addEventListener("error", failed);
        socket.addEventListener("close", failed);
        if (socket.readyState === 1) opened();
      });
      return cdp;
    } catch (error) { cdp.close(); throw error; }
  }

  send<T = Json>(method: string, params: Json = {}, options: WaitOptions = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const cleanup = this.deadline(options, () => {
        this.pending.delete(id);
      }, reject, `command ${method}`);
      if (options.signal?.aborted) { cleanup(); reject(asError(options.signal.reason)); return; }
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, cleanup });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(options.sessionId ? { sessionId: options.sessionId } : {}) })); }
      catch (error) { this.pending.delete(id); cleanup(); reject(asError(error)); }
    });
  }

  waitForEvent(method: string, predicate: (params: Json) => boolean = () => true, options: WaitOptions = {}): Promise<Json> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { method, predicate, sessionId: options.sessionId, resolve: (value) => resolve(value as Json), reject, cleanup: () => {} };
      waiter.cleanup = this.deadline(options, () => this.waiters.delete(waiter), reject, `event ${method}`);
      if (options.signal?.aborted) { waiter.cleanup(); reject(asError(options.signal.reason)); return; }
      this.waiters.add(waiter);
    });
  }

  private deadline(options: WaitOptions, remove: () => void, reject: (error: Error) => void, label: string): () => void {
    const abort = () => { remove(); cleanup(); reject(asError(options.signal?.reason)); };
    const timer = setTimeout(() => { remove(); cleanup(); reject(new Error(`CDP timeout: ${label}`)); }, options.timeoutMs ?? this.timeoutMs);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    options.signal?.addEventListener("abort", abort, { once: true });
    return cleanup;
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const item of [...this.pending.values(), ...this.waiters]) { item.cleanup(); item.reject(error); }
    this.pending.clear();
    this.waiters.clear();
  }

  close(): void {
    this.fail(new Error("CDP driver closed"));
    this.socket.removeEventListener("message", this.message);
    this.socket.removeEventListener("close", this.closed);
    this.socket.removeEventListener("error", this.errored);
    this.socket.close();
  }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error ?? "Aborted")); }
function validateEndpoint(address: string): void {
  const url = new URL(address);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
    throw new Error("CDP endpoint must be a loopback WebSocket with an explicit port");
  }
}

export function awaitDevTools(child: ChildProcess, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let tail = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr?.off("data", data);
      child.off("error", error);
      child.off("exit", exit);
    };
    const error = (reason: Error) => { cleanup(); reject(reason); };
    const exit = (code: number | null) => error(new Error(`Brave exited before DevTools readiness (${code})`));
    const data = (chunk: Buffer | string) => {
      tail = (tail + chunk.toString()).slice(-8192);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(tail);
      if (!match || !/\s/.test(tail.slice((match.index ?? 0) + match[0].length))) return;
      try { validateEndpoint(match[1]); cleanup(); resolve(match[1]); } catch (reason) { error(asError(reason)); }
    };
    const timer = setTimeout(() => error(new Error("Brave DevTools readiness timeout")), timeoutMs);
    child.stderr?.on("data", data);
    child.once("error", error);
    child.once("exit", exit);
    if (!child.stderr) error(new Error("Brave stderr is unavailable"));
  });
}

export class Page {
  readonly cdp: CDP;
  readonly sessionId: string;
  constructor(cdp: CDP, sessionId: string) { this.cdp = cdp; this.sessionId = sessionId; }
  send<T = Json>(method: string, params: Json = {}, options: Omit<WaitOptions, "sessionId"> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, { ...options, sessionId: this.sessionId });
  }
  async navigate(url: string): Promise<void> {
    await this.send("Page.enable");
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    const controller = new AbortController();
    const events: Json[] = [];
    let frameId: string | undefined;
    let loaderId: string | undefined;
    const loaded = this.cdp.waitForEvent("Page.lifecycleEvent", (event) => {
      events.push(event);
      return event.name === "load" && event.frameId === frameId && event.loaderId === loaderId;
    }, { sessionId: this.sessionId, signal: controller.signal });
    // Attach rejection handling before dispatch so a failed navigation leaves no abandoned waiter.
    void loaded.catch(() => {});
    try {
      const result = await this.send<{frameId: string; loaderId?: string; errorText?: string}>("Page.navigate", { url });
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
      frameId = result.frameId;
      loaderId = result.loaderId;
      if (!loaderId || events.some((event) => event.name === "load" && event.frameId === frameId && event.loaderId === loaderId)) return;
      await loaded;
    } finally { controller.abort(); }
  }
  async evaluate<T = unknown>(expression: string, timeoutMs = 10_000): Promise<T> {
    const result = await this.send<{ result?: {value?: unknown; subtype?: string; description?: string}; exceptionDetails?: {text: string; exception?: {description?: string}} }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, { timeoutMs });
    if (result.exceptionDetails) throw new Error(`Page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    if (result.result?.subtype === "error") throw new Error(result.result.description ?? "Evaluation error");
    return result.result?.value as T;
  }
  async screenshot(path: string): Promise<void> {
    const result = await this.send<{data: string}>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path, Buffer.from(result.data, "base64"));
  }
  async viewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }
  async waitFor(expression: string, timeoutMs = 10_000): Promise<void> {
    await this.evaluate(`new Promise((resolve,reject)=>{
      const check=()=>Boolean(${expression});
      if(check()){resolve(true);return;}
      const observer=new MutationObserver(()=>{try{if(check()){cleanup();resolve(true);}}catch(error){cleanup();reject(error);}});
      const timer=setTimeout(()=>{cleanup();reject(new Error('DOM condition timeout'));},${timeoutMs});
      const cleanup=()=>{clearTimeout(timer);observer.disconnect();};
      observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
    })`, timeoutMs + 1000);
  }
  async timing(expression: string): Promise<{ value: unknown; durationMs: number }> {
    return this.evaluate(`(async()=>{const start=performance.now();const value=await (${expression});await new Promise(requestAnimationFrame);return {value,durationMs:performance.now()-start};})()`);
  }
}

export type Browser = { cdp: CDP; page: Page; version: Json; profile: string; close(): Promise<void> };
export async function launchBrave(options: { executable?: string; port?: number; timeoutMs?: number } = {}): Promise<Browser> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid debugging port");
  const profile = await mkdtemp(join(tmpdir(), "brave-cdp-"));
  const child = spawn(options.executable ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", [
    "--headless=new", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  let cdp: CDP | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (cdp) await cdp.send("Browser.close", {}, { timeoutMs: 1000 }).catch(() => {});
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
        try { await exited; } finally { clearTimeout(kill); }
      }
    } finally { cdp?.close(); await rm(profile, { recursive: true, force: true }); }
  })();
  try {
    const endpoint = await awaitDevTools(child, options.timeoutMs);
    // Keep draining diagnostic output after readiness without retaining browser data.
    child.stderr?.resume();
    cdp = await CDP.connect(endpoint, undefined, options.timeoutMs);
    const version = await cdp.send("Browser.getVersion");
    const { targetId } = await cdp.send<{targetId: string}>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{sessionId: string}>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    await page.viewport(1440, 900);
    return { cdp, page, version, profile, close };
  } catch (error) { await close(); throw error; }
}
