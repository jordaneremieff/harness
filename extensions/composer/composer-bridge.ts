import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const DRAFT_BYTES = 1024 * 1024;
const BODY_BYTES = 4 * DRAFT_BYTES;
const EVENT_LIMIT = 256;
const utf8 = new TextDecoder("utf-8", { fatal: true });
export type DetachReason = "reload" | "new" | "resume" | "fork";
export type ComposerEvent =
	| { type: "setText" | "insert"; text: string }
	| { type: "focus" }
	| { type: "history"; entries: string[] }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	| { type: "detach"; reason: DetachReason }
	| { type: "close"; reason: string };
type SequencedEvent = ComposerEvent & { seq: number };
export interface ComposerState {
	version: number;
	phase: "idle" | "working" | "compacting";
	since?: number;
	waiting?: { kind: string; title?: string };
	queued: { behavior: "steer" | "followUp"; text: string }[];
	model?: { provider: string; id: string; name: string };
	thinking: string;
	thinkingLevels: string[];
	cost: number;
	context?: { percent: number | null; tokens: number | null; window: number };
	/** Pi's working directory for display, home-relative as in Pi's footer. */
	cwd: string;
	session: { id: string; name?: string };
}
export interface ComposerConfig {
	version: 1;
	composer: string;
	endpoint: string;
	token: string;
	pid: number;
}
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
	return value as JsonObject;
}
export function string(value: unknown): string {
	if (typeof value !== "string" || /\p{Cs}/u.test(value)) throw new Error("Expected well-formed Unicode text.");
	return value;
}
export function draft(value: unknown): string {
	const text = string(value);
	if (Buffer.byteLength(text) > DRAFT_BYTES) throw new Error("Composer text exceeds 1 MiB of UTF-8.");
	return text;
}
export function integer(value: unknown, min = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
		throw new Error("Expected a valid integer.");
	return value;
}
export function oneLine(error: unknown): string {
	return (
		Array.from(
			(error instanceof Error ? error.message : "Composer request failed.")
				.replace(/\p{Cs}/gu, "�")
				.replace(/[\r\n\p{Cc}\p{Zl}\p{Zp}]+/gu, " "),
		)
			.slice(0, 250)
			.join("") || "Composer request failed."
	);
}

interface BridgeHandlers {
	state(): ComposerState;
	hello(body: JsonObject): JsonObject;
	request(path: string, body: JsonObject, signal: AbortSignal): JsonObject | Promise<JsonObject>;
	poll(pending: boolean): void;
}
export class ComposerBridge {
	private readonly server: Server;
	private readonly token = randomBytes(32).toString("hex");
	private readonly events: SequencedEvent[] = [];
	private readonly lifetime = new AbortController();
	private sequence = 0;
	private lastStateVersion = -1;
	private pending?: () => void;
	private connected = false;
	private endpoint = "";

