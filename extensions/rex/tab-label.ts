import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RexSettings } from "./settings.ts";
import { CliTransport, type CliResult, type RexTransport } from "./transport.ts";

const MAX_RECORD_BYTES = 16384;
const MAX_STORE_RECORDS = 256;
const SHUTDOWN_DRAIN_MS = 2000;
// `open(2)` on macOS takes a flock-style exclusive lock atomically with O_EXLOCK.
// Node's fs.constants does not expose the flag.
const O_EXLOCK = 0x20;
// About two seconds of bounded acquisition.
const LOCK_ATTEMPTS = 20;
const LOCK_RETRY_MS = 100;

type Settings = Pick<RexSettings, "executable" | "maxOutputBytes" | "maxWaitMs">;

interface ResourceKey {
	hostId: string;
	instanceId: string;
	sessionId: string;
	windowId: string;
	blockId: string;
}

interface Attachment extends ResourceKey {
	currentLabel: string;
}

interface StoredRecord extends ResourceKey {
	version: 1;
	label?: string;
	pending?: string;
	attempt?: string;
	updatedAt: string;
}

interface Claim extends StoredRecord {
	pending: string;
	attempt: string;
}

interface Run {
	generation: number;
	ctx: ExtensionContext;
	controller: AbortController;
	transport: RexTransport;
}

interface RefreshDemand {
	inputRevision: number;
	nameRevision: number;
	desiredLabel: string;
}

interface RefreshCoverage {
	inputRevision: number;
	nameRevision: number;
}

interface RecordStep {
	read(): Promise<StoredRecord | undefined>;
	write(record: StoredRecord): Promise<void>;
	remove(): Promise<void>;
}

type StepOutcome<T> = { done: true; value: T } | { done: false };

export interface TabLabelProjector {
	start(ctx: ExtensionContext): void;
	refresh(ctx: ExtensionContext): void;
	input(ctx: ExtensionContext): void;
	idle(): Promise<void>;
	shutdown(): Promise<void>;
}

export interface TabLabelProjectorOptions {
	agentDir: string;
	settings: Settings;
	getSessionName: () => string | undefined;
	env?: NodeJS.ProcessEnv;
	pid?: number;
	maxRecords?: number;
	now?: () => Date;
	createTransport?: () => RexTransport;
}

export function sanitizeTabLabel(value: string): string {
	const clean = value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "").replace(/\s+/gu, " ").trim();
	return Array.from(clean).slice(0, 128).join("").trim();
}

export function createTabLabelProjector(options: TabLabelProjectorOptions): TabLabelProjector {
	return new Projector(options);
}

class Projector implements TabLabelProjector {
	private readonly env: NodeJS.ProcessEnv;
	private readonly pid: number;
	private readonly maxRecords: number;
	private readonly now: () => Date;
	private readonly createTransport: () => RexTransport;
	private readonly directory: string;
	private active = false;
	private generation = 0;
	private ctx: ExtensionContext | undefined;
	private controller: AbortController | undefined;
	private transport: RexTransport | undefined;
	private running: Promise<void> | undefined;
	private dirty = false;
	private readonly demand: RefreshDemand = { inputRevision: 0, nameRevision: 0, desiredLabel: "" };
	private warned = false;
	private readonly options: TabLabelProjectorOptions;

	constructor(options: TabLabelProjectorOptions) {
		this.options = options;
		this.env = options.env ?? process.env;
		this.pid = options.pid ?? process.pid;
		this.maxRecords = options.maxRecords ?? MAX_STORE_RECORDS;
		this.now = options.now ?? (() => new Date());
		this.createTransport = options.createTransport ?? (() => new CliTransport(options.settings.executable, this.env));
		this.directory = join(options.agentDir, "rex", "tab-labels");
	}

	start(ctx: ExtensionContext): void {
		this.invalidate();
		this.active = true;
		this.ctx = ctx;
		this.controller = new AbortController();
		this.transport = this.createTransport();
		this.demand.desiredLabel = this.label(ctx);
		this.demand.inputRevision++;
		this.dirty = true;
		this.pump();
	}

	refresh(ctx: ExtensionContext): void {
		if (!this.active) return;
		this.ctx = ctx;
		const label = this.label(ctx);
		if (label === this.demand.desiredLabel) return;
		this.demand.desiredLabel = label;
		this.demand.nameRevision++;
		this.dirty = true;
		this.pump();
	}

