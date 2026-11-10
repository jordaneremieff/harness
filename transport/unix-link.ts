/** Private-directory Unix transport for Chord's ordered byte links. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Link } from "@earendil-works/chord";

/** Default message payload bound; the four-byte length prefix is separate. */
export const UNIX_FRAME_BYTES = 16 * 1024 * 1024;
/** Queued encoded messages, including their length prefixes. */
export const UNIX_QUEUE_BYTES = 64 * 1024 * 1024;
/** The adapter format is independent of Chord's own protocol version. */
export const UNIX_TRANSPORT_FORMAT = "harness.chord/2";
const IDENTITY_BYTES = 1024;
const HANDSHAKE_MS = 5000;
export function unixSocketPath(serverId: string, directory: string): string {
	const path = join(directory, `${serverId}.sock`);
	if (Buffer.byteLength(path) <= 100) return path;
	const name = createHash("sha256").update(resolve(path)).digest("hex").slice(0, 40);
	return join("/tmp", `harness-chord-${process.getuid?.()}`, `${name}.sock`);
}

export interface UnixLinkOptions {
	readonly name?: string;
	readonly expectedName?: string;
	readonly expectedKind: "host" | "client";
	readonly maxFrameBytes?: number;
	readonly maxSendFrameBytes?: number;
	readonly maxQueueBytes?: number;
}
export interface UnixLink extends Link {
	readonly closed: boolean;
	readonly reason: string;
	readonly ready: Promise<void>;
	close(reason?: string): void;
}
function unixLimits(options: Pick<UnixLinkOptions, "maxFrameBytes" | "maxSendFrameBytes" | "maxQueueBytes">) {
	const frameLimit = options.maxFrameBytes ?? UNIX_FRAME_BYTES;
	const sendFrameLimit = options.maxSendFrameBytes ?? frameLimit;
	const queueLimit = options.maxQueueBytes ?? UNIX_QUEUE_BYTES;
	if ([frameLimit, sendFrameLimit, queueLimit].some((limit) => !Number.isSafeInteger(limit) || limit < 1 || limit > 0xffffffff)) throw new RangeError("Unix frame and queue bounds must be positive integers up to 4294967295");
	return { frameLimit, sendFrameLimit, queueLimit };
}

