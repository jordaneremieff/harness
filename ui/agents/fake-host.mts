import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChordError, type JsonValue } from "@earendil-works/chord";
import { createTransportServer, type FeedKind, type TransportRequest, type TransportServer } from "../../transport/index.ts";

export const STORAGE = "00000000-0000-4000-8000-000000000001";
export const CHILD = `${STORAGE}:2`;
type JsonObject = { [key: string]: JsonValue };
export interface FakeCall {
	connection: number;
	member: string;
	params: JsonObject | null;
	wireRequestId: string;
	expected: unknown;
	signal: AbortSignal;
}
export function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** Fabricated current host values remain independent of the UI decoder. */
export function frame(revision = 1, identity = STORAGE): JsonObject {
	const conversationId = identity === STORAGE ? 1 : Number(identity.split(":")[1]);
	return {
		scope: "conversation",
		storageId: STORAGE,
		conversationId,
		revision,
		observedAt: "2026-01-01T00:00:00.000Z",
		entries: [],
		live: [],
		nextBefore: null,
		status: {
			conversationId,
			identity,
			busy: false,
			lastText: "",
			live: null,
			inbox: [],
			agent: { thinkingLevel: "off", extensions: [], tools: [] },
			tasks: [],
			submissions: [],
		},
		coverage: {
			complete: true,
			entries: 0,
			bytes: 0,
			hiddenExcluded: 0,
			entryLimitReached: false,
			byteLimitReached: false,
		},
	};
}
export function snapshot(): JsonObject {
	return {
		entries: [],
		partial: false,
		revision: "empty",
		nextBefore: null,
		coverage: {
			complete: true,
			entries: 0,
			bytes: 0,
			hiddenExcluded: 0,
			entryLimitReached: false,
			byteLimitReached: false,
		},
	};
}
export function receipt(identity = STORAGE, requestId = "input-example"): JsonObject {
	return {
		submissionId: 7,
		conversationId: identity === STORAGE ? 1 : Number(identity.split(":")[1]),
		deduped: false,
		identity,
		result: { sessionId: identity, submissionId: 7, requestId },
	};
}
export function activity(identity = STORAGE): JsonObject {
	return { view: "activity", format: "compact", sessionId: identity,
		conversationId: identity === STORAGE ? 1 : Number(identity.split(":")[1]), turns: [], nextCursor: null,
		metadata: { owner: "here", live: true, operation: null, pending: 0, runningTools: [] },
		coverage: { scannedEntries: 0, scannedBytes: 0, complete: true, entryLimitReached: false,
			scanByteLimitReached: false, byteLimitReached: false, bytes: 0, omittedEntries: 0, metadataTruncated: false }, detail: "" };
}
export function blockedResult(identity = STORAGE, requestId = "input-example"): JsonObject {
	const conversationId = identity === STORAGE ? 1 : Number(identity.split(":")[1]);
	return { view: "result", sessionId: identity, conversationId, submissionId: 7, status: "done", requestId,
		usage: { models: {}, tools: {} }, recoveryOf: "previous-block",
		providerBlock: { blockId: "block-example", conversationId, providerSessionId: "provider-example", epoch: 0,
			model: { provider: "fixture", modelId: "fixture" }, error: "Quota exhausted.", errorRedacted: false,
			errorTruncated: false, source: "provider", timestamp: 0,
			originalResults: [{ sessionId: identity, submissionId: 7, requestId }], omittedOriginalResults: 0 } };
}
/** A status reply with an inventory, shaped like the host response. A host command named `tree` or `reload` is reserved and listed here only to show the UI leaves it out. */
export function statusReply(): JsonObject {
	return { conversation: { conversationId: 1, identity: STORAGE }, inventory: { contributions: [{ name: "fixture-contribution", source: "fixture/contribution.ts",
		commands: [{ name: "ping", description: "Reply with pong" }, { name: "tree", description: "Reserved" }, { name: "reload", description: "Reserved" }] }],
		ordinaryOnly: ["fixture-ordinary"] }, pid: 1, storageId: STORAGE };
}
export function commandReply(identity: string, name: string, text: string): JsonObject {
	return { name, conversationId: identity === STORAGE ? 1 : Number(identity.split(":")[1]), identity, text };
}
export const THREAD = `${STORAGE}/${"a".repeat(32)}`;
const THREAD_FRAME = { title: "Protocol design", purpose: "Keep peers useful", authority: "Operator task", source: "Operator task source",
	restrictions: "No external changes", acceptance: "Exchange survives restart", integrator: STORAGE };
