import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decodeServiceControlCall,
	type Context,
	type JsonValue,
	RemoteServiceError,
	type ServiceCall,
	type ServiceProviderUpdate,
} from "@earendil-works/chord";
import { Server, type ServerHost } from "@earendil-works/pi-server";
type ByteConnection = Parameters<Server["accept"]>[0];
import { createUnixListener } from "@earendil-works/pi-server/unix";

export const STORAGE = "00000000-0000-4000-8000-000000000001";
export const CHILD = `${STORAGE}:2`;
type JsonObject = { [key: string]: JsonValue };
export interface FakeCall {
	connection: number;
	member: string;
	params: JsonObject | null;
	wireRequestId: string;
	expected: JsonValue;
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

/** Fabricated wire values follow docs/agent-host-contract.md, not Agent internals. */
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
export async function descriptor(): Promise<JsonObject> {
	const metadata = JSON.parse(
		await readFile(new URL("../../node_modules/@earendil-works/pi-durable/package.json", import.meta.url), "utf8"),
	);
	const durable: string = metadata.version;
	const operations: JsonObject = {};
	for (const member of ["abort", "observe-close", "changes"]) {
		operations[member] = { request: `${member}/1.0.0`, response: `${member}/1.0.0` };
	}
	for (const member of ["snapshot", "observe-open", "observe-frame"]) {
		operations[member] = { request: `${member}/1.0.0`, response: `${member}/1.0.0`, durable };
	}
	operations["task-submit"] = { request: "task-submit/1.0.0", response: "task-submit/1.1.0" };
	operations.configure = { request: "configure/1.2.0", response: "configure/1.2.0" };
	operations.inspect = {
		request: "inspect/1.0.0",
		response: "98cbec841b6626155420cf582d77e318ea0c8e7607f113dffe04d94bf1b99736",
		durable,
	};
	operations.dashboard = {
		request: "dashboard/1.0.0",
		response: "46dd1bdd919bd3093ad6a3c0a316b35fa05d491490a37c9879ef9a9cffc4f241",
	};
	return {
		format: "pi.agent.contract/1",
		release: "1.0.0",
		upstream: { codingAgent: "1.0.3", durable },
		requires: { codingAgent: "1.0.0", durable: "1.0.0" },
		operations,
	};
}
interface OwnedObservation {
	frame: JsonObject;
}
interface Subscription {
	token: string;
	publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => unknown;
	context: Context;
}
interface Peer {
	id: number;
	tokens: Map<string, OwnedObservation>;
	subscriptions: Map<string, Subscription>;
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
	readonly #peers = new Map<number, Peer>();
	readonly #connections = new Set<ByteConnection>();
	readonly #waiters: { predicate: (call: FakeCall) => boolean; resolve: (call: FakeCall) => void }[] = [];
	readonly #releaseWaiters: { count: number; resolve: () => void }[] = [];
	readonly #server: Server;
	#released = 0;
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
		const unix = createUnixListener({ path: this.endpoint.socketPath, mode: 0o600 });
		const host: ServerHost = {
			serverServices: { attachClient: () => this.#attach() },
			resolveSession: async () => {
				throw new Error("Fake host has no native sessions");
			},
			openSession: async () => {
				throw new Error("Fake host never opens a runtime");
			},
		};
		this.#server = new Server(host, {
			serverId: this.serverId,
			onError: (error) => this.errors.push(error),
			listeners: [
				{
					start: (accept) =>
						unix.start((connection) => {
							this.#connections.add(connection);
							const handler = accept(connection);
							return {
								...handler,
								onClose: () => {
									this.#connections.delete(connection);
									handler.onClose();
								},
							};
						}),
					close: () => unix.close(),
				},
			],
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
		await Promise.all([...this.#connections].map((connection) => connection.close()));
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
		const pending: unknown[] = [];
		for (const peer of this.#peers.values()) {
			for (const [id, subscription] of peer.subscriptions) {
				const observation = peer.tokens.get(subscription.token);
				if (!observation || observation.frame.conversationId !== value.conversationId) continue;
				observation.frame = value;
				pending.push(
					subscription.publish(
						id,
						{ type: "state", member: "frame", sequence: Number(value.revision), ops: [["r", value]] },
						subscription.context,
					),
				);
			}
		}
		await Promise.all(pending);
	}
	#attach() {
		const id = this.lifecycle.filter((event) => event.kind === "connect").length + 1;
		const peer: Peer = { id, tokens: new Map(), subscriptions: new Map() };
		this.#peers.set(id, peer);
		this.lifecycle.push({ kind: "connect", connection: id });
		return {
			invokeService: (call: ServiceCall, publish: Subscription["publish"], context: Context) =>
				this.#invoke(peer, call, publish, context),
			release: () => this.#release(peer),
		};
	}
	async #invoke(peer: Peer, call: ServiceCall, publish: Subscription["publish"], context: Context): Promise<JsonValue> {
		const control = decodeServiceControlCall(call);
		if (control?.type === "unsubscribe") {
			peer.subscriptions.delete(control.subscriptionId);
			this.lifecycle.push({ kind: "unsubscribe", connection: peer.id });
			return null;
		}
		if (control?.type === "subscribe") return this.#subscribe(peer, control, publish, context);
		if (call.serviceId !== "pi.agent.host") throw new RemoteServiceError("service_invalid_value", "Unknown service");
		if (call.member === "runtime-contract") return this.contract;
		const captured = this.#capture(peer, call);
		const override = await this.#options.handler?.(captured);
		return override !== undefined ? override : this.#operate(peer, captured);
	}
	async #subscribe(
		peer: Peer,
		control: { serviceId: string; subscriptionId: string },
		publish: Subscription["publish"],
		context: Context,
	): Promise<JsonValue> {
		const token = control.serviceId.replace("pi.agent.host.observe:", "");
		const owned = peer.tokens.get(token);
		if (!owned)
			throw new RemoteServiceError("service_invalid_value", "Observation token belongs to another connection");
		const identity = (owned.frame.status as JsonObject).identity as string;
		const baseline = this.#options.subscriptionFrame?.(identity) ?? owned.frame;
		owned.frame = baseline;
		peer.subscriptions.set(control.subscriptionId, { token, publish, context });
		this.lifecycle.push({ kind: "subscribe", connection: peer.id, token });
		this.#options.onSubscribe?.();
		await this.#options.subscriptionGate;
		return {
			serviceId: "pi.agent.host.observe",
			mode: "singleton",
			instances: [
				{
					members: [
						{
							name: "frame",
							kind: "state",
							sequence: Number(baseline.revision),
							ops: [["r", baseline]],
						},
					],
				},
			],
		};
	}
	#capture(peer: Peer, call: ServiceCall): FakeCall {
		const [params, wireRequestId, expected] = call.args ?? [];
		const advertised = (this.contract as JsonObject).operations as JsonObject;
		const local = advertised?.[call.member] as JsonObject | undefined;
		const supplied = expected as JsonObject | undefined;
		if (!local || !supplied || ["request", "response", "durable"].some((key) => supplied[key] !== local[key])) {
			throw new RemoteServiceError("service_invalid_value", "Operation contract mismatch");
		}
		const captured: FakeCall = {
			connection: peer.id,
			member: call.member,
			params: params as JsonObject | null,
			wireRequestId: String(wireRequestId),
			expected,
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
			case "dashboard":
				return [];
			default:
				return {};
		}
	}
	#open(peer: Peer, input: JsonObject): JsonValue {
		const token = String(input.token);
		const value = this.#options.openFrame?.(String(input.sessionId)) ?? frame(1, String(input.sessionId));
		if (peer.tokens.has(token)) throw new RemoteServiceError("service_invalid_value", "Duplicate observation token");
		peer.tokens.set(token, { frame: value });
		this.lifecycle.push({ kind: "open", connection: peer.id, token });
		return this.#options.openResult?.(token, value) ?? { token, frame: value };
	}
	#release(peer: Peer): void {
		peer.tokens.clear();
		peer.subscriptions.clear();
		this.#peers.delete(peer.id);
		this.lifecycle.push({ kind: "release", connection: peer.id });
		this.#released++;
		for (const waiter of [...this.#releaseWaiters]) {
			if (this.#released < waiter.count) continue;
			this.#releaseWaiters.splice(this.#releaseWaiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	}
}
