import { createHash } from "node:crypto";
import type { ImageSource } from "../shared/api.ts";
import type { ImageBytes } from "../server/images.mts";
import { Worker } from "node:worker_threads";
import type { WorkerOptions } from "node:worker_threads";
import { AgentError, validateSubmitInput } from "./client.mts";
import type { SubmitInput } from "./client.mts";
import type { CatalogPage, CatalogRow, CatalogScan } from "./catalog.mts";
import { compareRosterRows } from "./catalog-state.mts";
import type { AbortReceipt, Admission, InspectResult, Snapshot } from "./contract.mts";
import type {
	AgentServiceOptions as RuntimeOptions,
	HistoryOptions,
	InspectOptions,
	UnavailableConfiguration,
} from "./service-runtime.mts";
export type AgentServiceOptions = Omit<RuntimeOptions, "frameProjection">;
export { AgentError, HostLink } from "./client.mts";
export { AgentCatalog, deriveEndpoint, readClaim } from "./catalog.mts";
export type { CatalogPage, CatalogRecord, CatalogScan, CatalogRow } from "./catalog.mts";
export type { AbortReceipt, Admission, ConversationFrame, InspectResult, Snapshot } from "./contract.mts";
export type { SubmitInput } from "./client.mts";
export type { AvailabilityListener, AvailabilityState } from "./observation.mts";
export type { HistoryOptions, InspectOptions, UnavailableConfiguration } from "./service-runtime.mts";

type WorkerPort = {
	on(event: "message", listener: (message: Response) => void): unknown;
	on(event: "error" | "exit", listener: () => void): unknown;
	postMessage(request: { id: number; member: string; args: unknown[] }): void;
	terminate(): Promise<number>;
};
type WorkerFactory = (url: URL, options: WorkerOptions) => WorkerPort;
type Response = {
	id?: number;
	result?: unknown;
	error?: { code: string; message: string; uncertain?: boolean; retryable?: boolean };
	event?: string;
	args?: unknown[];
};
interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	mutation: boolean;
	cleanup?: () => void;
}
interface InputReceipt {
	digest: string;
	promise: Promise<Admission>;
}
interface Selection {
	identity: string;
	epoch: number;
	confirmed: boolean;
	promise?: Promise<void>;
}
const mutations = new Set(["submit", "retrySubmit", "abort"]);
const MAX_ROWS = 2048,
	MAX_BYTES = 8 * 1024 * 1024;

