/** Private-directory Unix transport for the public Chord Link contract. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Frame, Link } from "@earendil-works/chord";

/** Default UTF-8 JSON frame bound, excluding the LF delimiter. */
export const UNIX_FRAME_BYTES = 16 * 1024 * 1024;
/** Encoded queued bytes, including delimiters; stalled readers have a finite outbox. */
export const UNIX_QUEUE_BYTES = 64 * 1024 * 1024;
export function unixSocketPath(serverId: string, directory: string): string {
	const path = join(directory, `${serverId}.sock`);
	if (Buffer.byteLength(path) <= 100) return path;
	// macOS limits Unix addresses. Hash the complete endpoint path to preserve directory isolation.
	const name = createHash("sha256").update(resolve(path)).digest("hex").slice(0, 40);
	return join("/tmp", `harness-chord-${process.getuid?.()}`, `${name}.sock`);
}

export interface UnixLinkOptions {
	readonly expectedName?: string;
	readonly expectedKind: "host" | "client";
	readonly maxFrameBytes?: number;
	readonly maxQueueBytes?: number;
}

function isFrameObject(raw: unknown): raw is Frame {
	return raw !== null && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as { t?: unknown }).t === "string";
}
function matchingHello(frame: Frame, options: UnixLinkOptions): boolean {
	return frame.t === "hello" && frame.kind === options.expectedKind && typeof frame.name === "string" && Number.isSafeInteger(frame.epoch) && frame.epoch >= 0 && (options.expectedName === undefined || frame.name === options.expectedName);
}

function unixLimits(options: Pick<UnixLinkOptions, "maxFrameBytes" | "maxQueueBytes">): { frameLimit: number; queueLimit: number } {
	const frameLimit = options.maxFrameBytes ?? UNIX_FRAME_BYTES;
	const queueLimit = options.maxQueueBytes ?? UNIX_QUEUE_BYTES;
	if (!Number.isSafeInteger(frameLimit) || frameLimit < 1 || !Number.isSafeInteger(queueLimit) || queueLimit < 1) throw new RangeError("Unix frame and queue bounds must be positive safe integers");
	return { frameLimit, queueLimit };
}

export function createUnixLink(socket: Socket, options: UnixLinkOptions): Link {
	const { frameLimit, queueLimit } = unixLimits(options);
	let closed = false;
	let reason = "closed";
	let greeted = false;
	let receiver: ((frame: Frame) => void) | undefined;
	const listeners = new Set<(reason: string) => void>();
	const early: { frame: Frame; bytes: number }[] = [];
	let earlyBytes = 0;
	let input = Buffer.alloc(0);
	let inputBytes = 0;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const finish = (message: string, graceful = false): void => {
		if (closed) return;
		closed = true;
		reason = message;
		input = Buffer.alloc(0);
		inputBytes = 0;
		early.length = 0;
		earlyBytes = 0;
		socket.off("data", receiveBytes);
		if (graceful) {
			const timer = setTimeout(() => socket.destroy(), 1000);
			timer.unref();
			socket.once("close", () => clearTimeout(timer));
			socket.end(() => socket.destroy());
		} else socket.destroy();
		for (const listener of listeners) { try { listener(message); } catch { /* Each close listener owns its errors. */ } }
		listeners.clear();
	};
	const deliver = (bytes: Buffer): void => {
		let raw: unknown;
		try { raw = JSON.parse(decoder.decode(bytes)); }
		catch { finish("invalid Unix JSON frame"); return; }
		if (!isFrameObject(raw)) { finish("invalid Unix Chord frame"); return; }
		const frame = raw as Frame;
		if (!greeted && !matchingHello(frame, options)) { finish("Unix Chord identity handshake failed"); return; }
		greeted = true;
		if (frame.t === "bye") { finish(frame.reason ?? "peer closed"); return; }
		if (receiver) { receiver(frame); return; }
		if (earlyBytes + bytes.length > queueLimit) { finish("Unix receive queue exceeds its bound"); return; }
		early.push({ frame, bytes: bytes.length });
		earlyBytes += bytes.length;
	};
	function receiveBytes(chunk: Buffer): void {
		let offset = 0;
		while (!closed && offset < chunk.length) {
			const end = chunk.indexOf(10, offset);
			const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
			const size = inputBytes + part.length;
			if (size > frameLimit) { finish("Unix frame exceeds its byte bound"); return; }
			if (size > input.length) {
				const next = Buffer.allocUnsafe(Math.min(frameLimit, Math.max(size, 4096, input.length * 2)));
				input.copy(next, 0, 0, inputBytes);
				input = next;
			}
			part.copy(input, inputBytes);
			inputBytes = size;
			if (end < 0) return;
			const complete = input.subarray(0, inputBytes);
			inputBytes = 0;
			deliver(complete);
			offset = end + 1;
		}
	}
	socket.on("data", receiveBytes);
	socket.on("error", (error) => finish(error.message));
	socket.on("end", () => finish(inputBytes > 0 ? "incomplete Unix frame" : "peer ended"));
	socket.on("close", () => finish("socket closed"));
	return {
		get closed() { return closed; },
		send(frame) {
			if (closed) return;
			try {
				const encoded = JSON.stringify(frame);
				const bytes = Buffer.byteLength(encoded, "utf8");
				if (bytes > frameLimit) { finish("Unix frame exceeds its byte bound"); return; }
				if (socket.writableLength + bytes + 1 > queueLimit) { finish("Unix write queue exceeds its byte bound"); return; }
				socket.write(`${encoded}\n`);
			} catch { finish("Unix frame serialization failed"); }
		},
		receive(handler) {
			receiver = handler;
			for (const item of early.splice(0)) { earlyBytes -= item.bytes; if (!closed) handler(item.frame); }
		},
		onClose(handler) { if (closed) handler(reason); else listeners.add(handler); },
		close(message = "closed") {
			if (closed) return;
			const bye = `${JSON.stringify({ t: "bye", reason: message })}\n`;
			const bytes = Buffer.byteLength(bye);
			if (bytes - 1 > frameLimit || socket.writableLength + bytes > queueLimit) { finish(message); return; }
			try { socket.write(bye); finish(message, true); } catch { finish(message); }
		},
	};
}

