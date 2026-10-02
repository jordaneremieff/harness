import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentCatalog, hostMetadata, storageIdOf, type CatalogRecord } from "./catalog.ts";
import { formatDurableFooter } from "./footer.ts";
import { buildStatusOverview } from "./status-overview.ts";
import { createPrimaryChannel, connectPrimaryChannel, type PrimaryChannel } from "./primary-channel.ts";
import type { ProjectTrustDecision } from "./trust-support.ts";
import { acquireHost, connectHost, type HostConnection } from "./host-client.ts";
import { hostPaths, type HostMetadata } from "./host-protocol.ts";
import { observeClaim } from "./claims.ts";
import { PlaceBook } from "./places.ts";
import type { AgentConversationPage, AgentConversationSnapshot, AgentConversationSummary } from "./dashboard-types.ts";

export const MANAGER_PROTOCOL = 9;
export interface AgentCaller {
	id: string;
	cwd: string;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	validateModel?: AgentManagerOptions["validateModel"];
}
export interface AgentManagerOptions {
	root: string;
	agentDir: string;
	packageDir: string;
	acquire?: typeof acquireHost;
	connect?: typeof connectHost;
	observe?: (metadata: HostMetadata, method: string, params: Record<string, unknown>) => Promise<unknown>;
	/** Largest delivered-key memory; the oldest key evicts first. */
	deliveredLimit?: number;
	createPrimary?: typeof createPrimaryChannel;
	validateModel?: (model: { provider: string; modelId: string }, thinkingLevel: string) => void | Promise<void>;
	/** Largest recorded-failure memory; the oldest failure evicts first. */
	failureLimit?: number;
}
interface PrimaryClient { send(text: string, details: unknown): void; status?(text: string | undefined): void; signal: AbortSignal; cwd?: string; name?: string; model?: { provider: string; modelId: string }; thinkingLevel?: string; promptTrust?(cwd: string): Promise<ProjectTrustDecision | undefined> }
interface ConversationPage { items: Array<{ identity: string; name?: string; busy?: boolean; parent?: string }>; next?: unknown }
interface ListCursor { storage?: string; catalog?: string; native?: unknown; query: string; cwd: string }
interface ListRecordStep { record?: CatalogRecord; complete: boolean }

