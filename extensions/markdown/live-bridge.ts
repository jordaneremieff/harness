import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	isRecord,
	LIVE_LIFETIME,
	LIVE_PROMPT_BYTES,
	LIVE_WIRE_BYTES,
	liveHandle,
	liveId,
	readLiveAction,
	readLiveBinding,
	readLiveResult,
	type LiveAction,
	type LiveBinding,
	type LiveCommand,
	type LiveConfig,
	type LivePromptReceipt,
	type LiveResult,
	type LiveState,
} from "./live-protocol.ts";
import { validUnicode } from "./responses.ts";

export type LivePublisher = (status: LiveState["status"], text: string, operationId: string) => void;
/** Reader panes that left the conversation, and the panes that remain connected to it. */
export interface PaneClosure {
	closed: number;
	connected: number;
}
export interface LiveRoute {
	submit(text: string, operationId: string): Promise<LivePromptReceipt>;
	/** Only a route with idempotent admission may repeat a failed submission. */
	retryFailedSubmission?: boolean;
	observe?(publish: LivePublisher): Promise<() => void>;
	/**
	 * Receives each settled group of pane closures. A pane that closes one document and connects
	 * another within the grace period switched documents and did not close.
	 */
	panesClosed?(closure: PaneClosure): void;
}
interface Pending {
	command: LiveCommand;
	waiters: Set<(result: LiveResult) => void>;
	result?: LiveResult;
	delivered: boolean;
	cancelled: boolean;
}
type Apply = Extract<LiveAction, { op: "apply" }>;
export type AnchorIdentity = { key: string; refreshed: boolean };
type EditReceipt = { fingerprint: string; pending: Pending; anchor?: AnchorIdentity };
const failure = (status: "closed" | "uncertain", message: string): LiveResult => ({ status, message });
const disconnectedEdit = () =>
	failure(
		"uncertain",
		"The document disconnected after delivery. Reconcile only the same operation ID and identical edit when the exact document reconnects.",
	);