function threadEvent(sequence: number, fields: JsonObject): JsonObject {
	return { threadId: THREAD, sequence, at: 1_800_000_000_000 + sequence, sender: STORAGE, origin: "model", source: "", replyTo: null,
		revision: sequence >= 4 ? 2 : 1, notify: [], ...fields } as JsonObject;
}
/** Fabricated thread events in the shape the collaboration read returns; values are independent of the UI decoder. */
export function threadEvents(): JsonObject[] {
	return [
		threadEvent(1, { kind: "create", message: JSON.stringify({ ...THREAD_FRAME, purpose: "Keep peers" }), source: "Operator task source" }),
		threadEvent(2, { kind: "join", sender: CHILD, message: "Challenge" }),
		threadEvent(3, { kind: "contribution", message: "Hello", replyTo: 1, notify: [CHILD] }),
		threadEvent(4, { kind: "revise", message: JSON.stringify(THREAD_FRAME), source: "Operator task source" }),
		threadEvent(5, { kind: "carried-authority", message: "Authority", source: "Operator" }),
	];
}
export function threadRecord(): JsonObject {
	return { ...THREAD_FRAME, id: THREAD, creator: STORAGE, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_005, revision: 2, closed: false,
		sequence: 5, members: [{ identity: STORAGE, contribution: "Lead", joinedAt: 1_800_000_000_000 }, { identity: CHILD, contribution: "Challenge", joinedAt: 1_800_000_000_002 }] };
}
export function threadList(): JsonObject {
	const thread = threadRecord();
	return { items: [{ id: THREAD, title: thread.title, purpose: String(thread.purpose).slice(0, 160), updatedAt: thread.updatedAt, closed: false, members: 2 }],
		nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } };
}
/** Pages newest first by exclusive boundary, like the host: events older than `before`, oldest first within the page. */
export function threadPage(input: JsonObject): JsonObject {
	if (input.threadId !== THREAD) throw new ChordError("invalid", "Thread not found", { reason: "thread" });
	const limit = typeof input.limit === "number" ? input.limit : 10;
	const before = typeof input.before === "number" ? input.before : 6;
	const events = threadEvents().filter(event => (event.sequence as number) < before).slice(-limit);
	const oldest = events.length ? (events[0].sequence as number) : before;
	const nextBefore = oldest > 1 ? oldest : null;
	const page: JsonObject = { thread: threadRecord(), events, nextBefore, pending: 0, coverage: { complete: nextBefore === null, bytes: 0 } };
	(page.coverage as JsonObject).bytes = Buffer.byteLength(JSON.stringify(page));
	return page;
}
export async function descriptor(): Promise<JsonObject> {
	const metadata = JSON.parse(
		await readFile(new URL("../../node_modules/@earendil-works/pi-durable/package.json", import.meta.url), "utf8"),
	);
	const durable: string = metadata.version;
	return {
	"format": "pi.agent.contract/1",
	"release": "1.0.0",
	"upstream": {
		"codingAgent": "1.2.0",
		"durable": durable
	},
	"requires": {
		"codingAgent": "1.2.0",
		"durable": durable
	},
	"operations": {
		"close": {
			"request": "close/1.0.0",
			"response": "close/1.0.0"
		},
		"recovery-state": {
			"request": "recovery-state/1.0.0",
			"response": "recovery-state/1.1.0"
		},
		"submit": {
			"request": "submit/1.3.0",
			"response": "submit/1.1.0"
		},
		"passive-submit": {
			"request": "passive-submit/1.1.0",
			"response": "passive-submit/1.0.0"
		},
		"spawn": {
			"request": "spawn/2.0.0",
			"response": "spawn/2.0.0"
		},
		"place": {
			"request": "place/2.0.0",
			"response": "place/2.0.0"
		},
		"attach": {
			"request": "attach/1.0.0",
			"response": "attach/1.0.0"
		},
		"receipts": {
			"request": "receipts/1.1.0",
			"response": "receipts/1.2.0",
			"durable": durable
		},
		"report": {
			"request": "report/1.0.0",
			"response": "report/1.0.0"
		},
		"acknowledge": {
			"request": "acknowledge/1.0.0",
			"response": "acknowledge/1.0.0"
		},
		"inspect": {
			"request": "inspect/1.1.0",
			"response": "d38d5e5a297d6b3738547ab0154cd494602f01c4a898423a076d2d946e430a6b",
			"durable": durable
		},
		"status": {
			"request": "status/1.0.0",
			"response": "481a5267ce06c0ed2bb89e85e142e3a5d58c78828fb502c46ff815a3cb889197",
			"durable": durable
		},
		"list": {
			"request": "list/1.0.0",
			"response": "76e932a0749fd72c9aef6b90635d061e455f84fb57f7f9bd102034cf28887600"
		},
		"fork": {
			"request": "fork/1.0.0",
			"response": "fork/1.0.0",
			"durable": durable
		},
		"rewind": {
			"request": "rewind/1.1.0",
			"response": "rewind/1.0.0",
			"durable": durable
		},
		"abort": {
			"request": "abort/1.0.0",
			"response": "abort/1.0.0"
		},
		"compact": {
			"request": "compact/1.0.0",
			"response": "compact/1.0.0",
			"durable": durable
		},
		"configure": {
			"request": "configure/1.3.0",
			"response": "configure/1.3.0"
		},
		"command": {
			"request": "command/1.1.0",
			"response": "command/1.0.0",
			"durable": durable
		},
		"reset": {
			"request": "reset/1.0.0",
			"response": "reset/1.0.0"
		},
		"timer-schedule": {
			"request": "timer-schedule/1.1.0",
			"response": "timer-schedule/1.0.0"
		},
		"timer-list": {
			"request": "timer-list/1.0.0",
			"response": "timer-list/1.0.0"
		},
		"timer-cancel": {
			"request": "timer-cancel/1.0.0",
			"response": "timer-cancel/1.0.0"
		},
		"dashboard": {
			"request": "dashboard/1.0.0",
			"response": "a89f98f3eb28c78f115c0010581107073600bfb9ec44934ad622aeb5d1cffcd7"
		},
		"snapshot": {
			"request": "snapshot/1.0.0",
			"response": "snapshot/2.0.0",
			"durable": durable
		},
		"observe-open": {
			"request": "observe-open/1.0.0",
			"response": "observe-open/2.0.0",
			"durable": durable
		},
		"observe-frame": {
			"request": "observe-frame/1.0.0",
			"response": "observe-frame/2.0.0",
			"durable": durable
		},
		"observe-close": {
			"request": "observe-close/1.0.0",
			"response": "observe-close/1.0.0"
		},
		"changes": {
			"request": "changes/1.0.0",
			"response": "changes/1.0.0"
		},
		"collaboration-list": {
			"request": "collaboration-list/1.0.0",
			"response": "collaboration-list/1.0.0"
		},
		"collaboration-read": {
			"request": "collaboration-read/1.0.0",
			"response": "collaboration-read/1.0.0"
		},
		"collaboration-mutate": {
			"request": "collaboration-mutate/1.0.0",
			"response": "collaboration-mutate/1.0.0"
		},
		"profile-read": {
			"request": "profile-read/1.0.0",
			"response": "b78d87440ae527566e0f13603e638dfa057aaa87f2985521e32b9c859baa1889"
		},
		"profile-update": {
			"request": "profile-update/1.0.0",
			"response": "7c805d143fae0d6a9fd373a4acb24fc080c94fa4b0787d447545e08714907eb4"
		},
		"profile-list": {
			"request": "profile-list/1.0.0",
			"response": "0eb5c60290d491535a1dd158e5d5ed4432eb8f89fe26a496a395e08b58ff4db4"
		},
		"resolve-agent": {
			"request": "resolve-agent/2.0.0",
			"response": "resolve-agent/2.0.0"
		},
		"task-submit": {
			"request": "task-submit/1.0.0",
			"response": "task-submit/1.2.0"
		},
		"await-state": {
			"request": "await-state/1.1.0",
			"response": "await-state/1.1.0"
		},
		"await-release": {
			"request": "await-release/1.0.0",
			"response": "await-release/1.0.0"
		}
	}
};
}
interface OwnedObservation {
	frame: JsonObject;
}
interface Subscription {
	kind: FeedKind;
	token?: string;
	publish: (value: unknown) => void;
}
interface Peer {
	id: number;
	key: string;
	tokens: Map<string, OwnedObservation>;
	subscriptions: Set<Subscription>;
	releases: Map<string, Promise<void>>;
}
export interface FakeHostOptions {
	/** An injected socket directory remains caller-owned; close removes only this host's private directory. */
	endpoint?: { serverId: string; socketPath: string };
	descriptor?: JsonValue;
	openFrame?: (identity: string) => JsonObject;
	openResult?: (token: string, value: JsonObject) => JsonValue;
	subscriptionFrame?: (identity: string) => JsonObject;
	subscriptionGate?: Promise<void>;
	onSubscribe?: () => void;
	observationReleaseGate?: Promise<void>;
	onObservationRelease?: () => void;
	maxFrameBytes?: number;
	maxQueueBytes?: number;
	handler?: (call: FakeCall) => JsonValue | undefined | Promise<JsonValue | undefined>;
}