export async function connectUnixLink(path: string, options: UnixLinkOptions & { readonly signal?: AbortSignal }): Promise<Link> {
	options.signal?.throwIfAborted();
	unixLimits(options);
	const socket = createConnection({ path });
	const link = createUnixLink(socket, options);
	await new Promise<void>((resolve, reject) => {
		const abort = () => { cleanup(); link.close("connect aborted"); reject(options.signal?.reason ?? new Error("connect aborted")); };
		const error = (failure: Error) => { cleanup(); reject(failure); };
		const connected = () => { cleanup(); resolve(); };
		const cleanup = () => { socket.off("connect", connected); socket.off("error", error); options.signal?.removeEventListener("abort", abort); };
		socket.once("connect", connected);
		socket.once("error", error);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) { cleanup(); abort(); }
	});
	return link;
}

/** Ownership checks precede chmod. A shared or substituted parent is not adopted. */
function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const state = lstatSync(path);
	if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.()) throw new Error("Unix socket directory is not owned by this user");
	chmodSync(path, 0o700);
}

export function listenUnixLinks(path: string, onLink: (link: Link) => void, options: Pick<UnixLinkOptions, "maxFrameBytes" | "maxQueueBytes"> = {}): { start(): Promise<void>; close(): Promise<void> } {
	unixLimits(options);
	const links = new Set<Link>();
	let identity: { dev: number; ino: number } | undefined;
	let closing: Promise<void> | undefined;
	let listening = false;
	const server = createServer((socket) => {
		const link = createUnixLink(socket, { ...options, expectedKind: "client" });
		links.add(link);
		link.onClose(() => links.delete(link));
		try { onLink(link); } catch { link.close("connection refused"); }
	});
	return {
		async start() {
			if (Buffer.byteLength(path, "utf8") > 100) throw new Error("Unix socket path exceeds 100 bytes");
			privateDirectory(dirname(path));
			const prior = lstatSync(path, { throwIfNoEntry: false });
			if (prior) throw new Error("Unix socket path already exists; its owner must remove it before listen");
			// Node unlinks its bind pathname on close. Publish a separate no-replace hard link
			// so that shutdown never unlinks a replacement at the public address.
			const boundPath = join(dirname(path), `.${randomUUID().replaceAll("-", "").slice(0, 20)}`);
			if (Buffer.byteLength(boundPath) > 100) throw new Error("Unix socket directory leaves no room for a private bind name");
			await new Promise<void>((resolve, reject) => {
				const failed = (error: Error) => { server.off("listening", ready); reject(error); };
				const ready = () => { server.off("error", failed); resolve(); };
				server.once("error", failed);
				server.once("listening", ready);
				server.listen(boundPath);
			});
			listening = true;
			chmodSync(boundPath, 0o600);
			linkSync(boundPath, path);
			const current = lstatSync(path);
			identity = { dev: current.dev, ino: current.ino };
			unlinkSync(boundPath);
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