export function createUnixLink(socket: Socket, options: UnixLinkOptions): UnixLink {
	const { frameLimit, sendFrameLimit, queueLimit } = unixLimits(options);
	const identity = Buffer.from(`${JSON.stringify({ transport: UNIX_TRANSPORT_FORMAT, kind: options.expectedKind === "host" ? "client" : "host", name: options.name ?? "" })}\n`);
	if (identity.length > IDENTITY_BYTES + 1) throw new RangeError("Unix transport identity exceeds its byte bound");
	let closed = false, reason = "closed", greeted = false;
	let receiver: ((message: Uint8Array) => void) | undefined;
	const listeners = new Set<() => void>();
	let resolveReady: () => void = () => {}, rejectReady: (error: Error) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	void ready.catch(() => {});
	let pendingBytes = 0, earlyBytes = 0;
	const early: Uint8Array[] = [];
	const prelude = Buffer.alloc(IDENTITY_BYTES);
	let preludeBytes = 0;
	const header = Buffer.alloc(4);
	let headerBytes = 0, payloadBytes = 0;
	let payload: Buffer | undefined;
	const finish = (message: string, graceful = false): void => {
		if (closed) return;
		closed = true; reason = message;
		clearTimeout(handshake);
		early.length = 0; earlyBytes = 0; payload = undefined;
		receiver = undefined;
		socket.off("data", receiveBytes);
		if (!greeted) rejectReady(new Error(message));
		if (graceful) {
			const timer = setTimeout(() => socket.destroy(), 1000); timer.unref();
			socket.once("close", () => clearTimeout(timer));
			socket.end(() => socket.destroy());
		} else socket.destroy();
		for (const listener of listeners) { try { listener(); } catch {} }
		listeners.clear();
	};
	const handshake = setTimeout(() => finish("Unix transport identity handshake timed out"), HANDSHAKE_MS);
	handshake.unref();
	const write = (encoded: Uint8Array, charged: number): void => {
		pendingBytes += charged;
		let completed = false;
		try {
			socket.write(encoded, (error) => {
				if (completed) return;
				completed = true; pendingBytes -= charged;
				if (error) finish(error.message);
			});
		} catch { finish("Unix socket write failed"); }
	};
	const acceptIdentity = (): void => {
		let raw: unknown;
		try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(prelude.subarray(0, preludeBytes))); } catch { /* Refused below. */ }
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) { finish("Unix transport identity handshake failed: incompatible format"); return; }
		const value = raw as Record<string, unknown>;
		if (Object.keys(value).length !== 3 || value.transport !== UNIX_TRANSPORT_FORMAT || value.kind !== options.expectedKind || typeof value.name !== "string" || (options.expectedName !== undefined && value.name !== options.expectedName)) {
			finish("Unix transport identity handshake failed: incompatible format or endpoint"); return;
		}
		greeted = true; clearTimeout(handshake); resolveReady();
	};
	const deliver = (message: Uint8Array): void => {
		if (receiver) { receiver(message); return; }
		if (earlyBytes + message.byteLength > queueLimit) { finish("Unix receive queue exceeds its bound"); return; }
		early.push(message); earlyBytes += message.byteLength;
	};
	function receiveIdentity(chunk: Buffer, start: number): number {
		let offset = start;
		while (offset < chunk.length) {
			const byte = chunk[offset++];
			if (byte === 10) { acceptIdentity(); return offset; }
			if (preludeBytes === IDENTITY_BYTES) { finish("Unix transport identity exceeds its byte bound"); return offset; }
			prelude[preludeBytes++] = byte;
		}
		return offset;
	}
	function receivePayload(chunk: Buffer, start: number): number {
		let offset = start;
		if (payload === undefined) {
			const length = Math.min(4 - headerBytes, chunk.length - offset);
			chunk.copy(header, headerBytes, offset, offset + length); headerBytes += length; offset += length;
			if (headerBytes < 4) return offset;
			const size = header.readUInt32BE(); headerBytes = 0;
			if (size === 0 || size > frameLimit) { finish("Unix frame exceeds its byte bound"); return offset; }
			payload = Buffer.allocUnsafe(size); payloadBytes = 0;
		}
		const length = Math.min(payload.length - payloadBytes, chunk.length - offset);
		chunk.copy(payload, payloadBytes, offset, offset + length); payloadBytes += length; offset += length;
		if (payloadBytes === payload.length) { const message = payload; payload = undefined; deliver(message); }
		return offset;
	}
	function receiveBytes(chunk: Buffer): void {
		let offset = 0;
		while (!closed && offset < chunk.length) offset = greeted ? receivePayload(chunk, offset) : receiveIdentity(chunk, offset);
	}
	socket.on("data", receiveBytes);
	socket.on("error", (error) => finish(error.message));
	socket.on("end", () => finish(!greeted ? "Unix transport identity handshake failed: peer ended" : payload !== undefined || headerBytes > 0 ? "incomplete Unix frame" : "peer ended"));
	socket.on("close", () => finish(!greeted ? "Unix transport identity handshake failed: socket closed" : "socket closed"));
	// The separately bounded identity prelude is not a Chord message or part of its outbox.
	write(identity, 0);
	return {
		get closed() { return closed; }, get reason() { return reason; }, ready,
		send(message) {
			if (closed) return;
			if (!(message instanceof Uint8Array) || message.byteLength === 0) { finish("Unix transport requires nonempty bytes"); return; }
			const bytes = message.byteLength;
			if (bytes > sendFrameLimit) { finish("Unix frame exceeds its byte bound"); return; }
			if (pendingBytes + bytes + 4 > queueLimit) { finish("Unix write queue exceeds its byte bound"); return; }
			const encoded = Buffer.allocUnsafe(bytes + 4); encoded.writeUInt32BE(bytes); encoded.set(message, 4);
			write(encoded, encoded.length);
		},
		onMessage(handler) {
			if (closed) return;
			receiver = handler;
			for (const message of early.splice(0)) { earlyBytes -= message.byteLength; if (!closed) handler(message); }
		},
		onClose(handler) { if (closed) handler(); else listeners.add(handler); },
		close(message = "closed") { finish(message, true); },
	};
}