/** Private Unix host for deterministic consumer regressions. It never opens a native runtime. */
export class FakeHost {
	readonly serverId: string;
	readonly calls: FakeCall[] = [];
	readonly errors: Error[] = [];
	readonly lifecycle: { kind: string; connection: number; token?: string }[] = [];
	readonly endpoint: { serverId: string; socketPath: string };
	readonly directory: string;
	readonly contract: JsonValue;
	readonly #options: FakeHostOptions;
	readonly #peers = new Map<string, Peer>();
	readonly #waiters: { predicate: (call: FakeCall) => boolean; resolve: (call: FakeCall) => void }[] = [];
	readonly #releaseWaiters: { count: number; resolve: () => void }[] = [];
	#server: TransportServer;
	#released = 0;
	#revision = 0;
	#nextPeer = 0;
	#closed = false;

	private constructor(directory: string, contract: JsonValue, options: FakeHostOptions) {
		this.directory = directory;
		this.contract = contract;
		this.#options = options;
		this.serverId = options.endpoint?.serverId ?? randomUUID();
		this.endpoint = {
			serverId: this.serverId,
			socketPath: options.endpoint?.socketPath ?? join(directory, "host.sock"),
		};
		this.#server = this.#createServer();
	}
	#createServer(): TransportServer {
		return createTransportServer({ serverId: this.serverId, path: this.endpoint.socketPath,
			maxFrameBytes: this.#options.maxFrameBytes, maxQueueBytes: this.#options.maxQueueBytes,
			request: (request, key, signal) => this.#invoke(this.#peer(key), request, signal),
			subscribe: (kind, token, key, publish) => this.#subscribe(this.#peer(key), kind, token, publish),
			release: key => { const peer = this.#peers.get(key); if (peer) this.#release(peer); },
		});
	}
	static async start(options: FakeHostOptions = {}): Promise<FakeHost> {
		// The directory and socket are ephemeral and removed by close(), including startup failure.
		const directory = await mkdtemp(join(tmpdir(), "ui-host-"));
		await chmod(directory, 0o700);
		const host = new FakeHost(
			directory,
			"descriptor" in options ? (options.descriptor as JsonValue) : await descriptor(),
			options,
		);
		try {
			await host.#server.start();
			return host;
		} catch (error) {
			await host.close();
			throw error;
		}
	}
	get tokenCount() {
		return [...this.#peers.values()].reduce((sum, peer) => sum + peer.tokens.size, 0);
	}
	get connectionCount() {
		return this.#peers.size;
	}
	waitForCall(predicate: (call: FakeCall) => boolean): Promise<FakeCall> {
		const existing = this.calls.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve) => this.#waiters.push({ predicate, resolve }));
	}
	waitForRelease(count = 1): Promise<void> {
		if (this.#released >= count) return Promise.resolve();
		return new Promise((resolve) => this.#releaseWaiters.push({ count, resolve }));
	}
	async disconnect(): Promise<void> {
		await this.#server.close();
		if (this.#closed) return;
		this.#server = this.#createServer();
		await this.#server.start();
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#server.close();
		} finally {
			await rm(this.directory, { recursive: true, force: true });
		}
	}
	async publish(value: JsonObject): Promise<void> {
		for (const peer of this.#peers.values()) {
			for (const observation of peer.tokens.values()) {
				if (observation.frame.conversationId === value.conversationId) observation.frame = value;
			}
			for (const subscription of peer.subscriptions) {
				const observation = subscription.token === undefined ? undefined : peer.tokens.get(subscription.token);
				if (observation?.frame.conversationId === value.conversationId) subscription.publish(value);
			}
		}
	}
	publishChanges(revision = this.#revision + 1): void {
		this.#revision = revision;
		for (const peer of this.#peers.values()) for (const subscription of peer.subscriptions) {
			if (subscription.kind === "changes") subscription.publish({ revision });
		}
	}
	unavailable(token: string): void {
		for (const peer of this.#peers.values()) for (const subscription of peer.subscriptions) {
			if (subscription.token === token) subscription.publish(null);
		}
	}
	#peer(key: string): Peer {
		const existing = this.#peers.get(key);
		if (existing) return existing;
		const peer: Peer = { id: ++this.#nextPeer, key, tokens: new Map(), subscriptions: new Set(), releases: new Map() };
		this.#peers.set(key, peer);
		this.lifecycle.push({ kind: "connect", connection: peer.id });
		return peer;
	}
	async #invoke(peer: Peer, request: TransportRequest, signal: AbortSignal): Promise<unknown> {
		if (request.method === "runtime-contract") return this.contract;
		const captured = this.#capture(peer, request, signal);
		const override = await this.#options.handler?.(captured);
		if (captured.member === "observe-close") await peer.releases.get(String(captured.params?.token));
		return override !== undefined ? override : this.#operate(peer, captured);
	}
	async #subscribe(peer: Peer, kind: FeedKind, token: string | undefined, publish: Subscription["publish"]): Promise<{ value: unknown; close: () => void }> {
		let baseline: unknown = { revision: this.#revision };
		if (kind === "observation") {
			const owned = token === undefined ? undefined : peer.tokens.get(token);
			if (!owned) throw new ChordError("invalid", "Observation token belongs to another connection", { reason: "token" });
			const identity = (owned.frame.status as JsonObject).identity as string;
			baseline = this.#options.subscriptionFrame?.(identity) ?? owned.frame;
			owned.frame = baseline as JsonObject;
		}
		const subscription: Subscription = { kind, ...(token === undefined ? {} : { token }), publish };
		peer.subscriptions.add(subscription);
		this.lifecycle.push({ kind: "subscribe", connection: peer.id, ...(token === undefined ? {} : { token }) });
		this.#options.onSubscribe?.();
		await this.#options.subscriptionGate;
		return { value: baseline, close: () => {
			if (!peer.subscriptions.delete(subscription)) return;
			this.lifecycle.push({ kind: "unsubscribe", connection: peer.id });
			if (token !== undefined) void this.#releaseObservation(peer, token).catch(error => this.errors.push(error instanceof Error ? error : new Error(String(error))));
		} };
	}
	#releaseObservation(peer: Peer, token: string): Promise<void> {
		const previous = peer.releases.get(token);
		if (previous) return previous;
		const release = (async () => {
			this.#options.onObservationRelease?.();
			await this.#options.observationReleaseGate;
			peer.tokens.delete(token);
		})().finally(() => peer.releases.delete(token));
		peer.releases.set(token, release);
		return release;
	}
	#capture(peer: Peer, request: TransportRequest, signal: AbortSignal): FakeCall {
		const advertised = (this.contract as JsonObject).operations as JsonObject;
		const local = advertised?.[request.method] as JsonObject | undefined;
		const supplied = request.contract as JsonObject | undefined;
		if (!local || !supplied || ["request", "response", "durable"].some((key) => supplied[key] !== local[key])) {
			throw new ChordError("unavailable", "Operation contract mismatch", { reason: "version" });
		}
		const captured: FakeCall = {
			connection: peer.id,
			member: request.method,
			params: request.params as JsonObject | null,
			wireRequestId: String(request.requestId),
			expected: request.contract,
			signal,
		};
		this.calls.push(captured);
		for (const waiter of [...this.#waiters]) {
			if (!waiter.predicate(captured)) continue;
			this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
			waiter.resolve(captured);
		}
		return captured;
	}
	#operate(peer: Peer, call: FakeCall): JsonValue {
		const input = call.params ?? {};
		switch (call.member) {
			case "snapshot":
				return snapshot();
			case "observe-open":
				return this.#open(peer, input);
			case "observe-close": {
				const token = String(input.token);
				for (const other of this.#peers.values()) {
					if (other !== peer && other.tokens.has(token)) throw new ChordError("invalid", "Observation token belongs to another connection", { reason: "token" });
				}
				const closed = peer.tokens.delete(token);
				this.lifecycle.push({ kind: "close", connection: peer.id, token });
				return { closed };
			}
			case "task-submit":
				return receipt(String(input.sessionId), String(input.requestId));
			case "abort":
				return {
					identity: input.sessionId ?? STORAGE,
					conversationId: input.sessionId === CHILD ? 2 : 1,
					background: input.background ?? false,
				};
			case "status":
				return statusReply();
			case "command":
				return commandReply(String(input.sessionId), String(input.name), "pong");
			case "dashboard":
				return [];
			case "collaboration-list":
				return threadList();
			case "collaboration-read":
				return threadPage(input);
			default:
				return {};
		}
	}
	#open(peer: Peer, input: JsonObject): JsonValue {
		const token = String(input.token);
		const value = this.#options.openFrame?.(String(input.sessionId)) ?? frame(1, String(input.sessionId));
		if (!this.#peers.has(peer.key)) throw new ChordError("unavailable", "Observation connection closed", { reason: "transport" });
		if (peer.tokens.has(token)) throw new ChordError("invalid", "Duplicate observation token", { reason: "token" });
		peer.tokens.set(token, { frame: value });
		this.lifecycle.push({ kind: "open", connection: peer.id, token });
		return this.#options.openResult?.(token, value) ?? { token, frame: value };
	}
	#release(peer: Peer): void {
		peer.tokens.clear();
		peer.subscriptions.clear();
		this.#peers.delete(peer.key);
		this.lifecycle.push({ kind: "release", connection: peer.id });
		this.#released++;
		for (const waiter of [...this.#releaseWaiters]) {
			if (this.#released < waiter.count) continue;
			this.#releaseWaiters.splice(this.#releaseWaiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	}
}
