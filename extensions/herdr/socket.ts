/**
 * JSONL client for the herdr socket API.
 *
 * Two connection shapes exist. A request opens a connection, writes one line,
 * reads one response line, and closes. A subscription keeps its connection open
 * and reads event lines until it is closed or the server drops it.
 *
 * Transports are injectable so tests never open a socket. Retries are bounded
 * and semantic: a request is retried only when the server cannot have executed
 * it, or when the caller declares the call idempotent. Server errors are never
 * retried, so no mutation runs twice.
 */

import net from "node:net";

/** First attempt times out fast; the retry gets more room. */
const FIRST_TIMEOUT_MS = 500;
const RETRY_TIMEOUT_MS = 1500;
/** Guard against a response line that never ends. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** Resolve the herdr socket endpoint for the current platform. */
export function socketEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/** A transport failure, carrying whether the request reached the server. */
export class TransportError extends Error {
	/** True once the payload was written; the server may have executed it. */
	readonly sent: boolean;
	constructor(message: string, sent: boolean, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "TransportError";
		this.sent = sent;
	}
}

export class HerdrError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "HerdrError";
		this.code = code;
	}
}

export interface TransportOptions {
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Write one request line and resolve with one complete response line. */
export type Transport = (endpoint: string, payload: string, options: TransportOptions) => Promise<string>;

/** Split a byte stream into complete lines, rejecting an unbounded line. */
export class LineSplitter {
	private buffer = "";
	private readonly maxBytes: number;

	constructor(maxBytes: number = MAX_LINE_BYTES) {
		this.maxBytes = maxBytes;
	}

	/** Append a chunk and return every complete line it finished. */
	push(chunk: string): string[] {
		this.buffer += chunk;
		if (this.buffer.length > this.maxBytes && !this.buffer.includes("\n")) {
			this.buffer = "";
			throw new Error(`herdr response exceeded ${this.maxBytes} bytes without a line break`);
		}
		const lines: string[] = [];
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.trim().length > 0) lines.push(line);
			index = this.buffer.indexOf("\n");
		}
		return lines;
	}
}

export function netTransport(endpoint: string, payload: string, options: TransportOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let sent = false;
		const splitter = new LineSplitter();
		const socket = net.createConnection(endpoint);
		const timeout = setTimeout(
			() => finish(() => reject(new TransportError(`herdr socket timeout after ${options.timeoutMs}ms`, sent))),
			options.timeoutMs,
		);
		timeout.unref?.();

		function finish(done: () => void): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			done();
		}
		function onAbort(): void {
			finish(() => reject(new TransportError("herdr request aborted", sent)));
		}

		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) {
			onAbort();
			return;
		}

		socket.setEncoding("utf8");
		socket.on("error", (err) => finish(() => reject(new TransportError(err.message, sent, { cause: err }))));
		socket.on("connect", () =>
			socket.write(payload, () => {
				sent = true;
			}),
		);
		socket.on("data", (data: string) => {
			let lines: string[];
			try {
				lines = splitter.push(data);
			} catch (err) {
				finish(() => reject(err));
				return;
			}
			if (lines.length > 0) finish(() => resolve(lines[0]));
		});
		socket.on("end", () => finish(() => reject(new TransportError("herdr socket closed without a response", sent))));
	});
}

export interface HerdrClientOptions {
	endpoint: string;
	/** Stable report source identity, for example "custom:pi-identity". */
	source: string;
	transport?: Transport;
	/** Injectable clock for deterministic tests. */
	now?: () => number;
}

export interface RequestOptions {
	/** Deadline for the first attempt. Long waits need their own budget. */
	timeoutMs?: number;
	/** Deadline for the retry, when a retry is allowed. */
	retryTimeoutMs?: number;
	/** Declare that running the call twice is harmless. */
	idempotent?: boolean;
	signal?: AbortSignal;
}

export class HerdrClient {
	private readonly options: HerdrClientOptions;
	private readonly transport: Transport;
	private readonly now: () => number;
	private seq: number;
	private counter = 0;

	constructor(options: HerdrClientOptions) {
		this.options = options;
		this.transport = options.transport ?? netTransport;
		this.now = options.now ?? (() => Date.now());
		this.seq = this.now() * 1000;
	}

