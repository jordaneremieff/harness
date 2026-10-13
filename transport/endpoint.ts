/** Chord contracts for local host operations and connection-owned state feeds. */
import { randomUUID } from "node:crypto";
import { ChordError, cell, createHost, invalid, isChordError, isJsonValue, method, remote, resource, type Handle, type Host, type Link } from "@earendil-works/chord";
import { Type } from "typebox";
import { connectUnixLink, listenUnixLinks } from "./unix-link.ts";

export const Endpoint = remote("pi.agent.endpoint", {
	version: 1,
	input: Type.Object({ serverId: Type.String() }, { additionalProperties: false }),
	variants: { default: { methods: {
		request: method(Type.Object({
			method: Type.String({ minLength: 1, maxLength: 128 }),
			params: Type.Optional(Type.Unknown()),
			requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			contract: Type.Optional(Type.Unknown()),
		}, { additionalProperties: false }), Type.Object({ value: Type.Optional(Type.Unknown()) }, { additionalProperties: false })),
	} } },
});
export const Feed = remote("pi.agent.feed", {
	version: 1,
	input: Type.Object({ serverId: Type.String(), kind: Type.Union([Type.Literal("changes"), Type.Literal("observation")]), token: Type.Optional(Type.String()) }, { additionalProperties: false }),
	variants: { default: { state: { value: Type.Object({ ready: Type.Boolean(), value: Type.Optional(Type.Unknown()) }, { additionalProperties: false }) } } },
});

export interface TransportRequest { readonly method: string; readonly params?: unknown; readonly requestId?: string; readonly contract?: unknown }
export type FeedKind = "changes" | "observation";
export interface TransportSubscription { readonly value: unknown; dispose(): Promise<void> }
export interface TransportClient {
	readonly connected: boolean;
	request(request: TransportRequest, signal?: AbortSignal): Promise<unknown>;
	subscribe(kind: FeedKind, token: string | undefined, listener: (value: unknown) => void, signal?: AbortSignal): Promise<TransportSubscription>;
	onClose(listener: (reason: string) => void): () => void;
	dispose(): Promise<void>;
}
export interface TransportServerOptions {
	readonly serverId: string;
	readonly path: string;
	readonly maxFrameBytes?: number;
	readonly maxQueueBytes?: number;
	readonly request: (request: TransportRequest, peerId: string, signal: AbortSignal) => Promise<unknown>;
	readonly subscribe?: (kind: FeedKind, token: string | undefined, peerId: string, publish: (value: unknown) => void) => Promise<{ value: unknown; close: () => void }> | { value: unknown; close: () => void };
	readonly release?: (peerId: string) => void;
}
export interface TransportServer { start(): Promise<void>; close(): Promise<void> }

function jsonValue(value: unknown): void {
	if (value !== undefined && !isJsonValue(value)) throw invalid("json", "The host transport requires a strict JSON value");
}
function wrapped(value: unknown): { value?: unknown } { jsonValue(value); return value === undefined ? {} : { value }; }
function peerKey(principal: unknown): string {
	if (principal === null || typeof principal !== "object" || !("connection" in principal) || typeof principal.connection !== "string") throw invalid("principal", "The host endpoint requires a connection principal");
	return principal.connection;
}

