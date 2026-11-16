import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isRecord, LIVE_PROMPT_BYTES, LIVE_WIRE_BYTES, liveHandle, liveId, readLiveAction, readLiveBinding, readLiveResult, type LiveAction, type LiveBinding, type LiveCommand, type LiveConfig, type LivePromptReceipt, type LiveResult, type LiveState } from "./live-protocol.ts";
import { validUnicode } from "./responses.ts";

export interface LiveRoute {
	submit(text: string, operationId: string): Promise<LivePromptReceipt>;
	/** Only a route with idempotent admission may repeat a failed submission. */
	retryFailedSubmission?: boolean;
	observe?(publish: (status: LiveState["status"], text: string, operationId?: string) => void): Promise<() => void>;
}
interface Pending {
	command: LiveCommand;
	promise: Promise<LiveResult>;
	resolve(result: LiveResult): void;
	result?: LiveResult;
	delivered: boolean;
	cancelled: boolean;
}
const failure = (status: "closed" | "uncertain", message: string): LiveResult => ({ status, message });
function boundedText(text: string): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text) <= 65536) return { text, truncated: false };
	let end = Math.min(text.length, 65536);
	while (Buffer.byteLength(text.slice(0, end)) > 65536) end = Math.floor(end * .9);
	if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
	return { text: text.slice(0, end), truncated: true };
}
/** One capability binds one host lifetime and one conversation; document names never select a conversation. */
export class LiveBridge {
	private server?: Server;
	private config?: LiveConfig;
	private closed = false;
	private detach?: () => void;
	private readonly token = randomBytes(32).toString("hex");
	private readonly bindings = new Map<string, LiveBinding>();
	private readonly retired = new Set<string>();
	private readonly documents = new Set<string>();
	private readonly pending = new Map<string, Pending>();
	private readonly edits = new Map<string, { fingerprint: string; pending: Pending }>();
	private readonly prompts = new Map<string, { handle: string; fingerprint: string; promise: Promise<LivePromptReceipt>; result?: LivePromptReceipt }>();
	private readonly wakes = new Map<string, () => void>();
	private readonly states = new Map<string, LiveState>();
	private focused?: string;
	private sequence = 0;
	private readonly route: LiveRoute;
	private readonly commandTimeoutMs: number;
	private readonly pollTimeoutMs: number;
	constructor(route: LiveRoute, commandTimeoutMs = 30000, pollTimeoutMs = 25000) {
		this.route = route; this.commandTimeoutMs = commandTimeoutMs; this.pollTimeoutMs = pollTimeoutMs;
	}
	async start(): Promise<LiveConfig> {
		if (this.closed) throw new Error("The live Markdown host closed.");
		if (this.config) return this.config;
		const server = createServer((request, response) => { void this.serve(request, response); });
		this.server = server;
		server.maxConnections = 32;
		server.headersTimeout = 10000;
		server.requestTimeout = 35000;
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
		const address = server.address();
		if (!address || typeof address === "string" || this.closed) { this.close(); throw new Error("The live Markdown connection closed before startup."); }
		this.config = { version: 1, endpoint: `http://127.0.0.1:${address.port}`, token: this.token };
		try {
			this.detach = await this.route.observe?.((status, text, operationId) => this.publish(status, text, operationId));
			if (this.closed) { this.detach?.(); throw new Error("The live Markdown host closed."); }
		}
		catch { this.close(); throw new Error("The conversation progress connection failed."); }
		return this.config;
	}
	publish(status: LiveState["status"], text: string, operationId?: string): void {
		if (this.closed) return;
		const handle = operationId ? this.prompts.get(operationId)?.handle : this.focused;
		if (!handle || this.retired.has(handle)) return;
		this.states.set(handle, { sequence: ++this.sequence, status, ...boundedText(text) });
		this.wakes.get(handle)?.();
	}
	private stateFor(handle: string): LiveState { return this.states.get(handle) ?? { sequence: 0, status: "idle", text: "", truncated: false }; }
	list(): { handle: string; workspace: string; document: string }[] {
		return [...this.bindings.values()].map((binding) => ({ handle: liveHandle(binding), ...binding }));
	}
	private binding(binding: LiveBinding): string {
		const handle = liveHandle(binding);
		if (this.closed || this.bindings.get(binding.workspace)?.document !== binding.document) throw new Error("The live Markdown document closed or changed.");
		return handle;
	}
	async execute(handle: string, input: LiveAction, signal?: AbortSignal): Promise<LiveResult> {
		const action = readLiveAction(input);
		const binding = this.list().find((row) => row.handle === handle);
		if (!binding) return failure("closed", "The exact live document is no longer connected. Do not replace it with a stored document.");
		signal?.throwIfAborted();
		let pending = action.op === "apply" ? this.priorEdit(handle, action) : undefined;
		if (!pending) {
			if (this.pending.size >= 16) throw new Error("The live Markdown command queue is full.");
			let resolve!: (result: LiveResult) => void;
			const promise = new Promise<LiveResult>((done) => { resolve = done; });
			pending = { command: { ...readLiveBinding(binding), ...action, requestId: randomUUID() }, promise, resolve, delivered: false, cancelled: false };
			this.pending.set(pending.command.requestId, pending);
			if (action.op === "apply") this.edits.set(action.operationId, { fingerprint: JSON.stringify({ handle, action }), pending });
			this.wakes.get(handle)?.();
		}
		if (pending.result) return pending.result;
		pending.cancelled = false;
		this.wakes.get(handle)?.();
		return this.wait(pending, signal);
	}
	private priorEdit(handle: string, action: Extract<LiveAction, { op: "apply" }>): Pending | undefined {
		const prior = this.edits.get(action.operationId);
		if (prior && prior.fingerprint !== JSON.stringify({ handle, action })) throw new Error("The operation ID already names a different live edit.");
		if (!prior && this.edits.size >= 128) throw new Error("The live edit receipt limit is reached. Existing receipts remain valid.");
		const pending = prior?.pending;
		return pending?.result && pending.result.status !== "applied" ? undefined : pending;
	}
	private wait(selected: Pending, signal?: AbortSignal): Promise<LiveResult> {
		return new Promise<LiveResult>((resolve) => {
			const finish = (result: LiveResult) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(result); };
			const abort = () => {
				selected.cancelled = true;
				if (!selected.delivered || selected.command.op === "read") this.complete(selected, failure("closed", "The live read or undelivered command was cancelled."));
				finish(failure("uncertain", "The caller withdrew its wait. Reconcile the same operation ID; do not create a replacement edit."));
			};
			const timer = setTimeout(() => {
				if (selected.command.op === "read") {
					const result: LiveResult = { status: "error", message: "The live read timed out. No edit was requested. Retry the read when the exact pane is available." };
					this.complete(selected, result);
					finish(result);
				} else finish(failure("uncertain", "The native result is unconfirmed. Retry only the same operation ID and identical edit; do not infer that it failed."));
			}, this.commandTimeoutMs);
			signal?.addEventListener("abort", abort, { once: true });
			void selected.promise.then(finish);
			if (signal?.aborted) abort();
		});
	}
	private complete(pending: Pending, result: LiveResult): void {
		pending.result = result;
		this.pending.delete(pending.command.requestId);
		pending.resolve(result);
	}
	private disconnect(binding: LiveBinding, retire = true): void {
		if (!this.documents.has(liveHandle(binding))) {
			if (!retire) return;
			if (this.documents.size >= 512) throw new Error("The native document capability limit is reached.");
			this.documents.add(liveHandle(binding));
		}
		if (this.bindings.get(binding.workspace)?.document === binding.document) this.bindings.delete(binding.workspace);
		if (retire) {
			this.retired.add(liveHandle(binding));
			this.states.delete(liveHandle(binding));
		}
		for (const pending of [...this.pending.values()]) if (liveHandle(pending.command) === liveHandle(binding)) this.complete(pending, failure("closed", "The exact native document disconnected; no replacement target was selected."));
		this.wakes.get(liveHandle(binding))?.();
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.detach?.();
		for (const binding of [...this.bindings.values()]) this.disconnect(binding);
		this.server?.close();
		this.server?.closeAllConnections();
	}
	private send(response: ServerResponse, code: number, value: unknown): void {
		if (response.destroyed || response.writableEnded) return;
		response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		response.end(JSON.stringify(value));
	}
	private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
		let size = 0;
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
			size += bytes.length;
			if (size > LIVE_WIRE_BYTES) throw new Error("The live Markdown envelope exceeds its limit.");
			chunks.push(bytes);
		}
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!isRecord(value)) throw new Error("The live Markdown envelope is not an object.");
		return value;
	}
	private authorised(request: IncomingMessage): boolean {
		const auth = Buffer.from(request.headers.authorization ?? "");
		const expected = Buffer.from(`Bearer ${this.token}`);
		return !this.closed && request.method === "POST" && request.headers.origin === undefined && request.headers.host === this.config?.endpoint.slice(7) && request.headers["content-type"]?.split(";", 1)[0] === "application/json" && auth.length === expected.length && timingSafeEqual(auth, expected);
	}
	private connect(binding: LiveBinding): object {
		const handle = liveHandle(binding);
		if (this.retired.has(handle) || (!this.documents.has(handle) && this.documents.size >= 512)) throw new Error("The native document capability expired. It is not reconnected by document identity.");
		const previous = this.bindings.get(binding.workspace);
		if (previous && previous.document !== binding.document) this.disconnect(previous, false);
		if (!previous && this.bindings.size >= 8) throw new Error("The native workspace limit is reached.");
		this.bindings.set(binding.workspace, binding);
		this.documents.add(handle);
		return { ok: true, handle };
	}
	private async poll(binding: LiveBinding, after: unknown, response: ServerResponse): Promise<object> {
		const handle = liveHandle(binding);
		if (!Number.isSafeInteger(after) || Number(after) < 0 || this.wakes.has(handle)) throw new Error("Invalid or duplicate live poll.");
		const available = () => [...this.pending.values()].find((item) => !item.cancelled && liveHandle(item.command) === handle);
		if (!available() && after === this.stateFor(handle).sequence) await new Promise<void>((resolve) => {
			const finish = () => { clearTimeout(timer); this.wakes.delete(handle); response.off("close", finish); resolve(); };
			const timer = setTimeout(finish, this.pollTimeoutMs);
			this.wakes.set(handle, finish); response.once("close", finish);
		});
		this.binding(binding);
		const pending = available();
		if (pending) pending.delivered = true;
		return { ok: true, command: pending?.command ?? null, state: this.stateFor(handle) };
	}
	private result(binding: LiveBinding, body: Record<string, unknown>): object {
		if (!liveId(body.requestId)) throw new Error("Invalid native result identity.");
		const pending = this.pending.get(body.requestId) ?? [...this.edits.values()].find((entry) => entry.pending.command.requestId === body.requestId)?.pending;
		if (!pending || liveHandle(pending.command) !== liveHandle(binding)) return { ok: true };
		const result = readLiveResult(body.result, pending.command);
		if (pending.result && JSON.stringify(pending.result) !== JSON.stringify(result)) throw new Error("The native receipt changed after acknowledgement.");
		this.complete(pending, result);
		return { ok: true };
	}
	private async prompt(binding: LiveBinding, body: Record<string, unknown>): Promise<object> {
		const rejected = (message: string) => ({ ok: true, status: "rejected", message });
		if (!liveId(body.operationId) || typeof body.text !== "string" || !body.text.trim() || !validUnicode(body.text) || Buffer.byteLength(body.text) > LIVE_PROMPT_BYTES) return rejected("Invalid live Markdown prompt; this request was not submitted.");
		const handle = liveHandle(binding);
		const fingerprint = JSON.stringify({ handle, text: body.text });
		let prior = this.prompts.get(body.operationId);
		if (prior && prior.fingerprint !== fingerprint) return rejected("The prompt ID already names a different request; the changed request was not submitted.");
		if (!prior || (prior.result?.status === "uncertain" && prior.result.retryable)) {
			if (!prior && this.prompts.size >= 128) return rejected("The live prompt receipt limit is reached; this request was not submitted.");
			const text = `This request comes from the live Markdown pane ${handle}. Use markdown_live to read this exact unsaved native buffer before edits. Apply changes through markdown_live with the same handle, base generation/digest and a stable operationId. Do not substitute markdown_read, markdown_publish, file writes or a new pane for live edits.\n\n${body.text}`;
			this.focused = handle;
			this.publish("queued", "The pane sent your request to this conversation.");
			const operationId = body.operationId;
			const promise = Promise.resolve().then(() => this.route.submit(text, operationId)).catch((): LivePromptReceipt => ({
				status: "uncertain", retryable: this.route.retryFailedSubmission === true,
				message: this.route.retryFailedSubmission ? "Admission is unconfirmed. Retry the same request ID to reconcile it." : "Admission is unconfirmed and this route cannot safely resubmit. Check the conversation before another request.",
			}));
			const entry: NonNullable<typeof prior> = { handle, fingerprint, promise };
			prior = entry; this.prompts.set(operationId, entry);
			void promise.then((result) => {
				entry.result = result;
				if (result.status === "rejected" || result.status === "uncertain") this.publish("error", result.message, operationId);
			});
		}
		return { ok: true, ...await prior.promise };
	}
	private async dispatch(path: string, body: Record<string, unknown>, response: ServerResponse): Promise<object> {
		const binding = readLiveBinding(body);
		if (path === "/connect") return this.connect(binding);
		if (path === "/close") { this.disconnect(binding); return { ok: true }; }
		this.binding(binding);
		switch (path) {
			case "/poll": return this.poll(binding, body.after, response);
			case "/result": return this.result(binding, body);
			case "/prompt": return this.prompt(binding, body);
			default: throw new Error("Unknown live Markdown operation.");
		}
	}
	private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			if (!this.authorised(request)) { this.send(response, 403, { ok: false, error: "Unauthorised live Markdown request." }); return; }
			if (!["/connect", "/poll", "/result", "/prompt", "/close"].includes(request.url ?? "")) { this.send(response, 404, { ok: false, error: "Unknown live Markdown operation." }); return; }
			const result = await this.dispatch(request.url ?? "", await this.body(request), response);
			this.send(response, 200, result);
		} catch (error) {
			this.send(response, 409, { ok: false, error: error instanceof Error ? error.message.slice(0, 500) : "The live Markdown operation failed." });
		}
	}
}

/** Host-local registry. A closed registry never reconnects old capabilities by document identity. */
export class LiveBridges {
	private readonly bridges = new Map<string, Promise<LiveBridge>>();
	private closed = false;
	async get(key: string, route: () => LiveRoute): Promise<LiveBridge> {
		if (this.closed) throw new Error("The live Markdown host closed.");
		let promise = this.bridges.get(key);
		if (!promise) {
			if (this.bridges.size >= 32) throw new Error("The live conversation limit is reached.");
			const bridge = new LiveBridge(route());
			promise = bridge.start().then(() => bridge).catch((error: unknown) => { bridge.close(); throw error; });
			this.bridges.set(key, promise);
		}
		return promise;
	}
	async find(key: string): Promise<LiveBridge | undefined> { return this.bridges.get(key); }
	close(): void { this.closed = true; for (const promise of this.bridges.values()) void promise.then((bridge) => bridge.close(), () => {}); }
}