	/** Monotonic report sequence; herdr ignores stale values from a source. */
	nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}

	/**
	 * One request, one response.
	 *
	 * The call is retried only when the server cannot have run it, or when the
	 * caller declares it idempotent. A server error rejects immediately.
	 */
	async request(method: string, params: Record<string, unknown>, options: RequestOptions = {}): Promise<unknown> {
		const id = this.requestId(method);
		const payload = `${JSON.stringify({ id, method, params })}\n`;
		const first = options.timeoutMs ?? FIRST_TIMEOUT_MS;
		const second = options.retryTimeoutMs ?? Math.max(RETRY_TIMEOUT_MS, first);
		try {
			return parseResponse(await this.transport(this.options.endpoint, payload, { timeoutMs: first, signal: options.signal }), id);
		} catch (err) {
			if (!retryAllowed(err, options.idempotent === true)) throw err;
			return parseResponse(
				await this.transport(this.options.endpoint, payload, { timeoutMs: second, signal: options.signal }),
				id,
			);
		}
	}

	/**
	 * Best-effort display report: one fast attempt, one retry, then drop.
	 *
	 * Reports carry a monotonic sequence, so repeating one is harmless and the
	 * next event re-synchronizes after a drop.
	 */
	async send(method: string, params: Record<string, unknown>): Promise<void> {
		try {
			await this.request(method, params, { idempotent: true });
		} catch {
			// Display-only report: dropping is safe; the next event re-syncs.
		}
	}

	private requestId(method: string): string {
		this.counter += 1;
		return `${this.options.source}:${method}:${this.now()}:${this.counter}`;
	}
}

/** Retry only when the request cannot have executed, or repeating it is safe. */
function retryAllowed(err: unknown, idempotent: boolean): boolean {
	if (err instanceof HerdrError) return false;
	if (err instanceof TransportError) return idempotent || !err.sent;
	return idempotent;
}

export function parseResponse(line: string, expectedId?: string): unknown {
	if (!line.trim()) throw new Error("empty response from herdr socket");
	const parsed = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { code?: string; message?: string } };
	if (expectedId !== undefined && parsed.id !== expectedId) {
		throw new Error(`herdr response id mismatch: expected ${expectedId}, got ${String(parsed.id)}`);
	}
	if (parsed.error) {
		throw new HerdrError(parsed.error.code ?? "error", parsed.error.message ?? "herdr request failed");
	}
	if (!("result" in parsed)) throw new Error("herdr response carried neither a result nor an error");
	return parsed.result;
}

/** Hooks a streaming transport calls while its connection lives. */
export interface StreamHooks {
	onLine: (line: string) => void;
	onClose: (err?: Error) => void;
}

export interface StreamHandle {
	close(): void;
}

/** Open a connection, write one request line, and stream the response lines. */
export type StreamTransport = (endpoint: string, payload: string, hooks: StreamHooks) => StreamHandle;

export function netStreamTransport(endpoint: string, payload: string, hooks: StreamHooks): StreamHandle {
	const splitter = new LineSplitter();
	const socket = net.createConnection(endpoint);
	let closed = false;
	const close = (err?: Error): void => {
		if (closed) return;
		closed = true;
		socket.destroy();
		hooks.onClose(err);
	};
	socket.setEncoding("utf8");
	socket.on("connect", () => socket.write(payload));
	socket.on("data", (data: string) => {
		let lines: string[];
		try {
			lines = splitter.push(data);
		} catch (err) {
			close(err as Error);
			return;
		}
		for (const line of lines) {
			if (closed) return;
			hooks.onLine(line);
		}
	});
	socket.on("error", (err) => close(err));
	socket.on("end", () => close(new Error("herdr subscription closed by the server")));
	socket.unref?.();
	return {
		close(): void {
			if (closed) return;
			closed = true;
			socket.destroy();
			// A local close and a remote close follow the same path, so a
			// resubscribe can reopen the stream immediately.
			hooks.onClose();
		},
	};
}

export interface SubscriptionEvent {
	/** Event name, for example "pane.agent_status_changed". */
	event: string;
	/** Full event line, parsed. */
	payload: Record<string, unknown>;
}

export interface SubscriptionClientOptions {
	endpoint: string;
	/** Stable request source identity for the subscribe call. */
	source: string;
	/** Subscribe parameters, or a provider called on every (re)subscribe. */
	params?: Record<string, unknown> | (() => Record<string, unknown>);
	/** Called for every event line after the acknowledgement. */
	onEvent: (event: SubscriptionEvent) => void | Promise<void>;
	/** Called after every successful (re)subscribe, so callers re-read state. */
	onReady?: (attempt: number) => void;
	/** Bounded backlog; the oldest event is dropped when it overflows. */
	queueLimit?: number;
	/** Reconnect delays in order; the last value repeats. */
	backoffMs?: number[];
	transport?: StreamTransport;
	setTimer?: (fn: () => void, ms: number) => () => void;
	random?: () => number;
}

const DEFAULT_QUEUE_LIMIT = 256;
const DEFAULT_BACKOFF_MS = [500, 1500, 5000, 15000];

