import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RexSettings } from "./settings.ts";
import { CliTransport, type CliResult, type RexTransport } from "./transport.ts";

const MAX_RECORD_BYTES = 16384;
const MAX_STORE_RECORDS = 256;
const SHUTDOWN_DRAIN_MS = 2000;

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
	updatedAt: string;
}

interface Run {
	generation: number;
	ctx: ExtensionContext;
	controller: AbortController;
	transport: RexTransport;
}

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
	return Array.from(clean).slice(0, 128).join("");
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
	private confirmed: { sessionId: string; blockId: string; label: string } | undefined;
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
		this.dirty = true;
		this.pump();
	}

	refresh(ctx: ExtensionContext): void {
		if (!this.active) return;
		this.ctx = ctx;
		this.dirty = true;
		this.pump();
	}

	input(ctx: ExtensionContext): void {
		if (!this.active) return;
		const desired = this.desired(ctx);
		if (
			this.confirmed &&
			this.confirmed.sessionId === this.env.REX_SESSION &&
			this.confirmed.blockId === this.env.REX_BLOCK &&
			this.confirmed.label === desired
		) return;
		this.refresh(ctx);
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
		this.confirmed = undefined;
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
			while (this.active && this.dirty) {
				this.dirty = false;
				const ctx = this.ctx;
				const controller = this.controller;
				const transport = this.transport;
				if (!ctx || !controller || !transport) continue;
				const run = { generation: this.generation, ctx, controller, transport };
				try {
					await this.update(run);
				} catch (error) {
					if (this.current(run)) this.warn(ctx, error);
				}
			}
		} finally {
			if (this.running === promise) this.running = undefined;
			if (this.active && this.dirty) this.pump();
		}
	}

	private current(run: Run): boolean {
		return this.active && this.generation === run.generation && !run.controller.signal.aborted;
	}

	private async update(run: Run): Promise<void> {
		this.confirmed = undefined;
		if (run.ctx.mode !== "tui") return;
		const sessionId = this.env.REX_SESSION;
		const blockId = this.env.REX_BLOCK;
		if (!sessionId || !blockId) return;
		const identity = await this.serverIdentity(run);
		if (!identity || !await this.foregroundMatches(run, sessionId, blockId)) return;
		const selected = await this.containingWindow(run, sessionId, blockId);
		if (!selected) return;
		const desired = this.desired(run.ctx);
		if (!desired) return;
		await this.applyLabel(run, { ...identity, sessionId, blockId, ...selected }, desired);
	}

	private async serverIdentity(run: Run): Promise<{ hostId: string; instanceId: string } | undefined> {
		const identity = object(await this.json(run, ["whoami", "--json"]));
		if (!this.current(run)) return undefined;
		if (!text(identity.host_id) || !text(identity.instance_id)) throw new Error("Rex did not report its host and instance IDs.");
		return { hostId: identity.host_id, instanceId: identity.instance_id };
	}

	private async foregroundMatches(run: Run, sessionId: string, blockId: string): Promise<boolean> {
		const processes = object(await this.api(run, "com.superlogical.terminal.process", { session_id: sessionId, block_id: blockId, args: {} }));
		if (!this.current(run)) return false;
		const foreground = processes.foreground === null || processes.foreground === undefined ? undefined : object(processes.foreground);
		return foreground?.pid === this.pid;
	}

	private async containingWindow(run: Run, sessionId: string, blockId: string): Promise<{ windowId: string; currentLabel: string } | undefined> {
		const view = object(await this.api(run, "session.view", { session_id: sessionId }));
		if (!this.current(run)) return undefined;
		return locateWindow(view, blockId);
	}

	private async applyLabel(run: Run, attachment: Attachment, desired: string): Promise<void> {
		const { currentLabel, ...key } = attachment;
		const record = await this.readRecord(key);
		if (!this.current(run)) return;
		const defaultLabel = `Window ${key.windowId.slice(-8)}`;
		const managed = record && (currentLabel === record.label || currentLabel === record.pending);
		if (currentLabel !== defaultLabel && !managed) {
			await this.removeRecord(key);
			return;
		}
		if (currentLabel === desired) {
			await this.confirmExisting(run, key, desired, record);
			return;
		}
		await this.writeLabel(run, key, currentLabel, desired, managed === true);
	}

	private async confirmExisting(run: Run, key: ResourceKey, desired: string, record: StoredRecord | undefined): Promise<void> {
		if (record?.pending !== undefined || (record && record.label !== desired)) {
			await this.writeRecord({ ...key, version: 1, label: desired, updatedAt: this.now().toISOString() });
		}
		if (this.current(run)) this.confirmed = { sessionId: key.sessionId, blockId: key.blockId, label: desired };
	}

	private async writeLabel(run: Run, key: ResourceKey, currentLabel: string, desired: string, managed: boolean): Promise<void> {
		await this.writeRecord({
			...key,
			version: 1,
			...(managed ? { label: currentLabel } : {}),
			pending: desired,
			updatedAt: this.now().toISOString(),
		});
		if (!this.current(run)) return;
		await this.api(run, "session.set_window_label", { session_id: key.sessionId, window_id: key.windowId, label: desired });
		if (!this.current(run)) return;
		await this.writeRecord({ ...key, version: 1, label: desired, updatedAt: this.now().toISOString() });
		if (this.current(run)) this.confirmed = { sessionId: key.sessionId, blockId: key.blockId, label: desired };
	}

	private desired(ctx: ExtensionContext): string {
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
		if (response.outcome !== "exited" || response.exitCode !== 0 || response.truncated) throw new Error(cliError(response));
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
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const path = this.path(record);
		const temporary = join(this.directory, `.${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await rename(temporary, path);
		} catch (error) {
			await unlink(temporary).catch(() => {});
			throw error;
		}
		await this.prune(path);
	}

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
			await unlink(path).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
			remaining--;
		}
	}

	private async removeRecord(key: ResourceKey): Promise<void> {
		await unlink(this.path(key)).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
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
		(record.pending === undefined || validStoredLabel(record.pending));
}

function validStoredLabel(value: unknown): value is string {
	return text(value) && Array.from(value).length <= 128 && sanitizeTabLabel(value) === value;
}

function sanitizeDiagnostic(value: string): string {
	return Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 240).join("");
}

function cliError(response: CliResult): string {
	const detail = response.stderr.trim() || response.stdout.trim() || "Rex CLI failed.";
	return `Rex CLI ${response.outcome}${response.exitCode === null ? "" : ` (${response.exitCode})`}: ${detail}`;
}
