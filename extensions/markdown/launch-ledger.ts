import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord, liveId, livePid, readLiveConfig, type LiveConfig } from "./live-protocol.ts";

export interface LiveLaunch {
	launchId: string;
	origin: "agent" | "operator";
	status: "offered" | "launching";
	documentId?: string;
	revision?: number;
	pid?: number;
}
export interface SuspendedLaunch {
	launch: LiveLaunch;
	expiresAt: number;
}
interface LaunchFile {
	path: string;
	dev: bigint;
	ino: bigint;
	birthtimeNs: bigint;
}
interface Reservation extends SuspendedLaunch {
	file?: LaunchFile;
	timer: NodeJS.Timeout;
}

const active = new Set<LaunchLedger>();
function closeAtExit(): void {
	for (const ledger of active) ledger.close();
}
function key(value: unknown): string {
	if (!liveId(value)) throw new Error("Invalid live Markdown launch ID.");
	return value.toLowerCase();
}
function processId(pid: unknown): number {
	if (!livePid(pid)) throw new Error("Invalid reader process ID.");
	return pid;
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
function retireFile(file: LaunchFile): "removed" | "absent" | "inaccessible" {
	try {
		const stat = lstatSync(file.path, { bigint: true });
		if (stat.dev !== file.dev || stat.ino !== file.ino || stat.birthtimeNs !== file.birthtimeNs) return "absent";
		unlinkSync(file.path);
		return "removed";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "inaccessible";
	}
}
function readOffer(body: unknown): LiveLaunch {
	if (!isRecord(body) || (body.origin !== "agent" && body.origin !== "operator"))
		throw new Error("Invalid live Markdown launch origin.");
	const launchId = key(body.launchId);
	const { documentId, revision } = body;
	if (documentId !== undefined && (typeof documentId !== "string" || !/^md-[a-f0-9]{20}$/u.test(documentId)))
		throw new Error("Invalid launch document ID.");
	if (
		revision !== undefined &&
		(!documentId || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
	)
		throw new Error("Invalid launch revision.");
	return {
		launchId,
		origin: body.origin,
		status: "offered",
		...(documentId ? { documentId } : {}),
		...(revision ? { revision } : {}),
	};
}
/** The route that authenticates the launch owns its file, including when the caller runs in another host. */
export class LaunchLedger {
	private readonly entries = new Map<string, Reservation>();
	private closed = false;
	private readonly lifetimeMs: number;
	constructor(lifetimeMs = 120_000) {
		this.lifetimeMs = lifetimeMs;
	}

	reserve(body: unknown, config: LiveConfig): { ok: true; path: string } {
		if (this.closed) throw new Error("The live Markdown host closed.");
		const launch = readOffer(body);
		const { launchId } = launch;
		this.prune();
		if (launch.origin === "agent" && [...this.entries.values()].some((x) => x.launch.origin === "agent"))
			throw new Error("This conversation already has a pending agent reader launch.");
		if (this.entries.size >= 16 || this.entries.has(launchId))
			throw new Error("Reader launch reservation unavailable.");
		const data = JSON.stringify({ ...readLiveConfig(config), launchId });
		const directory = join(getAgentDir(), "markdown-live");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const dir = lstatSync(directory);
		if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0)
			throw new Error("The reader launch directory is not private.");
		const path = join(directory, `${randomUUID()}.json`);
		const fd = openSync(path, "wx", 0o600);
		const { dev, ino, birthtimeNs } = fstatSync(fd, { bigint: true });
		const file = { path, dev, ino, birthtimeNs };
		try {
			writeFileSync(fd, data);
		} catch (error) {
			retireFile(file);
			throw error;
		} finally {
			closeSync(fd);
		}
		this.track({ launch, expiresAt: Date.now() + this.lifetimeMs }, file);
		return { ok: true, path };
	}
	private track(snapshot: SuspendedLaunch, file?: LaunchFile): void {
		const { launch, expiresAt } = snapshot;
		const timer = setTimeout(() => this.release(launch.launchId), Math.max(0, expiresAt - Date.now())).unref();
		if (!active.size) process.once("exit", closeAtExit);
		active.add(this);
		this.entries.set(launch.launchId, { launch: { ...launch }, file, timer, expiresAt });
	}

	private release(id: string): ReturnType<typeof retireFile> {
		const entry = this.entries.get(id);
		if (!entry) return "absent";
		const retired = entry.file ? retireFile(entry.file) : "absent";
		clearTimeout(entry.timer);
		this.entries.delete(id);
		if (!this.entries.size) active.delete(this);
		if (!active.size) process.off("exit", closeAtExit);
		return retired;
	}
	private prune(): void {
		for (const [id, entry] of this.entries) {
			if (Date.now() >= entry.expiresAt || (entry.launch.pid && !alive(entry.launch.pid))) this.release(id);
		}
	}
	private processLaunch(id: unknown, pid: unknown): Reservation {
		const launchId = key(id);
		const reader = processId(pid);
		this.prune();
		const entry = this.entries.get(launchId);
		if (!entry || (entry.launch.pid !== undefined && entry.launch.pid !== reader) || !alive(reader))
			throw new Error("The launch reservation is unavailable for this process. Reopen from the original conversation.");
		return entry;
	}
	starting(body: unknown): { ok: true } {
		if (!isRecord(body)) throw new Error("Invalid reader startup message.");
		const entry = this.processLaunch(body.launchId, body.pid);
		if (entry.launch.status === "offered") {
			clearTimeout(entry.timer);
			const launch: LiveLaunch = { ...entry.launch, status: "launching", pid: processId(body.pid) };
			this.track({ launch, expiresAt: Date.now() + this.lifetimeMs }, entry.file);
		}
		return { ok: true };
	}
	consume(id: unknown, pid: unknown): LiveLaunch["origin"] {
		const entry = this.processLaunch(id, pid);
		this.release(entry.launch.launchId);
		return entry.launch.origin;
	}
	cancel(body: unknown): { ok: true } {
		if (!isRecord(body)) throw new Error("Invalid reader cancellation.");
		this.release(key(body.launchId));
		return { ok: true };
	}
	pendingLaunches(): LiveLaunch[] {
		this.prune();
		return [...this.entries.values()].map(({ launch }) => ({ ...launch }));
	}
	/** Unclaimed commands expire at reload. Preserve readers already past file consumption without carrying callbacks. */
	suspend(): SuspendedLaunch[] {
		this.closed = true;
		this.prune();
		const snapshots: SuspendedLaunch[] = [];
		for (const [id, entry] of this.entries) {
			const file = this.release(id);
			if (file === "absent" || entry.launch.status === "launching")
				snapshots.push({ launch: { ...entry.launch }, expiresAt: entry.expiresAt });
		}
		return snapshots;
	}
	resume(snapshots: SuspendedLaunch[]): void {
		if (this.closed || this.entries.size) throw new Error("Cannot restore launches into an active ledger.");
		for (const snapshot of snapshots) {
			if (snapshot.expiresAt > Date.now() && (!snapshot.launch.pid || alive(snapshot.launch.pid))) this.track(snapshot);
		}
	}
	close(): void {
		this.closed = true;
		for (const id of this.entries.keys()) this.release(id);
	}
}
