import { randomUUID } from "node:crypto";
import { readFleetStatus } from "./fleet-status.ts";
import { handleSlug, handleStorageId } from "./identity.ts";
import type { AgentProfile } from "./profile-schema.ts";
import { composeListRow, matchesListRow, enrichDashboardRow } from "./profile-discovery.ts";
import { checkInMinutes } from "./durable-checkins.ts";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentCatalog, hostMetadata, storageIdOf, type CatalogRecord } from "./catalog.ts";
import { subscribeCatalogChanges } from "./catalog-events.ts";
import { formatDurableFooter } from "./footer.ts";
import { buildStatusOverview } from "./status-overview.ts";
import { createPrimaryChannel, connectPrimaryChannel, type PrimaryChannel } from "./primary-channel.ts";
import type { ProjectTrustDecision } from "./trust-support.ts";
import type { DeliveryOrigin } from "./durable-controls.ts";
import { acquireHost, connectHost, type HostConnection, type HostObservationListener } from "./host-client.ts";
import { hostRequestVersionError, hostPaths, type HostMetadata } from "./host-protocol.ts";
import { observeClaim, observeClaimAsync } from "./claims.ts";
import { PlaceBook } from "./places.ts";
import type { AgentConversationPage, AgentConversationSummary } from "./dashboard-types.ts";
import { emptyConversationSnapshot, type ConversationSnapshotPage } from "./durable-observation.ts";
import type { HostObservationScope } from "./host-client.ts";

import { MANAGER_CONTRACT } from "./version-contract.ts";
import { collaborationStorage } from "./collaboration.ts";
import { discoverCollaboration } from "./collaboration-discovery.ts";

