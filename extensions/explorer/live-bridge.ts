import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	isRecord,
	LIVE_LIFETIME,
	LIVE_PROMPT_BYTES,
	LIVE_WIRE_BYTES,
	type LiveBinding,
	type LiveConfig,
	type LivePromptReceipt,
	type LiveResult,
	type LiveState,
	liveHandle,
	liveId,
	readLiveBinding,
} from "./live-protocol.ts";
import type { LaunchTarget } from "./pane-command.ts";

export type LivePublisher = (status: LiveState["status"], text: string, requestId: string) => void;
export interface LivePrompt {
	requestId: string;
	threadId: string;
	root: string;
	text: string;
}
export interface LiveRoute {
	submit(prompt: LivePrompt): Promise<LivePromptReceipt>;
	/** Only idempotent admission can reconcile a thrown submission error by retrying. */
	retryFailedSubmission?: boolean;
	observe?(publish: LivePublisher): Promise<() => void>;
	label?: string;
}

type Command = LiveBinding & { requestId: string; op: "navigate"; target: LaunchTarget };
interface Pending {
	command: Command;
	delivered: boolean;
	finish(result: LiveResult): void;
}
interface Pane {
	binding: LiveBinding;
	states: Map<string, LiveState>;
	wake?: () => void;
}
interface Prompt {
	handle: string;
	threadId: string;
	fingerprint: string;
	promise: Promise<LivePromptReceipt>;
	receipt?: LivePromptReceipt;
}

const idle: LiveState = { sequence: 0, status: "idle", text: "", truncated: false };
const wirePaths = new Set(["/connect", "/poll", "/result", "/prompt", "/close"]);
const utf8 = new TextDecoder("utf-8", { fatal: true });
const noteId = /^n-[a-f0-9]{20}$/u;
const terminal = (status?: LiveState["status"]) => status === "answer" || status === "error";

function boundedText(text: string): { text: string; truncated: boolean } {
	let end = Math.min(text.length, 65536);
	while (Buffer.byteLength(JSON.stringify(text.slice(0, end))) - 2 > 65536) end = Math.floor(end * 0.9);
	if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
	return { text: text.slice(0, end), truncated: end !== text.length };
}
function unconfirmed(delivered: boolean): LiveResult {
	return delivered
		? { status: "uncertain", message: "The Explorer pane did not confirm that it opened the location." }
		: { status: "closed", message: "The exact Explorer pane did not receive the navigation command." };
}

/** One loopback capability routes to one conversation for its lifetime. */
export class LiveBridge {
	private server?: Server;
	private startup?: Promise<LiveConfig>;
	private host?: string;
	private detach?: () => void;
	private readonly lifetime = new AbortController();
	private readonly authorization = Buffer.from(`Bearer ${randomBytes(32).toString("hex")}`);
	private readonly panes = new Map<string, Pane>();
	private readonly retired = new Set<string>();
	private readonly pending = new Map<string, Pending>();
	private readonly prompts = new Map<string, Prompt>();
	private sequence = 0;

	private readonly route: LiveRoute;
	private readonly commandTimeoutMs: number;
	private readonly pollTimeoutMs: number;

	constructor(route: LiveRoute, commandTimeoutMs = 5000, pollTimeoutMs = 25000) {
		this.route = route;
		this.commandTimeoutMs = commandTimeoutMs;
		this.pollTimeoutMs = pollTimeoutMs;
	}

	async start(): Promise<LiveConfig> {
		this.checkOpen();
		this.startup ??= this.open();
		return this.startup;
	}

	private checkOpen(): void {
		if (this.lifetime.signal.aborted) throw new Error("The live Explorer host closed.");
	}