function boundedText(text: string): { text: string; truncated: boolean } {
	let end = Math.min(text.length, 65536);
	// The page envelope also has a byte limit after JSON escaping.
	while (Buffer.byteLength(JSON.stringify(text.slice(0, end))) - 2 > 65536) end = Math.floor(end * 0.9);
	if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
	return { text: text.slice(0, end), truncated: end !== text.length };
}
/** One capability binds one host lifetime and one conversation; document names never select a conversation. */
export class LiveBridge {
	private server?: Server;
	private config?: LiveConfig;
	private closed = false;
	private readonly lifetime = new AbortController();
	private detach?: () => void;
	private readonly token = randomBytes(32).toString("hex");
	private readonly bindings = new Map<string, LiveBinding>();
	private readonly retired = new Set<string>();
	private readonly versions = new Map<string, 1 | 2>();
	private readonly documents = new Set<string>();
	private readonly pending = new Map<string, Pending>();
	private readonly edits = new Map<string, EditReceipt>();
	private readonly prompts = new Map<
		string,
		{ handle: string; fingerprint: string; promise: Promise<LivePromptReceipt>; result?: LivePromptReceipt }
	>();
	private readonly wakes = new Map<string, () => void>();
	private readonly states = new Map<string, Map<string, LiveState>>();
	/** Panes whose document closed and that have not connected another document since. */
	private readonly vacated = new Set<string>();
	private vacancy?: ReturnType<typeof setTimeout>;
	/** Requests whose body, and so whose pane, is not yet known. */
	private arriving = 0;
	private sequence = 0;
	private readonly route: LiveRoute;
	private readonly commandTimeoutMs: number;
	private readonly pollTimeoutMs: number;
	private readonly paneGraceMs: number;
	constructor(route: LiveRoute, commandTimeoutMs = 30000, pollTimeoutMs = 25000, paneGraceMs = 1000) {
		this.route = route;
		this.commandTimeoutMs = commandTimeoutMs;
		this.pollTimeoutMs = pollTimeoutMs;
		this.paneGraceMs = paneGraceMs;
	}
	async start(): Promise<LiveConfig> {
		if (this.closed) throw new Error("The live Markdown host closed.");
		if (this.config) return this.config;
		const server = createServer((request, response) => {
			void this.serve(request, response);
		});
		this.server = server;
		server.maxConnections = 32;
		server.headersTimeout = 10000;
		server.requestTimeout = 35000;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string" || this.closed) {
			this.close();
			throw new Error("The live Markdown connection closed before startup.");
		}
		this.config = {
			version: 1,
			endpoint: `http://127.0.0.1:${address.port}`,
			token: this.token,
			[LIVE_LIFETIME]: this.lifetime.signal,
		};
		try {
			this.detach = await this.route.observe?.((status, text, operationId) => this.publish(status, text, operationId));
			if (this.closed) {
				this.detach?.();
				throw new Error("The live Markdown host closed.");
			}
		} catch {
			this.close();
			throw new Error("The conversation progress connection failed.");
		}
		return this.config;
	}
	publish(status: LiveState["status"], text: string, operationId: string): void {
		if (this.closed) return;
		const handle = this.prompts.get(operationId)?.handle;
		if (!handle || this.retired.has(handle)) return;
		const states = this.states.get(handle) ?? new Map<string, LiveState>();
		if (states.get(operationId)?.status === "answer") return;
		// Coalesce progress for one question, never replace a different question's answer.
		states.delete(operationId);
		states.set(operationId, { sequence: ++this.sequence, status, ...boundedText(text), operationId });
		this.states.set(handle, states);
		this.wakes.get(handle)?.();
	}
	private stateAfter(handle: string, after: number): LiveState {
		let latest: LiveState = { sequence: 0, status: "idle", text: "", truncated: false };
		for (const state of this.states.get(handle)?.values() ?? []) {
			latest = state;
			if (state.sequence > after) break;
		}
		return latest;
	}
	list(): { handle: string; workspace: string; document: string; live: 1 | 2 }[] {
		return [...this.bindings.values()].map((binding) => ({
			handle: liveHandle(binding),
			...binding,
			live: this.versions.get(liveHandle(binding)) ?? 1,
		}));
	}
	private binding(binding: LiveBinding): string {
		const handle = liveHandle(binding);
		if (this.closed || this.bindings.get(binding.workspace)?.document !== binding.document)
			throw new Error("The live Markdown document closed or changed.");
		return handle;
	}
	resolvedEdit(handle: string, operationId: string, key: string): { action: Apply; refreshed: boolean } | undefined {
		const prior = this.edits.get(operationId);
		if (!prior) return;
		const action = prior.pending.command;
		if (action.op !== "apply" || liveHandle(action) !== handle || prior.anchor?.key !== key)
			throw new Error("The operation ID already names a different live edit.");
		const { baseGeneration, baseDigest, edits } = action;
		return {
			action: { op: "apply", operationId, baseGeneration, baseDigest, edits },
			refreshed: prior.anchor.refreshed,
		};
	}
	async execute(handle: string, input: LiveAction, signal?: AbortSignal, anchor?: AnchorIdentity): Promise<LiveResult> {
		const action = readLiveAction(input);
		const binding = this.list().find((row) => row.handle === handle);
		if (!binding) return this.inactiveResult(handle, action, anchor);
		if ((action.op === "claim" || action.op === "release") && binding.live !== 2)
			return {
				status: "error",
				message: "This exact pane does not support claims. Claim and release require live: 2.",
			};
		signal?.throwIfAborted();
		const pending = this.queueCommand(handle, binding, action, anchor);
		if (pending.result) return pending.result;
		pending.cancelled = false;
		this.wakes.get(handle)?.();
		return this.wait(pending, signal);
	}
	private inactiveResult(handle: string, action: LiveAction, anchor?: AnchorIdentity): LiveResult {
		if (action.op === "apply" && !this.closed && !this.retired.has(handle) && this.edits.has(action.operationId)) {
			const prior = this.priorEdit(handle, action, anchor);
			if (prior?.delivered && !prior.result) return disconnectedEdit();
		}
		return failure(
			"closed",
			"The exact live document is no longer connected. Do not replace it with a stored document.",
		);
	}
	private queueCommand(handle: string, binding: LiveBinding, action: LiveAction, anchor?: AnchorIdentity): Pending {
		let pending = action.op === "apply" ? this.priorEdit(handle, action, anchor) : undefined;
		if (pending?.result) return pending;
		if (!pending || !this.pending.has(pending.command.requestId)) {
			if (this.pending.size >= 16) throw new Error("The live Markdown command queue is full.");
			if (!pending) {
				pending = {
					command: { ...readLiveBinding(binding), ...action, requestId: randomUUID() },
					waiters: new Set(),
					delivered: false,
					cancelled: false,
				};
				if (action.op === "apply")
					this.edits.set(action.operationId, { fingerprint: JSON.stringify({ handle, action }), pending, anchor });
			}
			this.pending.set(pending.command.requestId, pending);
		}
		return pending;
	}
	private priorEdit(handle: string, action: Apply, anchor?: AnchorIdentity): Pending | undefined {
		const prior = this.edits.get(action.operationId);
		if (prior && (prior.anchor?.key !== anchor?.key || prior.fingerprint !== JSON.stringify({ handle, action })))
			throw new Error("The operation ID already names a different live edit.");
		if (!prior && this.edits.size >= 128)
			throw new Error("The live edit receipt limit is reached. Existing receipts remain valid.");
		const pending = prior?.pending;
		return pending?.result && pending.result.status !== "applied" && !(anchor && pending.result.status === "stale")
			? undefined
			: pending;
	}
	private wait(selected: Pending, signal?: AbortSignal): Promise<LiveResult> {
		return new Promise<LiveResult>((resolve) => {
			const finish = (result: LiveResult) => {
				if (!selected.waiters.delete(finish)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				resolve(result);
			};
			const abort = () => {
				selected.cancelled = true;
				if (selected.command.op === "claim" || selected.command.op === "release") {
					const result = failure(
						"uncertain",
						"The claim result is unconfirmed. Claims expire automatically and never block the person.",
					);
					this.complete(selected, result);
					return;
				}
				finish(
					failure(
						"uncertain",
						"The caller withdrew its wait. Reconcile the same operation ID; do not create a replacement edit.",
					),
				);
				if (selected.waiters.size) {
					selected.cancelled = false;
					return;
				}
				if (!selected.delivered || selected.command.op === "read")
					this.complete(selected, failure("closed", "The live read or undelivered command was cancelled."));
			};
			const timer = setTimeout(() => {
				if (selected.command.op === "read") {
					const result: LiveResult = {
						status: "error",
						message: "The live read timed out. No edit was requested. Retry the read when the exact pane is available.",
					};
					this.complete(selected, result);
				} else if (selected.command.op === "apply")
					finish(
						failure(
							"uncertain",
							"The native result is unconfirmed. Retry only the same operation ID and identical edit; do not infer that it failed.",
						),
					);
				else {
					const result = failure(
						"uncertain",
						"The claim result is unconfirmed. Claims expire automatically and never block the person.",
					);
					this.complete(selected, result);
				}
			}, this.commandTimeoutMs);
			selected.waiters.add(finish);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}
	private complete(pending: Pending, result: LiveResult): void {
		pending.result = result;
		this.pending.delete(pending.command.requestId);
		for (const finish of pending.waiters) finish(result);
	}
	private disconnectCommand(pending: Pending): void {
		if (pending.command.op !== "apply" || !pending.delivered) {
			this.complete(
				pending,
				failure("closed", "The exact native document disconnected; no replacement target was selected."),
			);
			return;
		}
		// Withdraw delivery, not the receipt. Only an exact retry queues this command again.
		this.pending.delete(pending.command.requestId);
		const result = disconnectedEdit();
		for (const finish of pending.waiters) finish(result);
	}
	private disconnect(binding: LiveBinding, retire = true): void {
		const handle = liveHandle(binding);
		if (!this.documents.has(handle)) {
			if (!retire) return;
			if (this.documents.size >= 512) throw new Error("The native document capability limit is reached.");
			this.documents.add(handle);
		}
		if (this.bindings.get(binding.workspace)?.document === binding.document) {
			this.bindings.delete(binding.workspace);
			if (retire) this.vacate(binding.workspace);
		}
		if (retire) {
			this.retired.add(handle);
			this.states.delete(handle);
			this.versions.delete(handle);
		}
		for (const pending of this.pending.values()) {
			if (liveHandle(pending.command) === handle) this.disconnectCommand(pending);
		}
		this.wakes.get(handle)?.();
	}
	/**
	 * A pane reports the close of its shown document and connects the next one at once when it
	 * switches documents, so a closure counts only when the pane stays away for the grace period.
	 */
	private vacate(workspace: string): void {
		if (this.closed || !this.route.panesClosed) return;
		this.vacated.add(workspace);
		this.settleVacancyAfter(this.paneGraceMs);
	}
	private settleVacancyAfter(delay: number): void {
		clearTimeout(this.vacancy);
		// The immediate lets input that arrived while the process was busy reach the bridge first.
		this.vacancy = setTimeout(() => setImmediate(() => this.settleVacancy()), delay);
		this.vacancy.unref();
	}
	private settleVacancy(): void {
		if (this.closed) return;
		if (this.arriving > 0) {
			this.settleVacancyAfter(50);
			return;
		}
		this.vacancy = undefined;
		const closed = [...this.vacated].filter((workspace) => !this.bindings.has(workspace)).length;
		this.vacated.clear();
		if (!closed) return;
		try {
			this.route.panesClosed?.({ closed, connected: this.bindings.size });
		} catch {
			// A route that cannot take the notice leaves the connection state unchanged.
		}
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.lifetime.abort();
		this.detach?.();
		clearTimeout(this.vacancy);
		this.vacated.clear();
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
		return (
			!this.closed &&
			request.method === "POST" &&
			request.headers.origin === undefined &&
			request.headers.host === this.config?.endpoint.slice(7) &&
			request.headers["content-type"]?.split(";", 1)[0] === "application/json" &&
			auth.length === expected.length &&
			timingSafeEqual(auth, expected)
		);
	}
	private connect(binding: LiveBinding, version: unknown): object {
		if (version !== undefined && version !== 1 && version !== 2)
			throw new Error("Invalid live Markdown capability version.");
		const handle = liveHandle(binding);
		if (this.retired.has(handle) || (!this.documents.has(handle) && this.documents.size >= 512))
			throw new Error("The native document capability expired. It is not reconnected by document identity.");
		const previous = this.bindings.get(binding.workspace);
		if (previous && previous.document !== binding.document) this.disconnect(previous, false);
		if (!previous && this.bindings.size >= 8) throw new Error("The native workspace limit is reached.");
		this.bindings.set(binding.workspace, binding);
		this.vacated.delete(binding.workspace);
		this.versions.set(handle, version === 2 ? 2 : 1);
		this.documents.add(handle);
		return { ok: true, handle };
	}
	private async poll(binding: LiveBinding, after: unknown, response: ServerResponse): Promise<object> {
		const handle = liveHandle(binding);
		if (!Number.isSafeInteger(after) || Number(after) < 0 || this.wakes.has(handle))
			throw new Error("Invalid or duplicate live poll.");
		const available = () =>
			[...this.pending.values()].find((item) => !item.cancelled && liveHandle(item.command) === handle);
		if (!available() && after === this.stateAfter(handle, Number(after)).sequence)
			await new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					this.wakes.delete(handle);
					response.off("close", finish);
					resolve();
				};
				const timer = setTimeout(finish, this.pollTimeoutMs);
				this.wakes.set(handle, finish);
				response.once("close", finish);
			});
		this.binding(binding);
		const pending = available();
		if (pending) pending.delivered = true;
		return { ok: true, command: pending?.command ?? null, state: this.stateAfter(handle, Number(after)) };
	}
	private result(binding: LiveBinding, body: Record<string, unknown>): object {
		if (!liveId(body.requestId)) throw new Error("Invalid native result identity.");
		const pending =
			this.pending.get(body.requestId) ??
			[...this.edits.values()].find((entry) => entry.pending.command.requestId === body.requestId)?.pending;
		if (!pending || liveHandle(pending.command) !== liveHandle(binding)) return { ok: true };
		const result = readLiveResult(body.result, pending.command);
		if (pending.result && JSON.stringify(pending.result) !== JSON.stringify(result))
			throw new Error("The native receipt changed after acknowledgement.");
		this.complete(pending, result);
		return { ok: true };
	}
	private async prompt(binding: LiveBinding, body: Record<string, unknown>): Promise<object> {
		const rejected = (message: string) => ({ ok: true, status: "rejected", message });
		if (
			!liveId(body.operationId) ||
			typeof body.text !== "string" ||
			!body.text.trim() ||
			!validUnicode(body.text) ||
			Buffer.byteLength(body.text) > LIVE_PROMPT_BYTES
		)
			return rejected("Invalid live Markdown prompt; this request was not submitted.");
		const handle = liveHandle(binding);
		const fingerprint = JSON.stringify({ handle, text: body.text });
		let prior = this.prompts.get(body.operationId);
		if (prior && prior.fingerprint !== fingerprint)
			return rejected("The prompt ID already names a different request; the changed request was not submitted.");
		if (!prior || (prior.result?.status === "uncertain" && prior.result.retryable)) {
			if (!prior && this.prompts.size >= 128)
				return rejected("The live prompt receipt limit is reached; this request was not submitted.");
			const operationId = body.operationId;
			const text = `This question (${operationId}) comes from the live Markdown pane ${handle}. Answer in your final message; the Ask card shows it. Use markdown_live with this handle to read context or apply {find, replace} edits. Do not substitute a stored document, file write or new pane.\n\n${body.text}`;
			const promise = Promise.resolve()
				.then(() => this.route.submit(text, operationId))
				.catch(
					(): LivePromptReceipt => ({
						status: "uncertain",
						retryable: this.route.retryFailedSubmission === true,
						message: this.route.retryFailedSubmission
							? "Admission is unconfirmed. Retry the same request ID to reconcile it."
							: "Admission is unconfirmed and this route cannot safely resubmit. Check the conversation before another request.",
					}),
				);
			const entry: NonNullable<typeof prior> = { handle, fingerprint, promise };
			prior = entry;
			this.prompts.set(operationId, entry);
			this.publish("queued", "", operationId);
			void promise.then((result) => {
				entry.result = result;
			});
		}
		return { ok: true, ...(await prior.promise) };
	}
	private async dispatch(path: string, body: Record<string, unknown>, response: ServerResponse): Promise<object> {
		const binding = readLiveBinding(body);
		if (path === "/connect") return this.connect(binding, body.live);
		if (path === "/close") {
			this.disconnect(binding);
			return { ok: true };
		}
		this.binding(binding);
		switch (path) {
			case "/poll":
				return this.poll(binding, body.after, response);
			case "/result":
				return this.result(binding, body);
			case "/prompt":
				return this.prompt(binding, body);
			default:
				throw new Error("Unknown live Markdown operation.");
		}
	}
	private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			if (!this.authorised(request)) {
				this.send(response, 403, { ok: false, error: "Unauthorised live Markdown request." });
				return;
			}
			if (!["/connect", "/poll", "/result", "/prompt", "/close"].includes(request.url ?? "")) {
				this.send(response, 404, { ok: false, error: "Unknown live Markdown operation." });
				return;
			}
			this.arriving++;
			let body: Record<string, unknown>;
			try {
				body = await this.body(request);
			} finally {
				this.arriving--;
			}
			const result = await this.dispatch(request.url ?? "", body, response);
			this.send(response, 200, result);
		} catch (error) {
			this.send(response, 409, {
				ok: false,
				error: error instanceof Error ? error.message.slice(0, 500) : "The live Markdown operation failed.",
			});
		}
	}
}

/** Host-local registry. A closed registry never reconnects old capabilities by document identity. */
export class LiveBridges {
	private readonly bridges = new Map<string, Promise<LiveBridge>>();
	private closed = false;
	private readonly paneGraceMs?: number;
	constructor(paneGraceMs?: number) {
		this.paneGraceMs = paneGraceMs;
	}
	async get(key: string, route: () => LiveRoute): Promise<LiveBridge> {
		if (this.closed) throw new Error("The live Markdown host closed.");
		let promise = this.bridges.get(key);
		if (!promise) {
			if (this.bridges.size >= 32) throw new Error("The live conversation limit is reached.");
			const bridge = new LiveBridge(route(), undefined, undefined, this.paneGraceMs);
			promise = bridge
				.start()
				.then(() => bridge)
				.catch((error: unknown) => {
					bridge.close();
					if (this.bridges.get(key) === promise) this.bridges.delete(key);
					throw error;
				});
			this.bridges.set(key, promise);
		}
		return promise;
	}
	async find(key: string): Promise<LiveBridge | undefined> {
		return this.bridges.get(key);
	}
	close(): void {
		this.closed = true;
		for (const promise of this.bridges.values())
			void promise.then(
				(bridge) => bridge.close(),
				() => {},
			);
	}
}
