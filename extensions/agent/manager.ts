import { createHash, randomUUID } from "node:crypto";
import { storageStatusPageInput, type StorageStatusPageInput } from "./storage-status.ts";
import { PluginError, isChordError } from "@earendil-works/chord";
import { createColdObservationCache } from "./cold-observation.ts";
import { nativeRecipientAvailability, readDeliveryWake } from "./delivery-wake.ts";
import {
	launchIndependentCommand,
	type IndependentCommandInput,
	type IndependentCommandReceipt,
} from "./independent-launch.ts";
import { REPORT_DELIVERY_BOUNDARY } from "./control-guidance.ts";
import { readFleetStatus, validateFleetSelection, type FleetSelection } from "./fleet-status.ts";
import {
	assertHandleCwd,
	canonicalAgentCwd,
	handleSlug,
	handleStorageId,
	isThreadStorage,
	threadStorageId,
	threadStorageRecipientRefusal,
	threadStorageRefusal,
	threadStorageServes,
} from "./identity.ts";
import { durableTargetInput, peerMessageText, peerQuestionFields, questionReceipt } from "./peer-questions.ts";
import { profileText, type AgentProfile } from "./profile-schema.ts";
import { NativeListOutputSchema, observationSchema, structuredObservation } from "./observation-schema.ts";
import {
	composeListRow,
	matchesListRow,
	enrichDashboardRow,
	planListScan,
	compareListStorages,
	listCoverageBasis,
	type ListPass,
	type ListScanPlan,
	type ListScanStep,
} from "./profile-discovery.ts";
import { stopColdStorage } from "./cold-stop.ts";
import { unconfirmedStopText } from "./control-result.ts";
import { checkInMinutes } from "./check-in-options.ts";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	AgentCatalog,
	BACKGROUND_RECONCILE_MS,
	CatalogObservation,
	projectCatalogPriority,
	hostMetadata,
	storageIdOf,
	type CatalogFact,
	type CatalogInventory,
	type CatalogRecord,
} from "./catalog.ts";
import type { CatalogView } from "./catalog-view.ts";
import type { NativeOwnerEvidence } from "./host-changes.ts";
import { subscribeCatalogChanges, type CatalogChange } from "./catalog-events.ts";
import { sessionFigures } from "./footer.ts";
import { sentWorkIdentity } from "./session-work.ts";
import type { ContinuityFact } from "./continuity-facts.ts";
import { recordAdmission } from "./ordinary-continuity.ts";
import { buildStatusOverview } from "./status-overview.ts";
import { firstInteractivePurpose, purposeExcerpt } from "./effort-purpose.ts";
import { readEffortAwareness, type EffortAwareness } from "./effort-awareness.ts";
import {
	createPrimaryChannel,
	connectPrimaryChannel,
	primaryEndpointStatus,
	readPrimaryEndpointDescriptor,
	type PrimaryChannel,
	type PrimaryChannelOptions,
	type PrimaryInfo,
	type PrimaryIntentClaim,
	type PrimaryWorkReference,
} from "./primary-channel.ts";
import { readPrimaryObservation, type OrdinaryPrimaryObservation } from "./primary-observation.ts";
import { readRelatedEfforts, type EffortPresencePage, type EffortReadResources } from "./effort-presence.ts";
import { createPrimaryLocationResolver, type PrimaryLocationResolver } from "./effort-location.ts";
import { LaunchFailures, LaunchReplay } from "./launch-failures.ts";
import { RecoveryOrder } from "./recovery-order.ts";
import type { ProjectTrustDecision } from "./trust-support.ts";
import type { DeliveryOrigin } from "./durable-controls.ts";
import {
	acquireHost,
	connectHost,
	HostBusyEndpointUnavailableError,
	HostLaunchDemandEnded,
	HostEndpointUnavailableError,
	type HostConnection,
	type HostObservationListener,
} from "./host-client.ts";
import { HostError, hostPaths, hostRequestVersionError, type HostMetadata } from "./host-protocol.ts";
import { observeClaim, type ClaimObservation } from "./claims.ts";
import { PlaceBook } from "./places.ts";
import type {
	AgentConversationPage,
	AgentConversationSummary,
	AgentPriorityPage,
	AgentPrioritySummary,
} from "./dashboard-types.ts";
import type { ConversationSnapshotPage } from "./durable-observation.ts";
import type { HostObservationScope } from "./host-client.ts";

import {
	HOST_CONTRACT,
	MANAGER_CONTRACT,
	operationContractMismatch,
	type RuntimeContract,
} from "./version-contract.ts";
import { collaborationStorage, validateCollaborationAction } from "./collaboration-contract.ts";
import { discoverCollaboration } from "./collaboration-discovery.ts";

import {
	readAgentPreferences,
	resolveExecutionPreset,
	effectiveExecutionSelection,
	parseExecutionSelection,
	parsePreferenceSnapshot,
	executionInputDigest,
	type ExecutionSelection,
	type ExecutionFields,
	type PreferenceCatalog,
	type PreferenceSnapshot,
} from "./agent-preferences.ts";

let resultReferencePromise: Promise<typeof import("./result-reference.ts")> | undefined;
function loadResultReference(): Promise<typeof import("./result-reference.ts")> {
	resultReferencePromise ??= import("./result-reference.ts");
	return resultReferencePromise;
}

let collaborationPromise: Promise<typeof import("./collaboration.ts")> | undefined;
function loadCollaboration(): Promise<typeof import("./collaboration.ts")> {
	collaborationPromise ??= import("./collaboration.ts");
	return collaborationPromise;
}

let durableObservationPromise: Promise<typeof import("./durable-observation.ts")> | undefined;
function loadDurableObservation(): Promise<typeof import("./durable-observation.ts")> {
	durableObservationPromise ??= import("./durable-observation.ts");
	return durableObservationPromise;
}

export const MANAGER_PROTOCOL = MANAGER_CONTRACT;
export interface AgentCaller {
	id: string;
	cwd: string;
	reportedUsage?: { reportedCost: number; partial: boolean };
	name?: string;
	observedPurpose?: PrimaryInfo["observedPurpose"];
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	validateModel?: AgentManagerOptions["validateModel"];
	preferenceCatalog?: PreferenceCatalog;
	retainExecutionSelection?: (selection: ExecutionSelection) => void | Promise<void>;
}
interface AgentSpawnInput {
	preset?: string;
	selection?: ExecutionSelection;
	preferenceSnapshot?: PreferenceSnapshot;
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
	stopCold?: typeof stopColdStorage;
	observe?: (metadata: HostMetadata, method: string, params: Record<string, unknown>) => Promise<unknown>;
	/** Largest delivered-key memory; the oldest key evicts first. */
	deliveredLimit?: number;
	createPrimary?: typeof createPrimaryChannel;
	/** Resolves the working directory of a registering primary; defaults to a resolver that this manager owns. */
	locations?: PrimaryLocationResolver;
	/** Validate catalog presence; return the effective thinking level when Pi clamps it. */
	validateModel?: (
		model: { provider: string; modelId: string },
		thinkingLevel: string,
	) => string | void | Promise<string> | Promise<void>;
	/** Largest recorded-failure memory; the oldest failure evicts first. */
	failureLimit?: number;
}
interface PrimaryClient {
	sentWork?: Set<string>;
	retainSentWork?(sessionId: string): void;
	retainContinuity?(fact: ContinuityFact): void;
	send(text: string, details: unknown, sourceId: string, requireRetained: boolean): void;
	/** A confirmed body needs no new message, but a replay can carry new request results. */
	receiveRetainedReplay?(details: unknown): void;
	resumeInbox?(): void;
	status?(text: string | undefined): void;
	signal: AbortSignal;
	cwd?: string;
	sessionFile?: string;
	name?: string;
	observedInput?: string;
	observedInputComplete?: boolean;
	observedInputCanCapture?: boolean;
	/** Work items this session used, newest first; read at registration. */
	readonly workRefs?: PrimaryWorkReference[];
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	promptTrust?(cwd: string): Promise<ProjectTrustDecision | undefined>;
}
type RecoveryOwner = { signal: AbortSignal };
interface ConversationPage {
	items: Array<{ identity: string; name?: string; busy?: boolean; parent?: string }>;
	next?: unknown;
}
/** `after` is the last storage the pass finished; `storage` and `native` hold a storage page in progress. */
interface ListCursor {
	query: string;
	cwd: string;
	pass: ListPass;
	since: number;
	after?: string;
	storage?: string;
	native?: unknown;
	unavailable?: true;
}

const DEFAULT_DELIVERED_LIMIT = 1024;
/** How long a reloading session's channel stays published while its extension registers again. */
const PRIMARY_RELOAD_GRACE_MS = 60_000;
const DEFAULT_FAILURE_LIMIT = 256;
const MAX_ERROR_TEXT = 512;
const MAX_INVENTORY_PAGES = 16;
const MAX_LIST_STEPS = 32;
const PRIMARY_ACTIVITY_INTERVAL_MS = 60_000;
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
	const ordinaryOnly = Array.isArray(inventory.ordinaryOnly)
		? inventory.ordinaryOnly.filter((item): item is string => typeof item === "string")
		: [];
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