/** Native decoding and host ownership stay in the worker; roster reads use this bounded cache. */
export class AgentService {
	readonly #worker: WorkerPort;
	readonly #options: AgentServiceOptions;
	readonly #pending = new Map<number, Pending>();
	readonly #inputs = new Map<string, InputReceipt>();
	readonly #rows = new Map<string, { row: CatalogRow; bytes: number }>();
	#orderedRows: { row: CatalogRow; bytes: number }[] = [];
	readonly #selections = new Map<string, Map<string, Selection>>();
	#epoch = 0;
	#bytes = 0;
	#revision = 0;
	#serial = 0;
	#closed = false;
	#failed = false;
	#exited = false;
	#cacheOmitted = 0;
	#closing?: Promise<void>;
	#page: CatalogPage = {
		rows: [],
		nextCursor: null,
		coverage: { complete: false, omitted: 0 },
		stale: false,
		scan: { state: "not-started", complete: false, visited: 0, skipped: 0, omitted: 0 },
	};
	constructor(
		options: AgentServiceOptions,
		factory: WorkerFactory = (_url, workerOptions) => new Worker(new URL("./service-worker.mts", import.meta.url), workerOptions),
	) {
		if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(options.installationId))
			throw new AgentError("invalid_request", "Invalid UI installation identity.");
		if (typeof options.store !== "string" || !options.store)
			throw new AgentError("invalid_request", "Catalog store is required.");
		this.#options = options;
		this.#worker = factory(new URL("./service-worker.mts", import.meta.url), {
			workerData: { store: options.store, installationId: options.installationId, agentDir: options.agentDir },
		});
		this.#worker.on("message", (message: Response) => this.#message(message));
		this.#worker.on("error", () => this.#failure("Agent worker failed."));
		this.#worker.on("exit", () => {
			this.#exited = true;
			this.#failure("Agent worker exited.");
		});
	}
	#message(message: Response): void {
		if (message.id !== undefined) {
			const request = this.#pending.get(message.id);
			this.#pending.delete(message.id);
			request?.cleanup?.();
			if (message.error)
				request?.reject(new AgentError(message.error.code, message.error.message, message.error.uncertain ?? false, message.error.retryable ?? false));
			else request?.resolve(message.result);
			return;
		}
		if (message.event && message.args) this.#event(message.event, message.args);
	}
	#event(event: string, args: unknown[]): void {
		if (this.#closed || this.#failed || this.#exited) return;
		if (event === "roster") this.#rosterUpdate(args[0] as CatalogPage);
		else if ((event === "frame" || event === "availability") && !this.#callbackTarget(args)) return;
		else if (event === "frame")
			this.#options.onFrame?.(...(args as Parameters<NonNullable<AgentServiceOptions["onFrame"]>>));
		else if (event === "availability")
			this.#options.onAvailability?.(...(args as Parameters<NonNullable<AgentServiceOptions["onAvailability"]>>));
	}
	#callbackTarget(args: unknown[]): boolean {
		const [workspaceId, identity, epoch] = args;
		if (typeof workspaceId !== "string" || typeof identity !== "string") return false;
		const selected = this.#selections.get(workspaceId)?.get(identity);
		if (!selected || selected.epoch !== epoch) return false;
		selected.confirmed = true;
		return true;
	}
	#removeRow(id: string): void {
		const prior = this.#rows.get(id);
		if (prior) this.#bytes -= prior.bytes;
		this.#rows.delete(id);
	}
	#rosterUpdate(page: CatalogPage): void {
		const changed: CatalogRow[] = [],
			removed: string[] = [];
		for (const id of page.removed ?? []) {
			this.#removeRow(id);
			removed.push(id);
		}
		let omitted = 0;
		for (const row of page.changed ?? page.rows) {
			const bytes = Buffer.byteLength(JSON.stringify(row));
			const old = this.#rows.get(row.id);
			if ((!old && this.#rows.size >= MAX_ROWS) || this.#bytes - (old?.bytes ?? 0) + bytes > MAX_BYTES) {
				omitted++;
				continue;
			}
			this.#removeRow(row.id);
			this.#rows.set(row.id, { row, bytes });
			this.#bytes += bytes;
			changed.push(row);
		}
		if (changed.length || removed.length)
			this.#orderedRows = [...this.#rows.values()].sort((a, b) => compareRosterRows(a.row, b.row));
		changed.sort(compareRosterRows);
		this.#revision++;
		this.#cacheOmitted += omitted;
		this.#page = {
			...page,
			rows: [],
			nextCursor: null,
			coverage: {
				...page.coverage,
				complete: page.coverage.complete && this.#cacheOmitted === 0,
				omitted: page.coverage.omitted + this.#cacheOmitted,
			},
			stale: page.stale || this.#cacheOmitted > 0,
		};
		delete this.#page.changed;
		delete this.#page.removed;
		this.#options.onRoster?.({ ...structuredClone(this.#page), changed: structuredClone(changed), removed });
	}
	#failure(message: string): void {
		const first = !this.#failed;
		this.#failed = true;
		for (const request of this.#pending.values()) {
			request.cleanup?.();
			request.reject(new AgentError("host_unavailable", message, request.mutation));
		}
		this.#pending.clear();
		if (!this.#closed && first) {
			for (const [workspaceId, targets] of this.#selections)
				for (const selected of targets.values())
					this.#options.onAvailability?.(workspaceId, selected.identity, selected.epoch, "unavailable", message, {});
			this.#page = {
				...this.#page,
				stale: true,
				scan: { ...this.#page.scan, state: "failed", complete: false, error: message },
				coverage: { ...this.#page.coverage, complete: false },
			};
			this.#options.onRoster?.({ ...structuredClone(this.#page), changed: [], removed: [] });
		}
		this.#selections.clear();
	}
	#ready(): void {
		if (this.#closed || this.#failed || this.#exited) throw new AgentError("not_ready", "Agent service is closed.");
	}
	#request<T>(member: string, args: unknown[], signal?: AbortSignal): Promise<T> {
		if (this.#pending.size >= 64)
			return Promise.reject(new AgentError("capacity", "Agent worker request capacity reached."));
		if (signal?.aborted) return Promise.reject(new AgentError("cancelled", "The agent read was cancelled."));
		const id = ++this.#serial;
		return new Promise<T>((resolve, reject) => {
			const request: Pending = { resolve: (value) => resolve(value as T), reject, mutation: mutations.has(member) };
			this.#pending.set(id, request);
			const cancel = () => {
				if (!this.#pending.delete(id)) return;
				request.cleanup?.();
				this.#worker.postMessage({id, member:"cancel", args:[]});
				reject(new AgentError("cancelled", "The agent read was cancelled."));
			};
			if (signal) {signal.addEventListener("abort",cancel,{once:true});request.cleanup = () => signal.removeEventListener("abort",cancel);}
			try {
				if (Buffer.byteLength(JSON.stringify(args)) > 128 * 1024)
					throw new AgentError("invalid_request", "Agent request exceeds its byte bound.");
				this.#worker.postMessage({ id, member, args });
			} catch (error) {
				this.#pending.delete(id);
				request.cleanup?.();
				reject(
					error instanceof AgentError ? error : new AgentError("invalid_request", "Agent request is not serializable."),
				);
			}
		});
	}
	#offset(cursor?: string): number {
		if (cursor === undefined) return 0;
		if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(cursor))
			throw new AgentError("invalid_request", "Invalid roster cursor.");
		const match = /^(\d+):(\d+)$/u.exec(Buffer.from(cursor, "base64url").toString("utf8"));
		if (!match || Number(match[1]) !== this.#revision || !Number.isSafeInteger(Number(match[2])))
			throw new AgentError("stale_revision", "Roster cursor expired.");
		const offset = Number(match[2]);
		if (offset > this.#rows.size) throw new AgentError("invalid_request", "Invalid roster cursor offset.");
		return offset;
	}
	roster(options: { cursor?: string; limit?: number } = {}): CatalogPage {
		const limit = options.limit ?? 20;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new AgentError("invalid_request", "Roster page limit must be 1..100.");
		const offset = this.#offset(options.cursor);
		const rows: CatalogRow[] = [];
		let bytes = 2048;
		while (rows.length < limit && offset + rows.length < this.#orderedRows.length) {
			const cached = this.#orderedRows[offset + rows.length];
			if (!cached || bytes + cached.bytes > 256 * 1024) break;
			rows.push(structuredClone(cached.row));
			bytes += cached.bytes;
		}
		const next = offset + rows.length;
		const nextCursor = next < this.#rows.size ? Buffer.from(`${this.#revision}:${next}`).toString("base64url") : null;
		return {
			...structuredClone(this.#page),
			rows,
			nextCursor,
			coverage: { ...this.#page.coverage, complete: this.#page.coverage.complete && !nextCursor },
		};
	}
	rosterRow(identity: string): CatalogRow | undefined {
		const cached = this.#rows.get(identity);
		return cached ? structuredClone(cached.row) : undefined;
	}
	refresh(scanId?: string): Promise<CatalogScan> {
		this.#ready();
		return this.#request("refresh", [scanId]);
	}
	select(workspaceId: string, identity?: string): Promise<void> {
		this.#ready();
		if (!identity) return this.hide(workspaceId);
		const prior = this.#selections.get(workspaceId)?.get(identity);
		if (prior) return prior.promise ?? Promise.resolve();
		return this.#selectTarget("select", workspaceId, identity);
	}
	#selectTarget(member: string, workspaceId: string, identity: string): Promise<void> {
		const targets = this.#selections.get(workspaceId) ?? new Map<string, Selection>();
		const prior = targets.get(identity);
		const count = [...this.#selections.values()].reduce((total, values) => total + values.size, 0);
		if ((!prior && (targets.size >= 4 || count >= 16)) || this.#pending.size >= 64 || this.#epoch >= Number.MAX_SAFE_INTEGER)
			return Promise.reject(new AgentError("capacity", "Agent selection capacity reached."));
		const selected: Selection = {identity, epoch: ++this.#epoch, confirmed: false};
		targets.set(identity, selected); this.#selections.set(workspaceId, targets);
		selected.promise = this.#request<void>(member, [workspaceId, identity, selected.epoch]).catch(error => {
			if (this.#selections.get(workspaceId)?.get(identity) === selected && !selected.confirmed) {
				if (member === "reconnect") {
					selected.confirmed = true;
					this.#options.onAvailability?.(workspaceId,identity,selected.epoch,"unavailable",error instanceof Error ? error.message : "Agent reconnection failed.",{});
				} else targets.delete(identity);
				if (!targets.size) this.#selections.delete(workspaceId);
			}
			throw error;
		});
		return selected.promise;
	}
	#releaseWorkspace(member: string, workspaceId: string, identity?: string): Promise<void> {
		if (this.#closed || this.#failed || this.#exited) return Promise.resolve();
		if (this.#pending.size >= 64)
			return Promise.reject(new AgentError("capacity", "Agent worker request capacity reached."));
		const targets = this.#selections.get(workspaceId);
		if (identity === undefined) this.#selections.delete(workspaceId);
		else { targets?.delete(identity); if (!targets?.size) this.#selections.delete(workspaceId); }
		return this.#request(member, identity === undefined ? [workspaceId] : [workspaceId, identity]);
	}
	hide(workspaceId: string, identity?: string): Promise<void> {
		return this.#releaseWorkspace("hide", workspaceId, identity);
	}
	reconnect(workspaceId: string, identity: string): Promise<void> {
		this.#ready();
		if (!this.#selections.get(workspaceId)?.has(identity))
			return Promise.reject(new AgentError("invalid_request", "The target is not observed in this workspace."));
		return this.#selectTarget("reconnect", workspaceId, identity);
	}
	async prepare(identity: string): Promise<Record<string, boolean>> {
		this.#ready();
		return this.#request("prepare", [identity]);
	}
	async history(identity: string, options: HistoryOptions = {}, signal?: AbortSignal): Promise<Snapshot> {
		this.#ready();
		return this.#request("history", [identity, options], signal);
	}
	async image(identity: string, source: ImageSource, digest: string): Promise<ImageBytes> {
		this.#ready();
		return this.#request("image", [identity, source, digest]);
	}
	async inspect(identity: string, options: InspectOptions, signal?: AbortSignal): Promise<InspectResult> {
		this.#ready();
		return this.#request("inspect", [identity, options], signal);
	}
	#input(identity: string, input: SubmitInput): { digest: string; prior?: InputReceipt; captured: SubmitInput } {
		validateSubmitInput(input);
		const captured: SubmitInput = { operationId: input.operationId, message: input.message, mode: input.mode };
		const digest = createHash("sha256")
			.update(JSON.stringify({ identity, operationId: input.operationId, message: input.message, mode: input.mode }))
			.digest("hex");
		const prior = this.#inputs.get(input.operationId);
		if (prior && prior.digest !== digest)
			throw new AgentError("operation_conflict", "Agent operation key was reused with changed input or target.");
		if (!prior && this.#inputs.size >= 2048) throw new AgentError("capacity", "Agent input receipt cache is full.");
		return { digest, prior, captured };
	}
	submit(identity: string, input: SubmitInput): Promise<Admission> {
		this.#ready();
		try {
			const { digest, prior, captured } = this.#input(identity, input);
			if (prior) return prior.promise;
			const promise = this.#request<Admission>("submit", [identity, captured]);
			this.#inputs.set(input.operationId, { digest, promise });
			return promise;
		} catch (error) {
			return Promise.reject(error);
		}
	}
	retrySubmit(identity: string, input: SubmitInput): Promise<Admission> {
		this.#ready();
		try {
			const { digest, prior, captured } = this.#input(identity, input);
			if (!prior) return this.submit(identity, input);
			const promise = this.#request<Admission>("retrySubmit", [identity, captured]);
			this.#inputs.set(input.operationId, { digest, promise });
			return promise;
		} catch (error) {
			return Promise.reject(error);
		}
	}
	async abort(identity: string): Promise<AbortReceipt> {
		this.#ready();
		return this.#request("abort", [identity]);
	}
	configure(_identity: string, _options?: unknown): UnavailableConfiguration {
		return {
			available: false,
			reason: "Agent configuration is available through the primary agent command, not this UI adapter.",
		};
	}
	disconnectWorkspace(workspaceId: string): Promise<void> {
		return this.#releaseWorkspace("disconnectWorkspace", workspaceId);
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#failure("Agent service closed before a response.");
		this.#closing = (async () => {
			try {
				if (!this.#exited) await this.#request("close", []);
			} finally {
				await this.#worker.terminate();
				this.#exited = true;
				this.#failure("Agent service is closed.");
			}
		})();
		return this.#closing;
	}
}
export function createAgentService(options: AgentServiceOptions): AgentService {
	return new AgentService(options);
}
