import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { storageStatusPageInput, type StorageStatusPageInput } from "./storage-status.ts";
import { PluginError, isChordError } from "@earendil-works/chord";
import { createColdObservationCache } from "./cold-observation.ts";
import { readRecipientHint, readRecipientHints, recipientHintPath, type RecipientHint } from "./recipient-hints.ts";
import { deliverColdStorage, type ColdDeliveryResult } from "./cold-delivery.ts";
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
	unknownTargetRefusal,
} from "./identity.ts";
import {
	durableTargetInput,
	peerMessageText,
	peerQuestionFields,
	questionReceipt,
	SELF_MESSAGE_REFUSAL,
} from "./peer-questions.ts";
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
import type { HostChanges, NativeOwnerEvidence } from "./host-changes.ts";
import { PrimaryLiveActivity, type LiveActivityReplacement } from "./live-activity.ts";
import { CatalogObservationCapacityError, subscribeCatalogChanges, type CatalogChange } from "./catalog-events.ts";
import { FooterProjection, sessionFooter, type FooterStorage, type SessionFooter } from "./footer.ts";
import { sentWorkIdentity } from "./session-work.ts";
import type { ContinuityFact } from "./continuity-facts.ts";
import { recordAdmission } from "./ordinary-continuity.ts";
import { buildStatusOverview, type HostSupervisionSummary } from "./status-overview.ts";
import {
	configuredAgentRoot,
	superviseHosts,
	type SupervisionAct,
	type SupervisionOptions,
} from "./host-supervision.ts";
import { readSettings } from "./settings.ts";
import { firstInteractivePurpose, purposeExcerpt } from "./effort-purpose.ts";
import { readEffortAwareness, type EffortAwareness } from "./effort-awareness.ts";
import {
	createPrimaryChannel,
	connectPrimaryChannel,
	type PrimaryChannelConnection,
	primaryEndpointStatus,
	readPrimaryEndpointDescriptor,
	type PrimaryChannel,
	type PrimaryChannelOptions,
	type PrimaryInfo,
	type PrimaryIntentClaim,
	type PrimaryWorkReference,
} from "./primary-channel.ts";
import { retainedDeliveryRefusal } from "./primary-retention.ts";
import { readPrimaryObservation, type OrdinaryPrimaryObservation } from "./primary-observation.ts";
import { readRelatedEfforts, type EffortPresencePage, type EffortReadResources } from "./effort-presence.ts";
import { createPrimaryLocationResolver, type PrimaryLocationResolver } from "./effort-location.ts";
import { LaunchFailures, LaunchReplay } from "./launch-failures.ts";
import { RecoveryOrder } from "./recovery-order.ts";
import type { ProjectTrustDecision } from "./trust-support.ts";
import type { DeliveryOrigin } from "./durable-controls.ts";
import {
	acquireHost,
	connectionEnded,
	HostRetiringError,
	RETIRING_HOST_WAIT_MS,
	connectHost,
	HostBusyEndpointUnavailableError,
	HostLaunchDemandEnded,
	HostDeliveryOnly,
	HostEndpointUnavailableError,
	type HostConnection,
	type HostObservationListener,
} from "./host-client.ts";
import { HostError, hostPaths, hostRequestVersionError, type HostMetadata } from "./host-protocol.ts";
import { observeClaim, type ClaimObservation } from "./claims.ts";
import { PlaceBook } from "./places.ts";
import type {
	AgentActivity,
	AgentConversationPage,
	AgentConversationSummary,
	AgentPriorityPage,
	AgentPrioritySummary,
} from "./dashboard-types.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationSnapshotPage } from "./durable-observation.ts";
import type { HostObservationScope } from "./host-client.ts";

