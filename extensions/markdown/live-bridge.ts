import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LaunchLedger, type SuspendedLaunch } from "./launch-ledger.ts";
import {
	isRecord,
	PANE_PROTOCOL,
	livePid,
	readLiveView,
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
	type LivePane,
	type LivePaneView,
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
	panes: LivePane[];
}
export interface LiveRoute {
	checkAdmission?(): void;
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
export type AnchorIdentity = { key: string };
type EditReceipt = { fingerprint: string; pending: Pending; anchor?: AnchorIdentity };
const RELOAD_PAUSE = { ok: false, error: "Pi is reloading this conversation." };
const POLL_GRACE_MS = 6_000;
const RECONNECT_GRACE_MS = 30_000;
interface Reader {
	workspace: string;
	pid: number;
	origin: LivePane["origin"];
	launchId: string;
	serial: number;
	lastContact: number;
	navigation?: { command: Extract<LiveCommand, { op: "navigate" }>; result?: LiveResult };
}
type SavedEdit = Omit<EditReceipt, "pending"> & { command: LiveCommand; delivered: boolean; result?: LiveResult };
type SavedPrompt = { handle: string; fingerprint: string; result: LivePromptReceipt };
interface SavedState {
	version: 1;
	panes: LivePane[];
	retired: string[];
	documents: string[];
	prompts: [string, SavedPrompt][];
	edits: [string, SavedEdit][];
	states: [string, [string, LiveState][]][];
	launches: SuspendedLaunch[];
	sequence: number;
	navigations: [string, NonNullable<Reader["navigation"]>][];
}
/** Listener identity and replay fences survive a reload even when the new code cannot use the pane snapshot. */
export interface LiveBridgeHandoff {
	version: 1;
	server: Server;
	endpoint: string;
	token: string;
	conversation: string;
	readers: Omit<Reader, "navigation" | "lastContact">[];
	promptHandles: [string, string][];
	editIds: string[];
	state: SavedState;
}
export function discardLiveHandoff(record: LiveBridgeHandoff): void {
	record.server.close();
	record.server.closeAllConnections();
}
class RequestFailure extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}
const serialNumber = (value: unknown): number => {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Invalid native pane state serial.");
	return Number(value);
};
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
const failure = (status: "closed" | "uncertain", message: string): LiveResult => ({ status, message });
const queryOnly = (op: string): boolean => op === "read" || op === "comments";
function missingReceipt(op: string): LiveResult {
	switch (op) {
		case "setComment":
			return failure(
				"uncertain",
				"The comment change has no confirmed result. List open and closed comments and check the item's version before another request.",
			);
		case "navigate":
			return failure(
				"uncertain",
				"The reader did not confirm navigation. List the pane before another show; do not open a replacement.",
			);
		default:
			return failure(
				"uncertain",
				"The claim result is unconfirmed. Claims expire automatically and never block the person.",
			);
	}
}
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
	private token = randomBytes(32).toString("hex");
	private readonly bindings = new Map<string, LivePane>();
	private readonly readers = new Map<string, Reader>();
	private launches = new LaunchLedger();
	private readonly fencedPrompts = new Map<string, string>();
	private readonly fencedEdits = new Set<string>();
	private observer?: ReturnType<typeof setInterval>;
	private readonly retired = new Set<string>();
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
	private readonly vacated = new Map<string, LivePane>();
	private vacancy?: ReturnType<typeof setTimeout>;
	/** Requests whose body, and so whose pane, is not yet known. */
	private arriving = 0;
	private sequence = 0;
	private readonly route: LiveRoute;
	private readonly commandTimeoutMs: number;
	private readonly pollTimeoutMs: number;
	private readonly paneGraceMs: number;
	private readonly conversation: string;
	private readonly serving = new Set<ServerResponse>();
	private readonly receive = (request: IncomingMessage, response: ServerResponse) => {
		this.serving.add(response);
		void this.serve(request, response).finally(() => this.serving.delete(response));
	};
	constructor(
		route: LiveRoute,
		commandTimeoutMs = 30000,
		pollTimeoutMs = 25000,
		paneGraceMs = 1000,
		conversation = "local Pi conversation",
	) {
		this.conversation = conversation;
		this.route = route;
		this.commandTimeoutMs = commandTimeoutMs;
		this.pollTimeoutMs = pollTimeoutMs;
		this.paneGraceMs = paneGraceMs;
	}
	async start(handoff?: LiveBridgeHandoff): Promise<LiveConfig> {
		if (this.closed) throw new Error("The live Markdown host closed.");
		if (this.config) return this.config;
		if (handoff && (handoff.version !== 1 || handoff.conversation !== this.conversation || !handoff.server.listening)) {
			discardLiveHandoff(handoff);
			throw new Error("The prior Markdown connection cannot be resumed. Reopen the pane from this conversation.");
		}
		const server = handoff?.server ?? createServer();
		this.server = server;
		if (handoff) {
			server.removeAllListeners("request");
			this.token = handoff.token;
			this.restore(handoff);
		}
		server.on("request", this.receive);
		server.maxConnections = 32;
		server.headersTimeout = 10000;
		server.requestTimeout = 35000;
		if (!handoff)
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
			live: PANE_PROTOCOL,
			conversation: this.conversation,
			hostPid: process.pid,
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
		const handle = this.prompts.get(operationId)?.handle ?? this.fencedPrompts.get(operationId);
		if (!handle) return;
		const [workspace, document] = handle.split(":");
		const states = this.states.get(workspace) ?? new Map<string, LiveState>();
		if (states.get(operationId)?.status === "answer") return;
		// Coalesce progress for one question, never replace a different question's answer.
		states.delete(operationId);
		states.set(operationId, { sequence: ++this.sequence, status, ...boundedText(text), operationId, document });
		this.states.set(workspace, states);
		const selected = this.bindings.get(workspace);
		if (selected) this.wakes.get(selected.handle)?.();
	}
	private stateAfter(handle: string, after: number): LiveState {
		let latest: LiveState = { sequence: 0, status: "idle", text: "", truncated: false };
		for (const state of this.states.get(handle)?.values() ?? []) {
			latest = state;
			if (state.sequence > after) break;
		}
		return latest;
	}
	list(): LivePane[] {
		this.prune();
		return [...this.bindings.values()].map((pane) => ({ ...pane, view: { ...pane.view } }));
	}
	pendingLaunches() {
		return this.launches.pendingLaunches();
	}
	private monitor(): void {
		if (this.observer || !this.readers.size) return;
		this.observer = setInterval(() => this.prune(), 1000);
		this.observer.unref();
	}
	private prune(): void {
		const now = Date.now();
		for (const reader of this.readers.values()) {
			const pane = this.bindings.get(reader.workspace);
			if (!processAlive(reader.pid)) {
				this.leave(reader.workspace);
				continue;
			}
			if (!pane) {
				if (now - reader.lastContact >= RECONNECT_GRACE_MS) this.leave(reader.workspace);
				continue;
			}
			if (this.wakes.has(pane.handle) || now - reader.lastContact < POLL_GRACE_MS) continue;
			// A live reader can be inside a command instead of a poll. Its PID still detects death.
			const executing = [...this.pending.values()].some((p) => p.delivered && liveHandle(p.command) === pane.handle);
			if (executing && now - reader.lastContact <= this.commandTimeoutMs + 1000) continue;
			this.disconnect(pane, false);
			this.vacate(pane);
		}
		if (!this.readers.size) {
			clearInterval(this.observer);
			this.observer = undefined;
		}
	}
	private leave(workspace: string): void {
		const pane = this.bindings.get(workspace);
		if (pane) this.disconnect(pane);
		for (const handle of this.documents) if (handle.startsWith(`${workspace}:`)) this.retired.add(handle);
		this.readers.delete(workspace);
	}
	private contact(workspace: string): void {
		const reader = this.readers.get(workspace);
		if (reader) reader.lastContact = Date.now();
	}
	private binding(binding: LiveBinding): string {
		const handle = liveHandle(binding);
		if (this.closed || this.bindings.get(binding.workspace)?.document !== binding.document)
			throw new Error("The live Markdown document closed or changed.");
		return handle;
	}
	resolvedEdit(handle: string, operationId: string, key: string): { action: Apply } | undefined {
		if (this.fencedEdits.has(operationId))
			throw new Error("The previous host did not transfer this edit receipt. Inspect the pane before another edit.");
		const prior = this.edits.get(operationId);
		if (!prior) return;
		const action = prior.pending.command;
		if (action.op !== "apply" || liveHandle(action) !== handle || prior.anchor?.key !== key)
			throw new Error("The operation ID already names a different live edit.");
		const { baseGeneration, baseDigest, edits } = action;
		return {
			action: { op: "apply", operationId, baseGeneration, baseDigest, edits },
		};
	}
	async execute(handle: string, input: LiveAction, signal?: AbortSignal, anchor?: AnchorIdentity): Promise<LiveResult> {
		const action = readLiveAction(input);
		const binding = this.list().find((row) => row.handle === handle);
		if (!binding) return this.inactiveResult(handle, action, anchor);
		if (action.op === "navigate" && binding.origin !== "agent")
			return {
				status: "error",
				message: "This pane was opened from an operator action. Select an agent-opened pane instead.",
			};
		if (action.op === "navigate" && this.navigationInFlight(binding.workspace))
			return {
				status: "busy",
				message: "A navigation already awaits this pane. List its confirmed view before another show.",
			};
		if (action.op === "apply" && this.fencedEdits.has(action.operationId))
			return failure(
				"uncertain",
				"The previous host did not transfer this edit receipt. Inspect the pane before another edit.",
			);
		signal?.throwIfAborted();
		const pending = this.queueCommand(handle, binding, action, anchor);
		if (pending.result) return pending.result;
		pending.cancelled = false;
		this.wakes.get(handle)?.();
		return this.wait(pending, signal);
	}
	private navigationInFlight(workspace: string): boolean {
		const receipt = this.readers.get(workspace)?.navigation;
		return (
			!!(receipt && !receipt.result) ||
			[...this.pending.values()].some((p) => p.command.op === "navigate" && p.command.workspace === workspace)
		);
	}
	private inactiveResult(handle: string, action: LiveAction, anchor?: AnchorIdentity): LiveResult {
		if (action.op === "apply" && !this.closed && this.edits.has(action.operationId)) {
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
		if (!prior && this.edits.size + this.fencedEdits.size >= 128)
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
				if (selected.command.op === "navigate") {
					this.endNavigationWait(selected);
					return;
				}
				if (selected.command.op !== "apply" && !queryOnly(selected.command.op)) {
					this.complete(selected, missingReceipt(selected.command.op));
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
				if (!selected.delivered || queryOnly(selected.command.op))
					this.complete(selected, failure("closed", "The live read or undelivered command was cancelled."));
			};
			const timer = setTimeout(() => {
				if (selected.command.op === "navigate") {
					this.endNavigationWait(selected);
					return;
				}
				if (queryOnly(selected.command.op)) {
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
				else this.complete(selected, missingReceipt(selected.command.op));
			}, this.commandTimeoutMs);
			selected.waiters.add(finish);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}
	private endNavigationWait(pending: Pending): void {
		this.complete(
			pending,
			pending.delivered
				? missingReceipt(pending.command.op)
				: failure("closed", "The navigation did not reach the pane."),
		);
	}
	private complete(pending: Pending, result: LiveResult): void {
		pending.result = result;
		this.pending.delete(pending.command.requestId);
		for (const finish of pending.waiters) finish(result);
	}
	private disconnectCommand(pending: Pending): void {
		if (pending.command.op === "navigate") {
			this.endNavigationWait(pending);
			return;
		}
		if (pending.delivered && pending.command.op !== "apply" && !queryOnly(pending.command.op)) {
			this.complete(pending, missingReceipt(pending.command.op));
			return;
		}
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
	private disconnect(binding: LiveBinding, retire = true, completing?: Pending): void {
		const handle = liveHandle(binding);
		if (!this.documents.has(handle)) {
			if (!retire) return;
			if (this.documents.size >= 512) throw new Error("The native document capability limit is reached.");
			this.documents.add(handle);
		}
		const pane = this.bindings.get(binding.workspace);
		if (pane?.document === binding.document) {
			this.bindings.delete(binding.workspace);
			if (retire) this.vacate(pane);
		}
		if (retire) this.retired.add(handle);
		for (const pending of this.pending.values()) {
			if (pending !== completing && liveHandle(pending.command) === handle) this.disconnectCommand(pending);
		}
		this.wakes.get(handle)?.();
	}
	/**
	 * A pane reports the close of its shown document and connects the next one at once when it
	 * switches documents, so a closure counts only when the pane stays away for the grace period.
	 */
	private vacate(pane: LivePane): void {
		if (this.closed || !this.route.panesClosed) return;
		this.vacated.set(pane.workspace, pane);
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
		const panes = [...this.vacated.values()].filter((pane) => !this.bindings.has(pane.workspace));
		this.vacated.clear();
		if (!panes.length) return;
		try {
			this.route.panesClosed?.({ closed: panes.length, connected: this.bindings.size, panes });
		} catch {
			// A route that cannot take the notice leaves the connection state unchanged.
		}
	}
	/** No promises, timers, module instances or route callbacks cross a loader generation. */
	release(): LiveBridgeHandoff | undefined {
		if (this.closed || !this.server || !this.config) return;
		const server = this.server;
		const handoff: LiveBridgeHandoff = {
			version: 1,
			server,
			endpoint: this.config.endpoint,
			token: this.token,
			conversation: this.conversation,
			readers: [...this.readers.values()].map(({ workspace, pid, origin, launchId, serial }) => ({
				workspace,
				pid,
				origin,
				launchId,
				serial,
			})),
			promptHandles: [
				...this.fencedPrompts,
				...Array.from(this.prompts, ([id, prompt]): [string, string] => [id, prompt.handle]),
			],
			editIds: [...this.fencedEdits, ...this.edits.keys()],
			state: {
				version: 1,
				panes: [...this.bindings.values()],
				retired: [...this.retired],
				documents: [...this.documents],
				sequence: this.sequence,
				prompts: [...this.prompts].map(([id, { handle, fingerprint, result }]) => [
					id,
					{
						handle,
						fingerprint,
						result: result ?? {
							status: "uncertain",
							retryable: false,
							message:
								"Pi reloaded before prompt admission was confirmed. Check the conversation before another request.",
						},
					},
				]),
				edits: [...this.edits].map(
					([
						id,
						{
							fingerprint,
							anchor,
							pending: { command, delivered, result },
						},
					]) => [id, { fingerprint, anchor, command, delivered, result }],
				),
				states: [...this.states].map(([key, states]) => [key, [...states]]),
				launches: this.launches.suspend(),
				navigations: [...this.readers].flatMap(([workspace, reader]) =>
					reader.navigation ? [[workspace, reader.navigation]] : [],
				),
			},
		};
		this.server = undefined;
		server.off("request", this.receive);
		server.on("request", (_request, response) => {
			response.writeHead(503, { "Content-Type": "application/json", Connection: "close", "Cache-Control": "no-store" });
			response.end(JSON.stringify(RELOAD_PAUSE));
		});
		// Drain the former route's requests, not idle HTTP connections to the retained listener.
		for (const response of this.serving) this.send(response, 503, RELOAD_PAUSE);
		this.close();
		return handoff;
	}
	private restore(record: LiveBridgeHandoff): void {
		for (const reader of record.readers) this.readers.set(reader.workspace, { ...reader, lastContact: Date.now() });
		for (const [id, handle] of record.promptHandles) this.fencedPrompts.set(id, handle);
		for (const id of record.editIds) this.fencedEdits.add(id);
		this.monitor();
		const state = record.state;
		if (state?.version !== 1) return;
		try {
			this.restoreSnapshot(state);
		} catch {
			// Keep the listener, trusted reader leases and replay fences. No partially restored view is authoritative.
			this.sequence = 0;
			for (const records of [this.bindings, this.retired, this.documents, this.states, this.prompts, this.edits])
				records.clear();
			for (const reader of this.readers.values()) delete reader.navigation;
			this.launches.close();
			this.launches = new LaunchLedger();
			return;
		}
		for (const id of this.prompts.keys()) this.fencedPrompts.delete(id);
		for (const id of this.edits.keys()) this.fencedEdits.delete(id);
		this.prune();
	}
	private restoreSnapshot(state: SavedState): void {
		this.sequence = state.sequence;
		for (const pane of state.panes) this.bindings.set(pane.workspace, pane);
		for (const id of state.documents) this.documents.add(id);
		for (const id of state.retired) this.retired.add(id);
		for (const [key, states] of state.states) this.states.set(key, new Map(states));
		for (const [id, saved] of state.prompts) {
			this.prompts.set(id, { ...saved, promise: Promise.resolve(saved.result) });
		}
		for (const [id, { fingerprint, anchor, command, delivered, result }] of state.edits) {
			this.edits.set(id, {
				fingerprint,
				anchor,
				pending: { command, delivered, result, waiters: new Set(), cancelled: false },
			});
		}
		for (const [workspace, navigation] of state.navigations) {
			const reader = this.readers.get(workspace);
			if (reader) reader.navigation = navigation;
		}
		this.launches.resume(state.launches);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.lifetime.abort();
		this.detach?.();
		clearTimeout(this.vacancy);
		clearInterval(this.observer);
		this.launches.close();
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
	private checkHandle(binding: LiveBinding): void {
		const handle = liveHandle(binding);
		if (this.retired.has(handle) || (!this.documents.has(handle) && this.documents.size >= 512))
			throw new Error("The native document capability expired. It is not reconnected by document identity.");
	}
	private installView(
		binding: LiveBinding,
		reader: Reader,
		serial: number,
		view: LivePaneView,
		completing?: Pending,
	): void {
		this.checkHandle(binding);
		const previous = this.bindings.get(binding.workspace);
		if (
			serial < reader.serial ||
			(serial === reader.serial &&
				previous &&
				(previous.document !== binding.document || JSON.stringify(previous.view) !== JSON.stringify(view)))
		)
			throw new Error("Stale native pane report.");
		if (previous && previous.document !== binding.document) this.disconnect(previous, false, completing);
		const handle = liveHandle(binding);
		const pane: LivePane = {
			...binding,
			handle,
			live: PANE_PROTOCOL,
			pid: reader.pid,
			origin: reader.origin,
			reportedAt: Date.now(),
			view,
		};
		reader.serial = serial;
		this.bindings.set(binding.workspace, pane);
		this.documents.add(handle);
		this.vacated.delete(binding.workspace);
	}
	private connect(binding: LiveBinding, body: Record<string, unknown>): object {
		if (body.live !== PANE_PROTOCOL)
			throw new RequestFailure(
				// Earlier readers stop retrying on 410; they do not recognise the upgrade response.
				body.live === undefined || body.live === 1 || body.live === 2 ? 410 : 426,
				"This reader and Pi use different live pane protocols. Update the reader and reopen it from this Pi session.",
			);
		if (!livePid(body.pid) || !liveId(body.launchId)) throw new Error("Invalid native pane process or launch.");
		const pid = body.pid,
			launchId = body.launchId.toLowerCase();
		if (!processAlive(pid)) throw new RequestFailure(410, "The reader process ended. Reopen from this session.");
		const serial = serialNumber(body.serial),
			view = readLiveView(body.view);
		this.prune();
		const reader = this.currentReader(binding, launchId, pid);
		this.installView(binding, reader, serial, view);
		// A reconnect confirms the current view, not the outcome of a command whose packet or receipt was lost.
		if (reader.navigation && !reader.navigation.result) {
			const pending = this.pending.get(reader.navigation.command.requestId);
			if (pending) this.endNavigationWait(pending);
			delete reader.navigation;
		}
		this.contact(binding.workspace);
		return { ok: true, handle: liveHandle(binding) };
	}
	private currentReader(binding: LiveBinding, launchId: string, pid: number): Reader {
		let reader = this.readers.get(binding.workspace);
		if (!reader && [...this.documents].some((handle) => handle.startsWith(`${binding.workspace}:`)))
			throw new RequestFailure(410, "This pane's connection ended. Reopen from the original Pi conversation.");
		this.checkHandle(binding);
		if (reader && (reader.launchId !== launchId || reader.pid !== pid))
			throw new Error("The launch no longer belongs to this pane process.");
		if (!reader) {
			if (this.readers.size >= 8) throw new Error("The native workspace limit is reached.");
			const origin = this.consumeLaunch(launchId, pid);
			reader = { workspace: binding.workspace, origin, pid, launchId, serial: -1, lastContact: Date.now() };
			this.readers.set(binding.workspace, reader);
			this.monitor();
		}
		return reader;
	}
	private consumeLaunch(launchId: string, pid: number): LivePane["origin"] {
		try {
			return this.launches.consume(launchId, pid);
		} catch {
			throw new RequestFailure(
				410,
				"This reader's launch is no longer active. Reopen from the original Pi conversation.",
			);
		}
	}
	private updateView(binding: LiveBinding, body: Record<string, unknown>): object {
		const reader = this.readers.get(binding.workspace);
		if (!reader) throw new Error("The native reader is not connected.");
		const serial = serialNumber(body.serial);
		// An earlier authenticated report can finish after a newer one.
		if (serial >= reader.serial) {
			this.installView(binding, reader, serial, readLiveView(body.view));
			this.contact(binding.workspace);
		}
		return { ok: true };
	}
	private async poll(binding: LiveBinding, after: unknown, response: ServerResponse): Promise<object> {
		const handle = liveHandle(binding);
		if (!Number.isSafeInteger(after) || Number(after) < 0 || this.wakes.has(handle))
			throw new Error("Invalid or duplicate live poll.");
		const available = () =>
			[...this.pending.values()].find(
				(item) =>
					!item.cancelled && !(item.command.op === "navigate" && item.delivered) && liveHandle(item.command) === handle,
			);
		this.contact(binding.workspace);
		if (!available() && after === this.stateAfter(binding.workspace, Number(after)).sequence)
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
		this.contact(binding.workspace);
		const pending = available();
		if (pending && !response.destroyed) {
			pending.delivered = true;
			const reader = this.readers.get(binding.workspace);
			if (pending.command.op === "navigate" && reader) reader.navigation = { command: pending.command };
		}
		return { ok: true, command: pending?.command ?? null, state: this.stateAfter(binding.workspace, Number(after)) };
	}
	private navigationResult(
		reader: Reader,
		binding: LiveBinding,
		body: Record<string, unknown>,
		navigation: NonNullable<Reader["navigation"]>,
	): object {
		const command = navigation.command;
		if (liveHandle(binding) !== liveHandle(command))
			throw new Error("The navigation receipt came from another source handle.");
		const result = readLiveResult(body.result, command);
		if (navigation.result) {
			if (JSON.stringify(navigation.result) !== JSON.stringify(result))
				throw new Error("The navigation receipt changed after acknowledgement.");
			return { ok: true };
		}
		this.binding(binding);
		const pending = this.pending.get(command.requestId);
		if (result.status === "navigated") {
			if (result.workspace !== binding.workspace)
				throw new Error("The navigation receipt belongs to a different pane.");
			this.installView(readLiveBinding(result), reader, serialNumber(body.serial), result.view, pending);
		}
		navigation.result = result;
		if (pending) this.complete(pending, result);
		return { ok: true };
	}
	private result(binding: LiveBinding, body: Record<string, unknown>): object {
		if (!liveId(body.requestId)) throw new Error("Invalid native result identity.");
		const reader = this.readers.get(binding.workspace);
		if (reader?.navigation?.command.requestId === body.requestId)
			return this.navigationResult(reader, binding, body, reader.navigation);
		this.binding(binding);
		const pending =
			this.pending.get(body.requestId) ??
			[...this.edits.values()].find((entry) => entry.pending.command.requestId === body.requestId)?.pending;
		if (!pending) return { ok: true };
		if (liveHandle(pending.command) !== liveHandle(binding))
			throw new Error("The receipt belongs to a different native document.");
		if (!pending.delivered) throw new Error("The native command was not delivered.");
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
		if (this.fencedPrompts.has(body.operationId))
			return {
				ok: true,
				status: "uncertain",
				retryable: false,
				message: "Pi could not restore this admission receipt. Check the conversation before another request.",
			};
		let prior = this.prompts.get(body.operationId);
		if (!prior && this.bindings.get(binding.workspace)?.document !== binding.document)
			return rejected("This question's original buffer is no longer selected. Nothing was submitted.");
		if (prior && prior.fingerprint !== fingerprint)
			return rejected("The prompt ID already names a different request; the changed request was not submitted.");
		if (!prior || (prior.result?.status === "uncertain" && prior.result.retryable)) {
			try {
				this.route.checkAdmission?.();
			} catch {
				throw new RequestFailure(503, "The conversation is unavailable. This prompt was not submitted.");
			}
			if (!prior && this.prompts.size + this.fencedPrompts.size >= 128)
				return rejected("The live prompt receipt limit is reached; this request was not submitted.");
			const operationId = body.operationId;
			const text = `This question (${operationId}) comes from the live Markdown pane ${handle}. Answer in your final message; the Ask card shows it. Use markdown_live with this handle to read context or apply {find, replace} edits. Do not substitute a stored document, file write or new pane.\n\n${body.text}`;
			const promise = Promise.resolve()
				.then(() => {
					if (this.closed) return { status: "rejected" as const, message: "The route closed before submission." };
					return this.route.submit(text, operationId);
				})
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
		if (this.closed || !this.config)
			throw new RequestFailure(410, "This Pi conversation disconnected. Reopen the reader from the session.");
		switch (path) {
			case "/reserve":
				this.prune();
				if (body.origin === "agent" && [...this.readers.values()].some((r) => r.origin === "agent"))
					throw new Error("An agent reader is already open. Check its connection and navigate that pane instead.");
				return this.launches.reserve(body, this.config);
			case "/starting":
				this.launches.starting(body);
				return { ok: true };
			case "/cancel":
				this.launches.cancel(body);
				return { ok: true };
		}
		const binding = readLiveBinding(body);
		switch (path) {
			case "/connect":
				return this.connect(binding, body);
			case "/close":
				if (body.pane === true) this.leave(binding.workspace);
				else if (this.documents.has(liveHandle(binding))) this.disconnect(binding);
				return { ok: true };
			case "/result":
				return this.result(binding, body);
			case "/prompt":
				return this.prompt(binding, body);
		}
		this.binding(binding);
		return path === "/state" ? this.updateView(binding, body) : this.poll(binding, body.after, response);
	}
	private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			if (!this.authorised(request)) {
				this.send(response, 403, { ok: false, error: "Unauthorised live Markdown request." });
				return;
			}
			if (
				!["/reserve", "/starting", "/cancel", "/connect", "/state", "/poll", "/result", "/prompt", "/close"].includes(
					request.url ?? "",
				)
			) {
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
			this.send(response, error instanceof RequestFailure ? error.code : 409, {
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
	async get(key: string, route: () => LiveRoute, conversation = key, handoff?: LiveBridgeHandoff): Promise<LiveBridge> {
		if (this.closed) throw new Error("The live Markdown host closed.");
		let promise = this.bridges.get(key);
		if (!promise) {
			if (this.bridges.size >= 32) throw new Error("The live conversation limit is reached.");
			const bridge = new LiveBridge(route(), undefined, undefined, this.paneGraceMs, conversation);
			promise = bridge
				.start(handoff)
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
	async release(key: string): Promise<LiveBridgeHandoff | undefined> {
		const promise = this.bridges.get(key);
		this.bridges.delete(key);
		return (await promise)?.release();
	}
	delete(key: string): void {
		const promise = this.bridges.get(key);
		this.bridges.delete(key);
		void promise?.then(
			(bridge) => bridge.close(),
			() => {},
		);
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