	private async open(): Promise<LiveConfig> {
		const server = createServer({ headersTimeout: 10000, requestTimeout: 35000 }, (request, response) => {
			void this.serve(request, response);
		});
		server.maxConnections = 32;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					resolve();
				});
			});
			// Closing a pending Node listen can suppress its callback without reporting an error.
			this.server = server;
			this.checkOpen();
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("The live Explorer endpoint is unavailable.");
			const detach = await this.route.observe?.((status, text, id) => this.publish(status, text, id));
			if (this.lifetime.signal.aborted) detach?.();
			this.checkOpen();
			this.detach = detach;
			this.host = `127.0.0.1:${address.port}`;
			return {
				version: 1,
				endpoint: `http://${this.host}`,
				token: this.authorization.toString("ascii", 7),
				[LIVE_LIFETIME]: this.lifetime.signal,
			};
		} catch (error) {
			this.close();
			throw error;
		}
	}

	close(): void {
		// Also close a server that finished binding after the lifetime ended.
		this.server?.close();
		this.server?.closeAllConnections();
		if (this.lifetime.signal.aborted) return;
		this.lifetime.abort();
		for (const handle of this.panes.keys()) this.disconnect(handle);
		this.prompts.clear();
		this.detach?.();
	}

	list(): { handle: string }[] {
		return [...this.panes.keys()].map((handle) => ({ handle }));
	}

	async navigate(handle: string, target: LaunchTarget, signal?: AbortSignal): Promise<LiveResult> {
		const pane = this.panes.get(handle);
		if (!pane || signal?.aborted) return unconfirmed(false);
		if (this.pending.size >= 16) return { status: "error", message: "The Explorer command queue is full." };
		const requestId = randomUUID();
		const command: Command = { ...pane.binding, requestId, op: "navigate", target: structuredClone(target) };
		// Reserve the bounded state envelope space even for the largest reply the poll can carry.
		if (Buffer.byteLength(JSON.stringify(command)) > LIVE_WIRE_BYTES - 70000)
			return { status: "error", message: "The Explorer navigation target exceeds the live message limit." };
		return new Promise<LiveResult>((resolve) => {
			const abort = () => pending.finish(unconfirmed(pending.delivered));
			const timer = setTimeout(abort, this.commandTimeoutMs);
			const pending: Pending = {
				command,
				delivered: false,
				finish: (result) => {
					this.pending.delete(requestId);
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					resolve(result);
					pane.wake?.();
				},
			};
			this.pending.set(requestId, pending);
			signal?.addEventListener("abort", abort, { once: true });
			pane.wake?.();
		});
	}

	private disconnect(handle: string): void {
		const pane = this.panes.get(handle);
		this.panes.delete(handle);
		for (const item of this.pending.values()) {
			if (liveHandle(item.command) === handle) item.finish(unconfirmed(item.delivered));
		}
		pane?.wake?.();
	}

	private connect(binding: LiveBinding, body: Record<string, unknown>): object {
		if (body.version !== 1 || body.navigate !== 1) throw new Error("Invalid live Explorer capability version.");
		const handle = liveHandle(binding);
		if (this.retired.has(handle)) throw new Error("The exact Explorer pane closed.");
		let pane = this.panes.get(handle);
		if (!pane) {
			if (this.panes.size >= 8 || this.retired.size + this.panes.size >= 512)
				throw new Error("The live Explorer pane limit is reached.");
			pane = { binding, states: new Map() };
		}
		this.panes.delete(handle);
		this.panes.set(handle, pane);
		return { ok: true, handle, label: boundedText(this.route.label ?? "this Pi conversation").text };
	}

	private publish(status: LiveState["status"], text: string, requestId: string): void {
		const prompt = this.prompts.get(requestId.toLowerCase());
		const pane = prompt && this.panes.get(prompt.handle);
		if (!pane || status === "idle" || terminal(pane.states.get(requestId)?.status)) return;
		// Keep one state per request in sequence order. Only nonterminal progress can be replaced.
		pane.states.delete(requestId);
		pane.states.set(requestId, {
			sequence: ++this.sequence,
			status,
			requestId,
			threadId: prompt.threadId,
			...boundedText(text),
		});
		pane.wake?.();
	}

	private async poll(pane: Pane, after: number, response: ServerResponse): Promise<void> {
		if (!Number.isSafeInteger(after) || after < 0 || pane.wake) throw new Error("Invalid or duplicate live poll.");
		const handle = liveHandle(pane.binding);
		const available = () => {
			const first = [...this.pending.values()].find(({ command }) => liveHandle(command) === handle);
			return first?.delivered ? undefined : first;
		};
		const stateAfter = () => {
			let latest = idle;
			for (const state of pane.states.values()) {
				latest = state;
				if (state.sequence > after) break;
			}
			return latest;
		};
		if (!available() && stateAfter().sequence <= after && !response.destroyed) {
			await new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					response.off("close", finish);
					resolve();
				};
				const timer = setTimeout(finish, Math.min(25000, this.pollTimeoutMs));
				pane.wake = finish;
				response.once("close", finish);
			});
			pane.wake = undefined;
		}
		this.checkOpen();
		if (this.panes.get(handle) !== pane) throw new Error("The exact Explorer pane closed.");
		const pending = available();
		if (this.send(response, 200, { ok: true, command: pending?.command ?? null, state: stateAfter() }) && pending)
			pending.delivered = true;
	}

	private result(handle: string, body: Record<string, unknown>): object {
		const { requestId, result } = body;
		if (
			!liveId(requestId) ||
			!isRecord(result) ||
			!(result.status === "ok" || (result.status === "error" && typeof result.message === "string"))
		)
			throw new Error("Invalid Explorer navigation acknowledgement.");
		const pending = this.pending.get(requestId);
		if (pending?.delivered && liveHandle(pending.command) === handle) {
			pending.finish(result.status === "ok" ? { status: "ok" } : { status: "error", message: String(result.message) });
		}
		return { ok: true };
	}

	private async prompt(handle: string, body: Record<string, unknown>): Promise<object> {
		const rejected = (message: string) => ({ ok: true, status: "rejected", message });
		const { requestId, threadId, root, text, noteIds } = body;
		if (root === undefined)
			return rejected("The pane did not send its root. Run /explorer update, then reopen the pane.");
		if (
			!liveId(requestId) ||
			!liveId(threadId) ||
			typeof root !== "string" ||
			!root.startsWith("/") ||
			/[\u0000\uD800-\uDFFF]/u.test(root) ||
			Buffer.byteLength(root) > 4096 ||
			typeof text !== "string" ||
			!text.trim() ||
			/[\uD800-\uDFFF]/u.test(text) ||
			Buffer.byteLength(text) > LIVE_PROMPT_BYTES ||
			(noteIds !== undefined &&
				(!Array.isArray(noteIds) || !noteIds.every((id) => typeof id === "string" && noteId.test(id))))
		)
			return rejected("Invalid Explorer prompt; this request was not submitted.");
		const key = requestId.toLowerCase();
		const fingerprint = createHash("sha256")
			.update(JSON.stringify([handle, requestId, threadId, root, text, noteIds]))
			.digest("hex");
		let prior = this.prompts.get(key);
		if (prior && prior.fingerprint !== fingerprint)
			return rejected("The request ID already names a different Explorer prompt.");
		if (!prior || (prior.receipt?.status === "uncertain" && prior.receipt.retryable)) {
			if (!prior && this.prompts.size >= 128) return rejected("The live Explorer prompt limit is reached.");
			const promise = Promise.resolve()
				.then(() => this.route.submit({ requestId, threadId, root, text }))
				.catch((): LivePromptReceipt => {
					const retryable = this.route.retryFailedSubmission === true;
					return {
						status: "uncertain",
						retryable,
						message: retryable
							? "Admission is unconfirmed. Retry with the same request ID."
							: "Admission is unconfirmed. Check the conversation before sending another request.",
					};
				});
			const entry: Prompt = { handle, threadId, fingerprint, promise };
			this.prompts.set(key, entry);
			if (!prior) this.publish("queued", "", requestId);
			prior = entry;
			void promise.then((receipt) => {
				entry.receipt = receipt;
			});
		}
		return { ok: true, ...(await prior.promise) };
	}

	private send(response: ServerResponse, code: number, value: unknown): boolean {
		if (response.destroyed || response.writableEnded) return false;
		const body = JSON.stringify(value);
		if (Buffer.byteLength(body) > LIVE_WIRE_BYTES) throw new Error("The Explorer response exceeds its size limit.");
		response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		response.end(body);
		return true;
	}

	private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
		let size = 0;
		const chunks: Buffer[] = [];
		if (Number(request.headers["content-length"]) > LIVE_WIRE_BYTES)
			throw new Error("The Explorer request exceeds its size limit.");
		for await (const chunk of request.iterator({ destroyOnReturn: false })) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
			size += bytes.length;
			if (size > LIVE_WIRE_BYTES) throw new Error("The Explorer request exceeds its size limit.");
			chunks.push(bytes);
		}
		const value: unknown = JSON.parse(utf8.decode(Buffer.concat(chunks)));
		if (!isRecord(value)) throw new Error("The Explorer request must be a JSON object.");
		return value;
	}

	private authorised(request: IncomingMessage): boolean {
		const auth = Buffer.from(request.headers.authorization ?? "");
		return (
			!this.lifetime.signal.aborted &&
			this.host !== undefined &&
			request.method === "POST" &&
			request.headers.origin === undefined &&
			request.headers.host === this.host &&
			request.headers["content-type"]?.split(";", 1)[0] === "application/json" &&
			auth.length === this.authorization.length &&
			timingSafeEqual(auth, this.authorization)
		);
	}

	private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			const path = request.url ?? "";
			if (!this.authorised(request)) {
				response.setHeader("Connection", "close");
				this.send(response, 403, { ok: false, error: "Unauthorised live Explorer request." });
				return;
			}
			if (!wirePaths.has(path)) {
				response.setHeader("Connection", "close");
				this.send(response, 404, { ok: false, error: "Unknown live Explorer operation." });
				return;
			}
			await this.dispatch(path, await this.body(request), response);
		} catch (error) {
			if (!response.headersSent) {
				if (!request.complete) response.setHeader("Connection", "close");
				this.send(response, 409, {
					ok: false,
					error: error instanceof Error ? error.message.slice(0, 500) : "The live Explorer operation failed.",
				});
			}
		}
	}

	private async dispatch(path: string, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
		this.checkOpen();
		const binding = readLiveBinding(body);
		const handle = liveHandle(binding);
		if (path === "/connect") {
			this.send(response, 200, this.connect(binding, body));
			return;
		}
		if (path === "/close") {
			if (!this.panes.has(handle) && !this.retired.has(handle) && this.retired.size + this.panes.size >= 512)
				throw new Error("The live Explorer pane limit is reached.");
			this.retired.add(handle);
			this.disconnect(handle);
			this.send(response, 200, { ok: true });
			return;
		}
		const pane = this.panes.get(handle);
		if (!pane) throw new Error("The exact Explorer pane is not connected.");
		if (path === "/poll") {
			if (typeof body.after !== "number") throw new Error("Invalid live poll sequence.");
			await this.poll(pane, body.after, response);
			return;
		}
		this.send(response, 200, path === "/result" ? this.result(handle, body) : await this.prompt(handle, body));
	}
}

/** Host-local registry. Closing it invalidates every conversation capability. */
export class LiveBridges {
	private readonly bridges = new Map<string, { bridge: LiveBridge; ready: Promise<LiveBridge> }>();
	private closed = false;

	async get(key: string, route: () => LiveRoute): Promise<LiveBridge> {
		if (this.closed) throw new Error("The live Explorer host closed.");
		const found = this.bridges.get(key);
		if (found) return found.ready;
		if (this.bridges.size >= 32) throw new Error("The live Explorer conversation limit is reached.");
		const bridge = new LiveBridge(route());
		const ready = bridge.start().then(
			() => bridge,
			(error: unknown) => {
				this.bridges.delete(key);
				throw error;
			},
		);
		this.bridges.set(key, { bridge, ready });
		return ready;
	}

	async find(key: string): Promise<LiveBridge | undefined> {
		return this.bridges.get(key)?.ready;
	}

	close(): void {
		this.closed = true;
		for (const { bridge } of this.bridges.values()) bridge.close();
		this.bridges.clear();
	}
}
