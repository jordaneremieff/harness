/**
 * Minimal JSONL client for the herdr socket API.
 *
 * The transport is injectable so tests never open a socket. Delivery of
 * reports is best-effort: one attempt, one retry, then drop. The next event
 * re-synchronizes, so no report is ever fatal.
 */

import net from "node:net";

/** First attempt times out fast; the retry gets more room. */
const FIRST_TIMEOUT_MS = 500;
const RETRY_TIMEOUT_MS = 1500;

/** Resolve the herdr socket endpoint for the current platform. */
export function socketEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

export type Transport = (endpoint: string, payload: string, timeoutMs: number) => Promise<string>;

export function netTransport(endpoint: string, payload: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const socket = net.createConnection(endpoint);
		const timeout = setTimeout(() => finish(() => reject(new Error(`herdr socket timeout after ${timeoutMs}ms`))), timeoutMs);
		timeout.unref?.();
		function finish(done: () => void): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			done();
		}
		socket.on("error", (err) => finish(() => reject(err)));
		socket.on("connect", () => socket.write(payload));
		socket.on("data", (data) => finish(() => resolve(data.toString("utf8"))));
		socket.on("end", () => finish(() => reject(new Error("herdr socket closed without a response"))));
	});
}

export class HerdrError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "HerdrError";
		this.code = code;
	}
}

export interface HerdrClientOptions {
	endpoint: string;
	/** Stable report source identity, for example "custom:pi-identity". */
	source: string;
	transport?: Transport;
	/** Injectable clock for deterministic tests. */
	now?: () => number;
}

export class HerdrClient {
	private readonly options: HerdrClientOptions;
	private readonly transport: Transport;
	private readonly now: () => number;
	private seq: number;

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

	/** One request, one response. Rejects on transport failure or an error response. */
	async request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const payload = `${JSON.stringify({
			id: `${this.options.source}:${method}:${this.now()}:${Math.random().toString(36).slice(2)}`,
			method,
			params,
		})}\n`;
		const raw = await this.transport(this.options.endpoint, payload, RETRY_TIMEOUT_MS);
		return parseResponse(raw);
	}

	/** Best-effort report: one fast attempt, one retry, then drop. */
	async send(method: string, params: Record<string, unknown>): Promise<void> {
		const payload = `${JSON.stringify({
			id: `${this.options.source}:${method}:${this.now()}:${Math.random().toString(36).slice(2)}`,
			method,
			params,
		})}\n`;
		try {
			parseResponse(await this.transport(this.options.endpoint, payload, FIRST_TIMEOUT_MS));
			return;
		} catch {
			// fall through to the retry
		}
		try {
			parseResponse(await this.transport(this.options.endpoint, payload, RETRY_TIMEOUT_MS));
		} catch {
			// Display-only report: dropping is safe; the next event re-syncs.
		}
	}
}

function parseResponse(raw: string): unknown {
	const line = raw.split("\n").find((candidate) => candidate.trim().length > 0);
	if (!line) throw new Error("empty response from herdr socket");
	const parsed = JSON.parse(line) as { result?: unknown; error?: { code?: string; message?: string } };
	if (parsed.error) {
		throw new HerdrError(parsed.error.code ?? "error", parsed.error.message ?? "herdr request failed");
	}
	return parsed.result;
}
