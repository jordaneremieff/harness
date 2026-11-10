/** Chord contracts for local host operations and connection-owned state feeds. */
import { randomUUID } from "node:crypto";
import { ChordError, PluginError, binaryCodec, bool, broken, createHost, defineFacet, hostKind, invalid, isChordError, method, obj, oneOf, opt, remote, str, unknown, type Host, type Reference } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { isJsonValue, type JsonValue } from "@earendil-works/chord/json";
import type { WatchHandle } from "@earendil-works/chord/watch";
import { connectUnixLink, listenUnixLinks, UNIX_FRAME_BYTES, type UnixLink } from "./unix-link.ts";

const placement = hostKind("pi.agent", { serverId: str() });
const hostName = (serverId: string) => `pi.agent:${serverId}`;
type TransportPrincipal = { kind: "connection"; connection: string };
export const Endpoint = remote("pi.agent.endpoint", {
	version: 1,
	params: { serverId: str() },
	hostAddress: ({ serverId }) => placement({ serverId }),
	variants: { default: { methods: {
		request: method(obj({ method: str({ min: 1, max: 128 }), params: opt(unknown()), requestId: opt(str({ min: 1, max: 128 })), contract: opt(unknown()) }), obj({ value: opt(unknown()) })),
	} } },
});
const FeedState = obj({ ready: bool(), value: opt(unknown()) });
export const Feed = remote("pi.agent.feed", {
	version: 1,
	params: { serverId: str(), kind: oneOf("changes", "observation"), token: str() },
	hostAddress: ({ serverId }) => placement({ serverId }),
	variants: { default: { state: { value: FeedState } } },
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
	readonly serverId: string; readonly path: string;
	readonly maxFrameBytes?: number; readonly maxSendFrameBytes?: number; readonly maxQueueBytes?: number;
	readonly request: (request: TransportRequest, peerId: string, signal: AbortSignal) => Promise<unknown>;
	readonly subscribe?: (kind: FeedKind, token: string | undefined, peerId: string, publish: (value: unknown) => void) => Promise<{ value: unknown; close: () => void }> | { value: unknown; close: () => void };
	readonly release?: (peerId: string) => void;
}
export interface TransportServer { start(): Promise<void>; close(): Promise<void> }
function jsonValue(value: unknown): void {
	if (value !== undefined && !isJsonValue(value)) throw invalid("args", "The host transport requires a strict JSON value");
}
function wrapped(value: unknown): { value?: JsonValue } { jsonValue(value); return value === undefined ? {} : { value: value as JsonValue }; }
function peerKey(principal: unknown): string {
	if (principal === null || typeof principal !== "object" || !("connection" in principal) || typeof principal.connection !== "string") throw new PluginError("principal", "The host endpoint requires a connection principal");
	return principal.connection;
}
const principal = (connection: string): TransportPrincipal => ({ kind: "connection", connection });
const limits = (options: { maxFrameBytes?: number }) => ({ part: options.maxFrameBytes ?? UNIX_FRAME_BYTES, decoded: options.maxFrameBytes ?? UNIX_FRAME_BYTES });

export function createTransportServer(options: TransportServerOptions): TransportServer {
	const peers = new Set<string>();
	const host = createHost<TransportPrincipal>({ address: placement({ serverId: options.serverId }), principal: principal("host"), principalKey: (value) => value.connection, onError: () => {} });
	const authorize = (serverId: string, value: unknown): string => {
		if (serverId !== options.serverId) throw new PluginError("identity", "The host endpoint identity differs from the requested serverId");
		const key = peerKey(value);
		if (!peers.has(key)) throw new PluginError("principal", "The host connection is closed");
		return key;
	};
	const facet = defineFacet<TransportPrincipal>((services) => {
		services.serve(Endpoint, ({ serverId }, value) => {
			const peer = authorize(serverId, value);
			return { variant: "default", members: { request: async (request, ctx) => wrapped(await options.request(request, peer, ctx.abortSignal ?? new AbortController().signal)) } };
		});
		services.serve(Feed, ({ serverId, kind, token }, value, self) => {
			const peer = authorize(serverId, value);
			let closed = false;
			let latest: { value?: JsonValue } | undefined;
			const source = self.writable<{ ready: boolean; value?: JsonValue }>({ ready: false });
			const state = self.derive([source], ([current]) => current);
			const subscribe = options.subscribe;
			if (!subscribe) throw broken(new PluginError("feed", "The endpoint publishes no state feeds"));
			const publish = (next: unknown): void => {
				if (closed || !peers.has(peer)) return;
				latest = wrapped(next);
				try { source.set({ ready: true, ...latest }); }
				catch (error) {
					// The source ends before native subscription cleanup; an already queued publication is no longer observable.
					if (!isChordError(error, "released")) throw error;
				}
			};
			self.open(async () => {
				let subscription: { value: unknown; close: () => void };
				try { subscription = await subscribe(kind, token, peer, publish); }
				catch (error) { closed = true; throw broken(error); }
				try {
					const baseline = wrapped(subscription.value);
					if (!peers.has(peer)) throw new PluginError("feed", "The host connection closed during subscription");
					latest ??= baseline; source.set({ ready: true, ...latest });
					return () => { closed = true; subscription.close(); };
				} catch (error) { closed = true; subscription.close(); throw broken(error); }
			}, (close) => close());
			return { variant: "default", members: { value: state } };
		});
	});
	const server = listenUnixLinks(options.path, (link) => {
		const peer = randomUUID(); peers.add(peer);
		link.onClose(() => { peers.delete(peer); options.release?.(peer); });
		host.accept(link, { principal: principal(peer), codec: binaryCodec, limits: limits(options) }, BACKGROUND_CONTEXT);
	}, { ...options, name: hostName(options.serverId) });
	let closing: Promise<void> | undefined;
	return {
		start: async () => { await host.load([{ name: "harness-transport", facet }], BACKGROUND_CONTEXT); await server.start(); },
		close: () => closing ??= (async () => { await server.close(); await host.close(BACKGROUND_CONTEXT); })(),
	};
}

export async function connectTransport(options: { readonly serverId: string; readonly path: string; readonly timeoutMs?: number; readonly maxFrameBytes?: number; readonly maxSendFrameBytes?: number; readonly maxQueueBytes?: number }): Promise<TransportClient> {
	const deadline = AbortSignal.timeout(options.timeoutMs ?? 5000);
	const link = await connectUnixLink(options.path, { expectedName: hostName(options.serverId), expectedKind: "host", signal: deadline, maxFrameBytes: options.maxFrameBytes, maxSendFrameBytes: options.maxSendFrameBytes, maxQueueBytes: options.maxQueueBytes });
	let protocolReason: string | undefined;
	const closeReason = () => protocolReason ?? link.reason;
	const host = createHost<TransportPrincipal>({ principal: principal("client"), principalKey: (value) => value.connection, onError: (report) => {
		if (report.kind === "protocol_error") protocolReason = report.error instanceof Error ? report.error.message : String(report.error);
	} });
	const disconnected = new AbortController();
	link.onClose(() => disconnected.abort(new Error(`The host link closed during connection: ${closeReason()}`)));
	try {
		await host.load([], BACKGROUND_CONTEXT);
		host.connect(link, { principal: principal("server"), codec: binaryCodec, limits: limits(options) }, BACKGROUND_CONTEXT);
		const endpoint = await host.get(Endpoint, { serverId: options.serverId }, withAbortSignal(AbortSignal.any([deadline, disconnected.signal]), BACKGROUND_CONTEXT), { readyTimeout: options.timeoutMs ?? 5000 });
		return new ConnectedTransport(host, link, endpoint, options.serverId, closeReason);
	} catch (error) {
		link.close("identity handshake failed"); await host.close(BACKGROUND_CONTEXT);
		if (protocolReason !== undefined) throw new Error(`The host link closed during connection: ${protocolReason}`, { cause: error });
		throw error;
	}
}
class ConnectedTransport implements TransportClient {
	private readonly closedListeners = new Set<(reason: string) => void>();
	private readonly disconnected = new AbortController();
	private closing: Promise<void> | undefined;
	private readonly host: Host<TransportPrincipal>;
	private readonly link: UnixLink;
	private readonly endpoint: Reference<typeof Endpoint>;
	private readonly serverId: string;
	private readonly closeReason: () => string;
	constructor(host: Host<TransportPrincipal>, link: UnixLink, endpoint: Reference<typeof Endpoint>, serverId: string, closeReason: () => string) {
		this.host = host; this.link = link; this.endpoint = endpoint; this.serverId = serverId; this.closeReason = closeReason;
		link.onClose(() => {
			// A synchronous send must return its request promise before callers abort or dispose its root scope.
			queueMicrotask(() => {
				this.disconnected.abort(new ChordError({ code: "unavailable", message: closeReason() }));
				for (const listener of this.closedListeners) { try { listener(closeReason()); } catch {} }
				this.closedListeners.clear();
			});
		});
	}
	get connected(): boolean { return !this.link.closed; }
	onClose(listener: (reason: string) => void): () => void {
		if (this.link.closed) listener(this.closeReason()); else this.closedListeners.add(listener);
		return () => { this.closedListeners.delete(listener); };
	}
	async request(request: TransportRequest, signal?: AbortSignal): Promise<unknown> {
		if (this.link.closed) throw new Error(`The host link is closed: ${this.closeReason()}`);
		jsonValue(request);
		const context = withAbortSignal(signal ? AbortSignal.any([signal, this.disconnected.signal]) : this.disconnected.signal, BACKGROUND_CONTEXT);
		try {
			const result = await this.host.root((ctx) => this.endpoint.request(request, ctx), context);
			return result.value;
		} catch (error) {
			if (this.link.closed) throw new ChordError({ code: "unavailable", message: `The host link closed: ${this.closeReason()}` }, { cause: error });
			throw error;
		}
	}
	async subscribe(kind: FeedKind, token: string | undefined, listener: (value: unknown) => void, signal?: AbortSignal): Promise<TransportSubscription> {
		if (this.link.closed) throw new Error(`The host link is closed: ${this.closeReason()}`);
		const abort = signal ? AbortSignal.any([signal, this.disconnected.signal]) : this.disconnected.signal;
		abort.throwIfAborted();
		const context = withAbortSignal(abort, BACKGROUND_CONTEXT);
		const handle = await this.host.get(Feed, { serverId: this.serverId, kind, token: token ?? "" }, context);
		let disposed = false, hydrated = false;
		let value: unknown;
		let watch: WatchHandle<{ ready: boolean; value?: unknown }> | undefined;
		let status: Awaited<ReturnType<typeof handle.state.watch>> | undefined;
		let resolveFirst: () => void = () => {}, rejectFirst: (error: unknown) => void = () => {};
		const first = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; }); void first.catch(() => {});
		const dispose = async (): Promise<void> => {
			if (disposed) return;
			disposed = true; watch?.stop(); status?.stop(); handle.release(); abort.removeEventListener("abort", aborted);
			if (!hydrated) rejectFirst(new Error("The state subscription closed before hydration"));
		};
		const aborted = () => { rejectFirst(abort.reason); void dispose(); };
		abort.addEventListener("abort", aborted, { once: true });
		try {
			watch = await handle.value.watch(context);
			const accept = (state: { ready: boolean; value?: unknown }) => {
				if (disposed || !state.ready) return;
				value = state.value;
				if (!hydrated) { hydrated = true; resolveFirst(); } else { try { listener(value); } catch {} }
			};
			accept(watch.value);
			watch.start(async (call) => { if (call.kind === "value") accept(call.value); else rejectFirst(call.error); });
			void watch.closed.then(() => { if (!hydrated) rejectFirst(new Error("The state subscription ended before hydration")); });
			status = await handle.state.watch(context);
			status.start(async (call) => { if (call.kind === "value" && call.value.kind !== "live") rejectFirst(new Error("The state subscription is unavailable")); });
			if (abort.aborted) aborted();
			await first;
			return { get value() { return value; }, dispose };
		} catch (error) { await dispose(); throw error; }
	}
	dispose(): Promise<void> {
		this.closing ??= (async () => { this.link.close("client closed"); this.endpoint.release(); await this.host.close(BACKGROUND_CONTEXT); })();
		return this.closing;
	}
}