import {
	HOST_CONTRACT,
	MANAGER_CONTRACT,
	operationContractMismatch,
	type RuntimeContract,
} from "./version-contract.ts";
import {
	collaborationMutationMethod,
	collaborationStorage,
	validateCollaborationAction,
} from "./collaboration-contract.ts";
import { blankPrompt } from "./creation-prompt.ts";
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
	/** Cold delivery of one storage's rows to registered recipients; tests inject a counting fake. */
	deliverCold?: typeof deliverColdStorage;
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
	/** Ask for activity only on an ordinary process's existing changes feeds. */
	observeLiveActivity?: boolean;
	/** Largest recorded-failure memory; the oldest failure evicts first. */
	failureLimit?: number;
	/**
	 * Check this user's Durable host processes while a primary is registered, at `agent.hostCheckMinutes`. Only the
	 * manager of an ordinary Pi process sets it; Durable hosts and tests leave it off. An object replaces the check's
	 * process table, signals and clock.
	 */
	superviseHosts?: boolean | Omit<SupervisionOptions, "agentDir" | "stuckMs" | "idleMs" | "reported">;
}
interface PrimaryClient {
	/** A fresh session has no earlier agents to project. */
	freshSession?: boolean;
	sentWork?: Set<string>;
	retainSentWork?(sessionId: string): void;
	retainContinuity?(fact: ContinuityFact): void;
	send(text: string, details: unknown, sourceId: string, requireRetained: boolean): void;
	/** A confirmed body needs no new message, but a replay can carry new request results. */
	receiveRetainedReplay?(details: unknown): void;
	resumeInbox?(): void;
	/** The footer figures, and the agents in the primary's scope that need intervention (see `SessionFooter`). */
	status?(text: string | undefined, stuck?: readonly string[]): void;
	liveActivity?(event: LiveActivityReplacement): void;
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
/** One source with retained work for registered parties, from those parties' own hint directories. */
interface RecoveryDemand {
	readonly record: CatalogRecord;
	/** A registered party owns unfinished work there; otherwise the source only holds rows to deliver. */
	readonly execution: boolean;
	/** The registered recipient storages with a hint from this source. */
	readonly recipients: readonly string[];
}
/** A paced read of each registered party's own hint directory covers a lost or coalesced notice. */
const RECOVERY_RECONCILE_MS = 60_000;
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
/** The refusal of a delivery to a session whose extension reloads; its source keeps the delivery for a retry. */
export const PRIMARY_RELOADING_REFUSAL = "Primary session is reloading; the delivery stays unacknowledged for a retry";
/**
 * Whether a delivery got no answer from the primary: its link closed, as a reload closes the channel a sender holds,
 * or the request timed out on a live link. The primary may have taken the message, so its outcome is unknown. A retry
 * is safe: the receiver admits one source identity once.
 */
function unansweredDelivery(error: unknown, connection: PrimaryChannelConnection): boolean {
	return !connection.connected || (error as { name?: unknown }).name === "TimeoutError";
}

/**
 * The failure of a message to an ordinary primary. Without an unanswered attempt every attempt was refused or never
 * reached the primary, so the message was not delivered. After an unanswered attempt the primary may hold it, so
 * the failure names its source identity for reconciliation instead of asking for another send.
 */
function undeliveredPrimaryMessage(
	sessionId: string,
	sourceId: string,
	cause: string,
	attempt: { readonly unanswered: boolean },
): Error {
	const waited = `${Math.round(PRIMARY_RELOAD_WAIT_MS / 1000)} s`;
	if (attempt.unanswered) {
		const then =
			cause === "ended"
				? "the session ended"
				: cause === "deadline"
					? `it took no message for ${waited}`
					: `the next attempt failed: ${cause}`;
		return new Error(
			`Delivery to primary session ${sessionId} is unconfirmed: a request got no answer before its link closed or its deadline passed, and then ${then}. The session can hold the message under source ID ${sourceId} and place it when it runs. Check the session before you send the message again; a new send is a second message.`,
		);
	}
	if (cause === "ended")
		return new Error(`Primary session ${sessionId} ended during its reload; the message was not delivered.`);
	return new Error(
		`Primary session ${sessionId} took no message for ${waited}: it was reloading or its channel was unreachable. The message was not delivered; send it again after the reload.`,
	);
}
/** How long a message to a reloading ordinary primary waits for its next registration, and between attempts. */
const PRIMARY_RELOAD_WAIT_MS = 15_000;
const PRIMARY_RELOAD_RETRY_MS = 200;
/** How long a reloading session's channel stays published while its extension registers again. */
const PRIMARY_RELOAD_GRACE_MS = 60_000;
const DEFAULT_FAILURE_LIMIT = 256;
/** Recent host-check acts kept for status; each act appears once. */
const SUPERVISION_ACT_LIMIT = 8;
const SUPERVISION_REPORTED_LIMIT = 1024;
const MAX_ERROR_TEXT = 512;
const MAX_INVENTORY_PAGES = 16;
const MAX_LIST_STEPS = 32;
const PRIMARY_ACTIVITY_INTERVAL_MS = 60_000;
/** Catalogue notices that arrive within this interval share one footer projection. */
const FOOTER_NOTICE_INTERVAL_MS = 250;
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

/** One value for a footer's text and its stuck agents, so an unchanged footer is not written again. */
function footerKey(footer: SessionFooter): string {
	return JSON.stringify([footer.text, footer.stuck]);
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

/** A connection that found its host ending its retirement, which admits nothing; the next selection may succeed. */
function endedRetirement(error: unknown): boolean {
	const cause = error instanceof HostEndpointUnavailableError ? error.cause : error;
	return cause instanceof HostRetiringError && cause.ended;
}

/** Why a control that names the calling primary session refuses, or undefined when the caller may name itself. */
function callerTargetRefusal(method: string): string | undefined {
	if (["abort", "release", "interrupt-continue", "fork", "rewind", "compact", "configure", "command"].includes(method))
		return "This control cannot target the calling primary session";
	if (["submit", "task-submit", "report"].includes(method)) return SELF_MESSAGE_REFUSAL;
	return undefined;
}

/**
 * The view of an ordinary primary inspection: the supplied view, else the view that its cursor names, else activity.
 * A cursor continues the view of the read that returned it, so a different supplied view is refused. An exact cursor
 * also overrides "history", which native hosts of earlier snapshots still fill in for an omitted view.
 */
function primaryInspectView(input: Record<string, unknown>): unknown {
	const named = (input.cursor as { view?: unknown } | undefined)?.view;
	const cursorView = ["status", "activity", "history", "exact"].includes(named as string) ? named : undefined;
	const view =
		cursorView === "exact" && (input.view === undefined || input.view === "history")
			? "exact"
			: (input.view ?? cursorView ?? "activity");
	if (cursorView !== undefined && cursorView !== view)
		throw new Error(
			`This cursor continues a ${String(cursorView)} read of the ordinary session. Omit view or pass view "${String(cursorView)}" with it.`,
		);
	return view;
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
		if (this.toolCardRowsDirty) {
			this.toolCardRows = this.footerProjection.rows();
			this.toolCardRowsDirty = false;
		}
		return this.toolCardRows;
	}

	private observeToolCardRows(): void {
		this.toolCardRowsDirty = true;
	}
	private readonly rosterListeners = new Set<() => void>();
	/** The figures text last written to each primary's footer cell. */
	private readonly footerFigures = new Map<string, string>();
	/** Registrations with a footer projection, cleared when that primary leaves. */
	private readonly footerPages = new Map<string, "projected">();
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
		this.rosterChanged();
		this.scheduleFooterProjection();
		// A hint publication sends a notice too; each registered party reads its own hints again.
		this.recoverCatalogueChanges();
	}
	private footerTimer?: NodeJS.Timeout;
	/**
	 * Working hosts publish several notices each second, and a footer projection reads the whole catalogue. The
	 * first notice of an interval starts one timer; one projection then serves every notice of that interval.
	 */
	private scheduleFooterProjection(): void {
		if (this.footerTimer !== undefined || this.shuttingDown || !this.primaries.size) return;
		this.footerTimer = setTimeout(() => {
			this.footerTimer = undefined;
			void this.projectFooter();
		}, FOOTER_NOTICE_INTERVAL_MS);
		this.footerTimer.unref?.();
	}
	private cancelFooterProjection(): void {
		clearTimeout(this.footerTimer);
		this.footerTimer = undefined;
	}
	private releaseObservation(): Promise<void> {
		if (this.hasObservationOwners()) return this.coldRelease;
		this.cancelFooterProjection();
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
	/** A failed start of catalogue observation stays visible in status; a later owner tries again. */
	private recordObservationFailure(error: unknown): void {
		this.failures.set(
			"catalog-observation",
			`Catalog updates are unavailable: ${errorText(error)}. Restart this Pi process.`,
		);
	}
	/**
	 * A full observer table refuses the subscription, so observers stay bounded. After any other failed start the
	 * roster view still opens; it shows what its own reads return.
	 */
	subscribeRoster(listener: () => void): () => void {
		if (this.shuttingDown) throw new Error("Agent manager is closed");
		try {
			this.observeCatalogChanges();
		} catch (error) {
			if (error instanceof CatalogObservationCapacityError) throw error;
			this.recordObservationFailure(error);
		}
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
	/**
	 * Tell every roster listener. A listener that throws is recorded: it stops neither the listeners after it nor
	 * the change that tells them, which is already applied.
	 */
	private rosterChanged(): void {
		for (const listener of this.rosterListeners) {
			try {
				listener();
			} catch (error) {
				this.failures.set("footer", errorText(error));
			}
		}
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
	private supervisionTimer: ReturnType<typeof setInterval> | undefined;
	private supervisionRun: Promise<void> | undefined;
	private supervisionLast: Omit<HostSupervisionSummary, "acts"> | undefined;
	private readonly supervisionActs: SupervisionAct[] = [];
	private readonly supervisionReported = new Set<string>();
	/** The hint and party state of each source's last delivery-only attempt, so unchanged state is not tried again. */
	private readonly deliveryAttempts = new BoundedMap<{ state: string; retryAt: number }>(DEFAULT_FAILURE_LIMIT);
	/** Durable storages that act on their own hints while their host runs, beside the registered primaries. */
	private readonly recoveryParties = new Map<string, RecoveryOwner>();
	/** Changes when a party registers or a primary first saves its transcript: a new chance to deliver. */
	private readonly partyEpochs = new Map<string, string>();
	private reconcileTimer: ReturnType<typeof setInterval> | undefined;
	private readonly recoveryClients = new Map<
		string,
		{ client: HostConnection; close: () => void; refresh: () => Promise<void> }
	>();
	private readonly primaries = new Map<string, PrimaryClient>();
	private readonly liveActivity?: PrimaryLiveActivity;
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
	/** The registration that is replacing each session's channel, from its start until it settles. */
	private readonly replacingPrimaries = new Map<string, PrimaryClient>();
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
		if (options.observeLiveActivity) {
			this.liveActivity = new PrimaryLiveActivity(
				(ownerId) => {
					const primary = this.primaries.get(ownerId);
					if (!primary || this.reloadedSignals.has(primary.signal)) return undefined;
					return primary.liveActivity;
				},
				// An open work view lists running work under its agents, so it reads the roster again.
				() => {
					if (!this.shuttingDown) this.rosterChanged();
				},
			);
		}
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
		if (this.liveActivity !== undefined) {
			const previous = this.clients.get(storageId) ?? this.recoveryClients.get(storageId)?.client;
			if (previous !== undefined && previous !== client) this.liveActivity.withdraw(storageId, previous);
		}
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
	 * that waits in the queue never starts. A cold read cannot stop part way; it finishes, and only its
	 * result cache keeps the value.
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
				return cold.observe(record, method, params, signal === undefined ? {} : { signal });
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
		if (blankPrompt(input.prompt)) {
			const { prompt: _prompt, ...idle } = input;
			input = idle;
		}
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
		const selfRefusal = sessionId === caller.id ? callerTargetRefusal(method) : undefined;
		if (selfRefusal !== undefined) throw new Error(selfRefusal);
		let record: CatalogRecord;
		try {
			record = this.nativeTarget(sessionId);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!readPrimaryEndpointDescriptor(this.options.root, sessionId).info)
				throw new Error(unknownTargetRefusal(sessionId));
			return this.primaryControl(method, input, sessionId, caller, options?.signal);
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
		if (method === "attach") return this.attachControl(record, params, signal, launch);
		try {
			return await this.afterRetirement(record, launch, signal, (client) =>
				this.controlClient(client, method, params, caller, signal),
			);
		} catch (error) {
			if (method !== "configure" || !selector.startsWith("@")) throw error;
			throw new Error(`Configure of ${String(params.sessionId)} (${selector}) failed: ${errorText(error)}`, {
				cause: error,
			});
		}
	}

	/**
	 * Stop a live host in place. A cold storage gets only an exclusive stop writer, never an executing host. A host
	 * that refuses the stop because it is ending admitted nothing: once it has ended, the stop is selected again,
	 * once, and reaches the next live host or a cold stop writer.
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
		let reselected = false;
		const stopLive = async (client: HostConnection): Promise<unknown> => {
			try {
				return await this.controlClient(client, method, params, caller, signal);
			} catch (error) {
				if (reselected || !(error instanceof HostRetiringError)) throw error;
				if (!(await connectionEnded(client, RETIRING_HOST_WAIT_MS, signal))) throw error;
				reselected = true;
				return select();
			}
		};
		const select = async (): Promise<unknown> => {
			const running = await this.observationConnection(target);
			if (running !== undefined) return stopLive(running);
			if (!launch)
				throw new HostEndpointUnavailableError(target.storageId, new Error("this abort may not start a host"));
			signal?.throwIfAborted();
			const reply = await (this.options.stopCold ?? stopColdStorage)(
				hostMetadata(target, this.options.packageDir),
				String(params.sessionId),
				params.background === true,
				{ signal },
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
			return stopOwner();
		};
		// A competing writer won the lease. Stop it in place; never launch or retire it on this evidence.
		const stopOwner = async (): Promise<unknown> => {
			let owner: HostConnection;
			try {
				owner = await this.connection(target, undefined, false);
			} catch (error) {
				// Its host ended its retirement during the connection, so it admitted nothing; select once more.
				if (reselected || !endedRetirement(error)) throw error;
				reselected = true;
				return select();
			}
			return stopLive(owner);
		};
		return select();
	}

	private requestedOperation(method: string): string {
		if (method === "submit") return "task-submit";
		if (method === "report") return "submit";
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
							this.continuityFactFailure(ownerId, error);
						}
					};
		return recordAdmission(record, { ownerId, sessionId, requestId, replyTo }, call);
	}

	/** Report a request fact that a primary could not save in its session. */
	continuityFactFailure(ownerId: string, error: unknown): void {
		this.failures.set(
			`continuity:${ownerId}`,
			`An admission fact was not saved; the continuity note after a compaction can omit or misstate this request. ${errorText(error)}`,
		);
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

	/**
	 * A host that began to end refuses before admission. Wait for that host to close, then send once through a fresh
	 * host; the refusal proves that the first attempt admitted nothing.
	 */
	private async afterRetirement<T>(
		record: CatalogRecord,
		launch: boolean,
		signal: AbortSignal | undefined,
		run: (client: HostConnection) => Promise<T>,
	): Promise<T> {
		// A caller that withdrew starts no further acquisition; a step that a host already applied stays applied.
		signal?.throwIfAborted();
		const client = await this.connection(record, undefined, launch);
		try {
			return await run(client);
		} catch (error) {
			if (!(error instanceof HostRetiringError)) throw error;
			if (!(await connectionEnded(client, RETIRING_HOST_WAIT_MS, signal))) throw error;
			return run(await this.connection(record, undefined, launch));
		}
	}

	private async controlClient(
		client: HostConnection,
		method: string,
		params: Record<string, unknown>,
		caller: AgentCaller,
		signal?: AbortSignal,
	): Promise<unknown> {
		const sessionId = String(params.sessionId);
		const requested = this.requestedOperation(method);
		const versionError = hostRequestVersionError(requested, client.runtimeContract);
		if (versionError) throw versionError;
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

	/**
	 * Attach configures a selected model, then reads status. Each request crosses a retiring host on its own, so a
	 * configuration that a host applied is never sent again because the status read after it met a retiring host.
	 */
	private async attachControl(
		record: CatalogRecord,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		launch: boolean,
	): Promise<unknown> {
		const sessionId = String(params.sessionId);
		const send = (operation: "configure" | "status", body: Record<string, unknown>) =>
			this.afterRetirement(record, launch, signal, (client) => {
				const versionError = hostRequestVersionError(operation, client.runtimeContract);
				if (versionError) throw versionError;
				return client.request(operation, body);
			});
		if (params.model !== undefined) {
			const outcome = await send("configure", { sessionId, model: params.model });
			if ((outcome as { outcome?: string })?.outcome === "failed") return outcome;
		}
		return {
			sessionId,
			status: compactStatus(await send("status", { sessionId })),
			recovery: "retained work resumes; no new input was submitted",
		};
	}

	/** Retained ordinary evidence never connects to a peer or acquires a Durable host. */
	async observePrimary(sessionId: string, input: Record<string, unknown> = {}): Promise<OrdinaryPrimaryObservation> {
		const exactCursor = (input.cursor as { view?: unknown } | undefined)?.view === "exact";
		const view = primaryInspectView(input);
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
				`${unknownTargetRefusal(sessionId)} The endpoint of an ordinary session with this identity is ${descriptor.unreadable ? "unreadable" : descriptor.state}. No peer was contacted.`,
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
		signal?: AbortSignal,
	): Promise<unknown> {
		if (method === "status" || method === "inspect")
			return this.observePrimary(sessionId, method === "status" ? { view: "status" } : input);
		if (method === "collaboration-mutate" || method === "collaboration-message-parts")
			throw new Error(
				"Threads of an ordinary primary live in that primary's own thread storage; repeat agent_collaborate create without sessionId to create the thread in your own thread storage",
			);
		return this.primaryMessage(method, input, sessionId, caller, signal);
	}

	private async primaryMessage(
		method: string,
		input: Record<string, unknown>,
		sessionId: string,
		caller: AgentCaller,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (method !== "submit" && method !== "report")
			throw new Error("A registered primary accepts messages, not Durable session controls");
		const sourceId = typeof input.requestId === "string" ? input.requestId : randomUUID();
		// A monotonic clock: a wall-clock step neither ends nor extends the wait.
		const deadline = performance.now() + PRIMARY_RELOAD_WAIT_MS;
		const channel = await connectPrimaryChannel({ id: sessionId, sessionsRoot: this.options.root }).catch(
			async (error: unknown) => {
				// The record can name a channel that a reload closes before the connection; a live owner publishes the next.
				if (primaryEndpointStatus(this.options.root, sessionId).state !== "live") throw error;
				const next = await this.reconnectReloadingPrimary(sessionId, deadline, signal);
				if (typeof next === "string") throw undeliveredPrimaryMessage(sessionId, sourceId, next, { unanswered: false });
				return next;
			},
		);
		const origin: DeliveryOrigin = input.origin === "operator" ? "operator" : "model";
		const sender = this.primaryChannels.get(caller.id)?.info();
		const name = "name" in caller ? caller.name : sender?.name;
		const observedPurpose = caller.observedPurpose ?? sender?.observedPurpose;
		let question: ReturnType<typeof peerQuestionFields>;
		try {
			question = peerQuestionFields(input, method, sourceId);
		} catch (error) {
			await channel.close();
			throw error;
		}
		const text = peerMessageText(String(input.message ?? ""), question, caller.id, name);
		const message = {
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
		};
		await this.deliverPrimaryMessage(sessionId, channel, message, deadline, signal);
		return {
			sessionId,
			admitted: true,
			sourceId,
			...questionReceipt(question),
			boundary:
				"The recipient retained the message for delivery. Admission does not prove placement, action, or task acceptance.",
		};
	}

	/**
	 * Deliver one message through `channel` and close every connection it used. A reloading primary refuses until
	 * it registers again, and a reload closes the channel a sender may hold, so the message waits for the next
	 * registration within a bound; its source identity makes a retry arrive once. An attempt that got no answer
	 * leaves the outcome unknown, and every later failure reports it unconfirmed, not undelivered. An aborted
	 * `signal` starts no further attempt.
	 */
	private async deliverPrimaryMessage(
		sessionId: string,
		channel: PrimaryChannelConnection,
		message: Parameters<PrimaryChannelConnection["deliver"]>[0],
		deadline: number,
		signal?: AbortSignal,
	): Promise<void> {
		const attempt = { unanswered: false };
		let open: PrimaryChannelConnection | undefined = channel;
		try {
			for (let connection = channel; ; ) {
				signal?.throwIfAborted();
				if (await this.primaryAttempt(sessionId, connection, message, attempt)) return;
				open = undefined;
				await connection.close();
				const next = await this.reconnectReloadingPrimary(sessionId, deadline, signal);
				if (typeof next === "string") throw undeliveredPrimaryMessage(sessionId, message.sourceId, next, attempt);
				connection = next;
				open = connection;
			}
		} finally {
			await open?.close();
		}
	}

	/** One delivery: true when the primary took it, false when it waits for the next registration. */
	private async primaryAttempt(
		sessionId: string,
		connection: PrimaryChannelConnection,
		message: Parameters<PrimaryChannelConnection["deliver"]>[0],
		attempt: { unanswered: boolean },
	): Promise<boolean> {
		try {
			await connection.deliver(message);
			return true;
		} catch (error) {
			if (unansweredDelivery(error, connection)) {
				attempt.unanswered = true;
				return false;
			}
			if (errorText(error).includes(PRIMARY_RELOADING_REFUSAL)) return false;
			if (!attempt.unanswered) throw error;
			throw undeliveredPrimaryMessage(sessionId, message.sourceId, errorText(error), attempt);
		}
	}

	/**
	 * A new connection to a primary that reloads, after a short wait. `"ended"` when the session ended, and
	 * `"deadline"` when no registration took a connection within the bound.
	 */
	private async reconnectReloadingPrimary(
		sessionId: string,
		deadline: number,
		signal?: AbortSignal,
	): Promise<PrimaryChannelConnection | "ended" | "deadline"> {
		let absent = 0;
		for (;;) {
			if (performance.now() >= deadline) return "deadline";
			await delay(PRIMARY_RELOAD_RETRY_MS, undefined, signal === undefined ? undefined : { signal });
			try {
				return await connectPrimaryChannel({ id: sessionId, sessionsRoot: this.options.root });
			} catch {
				// The old channel can close between the record read and the connection; the new one follows. A reload
				// keeps the endpoint published, so a dead owner, or an endpoint absent at two attempts, ended the session.
				const state = primaryEndpointStatus(this.options.root, sessionId).state;
				absent = state === "absent" ? absent + 1 : 0;
				if (state === "dead" || absent >= 2) return "ended";
			}
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
		if (blankPrompt(input.prompt)) input = { ...input, prompt: undefined };
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

	/**
	 * One roster page. With `activity`, each row of the reading session's agents also carries the running work
	 * its linked host reports through live activity; the work view asks for it, status overviews do not.
	 */
	async dashboardPage(
		input: { cursor?: string; ownerId?: string; activity?: boolean } = {},
	): Promise<AgentPriorityPage> {
		const page = await this.priorityPage(input, {});
		if (!input.activity || input.ownerId === undefined) return page;
		const items = this.liveActivity?.items(input.ownerId) ?? [];
		if (items.length === 0) return page;
		// The identity module resolves the Durable runtime, which the ordinary entry does not load at startup.
		const { canonicalIdentity } = await import("./native-identity.ts");
		const byRow = new Map<string, AgentActivity[]>();
		for (const { storageId, conversationId, source, id, label, startedAt } of items) {
			const row = canonicalIdentity(storageId, conversationId as ConversationId);
			byRow.set(row, [...(byRow.get(row) ?? []), { source, id, label, startedAt }]);
		}
		return {
			...page,
			rows: page.rows.map((row) => {
				const activity = byRow.get(row.id);
				return activity === undefined ? row : { ...row, activity };
			}),
		};
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

	/** An aborted `signal` ends the wait; a read of stored messages that has not started never starts. */
	async snapshot(
		sessionId: string,
		params: { before?: number; limit?: number; maxBytes?: number } = {},
		signal?: AbortSignal,
	): Promise<ConversationSnapshotPage> {
		sessionId = await this.resolveTarget(sessionId, signal);
		if (this.launchRows.has(storageIdOf(sessionId)) && this.opening.has(storageIdOf(sessionId))) {
			const { emptyConversationSnapshot } = await loadDurableObservation();
			return emptyConversationSnapshot();
		}
		return this.observe(
			this.nativeTarget(sessionId),
			"snapshot",
			{ sessionId, ...params },
			undefined,
			signal,
		) as Promise<ConversationSnapshotPage>;
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
		// A known frame revision only shortens a forward read; any other read returns the frame and needs no hint.
		if (input.action === "read" && input.after === undefined && input.knownFrameRevision !== undefined) {
			const { knownFrameRevision: _known, ...read } = input;
			input = read;
		}
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
			collaborationMutationMethod(input),
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
					`Thread ${input.threadId} is not retained: its storage ${sessionId} does not exist. Find current threads with agent_collaborate action list.`,
				);
			if (session === sessionId)
				throw new Error(`No retained storage ${sessionId}. Find current agents and threads with agent_list.`);
			if (session !== caller.id && !readPrimaryEndpointDescriptor(this.options.root, session).info)
				throw new Error(unknownTargetRefusal(session));
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
			{ ...page, rows: page.rows.map(({ profile: _profile, ...row }) => row) },
			[...this.primaries].map(([sessionId, primary]) => ({
				sessionId,
				cwd: primary.cwd ?? "",
				name: primary.name,
				model: primary.model,
				thinkingLevel: primary.thinkingLevel,
			})),
			failures,
			awareness,
			caller?.id,
			this.hostSupervision(),
		);
	}

	registerPrimary(ownerId: string, primary: PrimaryClient): Promise<void> {
		this.replacingPrimaries.set(ownerId, primary);
		const registration = this.registerPrimaryChannel(ownerId, primary);
		const pending = this.registeringPrimaries.get(primary.signal) ?? new Map<string, Promise<void>>();
		pending.set(ownerId, registration);
		this.registeringPrimaries.set(primary.signal, pending);
		return registration.finally(() => {
			if (pending.get(ownerId) === registration) pending.delete(ownerId);
			if (this.replacingPrimaries.get(ownerId) === primary) this.replacingPrimaries.delete(ownerId);
			if (!this.activityPrimary(ownerId)) this.liveActivity?.forgetOwner(ownerId);
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
		this.liveActivity?.forOwner(ownerId, primary.liveActivity, false);
		try {
			primary.status?.(undefined);
		} catch (error) {
			this.failures.set(`primary-status:${ownerId}`, errorText(error));
		}
		return true;
	}

	/** Why one registration takes no delivery now, or undefined when it takes one. */
	private primaryRefusal(ownerId: string, primary: PrimaryClient): string | undefined {
		const replacing = this.replacingPrimaries.get(ownerId);
		if (replacing !== undefined && replacing !== primary) return PRIMARY_RELOADING_REFUSAL;
		if (this.stopping(primary) || this.primaries.get(ownerId) !== primary)
			return replacing === primary && !this.stopping(primary) ? PRIMARY_RELOADING_REFUSAL : "Primary session is closed";
		return this.reloadingPrimaries.get(ownerId)?.primary === primary ? PRIMARY_RELOADING_REFUSAL : undefined;
	}

	/**
	 * Delivery into one registration; a closed or reloading registration refuses, so the source retries. While
	 * another registration replaces the session's channel, both channels refuse as reloading until the new one
	 * is current, so no delivery reaches the registration that is leaving. A source-ledger delivery for another
	 * recipient refuses before the replay cache or the session sees it.
	 */
	private primaryDelivery(ownerId: string, primary: PrimaryClient): PrimaryChannelOptions["deliver"] {
		const deliveryScope = Symbol();
		return (message) => {
			const refusal = this.primaryRefusal(ownerId, primary);
			if (refusal !== undefined) throw new Error(refusal);
			if (message.requireRetained === false) {
				primary.send(message.text, message.details, message.sourceId, false);
				return;
			}
			const misaddressed = retainedDeliveryRefusal(message.details, ownerId);
			if (misaddressed !== undefined) throw misaddressed;
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
		this.liveActivity?.forOwner(ownerId, primary.liveActivity, true);
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
			this.recordObservationFailure(error);
		}
		this.rosterChanged();
		primary.resumeInbox?.();
		this.partyEpochs.set(ownerId, randomUUID());
		this.startRecoveryReconcile();
		if (!primary.freshSession) this.scheduleFooterProjection();
		// This session's own hints are read before this returns, and their recovery joins the recovery queue
		// without holding the registration; a closed or replaced registration starts no launch from it.
		void this.scanRecovery(primary, ownerId).catch((error) => {
			if (!this.stopping(primary)) this.failures.set(`primary:${ownerId}`, errorText(error));
		});
		this.startHostSupervision();
	}

	/** True while the storage waits for its launch window; the hints are read again when the wait ends. */
	private launchWaits(storageId: string): boolean {
		const until = this.launchFailures.waitsUntil(storageId);
		if (until === undefined) return false;
		this.launchReplay.arm(until);
		return true;
	}

	/** Registered parties that act on their own hints: primaries, and Durable storages whose host runs here. */
	private recoveryPartyIds(): string[] {
		const parties: string[] = [];
		for (const [ownerId, primary] of this.primaries) if (!this.stopping(primary)) parties.push(ownerId);
		for (const [storageId, party] of this.recoveryParties) if (!this.stopping(party)) parties.push(storageId);
		return parties;
	}

	/** A recipient identity names a hint directory only when it is an exact storage identity. */
	private hintRecipient(party: string): string | undefined {
		try {
			return storageIdOf(party) === party ? party : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Read the given parties' own hint directories, page by page, and nothing else: no catalogue listing and no
	 * other party's directory. A malformed hint grants nothing and stays a visible repair condition.
	 */
	private readDemand(parties: readonly string[], owner: RecoveryOwner): Map<string, RecoveryDemand> {
		const sources = new Map<string, { execution: boolean; recipients: Set<string> }>();
		for (const party of parties) {
			const recipient = this.hintRecipient(party);
			if (recipient === undefined || this.stopping(owner)) continue;
			for (const hint of this.partyHints(recipient, owner)) {
				const entry = sources.get(hint.source) ?? { execution: false, recipients: new Set<string>() };
				entry.execution ||= hint.execution;
				entry.recipients.add(recipient);
				sources.set(hint.source, entry);
			}
		}
		const demand = new Map<string, RecoveryDemand>();
		for (const [source, entry] of sources) {
			let record: CatalogRecord;
			try {
				record = this.catalog.read(source);
			} catch (error) {
				// A hint outlives a removed storage record; it names nothing to recover.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.recordRecoveryError(source, errorText(error));
				continue;
			}
			demand.set(source, { record, execution: entry.execution, recipients: [...entry.recipients].sort() });
		}
		return demand;
	}

	/** Every page of one party's hint directory; unreadable hints become the party's repair condition. */
	private partyHints(recipient: string, owner: RecoveryOwner): RecipientHint[] {
		const hints: RecipientHint[] = [];
		const invalid: string[] = [];
		let after: string | undefined;
		do {
			if (this.stopping(owner)) break;
			let page: ReturnType<typeof readRecipientHints>;
			try {
				page = readRecipientHints(this.options.root, recipient, after === undefined ? {} : { after });
			} catch (error) {
				invalid.push(errorText(error));
				break;
			}
			invalid.push(...page.invalid.map((item) => `${item.path}: ${item.error}`));
			hints.push(...page.hints);
			after = page.next;
		} while (after !== undefined);
		if (invalid.length === 0) this.failures.delete(`hints:${recipient}`);
		else
			this.failures.set(
				`hints:${recipient}`,
				`Recipient hints are unreadable and grant no recovery: ${invalid.slice(0, 3).join("; ")}. The source's next writer publication replaces each hint; agent_attach recovers a source explicitly.`,
			);
		return hints;
	}

	/** True while a registered party still holds an execution hint from the storage: the only automatic launch demand. */
	private executionDemand(storageId: string): boolean {
		return this.executionRecipients(storageId).length > 0;
	}

	private executionRecipients(storageId: string): string[] {
		const recipients: string[] = [];
		for (const party of this.recoveryPartyIds()) {
			const recipient = this.hintRecipient(party);
			if (recipient === undefined || recipient === storageId) continue;
			try {
				if (readRecipientHint(this.options.root, recipient, storageId)?.execution === true) recipients.push(recipient);
			} catch {
				/* A malformed hint grants no launch; the demand read reports it. */
			}
		}
		return recipients;
	}

	private recoverCatalogueChanges(): void {
		if (this.catalogueScan !== undefined) {
			this.catalogueScanAgain = true;
			return;
		}
		this.catalogueScan = (async () => {
			do {
				this.catalogueScanAgain = false;
				const owner = [...this.primaries.values(), ...this.recoveryParties.values()].find(
					(party) => !this.stopping(party),
				);
				if (owner === undefined || this.stopping(owner)) return;
				await this.scanRecovery(owner);
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

	/** Read the registering party's hints, or every registered party's, and recover the sources they name. */
	private async scanRecovery(owner: RecoveryOwner, registeringParty?: string): Promise<void> {
		const order = this.recoveryOrder.begin();
		try {
			const parties = registeringParty === undefined ? this.recoveryPartyIds() : [registeringParty];
			const due = [...this.readDemand(parties, owner).values()];
			if (!this.stopping(owner)) await this.enqueueRecovery(due, owner, order.at, registeringParty);
		} finally {
			order.end();
		}
	}

	/** A paced read of the registered parties' own hint directories, independent of notices and host checks. */
	private startRecoveryReconcile(): void {
		if (this.reconcileTimer !== undefined || this.shuttingDown) return;
		this.reconcileTimer = setInterval(() => this.recoverCatalogueChanges(), RECOVERY_RECONCILE_MS);
		this.reconcileTimer.unref?.();
	}

	/**
	 * Act on this Durable storage's own hints while its host runs: unfinished work that a child holds for it, and
	 * rows that any source holds for it. The registration ends with the signal.
	 */
	registerRecoveryParty(storageId: string, signal: AbortSignal): void {
		if (this.hintRecipient(storageId) === undefined)
			throw new Error("A recovery party requires an exact storage identity");
		if (this.shuttingDown || signal.aborted) return;
		const party: RecoveryOwner = { signal };
		this.recoveryParties.set(storageId, party);
		this.partyEpochs.set(storageId, randomUUID());
		signal.addEventListener(
			"abort",
			() => {
				if (this.recoveryParties.get(storageId) !== party) return;
				this.recoveryParties.delete(storageId);
				this.partyEpochs.delete(storageId);
			},
			{ once: true },
		);
		this.startRecoveryReconcile();
		void this.scanRecovery(party, storageId).catch((error) => {
			this.failures.set(`party:${storageId}`, errorText(error));
		});
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
		if (!this.reloadedSignals.has(signal)) {
			this.liveActivity?.forOwner(ownerId, primary.liveActivity, false);
		}
		if (!this.activityPrimary(ownerId)) this.liveActivity?.forgetOwner(ownerId);
		this.primaryChannels.delete(ownerId);
		this.partyEpochs.delete(ownerId);
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
		this.footerPages.delete(ownerId);
		try {
			if (!this.reloadedSignals.has(signal)) primary.status?.(undefined);
		} catch (error) {
			this.failures.set(`primary-status:${ownerId}`, errorText(error));
		}
		if (!this.primaries.size) {
			this.stopHostSupervision();
			this.releaseClients();
		}
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

	/**
	 * The first input of any source ends capture, and only interactive input supplies the observed fallback. A
	 * session that an extension or a client started, such as by a handover pickup or a command's kickoff, has
	 * message history before its first typed input, so that input is not its first request.
	 */
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
		primary.observedInputCanCapture = false;
		if (!excerpt) return false;
		primary.observedInput = excerpt;
		this.primaryChannels.get(ownerId)?.setObservedPurpose(this.observedPurpose(primary));
		this.rosterChanged();
		return true;
	}

	/**
	 * The session saved its first transcript entry, so deliveries that its sources kept while it had no file can
	 * now reach it. The registration's own recovery reads them; nothing else changes.
	 */
	primaryRetains(ownerId: string): void {
		const primary = this.primaries.get(ownerId);
		if (primary === undefined || this.stopping(primary)) return;
		this.partyEpochs.set(ownerId, randomUUID());
		void this.scanRecovery(primary, ownerId).catch((error) => {
			this.failures.set(`primary:${ownerId}`, errorText(error));
		});
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
		due: readonly RecoveryDemand[],
		primary: RecoveryOwner,
		readAt: number,
		registeringParty?: string,
	): Promise<void> {
		let next = 0;
		const recover = async () => {
			while (!this.stopping(primary) && next < due.length) {
				const demand = due[next++];
				if (demand) {
					this.queuedRecovery.delete(demand.record.storageId);
					await this.recover(demand, primary, readAt, registeringParty);
				}
			}
		};
		const recovery = this.recoveryQueue.then(async () => {
			await Promise.all([recover(), recover()]);
		});
		this.recoveryQueue = recovery.catch(() => undefined);
		await recovery;
		for (const demand of due.slice(next)) this.queuedRecovery.delete(demand.record.storageId);
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

	private recoveryLaunchNeeded(storageId: string, primary: RecoveryOwner): boolean {
		if (this.stopping(primary) || this.crashes.get(storageId)?.stopped) return false;
		return this.executionDemand(storageId);
	}

	/** Acquire the host of one due record and note the outcome for the reads that began before it. */
	private async acquireRecovery(
		storageId: string,
		primary: RecoveryOwner,
		launchNeeded: () => boolean,
		recoveryRecipients?: () => readonly string[],
	): Promise<HostConnection> {
		let outcome = true;
		try {
			return await (this.options.acquire ?? acquireHost)(
				hostMetadata(this.catalog.read(storageId), this.options.packageDir),
				{ ...MANAGED_LINK, launchNeeded, recoveryRecipients },
			);
		} catch (error) {
			// A launch that this read no longer needs says nothing about what another read needs.
			outcome = !(error instanceof HostLaunchDemandEnded || error instanceof HostDeliveryOnly);
			throw error;
		} finally {
			// A stopped owner's acquisition proves nothing for the reads of other owners.
			if (this.stopping(primary)) this.recoveryOrder.withdraw(storageId);
			else if (outcome) this.recoveryOrder.settled(storageId);
		}
	}

	private async recover(
		demand: RecoveryDemand,
		primary: RecoveryOwner,
		readAt: number,
		registeringParty?: string,
	): Promise<void> {
		const { record } = demand;
		if (this.crashes.get(record.storageId)?.stopped) return;
		if (await this.refreshRecoveryClient(record.storageId)) return;
		if (this.recovering.has(record.storageId)) return;
		// An acquisition for this storage settled after this record was read; its outcome is the newer fact.
		if (this.recoveryOrder.done(record.storageId, readAt)) return;
		if (demand.execution && this.recoveryHolds.has(record.storageId)) {
			if (registeringParty === undefined) return;
			this.recoveryHolds.set(record.storageId, Symbol());
		}
		// A launch that keeps failing waits for its window; a registration is an explicit act and tries at once.
		if (registeringParty === undefined && this.launchWaits(record.storageId)) return;
		if (!demand.execution) return this.recoverDelivery(demand, primary);
		return this.recoverExecution(demand, primary);
	}

	private async recoverExecution(demand: RecoveryDemand, primary: RecoveryOwner): Promise<void> {
		const { record } = demand;
		this.recovering.add(record.storageId);
		try {
			const launchNeeded = () => this.recoveryLaunchNeeded(record.storageId, primary);
			if (!launchNeeded()) {
				this.recovering.delete(record.storageId);
				return;
			}
			const client = await this.acquireRecovery(record.storageId, primary, launchNeeded, () =>
				this.stopping(primary)
					? []
					: demand.recipients.filter(
							(party) =>
								this.recoveryPartyIds().includes(party) &&
								readRecipientHint(this.options.root, party, record.storageId)?.execution === true,
						),
			);
			await this.monitorAcquired(record.storageId, client, primary);
		} catch (error) {
			this.recovering.delete(record.storageId);
			if (error instanceof HostDeliveryOnly && !this.stopping(primary)) return this.recoverDelivery(demand, primary);
			if (error instanceof HostLaunchDemandEnded) return;
			this.recoveryFailed(record.storageId, error);
		}
	}

	private async monitorAcquired(storageId: string, client: HostConnection, primary: RecoveryOwner): Promise<void> {
		if (this.stopping(primary)) {
			await client.close();
			this.recovering.delete(storageId);
			return;
		}
		this.recoveryErrors.delete(storageId);
		this.recoveryHolds.delete(storageId);
		this.launchFailures.clear(storageId);
		await this.monitorRecovery(storageId, client, primary);
	}

	/** The hint files and party registrations that a delivery-only attempt saw; a new attempt needs a change. */
	private deliveryState(demand: RecoveryDemand): string {
		return JSON.stringify(
			demand.recipients.map((recipient) => {
				const stat = statSync(recipientHintPath(this.options.root, recipient, demand.record.storageId), {
					throwIfNoEntry: false,
				});
				return [recipient, this.partyEpochs.get(recipient), stat?.ino, stat?.mtimeMs, stat?.size];
			}),
		);
	}

	/**
	 * Delivery-only demand never starts the source's scheduler. A running source delivers once it reads its
	 * recovery state; a source without a host delivers through a cold writer that routes only these recipients'
	 * rows. Each attempt waits for a change of the hints or of the recipients' registrations.
	 */
	private async recoverDelivery(demand: RecoveryDemand, primary: RecoveryOwner): Promise<void> {
		const { storageId } = demand.record;
		const state = this.deliveryState(demand);
		const previous = this.deliveryAttempts.get(storageId);
		if (previous?.state === state && Date.now() < previous.retryAt) return;
		this.deliveryAttempts.set(storageId, { state, retryAt: Infinity });
		this.recovering.add(storageId);
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				if (await this.attachDeliveryHost(storageId, primary)) return;
				if (this.stopping(primary)) break;
				const outcome = await (this.options.deliverCold ?? deliverColdStorage)(
					hostMetadata(demand.record, this.options.packageDir),
					demand.recipients,
					{ signal: primary.signal },
				);
				// A host took the writer lease meanwhile: it delivers once it reads its recovery state.
				if ("busy" in outcome) {
					if (attempt === 0) continue;
					throw new HostBusyEndpointUnavailableError(storageId, "The cold writer lease is held");
				}
				this.coldDelivered(storageId, state, outcome.result);
				break;
			}
			this.recovering.delete(storageId);
		} catch (error) {
			this.recovering.delete(storageId);
			this.deliveryAttempts.delete(storageId);
			this.recoveryFailed(storageId, error);
			this.launchReplay.arm(this.launchFailures.waitsUntil(storageId) ?? Date.now() + 1000);
		}
	}

	private async attachDeliveryHost(storageId: string, primary: RecoveryOwner): Promise<boolean> {
		try {
			const client = await this.acquireRecovery(storageId, primary, () => false);
			await this.monitorAcquired(storageId, client, primary);
			return true;
		} catch (error) {
			if (!(error instanceof HostLaunchDemandEnded)) throw error;
			return false;
		}
	}

	private coldDelivered(storageId: string, state: string, result: ColdDeliveryResult): void {
		this.launchFailures.clear(storageId);
		this.recoveryErrors.delete(storageId);
		const note =
			result.interrupted === true
				? "Holds work that its host stopped while it ran, so rows for this session wait for that work to resume: its owner's next registration resumes it, or agent_attach resumes it now."
				: result.remaining.length
					? `Delivery waits for ${result.remaining.join(", ")}.`
					: undefined;
		if (!result.interrupted && result.remaining.length) {
			const retryAt = Date.now() + RECOVERY_RECONCILE_MS;
			this.deliveryAttempts.set(storageId, { state, retryAt });
			this.launchReplay.arm(retryAt);
		}
		if (this.recoveryNotes.get(storageId) === note) return;
		if (note === undefined) this.recoveryNotes.delete(storageId);
		else this.recoveryNotes.set(storageId, note);
		void this.refreshFooter();
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
		} catch (error) {
			this.recordRecoveryError(storageId, errorText(error));
			return;
		}
		// Only a registered party's unfinished work there relaunches a lost host. A host that failed while it held
		// only rows to deliver is tried again through the delivery path, which never starts its scheduler.
		if (!this.executionDemand(storageId)) {
			void client.ownedExit?.then(
				(outcome) => {
					if (!outcome.failed || client.ownerReleased || this.shuttingDown) return;
					this.deliveryAttempts.delete(storageId);
					this.recoverCatalogueChanges();
				},
				() => undefined,
			);
			return;
		}
		const recover = () => {
			if (this.recoveryHolds.get(storageId) !== loss || this.shuttingDown || client.ownerReleased) return;
			const primary = [...this.primaries.values(), ...this.recoveryParties.values()].find(
				(candidate) => !this.stopping(candidate),
			);
			if (!primary || this.queuedRecovery.has(storageId)) return;
			try {
				const record = this.catalog.read(storageId);
				const recipients = this.executionRecipients(storageId);
				if (!recipients.length || this.crashes.get(storageId)?.stopped) return;
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
				void this.enqueueRecovery([{ record, execution: true, recipients }], primary, order.at)
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
		const activity = this.activityFeed(storageId, client, () => !closed && !this.clients.has(storageId));
		let unsubscribe = () => {};
		let removeClose = () => {};
		let checking = false;
		let again = false;
		const close = () => {
			if (closed) return;
			closed = true;
			activity?.unavailable();
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
				unsubscribe = await client.subscribeChanges(
					(frame) => {
						activity?.receive(frame);
						void check();
					},
					primary.signal,
					activity,
				);
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

	private activityPrimary(sessionId: string): boolean {
		const primary = this.replacingPrimaries.get(sessionId) ?? this.primaries.get(sessionId);
		return primary?.liveActivity !== undefined && !this.stopping(primary);
	}

	/** Look up creation lineage at link setup, never on a catalogue notice or an ordinary render. */
	private activityFeed(storageId: string, client: HostConnection, current: () => boolean) {
		const projection = this.liveActivity;
		if (
			projection === undefined ||
			client.subscribeChanges === undefined ||
			(this.primaries.size === 0 && this.replacingPrimaries.size === 0)
		)
			return undefined;
		let sessionId: string | undefined;
		try {
			sessionId = this.catalog.ordinaryOwner(client.metadata.ownerId);
		} catch {
			return undefined;
		}
		if (sessionId === undefined || !this.activityPrimary(sessionId)) return undefined;
		const owner = sessionId;
		const active = () => current() && this.activityPrimary(owner);
		return {
			sessionId,
			active,
			unavailable: () => projection.withdraw(storageId, client),
			receive: (frame: HostChanges) => {
				if (active()) projection.replace(storageId, client, owner, frame.writerId, frame.view);
			},
		};
	}

	private async subscribe(storageId: string, client: HostConnection): Promise<void> {
		const current = () => this.clients.get(storageId) === client;
		const activity = this.activityFeed(storageId, client, current);
		this.subscriptions.get(storageId)?.();
		this.subscriptions.delete(storageId);
		client.onClose(() => {
			activity?.unavailable();
			if (!current()) return;
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
		const unsubscribe = await client.subscribeChanges(
			(frame) => {
				activity?.receive(frame);
				this.catalogChanged([storageId]);
			},
			this.lifecycle.signal,
			activity,
		);
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
			// The page of this primary's last projection gives the same text as that projection, marker included.
			const page = this.footerPages.get(ownerId);
			const footer = page ? this.footerForPage(ownerId, page) : this.footerForRows(ownerId, this.toolCardRows);
			this.footerFigures.set(ownerId, footerKey(footer));
			primary.status?.(footer.text || undefined, footer.stuck);
		} catch (error) {
			this.failures.set("footer", errorText(error));
		}
		this.rosterChanged();
	}

	/** Exact successful task admissions, for presentation-side relationship joins only. */
	dashboardTaskTargets(ownerId: string): readonly string[] {
		return [...(this.primaries.get(ownerId)?.sentWork ?? [])];
	}

	/** UI-local session totals reuse the roster and the primary's retained sent-work identities. */
	async sessionFigures(ownerId: string, page?: AgentConversationPage): Promise<string> {
		return this.footerForPage(ownerId, page ?? (await this.dashboardPage({ ownerId }))).text;
	}

	/** Explicit pages retain their own coverage; the primary's notice projection owns its totals. */
	private footerForPage(ownerId: string, page: AgentConversationPage | "projected"): SessionFooter {
		if (page === "projected") {
			this.footerProjection.updateOwner(ownerId, this.primaries.get(ownerId)?.sentWork);
			return this.footerProjection.figures(ownerId);
		}
		const footer = this.footerForRows(ownerId, page.rows);
		return page.coverage.complete ? footer : { ...footer, text: footer.text.replace(/^(agents: \d+\/\d+)/u, "$1+") };
	}

	private footerForRows(ownerId: string, rows: readonly AgentConversationSummary[]): SessionFooter {
		return sessionFooter(
			rows,
			ownerId,
			(storageId) => this.inventory.ownerId(storageId),
			this.primaries.get(ownerId)?.sentWork,
			(storageId) => this.recoveryErrors.get(storageId) !== undefined,
		);
	}

	private readonly footerProjection = new FooterProjection();
	private footerSeeded = false;
	private toolCardRowsDirty = false;
	private footerLocal = new Set<string>();
	private readonly footerLocalDirty = new Set<string>();

	private async refreshFooter(): Promise<void> {
		// Local launch and recovery state can change without a catalogue write.
		const current = new Set([
			...this.launchRows.keys(),
			...this.clients.keys(),
			...this.recoveryClients.keys(),
			...[...this.recoveryErrors.entries].map(([id]) => id),
			...[...this.recoveryNotes.entries].map(([id]) => id),
		]);
		for (const id of this.footerLocal) this.footerLocalDirty.add(id);
		for (const id of current) this.footerLocalDirty.add(id);
		this.footerLocal = current;
		this.rosterChanged();
		await this.projectFooter();
	}

	private projectFooterStorage(fact: CatalogFact | null | undefined): FooterStorage | undefined {
		if (fact === undefined) return undefined;
		if (fact === null) return { rows: [], incomplete: true, blocked: false };
		const { record, claim, observedAt } = fact;
		if (isThreadStorage(record, this.catalog.root)) return undefined;
		const projection = this.catalogRows(record, claim, observedAt);
		const error = this.recoveryErrors.get(record.storageId);
		const note = this.recoveryNotes.get(record.storageId);
		return {
			rows: projection.rows.map((row) => ({
				...row,
				...(record.ownerId ? { creatingOwnerId: record.ownerId } : {}),
				...(note === undefined ? {} : { ownerLabel: `${note} ${row.ownerLabel ?? ""}`.trim() }),
				...(error === undefined ? {} : { health: { ...row.health, lastError: error } }),
			})),
			incomplete: projection.skipped > 0 || projection.omitted > 0 || !projection.resolvedClaim,
			blocked: error !== undefined,
		};
	}

	private publishFooter(ownerId: string): void {
		const primary = this.primaries.get(ownerId);
		if (!primary || primary.signal.aborted) return;
		const footer = this.footerProjection.figures(ownerId);
		// Do not render again when the figures and intervention targets did not change.
		const key = footerKey(footer);
		if (this.footerFigures.get(ownerId) !== key) {
			this.footerFigures.set(ownerId, key);
			primary.status?.(footer.text || undefined, footer.stuck);
		}
	}

	private async refreshFooterProjection(): Promise<void> {
		const registrations = new Map<string, PrimaryClient>();
		for (const [id, primary] of this.primaries) if (!this.footerPages.has(id)) registrations.set(id, primary);
		// A new primary needs the current inventory even if a writer's notice is still in flight.
		if (registrations.size && this.footerSeeded)
			await this.inventory.read({ reconcileAfterMs: BACKGROUND_RECONCILE_MS });
		const facts = await this.inventory.readChanges();
		if (this.shuttingDown) return;
		this.footerSeeded = true;
		this.footerProjection.retainOwners(this.primaries);
		const complete = this.footerProjection.complete;
		const affected = this.applyFooterFacts(facts);
		const coverageChanged = complete !== this.footerProjection.complete;
		for (const [ownerId, primary] of this.primaries) {
			const newOwner = !this.footerPages.has(ownerId);
			if (newOwner) {
				if (registrations.get(ownerId) !== primary) continue;
				this.footerProjection.updateOwner(ownerId, primary.sentWork, true);
				this.footerPages.set(ownerId, "projected");
			}
			if (newOwner || affected.has(ownerId) || coverageChanged) this.publishFooter(ownerId);
		}
	}

	private applyFooterFacts(facts: ReadonlyMap<string, CatalogFact | null | undefined>): ReadonlySet<string> {
		const updates = new Map<string, FooterStorage | undefined>();
		for (const [id, fact] of facts) updates.set(id, this.projectFooterStorage(fact));
		for (const id of this.footerLocalDirty)
			if (!updates.has(id)) updates.set(id, this.projectFooterStorage(this.inventory.currentFact(id)));
		this.footerLocalDirty.clear();
		if (updates.size) this.observeToolCardRows();
		return this.footerProjection.apply(updates, (id) => this.inventory.ownerId(id));
	}

	/** Apply one catalogue batch and write only affected primary footers. */
	private async projectFooter(): Promise<void> {
		if (this.shuttingDown || !this.primaries.size) return;
		if (this.refreshing) {
			this.refreshAgain = true;
			return;
		}
		this.refreshing = true;
		try {
			do {
				this.refreshAgain = false;
				await this.refreshFooterProjection();
			} while (this.refreshAgain && !this.shuttingDown && this.primaries.size);
		} catch (error) {
			this.failures.set("footer", errorText(error));
		} finally {
			this.refreshing = false;
		}
	}

	private releaseClients(): void {
		this.liveActivity?.clear();
		this.launchRows.clear();
		for (const client of this.recoveryClients.values()) client.close();
		for (const unsubscribe of this.subscriptions.values()) unsubscribe();
		this.subscriptions.clear();
		const clients = [...this.clients.values()];
		this.clients.clear();
		for (const client of clients) void client.close();
	}

	/** Start the host check once a primary registers: one check now, then one per interval. */
	private startHostSupervision(): void {
		const supervise = this.options.superviseHosts;
		if (supervise === undefined || supervise === false || this.supervisionTimer !== undefined || this.shuttingDown)
			return;
		const minutes = readSettings({ agentDir: this.options.agentDir }).values.hostCheckMinutes;
		if (!(minutes > 0)) return;
		this.supervisionTimer = setInterval(() => void this.checkHosts(), minutes * 60_000);
		this.supervisionTimer.unref?.();
		void this.checkHosts();
	}

	private stopHostSupervision(): void {
		if (this.supervisionTimer !== undefined) clearInterval(this.supervisionTimer);
		this.supervisionTimer = undefined;
	}

	/** One host check; its acts join the bounded status record, and an ended host's storage gets a recovery scan. */
	checkHosts(): Promise<void> {
		if (this.supervisionRun !== undefined) return this.supervisionRun;
		const supervise = this.options.superviseHosts;
		const injected = typeof supervise === "object" ? supervise : {};
		if (this.supervisionReported.size > SUPERVISION_REPORTED_LIMIT) this.supervisionReported.clear();
		this.supervisionRun = (async () => {
			const values = readSettings({ agentDir: this.options.agentDir }).values;
			const run = await superviseHosts({
				activeRoot: configuredAgentRoot(this.options.agentDir),
				...injected,
				agentDir: this.options.agentDir,
				stuckMs: values.stuckHostMinutes * 60_000,
				idleMs: values.idleMinutes * 60_000,
				reported: this.supervisionReported,
			});
			this.supervisionActs.push(...run.acts);
			this.supervisionActs.splice(0, Math.max(0, this.supervisionActs.length - SUPERVISION_ACT_LIMIT));
			this.supervisionLast = {
				checkedAt: run.checkedAt,
				hosts: run.hosts,
				...(run.skipped === undefined ? {} : { skipped: run.skipped }),
			};
			this.failures.delete("host-check");
			if (run.ended.length > 0 && !this.shuttingDown) this.recoverCatalogueChanges();
		})()
			.catch((error) => {
				this.failures.set("host-check", errorText(error));
			})
			.finally(() => {
				this.supervisionRun = undefined;
			});
		return this.supervisionRun;
	}

	/** The latest host check and its recent acts, for status. */
	hostSupervision(): HostSupervisionSummary | undefined {
		if (this.supervisionLast === undefined) return undefined;
		return { ...this.supervisionLast, acts: [...this.supervisionActs] };
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.shuttingDown = true;
		this.stopHostSupervision();
		if (this.reconcileTimer !== undefined) clearInterval(this.reconcileTimer);
		this.reconcileTimer = undefined;
		this.cancelFooterProjection();
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
