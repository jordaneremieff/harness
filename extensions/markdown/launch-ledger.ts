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
export type LaunchFailureReason =
	| "offer-expired"
	| "startup-expired"
	| "process-ended"
	| "boot-failed"
	| "reload-revoked";
export interface LaunchFailure extends Omit<LiveLaunch, "status"> {
	status: "failed";
	reason: LaunchFailureReason;
	message: string;
	finishedAt: number;
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
	private readonly failures = new Map<string, LaunchFailure>();
	private closed = false;
	private readonly offerLifetimeMs: number;
	private readonly startupLifetimeMs: number;
	constructor(offerLifetimeMs = 300_000, startupLifetimeMs = 120_000) {
		this.offerLifetimeMs = offerLifetimeMs;
		this.startupLifetimeMs = startupLifetimeMs;
	}

	reserve(body: unknown, config: LiveConfig): { ok: true; path: string; expiresAt: number } {
		if (this.closed) throw new Error("The live Markdown host closed.");
		const launch = readOffer(body);
		const { launchId } = launch;
		this.prune();
		if (launch.origin === "agent" && [...this.entries.values()].some((x) => x.launch.origin === "agent"))
			throw new Error("This conversation already has a pending agent reader launch.");
		if (this.entries.size >= 16 || this.entries.has(launchId) || this.failures.has(launchId))
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
		const expiresAt = Date.now() + this.offerLifetimeMs;
		this.track({ launch, expiresAt }, file);
		return { ok: true, path, expiresAt };
	}
	private track(snapshot: SuspendedLaunch, file?: LaunchFile): void {
		const { launch, expiresAt } = snapshot;
		const timer = setTimeout(() => this.prune(), Math.max(0, expiresAt - Date.now())).unref();
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
	private reject(entry: Reservation, reason: LaunchFailureReason, message: string): void {
		const { launch } = entry;
		this.release(launch.launchId);
		this.record({ ...launch, status: "failed", reason, message, finishedAt: Date.now() });
	}
	private record(failure: LaunchFailure): void {
		this.failures.set(failure.launchId, failure);
		const oldest = this.failures.keys().next().value;
		if (this.failures.size > 16 && oldest) this.failures.delete(oldest);
	}
	private prune(): void {
		for (const entry of this.entries.values()) {
			if (entry.launch.pid && !alive(entry.launch.pid))
				this.reject(
					entry,
					"process-ended",
					"The reader process ended before it confirmed its first view. Check the Rex pane for its exit status and output.",
				);
			else if (Date.now() >= entry.expiresAt) {
				if (entry.launch.status === "offered")
					this.reject(
						entry,
						"offer-expired",
						"The offer expired before a reader reported startup. The old command is no longer valid.",
					);
				else
					this.reject(
						entry,
						"startup-expired",
						"The reader did not confirm its first view before the startup deadline.",
					);
			}
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
	starting(body: unknown): { ok: true; expiresAt: number } {
		if (!isRecord(body)) throw new Error("Invalid reader startup message.");
		const entry = this.processLaunch(body.launchId, body.pid);
		if (entry.launch.status === "launching") return { ok: true, expiresAt: entry.expiresAt };
		clearTimeout(entry.timer);
		const launch: LiveLaunch = { ...entry.launch, status: "launching", pid: processId(body.pid) };
		const expiresAt = Date.now() + this.startupLifetimeMs;
		this.track({ launch, expiresAt }, entry.file);
		return { ok: true, expiresAt };
	}
	private startedEntry(id: unknown, pid: unknown): Reservation {
		const entry = this.processLaunch(id, pid);
		if (entry.launch.status !== "launching") throw new Error("The reader did not report startup.");
		return entry;
	}
	started(id: unknown, pid: unknown): LiveLaunch {
		return this.startedEntry(id, pid).launch;
	}
	consume(id: unknown, pid: unknown): void {
		this.release(this.started(id, pid).launchId);
	}
	failed(body: Record<string, unknown>): { ok: true } {
		const launchId = key(body.launchId);
		const prior = this.failures.get(launchId);
		if (prior?.pid === body.pid && prior?.reason === "boot-failed") return { ok: true };
		const entry = this.startedEntry(launchId, body.pid);
		const detail =
			typeof body.message === "string" ? body.message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim() : "";
		this.reject(
			entry,
			"boot-failed",
			[...detail].slice(0, 400).join("") || "The reader failed before it confirmed its first view.",
		);
		return { ok: true };
	}
	failedLaunches(): LaunchFailure[] {
		this.prune();
		return [...this.failures.values()].map((row) => ({ ...row }));
	}
	cancel(body: unknown): { ok: true } {
		if (!isRecord(body)) throw new Error("Invalid reader cancellation.");
		const id = key(body.launchId);
		if (this.entries.get(id)?.launch.status === "offered") this.release(id);
		return { ok: true };
	}
	pendingLaunches(): (LiveLaunch & { expiresAt: number })[] {
		this.prune();
		return [...this.entries.values()].map(({ launch, expiresAt }) => ({ ...launch, expiresAt }));
	}
	/** Unclaimed commands expire at reload. Preserve readers already past file consumption without carrying callbacks. */
	suspend(): SuspendedLaunch[] {
		this.closed = true;
		this.prune();
		const snapshots: SuspendedLaunch[] = [];
		for (const [id, entry] of this.entries) {
			const file = this.release(id);
			if (entry.launch.status === "launching" || file === "absent")
				snapshots.push({ launch: { ...entry.launch }, expiresAt: entry.expiresAt });
			else
				this.record({
					...entry.launch,
					status: "failed",
					reason: "reload-revoked",
					message: "Pi reload revoked the unused offer. The old command is no longer valid.",
					finishedAt: Date.now(),
				});
		}
		return snapshots;
	}
	resume(snapshots: SuspendedLaunch[], failures: LaunchFailure[]): void {
		if (this.closed || this.entries.size) throw new Error("Cannot restore launches into an active ledger.");
		for (const failure of failures) this.record(failure);
		for (const snapshot of snapshots) this.track(snapshot);
		this.prune();
	}
	close(): void {
		this.closed = true;
		for (const id of this.entries.keys()) this.release(id);
	}
}