const DEFAULT_DELIVERED_LIMIT = 1024;
const DEFAULT_FAILURE_LIMIT = 256;
const MAX_ERROR_TEXT = 512;
const MAX_INVENTORY_PAGES = 16;
const MAX_LIST_VISITS = 32;
const CRASH_WINDOW_MS = 60_000;
const MAX_AUTOMATIC_RESTARTS = 3;
const MANAGED_LINK = { retryAttempts: 0 } as const;

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT - 3)}...` : text;
}

/** Insertion-ordered map with a hard capacity; the oldest key evicts first. */
class BoundedMap<V> {
	private readonly items = new Map<string, V>();
	private readonly limit: number;
	constructor(limit: number) {
		this.limit = Math.max(1, limit);
	}
	set(key: string, value: V): void {
		this.items.delete(key);
		this.items.set(key, value);
		while (this.items.size > this.limit) {
			const oldest = this.items.keys().next().value;
			if (oldest === undefined) return;
			this.items.delete(oldest);
		}
	}
	get(key: string): V | undefined { return this.items.get(key); }
	has(key: string): boolean {
		return this.items.has(key);
	}
	delete(key: string): void {
		this.items.delete(key);
	}
	get entries(): IterableIterator<[string, V]> {
		return this.items.entries();
	}
}

/** A primary owns client connections, never a Durable scheduler or storage writer. */
export class AgentManager {
	readonly managerProtocol = MANAGER_PROTOCOL;
	readonly catalog: AgentCatalog;
	readonly places: PlaceBook;
	private readonly options: AgentManagerOptions;
	private readonly clients = new Map<string, HostConnection>();
	private readonly opening = new Map<string, Promise<HostConnection>>();
	private readonly recovering = new Set<string>();
	private recoveryQueue: Promise<void> = Promise.resolve();
	private readonly recoveryClients = new Map<string, () => void>();
	private readonly primaries = new Map<string, PrimaryClient>();
	private readonly primaryChannels = new Map<string, PrimaryChannel>();
	private readonly closingPrimaries = new Map<string, Promise<void>>();
	private readonly subscriptions = new Map<string, () => void>();
	private readonly lifecycle = new AbortController();
	private refreshing = false;
	private refreshAgain = false;
	private readonly delivered: BoundedMap<true>;
	private readonly failures: BoundedMap<string>;
	private readonly crashes = new BoundedMap<{ times: number[]; stopped: boolean }>(DEFAULT_FAILURE_LIMIT);
	private readonly recoveryErrors = new BoundedMap<string>(DEFAULT_FAILURE_LIMIT);
	private readonly queuedRecovery = new Set<string>();
	private shuttingDown = false;
	constructor(options: AgentManagerOptions) {
		this.options = options;
		this.catalog = new AgentCatalog(options.root);
		this.places = new PlaceBook(join(options.root, "durable"));
		this.delivered = new BoundedMap(options.deliveredLimit ?? DEFAULT_DELIVERED_LIMIT);
		this.failures = new BoundedMap(options.failureLimit ?? DEFAULT_FAILURE_LIMIT);
	}

	private async connection(record: CatalogRecord, primary?: PrimaryClient): Promise<HostConnection> {
		if (this.shuttingDown) throw new Error("Agent manager is closed");
		const existing = this.clients.get(record.storageId);
		if (existing && !existing.closed) return existing;
		const pending = this.opening.get(record.storageId);
		if (pending) return pending;
		const open = (this.options.acquire ?? acquireHost)(hostMetadata(record), MANAGED_LINK).then(async (client) => {
			if (this.shuttingDown || primary?.signal.aborted) {
				await client.close().catch(() => undefined);
				throw new Error(this.shuttingDown ? "Agent manager closed while opening its host" : "Agent primary released while opening its host");
			}
			this.clients.set(record.storageId, client);
			await this.subscribe(record.storageId, client);
			return client;
		}).finally(() => { this.opening.delete(record.storageId); });
		this.opening.set(record.storageId, open);
		return open;
	}

	private async observe(record: CatalogRecord, method: string, params: Record<string, unknown>, primary?: PrimaryClient): Promise<unknown> {
		if (this.shuttingDown) throw new Error("Agent manager is closed");
		let client = this.clients.get(record.storageId);
		if (!client || client.closed) {
			try {
				client = await (this.options.connect ?? connectHost)(hostMetadata(record), MANAGED_LINK);
				if (this.shuttingDown || primary?.signal.aborted) {
					await client.close().catch(() => undefined);
					client = undefined;
				} else {
					this.clients.set(record.storageId, client);
					await this.subscribe(record.storageId, client);
				}
			} catch {
				client = undefined;
			}
		}
		if (client) return client.request(method, params);
		if (primary?.signal.aborted) throw new Error("Agent primary released during observation");
		if (this.options.observe) return this.options.observe(record, method, params);
		const { observeDurableStorage } = await import("./durable-runtime.ts");
		return observeDurableStorage(record, method, params);
	}

	async spawn(input: { cwd?: string; model?: string; thinkingLevel?: string; name?: string; prompt?: string; trust?: boolean; requestId?: string }, caller: AgentCaller): Promise<unknown> {
		const cwd = realpathSync(resolve(caller.cwd, input.cwd ?? "."));
		if (!statSync(cwd).isDirectory()) throw new Error("Agent cwd must be a directory");
		const separator = input.model?.indexOf("/") ?? -1;
		const model = input.model === undefined ? caller.model : separator > 0 ? { provider: input.model.slice(0, separator), modelId: input.model.slice(separator + 1) } : undefined;
		if (!model?.modelId) throw new Error("An exact provider/model is required when the caller has no selected model");
		const thinkingLevel = input.thinkingLevel ?? caller.thinkingLevel ?? "off";
		const validate = caller.validateModel ?? this.options.validateModel;
		if (!validate) throw new Error("Spawn requires the caller's configured model catalog");
		await validate(model, thinkingLevel);
		const { record, created } = this.catalog.createTracked({ cwd, model, thinkingLevel, name: input.name, trust: input.trust, ownerId: caller.id, agentDir: this.options.agentDir, packageDir: this.options.packageDir }, input.requestId);
		let client: HostConnection;
		try { client = await this.connection(record); }
		catch (error) { if (created) this.catalog.discardUnopened(record); throw error; }
		const admission = input.prompt ? await client.request("submit", { sessionId: record.storageId, message: input.prompt, requestId: input.requestId ?? randomUUID(), ownerId: caller.id }) : undefined;
		const outcome = { sessionId: record.storageId, cwd, admission, lifetime: "independent host process" };
		return this.mutationSnapshot(client, outcome, record.storageId);
	}

	async control(method: string, input: Record<string, unknown>, caller: AgentCaller): Promise<unknown> {
		const sessionId = String(input.sessionId ?? "");
		if (sessionId === caller.id && ["abort", "fork", "rewind", "compact", "configure", "command"].includes(method)) throw new Error("This control cannot target the calling primary session");
		let record: CatalogRecord;
		try { record = this.catalog.read(sessionId); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return this.primaryMessage(method, input, sessionId, caller);
		}
		const params: Record<string, unknown> = { ...input, sessionId, ownerId: caller.id };
		if (method === "inspect" || method === "status" || method === "snapshot" || method === "dashboard") return this.observe(record, method, params);
		if (method === "attach") {
			this.crashes.delete(record.storageId);
			this.recoveryErrors.delete(record.storageId);
			this.failures.delete(record.storageId);
		}
		const client = await this.connection(record);
		if (method === "attach") return this.attachClient(client, sessionId, input.model);
		if ((method === "submit" || method === "rewind" || method === "fork") && params.requestId === undefined) Object.assign(params, { requestId: randomUUID() });
		const outcome = await client.request(method, params);
		return ["fork", "rewind", "configure"].includes(method) ? this.mutationSnapshot(client, outcome, sessionId) : outcome;
	}

	private async attachClient(client: HostConnection, sessionId: string, model: unknown): Promise<unknown> {
		if (model !== undefined) {
			const outcome = await client.request("configure", { sessionId, model });
			if ((outcome as { outcome?: string })?.outcome === "failed") return outcome;
		}
		return { sessionId, status: await client.request("status", { sessionId }), recovery: "retained work resumes; no new input was submitted" };
	}

	private async primaryMessage(method: string, input: Record<string, unknown>, sessionId: string, caller: AgentCaller): Promise<unknown> {
		const channel = await connectPrimaryChannel({ id: sessionId, sessionsRoot: this.options.root });
		try {
			if (method !== "submit") throw new Error("A registered primary accepts messages, not Durable session controls");
			const sourceId = typeof input.requestId === "string" ? input.requestId : randomUUID();
			await channel.deliver({ sourceId, text: String(input.message ?? ""), details: { senderIdentity: caller.id, source: sourceId, liveOwner: true, saved: false, provider: caller.model?.provider ?? null, modelId: caller.model?.modelId ?? null, thinkingLevel: caller.thinkingLevel ?? null }, ...(typeof input.replyTo === "string" ? { replyTo: input.replyTo } : {}) });
			return { sessionId, admitted: true, sourceId, boundary: "Delivery does not prove action or task acceptance" };
		} finally { await channel.close(); }
	}

	private async mutationSnapshot(client: HostConnection, outcome: unknown, sessionId: string): Promise<unknown> {
		if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) return outcome;
		const values = outcome as Record<string, unknown>;
		const target = typeof values.identity === "string" ? values.identity : sessionId;
		try { return { ...values, status: await client.request("status", { sessionId: target }) }; }
		catch (error) { return { ...values, snapshotError: errorText(error) }; }
	}

	async place(input: { area?: string; topic?: string; prompt?: string; trust?: boolean; requestId?: string }, caller: AgentCaller): Promise<unknown> {
		const area = realpathSync(resolve(caller.cwd, input.area ?? "."));
		const result = await this.places.withArea(area, async (existing) => {
			if (existing) {
				const response = input.prompt ? await this.control("submit", { sessionId: existing.sessionId, message: input.prompt, requestId: input.requestId }, caller) : await this.control("attach", { sessionId: existing.sessionId }, caller);
				return { value: { ...response as object, sessionId: existing.sessionId }, sessionId: existing.sessionId, topic: existing.topic };
			}
			const created = await this.spawn({ cwd: area, name: input.topic, prompt: input.prompt, trust: input.trust, requestId: input.requestId }, caller) as { sessionId: string };
			return { value: created, sessionId: created.sessionId, topic: input.topic };
		});
		return result.value;
	}

	private listCursor(input: { cursor?: string; query?: string; cwd?: string }): ListCursor {
		const query = input.query ?? "";
		const cwd = input.cwd ?? "";
		if (input.cursor === undefined) return { query, cwd };
		const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Partial<ListCursor>;
		if (parsed.query !== query || parsed.cwd !== cwd) throw new Error("Repeat the same query and cwd with the cursor");
		return {
			query,
			cwd,
			...(typeof parsed.storage === "string" ? { storage: parsed.storage } : {}),
			...(typeof parsed.catalog === "string" ? { catalog: parsed.catalog } : {}),
			...(parsed.native === undefined ? {} : { native: parsed.native }),
		};
	}

	private async nextListRecord(cursor: ListCursor, cwd?: string): Promise<ListRecordStep> {
		if (cursor.storage !== undefined) return { record: this.catalog.read(cursor.storage), complete: false };
		const page = await this.catalog.page({ cursor: cursor.catalog, limit: 1, cwd });
		cursor.catalog = page.nextCursor ?? undefined;
		if (page.records.length === 0) return { complete: page.nextCursor === null };
		cursor.storage = page.records[0].storageId;
		return { record: page.records[0], complete: false };
	}

	private matchesListRow(row: { identity: string; name?: string; firstMessage?: string }, query: string, cwd: string): boolean {
		if (query === "") return true;
		const text = query.toLocaleLowerCase();
		return [row.identity, row.name ?? "", row.firstMessage ?? "", cwd].some((value) => value.toLocaleLowerCase().includes(text));
	}

	private async collectListPage(record: CatalogRecord, cursor: ListCursor, limit: number, rows: unknown[], unavailable: Array<{ storageId: string; reason: string }>): Promise<void> {
		try {
			const page = await this.observe(record, "list", { limit, cursor: cursor.native }) as ConversationPage;
			for (const row of page.items) {
				if (this.matchesListRow(row, cursor.query, record.cwd)) rows.push({ ...row, sessionId: row.identity, storageId: record.storageId, cwd: record.cwd });
			}
			cursor.native = page.next ?? undefined;
		} catch (error) {
			unavailable.push({ storageId: record.storageId, reason: errorText(error) });
			cursor.native = undefined;
		}
	}

	async list(input: { cursor?: string; query?: string; cwd?: string; limit?: number } = {}): Promise<unknown> {
		const limit = input.limit ?? 10;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("List limit must be between 1 and 20");
		const cursor = this.listCursor(input);
		const rows: unknown[] = [];
		const unavailable: Array<{ storageId: string; reason: string }> = [];
		let visits = 0;
		let complete = false;
		while (rows.length < limit && visits < MAX_LIST_VISITS) {
			const step = await this.nextListRecord(cursor, input.cwd);
			if (step.record === undefined) {
				complete = step.complete;
				break;
			}
			visits += 1;
			await this.collectListPage(step.record, cursor, limit - rows.length, rows, unavailable);
			if (cursor.native === undefined) {
				cursor.storage = undefined;
				if (!cursor.catalog) {
					complete = true;
					break;
				}
			}
		}
		return { rows, nextCursor: complete ? null : Buffer.from(JSON.stringify(cursor)).toString("base64url"), coverage: { complete, storagesVisited: visits, unavailable }, observedAt: new Date().toISOString(), authority: "Observation grants no control or task authority" };
	}

	async dashboardPage(): Promise<AgentConversationPage> {
		const rows: AgentConversationSummary[] = [];
		const coverage = { complete: false, storagesVisited: 0, skipped: 0, omitted: 0, nextCursor: null as string | null };
		const observedAt = new Date().toISOString();
		let cursor: string | undefined;
		for (let pageIndex = 0; pageIndex < MAX_INVENTORY_PAGES; pageIndex++) {
			const page = await this.catalog.page({ cursor, limit: 20 });
			coverage.skipped += page.coverage.skipped;
			for (const record of page.records) {
				coverage.storagesVisited++;
				const projection = this.catalogRows(record);
				coverage.skipped += projection.skipped;
				coverage.omitted += projection.omitted;
				const recoveryError = this.recoveryErrors.get(record.storageId);
				rows.push(...projection.rows.map((row) => recoveryError === undefined ? row : { ...row, health: { ...row.health, lastError: recoveryError } }));
			}
			coverage.nextCursor = page.nextCursor;
			if (!page.nextCursor) { coverage.complete = true; break; }
			cursor = page.nextCursor;
		}
		return { rows, coverage, observedAt };
	}

	private catalogRows(record: CatalogRecord): { rows: AgentConversationSummary[]; skipped: number; omitted: number } {
		const view = record.view;
		if (!view || view.unavailable) {
			return { skipped: 1, omitted: 0, rows: [{ id: record.storageId, storageId: record.storageId, cwd: record.cwd, name: record.name, modifiedAt: Date.parse(view?.updatedAt ?? record.createdAt), owner: "unknown", state: "unavailable", cost: 0, partial: true, error: view?.unavailable ?? "Host metadata is unavailable; inspect this conversation for native state" }] };
		}
		const paths = hostPaths(record);
		const claim = observeClaim(paths.claim, paths.identity);
		const rows = view.rows.map((source) => {
			const row = { ...source } as AgentConversationSummary;
			row.owner = claim.kind === "unknown" ? "unavailable" : claim.kind === "live" ? "here" : "unknown";
			row.ownerLabel = `Host metadata at ${view.updatedAt}${claim.kind === "unknown" ? `; ${claim.error}` : ""}`;
			if (claim.kind !== "live" && row.state === "working") row.state = "interrupted";
			if (claim.kind !== "live") row.currentTool = undefined;
			return row;
		});
		return { rows, skipped: view.coverage.complete ? 0 : 1, omitted: view.coverage.omitted };
	}

	async snapshot(sessionId: string): Promise<AgentConversationSnapshot> { return this.observe(this.catalog.read(sessionId), "snapshot", { sessionId }) as Promise<AgentConversationSnapshot>; }

	async status(sessionId?: string): Promise<unknown> {
		if (sessionId) return this.observe(this.catalog.read(sessionId), "status", { sessionId });
		const page = await this.dashboardPage();
		return buildStatusOverview(page, [...this.primaries].map(([sessionId, primary]) => ({ sessionId, cwd: primary.cwd ?? "", name: primary.name, model: primary.model, thinkingLevel: primary.thinkingLevel })), [...this.failures.entries].map(([storageId, error]) => ({ storageId, error })));
	}

	async registerPrimary(ownerId: string, primary: PrimaryClient): Promise<void> {
		if (this.stopping(primary)) return;
		await this.closingPrimaries.get(ownerId);
		await this.primaryChannels.get(ownerId)?.close();
		const channel = await (this.options.createPrimary ?? createPrimaryChannel)({ id: ownerId, cwd: primary.cwd ?? this.options.root, name: primary.name, model: primary.model, thinkingLevel: primary.thinkingLevel, sessionsRoot: this.options.root, signal: primary.signal,
			promptTrust: (cwd) => primary.promptTrust?.(cwd) ?? Promise.resolve(undefined),
			deliver: (message) => {
				if (this.stopping(primary)) throw new Error("Primary session is closed");
				const key = `${ownerId}:${message.sourceId}`;
				if (this.delivered.has(key)) return;
				primary.send(message.text, message.details);
				this.delivered.set(key, true);
			},
		});
		if (this.stopping(primary)) { await channel.close(); return; }
		this.primaryChannels.set(ownerId, channel);
		this.primaries.set(ownerId, primary);
		primary.signal.addEventListener("abort", () => {
			if (this.primaries.get(ownerId) !== primary) return;
			primary.status?.(undefined);
			this.primaries.delete(ownerId);
			this.primaryChannels.delete(ownerId);
			const closing = channel.close().catch((error) => { this.failures.set(`primary:${ownerId}`, errorText(error)); }).finally(() => {
				if (this.closingPrimaries.get(ownerId) === closing) this.closingPrimaries.delete(ownerId);
			});
			this.closingPrimaries.set(ownerId, closing);
			if (!this.primaries.size) this.releaseClients();
		}, { once: true });
		await this.refreshFooter();
		const due: CatalogRecord[] = [];
		let cursor: string | undefined;
		for (let pageIndex = 0; pageIndex < MAX_INVENTORY_PAGES; pageIndex++) {
			if (this.stopping(primary)) return;
			const page = await this.catalog.page({ cursor, limit: 20 });
			due.push(...page.records.filter((record) => record.recoveryDue === true));
			cursor = page.nextCursor ?? undefined;
			if (!cursor) break;
		}
		if (cursor) this.failures.set("startup", "Startup recovery reached its inventory bound; use agent_list for the remaining storage");
		await this.enqueueRecovery(due, primary);
	}

	private async enqueueRecovery(due: CatalogRecord[], primary: PrimaryClient, afterLoss = false): Promise<void> {
		let next = 0;
		const recover = async () => {
			while (!this.stopping(primary) && next < due.length) {
				const record = due[next++];
				if (record) {
					this.queuedRecovery.delete(record.storageId);
					await this.recover(record, primary, afterLoss);
				}
			}
		};
		const recovery = this.recoveryQueue.then(async () => { await Promise.all([recover(), recover()]); });
		this.recoveryQueue = recovery.catch(() => undefined);
		await recovery;
		for (const record of due.slice(next)) this.queuedRecovery.delete(record.storageId);
	}

	private async recover(record: CatalogRecord, primary: PrimaryClient, afterLoss: boolean): Promise<void> {
		if (this.recovering.has(record.storageId) || this.clients.has(record.storageId) || this.crashes.get(record.storageId)?.stopped) return;
		const paths = hostPaths(record);
		const claim = observeClaim(paths.claim, paths.identity);
		if (claim.kind === "unknown") { this.recordRecoveryError(record.storageId, claim.error); return; }
		this.recovering.add(record.storageId);
		try {
			const open = claim.kind === "live" && !afterLoss ? this.options.connect ?? connectHost : this.options.acquire ?? acquireHost;
			const client = await open(hostMetadata(record), MANAGED_LINK);
			if (this.stopping(primary)) { await client.close(); this.recovering.delete(record.storageId); return; }
			this.recoveryErrors.delete(record.storageId);
			await this.monitorRecovery(record.storageId, client, primary);
		} catch (error) {
			this.recovering.delete(record.storageId);
			this.recordRecoveryError(record.storageId, errorText(error));
		}
	}

	private recordRecoveryError(storageId: string, error: string): void {
		this.failures.set(storageId, error);
		this.recoveryErrors.set(storageId, error);
		void this.refreshFooter();
	}

	private hostLost(storageId: string): void {
		const primary = [...this.primaries.values()].find((candidate) => !this.stopping(candidate));
		if (!primary || this.queuedRecovery.has(storageId)) return;
		try {
			const record = this.catalog.read(storageId);
			if (record.recoveryDue !== true || this.crashes.get(storageId)?.stopped) return;
			const now = Date.now();
			const times = (this.crashes.get(storageId)?.times ?? []).filter((time) => now - time < CRASH_WINDOW_MS);
			times.push(now);
			const stopped = times.length > MAX_AUTOMATIC_RESTARTS;
			this.crashes.set(storageId, { times, stopped });
			if (stopped) {
				this.recordRecoveryError(storageId, "Automatic recovery stopped after repeated host losses within 60 seconds. Inspect the host error, then use agent_attach to retry.");
				return;
			}
			this.queuedRecovery.add(storageId);
			void this.enqueueRecovery([record], primary, true).catch((error) => { this.queuedRecovery.delete(storageId); this.recordRecoveryError(storageId, errorText(error)); });
		} catch (error) { this.recordRecoveryError(storageId, errorText(error)); }
	}

	private async monitorRecovery(storageId: string, client: HostConnection, primary: PrimaryClient): Promise<void> {
		let closed = false;
		let unsubscribe = () => {};
		let removeClose = () => {};
		let checking = false;
		let again = false;
		const close = () => {
			if (closed) return;
			closed = true;
			unsubscribe();
			removeClose();
			primary.signal.removeEventListener("abort", close);
			this.recoveryClients.delete(storageId);
			this.recovering.delete(storageId);
			void client.close().catch((error) => this.failures.set(storageId, errorText(error)));
		};
		this.recoveryClients.set(storageId, close);
		primary.signal.addEventListener("abort", close, { once: true });
		const lost = () => {
			if (closed) return;
			close();
			this.hostLost(storageId);
		};
		removeClose = client.onClose(lost);
		const check = async () => {
			if (closed) return;
			if (checking) { again = true; return; }
			checking = true;
			try {
				do {
					again = false;
					const state = await client.request("recovery-state") as { workPending?: boolean; deliveriesPending?: boolean };
					if (state.workPending === false && state.deliveriesPending === false) close();
					void this.refreshFooter();
				} while (again && !closed);
			} catch (error) {
				lost();
				this.failures.set(storageId, errorText(error));
			}
			finally { checking = false; }
		};
		try {
			if (client.subscribeChanges) {
				unsubscribe = await client.subscribeChanges(() => { void check(); }, primary.signal);
				if (closed) unsubscribe();
			}
			await check();
		} catch (error) { close(); throw error; }
	}

	private stopping(primary: PrimaryClient): boolean {
		return this.shuttingDown || primary.signal.aborted;
	}

	private async subscribe(storageId: string, client: HostConnection): Promise<void> {
		this.subscriptions.get(storageId)?.();
		client.onClose(() => {
			if (this.clients.get(storageId) !== client) return;
			this.clients.delete(storageId);
			this.subscriptions.get(storageId)?.();
			this.subscriptions.delete(storageId);
			this.hostLost(storageId);
			void this.refreshFooter();
		});
		if (!client.subscribeChanges) return;
		const unsubscribe = await client.subscribeChanges(() => { void this.refreshFooter(); }, this.lifecycle.signal);
		if (client.closed) unsubscribe();
		else this.subscriptions.set(storageId, unsubscribe);
	}

	private async refreshFooter(): Promise<void> {
		if (this.shuttingDown || !this.primaries.size) return;
		if (this.refreshing) { this.refreshAgain = true; return; }
		this.refreshing = true;
		try {
			do {
				this.refreshAgain = false;
				const page = await this.dashboardPage();
				const text = formatDurableFooter(page.rows);
				for (const primary of this.primaries.values()) if (!primary.signal.aborted) primary.status?.(text);
			} while (this.refreshAgain && !this.shuttingDown && this.primaries.size);
		} catch (error) { this.failures.set("footer", errorText(error)); }
		finally { this.refreshing = false; }
	}

	private releaseClients(): void {
		for (const close of this.recoveryClients.values()) close();
		for (const unsubscribe of this.subscriptions.values()) unsubscribe();
		this.subscriptions.clear();
		const clients = [...this.clients.values()];
		this.clients.clear();
		for (const client of clients) void client.close();
	}

	close(): void {
		this.shuttingDown = true;
		this.lifecycle.abort();
		for (const primary of this.primaries.values()) primary.status?.(undefined);
		this.primaries.clear();
		for (const channel of this.primaryChannels.values()) void channel.close();
		this.primaryChannels.clear();
		this.releaseClients();
	}

	connectedStorageIds(): string[] { return [...this.clients.keys()]; }
	storageId(sessionId: string): string { return storageIdOf(sessionId); }
}