/**
 * Long-lived events.subscribe connection.
 *
 * The first response line must acknowledge the subscription; anything else is
 * treated as a failed attempt. The connection reconnects with backoff, and
 * `onReady` fires after every successful subscribe so the caller can re-read a
 * fresh snapshot instead of trusting replayed history.
 */
export class SubscriptionClient {
	private readonly options: SubscriptionClientOptions;
	private readonly transport: StreamTransport;
	private readonly setTimer: (fn: () => void, ms: number) => () => void;
	private readonly random: () => number;
	private readonly queue: SubscriptionEvent[] = [];
	private handle: StreamHandle | undefined;
	private cancelTimer: (() => void) | undefined;
	private acknowledged = false;
	private stopped = false;
	private reopening = false;
	private closed = false;
	private attempt = 0;
	private draining = false;
	private requestId = 0;

	constructor(options: SubscriptionClientOptions) {
		this.options = options;
		this.transport = options.transport ?? netStreamTransport;
		this.setTimer =
			options.setTimer ??
			((fn, ms) => {
				const timer = setTimeout(fn, ms);
				timer.unref?.();
				return () => clearTimeout(timer);
			});
		this.random = options.random ?? Math.random;
	}

	/** Open the subscription. Repeated calls after the first are ignored. */
	start(): void {
		if (this.stopped || this.handle) return;
		this.open();
	}

	/** Close the subscription and cancel any pending reconnect. Idempotent. */
	close(): void {
		this.stopped = true;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		this.handle?.close();
		this.handle = undefined;
		this.queue.length = 0;
	}

	/**
	 * Close and reopen with fresh parameters.
	 *
	 * The provider is called again, so a caller that tracks which panes exist can
	 * widen or narrow the subscription set without a backoff wait.
	 */
	resubscribe(): void {
		if (this.stopped) return;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		if (this.handle) {
			this.reopening = true;
			this.handle.close();
		} else {
			this.open();
		}
	}

	/** Current subscribe parameters, re-evaluated on every (re)subscribe. */
	private resolveParams(): Record<string, unknown> {
		const params = this.options.params;
		return typeof params === "function" ? params() : (params ?? {});
	}

	private open(): void {
		this.acknowledged = false;
		this.closed = false;
		this.requestId += 1;
		const id = `${this.options.source}:events.subscribe:${this.requestId}`;
		const payload = `${JSON.stringify({ id, method: "events.subscribe", params: this.resolveParams() })}\n`;
		this.handle = this.transport(this.options.endpoint, payload, {
			onLine: (line) => this.onLine(id, line),
			onClose: () => this.onClose(),
		});
	}

	private onLine(id: string, line: string): void {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (!this.acknowledged) {
			if (!isSubscriptionAck(parsed, id)) {
				this.handle?.close();
				return;
			}
			this.acknowledged = true;
			this.attempt += 1;
			this.options.onReady?.(this.attempt);
			return;
		}
		const event = eventName(parsed);
		if (!event) return;
		this.enqueue({ event, payload: parsed });
	}

	private onClose(): void {
		if (this.closed) return;
		this.closed = true;
		this.handle = undefined;
		if (this.stopped) return;
		if (this.reopening) {
			this.reopening = false;
			this.open();
			return;
		}
		const delays = this.options.backoffMs ?? DEFAULT_BACKOFF_MS;
		const base = delays[Math.min(this.attempt, delays.length - 1)];
		const delay = Math.round(base * (0.5 + this.random() * 0.5));
		this.cancelTimer = this.setTimer(() => {
			this.cancelTimer = undefined;
			if (!this.stopped) this.open();
		}, delay);
	}

	private enqueue(event: SubscriptionEvent): void {
		const limit = this.options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
		this.queue.push(event);
		while (this.queue.length > limit) this.queue.shift();
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0 && !this.stopped) {
				const next = this.queue.shift();
				if (!next) break;
				try {
					await this.options.onEvent(next);
				} catch {
					// One bad event must not stop the stream.
				}
			}
		} finally {
			this.draining = false;
		}
	}
}

function isSubscriptionAck(parsed: Record<string, unknown>, id: string): boolean {
	if (parsed.id !== id) return false;
	const result = parsed.result as { type?: unknown } | undefined;
	return Boolean(result && result.type === "subscription_started");
}

/** Read the event name from an event line, whichever field carries it. */
function eventName(parsed: Record<string, unknown>): string | undefined {
	const direct = parsed.event;
	if (typeof direct === "string") return direct;
	const type = parsed.type;
	if (typeof type === "string") return type;
	const nested = parsed.event as { type?: unknown } | undefined;
	if (nested && typeof nested.type === "string") return nested.type;
	return undefined;
}