	private readonly composer: string;
	private readonly paths: ReadonlySet<string>;
	private readonly handlers: BridgeHandlers;
	private readonly pollMs: number;
	constructor(composer: string, paths: ReadonlySet<string>, handlers: BridgeHandlers, pollMs = 25_000) {
		this.composer = composer;
		this.paths = paths;
		this.handlers = handlers;
		this.pollMs = pollMs;
		this.server = createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, (req, res) => {
			void this.handle(req, res);
		});
	}
	async start(): Promise<ComposerConfig> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => {
				this.server.off("error", reject);
				resolve();
			});
		});
		const address = this.server.address();
		if (typeof address !== "object" || !address) throw new Error("No loopback address for the composer.");
		this.endpoint = `http://127.0.0.1:${address.port}`;
		return { version: 1, composer: this.composer, endpoint: this.endpoint, token: this.token, pid: process.pid };
	}
	emit(event: ComposerEvent): void {
		this.events.push({ ...event, seq: ++this.sequence });
		if (this.events.length > EVENT_LIMIT) this.events.shift();
		this.changed();
	}
	changed(): void {
		this.pending?.();
	}
	close(): void {
		if (this.lifetime.signal.aborted) return;
		this.lifetime.abort();
		this.server.close();
		this.server.closeAllConnections();
	}
	private authorised(request: IncomingMessage): boolean {
		const auth = Buffer.from(request.headers.authorization ?? "");
		const expected = Buffer.from(`Bearer ${this.token}`);
		return (
			!this.lifetime.signal.aborted &&
			request.method === "POST" &&
			request.headers.origin === undefined &&
			request.headers.host === this.endpoint.slice(7) &&
			request.headers["content-type"]?.split(";", 1)[0] === "application/json" &&
			auth.length === expected.length &&
			timingSafeEqual(auth, expected)
		);
	}
	private send(response: ServerResponse, status: number, result: JsonObject): void {
		if (response.destroyed || response.writableEnded) return;
		response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		response.end(JSON.stringify(result));
	}
	private async body(request: IncomingMessage): Promise<JsonObject> {
		// Keep the request alive long enough to return a structured refusal.
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			request.on("data", (chunk: Buffer) => {
				if (bytes > BODY_BYTES) return;
				bytes += chunk.length;
				if (bytes > BODY_BYTES) {
					chunks.length = 0;
					reject(new Error("Composer request exceeds 4 MiB."));
				} else chunks.push(chunk);
			});
			request.once("error", reject);
			request.once("end", () => {
				if (bytes > BODY_BYTES) return;
				try {
					resolve(object(JSON.parse(utf8.decode(Buffer.concat(chunks)))));
				} catch {
					reject(new Error("Expected a UTF-8 JSON object."));
				}
			});
		});
	}
	private poll(response: ServerResponse, after: number): void {
		if (this.pending) throw new Error("A composer event poll is already pending.");
		if (after > this.sequence) throw new Error("Event sequence is ahead of the bridge.");
		const ready = () => after !== this.sequence || this.handlers.state().version !== this.lastStateVersion;
		const finish = () => {
			const state = this.handlers.state();
			const reset = after < (this.events[0]?.seq ?? 1) - 1;
			this.lastStateVersion = state.version;
			this.send(response, 200, {
				ok: true,
				sequence: this.sequence,
				state,
				events: reset ? [] : this.events.filter((event) => event.seq > after),
				...(reset ? { reset } : {}),
			});
		};
		this.handlers.poll(true);
		if (ready()) {
			finish();
			this.handlers.poll(false);
			return;
		}
		const cleanup = () => {
			clearTimeout(timer);
			this.pending = undefined;
			response.off("close", cleanup);
			this.handlers.poll(false);
		};
		const respond = () => {
			cleanup();
			finish();
		};
		const timer = setTimeout(respond, this.pollMs);
		this.pending = () => {
			if (ready()) respond();
		};
		response.once("close", cleanup);
	}
	private async dispatch(path: string, body: JsonObject, response: ServerResponse): Promise<void> {
		if (path === "/hello") {
			if (this.pending) throw new Error("An event poll is still open.");
			const result = this.handlers.hello(body);
			this.connected = true;
			const state = this.handlers.state();
			this.lastStateVersion = state.version;
			this.send(response, 200, { ok: true, ...result, protocol: 1, sequence: this.sequence, state });
			return;
		}
		if (!this.connected) throw new Error("Connect the composer with /hello first.");
		if (path === "/events") {
			this.poll(response, integer(body.after));
			return;
		}
		const abort = new AbortController();
		const disconnect = () => abort.abort();
		response.once("close", disconnect);
		try {
			this.send(response, 200, {
				ok: true,
				...(await this.handlers.request(path, body, AbortSignal.any([abort.signal, this.lifetime.signal]))),
			});
		} finally {
			response.off("close", disconnect);
		}
	}
	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			if (!this.authorised(request)) {
				this.send(response, 403, { ok: false, error: "Unauthorised composer request." });
				return;
			}
			const path = request.url ?? "";
			if (path !== "/hello" && path !== "/events" && !this.paths.has(path)) {
				this.send(response, 404, { ok: false, error: "Unknown composer request." });
				return;
			}
			const body = await this.body(request);
			this.lifetime.signal.throwIfAborted();
			if (response.destroyed) return;
			if (body.composer !== this.composer) throw new Error("Composer identity differs.");
			await this.dispatch(path, body, response);
		} catch (error) {
			this.send(response, 409, { ok: false, error: oneLine(error) });
		}
	}
}