export const MANAGER_PROTOCOL = MANAGER_CONTRACT;
export interface AgentCaller {
	id: string;
	cwd: string;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	validateModel?: AgentManagerOptions["validateModel"];
}
interface AgentSpawnInput {
	handle?: string;
	role?: string;
	cwd?: string;
	model?: string;
	thinkingLevel?: string;
	name?: string;
	prompt?: string;
	trust?: boolean;
	requestId?: string;
	origin?: DeliveryOrigin;
	checkInMinutes?: number;
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
interface ListRecordStep { record: CatalogRecord; catalog?: string }
interface ListBatch { steps: ListRecordStep[]; nextCursor: string | null; complete: boolean }

const DEFAULT_DELIVERED_LIMIT = 1024;
const DEFAULT_FAILURE_LIMIT = 256;
const MAX_ERROR_TEXT = 512;
const MAX_INVENTORY_PAGES = 16;
const MAX_LIST_VISITS = 32;
const CRASH_WINDOW_MS = 60_000;
const MAX_AUTOMATIC_RESTARTS = 3;
const MANAGED_LINK = { retryAttempts: 0 } as const;

/** Admission origin as request parameters; an absent origin stays absent. */
function originParams(origin: DeliveryOrigin | undefined): { origin?: DeliveryOrigin } {
	return origin === undefined ? {} : { origin };
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Compact projection of one host status: identity, admission-relevant session
 * facts, and the capability limits that matter. The full status remains
 * available through the `agent_status` tool.
 */
function compactStatus(value: unknown): unknown {
	const wrapper = record(value);
	const conversation = record(wrapper.conversation);
	const agent = record(conversation.agent);
	const model = record(agent.model);
	const inventory = record(wrapper.inventory);
	const ordinaryOnly = Array.isArray(inventory.ordinaryOnly) ? inventory.ordinaryOnly.filter((item): item is string => typeof item === "string") : [];
	const provider = stringField(model.provider);
	const modelId = stringField(model.modelId);
	const name = stringField(conversation.name);
	const cwd = stringField(conversation.cwd);
	return {
		...(typeof conversation.identity === "string" ? { identity: conversation.identity } : {}),
		...(typeof conversation.conversationId === "number" ? { conversationId: conversation.conversationId } : {}),
		...(name === undefined ? {} : { name }),
		...(cwd === undefined ? {} : { cwd }),
		busy: conversation.busy === true,
		state: conversation.busy === true ? "working" : "idle",
		agent: {
			...(provider === undefined || modelId === undefined ? {} : { model: { provider, modelId } }),
			thinkingLevel: stringField(agent.thinkingLevel) ?? "off",
		},
		...(ordinaryOnly.length === 0 ? {} : { limits: { ordinaryOnly } }),
	};
}

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
	private readonly rosterListeners = new Set<() => void>();
	private stopCatalogObservation?: () => void;
	subscribeRoster(listener: () => void): () => void {
		if (this.shuttingDown) throw new Error("Agent manager is closed");
		if (!this.stopCatalogObservation) {
			this.stopCatalogObservation = subscribeCatalogChanges(this.catalog.root, () => this.rosterChanged(), (error) => {
				this.failures.set("catalog-observation", `Catalog updates are unavailable: ${error.message}. Restart this Pi process.`);
				this.rosterChanged();
			});
		}
		this.rosterListeners.add(listener);
		return () => {
			this.rosterListeners.delete(listener);
			if (this.rosterListeners.size === 0) {
				this.stopCatalogObservation?.();
				this.stopCatalogObservation = undefined;
				this.failures.delete("catalog-observation");
			}
		};
	}
	private rosterChanged(): void { for (const listener of this.rosterListeners) listener(); }
	readonly catalog: AgentCatalog;
	readonly places: PlaceBook;
	private readonly options: AgentManagerOptions;
	private readonly clients = new Map<string, HostConnection>();
	private readonly attaching = new Set<string>();
	private readonly opening = new Map<string, Promise<HostConnection>>();
	private readonly launchRows = new Map<string, AgentConversationSummary>();
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

	private async connection(record: CatalogRecord, primary?: PrimaryClient, launch = true): Promise<HostConnection> {
		if (this.shuttingDown) throw new Error("Agent manager is closed");
		const existing = this.clients.get(record.storageId);
		if (existing && !existing.closed) return existing;
		const pending = this.opening.get(record.storageId);
		if (pending) {
			if (!launch || !this.attaching.has(record.storageId)) return pending;
			try { return await pending; }
			catch { return this.connection(record, primary); }
		}
		if (!launch) this.attaching.add(record.storageId);
		const acquire = launch ? this.options.acquire ?? acquireHost : this.options.connect ?? connectHost;
		const open = Promise.resolve().then(() => acquire(hostMetadata(record), MANAGED_LINK))
			.then((client) => this.adoptClient(record, client, primary))
			.finally(() => { this.opening.delete(record.storageId); this.attaching.delete(record.storageId); });
		this.opening.set(record.storageId, open);
		return open;
	}

	private async adoptClient(record: CatalogRecord, client: HostConnection, primary: PrimaryClient | undefined): Promise<HostConnection> {
		if (this.shuttingDown || primary?.signal.aborted) {
			await client.close().catch(() => undefined);
			throw new Error("Agent manager or primary released while opening its host");
		}
		const winner = this.clients.get(record.storageId);
		if (winner && winner !== client && !winner.closed) { await client.close(); return winner; }
		await this.subscribeClient(record.storageId, client);
		return client;
	}

	private async subscribeClient(storageId: string, client: HostConnection): Promise<void> {
		this.clients.set(storageId, client);
		try {
			await this.subscribe(storageId, client);
			this.failures.delete(`changes:${storageId}`);
		} catch (error) {
			if (!client.closed && !this.shuttingDown && !this.lifecycle.signal.aborted) {
				this.failures.set(`changes:${storageId}`, `Live change notices are unavailable. Restart the caller or let the idle host retire, then use agent_attach. Compatible reads and controls remain available. ${errorText(error)}`);
				void this.refreshFooter();
				return;
			}
			if (this.clients.get(storageId) === client) this.clients.delete(storageId);
			await client.close().catch(() => undefined);
			throw error;
		}
	}

	/** Reuse a writer or a launch already owned by this manager; never acquire one. */
	private async observationConnection(record: CatalogRecord, primary?: PrimaryClient): Promise<HostConnection | undefined> {
		try { return await this.connection(record, primary, false); }
		catch (error) {
			if (this.shuttingDown || primary?.signal.aborted) throw error;
			const paths = hostPaths(record);
			if (observeClaim(paths.claim, paths.identity).kind === "live") throw error;
			return undefined;
		}
	}

	private observe(record: CatalogRecord, method: string, params: Record<string, unknown>, primary?: PrimaryClient): Promise<unknown> {
		return (async () => {
			if (this.shuttingDown) throw new Error("Agent manager is closed");
			const client = await this.observationConnection(record, primary);
			if (client) return client.request(method, params);
			if (primary?.signal.aborted) throw new Error("Agent primary released during observation");
			if (this.options.observe) return this.options.observe(record, method, params);
			const { observeDurableStorage } = await import("./durable-runtime.ts");
			return observeDurableStorage(record, method, params);
		})();
	}

	async resolveTarget(selector: string): Promise<string> {
		if (!selector.startsWith("@")) return selector;
		const id = handleStorageId(selector.slice(1), this.catalog.root);
		const record = this.catalog.read(id);
		if (record.view?.profileSeed?.handle === selector.slice(1) || record.view?.profiles?.rows.some((row) => row.identity === id && row.handle === selector)) return id;
		const profile = await this.observe(record, "profile-read", { sessionId: id }) as AgentProfile;
		if (profile.handle !== selector) throw new Error("Handle address belongs to a different retained agent");
		return id;
	}

	private async handledRecord(input: AgentSpawnInput, caller: AgentCaller, handle: string): Promise<{ record: CatalogRecord; created: boolean }> {
		try { return { record: this.catalog.read(handleStorageId(handle, this.catalog.root)), created: false }; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		return this.catalog.createHandled(await this.creationMetadata(input, caller), handle, input.role ?? "");
	}

	private async retainedHandle(record: CatalogRecord, handle: string): Promise<unknown> {
		const base = { sessionId: record.storageId, cwd: record.cwd, handle: `@${handle}`, created: false };
		if (record.view?.profileSeed) return { ...base, profile: null, availability: "initializing", creation: { ...record.view.profileSeed, name: record.name ?? null, model: record.model, thinkingLevel: record.thinkingLevel, cwd: record.cwd } };
		const profile = await this.observe(record, "profile-read", { sessionId: record.storageId }) as AgentProfile;
		if (profile.handle !== base.handle) throw new Error("Handle address belongs to a different retained agent");
		return { ...base, profile, availability: profile.live ? "live" : "retained" };
	}

	private async spawnHandled(input: AgentSpawnInput & { handle: string }, caller: AgentCaller, onCreated?: (row: AgentConversationSummary) => void): Promise<unknown> {
		const handle = handleSlug(input.handle);
		const { record: retained, created } = await this.handledRecord(input, caller, handle);
		const id = retained.storageId;
		if (input.cwd !== undefined && retained.cwd !== realpathSync(resolve(caller.cwd, input.cwd))) throw new Error("The retained handle has a different cwd; creation defaults cannot change it");
		const row: AgentConversationSummary = { id, storageId: id, cwd: retained.cwd, name: retained.name, model: { ...retained.model, thinkingLevel: retained.thinkingLevel }, modifiedAt: Date.parse(retained.createdAt), owner: "unknown", state: "starting", cost: 0, partial: false };
		onCreated?.(row);
		if (!created && input.prompt === undefined) return this.retainedHandle(retained, handle);
		const client = await this.connection(retained);
		const profile = await client.request("profile-read", { sessionId: id }) as AgentProfile;
		if (profile.handle !== `@${handle}`) throw new Error("Handle address belongs to a different retained agent");
		const admission = input.prompt === undefined ? undefined : await client.request("task-submit", { sessionId: id, message: input.prompt, requestId: input.requestId ?? randomUUID(), requester: caller.id, origin: input.origin ?? "operator", whenBusy: "followUp", checkInMinutes: checkInMinutes(input.checkInMinutes, input.origin ?? "operator") });
		this.rosterChanged();
		return { sessionId: id, cwd: retained.cwd, handle: `@${handle}`, created, profile, ...(admission === undefined ? {} : { admission }) };
	}

	private async creationMetadata(input: AgentSpawnInput, caller: AgentCaller): Promise<Omit<HostMetadata, "storageId" | "storagePath">> {
		const cwd = realpathSync(resolve(caller.cwd, input.cwd ?? "."));
		if (!statSync(cwd).isDirectory()) throw new Error("Agent cwd must be a directory");
		const separator = input.model?.indexOf("/") ?? -1;
		const model = input.model === undefined ? caller.model : separator > 0 ? { provider: input.model.slice(0, separator), modelId: input.model.slice(separator + 1) } : undefined;
		if (!model?.modelId) throw new Error("An exact provider/model is required when the caller has no selected model");
		const thinkingLevel = input.thinkingLevel ?? caller.thinkingLevel ?? "off";
		const validate = caller.validateModel ?? this.options.validateModel;
		if (!validate) throw new Error("Spawn requires the caller's configured model catalog");
		await validate(model, thinkingLevel);
		return { cwd, model, thinkingLevel, name: input.name, trust: input.trust, ownerId: caller.id, agentDir: this.options.agentDir, packageDir: this.options.packageDir };
	}

	async spawn(input: AgentSpawnInput, caller: AgentCaller, onCreated?: (row: AgentConversationSummary) => void): Promise<unknown> {
		if (input.handle !== undefined) return this.spawnHandled({ ...input, handle: input.handle }, caller, onCreated);
		if (input.role !== undefined) throw new Error("A creation role requires a handle; use agent_profile to configure another agent");
		const metadata = await this.creationMetadata(input, caller);
		const { cwd, model, thinkingLevel } = metadata;
		const { record, created } = this.catalog.createTracked(metadata, input.requestId);
		const row: AgentConversationSummary = {
			id: record.storageId, storageId: record.storageId, cwd, name: input.name,
			firstMessage: input.prompt, model: { ...model, thinkingLevel },
			modifiedAt: Date.parse(record.createdAt), owner: "unknown", state: "starting",
			cost: 0, partial: false,
		};
		return this.startSpawn(record, created, row, input, caller, onCreated);
	}

	private startSpawn(record: CatalogRecord, created: boolean, row: AgentConversationSummary, input: AgentSpawnInput, caller: AgentCaller, onCreated?: (row: AgentConversationSummary) => void): Promise<unknown> {
		return this.performSpawn(record, created, row, input, caller, onCreated);
	}

	private async performSpawn(record: CatalogRecord, created: boolean, row: AgentConversationSummary, input: AgentSpawnInput, caller: AgentCaller, onCreated?: (row: AgentConversationSummary) => void): Promise<unknown> {
		this.launchRows.set(record.storageId, row);
		try {
			const opening = this.connection(record);
			onCreated?.(row);
			this.rosterChanged();
			let client: HostConnection;
			try { client = await opening; }
			catch (error) { if (created) this.catalog.discardUnopened(record); throw error; }
			const submitMethod = client.runtimeContract.operations["task-submit"] ? "task-submit" : "submit";
			const versionError = input.prompt ? hostRequestVersionError(submitMethod, client.runtimeContract) : undefined;
			if (versionError) throw versionError;
			const admission = input.prompt ? await client.request(submitMethod, { sessionId: record.storageId, message: input.prompt, requestId: input.requestId ?? randomUUID(), ownerId: caller.id, ...(submitMethod === "task-submit" ? { requester: caller.id, origin: input.origin ?? "operator" } : originParams(input.origin)), checkInMinutes: checkInMinutes(input.checkInMinutes, input.origin ?? "operator") }) : undefined;
			const outcome = { sessionId: record.storageId, cwd: record.cwd, admission, lifetime: "independent host process" };
			const result = await this.mutationSnapshot(client, outcome, record.storageId);
			this.launchRows.set(record.storageId, { ...row, owner: "here" });
			this.rosterChanged();
			return result;
		} catch (error) {
			if (this.launchRows.get(record.storageId) === row) this.launchRows.delete(record.storageId);
			this.rosterChanged();
			throw error;
		}
	}

	async control(method: string, input: Record<string, unknown>, caller: AgentCaller): Promise<unknown> {
		const selector = String(input.sessionId ?? "");
		const sessionId = await this.resolveTarget(selector);
		if (typeof input.replyTo === "string") input = { ...input, replyTo: await this.resolveTarget(input.replyTo) };
		if (sessionId === caller.id && ["abort", "fork", "rewind", "compact", "configure", "command"].includes(method)) throw new Error("This control cannot target the calling primary session");
		let record: CatalogRecord;
		try { record = this.catalog.read(sessionId); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return this.primaryMessage(method, input, sessionId, caller);
		}
		const params: Record<string, unknown> = { ...input, sessionId, ownerId: caller.id };
		if (method === "task-submit") { params.requester = caller.id; params.origin ??= "operator"; params.requestId ??= randomUUID(); }
		if (method === "profile-update") { params.senderIdentity = caller.id; params.requestId ??= randomUUID(); }
		if (method === "inspect" || method === "status" || method === "snapshot" || method === "dashboard" || method === "profile-read") return this.observe(record, method, params);
		if (method === "attach") {
			this.crashes.delete(record.storageId);
			this.recoveryErrors.delete(record.storageId);
			this.failures.delete(record.storageId);
		}
		return this.controlClient(await this.connection(record), method, params, caller);
	}

	private requestedOperation(method: string, params: Record<string, unknown>, client: HostConnection): string {
		if (method === "submit" && (params.replyTo !== undefined || client.runtimeContract.operations["task-submit"])) return "task-submit";
		if (method === "report") return "submit";
		if (method === "attach") return params.model === undefined ? "status" : "configure";
		return method;
	}

	private async controlClient(client: HostConnection, method: string, params: Record<string, unknown>, caller: AgentCaller): Promise<unknown> {
		const sessionId = String(params.sessionId);
		const requested = this.requestedOperation(method, params, client);
		const versionError = hostRequestVersionError(requested, client.runtimeContract);
		if (versionError) throw versionError;
		if (method === "attach") return this.attachClient(client, sessionId, params.model);
		if (method === "report") return client.request("submit", { sessionId, message: `Report from ${caller.id}:\n${String(params.message ?? "")}`, requestId: params.requestId ?? randomUUID(), whenBusy: "followUp" });
		if (["submit", "rewind", "fork"].includes(method)) params.requestId ??= randomUUID();
		const outcome = requested === "task-submit"
			? await client.request(requested, { ...params, requester: caller.id, origin: params.origin ?? "operator" })
			: await client.request(method, params);
		return ["fork", "rewind", "configure"].includes(method) ? this.mutationSnapshot(client, outcome, sessionId) : outcome;
	}

	private async attachClient(client: HostConnection, sessionId: string, model: unknown): Promise<unknown> {
		if (model !== undefined) {
			const outcome = await client.request("configure", { sessionId, model });
			if ((outcome as { outcome?: string })?.outcome === "failed") return outcome;
		}
		return { sessionId, status: compactStatus(await client.request("status", { sessionId })), recovery: "retained work resumes; no new input was submitted" };
	}

	private async primaryMessage(method: string, input: Record<string, unknown>, sessionId: string, caller: AgentCaller): Promise<unknown> {
		const channel = await connectPrimaryChannel({ id: sessionId, sessionsRoot: this.options.root });
		try {
			if (method !== "submit" && method !== "report") throw new Error("A registered primary accepts messages, not Durable session controls");
			const sourceId = typeof input.requestId === "string" ? input.requestId : randomUUID();
			const origin: DeliveryOrigin = input.origin === "operator" ? "operator" : "model";
			await channel.deliver({ sourceId, text: String(input.message ?? ""), details: { senderIdentity: caller.id, source: sourceId, liveOwner: true, saved: false, origin, wake: origin !== "operator", provider: caller.model?.provider ?? null, modelId: caller.model?.modelId ?? null, thinkingLevel: caller.thinkingLevel ?? null }, ...(typeof input.replyTo === "string" ? { replyTo: input.replyTo } : {}) });
			return { sessionId, admitted: true, sourceId, boundary: "Delivery does not prove action or task acceptance" };
		} finally { await channel.close(); }
	}

	private async mutationSnapshot(client: HostConnection, outcome: unknown, sessionId: string): Promise<unknown> {
		if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) return outcome;
		const values = outcome as Record<string, unknown>;
		const target = typeof values.identity === "string" ? values.identity : sessionId;
		try { return { ...values, status: compactStatus(await client.request("status", { sessionId: target })) }; }
		catch (error) { return { ...values, snapshotError: errorText(error) }; }
	}

	async place(input: { area?: string; topic?: string; prompt?: string; trust?: boolean; requestId?: string; origin?: DeliveryOrigin; checkInMinutes?: number }, caller: AgentCaller): Promise<unknown> {
		const area = realpathSync(resolve(caller.cwd, input.area ?? "."));
		const result = await this.places.withArea(area, async (existing) => {
			if (existing) {
				const response = input.prompt ? await this.control("submit", { sessionId: existing.sessionId, message: input.prompt, checkInMinutes: checkInMinutes(input.checkInMinutes, input.origin ?? "operator"), ...(input.requestId === undefined ? {} : { requestId: input.requestId }), ...originParams(input.origin) }, caller) : await this.control("attach", { sessionId: existing.sessionId }, caller);
				return { value: { ...response as object, sessionId: existing.sessionId }, sessionId: existing.sessionId, topic: existing.topic };
			}
			const created = await this.spawn({ cwd: area, name: input.topic, prompt: input.prompt, trust: input.trust, checkInMinutes: input.checkInMinutes, ...(input.requestId === undefined ? {} : { requestId: input.requestId }), ...originParams(input.origin) }, caller) as { sessionId: string };
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

	/** Freeze one bounded catalog batch before observations publish metadata rewrites. */
	private async listBatch(cursor: ListCursor, cwd?: string): Promise<ListBatch> {
		const resumed = cursor.storage !== undefined;
		if (resumed && cursor.catalog === undefined) throw new Error("List cursor lacks a catalog continuation; restart discovery");
		const page = await this.catalog.page({ cursor: cursor.catalog, limit: MAX_LIST_VISITS - Number(resumed), cwd });
		const steps: ListRecordStep[] = [];
		if (cursor.storage !== undefined) steps.push({ record: this.catalog.read(cursor.storage), catalog: cursor.catalog });
		for (let index = 0; index < page.records.length; index++) {
			steps.push({ record: page.records[index], catalog: page.recordCursors[index] ?? undefined });
		}
		return { steps, nextCursor: page.nextCursor, complete: page.coverage.complete };
	}

	private async collectListPage(record: CatalogRecord, cursor: ListCursor, limit: number, rows: unknown[], unavailable: Array<{ storageId: string; reason: string }>): Promise<void> {
		try {
			const page = await this.observe(record, "list", { limit, ...(cursor.native === undefined ? {} : { cursor: cursor.native }) }) as ConversationPage;
			for (const row of page.items) {
				const composite = composeListRow(row, record.view?.profiles, record.cwd, record.storageId);
				if (matchesListRow(composite, cursor.query)) rows.push(composite);
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
		const batch = await this.listBatch(cursor, input.cwd);
		let visits = 0;
		const profileHints = { complete: true, unknownStorages: 0, omitted: 0 };
		let index = 0;
		while (rows.length < limit && visits < MAX_LIST_VISITS && index < batch.steps.length) {
			const step = batch.steps[index];
			cursor.storage = step.record.storageId;
			cursor.catalog = step.catalog;
			visits += 1;
			const hints = step.record.view?.profiles;
			if (!hints) { profileHints.complete = false; profileHints.unknownStorages++; }
			else { profileHints.complete &&= hints.coverage.complete; profileHints.omitted += hints.coverage.omitted; }
			await this.collectListPage(step.record, cursor, limit - rows.length, rows, unavailable);
			if (cursor.native === undefined) {
				cursor.storage = undefined;
				index++;
			}
		}
		const exhausted = index === batch.steps.length;
		if (exhausted) cursor.catalog = batch.nextCursor ?? undefined;
		const complete = exhausted && batch.complete;
		return { rows, nextCursor: complete ? null : Buffer.from(JSON.stringify(cursor)).toString("base64url"), coverage: { complete, storagesVisited: visits, unavailable, profileHints }, observedAt: new Date().toISOString(), authority: "Observation grants no control or task authority" };
	}

	async dashboardPage(input: { cursor?: string } = {}): Promise<AgentConversationPage> {
		const rows: AgentConversationSummary[] = [];
		const coverage = { complete: false, storagesVisited: 0, skipped: 0, omitted: 0, nextCursor: null as string | null };
		const observedAt = new Date().toISOString();
		let cursor: string | undefined = input.cursor;
		for (let pageIndex = 0; pageIndex < MAX_INVENTORY_PAGES; pageIndex++) {
			const page = await this.catalog.page({ cursor, limit: 20 });
			coverage.skipped += page.coverage.skipped;
			for (const record of page.records) {
				coverage.storagesVisited++;
				const projection = await this.catalogRows(record);
				coverage.skipped += projection.skipped;
				coverage.omitted += projection.omitted;
				const recoveryError = this.recoveryErrors.get(record.storageId);
				const hostLabel = recoveryError;
				rows.push(...projection.rows.map((row) => hostLabel === undefined ? row : { ...row, health: { ...row.health, lastError: hostLabel } }));
			}
			coverage.nextCursor = page.nextCursor;
			if (!page.nextCursor) { coverage.complete = true; break; }
			cursor = page.nextCursor;
		}
		return { rows, coverage, observedAt };
	}

	private async catalogRows(record: CatalogRecord): Promise<{ rows: AgentConversationSummary[]; skipped: number; omitted: number }> {
		const starting = this.launchRows.get(record.storageId);
		const view = record.view;
		if (starting) {
			const published = view?.rows.find((row) => row.id === record.storageId);
			if (this.opening.has(record.storageId) || !published || view?.unavailable || (starting.firstMessage && !published.firstMessage))
				return { rows: [starting], skipped: 0, omitted: 0 };
			this.launchRows.delete(record.storageId);
		}
		if (!view || view.unavailable) {
			return { skipped: 1, omitted: 0, rows: [{ id: record.storageId, storageId: record.storageId, cwd: record.cwd, name: record.name, modifiedAt: Date.parse(view?.updatedAt ?? record.createdAt), owner: "unknown", state: "unavailable", cost: 0, partial: true, error: view?.unavailable ?? "Host metadata is unavailable; inspect this conversation for native state" }] };
		}
		const paths = hostPaths(record);
		const claim = await observeClaimAsync(paths.claim, paths.identity);
		const rows = view.rows.map((source) => {
			const row = { ...source } as AgentConversationSummary;
			row.owner = claim.kind === "unknown" ? "unavailable" : claim.kind === "live" ? "here" : "unknown";
			row.ownerLabel = `Host metadata at ${view.updatedAt}${claim.kind === "unknown" ? `; ${claim.error}` : ""}`;
			if (claim.kind !== "live" && row.state === "working") row.state = "interrupted";
			if (claim.kind !== "live") row.currentTool = undefined;
			return enrichDashboardRow(row, view.profiles);
		});
		return { rows, skipped: view.coverage.complete ? 0 : 1, omitted: view.coverage.omitted };
	}

	async snapshot(sessionId: string, params: { before?: number; limit?: number; maxBytes?: number } = {}): Promise<ConversationSnapshotPage> {
		sessionId = await this.resolveTarget(sessionId);
		if (this.launchRows.has(storageIdOf(sessionId)) && this.opening.has(storageIdOf(sessionId))) return emptyConversationSnapshot();
		return this.observe(this.catalog.read(sessionId), "snapshot", { sessionId, ...params }) as Promise<ConversationSnapshotPage>;
	}

	/**
	 * Attach-only live observation for one conversation or the storage's task
	 * graph. An existing manager-owned launch is shared; without one or a live
	 * writer, the storage stays cold. Opening a view never launches a host.
	 */
	async observeLive(
		sessionId: string,
		scope: "conversation" | "tasks",
		listener: HostObservationListener,
		signal?: AbortSignal,
	): Promise<(() => void) | undefined> {
		if (this.shuttingDown || signal?.aborted) return undefined;
		sessionId = await this.resolveTarget(sessionId);
		const record = this.catalog.read(sessionId);
		return (async () => {
			const client = await this.observationConnection(record);
			if (!client?.observe || signal?.aborted) return undefined;
			const versionError = hostRequestVersionError("observe-open", client.runtimeContract);
			if (versionError) throw versionError;
			const observationScope: HostObservationScope = scope === "tasks" ? { scope: "tasks", sessionId: record.storageId } : { scope: "conversation", sessionId };
			const observation = await client.observe(observationScope, { ...(signal === undefined ? {} : { signal }) });
			const off = observation.onFrame(listener);
			return () => { off(); void observation.close().catch(() => undefined); };
		})();
	}

	private async collaborationTargets(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const params = { ...input };
		for (const key of ["sessionId", "integrator"]) if (typeof params[key] === "string") params[key] = await this.resolveTarget(params[key] as string);
		if (Array.isArray(params.notify)) params.notify = await Promise.all(params.notify.map((id) => this.resolveTarget(String(id))));
		return params;
	}

	/** Discovery uses published hints; scoped reads never acquire a storage writer. */
	async collaborate(input: Record<string, unknown>, caller: AgentCaller): Promise<unknown> {
		input = await this.collaborationTargets(input);
		const action = String(input.action ?? "");
		const threadId = typeof input.threadId === "string" ? input.threadId : undefined;
		const sessionId = typeof input.sessionId === "string" ? input.sessionId : threadId ? collaborationStorage(threadId) : undefined;
		if (action === "list" && !sessionId) return discoverCollaboration(this.catalog, input);
		if (!sessionId) throw new Error("Create requires an agent sessionId; discover an agent or create one first.");
		if (action === "list" || action === "read") return this.observe(this.catalog.read(sessionId), action === "list" ? "collaboration-list" : "collaboration-read", { ...input, sessionId });
		return this.control("collaboration-mutate", { ...input, sessionId, senderIdentity: caller.id, origin: input.origin ?? "model", requestId: input.requestId ?? randomUUID() }, caller);
	}

	async status(sessionId?: string, view?: "fleet"): Promise<unknown> {
		if (view === "fleet") {
			if (sessionId !== undefined) throw new Error("Fleet status describes the local catalog; omit sessionId");
			return readFleetStatus(this.catalog);
		}
		if (sessionId) { sessionId = await this.resolveTarget(sessionId); return this.observe(this.catalog.read(sessionId), "status", { sessionId }); }
		const page = await this.dashboardPage();
		const failures = [
			[...this.failures.entries].map(([storageId, error]) => ({ storageId, error })),
		].flat();
		return buildStatusOverview({ ...page, rows: page.rows.map(({ profile: _profile, ...row }) => row) }, [...this.primaries].map(([sessionId, primary]) => ({ sessionId, cwd: primary.cwd ?? "", name: primary.name, model: primary.model, thinkingLevel: primary.thinkingLevel })), failures);
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

	/** Refresh the recorded identity of a registered primary; the channel endpoint record is rewritten. */
	updatePrimary(ownerId: string, info: { name?: string; model?: { provider: string; modelId: string }; thinkingLevel?: string }): void {
		const primary = this.primaries.get(ownerId);
		if (!primary) return;
		if ("name" in info) primary.name = info.name;
		if ("model" in info) primary.model = info.model;
		if ("thinkingLevel" in info) primary.thinkingLevel = info.thinkingLevel;
		try {
			this.primaryChannels.get(ownerId)?.update({ name: primary.name, model: primary.model, thinkingLevel: primary.thinkingLevel });
		} catch (error) {
			this.failures.set(`primary:${ownerId}`, errorText(error));
		}
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
					if (state.workPending === false && state.deliveriesPending === false) {
						close();
					}
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
		this.subscriptions.delete(storageId);
		client.onClose(() => {
			if (this.clients.get(storageId) !== client) return;
			this.clients.delete(storageId);
			this.launchRows.delete(storageId);
			this.subscriptions.get(storageId)?.();
			this.subscriptions.delete(storageId);
			this.failures.delete(`changes:${storageId}`);
			this.hostLost(storageId);
			void this.refreshFooter();
		});
		if (!client.subscribeChanges) return;
		const unsubscribe = await client.subscribeChanges(() => {
			void this.refreshFooter();
		}, this.lifecycle.signal);
		if (client.closed) unsubscribe();
		else this.subscriptions.set(storageId, unsubscribe);
	}

	private async refreshFooter(): Promise<void> {
		this.rosterChanged();
		if (this.shuttingDown || !this.primaries.size) return;
		if (this.refreshing) { this.refreshAgain = true; return; }
		this.refreshing = true;
		try {
			do {
				this.refreshAgain = false;
				const page = await this.dashboardPage();
				const text = formatDurableFooter(page.rows, page.coverage);
				for (const primary of this.primaries.values()) if (!primary.signal.aborted) primary.status?.(text);
			} while (this.refreshAgain && !this.shuttingDown && this.primaries.size);
		} catch (error) { this.failures.set("footer", errorText(error)); }
		finally { this.refreshing = false; }
	}

	private releaseClients(): void {
		this.launchRows.clear();
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
		this.stopCatalogObservation?.();
		this.stopCatalogObservation = undefined;
		this.rosterListeners.clear();
		for (const primary of this.primaries.values()) primary.status?.(undefined);
		this.primaries.clear();
		for (const channel of this.primaryChannels.values()) void channel.close();
		this.primaryChannels.clear();
		this.releaseClients();
	}

	connectedStorageIds(): string[] { return [...this.clients.keys()]; }
	storageId(sessionId: string): string { return storageIdOf(sessionId); }
}