function claimOwner(claim: ClaimObservation): AgentConversationSummary["owner"] {
	if (claim.kind === "live") return "here";
	return claim.kind === "unknown" ? "unavailable" : "unknown";
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
	get(key: string): V | undefined {
		return this.items.get(key);
	}
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

/** An omitted field and an undefined one mean the same to a control; the host transport accepts only strict JSON. */
function definedFields(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/** The caller's wait ends when `signal` aborts; the work itself settles on its own with its outcome handled. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return work;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

/** A primary owns client connections, never a Durable scheduler or storage writer. */
function catalogOwner(storageId: string, observedClaim: ClaimObservation, evidence: NativeOwnerEvidence | undefined) {
	const verified =
		evidence?.kind === "verified" &&
		evidence.storageId === storageId &&
		!(
			observedClaim.kind === "dead" &&
			observedClaim.endedAt !== undefined &&
			observedClaim.writerId === evidence.writerId
		);
	const publication = verified ? evidence.view : undefined;
	const resolvedClaim =
		publication !== undefined || (!verified && (observedClaim.kind === "absent" || observedClaim.kind === "dead"));
	const claim: ClaimObservation = publication
		? { kind: "live", label: "Verified current host" }
		: verified
			? { kind: "unknown", error: "The current host has no successful bounded publication" }
			: observedClaim;
	const unknownReason =
		evidence && evidence.kind !== "verified"
			? evidence.reason
			: !evidence && observedClaim.kind === "unknown"
				? observedClaim.error
				: "The current host has no successful bounded publication";
	return { publication, resolvedClaim, claim, unknownReason };
}

function publishedRows(
	view: CatalogView,
	observedAt: string,
	{ claim, publication, unknownReason }: ReturnType<typeof catalogOwner>,
): AgentConversationSummary[] {
	const hints = new Map((view.attention?.rows ?? []).map((hint) => [hint.identity, hint.kind]));
	const ownerLabel = `${publication ? "Current host publication" : "Host metadata"} at ${view.updatedAt}; claim observed at ${observedAt}${claim.kind === "unknown" ? `; ${unknownReason}` : ""}`;
	return view.rows.map((source) => {
		const row = { ...source } as AgentConversationSummary;
		const hint = hints.get(source.id);
		if (hint !== undefined) row.attention = hint;
		row.owner = claimOwner(claim);
		row.ownerLabel = ownerLabel;
		if (claim.kind === "unknown" && row.state === "working") {
			row.state = "unavailable";
			row.partial = true;
			row.error = unknownReason;
		} else if (claim.kind !== "live" && row.state === "working") row.state = "interrupted";
		if (claim.kind !== "live") row.currentTool = undefined;
		return enrichDashboardRow(row, view.profiles);
	});
}

export class AgentManager {
	readonly managerProtocol = MANAGER_PROTOCOL;
	private coldObservations = createColdObservationCache();
	private coldReleased = false;
	private coldRelease: Promise<void> = Promise.resolve();
	private hasObservationOwners(): boolean {
		return !this.shuttingDown && (this.primaries.size > 0 || this.rosterListeners.size > 0);
	}
	private retainColdObservations(): void {
		if (!this.hasObservationOwners() || !this.coldReleased) return;
		this.coldObservations = createColdObservationCache();
		this.coldReleased = false;
	}
	private closing?: Promise<void>;
	private toolCardRows: readonly AgentConversationSummary[] = [];

	/** Latest roster facts already observed for the primary footer; this lookup performs no I/O. */
	observedToolCardRows(): readonly AgentConversationSummary[] {
		return this.toolCardRows;
	}

	private observeToolCardRows(page: AgentConversationPage): void {
		this.toolCardRows = page.rows;
	}
	private readonly rosterListeners = new Set<() => void>();
	/** The figures text last written to each primary's footer cell. */
	private readonly footerFigures = new Map<string, string>();
	private stopCatalogObservation?: () => void;
	private observeCatalogChanges(): void {
		if (this.stopCatalogObservation) return;
		const changed = (change: CatalogChange) => this.catalogChanged(change);
		this.stopCatalogObservation = subscribeCatalogChanges(this.catalog.root, changed, (error) => {
			this.failures.set(
				"catalog-observation",
				`Catalog updates are unavailable: ${error.message}. Restart this Pi process.`,
			);
			changed(undefined);
		});
		this.inventory.invalidate();
		this.failures.delete("catalog-observation");
	}
	private catalogChanged(change: CatalogChange): void {
		this.inventory.invalidate(change);
		void this.refreshFooter().catch((error) => this.failures.set("footer", errorText(error)));
		// A changed recipient can wake a parked delivery in any source storage.
		this.recoverCatalogueChanges();
	}
	private releaseObservation(): Promise<void> {
		if (this.hasObservationOwners()) return this.coldRelease;
		this.stopCatalogObservation?.();
		this.stopCatalogObservation = undefined;
		this.failures.delete("catalog-observation");
		if (!this.coldReleased) {
			this.coldReleased = true;
			this.coldRelease = Promise.all([this.coldRelease, this.coldObservations.close()]).then(() => undefined);
		}
		return this.coldRelease;
	}
	private readonly observationOwnerEnded = (): void => {
		void this.releaseObservation().catch((error) => this.failures.set("cold-observation", errorText(error)));
	};
	subscribeRoster(listener: () => void): () => void {
		if (this.shuttingDown) throw new Error("Agent manager is closed");
		this.observeCatalogChanges();
		this.rosterListeners.add(listener);
		this.retainColdObservations();
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.rosterListeners.delete(listener);
			this.observationOwnerEnded();
		};
	}
	private rosterChanged(): void {
		for (const listener of this.rosterListeners) listener();
	}
	readonly catalog: AgentCatalog;
	private readonly locations: PrimaryLocationResolver;
	private readonly inventory: CatalogObservation;
	readonly places: PlaceBook;
	private readonly options: AgentManagerOptions;
	private readonly clients = new Map<string, HostConnection>();
	private readonly attaching = new Set<string>();
	private readonly opening = new Map<string, Promise<HostConnection>>();
	private readonly launchRows = new Map<string, AgentConversationSummary>();
	private readonly recovering = new Set<string>();
	/** Lets overlapping reads of one due record end in one acquisition, whatever order their batches run in. */
	private readonly recoveryOrder = new RecoveryOrder();
	/** Catalogue work markers do not replace the exit evidence required after a known link loss. */
	private readonly recoveryHolds = new Map<string, symbol>();
	private recoveryQueue: Promise<void> = Promise.resolve();
	private catalogueScan?: Promise<void>;
	private catalogueScanAgain = false;
	private readonly wakeAttempts = new BoundedMap<ReadonlyMap<string, string>>(MAX_INVENTORY_PAGES * 20);
	private readonly recoveryClients = new Map<
		string,
		{ client: HostConnection; close: () => void; refresh: () => Promise<void> }
	>();
	private readonly primaries = new Map<string, PrimaryClient>();
	private readonly primaryChannels = new Map<string, PrimaryChannel>();
	private readonly closingPrimaries = new Map<string, Promise<void>>();
	/** Registrations of sessions whose extension reloads; each keeps its channel published until it registers again. */
	private readonly reloadingPrimaries = new Map<
		string,
		{ readonly primary: PrimaryClient; readonly timer: ReturnType<typeof setTimeout> }
	>();
	/** Registrations whose extension instance is gone, so their callbacks are not called again. */
	private readonly reloadedSignals = new WeakSet<AbortSignal>();
	private readonly primaryClosures = new WeakMap<AbortSignal, Map<string, Promise<void>>>();
	private readonly registeringPrimaries = new WeakMap<AbortSignal, Map<string, Promise<void>>>();
	private readonly subscriptions = new Map<string, () => void>();
	private readonly lifecycle = new AbortController();
	private refreshing = false;
	private refreshAgain = false;
	private readonly delivered: BoundedMap<symbol>;
	private readonly failures: BoundedMap<string>;
	private readonly crashes = new BoundedMap<{ times: number[]; stopped: boolean }>(DEFAULT_FAILURE_LIMIT);
	/** Recovery acquisitions that failed, so catalog notices cannot launch one failing host over and over. */
	private readonly launchFailures = new LaunchFailures({
		limit: MAX_AUTOMATIC_RESTARTS,
		windowMs: CRASH_WINDOW_MS,
		storages: DEFAULT_FAILURE_LIMIT,
	});
	/** Reads the catalog again when a waiting storage may launch, since no catalog notice follows a failed launch. */
	private readonly launchReplay = new LaunchReplay(() => this.recoverCatalogueChanges());
	private readonly recoveryErrors = new BoundedMap<string>(DEFAULT_FAILURE_LIMIT);
	private readonly recoveryNotes = new BoundedMap<string>(DEFAULT_FAILURE_LIMIT);
	private readonly queuedRecovery = new Set<string>();
	private shuttingDown = false;
	constructor(options: AgentManagerOptions) {
		this.options = options;
		this.catalog = new AgentCatalog(options.root);
		this.locations = options.locations ?? createPrimaryLocationResolver();
		this.inventory = new CatalogObservation(this.catalog);
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
			try {
				return await pending;
			} catch {
				return this.connection(record, primary, true);
			}
		}
		if (!launch) this.attaching.add(record.storageId);
		const acquire = launch ? (this.options.acquire ?? acquireHost) : (this.options.connect ?? connectHost);
		const metadata = hostMetadata(record, this.options.packageDir);
		const open = Promise.resolve()
			.then(() => acquire(metadata, MANAGED_LINK))
			.then((client) => this.adoptClient(record, client, primary))
			.finally(() => {
				this.opening.delete(record.storageId);
				this.attaching.delete(record.storageId);
			});
		this.opening.set(record.storageId, open);
		return open;
	}

	private async adoptClient(
		record: CatalogRecord,
		client: HostConnection,
		primary: PrimaryClient | undefined,
	): Promise<HostConnection> {
		if (this.shuttingDown || primary?.signal.aborted) {
			await client.close().catch(() => undefined);
			throw new Error("Agent manager or primary released while opening its host");
		}
		const winner = this.clients.get(record.storageId);
		if (winner && winner !== client && !winner.closed) {
			await client.close();
			return winner;
		}
		await this.subscribeClient(record.storageId, client);
		return client;
	}

	private async subscribeClient(storageId: string, client: HostConnection): Promise<void> {
		this.clients.set(storageId, client);
		this.recoveryHolds.delete(storageId);
		try {
			await this.subscribe(storageId, client);
			this.failures.delete(`changes:${storageId}`);
		} catch (error) {
			if (!client.closed && !this.shuttingDown && !this.lifecycle.signal.aborted) {
				this.failures.set(
					`changes:${storageId}`,
					`Live change notices are unavailable. Restart the caller or let the idle host retire, then use agent_attach. Compatible reads and controls remain available. ${errorText(error)}`,
				);
				void this.refreshFooter();
				return;
			}
			if (this.clients.get(storageId) === client) this.clients.delete(storageId);
			await client.close().catch(() => undefined);
			throw error;
		}
	}

	/** Reuse a writer or a launch already owned by this manager; never acquire one. */
	private async observationConnection(
		record: CatalogRecord,
		primary?: PrimaryClient,
	): Promise<HostConnection | undefined> {
		try {
			return await this.connection(record, primary, false);
		} catch (error) {
			if (this.shuttingDown || primary?.signal.aborted) throw error;
			if (error instanceof HostEndpointUnavailableError) return undefined;
			if (error instanceof HostError || isChordError(error) || error instanceof PluginError) throw error;
			return undefined;
		}
	}

	/** Version differences explain a strict observation refusal; they never relax its schema. */
	private observationPeerError(error: unknown, peer: RuntimeContract): Error {
		const message = error instanceof Error ? error.message : String(error);
		const local = HOST_CONTRACT;
		if (
			peer.release === local.release &&
			peer.upstream.codingAgent === local.upstream.codingAgent &&
			peer.upstream.durable === local.upstream.durable
		)
			return error instanceof Error ? error : new Error(message);
		const older =
			peer.release.localeCompare(local.release, undefined, { numeric: true }) < 0 ||
			peer.upstream.codingAgent.localeCompare(local.upstream.codingAgent, undefined, { numeric: true }) < 0 ||
			peer.upstream.durable.localeCompare(local.upstream.durable, undefined, { numeric: true }) < 0;
		return new Error(
			`The peer runs ${older ? "older" : "different"} code: agent ${peer.release}, Pi ${peer.upstream.codingAgent}, Durable ${peer.upstream.durable}; this caller uses agent ${local.release}, Pi ${local.upstream.codingAgent}, Durable ${local.upstream.durable}. Replace the peer's loaded code: let its active work finish, then use agent_abort with release: true when it is idle. A host without release support names its stop step in that refusal. Then use agent_attach to start a host from the current installation. Restart an ordinary primary to replace its loaded code. No older observation shape was accepted. ${message}`,
			{ cause: error },
		);
	}

	private async observePeer(
		client: HostConnection,
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		try {
			const value = await client.request(method, params, signal === undefined ? undefined : { signal });
			if (method === "list") return structuredObservation(NativeListOutputSchema, value);
			return method === "status" || method === "inspect"
				? structuredObservation(observationSchema(method), value)
				: value;
		} catch (error) {
			throw this.observationPeerError(error, client.runtimeContract);
		}
	}

	/**
	 * An aborted `signal` ends the caller's wait at once and cancels a live host request. A cold read
	 * cannot stop part way; it finishes, and only its result cache keeps the value.
	 */
	private observe(
		record: CatalogRecord,
		method: string,
		params: Record<string, unknown>,
		primary?: PrimaryClient,
		signal?: AbortSignal,
	): Promise<unknown> {
		const cold = this.coldObservations;
		return abortable(
			(async () => {
				signal?.throwIfAborted();
				if (this.shuttingDown) throw new Error("Agent manager is closed");
				const client = await this.observationConnection(record, primary);
				if (client) return this.observePeer(client, method, params, signal);
				if (primary?.signal.aborted) throw new Error("Agent primary released during observation");
				if (this.options.observe) return this.options.observe(record, method, params);
				if (this.shuttingDown) throw new Error("Agent manager is closed");
				return cold.observe(record, method, params);
			})(),
			signal,
		);
	}

	/** Resolve one retained native target without guessing an ordinary primary or copying its catalog. */
	nativeTarget(sessionId: string): CatalogRecord {
		return this.catalog.read(sessionId);
	}

	/** The caller owns this manager and closes it after waits or subscriptions finish. */
	async connectNative(sessionId: string, launch = true): Promise<HostConnection> {
		return this.connection(this.nativeTarget(sessionId), undefined, launch);
	}

	async resolveTarget(selector: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if (!selector.startsWith("@")) return selector;
		let id: string;
		let record: CatalogRecord;
		try {
			// A catalog root that does not exist yet holds no handle either.
			id = handleStorageId(selector.slice(1), this.catalog.root);
			record = this.catalog.read(id);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const slug = selector.slice(1);
			throw Object.assign(
				new Error(
					`No retained agent holds ${selector}. Find it with agent_list and query ${JSON.stringify(slug)}, or create it with agent_spawn and handle ${JSON.stringify(slug)}.`,
				),
				{ code: "ENOENT" },
			);
		}
		if (
			record.view?.profileSeed?.handle === selector.slice(1) ||
			record.view?.profiles?.rows.some((row) => row.identity === id && row.handle === selector)
		)
			return id;
		const profile = (await this.observe(record, "profile-read", { sessionId: id }, undefined, signal)) as AgentProfile;
		if (profile.handle !== selector) throw new Error("Handle address belongs to a different retained agent");
		return id;
	}

	private executionInput(
		input: AgentSpawnInput,
		caller: AgentCaller,
		retained?: ExecutionFields,
	): AgentSpawnInput & { selection: ExecutionSelection } {
		if (input.selection !== undefined) {
			const selection = parseExecutionSelection(input.selection);
			if (selection.inputDigest !== executionInputDigest(input))
				throw new Error("Request ID already belongs to different execution inputs");
			return { ...input, ...selection.values, selection };
		}
		const preferenceSnapshot =
			input.preferenceSnapshot === undefined
				? readAgentPreferences(this.options.agentDir, caller.preferenceCatalog)
				: parsePreferenceSnapshot(input.preferenceSnapshot);
		let selection = resolveExecutionPreset(preferenceSnapshot, input, retained ?? {}, {
			creation: !retained,
			reused: !!retained,
			role: !!input.handle || input.role !== undefined,
			checkIn: input.prompt !== undefined,
		});
		if (input.prompt !== undefined && selection.values.checkInMinutes === undefined) {
			selection.values.checkInMinutes = checkInMinutes(undefined, input.origin ?? "operator", this.options.agentDir);
			selection.origins.checkInMinutes = "default";
		}
		if (retained) selection = effectiveExecutionSelection(selection, retained.thinkingLevel);
		const { role: _role, ...base } = input;
		return { ...base, ...selection.values, selection, preferenceSnapshot };
	}

	private async reuseExecutionInput(
		input: AgentSpawnInput,
		caller: AgentCaller,
		record: CatalogRecord,
		sessionId = record.storageId,
	): Promise<AgentSpawnInput & { selection: ExecutionSelection }> {
		if (input.selection !== undefined) return this.executionInput(input, caller);
		let fields: ExecutionFields = {};
		let unavailable: string | undefined;
		try {
			const profile = (await this.observe(record, "profile-read", { sessionId })) as AgentProfile;
			fields = {
				model: profile.model ? `${profile.model.provider}/${profile.model.modelId}` : undefined,
				thinkingLevel: profile.thinkingLevel ?? undefined,
			};
			if (fields.model === undefined || fields.thinkingLevel === undefined)
				unavailable = "The target profile has no complete retained model and thinking evidence.";
		} catch (error) {
			unavailable = errorText(error).slice(0, 512);
		}
		const selected = this.executionInput(input, caller, fields);
		if (unavailable)
			selected.selection.diagnostics.push({
				field: "retained",
				message: `Current retained execution evidence is unavailable: ${unavailable}`,
			});
		return selected;
	}

	private async retainedHandle(record: CatalogRecord, handle: string): Promise<unknown> {
		const base = { sessionId: record.storageId, cwd: record.cwd, handle: `@${handle}`, created: false };
		if (record.view?.profileSeed)
			return {
				...base,
				profile: null,
				availability: "initializing",
				creation: {
					...record.view.profileSeed,
					name: record.name ?? null,
					model: record.model,
					thinkingLevel: record.thinkingLevel,
					cwd: record.cwd,
				},
			};
		const profile = (await this.observe(record, "profile-read", { sessionId: record.storageId })) as AgentProfile;
		if (profile.handle !== base.handle) throw new Error("Handle address belongs to a different retained agent");
		return { ...base, profile, availability: profile.live ? "live" : "retained" };
	}

	private async selectedHandle(input: AgentSpawnInput & { handle: string }, caller: AgentCaller, handle: string) {
		const previous = this.catalog.readHandle(handle);
		const bindsCwd = input.cwd !== undefined || input.prompt !== undefined;
		if (previous) {
			if (bindsCwd) assertHandleCwd(handle, canonicalAgentCwd(caller.cwd, input.cwd), previous.cwd);
			const selected = await this.reuseExecutionInput(input, caller, previous);
			return { selected, retained: previous, created: false };
		}
		const selected = this.executionInput(input, caller);
		const metadata = await this.creationMetadata(selected, caller);
		const { record: retained, created } = this.catalog.createHandled(metadata, handle, selected.role ?? "");
		if (!created) {
			if (bindsCwd) assertHandleCwd(handle, metadata.cwd, retained.cwd);
			const reused = await this.reuseExecutionInput(
				{ ...input, selection: undefined, preferenceSnapshot: selected.preferenceSnapshot },
				caller,
				retained,
			);
			return { selected: reused, retained, created };
		}
		selected.selection = effectiveExecutionSelection(selected.selection, retained.thinkingLevel);
		return { selected, retained, created };
	}

	private async spawnHandled(
		request: AgentSpawnInput & { handle: string },
		caller: AgentCaller,
		onCreated?: (row: AgentConversationSummary) => void,
	): Promise<unknown> {
		const handle = handleSlug(request.handle);
		const { selected: input, retained, created } = await this.selectedHandle(request, caller, handle);
		await caller.retainExecutionSelection?.(input.selection);
		const id = retained.storageId;
		const row: AgentConversationSummary = {
			id,
			storageId: id,
			cwd: retained.cwd,
			name: retained.name,
			model: { ...retained.model, thinkingLevel: retained.thinkingLevel },
			modifiedAt: Date.parse(retained.createdAt),
			owner: "unknown",
			state: "starting",
			cost: 0,
			partial: false,
		};
		if (!created && input.prompt === undefined) {
			onCreated?.(row);
			return { ...((await this.retainedHandle(retained, handle)) as object), selection: input.selection };
		}
		const requestId = input.requestId ?? randomUUID();
		const client = await this.connection(retained);
		const profile = (await client.request("profile-read", { sessionId: id })) as AgentProfile;
		if (profile.handle !== `@${handle}`) throw new Error("Handle address belongs to a different retained agent");
		onCreated?.(row);
		const admission = await this.submitSpawnPrompt(client, id, caller, input, requestId, "followUp");
		const result = admission === undefined ? undefined : await this.sentWorkResult(caller.id, id, admission, requestId);
		this.rosterChanged();
		return {
			sessionId: id,
			cwd: retained.cwd,
			handle: `@${handle}`,
			created,
			profile,
			selection: input.selection,
			...(created ? this.spawnThinking(input, retained) : {}),
			...(admission === undefined ? {} : { admission, result }),
		};
	}

	private async creationMetadata(
		input: AgentSpawnInput,
		caller: AgentCaller,
	): Promise<Omit<HostMetadata, "storageId" | "storagePath">> {
		const cwd = canonicalAgentCwd(caller.cwd, input.cwd);
		const separator = input.model?.indexOf("/") ?? -1;
		const model =
			input.model !== undefined && separator > 0
				? { provider: input.model.slice(0, separator), modelId: input.model.slice(separator + 1) }
				: undefined;
		if (!model?.modelId) throw new Error("Creation requires a resolved exact provider/model");
		const thinkingLevel = input.thinkingLevel ?? "off";
		const validate = caller.validateModel ?? this.options.validateModel;
		if (!validate) throw new Error("Spawn requires the caller's configured model catalog");
		const effective = await validate(model, thinkingLevel);
		return {
			cwd,
			model,
			thinkingLevel: effective ?? thinkingLevel,
			name: input.name,
			trust: input.trust,
			ownerId: caller.id,
			agentDir: this.options.agentDir,
			packageDir: this.options.packageDir,
		};
	}

	/** Admit independent contributed work without adopting its link or subscribing the primary. */
	launchIndependent(input: IndependentCommandInput): Promise<IndependentCommandReceipt> {
		if (this.shuttingDown) throw new Error("Agent manager is closed");
		const primary = this.primaries.get(input.creatorId);
		const askPrimary = primary?.promptTrust?.bind(primary);
		return launchIndependentCommand(input, {
			root: this.options.root,
			agentDir: this.options.agentDir,
			packageDir: this.options.packageDir,
			...(this.options.acquire === undefined ? {} : { acquire: this.options.acquire }),
			...(askPrimary === undefined ? {} : { askPrimary }),
		});
	}

	async spawn(
		input: AgentSpawnInput,
		caller: AgentCaller,
		onCreated?: (row: AgentConversationSummary) => void,
	): Promise<unknown> {
		if (input.handle !== undefined) return this.spawnHandled({ ...input, handle: input.handle }, caller, onCreated);
		return this.spawnIndependent(input, caller, onCreated);
	}

	private async spawnIndependent(
		input: AgentSpawnInput,
		caller: AgentCaller,
		onCreated?: (row: AgentConversationSummary) => void,
		reserveBinding?: (storageId: string) => () => void,
	): Promise<unknown> {
		if (input.role !== undefined) profileText(input.role, "role");
		const previous = input.requestId === undefined ? undefined : this.catalog.readRequest(caller.id, input.requestId);
		if (
			previous &&
			((input.cwd !== undefined && realpathSync(resolve(caller.cwd, input.cwd)) !== previous.cwd) ||
				input.name !== previous.name)
		)
			throw new Error("Spawn request ID already belongs to different agent configuration");
		const selected = this.executionInput(input, caller);
		input = selected;
		const metadata = previous ?? (await this.creationMetadata(input, caller));
		const { cwd, model, thinkingLevel } = metadata;
		const selection = input.selection?.thinking
			? selected.selection
			: effectiveExecutionSelection(selected.selection, thinkingLevel);
		input = { ...selected, selection };
		await caller.retainExecutionSelection?.(selection);
		let publishBinding: (() => void) | undefined;
		const reserve = (storageId: string) => {
			publishBinding = reserveBinding?.(storageId);
		};
		if (previous) reserve(previous.storageId);
		const { record, created } = previous
			? { record: previous, created: false }
			: this.catalog.createTracked(metadata, input.requestId, reserve);
		const row: AgentConversationSummary = {
			id: record.storageId,
			storageId: record.storageId,
			cwd,
			name: input.name,
			firstMessage: input.prompt,
			model: { ...model, thinkingLevel },
			modifiedAt: Date.parse(record.createdAt),
			owner: "unknown",
			state: "starting",
			cost: 0,
			partial: false,
		};
		return this.performSpawn(record, created, row, input, caller, onCreated, publishBinding);
	}

	private spawnThinking(
		input: AgentSpawnInput,
		record: CatalogRecord,
	): { thinking?: { requested: string; effective: string } } {
		const requested = input.thinkingLevel ?? "off";
		return requested === record.thinkingLevel ? {} : { thinking: { requested, effective: record.thinkingLevel } };
	}

	private async saveSpawnRole(
		client: HostConnection,
		sessionId: string,
		created: boolean,
		role: string | undefined,
		requestId: string,
		senderIdentity: string,
	): Promise<void> {
		if (role === undefined) return;
		const profile = (await client.request("profile-read", { sessionId })) as AgentProfile;
		if (profile.role === role || (!created && profile.role !== "")) return;
		const update = (await client.request("profile-update", {
			sessionId,
			role,
			expectedRevision: profile.revision,
			requestId: `spawn-role:${requestId}`,
			senderIdentity,
		})) as { outcome: string };
		if (update.outcome !== "applied")
			throw new Error(
				"The new agent's role changed before its creation role was saved; read agent_profile before retrying",
			);
	}

	private submitSpawnPrompt(
		client: HostConnection,
		sessionId: string,
		caller: AgentCaller,
		input: AgentSpawnInput,
		requestId: string,
		whenBusy?: "followUp",
	): Promise<unknown> | undefined {
		const message = input.prompt;
		if (message === undefined) return undefined;
		const origin = input.origin ?? "operator";
		return this.admission(caller.id, sessionId, requestId, undefined, () =>
			client.request("task-submit", {
				sessionId,
				message,
				requestId,
				requester: caller.id,
				origin,
				...(whenBusy === undefined ? {} : { whenBusy }),
				checkInMinutes: checkInMinutes(input.checkInMinutes, origin, this.options.agentDir),
			}),
		);
	}

	private async performSpawn(
		record: CatalogRecord,
		created: boolean,
		row: AgentConversationSummary,
		input: AgentSpawnInput,
		caller: AgentCaller,
		onCreated?: (row: AgentConversationSummary) => void,
		publishBinding?: () => void,
	): Promise<unknown> {
		this.launchRows.set(record.storageId, row);
		try {
			const requestId = input.requestId ?? randomUUID();
			const opening = this.connection(record);
			onCreated?.(row);
			this.rosterChanged();
			let client: HostConnection;
			try {
				client = await opening;
			} catch (error) {
				if (created) this.catalog.discardUnopened(record);
				throw error;
			}
			const versionError =
				input.prompt === undefined ? undefined : hostRequestVersionError("task-submit", client.runtimeContract);
			if (versionError) throw versionError;
			await this.saveSpawnRole(client, record.storageId, created, input.role, requestId, caller.id);
			publishBinding?.();
			const admission = await this.submitSpawnPrompt(client, record.storageId, caller, input, requestId);
			const outcome = {
				sessionId: record.storageId,
				cwd: record.cwd,
				selection: input.selection,
				...this.spawnThinking(input, record),
				lifetime: "independent host process",
				...(admission === undefined
					? {}
					: { admission, result: await this.sentWorkResult(caller.id, record.storageId, admission, requestId) }),
			};
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

	private nativeControlParams(
		method: string,
		input: Record<string, unknown>,
		sessionId: string,
		callerId: string,
	): Record<string, unknown> {
		const params: Record<string, unknown> = { ...definedFields(input), sessionId, ownerId: callerId };
		if (method === "task-submit") {
			params.requester = callerId;
			params.origin ??= "operator";
			params.requestId ??= randomUUID();
		}
		if (method === "profile-update") {
			params.senderIdentity = callerId;
			params.requestId ??= randomUUID();
		}
		return params;
	}

	/**
	 * `options.signal` withdraws the caller's wait for the answer: the client settles at once and a late
	 * answer is dropped. The host still runs an admitted request; nothing is rolled back or replayed.
	 * `options.launch: false` uses only a running host or a launch this manager already owns, and
	 * fails instead of starting one.
	 */
	async control(
		method: string,
		input: Record<string, unknown>,
		caller: AgentCaller,
		options?: { readonly signal?: AbortSignal; readonly launch?: boolean },
	): Promise<unknown> {
		options?.signal?.throwIfAborted();
		const work = abortable(this.resolveControl(method, input, caller, options), options?.signal);
		if (method !== "abort" && method !== "release") return work;
		return work.catch((error: unknown) => {
			if (options?.signal?.aborted !== true) throw error;
			// Keep the abort identity for callers that classify cancellation; replace only the text the model reads.
			const cancelled = new Error(unconfirmedStopText(String(input.sessionId ?? ""), "cancelled"), { cause: error });
			cancelled.name = "AbortError";
			throw cancelled;
		});
	}

	private async resolveControl(
		method: string,
		input: Record<string, unknown>,
		caller: AgentCaller,
		options?: { readonly signal?: AbortSignal; readonly launch?: boolean },
	): Promise<unknown> {
		const selector = String(input.sessionId ?? "");
		const sessionId = await this.resolveTarget(selector, options?.signal);
		if (typeof input.replyTo === "string")
			input = { ...input, replyTo: await this.resolveReplyTo(input.replyTo, options?.signal) };
		options?.signal?.throwIfAborted();
		if (
			sessionId === caller.id &&
			["abort", "release", "interrupt-continue", "fork", "rewind", "compact", "configure", "command"].includes(method)
		)
			throw new Error("This control cannot target the calling primary session");
		let record: CatalogRecord;
		try {
			record = this.nativeTarget(sessionId);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!readPrimaryEndpointDescriptor(this.options.root, sessionId).info)
				throw new Error("The exact native target is not retained and no ordinary primary is registered");
			return this.primaryControl(method, input, sessionId, caller);
		}
		({ method, input } = durableTargetInput(method, input, caller.id, caller.name));
		if (isThreadStorage(record, this.catalog.root) && !threadStorageServes(method, input))
			throw new Error(threadStorageRefusal(record.storageId, String(record.ownerId)));
		const params = this.nativeControlParams(method, input, sessionId, caller.id);
		if (["inspect", "status", "snapshot", "dashboard", "profile-read"].includes(method))
			return this.observe(record, method, params, undefined, options?.signal);
		if (method === "attach") {
			this.crashes.delete(record.storageId);
			this.launchFailures.clear(record.storageId);
			this.recoveryErrors.delete(record.storageId);
			this.failures.delete(record.storageId);
		}
		return this.selectedControl(record, method, params, caller, selector, options?.signal, options?.launch ?? true);
	}

	/** An answer route to a thread storage would address agent input to it. */
	private async resolveReplyTo(selector: string, signal: AbortSignal | undefined): Promise<string> {
		const replyTo = await this.resolveTarget(selector, signal);
		const owner = this.catalog.threadStorageOwner(replyTo);
		if (owner !== undefined) throw new Error(threadStorageRecipientRefusal("replyTo", replyTo, owner));
		return replyTo;
	}

	private async selectedControl(
		record: CatalogRecord,
		method: string,
		params: Record<string, unknown>,
		caller: AgentCaller,
		selector: string,
		signal: AbortSignal | undefined,
		launch: boolean,
	): Promise<unknown> {
		if (method === "interrupt-continue") {
			const client = await this.observationConnection(record);
			if (!client) throw new Error("Interrupt requires a running host; no work was stopped");
			return this.controlClient(client, method, params, caller, signal);
		}
		if (method === "abort" || method === "release")
			return this.abortControl(record, params, caller, signal, launch, method);
		try {
			return await this.controlClient(await this.connection(record, undefined, launch), method, params, caller, signal);
		} catch (error) {
			if (method !== "configure" || !selector.startsWith("@")) throw error;
			throw new Error(`Configure of ${String(params.sessionId)} (${selector}) failed: ${errorText(error)}`, {
				cause: error,
			});
		}
	}

	/**
	 * Stop a live host in place. A cold storage gets only an exclusive stop writer, never an executing host.
	 */
	private async abortControl(
		target: CatalogRecord,
		params: Record<string, unknown>,
		caller: AgentCaller,
		signal: AbortSignal | undefined,
		launch: boolean,
		method: "abort" | "release",
	): Promise<unknown> {
		if (method === "release" && params.background === true)
			throw new Error("release cannot be combined with background");
		const running = await this.observationConnection(target);
		if (running !== undefined) return this.controlClient(running, method, params, caller, signal);
		if (!launch) throw new HostEndpointUnavailableError(target.storageId, new Error("this abort may not start a host"));
		signal?.throwIfAborted();
		const reply = await (this.options.stopCold ?? stopColdStorage)(
			hostMetadata(target, this.options.packageDir),
			String(params.sessionId),
			params.background === true,
		);
		if ("result" in reply) {
			const aborted = {
				...reply.result,
				cold: true,
				started:
					"A stop writer marked the retained work and exited. No host was started. Pending abort handlers settle on normal recovery.",
			};
			return method === "release" ? { aborted, retiring: true, blockers: [], writesPlaced: 0 } : aborted;
		}
		// A competing writer won the lease. Stop it in place; never launch or retire it on this evidence.
		const owner = await this.connection(target, undefined, false);
		return this.controlClient(owner, method, params, caller, signal);
	}

	private requestedOperation(method: string, params: Record<string, unknown>): string {
		if (method === "submit") return "task-submit";
		if (method === "report") return "submit";
		if (method === "attach") return params.model === undefined ? "status" : "configure";
		return method;
	}

	/** A primary keeps the admission phases of its answer-bearing request; a fact that is not saved never changes the host call. */
	private admission<T>(
		ownerId: string,
		sessionId: string,
		requestId: string,
		replyTo: unknown,
		call: () => Promise<T>,
	): Promise<T> {
		const primary = this.primaries.get(ownerId);
		const record =
			primary?.retainContinuity === undefined
				? undefined
				: (fact: ContinuityFact): void => {
						try {
							primary.retainContinuity?.(fact);
						} catch (error) {
							this.failures.set(
								`continuity:${ownerId}`,
								`An admission fact was not saved; the continuity note after a compaction can omit or misstate this request. ${errorText(error)}`,
							);
						}
					};
		return recordAdmission(record, { ownerId, sessionId, requestId, replyTo }, call);
	}

	/** Report or clear the state of a primary's continuity note in the status overview. */
	continuityNoteFailure(ownerId: string, text: string | undefined): void {
		if (text === undefined) this.failures.delete(`continuity-note:${ownerId}`);
		else this.failures.set(`continuity-note:${ownerId}`, text);
	}

	/** Only the plain forwarded request carries the caller's withdrawal; task submission keeps its own admission path. */
	private forwardControl(
		client: HostConnection,
		method: string,
		requested: string,
		params: Record<string, unknown>,
		caller: AgentCaller,
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		if (requested === "task-submit")
			return this.admission(caller.id, String(params.sessionId), String(params.requestId), params.replyTo, () =>
				client.request(requested, { ...params, requester: caller.id, origin: params.origin ?? "operator" }),
			);
		return client.request(method, params, signal ? { signal } : undefined);
	}

	private async controlClient(
		client: HostConnection,
		method: string,
		params: Record<string, unknown>,
		caller: AgentCaller,
		signal?: AbortSignal,
	): Promise<unknown> {
		const sessionId = String(params.sessionId);
		const requested = this.requestedOperation(method, params);
		const versionError = hostRequestVersionError(requested, client.runtimeContract);
		if (versionError) throw versionError;
		if (method === "attach") return this.attachClient(client, sessionId, params.model);
		if (method === "report") {
			const receipt = await client.request("submit", {
				sessionId,
				message: `Report from ${caller.id}:\n${String(params.message ?? "")}`,
				requestId: params.requestId ?? randomUUID(),
				whenBusy: "followUp",
				inputClass: "report",
				inputSender: caller.id,
			});
			return { ...(receipt as Record<string, unknown>), boundary: REPORT_DELIVERY_BOUNDARY };
		}
		if (["submit", "rewind", "fork"].includes(method)) params.requestId ??= randomUUID();
		const outcome = await this.forwardControl(client, method, requested, params, caller, signal);
		if (requested === "task-submit")
			return {
				...(outcome as object),
				result: await this.sentWorkResult(caller.id, sessionId, outcome, String(params.requestId)),
			};
		const values = record(outcome);
		if (
			(method === "rewind" && Number.isSafeInteger(values.submissionId) && Number(values.submissionId) > 0) ||
			(method === "timer-schedule" && Number.isSafeInteger(values.timerId) && Number(values.timerId) > 0)
		)
			this.rememberSentWork(caller.id, values.identity);
		return ["fork", "rewind", "configure"].includes(method)
			? this.mutationSnapshot(client, outcome, sessionId)
			: outcome;
	}

	private async attachClient(client: HostConnection, sessionId: string, model: unknown): Promise<unknown> {
		if (model !== undefined) {
			const outcome = await client.request("configure", { sessionId, model });
			if ((outcome as { outcome?: string })?.outcome === "failed") return outcome;
		}
		return {
			sessionId,
			status: compactStatus(await client.request("status", { sessionId })),
			recovery: "retained work resumes; no new input was submitted",
		};
	}

	/** Retained ordinary evidence never connects to a peer or acquires a Durable host. */
	async observePrimary(sessionId: string, input: Record<string, unknown> = {}): Promise<OrdinaryPrimaryObservation> {
		const exactCursor = (input.cursor as { view?: unknown } | undefined)?.view === "exact";
		// An exact cursor selects its view; the native tool fills an omitted view with "history".
		const view =
			exactCursor && (input.view === undefined || input.view === "history") ? "exact" : (input.view ?? "activity");
		if (view === "exact" && !exactCursor)
			throw new Error(
				"Ordinary primary exact inspection requires the textCursor of a clipped entry, or a nextCursor from an exact page, as cursor.",
			);
		if (view !== "status" && view !== "activity" && view !== "history" && view !== "exact")
			throw new Error(
				"Ordinary primary inspection supports activity, history and cursor-selected exact pages only; native branch, search and result views are unavailable.",
			);
		for (const key of [
			"entryId",
			"fromId",
			"offset",
			"query",
			"source",
			"submissionId",
			"operationId",
			"receiptCursor",
			"finalReport",
		]) {
			if (input[key] !== undefined)
				throw new Error(
					`Ordinary primary inspection does not support ${key}; use its returned cursor for retained ancestry.`,
				);
		}
		const descriptor = readPrimaryEndpointDescriptor(this.options.root, sessionId);
		if (!descriptor.info)
			throw new Error(
				`Ordinary primary observation is unavailable: ${descriptor.unreadable ? "endpoint unreadable" : descriptor.state}. No peer was contacted.`,
			);
		return readPrimaryObservation(descriptor.info, {
			view,
			limit: input.limit as number | undefined,
			cursor: input.cursor,
		});
	}

	private async primaryControl(
		method: string,
		input: Record<string, unknown>,
		sessionId: string,
		caller: AgentCaller,
	): Promise<unknown> {
		if (method === "status" || method === "inspect")
			return this.observePrimary(sessionId, method === "status" ? { view: "status" } : input);
		if (method === "collaboration-mutate")
			throw new Error(
				"Threads of an ordinary primary live in that primary's own thread storage; repeat agent_collaborate create without sessionId to create the thread in your own thread storage",
			);
		return this.primaryMessage(method, input, sessionId, caller);
	}

	private async primaryMessage(
		method: string,
		input: Record<string, unknown>,
		sessionId: string,
		caller: AgentCaller,
	): Promise<unknown> {
		const channel = await connectPrimaryChannel({ id: sessionId, sessionsRoot: this.options.root });
		try {
			if (method !== "submit" && method !== "report")
				throw new Error("A registered primary accepts messages, not Durable session controls");
			const sourceId = typeof input.requestId === "string" ? input.requestId : randomUUID();
			const origin: DeliveryOrigin = input.origin === "operator" ? "operator" : "model";
			const sender = this.primaryChannels.get(caller.id)?.info();
			const name = "name" in caller ? caller.name : sender?.name;
			const observedPurpose = caller.observedPurpose ?? sender?.observedPurpose;
			const question = peerQuestionFields(input, method, sourceId);
			const text = peerMessageText(String(input.message ?? ""), question, caller.id, name);
			await channel.deliver({
				sourceId,
				requireRetained: false,
				text,
				details: {
					...question,
					kind: method === "report" ? "report" : "message",
					senderKind: "session",
					senderIdentity: caller.id,
					source: sourceId,
					liveOwner: true,
					saved: false,
					origin,
					wake: origin !== "operator",
					...(name === undefined ? {} : { name }),
					...(observedPurpose === undefined ? {} : { observedPurpose: observedPurpose.text }),
					...(caller.model === undefined ? {} : { provider: caller.model.provider, modelId: caller.model.modelId }),
					...(caller.thinkingLevel === undefined ? {} : { thinkingLevel: caller.thinkingLevel }),
				},
				...(typeof input.replyTo === "string" ? { replyTo: input.replyTo } : {}),
			});
			return {
				sessionId,
				admitted: true,
				sourceId,
				...questionReceipt(question),
				boundary:
					"The recipient retained the message for delivery. Admission does not prove placement, action, or task acceptance.",
			};
		} finally {
			await channel.close();
		}
	}

	private async mutationSnapshot(client: HostConnection, outcome: unknown, sessionId: string): Promise<unknown> {
		if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) return outcome;
		const values = outcome as Record<string, unknown>;
		const target = typeof values.identity === "string" ? values.identity : sessionId;
		try {
			return { ...values, status: compactStatus(await client.request("status", { sessionId: target })) };
		} catch (error) {
			return { ...values, snapshotError: errorText(error) };
		}
	}

	async place(input: AgentSpawnInput & { area?: string; topic?: string }, caller: AgentCaller): Promise<unknown> {
		if (input.prompt === "") input = { ...input, prompt: undefined };
		const area = realpathSync(resolve(caller.cwd, input.area ?? "."));
		if (!statSync(area).isDirectory()) throw new Error("Place area must be a directory");
		const result = await this.places.withArea(area, async (existing, reserve) => {
			if (existing) {
				const { sessionId } = existing;
				const selected = await this.reuseExecutionInput(input, caller, this.catalog.read(sessionId), sessionId);
				await caller.retainExecutionSelection?.(selected.selection);
				const response = selected.prompt
					? await this.control(
							"submit",
							{
								sessionId,
								message: selected.prompt,
								checkInMinutes: checkInMinutes(
									selected.checkInMinutes,
									selected.origin ?? "operator",
									this.options.agentDir,
								),
								...(selected.requestId === undefined ? {} : { requestId: selected.requestId }),
								...originParams(selected.origin),
							},
							caller,
						)
					: await this.control("attach", { sessionId }, caller);
				return { ...(response as object), sessionId, selection: selected.selection };
			}
			const created = (await this.spawnIndependent(
				{
					preset: input.preset,
					selection: input.selection,
					preferenceSnapshot: input.preferenceSnapshot,
					model: input.model,
					thinkingLevel: input.thinkingLevel,
					cwd: area,
					name: input.topic,
					prompt: input.prompt,
					trust: input.trust,
					checkInMinutes: input.checkInMinutes,
					...(input.requestId === undefined ? {} : { requestId: input.requestId }),
					...originParams(input.origin),
				},
				caller,
				undefined,
				(storageId) => reserve(storageId, input.topic),
			)) as { sessionId: string; admission?: object };
			// First use and reuse expose the same top-level admission facts to native place replay.
			return { ...created.admission, ...created };
		});
		return result.value;
	}

	private listCursor(input: { cursor?: string; query?: string; cwd?: string }): ListCursor {
		const query = input.query ?? "";
		const cwd = input.cwd ?? "";
		if (input.cursor === undefined) return { query, cwd, pass: "candidates", since: Date.now() };
		let parsed: Partial<ListCursor> | null;
		try {
			parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Partial<ListCursor> | null;
		} catch {
			parsed = null;
		}
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			(parsed.pass !== "candidates" && parsed.pass !== "remainder") ||
			typeof parsed.since !== "number" ||
			!Number.isFinite(parsed.since)
		)
			throw new Error("List cursor is not an agent_list continuation; restart discovery without a cursor");
		if (parsed.query !== query || parsed.cwd !== cwd) throw new Error("Repeat the same query and cwd with the cursor");
		return {
			query,
			cwd,
			pass: parsed.pass,
			since: parsed.since,
			...(typeof parsed.after === "string" ? { after: parsed.after } : {}),
			...(typeof parsed.storage === "string" ? { storage: parsed.storage } : {}),
			...(parsed.native === undefined ? {} : { native: parsed.native }),
			...(parsed.unavailable === true ? { unavailable: true } : {}),
		};
	}

	private async collectListPage(
		record: CatalogRecord,
		cursor: ListCursor,
		limit: number,
		rows: unknown[],
		unavailable: Array<{ storageId: string; reason: string }>,
	): Promise<void> {
		try {
			const page = (await this.observe(record, "list", {
				limit,
				...(cursor.native === undefined ? {} : { cursor: cursor.native }),
			})) as ConversationPage;
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

	/** The storages the current pass still has to observe; a storage page in progress comes first. */
	private listQueue(plan: ListScanPlan, cursor: ListCursor, facts: CatalogInventory["facts"]): ListScanStep[] {
		const steps = cursor.pass === "candidates" ? plan.candidates : plan.remainder;
		const position = cursor.storage ?? cursor.after;
		const queue =
			position === undefined
				? steps
				: steps.filter((step) => compareListStorages(facts, cursor.query, step.storageId, position) > 0);
		if (cursor.storage === undefined) return queue;
		return [{ storageId: cursor.storage, record: facts.get(cursor.storage)?.record }, ...queue];
	}

	/** Spend one step per native page or unreadable record, across both passes. */
	private async observeListSteps(
		queue: ListScanStep[],
		cursor: ListCursor,
		limit: number,
		rows: unknown[],
		unavailable: Array<{ storageId: string; reason: string }>,
		progress: { steps: number; visits: number; finished: Set<string> },
	): Promise<number> {
		let index = 0;
		while (index < queue.length && rows.length < limit && progress.steps < MAX_LIST_STEPS) {
			const step = queue[index];
			progress.steps++;
			if (step.record) {
				cursor.storage = step.storageId;
				progress.visits++;
				await this.collectListPage(step.record, cursor, limit - rows.length, rows, unavailable);
				if (cursor.native !== undefined) continue;
				progress.finished.add(step.storageId);
			} else {
				unavailable.push({ storageId: step.storageId, reason: "Catalog record could not be read" });
				cursor.native = undefined;
			}
			cursor.storage = undefined;
			cursor.after = step.storageId;
			index++;
		}
		return queue.length - index;
	}

	async list(input: { cursor?: string; query?: string; cwd?: string; limit?: number } = {}): Promise<unknown> {
		const limit = input.limit ?? 10;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("List limit must be between 1 and 20");
		const cursor = this.listCursor(input);
		const rows: unknown[] = [];
		const unavailable: Array<{ storageId: string; reason: string }> = [];
		// One inventory reading orders the whole call; observations can rewrite catalog records.
		const inventory = this.withoutThreadStorages(await this.inventory.read());
		const plan = planListScan(inventory.facts, cursor.query, cursor.cwd, cursor.since);
		const progress = { steps: 0, visits: 0, finished: new Set<string>() };
		let open = await this.observeListSteps(
			this.listQueue(plan, cursor, inventory.facts),
			cursor,
			limit,
			rows,
			unavailable,
			progress,
		);
		// The remainder pass repeats no storage that this call finished as a candidate.
		const remainder = plan.remainder.filter((step) => !progress.finished.has(step.storageId));
		if (open === 0 && cursor.pass === "candidates" && remainder.length > 0) {
			cursor.pass = "remainder";
			cursor.after = undefined;
			open = await this.observeListSteps(remainder, cursor, limit, rows, unavailable, progress);
		}
		const visits = progress.visits;
		const pending = open + (cursor.pass === "candidates" ? remainder.length : 0);
		const complete = pending === 0;
		if (unavailable.length > 0) cursor.unavailable = true;
		const nextCursor = complete ? null : Buffer.from(JSON.stringify(cursor)).toString("base64url");
		const next =
			nextCursor === null
				? null
				: {
						tool: "agent_list" as const,
						...(input.query === undefined ? {} : { query: input.query }),
						...(input.cwd === undefined ? {} : { cwd: input.cwd }),
						...(input.limit === undefined ? {} : { limit }),
						cursor: nextCursor,
					};
		const coverage = {
			complete,
			storagesVisited: visits,
			unavailable,
			profileHints: plan.profileHints,
			catalog: { storages: plan.storages, pass: cursor.pass, pending, settled: plan.settled },
			basis: listCoverageBasis({
				query: cursor.query,
				pass: cursor.pass,
				pending,
				settled: plan.settled,
				unavailable: cursor.unavailable === true,
			}),
			next,
		};
		return {
			rows,
			nextCursor,
			coverage,
			observedAt: new Date().toISOString(),
			authority: "Observation grants no control or task authority",
		};
	}

	async dashboardPage(input: { cursor?: string; ownerId?: string } = {}): Promise<AgentPriorityPage> {
		return this.priorityPage(input, {});
	}

	/** Agent views omit thread storages; recovery and thread discovery still read them. */
	private withoutThreadStorages(inventory: CatalogInventory): CatalogInventory {
		const facts = new Map<string, CatalogFact | null>();
		for (const [storageId, fact] of inventory.facts)
			if (!fact || !isThreadStorage(fact.record, this.catalog.root)) facts.set(storageId, fact);
		return facts.size === inventory.facts.size ? inventory : { ...inventory, facts };
	}

	private async priorityPage(
		input: { cursor?: string; ownerId?: string },
		read: { reconcileAfterMs?: number },
	): Promise<AgentPriorityPage> {
		const rows: AgentPrioritySummary[] = [];
		const inventory = this.withoutThreadStorages(await this.inventory.read(read));
		const activeStorageIds = [...new Set([...this.launchRows.keys(), ...this.opening.keys(), ...this.recovering])];
		const page = projectCatalogPriority(inventory, {
			cursor: input.cursor,
			ownerIds: input.ownerId ? [input.ownerId] : [...this.primaries.keys()],
			activeStorageIds,
			hasCurrentPublication: ({ record, claim }) =>
				this.observedCatalogOwner(record.storageId, claim).publication !== undefined,
			limit: MAX_INVENTORY_PAGES * 20,
		});
		const coverage = {
			complete: page.nextCursor === null && page.coverage.remaining === 0 && page.coverage.unreadable === 0,
			storagesVisited: page.coverage.inspected,
			skipped: page.coverage.unreadable,
			omitted: 0,
			nextCursor: page.nextCursor,
			inventory: page.coverage,
			projections: {} as Record<string, { skipped: number; omitted: number; unresolvedClaim: boolean }>,
			unresolvedClaims: 0,
		};
		for (const { record, modifiedAt, priority, claim, observedAt } of page.items) {
			const projection = this.catalogRows(record, claim, observedAt);
			coverage.skipped += projection.skipped;
			if (!projection.resolvedClaim) coverage.unresolvedClaims++;
			coverage.omitted += projection.omitted;
			coverage.projections[record.storageId] = {
				skipped: projection.skipped,
				omitted: projection.omitted,
				unresolvedClaim: !projection.resolvedClaim,
			};
			const recoveryError = this.recoveryErrors.get(record.storageId);
			const note = this.recoveryNotes.get(record.storageId);
			rows.push(
				...projection.rows.map((row) => ({
					...row,
					rosterOrder: { priority, modifiedAt },
					...(record.ownerId ? { creatingOwnerId: record.ownerId } : {}),
					...(note === undefined ? {} : { ownerLabel: `${note} ${row.ownerLabel ?? ""}`.trim() }),
					...(recoveryError === undefined ? {} : { health: { ...row.health, lastError: recoveryError } }),
				})),
			);
		}
		coverage.complete &&= coverage.unresolvedClaims === 0 && coverage.skipped === 0 && coverage.omitted === 0;
		return { rows, coverage, observedAt: page.observedAt };
	}

	private observedCatalogOwner(storageId: string, claim: ClaimObservation): ReturnType<typeof catalogOwner> {
		const connection = this.clients.get(storageId) ?? this.recoveryClients.get(storageId)?.client;
		return catalogOwner(storageId, claim, connection?.ownerEvidence);
	}

	private catalogRows(
		record: CatalogRecord,
		observedClaim: ClaimObservation,
		observedAt: string,
	): { rows: AgentConversationSummary[]; skipped: number; omitted: number; resolvedClaim: boolean } {
		const owner = this.observedCatalogOwner(record.storageId, observedClaim);
		const { publication, resolvedClaim } = owner;
		const starting = this.launchRows.get(record.storageId);
		const view = publication ?? record.view;
		if (starting) {
			const published = view?.rows.find((row) => row.id === record.storageId);
			if (
				this.opening.has(record.storageId) ||
				!published ||
				view?.unavailable ||
				(starting.firstMessage && !published.firstMessage)
			)
				return { rows: [starting], skipped: 0, omitted: 0, resolvedClaim };
			this.launchRows.delete(record.storageId);
		}
		if (!view || view.unavailable) {
			return {
				skipped: 1,
				omitted: 0,
				resolvedClaim,
				rows: [
					{
						id: record.storageId,
						storageId: record.storageId,
						cwd: record.cwd,
						name: record.name,
						modifiedAt: Date.parse(view?.updatedAt ?? record.createdAt),
						owner: claimOwner(observedClaim),
						state: "unavailable",
						cost: 0,
						partial: true,
						error: view?.unavailable ?? "Host metadata is unavailable; inspect this conversation for native state",
					},
				],
			};
		}
		const rows = publishedRows(view, observedAt, owner);
		return { rows, skipped: view.coverage.complete ? 0 : 1, omitted: view.coverage.omitted, resolvedClaim };
	}

	async snapshot(
		sessionId: string,
		params: { before?: number; limit?: number; maxBytes?: number } = {},
	): Promise<ConversationSnapshotPage> {
		sessionId = await this.resolveTarget(sessionId);
		if (this.launchRows.has(storageIdOf(sessionId)) && this.opening.has(storageIdOf(sessionId))) {
			const { emptyConversationSnapshot } = await loadDurableObservation();
			return emptyConversationSnapshot();
		}
		return this.observe(this.nativeTarget(sessionId), "snapshot", {
			sessionId,
			...params,
		}) as Promise<ConversationSnapshotPage>;
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
		const record = this.nativeTarget(sessionId);
		return (async () => {
			const client = await this.observationConnection(record);
			if (!client?.observe || signal?.aborted) return undefined;
			const versionError = hostRequestVersionError("observe-open", client.runtimeContract);
			if (versionError) throw versionError;
			const observationScope: HostObservationScope =
				scope === "tasks" ? { scope: "tasks", sessionId: record.storageId } : { scope: "conversation", sessionId };
			const observation = await client.observe(observationScope, { ...(signal === undefined ? {} : { signal }) });
			const off = observation.onFrame(listener);
			return () => {
				off();
				void observation.close().catch(() => undefined);
			};
		})();
	}

	async collaborationTargets(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		validateCollaborationAction(input);
		const { collaborationIdentity } = await loadCollaboration();
		const params = { ...input };
		const resolveIdentity = async (value: unknown, field: string): Promise<string> => {
			let resolved = value;
			if (typeof value === "string" && value.startsWith("@")) {
				try {
					resolved = await this.resolveTarget(value);
				} catch (error) {
					throw new Error(
						`${field}: handle resolution failed: ${errorText(error)}. Call agent_list and copy a discovered identity into ${field}${field === "integrator" ? "; omit integrator to use the caller" : ""}`,
					);
				}
			}
			return collaborationIdentity(resolved, field);
		};
		// A notice to a thread storage, or a frame it integrates, would address agent input to it.
		const resolveParticipant = async (value: unknown, field: string): Promise<string> => {
			const identity = await resolveIdentity(value, field);
			const owner = this.catalog.threadStorageOwner(identity);
			if (owner !== undefined) throw new Error(threadStorageRecipientRefusal(field, identity, owner));
			return identity;
		};
		if (params.sessionId !== undefined) params.sessionId = await resolveIdentity(params.sessionId, "sessionId");
		if (params.integrator !== undefined) params.integrator = await resolveParticipant(params.integrator, "integrator");
		if (Array.isArray(params.notify))
			params.notify = await Promise.all(params.notify.map((id, index) => resolveParticipant(id, `notify[${index}]`)));
		return params;
	}

	/** Discovery uses published hints; scoped reads never acquire a storage writer. */
	async collaborate(input: Record<string, unknown>, caller: AgentCaller): Promise<unknown> {
		input = await this.collaborationTargets(input);
		const action = String(input.action ?? "");
		const threadId = typeof input.threadId === "string" ? input.threadId : undefined;
		const sessionId = this.collaborationAddress(input, action, threadId, caller);
		if (action === "list" && !sessionId) return discoverCollaboration(this.catalog, input);
		if (!sessionId) throw new Error("This action requires threadId");
		if (action === "list" || action === "read") return this.observeCollaboration(input, action, sessionId, caller);
		return this.control(
			"collaboration-mutate",
			{
				...input,
				sessionId,
				senderIdentity: caller.id,
				origin: input.origin ?? "model",
				requestId: input.requestId ?? randomUUID(),
			},
			caller,
		);
	}

	private async observeCollaboration(
		input: Record<string, unknown>,
		action: "list" | "read",
		sessionId: string,
		caller: AgentCaller,
	): Promise<unknown> {
		let target: CatalogRecord;
		try {
			target = this.nativeTarget(sessionId);
		} catch (error) {
			// Only a list that named an ordinary session selects a thread storage that may not exist yet.
			const session = typeof input.sessionId === "string" && input.threadId === undefined ? input.sessionId : sessionId;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (typeof input.threadId === "string")
				throw new Error(
					`Thread ${input.threadId} is not retained: its storage ${sessionId} no longer exists. Find current threads with agent_collaborate action list.`,
				);
			if (session === sessionId)
				throw new Error(`No retained storage ${sessionId}. Find current agents and threads with agent_list.`);
			if (session !== caller.id && !readPrimaryEndpointDescriptor(this.options.root, session).info)
				throw new Error("The exact native target is not retained and no ordinary primary is registered");
			return { items: [], nextCursor: null, coverage: { complete: true, visited: 0, omitted: 0 } };
		}
		return this.observe(target, action === "list" ? "collaboration-list" : "collaboration-read", {
			...input,
			sessionId,
		});
	}

	/**
	 * Create without a storage, or with the caller's own identity, uses the caller's own storage. A list
	 * that names an ordinary session reads that session's thread storage.
	 */
	private collaborationAddress(
		input: Record<string, unknown>,
		action: string,
		threadId: string | undefined,
		caller: AgentCaller,
	): string | undefined {
		if (threadId !== undefined) return collaborationStorage(threadId);
		const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
		if (action === "list" && sessionId !== undefined && !sessionId.includes(":") && !this.retainedNative(sessionId))
			return threadStorageId(sessionId, this.catalog.root);
		if (action !== "create" || (sessionId !== undefined && sessionId !== caller.id)) return sessionId;
		if (this.retainedNative(caller.id)) return sessionId ?? storageIdOf(caller.id);
		return this.ownThreadStorage(caller);
	}

	private retainedNative(identity: string): boolean {
		try {
			this.catalog.read(storageIdOf(identity));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * The caller's thread storage: an ordinary Durable record that holds threads and never runs
	 * agent work. Its host starts on the first mutation, like any participant storage.
	 */
	private ownThreadStorage(caller: AgentCaller): string {
		const storageId = threadStorageId(caller.id, this.catalog.root);
		try {
			this.catalog.read(storageId);
			return storageId;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (!caller.model)
			throw new Error(
				"Creating a thread storage needs this session's selected model; select a model and repeat create",
			);
		const name = `Threads of ${caller.name?.trim() || caller.id}`;
		// The record's own address: the catalog computes it after it made its directory, so it holds also
		// when the address above came from a catalog path that did not exist yet.
		return this.catalog.createThreadStorage({
			cwd: canonicalAgentCwd(caller.cwd),
			model: caller.model,
			thinkingLevel: "off",
			name: name.length > 120 ? `${name.slice(0, 119)}…` : name,
			trust: false,
			ownerId: caller.id,
			agentDir: this.options.agentDir,
			packageDir: this.options.packageDir,
		}).record.storageId;
	}

	private async selectedStatus(selector: string): Promise<unknown> {
		const sessionId = await this.resolveTarget(selector);
		let record: CatalogRecord;
		try {
			record = this.nativeTarget(sessionId);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return this.observePrimary(sessionId, { view: "status" });
		}
		return this.observe(record, "status", { sessionId });
	}

	async status(
		sessionId?: string | StorageStatusPageInput,
		view?: "fleet",
		caller?: AgentCaller,
		selection: FleetSelection = {},
	): Promise<unknown> {
		if (typeof sessionId === "object") {
			const input = storageStatusPageInput(sessionId);
			if (view !== undefined || Object.keys(selection).length !== 0)
				throw new Error("Storage status does not accept fleet selectors");
			return this.observe(this.nativeTarget(input.storageId), "status", { ...input });
		}
		validateFleetSelection({ ...selection, view, sessionId });
		if (view === "fleet") {
			return readFleetStatus(this.catalog, {
				...selection,
				...(caller ? { effort: { callerId: caller.id, callerUsage: caller.reportedUsage } } : {}),
			});
		}
		if (sessionId) return this.selectedStatus(sessionId);
		const page = await this.dashboardPage({ ownerId: caller?.id });
		const failures = [[...this.failures.entries].map(([storageId, error]) => ({ storageId, error }))].flat();
		const awareness = caller ? await this.awareness(caller.id, caller.cwd) : undefined;
		return buildStatusOverview(
			{ ...page, rows: page.rows.map(({ profile: _profile, creatingOwnerId: _creatingOwnerId, ...row }) => row) },
			[...this.primaries].map(([sessionId, primary]) => ({
				sessionId,
				cwd: primary.cwd ?? "",
				name: primary.name,
				model: primary.model,
				thinkingLevel: primary.thinkingLevel,
			})),
			failures,
			awareness,
		);
	}

	registerPrimary(ownerId: string, primary: PrimaryClient): Promise<void> {
		const registration = this.registerPrimaryChannel(ownerId, primary);
		const pending = this.registeringPrimaries.get(primary.signal) ?? new Map<string, Promise<void>>();
		pending.set(ownerId, registration);
		this.registeringPrimaries.set(primary.signal, pending);
		return registration.finally(() => {
			if (pending.get(ownerId) === registration) pending.delete(ownerId);
		});
	}

	/**
	 * Keep the channel of a session whose extension reloads published until the same session registers again,
	 * so no other session reads it as ended in between. Deliveries to it refuse as retryable meanwhile. Without
	 * a registration within the grace period, `owner` aborts and the registration ends. False when `owner` does
	 * not hold the session's registration.
	 */
	suspendPrimary(ownerId: string, owner: AbortController, graceMs = PRIMARY_RELOAD_GRACE_MS): boolean {
		const primary = this.primaries.get(ownerId);
		if (primary === undefined || primary.signal !== owner.signal || this.reloadingPrimaries.has(ownerId)) return false;
		const timer = setTimeout(() => {
			if (this.reloadingPrimaries.get(ownerId)?.primary === primary) this.reloadingPrimaries.delete(ownerId);
			owner.abort();
		}, graceMs);
		timer.unref?.();
		this.reloadingPrimaries.set(ownerId, { primary, timer });
		this.reloadedSignals.add(owner.signal);
		try {
			primary.status?.(undefined);
		} catch (error) {
			this.failures.set(`primary-status:${ownerId}`, errorText(error));
		}
		return true;
	}

	/** Delivery into one registration; a closed or reloading registration refuses, so the source retries. */
	private primaryDelivery(ownerId: string, primary: PrimaryClient): PrimaryChannelOptions["deliver"] {
		const deliveryScope = Symbol();
		return (message) => {
			if (this.stopping(primary) || this.primaries.get(ownerId) !== primary)
				throw new Error("Primary session is closed");
			if (this.reloadingPrimaries.get(ownerId)?.primary === primary)
				throw new Error("Primary session is reloading; the delivery stays unacknowledged for a retry");
			if (message.requireRetained === false) {
				primary.send(message.text, message.details, message.sourceId, false);
				return;
			}
			const key = `${ownerId}:retained:${message.sourceId}`;
			if (this.delivered.get(key) === deliveryScope) {
				primary.receiveRetainedReplay?.(message.details);
				return;
			}
			primary.send(message.text, message.details, message.sourceId, true);
			this.delivered.set(key, deliveryScope);
		};
	}

	/**
	 * End the session's earlier registration before a new one. A reloading registration stays until the new
	 * channel replaced its record in one rename; it is returned for the caller to close then.
	 */
	private async previousRegistration(ownerId: string): Promise<PrimaryClient | undefined> {
		const previous = this.primaries.get(ownerId);
		const reloading = this.reloadingPrimaries.get(ownerId);
		if (reloading !== undefined) {
			clearTimeout(reloading.timer);
			this.reloadingPrimaries.delete(ownerId);
			if (reloading.primary === previous) return previous;
		}
		if (previous) await this.closePrimary(ownerId, previous.signal);
		return undefined;
	}

	private async registerPrimaryChannel(ownerId: string, primary: PrimaryClient): Promise<void> {
		if (this.stopping(primary)) return;
		await this.closingPrimaries.get(ownerId);
		const replacing = await this.previousRegistration(ownerId);
		const releasePrevious = async () => {
			if (replacing !== undefined) await this.closePrimary(ownerId, replacing.signal);
		};
		const released = async (error: unknown): Promise<never> => {
			await releasePrevious().catch(() => {});
			throw error;
		};
		if (this.stopping(primary)) return releasePrevious();
		const location = await this.locations.resolve(primary.cwd ?? this.options.root).catch(released);
		if (this.stopping(primary)) return releasePrevious();
		const channel = await (this.options.createPrimary ?? createPrimaryChannel)({
			...(replacing === undefined ? {} : { replaceOwn: true }),
			id: ownerId,
			...location,
			lastActivityAt: new Date().toISOString(),
			observedPurpose: this.observedPurpose(primary),
			...(primary.workRefs?.length ? { workRefs: primary.workRefs } : {}),
			sessionFile: primary.sessionFile,
			name: primary.name,
			model: primary.model,
			thinkingLevel: primary.thinkingLevel,
			sessionsRoot: this.options.root,
			signal: primary.signal,
			promptTrust: (cwd) => primary.promptTrust?.(cwd) ?? Promise.resolve(undefined),
			deliver: this.primaryDelivery(ownerId, primary),
		}).catch(released);
		await releasePrevious();
		if (this.stopping(primary)) {
			await channel.close();
			return;
		}
		this.primaryClosures.get(primary.signal)?.delete(ownerId);
		this.primaryChannels.set(ownerId, channel);
		this.primaries.set(ownerId, primary);
		// References reported while the channel was opening reach the record now.
		const workRefs = primary.workRefs ?? [];
		if (JSON.stringify(workRefs) !== JSON.stringify(channel.info().workRefs ?? [])) {
			try {
				channel.setWorkRefs(workRefs);
			} catch (error) {
				this.failures.set(`primary:${ownerId}`, errorText(error));
			}
		}
		this.retainColdObservations();
		primary.signal.addEventListener(
			"abort",
			() => {
				void this.closePrimary(ownerId, primary.signal).catch(() => {});
			},
			{ once: true },
		);
		try {
			this.observeCatalogChanges();
		} catch (error) {
			this.failures.set(
				"catalog-observation",
				`Catalog updates are unavailable: ${errorText(error)}. Restart this Pi process.`,
			);
		}
		this.rosterChanged();
		primary.resumeInbox?.();
		await this.refreshFooter();
		await this.scanRecovery(primary, ownerId);
	}

	/** Availability changes, not source view publication, permit another parked wake. */
	private recipientAvailability(identity: string): string | undefined {
		try {
			const record = this.nativeTarget(identity);
			return nativeRecipientAvailability(record, this.options.packageDir);
		} catch {
			/* An ordinary primary has no native catalogue record. */
		}
		if (primaryEndpointStatus(this.options.root, identity).state !== "live") return undefined;
		const info = readPrimaryEndpointDescriptor(this.options.root, identity).info;
		return info === undefined
			? undefined
			: createHash("sha256")
					.update(JSON.stringify([info.pid, info.hostname, info.startedAt, info.socketPath]))
					.digest("hex");
	}

	private parkedWakeDue(record: CatalogRecord, registeringPrimary?: string, recheck = false): boolean {
		const wake = readDeliveryWake(this.options.root, record.storageId);
		if (wake === undefined) {
			this.wakeAttempts.delete(record.storageId);
			return false;
		}
		if (registeringPrimary !== undefined) {
			if (!wake.recipients.includes(registeringPrimary)) return false;
			if (wake.failedAvailability[registeringPrimary] === null) return true;
			const current = this.recipientAvailability(registeringPrimary);
			return current !== undefined && current !== wake.failedAvailability[registeringPrimary];
		}
		const previous = this.wakeAttempts.get(record.storageId);
		const available = new Map<string, string>();
		for (const recipient of wake.recipients) {
			const fingerprint = this.recipientAvailability(recipient);
			if (fingerprint !== undefined && fingerprint !== wake.failedAvailability[recipient])
				available.set(recipient, fingerprint);
		}
		if (recheck) return available.size > 0;
		this.wakeAttempts.set(record.storageId, available);
		return [...available].some(([recipient, fingerprint]) => previous?.get(recipient) !== fingerprint);
	}

	/** True while the storage waits for its launch window; the catalog is then read again when the wait ends. */
	private launchWaits(storageId: string): boolean {
		const until = this.launchFailures.waitsUntil(storageId);
		if (until === undefined) return false;
		this.launchReplay.arm(until);
		return true;
	}

	private recoveryCandidate(record: CatalogRecord, registeringPrimary?: string): boolean {
		if (record.recoveryDue === true) return true;
		// A waiting storage keeps its wake unjudged, so the read after the wait still finds a new availability new.
		if (registeringPrimary === undefined && this.launchWaits(record.storageId)) return false;
		try {
			return this.parkedWakeDue(record, registeringPrimary);
		} catch (error) {
			this.recordRecoveryError(record.storageId, `Delivery wake metadata: ${errorText(error)}`);
			return false;
		}
	}

	private recoverCatalogueChanges(): void {
		if (this.catalogueScan !== undefined) {
			this.catalogueScanAgain = true;
			return;
		}
		this.catalogueScan = (async () => {
			do {
				this.catalogueScanAgain = false;
				const owner = [...this.primaries.values()].find((primary) => !this.stopping(primary));
				if (owner === undefined || this.stopping(owner)) return;
				await this.scanRecovery(owner, undefined, { reconcileAfterMs: BACKGROUND_RECONCILE_MS });
			} while (this.catalogueScanAgain && !this.shuttingDown);
		})()
			.catch((error) => {
				this.failures.set("catalog-recovery", errorText(error));
			})
			.finally(() => {
				this.catalogueScan = undefined;
				if (this.catalogueScanAgain && !this.shuttingDown) this.recoverCatalogueChanges();
			});
	}

	private async scanRecovery(
		owner: RecoveryOwner,
		registeringPrimary?: string,
		read: { reconcileAfterMs?: number } = {},
	): Promise<void> {
		const order = this.recoveryOrder.begin();
		try {
			const due: CatalogRecord[] = [];
			const inventory = await this.inventory.read(read);
			let visited = 0;
			let complete = true;
			for (const fact of inventory.facts.values()) {
				if (this.stopping(owner) || visited >= MAX_INVENTORY_PAGES * 20) {
					complete = false;
					break;
				}
				if (!fact) {
					complete = false;
					continue;
				}
				visited++;
				if (this.recoveryCandidate(fact.record, registeringPrimary)) due.push(fact.record);
			}
			if (!complete)
				this.failures.set(
					"startup",
					"Startup recovery reached its inventory bound or unreadable metadata; use agent_list for the remaining storage",
				);
			await this.enqueueRecovery(due, owner, order.at, registeringPrimary);
		} finally {
			order.end();
		}
	}

	/** Await only this registration's teardown, including endpoint removal before process replacement. */
	async closePrimary(ownerId: string, signal: AbortSignal): Promise<void> {
		const primary = this.primaries.get(ownerId);
		if (!primary || primary.signal !== signal) {
			await this.registeringPrimaries.get(signal)?.get(ownerId);
			return this.primaryClosures.get(signal)?.get(ownerId);
		}
		const closures = this.primaryClosures.get(signal);
		const channel = this.primaryChannels.get(ownerId);
		this.primaries.delete(ownerId);
		this.primaryChannels.delete(ownerId);
		const closing = Promise.resolve()
			.then(async () => {
				try {
					await channel?.close();
				} finally {
					await this.releaseObservation();
				}
			})
			.catch((error) => {
				this.failures.set(`primary:${ownerId}`, errorText(error));
				throw error;
			})
			.finally(() => {
				if (this.closingPrimaries.get(ownerId) === closing) this.closingPrimaries.delete(ownerId);
			});
		const ownedClosures = closures ?? new Map<string, Promise<void>>();
		ownedClosures.set(ownerId, closing);
		this.primaryClosures.set(signal, ownedClosures);
		this.closingPrimaries.set(ownerId, closing);
		this.footerFigures.delete(ownerId);
		try {
			if (!this.reloadedSignals.has(signal)) primary.status?.(undefined);
		} catch (error) {
			this.failures.set(`primary-status:${ownerId}`, errorText(error));
		}
		if (!this.primaries.size) this.releaseClients();
		this.observationOwnerEnded();
		await closing;
	}

	/** Bounded local-machine efforts with full intent only for a shared repository or cwd. */
	async efforts(ownerId: string, cwd?: string): Promise<EffortPresencePage> {
		const self = this.primaryChannels.get(ownerId)?.info() ?? {
			id: ownerId,
			...(await this.locations.resolve(cwd ?? this.options.root)),
		};
		return readRelatedEfforts(this.effortResources(), self);
	}

	/** Current bounded view for model runs, status, and the dashboard. */
	async awareness(
		ownerId: string,
		cwd?: string,
		mode: "observation" | "prompt" = "observation",
	): Promise<EffortAwareness> {
		const self = this.primaryChannels.get(ownerId)?.info() ?? { id: ownerId, cwd: cwd ?? this.options.root };
		const awareness = await readEffortAwareness(this.effortResources(), self, "canonical", mode);
		if (
			(this.primaries.get(ownerId)?.observedInputComplete === false ||
				this.primaries.get(ownerId)?.observedInputCanCapture === false) &&
			!awareness.self.observedPurpose &&
			!awareness.self.intentClaim
		)
			awareness.self.omitted = true;
		return awareness;
	}

	private effortResources(): EffortReadResources {
		return { catalog: this.catalog, locations: this.locations };
	}

	/** Publish a session's claim without changing host facts or another primary. */
	async publishIntent(
		ownerId: string,
		input: Omit<PrimaryIntentClaim, "updatedAt"> | undefined,
	): Promise<{ published: PrimaryInfo; awareness: EffortAwareness }> {
		const channel = this.primaryChannels.get(ownerId);
		if (!channel) throw new Error("Intent publication requires this live ordinary primary session");
		channel.publishIntent(input === undefined ? undefined : { ...input, updatedAt: new Date().toISOString() });
		this.rosterChanged();
		return { published: channel.info(), awareness: await this.awareness(ownerId) };
	}

	/** The operator's first request states the work better than a generated session name, which stays in `name`. */
	private observedPurpose(primary: PrimaryClient): PrimaryInfo["observedPurpose"] {
		if (primary.observedInput) return { source: "interactive-input", text: purposeExcerpt(primary.observedInput) };
		const name = purposeExcerpt(primary.name ?? "");
		return name ? { source: "session-name", text: name } : undefined;
	}

	/**
	 * Publish the work items this session used; the caller owns the list and its retention. Before
	 * registration completes, registration itself publishes the caller's current list.
	 */
	setPrimaryWorkRefs(ownerId: string, workRefs: PrimaryWorkReference[]): void {
		if (!this.primaries.has(ownerId)) return;
		try {
			this.primaryChannels.get(ownerId)?.setWorkRefs(workRefs);
		} catch (error) {
			this.failures.set(`primary:${ownerId}`, errorText(error));
		}
		this.rosterChanged();
	}

	/** Only interactive input supplies an observed fallback; extension-generated text never does. */
	recordPrimaryInput(ownerId: string, text: string, source: string): boolean {
		const primary = this.primaries.get(ownerId);
		if (!primary) return false;
		const excerpt = firstInteractivePurpose(
			{
				text: primary.observedInput,
				complete: primary.observedInputComplete === true,
				canCapture: primary.observedInputCanCapture === true,
			},
			{ source, text },
		);
		if (source === "interactive") primary.observedInputCanCapture = false;
		if (!excerpt) return false;
		primary.observedInput = excerpt;
		this.primaryChannels.get(ownerId)?.setObservedPurpose(this.observedPurpose(primary));
		this.rosterChanged();
		return true;
	}

	/** Event-driven activity is sampled, never refreshed by a heartbeat. */
	touchPrimary(ownerId: string, now = Date.now()): void {
		const channel = this.primaryChannels.get(ownerId);
		if (!channel) return;
		const previous = Date.parse(channel.info().lastActivityAt ?? channel.info().startedAt);
		if (Number.isFinite(previous) && now - previous < PRIMARY_ACTIVITY_INTERVAL_MS) return;
		try {
			channel.touch(new Date(now).toISOString());
		} catch (error) {
			this.failures.set(`primary:${ownerId}`, errorText(error));
		}
	}

	/** Refresh the recorded identity of a registered primary; the channel endpoint record is rewritten. */
	updatePrimary(
		ownerId: string,
		info: { name?: string; model?: { provider: string; modelId: string }; thinkingLevel?: string },
	): void {
		const primary = this.primaries.get(ownerId);
		if (!primary) return;
		if ("name" in info) primary.name = info.name;
		if ("model" in info) primary.model = info.model;
		if ("thinkingLevel" in info) primary.thinkingLevel = info.thinkingLevel;
		try {
			this.primaryChannels
				.get(ownerId)
				?.update({ name: primary.name, model: primary.model, thinkingLevel: primary.thinkingLevel });
			if ("name" in info) {
				this.primaryChannels.get(ownerId)?.setObservedPurpose(this.observedPurpose(primary));
				this.rosterChanged();
			}
		} catch (error) {
			this.failures.set(`primary:${ownerId}`, errorText(error));
		}
	}

	/** `readAt` is the recovery order position at which the read of `due` began. */
	private async enqueueRecovery(
		due: CatalogRecord[],
		primary: RecoveryOwner,
		readAt: number,
		registeringPrimary?: string,
	): Promise<void> {
		let next = 0;
		const recover = async () => {
			while (!this.stopping(primary) && next < due.length) {
				const record = due[next++];
				if (record) {
					this.queuedRecovery.delete(record.storageId);
					await this.recover(record, primary, readAt, registeringPrimary);
				}
			}
		};
		const recovery = this.recoveryQueue.then(async () => {
			await Promise.all([recover(), recover()]);
		});
		this.recoveryQueue = recovery.catch(() => undefined);
		await recovery;
		for (const record of due.slice(next)) this.queuedRecovery.delete(record.storageId);
	}

	private async refreshRecoveryClient(storageId: string): Promise<boolean> {
		const cached = this.clients.get(storageId);
		if (cached) {
			try {
				await this.readRecoveryState(storageId, cached);
			} catch (error) {
				this.recordRecoveryError(storageId, errorText(error));
			}
			return true;
		}
		const recovering = this.recoveryClients.get(storageId);
		if (recovering) {
			await recovering.refresh();
			return true;
		}
		return false;
	}

	private recoveryLaunchNeeded(storageId: string, primary: RecoveryOwner, registeringPrimary?: string): boolean {
		if (this.stopping(primary) || this.crashes.get(storageId)?.stopped) return false;
		const current = this.catalog.read(storageId);
		return current.recoveryDue === true || this.parkedWakeDue(current, registeringPrimary, true);
	}

	/** Acquire the host of one due record and note the outcome for the reads that began before it. */
	private async acquireRecovery(
		storageId: string,
		primary: RecoveryOwner,
		launchNeeded: () => boolean,
	): Promise<HostConnection> {
		let outcome = true;
		try {
			return await (this.options.acquire ?? acquireHost)(
				hostMetadata(this.catalog.read(storageId), this.options.packageDir),
				{ ...MANAGED_LINK, launchNeeded },
			);
		} catch (error) {
			// A launch that this read no longer needs says nothing about what another read needs.
			outcome = !(error instanceof HostLaunchDemandEnded);
			throw error;
		} finally {
			// A stopped owner's acquisition proves nothing for the reads of other owners.
			if (this.stopping(primary)) this.recoveryOrder.withdraw(storageId);
			else if (outcome) this.recoveryOrder.settled(storageId);
		}
	}

	private async recover(
		record: CatalogRecord,
		primary: RecoveryOwner,
		readAt: number,
		registeringPrimary?: string,
	): Promise<void> {
		if (this.crashes.get(record.storageId)?.stopped) return;
		if (await this.refreshRecoveryClient(record.storageId)) return;
		if (this.recovering.has(record.storageId)) return;
		// An acquisition for this storage settled after this record was read; its outcome is the newer fact.
		if (this.recoveryOrder.done(record.storageId, readAt)) return;
		if (record.recoveryDue === true && this.recoveryHolds.has(record.storageId)) {
			if (registeringPrimary === undefined) return;
			this.recoveryHolds.set(record.storageId, Symbol());
		}
		// A launch that keeps failing waits for its window; a registration is an explicit act and tries at once.
		if (registeringPrimary === undefined && this.launchWaits(record.storageId)) return;
		this.recovering.add(record.storageId);
		try {
			const launchNeeded = () => this.recoveryLaunchNeeded(record.storageId, primary, registeringPrimary);
			if (!launchNeeded()) {
				this.recovering.delete(record.storageId);
				return;
			}
			const client = await this.acquireRecovery(record.storageId, primary, launchNeeded);
			if (this.stopping(primary)) {
				await client.close();
				this.recovering.delete(record.storageId);
				return;
			}
			this.recoveryErrors.delete(record.storageId);
			this.recoveryHolds.delete(record.storageId);
			this.launchFailures.clear(record.storageId);
			await this.monitorRecovery(record.storageId, client, primary);
		} catch (error) {
			this.recovering.delete(record.storageId);
			if (error instanceof HostLaunchDemandEnded) return;
			this.recoveryFailed(record.storageId, error);
		}
	}

	/**
	 * One recovery acquisition ended without a link. Each counts in the storage's launch window. A busy runner
	 * stays a note, and an error is recorded once for each text of a window, not at every later notice.
	 */
	private recoveryFailed(storageId: string, error: unknown): void {
		const busy = error instanceof HostBusyEndpointUnavailableError;
		const report = this.launchFailures.failed(storageId, errorText(error));
		if (busy) {
			if (this.recoveryNotes.get(storageId) === error.message) return;
			this.recoveryNotes.set(storageId, error.message);
			void this.refreshFooter();
		} else if (report !== undefined) this.recordRecoveryError(storageId, report);
	}

	/** An advertised interface difference is a live-host fact, never a transport loss. */
	private recoveryCompatible(storageId: string, client: HostConnection): boolean {
		if (client.closed) return true;
		this.recoveryErrors.delete(storageId);
		this.failures.delete(storageId);
		const mismatch = operationContractMismatch("recovery-state", client.runtimeContract.operations["recovery-state"]);
		if (!mismatch) {
			this.recoveryNotes.delete(storageId);
			return true;
		}
		const note = `${mismatch} Host code updates on its next start.`;
		if (this.recoveryNotes.get(storageId) !== note) {
			this.recoveryNotes.set(storageId, note);
			void this.refreshFooter();
		}
		return false;
	}

	private async readRecoveryState(
		storageId: string,
		client: HostConnection,
	): Promise<{ workPending?: boolean; deliveriesPending?: boolean; deliveriesActive?: boolean } | undefined> {
		if (!this.recoveryCompatible(storageId, client)) return undefined;
		try {
			return (await client.request("recovery-state")) as {
				workPending?: boolean;
				deliveriesPending?: boolean;
				deliveriesActive?: boolean;
			};
		} catch (error) {
			if (this.recoveryCompatible(storageId, client)) throw error;
			return undefined;
		}
	}

	private recordRecoveryError(storageId: string, error: string): void {
		this.failures.set(storageId, error);
		this.recoveryErrors.set(storageId, error);
		void this.refreshFooter();
	}

	private hostLost(storageId: string, client: HostConnection): void {
		if (this.shuttingDown) return;
		const loss = Symbol();
		this.recoveryHolds.set(storageId, loss);
		if (client.ownerReleased) return;
		let record: CatalogRecord;
		try {
			record = this.catalog.read(storageId);
			if (record.recoveryDue !== true) return;
		} catch (error) {
			this.recordRecoveryError(storageId, errorText(error));
			return;
		}
		const recover = () => {
			if (this.recoveryHolds.get(storageId) !== loss || this.shuttingDown || client.ownerReleased) return;
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
					this.recordRecoveryError(
						storageId,
						"Automatic recovery stopped after repeated host losses within 60 seconds. A running host's error output is not retained; use agent_attach to retry, and a host that fails before readiness returns its error output in that refusal.",
					);
					return;
				}
				this.recoveryHolds.delete(storageId);
				this.queuedRecovery.add(storageId);
				const order = this.recoveryOrder.begin();
				void this.enqueueRecovery([record], primary, order.at)
					.catch((error) => {
						this.queuedRecovery.delete(storageId);
						this.recordRecoveryError(storageId, errorText(error));
					})
					.finally(order.end);
			} catch (error) {
				this.recordRecoveryError(storageId, errorText(error));
			}
		};
		if (!client.ownedExit) {
			const paths = hostPaths(record);
			const ended = observeClaim(paths.claim, paths.identity);
			if (ended.kind === "dead" && ended.endedAt !== undefined && ended.writerId === client.writerId) {
				this.recoveryErrors.delete(storageId);
				this.failures.delete(storageId);
				return;
			}
			this.recordRecoveryError(
				storageId,
				"Host link is unavailable without an owned child-exit event. Retained work remains; use agent_attach for explicit recovery.",
			);
			return;
		}
		void client.ownedExit.then(
			(outcome) => {
				if (outcome.failed && !client.ownerReleased) recover();
			},
			(error: unknown) => {
				if (!this.shuttingDown && this.recoveryHolds.get(storageId) === loss)
					this.recordRecoveryError(storageId, `Owned host exit is unavailable: ${errorText(error)}`);
			},
		);
	}

	private async monitorRecovery(storageId: string, client: HostConnection, primary: RecoveryOwner): Promise<void> {
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
			if (this.recoveryClients.get(storageId) === managed) {
				this.recoveryClients.delete(storageId);
				this.recoveryNotes.delete(storageId);
				this.recovering.delete(storageId);
			}
			void client.close().catch((error) => this.failures.set(storageId, errorText(error)));
		};
		const managed = { client, close, refresh: () => check() };
		this.recoveryClients.set(storageId, managed);
		primary.signal.addEventListener("abort", close, { once: true });
		const lost = () => {
			if (closed) return;
			close();
			this.hostLost(storageId, client);
		};
		removeClose = client.onClose(lost);
		const failed = (error: unknown) => {
			if (closed) return;
			this.failures.set(storageId, errorText(error));
			lost();
		};
		const check = async () => {
			if (closed) return;
			if (checking) {
				again = true;
				return;
			}
			checking = true;
			try {
				do {
					again = false;
					const state = await this.readRecoveryState(storageId, client);
					if (state?.workPending === false && state.deliveriesActive === false) {
						close();
					}
					void this.refreshFooter();
				} while (again && !closed);
			} catch (error) {
				failed(error);
			} finally {
				checking = false;
			}
		};
		try {
			if (client.subscribeChanges) {
				unsubscribe = await client.subscribeChanges(() => {
					void check();
				}, primary.signal);
				if (closed) unsubscribe();
			}
			await check();
		} catch (error) {
			close();
			throw error;
		}
	}

	private stopping(primary: RecoveryOwner): boolean {
		return this.shuttingDown || primary.signal.aborted;
	}

	private async subscribe(storageId: string, client: HostConnection): Promise<void> {
		this.subscriptions.get(storageId)?.();
		this.subscriptions.delete(storageId);
		client.onClose(() => {
			if (this.clients.get(storageId) !== client) return;
			this.clients.delete(storageId);
			this.launchRows.delete(storageId);
			this.recoveryNotes.delete(storageId);
			this.subscriptions.get(storageId)?.();
			this.subscriptions.delete(storageId);
			this.failures.delete(`changes:${storageId}`);
			this.hostLost(storageId, client);
			this.catalogChanged([storageId]);
		});
		if (!client.subscribeChanges) return;
		const unsubscribe = await client.subscribeChanges(() => {
			this.catalogChanged([storageId]);
		}, this.lifecycle.signal);
		if (client.closed) unsubscribe();
		else this.subscriptions.set(storageId, unsubscribe);
	}

	private async sentWorkResult(ownerId: string, sessionId: string, admission: unknown, requestId: string) {
		const { admittedResult } = await loadResultReference();
		const result = admittedResult(sessionId, admission, requestId);
		this.rememberSentWork(ownerId, result.sessionId);
		return result;
	}

	/** Marker or presentation failure never changes a successful native admission. */
	private rememberSentWork(ownerId: string, target: unknown): void {
		const primary = this.primaries.get(ownerId);
		const identity = sentWorkIdentity(target);
		if (!primary || identity === undefined) return;
		primary.sentWork ??= new Set();
		if (primary.sentWork.has(identity)) return;
		primary.sentWork.add(identity);
		try {
			primary.retainSentWork?.(identity);
		} catch (error) {
			this.failures.set(
				`sent-work:${ownerId}`,
				`Sent-work marker was not saved; this target may be absent after restart. ${errorText(error)}`,
			);
		}
		try {
			const figures = this.figuresForRows(ownerId, this.toolCardRows);
			this.footerFigures.set(ownerId, figures);
			primary.status?.(figures || undefined);
		} catch (error) {
			this.failures.set("footer", errorText(error));
		}
		try {
			this.rosterChanged();
		} catch (error) {
			this.failures.set("footer", errorText(error));
		}
	}

	/** Exact successful task admissions, for presentation-side relationship joins only. */
	dashboardTaskTargets(ownerId: string): readonly string[] {
		return [...(this.primaries.get(ownerId)?.sentWork ?? [])];
	}

	/** UI-local session totals reuse the roster and the primary's retained sent-work identities. */
	async sessionFigures(ownerId: string, page?: AgentConversationPage): Promise<string> {
		const observed = page ?? (await this.dashboardPage({ ownerId }));
		const text = this.figuresForRows(ownerId, observed.rows);
		return !observed.coverage.complete ? text.replace(/(agents: \d+\/\d+)( active)/u, "$1+$2") : text;
	}

	private figuresForRows(ownerId: string, rows: readonly AgentConversationSummary[]): string {
		return sessionFigures(
			rows,
			ownerId,
			(storageId) => this.inventory.ownerId(storageId),
			this.primaries.get(ownerId)?.sentWork,
			(storageId) => this.recoveryErrors.get(storageId) !== undefined,
		);
	}

	private async refreshFooter(): Promise<void> {
		this.rosterChanged();
		if (this.shuttingDown || !this.primaries.size) return;
		if (this.refreshing) {
			this.refreshAgain = true;
			return;
		}
		this.refreshing = true;
		try {
			do {
				this.refreshAgain = false;
				for (const [ownerId, primary] of this.primaries) {
					// Footer refreshes follow catalogue notices, so they reconcile claims on the background bound.
					const page = await this.priorityPage({ ownerId }, { reconcileAfterMs: BACKGROUND_RECONCILE_MS });
					this.observeToolCardRows(page);
					const text = await this.sessionFigures(ownerId, page);
					// Each status write requests a terminal render, and notices arrive far more often than
					// the figures change, so an unchanged text writes nothing.
					if (!primary.signal.aborted && this.footerFigures.get(ownerId) !== text) {
						this.footerFigures.set(ownerId, text);
						primary.status?.(text || undefined);
					}
				}
			} while (this.refreshAgain && !this.shuttingDown && this.primaries.size);
		} catch (error) {
			this.failures.set("footer", errorText(error));
		} finally {
			this.refreshing = false;
		}
	}

	private releaseClients(): void {
		this.launchRows.clear();
		for (const client of this.recoveryClients.values()) client.close();
		for (const unsubscribe of this.subscriptions.values()) unsubscribe();
		this.subscriptions.clear();
		const clients = [...this.clients.values()];
		this.clients.clear();
		for (const client of clients) void client.close();
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.shuttingDown = true;
		this.launchReplay.close();
		this.recoveryHolds.clear();
		this.lifecycle.abort();
		this.locations.clear();
		this.rosterListeners.clear();
		for (const { timer } of this.reloadingPrimaries.values()) clearTimeout(timer);
		this.reloadingPrimaries.clear();
		const primaries = [...this.primaries].map(([ownerId, primary]) => this.closePrimary(ownerId, primary.signal));
		this.releaseClients();
		const observations = this.releaseObservation();
		this.closing = Promise.allSettled([...primaries, ...this.closingPrimaries.values()]).then(() => observations);
		return this.closing;
	}

	connectedStorageIds(): string[] {
		return [...this.clients.keys()];
	}
	storageId(sessionId: string): string {
		return storageIdOf(sessionId);
	}
}