export function createTransportServer(options: TransportServerOptions): TransportServer {
	const peers = new Set<string>();
	const host = createHost({ name: options.serverId, principalKey: (principal) => principal !== null && typeof principal === "object" && "connection" in principal ? String(principal.connection) : "host" });
	const authorize = (serverId: string, principal: unknown): string => {
		if (serverId !== options.serverId) throw invalid("identity", "The host endpoint identity differs from the requested serverId");
		const key = peerKey(principal);
		if (!peers.has(key)) throw invalid("principal", "The host connection is closed");
		return key;
	};
	host.serve(Endpoint, ({ serverId }, principal) => {
		const peer = authorize(serverId, principal);
		return { kind: "default", request: async (request, ctx) => {
			try { return wrapped(await options.request(request, peer, ctx.signal)); }
			catch (error) { if (isChordError(error)) throw error; throw new ChordError("unavailable", error instanceof Error ? error.message : String(error), { reason: "internal" }); }
		} };
	});
	host.serve(Feed, ({ serverId, kind, token }, principal, self) => {
		const peer = authorize(serverId, principal);
		const state = self.state({ value: cell(Type.Object({ ready: Type.Boolean(), value: Type.Optional(Type.Unknown()) }, { additionalProperties: false }), { ready: false } as { ready: boolean; value?: unknown }) });
		self.resources({ feed: resource({ rev: 1, open: async () => {
			if (!options.subscribe) throw invalid("feed", "The endpoint publishes no state feeds");
			let closed = false;
			let latest: { value?: unknown } | undefined;
			let active = false;
			const publish = (value: unknown): void => {
				if (closed || !peers.has(peer)) return;
				latest = wrapped(value);
				if (active) void host.root((ctx) => { if (!closed && peers.has(peer)) state.value.replace(ctx, { ready: true, ...latest }); }).catch(() => {});
			};
			const subscription = await options.subscribe(kind, token, peer, publish);
			if (!peers.has(peer)) { closed = true; subscription.close(); throw invalid("feed", "The host connection closed during subscription"); }
			try {
				const baseline = wrapped(subscription.value);
				active = true;
				await host.root((ctx) => state.value.replace(ctx, { ready: true, ...(latest ?? baseline) }));
				return () => { closed = true; subscription.close(); };
			} catch (error) { closed = true; subscription.close(); throw error; }
		}, close: (close) => close() }) });
		return { kind: "default", value: state.value };
	});
	const server = listenUnixLinks(options.path, (link) => {
		const peer = randomUUID();
		peers.add(peer);
		link.onClose(() => { peers.delete(peer); options.release?.(peer); });
		host.accept(link, { kind: "client", principal: { connection: peer } });
	}, options);
	let closing: Promise<void> | undefined;
	return { start: () => server.start(), close: () => closing ??= (async () => { await server.close(); await host.close(); })() };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export async function connectTransport(options: { readonly serverId: string; readonly path: string; readonly timeoutMs?: number; readonly maxFrameBytes?: number; readonly maxQueueBytes?: number }): Promise<TransportClient> {
	const deadline = AbortSignal.timeout(options.timeoutMs ?? 5000);
	const link = await connectUnixLink(options.path, { expectedName: options.serverId, expectedKind: "host", signal: deadline, maxFrameBytes: options.maxFrameBytes, maxQueueBytes: options.maxQueueBytes });
	const host = createHost({ kind: "client", upstream: link });
	const endpoint = host.get(Endpoint, { serverId: options.serverId }, { at: options.serverId });
	const disconnected = new AbortController();
	link.onClose((reason) => disconnected.abort(new Error(`The host link closed during connection: ${reason}`)));
	try { await abortable(endpoint.ready, AbortSignal.any([deadline, disconnected.signal])); }
	catch (error) { link.close("identity handshake failed"); await host.close(); throw error; }
	return new ConnectedTransport(host, link, endpoint, options.serverId);
}

class ConnectedTransport implements TransportClient {
	private readonly host: Host;
	private readonly link: Link;
	private readonly endpoint: Handle<typeof Endpoint>;
	private readonly serverId: string;
	private readonly closedListeners = new Set<(reason: string) => void>();
	private reason = "closed";
	private readonly disconnected = new AbortController();
	private closing: Promise<void> | undefined;
	constructor(host: Host, link: Link, endpoint: Handle<typeof Endpoint>, serverId: string) {
		this.host = host; this.link = link; this.endpoint = endpoint; this.serverId = serverId;
		link.onClose((reason) => {
			this.reason = reason;
			this.disconnected.abort(new ChordError("unavailable", reason, { reason: "transport" }));
			for (const listener of this.closedListeners) { try { listener(reason); } catch {} }
			this.closedListeners.clear();
		});
	}
	get connected(): boolean { return !this.link.closed; }
	onClose(listener: (reason: string) => void): () => void {
		if (this.link.closed) listener(this.reason); else this.closedListeners.add(listener);
		return () => { this.closedListeners.delete(listener); };
	}
	async request(request: TransportRequest, signal?: AbortSignal): Promise<unknown> {
		if (this.link.closed) throw new Error("The host link is closed");
		jsonValue(request);
		const result = await this.host.root((ctx) => this.endpoint.request(request, ctx), signal ? { signal } : undefined);
		return result.value;
	}
	async subscribe(kind: FeedKind, token: string | undefined, listener: (value: unknown) => void, signal?: AbortSignal): Promise<TransportSubscription> {
		if (this.link.closed) throw new Error("The host link is closed");
		signal = signal ? AbortSignal.any([signal, this.disconnected.signal]) : this.disconnected.signal;
		signal.throwIfAborted();
		const handle = this.host.get(Feed, { serverId: this.serverId, kind, ...(token === undefined ? {} : { token }) }, { at: this.serverId });
		let disposed = false;
		let value: unknown;
		let off = () => {};
		let offStatus = () => {};
		let hydrated = false;
		let resolveValue: () => void = () => {};
		let rejectValue: (error: unknown) => void = () => {};
		const first = new Promise<void>((resolve, reject) => { resolveValue = resolve; rejectValue = reject; });
		void first.catch(() => {});
		const dispose = async (): Promise<void> => {
			if (disposed) return;
			disposed = true;
			off(); offStatus(); handle.release();
			signal?.removeEventListener("abort", aborted);
			if (!hydrated) rejectValue(new Error("The state subscription closed before hydration"));
		};
		const aborted = () => { rejectValue(signal?.reason); void dispose(); };
		signal?.addEventListener("abort", aborted, { once: true });
		try {
			const ready = signal ? abortable(handle.ready, signal) : handle.ready;
			await ready;
			offStatus = handle.onStatus((status, error) => { if (status !== "live") rejectValue(error ?? new Error("The state subscription is unavailable")); });
			off = handle.value.subscribe((state) => {
				if (disposed || !state?.ready) return;
				value = state.value;
				if (!hydrated) { hydrated = true; resolveValue(); }
				else { try { listener(value); } catch {} }
			});
			await first;
			return { get value() { return value; }, dispose };
		} catch (error) { await dispose(); throw error; }
	}
	dispose(): Promise<void> {
		this.closing ??= (async () => { this.link.close("client closed"); await this.host.close(); })();
		return this.closing;
	}
}