	input(ctx: ExtensionContext): void {
		if (!this.active) return;
		this.ctx = ctx;
		this.demand.inputRevision++;
		this.dirty = true;
		this.pump();
	}

	async idle(): Promise<void> {
		await this.running;
	}

	async shutdown(): Promise<void> {
		this.active = false;
		this.ctx = undefined;
		this.dirty = false;
		this.invalidate();
		const running = this.running;
		if (!running) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				running,
				new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS); }),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private invalidate(): void {
		this.generation++;
		this.controller?.abort();
		this.transport?.dispose();
		this.controller = undefined;
		this.transport = undefined;
	}

	private pump(): void {
		if (!this.active || !this.dirty || this.running) return;
		let promise!: Promise<void>;
		promise = Promise.resolve().then(() => this.runLoop(promise));
		this.running = promise;
	}

	private async runLoop(promise: Promise<void>): Promise<void> {
		try {
			while (this.active && this.dirty) await this.runPass();
		} finally {
			if (this.running === promise) this.running = undefined;
			if (this.active && this.dirty) this.pump();
		}
	}

	private async runPass(): Promise<void> {
		this.dirty = false;
		const ctx = this.ctx;
		const controller = this.controller;
		const transport = this.transport;
		if (!ctx || !controller || !transport) return;
		const run = { generation: this.generation, ctx, controller, transport };
		try {
			const coverage = await this.update(run, this.demand.inputRevision);
			if (coverage && this.current(run) && this.coversDemand(coverage)) this.dirty = false;
		} catch (error) {
			if (this.current(run)) this.warn(ctx, error);
		}
	}

	private coversDemand(coverage: RefreshCoverage): boolean {
		return this.demand.inputRevision <= coverage.inputRevision && this.demand.nameRevision <= coverage.nameRevision;
	}

	private current(run: Run): boolean {
		return this.active && this.generation === run.generation && !run.controller.signal.aborted;
	}

	/** One observation pass. A pass reports the demands it covered; an invalidated run reports none. */
	private async update(run: Run, inputRevision: number): Promise<RefreshCoverage | undefined> {
		if (run.ctx.mode !== "tui") return this.coveredDemand();
		const sessionId = this.env.REX_SESSION;
		const blockId = this.env.REX_BLOCK;
		if (!sessionId || !blockId) return this.coveredDemand();
		const identity = await this.serverIdentity(run);
		if (!this.current(run)) return undefined;
		if (!await this.foregroundMatches(run, sessionId, blockId)) return this.current(run) ? this.coveredDemand() : undefined;
		const selected = await this.containingWindow(run, sessionId, blockId);
		if (!this.current(run)) return undefined;
		if (!selected) return this.coveredDemand();
		const desired = this.label(this.ctx ?? run.ctx);
		this.demand.desiredLabel = desired;
		const coverage: RefreshCoverage = { inputRevision, nameRevision: this.demand.nameRevision };
		if (!desired) return coverage;
		await this.applyLabel(run, { ...identity, sessionId, blockId, ...selected }, desired);
		return coverage;
	}

	/** A pass that found nothing to apply covers every demand made before it ended. */
	private coveredDemand(): RefreshCoverage {
		return { inputRevision: this.demand.inputRevision, nameRevision: this.demand.nameRevision };
	}

	private async serverIdentity(run: Run): Promise<{ hostId: string; instanceId: string }> {
		const identity = object(await this.json(run, ["whoami", "--json"]));
		if (!text(identity.host_id) || !text(identity.instance_id)) throw new Error("Rex did not report its host and instance IDs.");
		return { hostId: identity.host_id, instanceId: identity.instance_id };
	}

	private async foregroundMatches(run: Run, sessionId: string, blockId: string): Promise<boolean> {
		const processes = object(await this.api(run, "com.superlogical.terminal.process", { session_id: sessionId, block_id: blockId, args: {} }));
		const foreground = processes.foreground === null || processes.foreground === undefined ? undefined : object(processes.foreground);
		return foreground?.pid === this.pid;
	}

	private async containingWindow(run: Run, sessionId: string, blockId: string): Promise<{ windowId: string; currentLabel: string } | undefined> {
		const view = object(await this.api(run, "session.view", { session_id: sessionId }));
		return locateWindow(view, blockId);
	}

	private async applyLabel(run: Run, attachment: Attachment, desired: string): Promise<void> {
		const { currentLabel, ...key } = attachment;
		const defaultLabel = `Window ${key.windowId.slice(-8)}`;
		const attempt = randomUUID();
		let claimAttempted = false;
		let claim: Claim | undefined;
		try {
			const outcome = await this.withRecordStep(key, run, async (step) => {
				const record = await step.read();
				const managed = record && (currentLabel === record.label || currentLabel === record.pending);
				if (currentLabel !== defaultLabel && !managed) {
					await step.remove();
					return undefined;
				}
				if (currentLabel === desired) {
					if (record && (record.pending !== undefined || record.label !== desired)) {
						await step.write({ ...key, version: 1, label: desired, updatedAt: this.now().toISOString() });
					}
					return undefined;
				}
				const next: Claim = {
					...key,
					version: 1,
					...(managed ? { label: currentLabel } : {}),
					pending: desired,
					attempt,
					updatedAt: this.now().toISOString(),
				};
				claimAttempted = true;
				await step.write(next);
				return next;
			});
			if (!outcome.done) return;
			claim = outcome.value;
		} catch (error) {
			// A failed step can still leave the renamed claim behind. Withdraw it, and keep
			// the step failure as the diagnostic.
			if (claimAttempted) await this.withdrawClaim(key, attempt).catch(() => {});
			throw error;
		}
		if (!claim) return;
		await this.writeLabel(run, key, claim, desired);
	}

	private async writeLabel(run: Run, key: ResourceKey, claim: Claim, desired: string): Promise<void> {
		if (!this.current(run)) {
			await this.withdrawClaim(key, claim.attempt);
			return;
		}
		try {
			await this.api(run, "session.set_window_label", { session_id: key.sessionId, window_id: key.windowId, label: desired });
		} catch (error) {
			if (!(error instanceof CliCallError) || error.started) throw error;
			let withdrawal: unknown;
			try {
				await this.withdrawClaim(key, claim.attempt);
			} catch (withdrawalError) {
				withdrawal = withdrawalError;
			}
			if (this.current(run)) throw withdrawal ?? error;
			return;
		}
		if (!this.current(run)) return;
		await this.confirmLabel(run, key, claim.attempt, desired);
	}

	// Confirms one successful write only while the record still carries its attempt.
	private async confirmLabel(run: Run, key: ResourceKey, attempt: string, desired: string): Promise<void> {
		await this.withRecordStep(key, run, async (step) => {
			const record = await step.read();
			if (record?.attempt !== attempt) return;
			await step.write({ ...key, version: 1, label: desired, updatedAt: this.now().toISOString() });
		});
	}

	// Withdraws one attempt only. A record with a different attempt, or no record, belongs to newer state.
	private async withdrawClaim(key: ResourceKey, attempt: string): Promise<void> {
		await this.withRecordStep(key, undefined, async (step) => {
			const record = await step.read();
			if (record?.attempt !== attempt) return;
			if (record.label === undefined) {
				await step.remove();
				return;
			}
			await step.write({ ...key, version: 1, label: record.label, updatedAt: this.now().toISOString() });
		});
	}

	/**
	 * Runs one decision and its local file mutations for one record under that record's
	 * kernel-held lock. Another instance, in this process or another, cannot change the
	 * record between the decision's read and its write. A step never holds the lock across
	 * a Rex call and never acquires a second record's lock.
	 */
	private async withRecordStep<T>(key: ResourceKey, run: Run | undefined, decide: (step: RecordStep) => Promise<T>): Promise<StepOutcome<T>> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const recordPath = this.path(key);
		const lock = await RecordLock.acquire(recordPath, LOCK_ATTEMPTS);
		if (!lock) throw new Error("Rex tab label record lock is held by another update.");
		let wrote = false;
		let outcome: StepOutcome<T>;
		try {
			const guard = (): void => {
				if (run && !this.current(run)) throw new CancelledStep();
			};
			guard();
			const value = await decide({
				read: () => this.readRecord(key),
				write: async (record) => {
					guard();
					wrote = true;
					await this.writeRecord(record);
				},
				remove: async () => {
					guard();
					await this.removeRecord(key);
				},
			});
			outcome = { done: true, value };
		} catch (error) {
			if (!(error instanceof CancelledStep)) throw error;
			outcome = { done: false };
		} finally {
			await lock.release();
		}
		if (!outcome.done) return outcome;
		if (wrote) await this.prune(recordPath);
		return outcome;
	}

	private label(ctx: ExtensionContext): string {
		return sanitizeTabLabel(this.options.getSessionName() || basename(ctx.cwd));
	}

	private prefix(): string[] {
		return ["--autostart=false", "--color=never", "--timeout=10s", ...(this.env.REX_SERVER ? ["--server", this.env.REX_SERVER] : [])];
	}

	private api(run: Run, method: string, args: Record<string, unknown>): Promise<unknown> {
		return this.json(run, ["api", "call", method, JSON.stringify(args)]);
	}

	private async json(run: Run, args: string[]): Promise<unknown> {
		run.controller.signal.throwIfAborted();
		const response = await run.transport.run([...this.prefix(), ...args], {
			cwd: run.ctx.cwd,
			signal: run.controller.signal,
			timeoutMs: this.options.settings.maxWaitMs,
			maxOutputBytes: this.options.settings.maxOutputBytes,
		});
		if (response.outcome !== "exited" || response.exitCode !== 0 || response.truncated) throw new CliCallError(cliError(response), response.started);
		try {
			return JSON.parse(response.stdout);
		} catch {
			throw new Error("Rex did not return complete JSON.");
		}
	}

	private warn(ctx: ExtensionContext, error: unknown): void {
		if (this.warned) return;
		this.warned = true;
		const detail = sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
		try {
			ctx.ui.notify(`Rex tab label update failed: ${detail || "Unknown error"}`, "warning");
		} catch {
			// A diagnostic must not interrupt the host lifecycle.
		}
	}

	private path(key: ResourceKey): string {
		const identity = {
			hostId: key.hostId,
			instanceId: key.instanceId,
			sessionId: key.sessionId,
			windowId: key.windowId,
			blockId: key.blockId,
		};
		const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
		return join(this.directory, `${digest}.json`);
	}

	private async readRecord(key: ResourceKey): Promise<StoredRecord | undefined> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(this.path(key), "r");
			const info = await handle.stat();
			if (!info.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
			const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_RECORD_BYTES) return undefined;
			const value: unknown = JSON.parse(buffer.toString("utf8", 0, bytesRead));
			if (!validRecord(value, key)) return undefined;
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
			if (error instanceof TypeError) return undefined;
			throw error;
		} finally {
			await handle?.close();
		}
	}

	private async writeRecord(record: StoredRecord): Promise<void> {
		const path = this.path(record);
		const temporary = join(this.directory, `.${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await rename(temporary, path);
		} catch (error) {
			await unlink(temporary).catch(() => {});
			throw error;
		}
	}

	// Runs after the writer's own step released its lock. Each victim is locked alone and
	// removed only when it is still the one listed and no other step holds it.
	private async prune(current: string): Promise<void> {
		const names = (await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
		if (names.length <= this.maxRecords) return;
		const records = await Promise.all(names.map(async (name) => ({
			name,
			mtime: (await stat(join(this.directory, name))).mtimeMs,
		})));
		records.sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name));
		let remaining = names.length - this.maxRecords;
		for (const record of records) {
			if (remaining === 0) break;
			const path = join(this.directory, record.name);
			if (path === current) continue;
			if (await this.pruneRecord(path, record.mtime)) remaining--;
		}
	}

	// A locked record belongs to another step, and a changed record is newer than the listed one.
	private async pruneRecord(path: string, mtime: number): Promise<boolean> {
		const lock = await RecordLock.acquire(path, 1);
		if (!lock) return false;
		try {
			const listed = await recordMtime(path);
			if (listed === undefined) return true;
			if (listed !== mtime) return false;
			await unlink(path);
			return true;
		} finally {
			await lock.release();
		}
	}

	private async removeRecord(key: ResourceKey): Promise<void> {
		await unlink(this.path(key)).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
	}
}

/** A step gave up because its run is no longer current; it made no mutation. */
class CancelledStep extends Error {}

function lockPathFor(recordPath: string): string {
	return `${recordPath.slice(0, -".json".length)}.lock`;
}

function wait(ms: number): Promise<void> {
	return new Promise<void>((settle) => { setTimeout(settle, ms); });
}

async function recordMtime(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * One held record lock. The open file description owns the kernel lock, so exclusion holds
 * while that description stays open and the kernel releases it when the process dies. No
 * elapsed time, heartbeat or ownership check participates.
 */
class RecordLock {
	private readonly lockPath: string;
	private readonly handle: FileHandle;

	private constructor(lockPath: string, handle: FileHandle) {
		this.lockPath = lockPath;
		this.handle = handle;
	}

	/**
	 * Locks one record, or returns undefined when another holder keeps it for every attempt.
	 */
	static async acquire(recordPath: string, attempts: number): Promise<RecordLock | undefined> {
		if (process.platform !== "darwin") throw new Error("Rex tab label record locks need macOS file locks.");
		const lockPath = lockPathFor(recordPath);
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt > 0) await wait(LOCK_RETRY_MS);
			const lock = await RecordLock.attempt(lockPath);
			if (lock) return lock;
		}
		return undefined;
	}

	/**
	 * One acquisition attempt. The open file description owns the lock. A lock path that no
	 * longer names the opened file means a successor took the path: the attempt closes its
	 * description and reports a retry, so it never acts under a successor's lock.
	 */
	private static async attempt(lockPath: string): Promise<RecordLock | undefined> {
		let handle: FileHandle;
		try {
			handle = await open(lockPath, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EAGAIN") return undefined;
			throw error;
		}
		try {
			const locked = await handle.stat();
			const named = await stat(lockPath);
			if (named.dev === locked.dev && named.ino === locked.ino) return new RecordLock(lockPath, handle);
		} catch (error) {
			await handle.close().catch(() => {});
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		await handle.close();
		return undefined;
	}

	/** Removes the lock path while this description still holds its lock, then closes it. */
	async release(): Promise<void> {
		try {
			await unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		} finally {
			await this.handle.close();
		}
	}
}

function locateWindow(view: Record<string, unknown>, blockId: string): { windowId: string; currentLabel: string } | undefined {
	const windows = Array.isArray(view.windows) ? view.windows : [];
	for (const candidate of windows) {
		const window = object(candidate);
		const layers = Array.isArray(window.layers) ? window.layers : [];
		const blocks = layers.flatMap((layer) => {
			const value = object(layer).blocks;
			return Array.isArray(value) ? value : [];
		});
		if (!blocks.some((block) => object(block).block_id === blockId)) continue;
		if (blocks.length > 1 || !text(window.window_id)) return undefined;
		if (!text(window.label)) throw new Error("Rex did not report the containing window label.");
		return { windowId: window.window_id, currentLabel: window.label };
	}
	return undefined;
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Rex returned an invalid object.");
	return value as Record<string, unknown>;
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validRecord(value: unknown, key: ResourceKey): value is StoredRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.version === 1 &&
		record.hostId === key.hostId && record.instanceId === key.instanceId &&
		record.sessionId === key.sessionId && record.windowId === key.windowId && record.blockId === key.blockId &&
		text(record.updatedAt) && record.updatedAt.length <= 64 &&
		(record.label === undefined || validStoredLabel(record.label)) &&
		(record.pending === undefined || validStoredLabel(record.pending)) &&
		(record.attempt === undefined || validAttempt(record.attempt));
}

function validAttempt(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function validStoredLabel(value: unknown): value is string {
	return text(value) && Array.from(value).length <= 128 && sanitizeTabLabel(value) === value;
}

function sanitizeDiagnostic(value: string): string {
	return Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 240).join("");
}

/** A failed Rex CLI call. `started` separates a write that never began from an uncertain one. */
class CliCallError extends Error {
	readonly started: boolean;

	constructor(message: string, started: boolean) {
		super(message);
		this.started = started;
	}
}

function cliError(response: CliResult): string {
	const detail = response.stderr.trim() || response.stdout.trim() || "Rex CLI failed.";
	return `Rex CLI ${response.outcome}${response.exitCode === null ? "" : ` (${response.exitCode})`}: ${detail}`;
}