export async function connectUnixLink(path: string, options: UnixLinkOptions & { readonly signal?: AbortSignal }): Promise<UnixLink> {
	options.signal?.throwIfAborted(); unixLimits(options);
	const socket = createConnection({ path });
	const link = createUnixLink(socket, options);
	await new Promise<void>((resolve, reject) => {
		const abort = () => { cleanup(); link.close("connect aborted"); reject(options.signal?.reason ?? new Error("connect aborted")); };
		const error = (failure: Error) => { cleanup(); reject(failure); };
		const connected = () => { cleanup(); resolve(); };
		const cleanup = () => { socket.off("connect", connected); socket.off("error", error); options.signal?.removeEventListener("abort", abort); };
		socket.once("connect", connected); socket.once("error", error); options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const abort = () => reject(options.signal?.reason ?? new Error("connect aborted"));
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			void link.ready.then(resolve, reject).finally(() => options.signal?.removeEventListener("abort", abort));
		});
		return link;
	} catch (error) { link.close("identity handshake failed"); throw error; }
}

/** Ownership checks precede chmod. A shared or substituted parent is not adopted. */
function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const state = lstatSync(path);
	if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.()) throw new Error("Unix socket directory is not owned by this user");
	chmodSync(path, 0o700);
}
export function listenUnixLinks(path: string, onLink: (link: UnixLink) => void, options: Pick<UnixLinkOptions, "name" | "maxFrameBytes" | "maxSendFrameBytes" | "maxQueueBytes"> = {}): { start(): Promise<void>; close(): Promise<void> } {
	unixLimits(options);
	const links = new Set<UnixLink>();
	let identity: { dev: number; ino: number } | undefined;
	let closing: Promise<void> | undefined;
	let listening = false;
	const server = createServer((socket) => {
		const link = createUnixLink(socket, { ...options, expectedKind: "client" }); links.add(link);
		link.onClose(() => links.delete(link));
		void link.ready.then(() => { if (!link.closed) onLink(link); }).catch(() => { link.close("connection refused"); });
	});
	return {
		async start() {
			if (Buffer.byteLength(path, "utf8") > 100) throw new Error("Unix socket path exceeds 100 bytes");
			privateDirectory(dirname(path));
			if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("Unix socket path already exists; its owner must remove it before listen");
			const boundPath = join(dirname(path), `.${randomUUID().replaceAll("-", "").slice(0, 20)}`);
			if (Buffer.byteLength(boundPath) > 100) throw new Error("Unix socket directory leaves no room for a private bind name");
			await new Promise<void>((resolve, reject) => {
				const failed = (error: Error) => { server.off("listening", ready); reject(error); };
				const ready = () => { server.off("error", failed); resolve(); };
				server.once("error", failed); server.once("listening", ready); server.listen(boundPath);
			});
			listening = true; chmodSync(boundPath, 0o600); linkSync(boundPath, path);
			const current = lstatSync(path); identity = { dev: current.dev, ino: current.ino }; unlinkSync(boundPath);
		},
		close() {
			closing ??= (async () => {
				for (const link of links) link.close("server closed");
				if (listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
				const current = lstatSync(path, { throwIfNoEntry: false });
				if (identity && current?.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
			})();
			return closing;
		},
	};
}
