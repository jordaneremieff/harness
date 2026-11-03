/** Catalog invalidation after publication, without a scheduler, model, or filesystem polling. */
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, mkdtempSync, lstatSync, openSync, readSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer, type Socket } from "node:net";

const FORMAT = "pi.agent.catalog-observer/1";
const NOTICE_FORMAT = "pi.agent.catalog-changed/1";
const NOTICE_BYTES = 4096;
export const MAX_CHANGED_STORAGE_IDS = 64;
/** Undefined means the whole namespace is dirty, including unknown or overflowing notices. */
export type CatalogChange = readonly string[] | undefined;

export function catalogChange(value: unknown): CatalogChange {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHANGED_STORAGE_IDS || value.some((id) => typeof id !== "string" || !UUID.test(id))) return undefined;
	return [...new Set(value as string[])];
}
function noticeChange(text: string): CatalogChange {
	try {
		const value = JSON.parse(text);
		return value?.format === NOTICE_FORMAT ? catalogChange(value.storageIds) : undefined;
	} catch { return undefined; }
}
const RECORD_BYTES = 1024;
const VISITS = 256;
const RECIPIENTS = 32;
const DEADLINE_MS = 1000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
interface Observer { format: string; id: string; hostname: string; pid: number; socketPath: string }
const directory = (root: string): string => join(root, ".observers");
interface ObserverFile { observer: Observer; dev: number; ino: number }
function ownerState(pid: number): "live" | "dead" | "unknown" {
	try { process.kill(pid, 0); return "live"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}
function removeDeadObserver(path: string, file: ObserverFile): boolean {
	if (ownerState(file.observer.pid) !== "dead") return false;
	const current = lstatSync(path, { throwIfNoEntry: false });
	if (!current || current.dev !== file.dev || current.ino !== file.ino) return false;
	unlinkSync(path);
	return true;
}

/** Read only a bounded regular file, never a symlink or another process's namespace. */
function readObserver(path: string): ObserverFile | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > RECORD_BYTES) return undefined;
		const bytes = Buffer.alloc(RECORD_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, length);
			if (count === 0) break;
			length += count;
		}
		if (length > RECORD_BYTES) return undefined;
		const value = JSON.parse(bytes.toString("utf8", 0, length)) as Partial<Observer> | null;
		if (!value || value.format !== FORMAT || typeof value.id !== "string" || !UUID.test(value.id) || value.hostname !== hostname() || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.socketPath !== "string" || !value.socketPath.startsWith("/") || Buffer.byteLength(value.socketPath) > 100) return undefined;
		return { observer: value as Observer, dev: stat.dev, ino: stat.ino };
	} catch { return undefined; }
	finally { if (fd !== undefined) closeSync(fd); }
}

/** Bind before advertising, so an immediate external publication has a receiver. */
export function subscribeCatalogChanges(root: string, listener: (change: CatalogChange) => void, onError: (error: Error) => void): () => void {
	const id = randomUUID();
	const dir = directory(root);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const socketDir = mkdtempSync(join(tmpdir(), "ac-"));
	const socketPath = join(socketDir, "events.sock");
	let path: string | undefined;
	const sockets = new Set<Socket>();
	let closed = false;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.setTimeout(DEADLINE_MS, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		socket.on("close", () => sockets.delete(socket));
		let text = "";
		socket.on("data", (bytes: Buffer) => {
			if (Buffer.byteLength(text) + bytes.length > NOTICE_BYTES) { if (!closed) listener(undefined); socket.destroy(); return; }
			text += bytes.toString("utf8");
		});
		socket.on("end", () => { if (!closed) listener(noticeChange(text)); });
	});
	const close = (): void => {
		if (closed) return;
		closed = true;
		if (path) {
			const file = readObserver(path);
			const current = lstatSync(path, { throwIfNoEntry: false });
			if (file?.observer.id === id && file.observer.pid === process.pid && current?.dev === file.dev && current.ino === file.ino) unlinkSync(path);
		}
		for (const socket of sockets) socket.destroy();
		server.close();
		rmSync(socketDir, { recursive: true, force: true });
	};
	server.on("error", (error) => { close(); onError(error); });
	try {
		if (Buffer.byteLength(socketPath) > 100) throw new Error("Catalog notification socket exceeds the Unix path bound");
		server.listen(socketPath);
		server.unref();
		chmodSync(socketPath, 0o600);
		const record = JSON.stringify({ format: FORMAT, id, hostname: hostname(), pid: process.pid, socketPath } satisfies Observer);
		for (let slot = 0; slot < RECIPIENTS; slot++) {
			const candidate = join(dir, `${slot}.json`);
			const previous = readObserver(candidate);
			if (previous) removeDeadObserver(candidate, previous);
			try { writeFileSync(candidate, record, { flag: "wx", mode: 0o600 }); path = candidate; break; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		}
		if (!path) throw new Error("Catalog observation capacity is occupied; close unused Pi windows before retrying");
	} catch (error) { close(); throw error; }
	return close;
}

function send(socketPath: string, notice: string): Promise<void> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const finish = (): void => { socket.destroy(); resolve(); };
		socket.setTimeout(DEADLINE_MS, finish);
		socket.on("error", finish);
		socket.on("close", () => resolve());
		socket.on("connect", () => socket.end(notice));
	});
}

/** A publication never waits for observation and never changes a conversation payload. */
async function broadcast(root: string, change: CatalogChange): Promise<void> {
	let handle: Awaited<ReturnType<typeof opendir>>;
	try { handle = await opendir(directory(root)); } catch { return; }
	const recipients: string[] = [];
	let visited = 0;
	for await (const entry of handle) {
		visited += 1;
		if (entry.isFile() && /^\d+\.json$/u.test(entry.name) && Number(entry.name.slice(0, -5)) < RECIPIENTS) {
			const path = join(directory(root), entry.name);
			const file = readObserver(path);
			if (file && ownerState(file.observer.pid) === "live") recipients.push(file.observer.socketPath);
		}
		if (visited >= VISITS || recipients.length >= RECIPIENTS) break;
	}
	const notice = `${JSON.stringify({ format: NOTICE_FORMAT, ...(change ? { storageIds: change } : {}) })}\n`;
	await Promise.all(recipients.map((recipient) => send(recipient, notice)));
}

const publishing = new Map<string, { again: boolean; change: CatalogChange }>();
/** Coalesce overlapping publications without dropping identities from concurrent writers. */
export function publishCatalogChange(root: string, storageId?: string): void {
	const change = catalogChange(storageId === undefined ? undefined : [storageId]);
	const pending = publishing.get(root);
	if (pending) {
		if (!pending.again) pending.change = change;
		else if (!pending.change || !change) pending.change = undefined;
		else pending.change = catalogChange([...pending.change, ...change]);
		pending.again = true;
		return;
	}
	const state = { again: false, change };
	publishing.set(root, state);
	void (async () => {
		try {
			do {
				const batch = state.change;
				state.again = false;
				await broadcast(root, batch);
			} while (state.again);
		} finally { publishing.delete(root); }
	})().catch(() => undefined);
}
