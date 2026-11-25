/**
 * agent/durable-delivery: cross-storage delivery from one Durable host to the
 * owner that is entitled to the result.
 *
 * A durable agent can submit work into a foreign storage with an owner identity
 * from its own storage. The foreign storage retains that result as a delivery
 * receipt or report. This watcher runs beside the source storage: after every
 * native commit it settles pending intents, routes each unacknowledged row, and
 * acknowledges only the owners that accepted their normal delivery.
 *
 * Routing: an owner with a discovery catalog record receives an untrusted
 * follow-up in its own Durable host. Without a catalog record, only a canonical
 * primary identity can use a registered primary channel, and only the exact
 * owner's channel: no other session receives a row or a copy of it. An owner
 * that is absent, has no saved transcript, keeps none, or refused the row parks
 * it in durable storage without a retry timer until its own facts change.
 * Reachable recipients retry transient transport failures. Malformed identities
 * and corrupt origins retain terminal reasons and never retry.
 *
 * Delivery is at-least-once. Request IDs and channel source IDs derive from the
 * source storage and the answer, unanswered submission, or report identity.
 * Retries and reopens reuse them for recipient-local deduplication.
 */
import { createHash } from "node:crypto";
import {
	COMMUNICATION_BODY_BYTES,
	COMMUNICATION_VALUE_BYTES,
	communicationSerializedBytes,
	communicationRequestId,
	parseCommunication,
	parseCommunicationPassive,
	type Communication,
} from "./communication.ts";
import type { InputProvenance } from "./awaited-results.ts";
import { canonicalIdentity } from "./native-identity.ts";
import type { ReceiptAssociation, ReceiptReferencePage, ResultReference } from "./result-schema.ts";
import { modelFailureText, providerBlockText } from "./provider-block-facts.ts";
import { join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { threadExcerpt, threadRecoveryText } from "./thread-notice-projection.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	finalReportDeliveryFacts,
	finalReportToItself,
	receiptDependencyMark,
	reportDependencyMarks,
	requestHasOpenWork,
	requestWork,
	type DependencyMark,
	type FinalReportDeliveryFacts,
	type FinalReportRead,
	type RequestWork,
} from "./open-work.ts";
import {
	LiveDoc,
	type ConversationId,
	type EntryId,
	type Harness,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import { type AgentCatalog, type CatalogRecord, hostMetadata, storageIdOf } from "./catalog.ts";
import { isThreadStorage, threadStorageUnanswered } from "./identity.ts";
import { foldContinuity } from "./continuity-facts.ts";
import { ContinuityDoc } from "./continuity-native.ts";
import {
	acknowledgeReports,
	type DeliveryOrigin,
	type DeliveryReceipt,
	type DeliveryReport,
	type DeliveryIntent,
	type DeliveryDisposition,
	type AgentDeliveryState,
	settleDeliveries,
	providerRetryReportSettled,
} from "./durable-controls.ts";
import { readTaskGraph, type DurableHost } from "./durable-host.ts";
import { CHECK_IN_DEADLINE_TASK, CheckInParkedSignal, resumePausedCheckIn } from "./durable-checkins.ts";
import {
	receiptSourceIdentity,
	receiptDeliveryRequestId,
	receiptReferencePage,
	receiptReferenceSlice,
	type ReceiptPageMember,
	snapshotReceipt,
	deliveryPendingCount,
	deliveryState,
	intentKey,
	receiptKey as storedReceiptKey,
	reportKey,
	pendingDeliveryPage,
	reloadDeliveryRows,
	terminalDeliveryState,
	retainedIntent,
	retainedReceipt,
	retainedReport,
	storeDeliveryRow,
} from "./delivery-store.ts";
import { resolveSessionConversationId } from "./durable-observation.ts";
import { acquireHost, hostAttempt, type HostConnection } from "./host-client.ts";
import { HostError, HostLeaseBusyError, type HostMetadata } from "./host-protocol.ts";
import { isChordError } from "@earendil-works/chord";
import { DELIVERY_WAKE_RECIPIENT_LIMIT, nativeRecipientAvailability } from "./recipient-availability.ts";
import { recipientStorage } from "./recipient-hints.ts";
import {
	connectPrimaryChannel,
	primaryEndpointIncompatibleError,
	primaryEndpointStatus,
	primaryRecipientStatus,
	primaryRefusalKind,
	readPrimaryEndpointDescriptor,
	verifyPrimaryOwners,
	type PrimaryTranscript,
	type PrimaryDelivery,
} from "./primary-channel.ts";

const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;
const REPORT_KEY_CHARS = 32;
/** Registered primary ids are canonical lowercase UUIDs of any version. */
const PRIMARY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Bound for one peer body; the marker names the retained source for the full text. */
/** UTF-16 units of a message body that a recipient reads; a longer body keeps its head. */
export const PEER_TEXT_LIMIT = 16_000;
const PEER_TRUNCATION_MARKER = "\n\n[text truncated; use agent_inspect for retained full text]";
/** The passive-submit host operation bounds the entire model message, not its body. */
const PASSIVE_MESSAGE_BYTES = 16 * 1024;
const PASSIVE_REPORT_TRUNCATION = "\n\n[text truncated; the sender's delivery record retains the full report]";

/** Storage prefix of one external identity, for the same-storage check; the catalog owns strict validation. */
function ownerStorageId(identity: string): string {
	const separator = identity.indexOf(":");
	return separator < 0 ? identity : identity.slice(0, separator);
}

/** Bound one peer body without splitting a surrogate pair. */
function peerTextPrefix(text: string): string {
	if (text.length <= PEER_TEXT_LIMIT) return text;
	const last = text.charCodeAt(PEER_TEXT_LIMIT - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? PEER_TEXT_LIMIT - 1 : PEER_TEXT_LIMIT);
}

function boundedPeerText(text: string): { text: string; truncated: boolean } {
	const prefix = peerTextPrefix(text);
	return prefix === text ? { text, truncated: false } : { text: `${prefix}${PEER_TRUNCATION_MARKER}`, truncated: true };
}

/**
 * Bound one report body. A thread body recovers through its typed thread read: a cut names that
 * exact call once and never the generic inspection advice.
 */
function boundedReportText(report: DeliveryReport, text = report.message): { text: string; truncated: boolean } {
	if (report.threadId === undefined) return boundedPeerText(text);
	const excerpt = threadExcerpt(text, PEER_TEXT_LIMIT);
	if (!excerpt.cut) return { text, truncated: false };
	const recovery = threadRecoveryText(report.threadId, report.threadEvent);
	return { text: `${excerpt.text} [cut]${excerpt.text.includes(recovery) ? "" : `\n\n${recovery}`}`, truncated: true };
}

export interface NativeTargetFailure {
	readonly reason: string;
	readonly availability: string;
}

export interface DurableDeliveryOptions {
	readonly host: DurableHost;
	/** Source host metadata; `storageId` names this storage in routed request IDs. */
	readonly metadata: HostMetadata;
	readonly catalog: AgentCatalog;
	/** Aborted when the host shuts down; ends retries and closes target links. */
	readonly signal: AbortSignal;
	readonly onError?: (error: Error) => void;
	/** Completion of all effects in one delivery pass; permits a new host idle interval. */
	readonly onIdle?: () => void;
	/** Target host acquisition; defaults to `acquireHost`. Tests inject a fake backed by a real Harness. */
	readonly acquire?: typeof acquireHost;
	/** Resolve native namespace ownership; undefined means a separately verified ordinary target. */
	readonly readTarget?: (identity: string) => CatalogRecord | undefined;
	/** Connect through the resolved target's retained source and installation. */
	readonly connectTarget?: (record: CatalogRecord) => Promise<HostConnection>;
	/** Release the namespace resolver after target links and in-flight delivery close. */
	readonly onClose?: () => void | Promise<void>;
	/** Base delay after a transient failure; doubles to 30 s. Defaults to 500 ms. */
	readonly retryDelayMs?: number;
	/** Root of the primary endpoint directory; defaults to `PI_AGENT_SESSIONS_DIR` or `<agentDir>/agent-sessions`. */
	readonly sessionsRoot?: string;
	/** Failed native acquisitions stay parked until a new watcher or explicit refresh. */
	readonly unavailableTargets?: Map<string, NativeTargetFailure>;
	/**
	 * Whether this host retries transient provider errors, from Pi's retry settings. When it does not, and the
	 * stored run of an input shows that such an error ended it at the first attempt, the notice says so; a
	 * requester otherwise cannot tell a disabled retry from a provider that failed every attempt.
	 */
	readonly retriesProviderErrors?: () => boolean;
	/**
	 * Route only the rows of these recipient storages, and signal no task: the delivery of a storage whose scheduler
	 * stays paused. Every pending row still enters the summary.
	 */
	readonly recipients?: ReadonlySet<string>;
}

export interface DeliverySummary {
	readonly pendingCount: number;
	readonly active: boolean;
	readonly complete: boolean;
	readonly fresh: boolean;
	readonly blocker?: string;
	readonly parkedRecipients: readonly string[];
	readonly parkedRows: Readonly<Record<string, number>>;
	/** Pending parked rows whose recipient did not fit the bounded set. */
	readonly parkedOmitted: number;
	readonly activeRecipients: readonly string[];
	/**
	 * Recipient storages with a pending row of the completed traversal, each true when one of its rows is an
	 * unsettled admission: the source holds unfinished work for it, not only rows to deliver.
	 */
	readonly demand: ReadonlyMap<string, boolean>;
	/** Sequence number of the traversal that produced this summary, and of the latest traversal that began. */
	readonly traversal: number;
	readonly started: number;
}

export interface DurableDelivery {
	readonly busy: boolean;
	/** No payload reads. Relevant endpoint checks are reserved for recovery and retirement. */
	summary(validateRecipients?: boolean): DeliverySummary;
	/** Request a scan after a recovery acquisition or endpoint registration, without polling. */
	refresh(): void;
	/** Stop new delivery effects synchronously; close still owns link and in-flight cleanup. */
	sealAdmission(): void;
	close(): Promise<void>;
}

type ReceiptRow = {
	readonly kind: "receipt";
	readonly receipt: DeliveryReceipt;
	readonly receipts: DeliveryReceipt[];
	receiptGroup?: ReceiptReferencePage & { members: ReceiptPageMember[] };
	groupDecision?: { wake: boolean; onlyNotes: boolean; result?: ResultReference };
	displayReason?: string;
	readonly deliveredTo: Set<string>;
};

type DeliveryRow =
	| ReceiptRow
	| { readonly kind: "report"; readonly report: DeliveryReport; readonly deliveredTo: Set<string> };

/** Structured source facts are captured independently of transport prose. */
function receiptCommunication(
	row: ReceiptRow,
	storageId: string,
	group: ReceiptReferencePage,
	members: readonly ReceiptPageMember[],
): Communication {
	const receipt = row.receipt;
	return {
		format: "agent.communication/1",
		kind: "result",
		sender: { identity: canonicalIdentity(storageId, receipt.conversationId) },
		body: {
			text: inlineAnswer(receipt) ?? row.displayReason ?? receipt.reason ?? "",
			complete: receipt.answerTruncated === false,
			redacted: false,
		},
		recordedAt: 0,
		metadata: {
			status: receipt.status,
			references: members.map((member) => ({
				submissionId: member.submissionId,
				...(communicationRequestId(member.requestId) ? { requestId: member.requestId } : {}),
				...(member.entryId === null ? {} : { entryId: String(member.entryId) }),
				...(member.answerEntryId === null ? {} : { answerEntryId: String(member.answerEntryId) }),
			})),
			omittedReferences: row.receipts.filter(
				(item) => !members.some((member) => member.submissionId === item.submissionId),
			).length,
			...(receipt.reason === null ? {} : { reason: row.displayReason ?? receipt.reason }),
			...receiptGroupContinuation(row, storageId, group.next),
		},
	};
}
function reportCommunication(report: DeliveryReport): Communication | undefined {
	const common = {
		format: "agent.communication/1" as const,
		sender: { identity: report.senderIdentity },
		body: { text: report.message, complete: false, redacted: false },
		recordedAt: report.createdAt,
	};
	if (report.threadId !== undefined) {
		if (report.operatorMessage === undefined) return undefined;
		return {
			...common,
			kind: "notice",
			body: { ...common.body, text: report.operatorMessage },
			metadata: {
				threadId: report.threadId,
				...(report.threadTitle === undefined ? {} : { title: report.threadTitle }),
				...(report.threadEvent === undefined ? {} : { event: report.threadEvent }),
				...(report.threadFrameRevision === undefined ? {} : { frameRevision: report.threadFrameRevision }),
				...(report.threadEventKind === undefined ? {} : { eventKind: report.threadEventKind }),
				passive: report.passive === true,
			},
		};
	}
	if (report.checkIn !== undefined)
		return {
			...common,
			kind: "check-in",
			metadata: {
				sourceId: report.sourceId,
				producerRequestId: report.checkIn.requestId,
				elapsedMs: report.checkIn.elapsedMs,
				origin: report.checkIn.origin,
			},
		};
	return {
		...common,
		kind: "report",
		body: { ...common.body, complete: report.passive === true },
		metadata: {
			sourceId: report.sourceId,
			requestId: report.requestId,
			...(report.replyTo === null ? {} : { replyTo: report.replyTo }),
			...(report.passive === undefined ? {} : { passive: report.passive }),
		},
	};
}
/** The body within its own byte bound; a body that this cut shortens is not complete. */
function withBoundedBody<T extends Communication>(value: T): T {
	let text = "";
	let bytes = 0;
	for (const point of value.body.text) {
		const size = Buffer.byteLength(point, "utf8");
		if (bytes + size > COMMUNICATION_BODY_BYTES) break;
		text += point;
		bytes += size;
	}
	return {
		...value,
		body: { ...value.body, text, complete: value.body.complete && !value.body.redacted && text === value.body.text },
	};
}
function deliveryCommunication(row: DeliveryRow, host: DurableHost): Communication | undefined {
	try {
		let value: Communication | undefined =
			row.kind === "report"
				? reportCommunication(row.report)
				: row.receiptGroup
					? receiptCommunication(row, host.storageId, row.receiptGroup, row.receiptGroup.members)
					: undefined;
		if (value === undefined) return undefined;
		value = withBoundedBody(value);
		while (!communicationFits(value) && value.body.text.length > 0) {
			const points: string[] = Array.from(value.body.text);
			value = {
				...value,
				body: { ...value.body, text: points.slice(0, Math.floor(points.length / 2)).join(""), complete: false },
			};
		}
		return parseCommunication(value);
	} catch {
		return undefined;
	}
}

/** Receipt admission replaces the producer's zero timestamp with the receiver's clock. */
function communicationFits(value: Communication) {
	return (
		communicationSerializedBytes(value.kind === "result" ? { ...value, recordedAt: Number.MAX_SAFE_INTEGER } : value) <=
		COMMUNICATION_VALUE_BYTES
	);
}
function deliveryCommunicationParams(row: DeliveryRow, host: DurableHost): { communication?: Communication } {
	const communication = deliveryCommunication(row, host);
	return communication === undefined ? {} : { communication };
}

/** Answer entries are storage-wide identities; unanswered inputs remain separate. */
function receiptKey(receipt: Pick<DeliveryReceipt, "answerEntryId" | "submissionId">): string {
	return receipt.answerEntryId === null ? `submission:${receipt.submissionId}` : `answer:${receipt.answerEntryId}`;
}

/**
 * The identity a refusal of one receipt's content holds for: its answer for its owner, which the transport source
 * identity also names. A delivery page that holds only part of an answer group finds the same identity.
 */
function receiptRefusalKey(receipt: Pick<DeliveryReceipt, "answerEntryId" | "submissionId" | "ownerId">): string {
	return `receipt:${JSON.stringify([receiptKey(receipt), receipt.ownerId])}`;
}

function receiptRows(receipts: readonly DeliveryReceipt[]): ReceiptRow[] {
	const groups = new Map<string, ReceiptRow>();
	for (const receipt of receipts) {
		const key = JSON.stringify([receiptKey(receipt), receipt.ownerId]);
		const group = groups.get(key);
		if (group === undefined) groups.set(key, { kind: "receipt", receipt, receipts: [receipt], deliveredTo: new Set() });
		else group.receipts.push(receipt);
	}
	return [...groups.values()];
}

function submissionLabel(row: ReceiptRow): string {
	return `submissions ${row.receipts.map((receipt) => receipt.submissionId).join(", ")}`;
}

interface SourceStatus {
	readonly senderKind?: "agent" | "session";
	readonly observedPurpose?: string;
	readonly metadataSource?: "primary-endpoint";
	readonly handle?: string | null;
	readonly retainedAt?: string;
	readonly name?: string | null;
	readonly owner?: string | null;
	readonly agent?: {
		readonly model?: { readonly provider?: string; readonly modelId?: string };
		readonly thinkingLevel?: string;
	};
}

/** Exact retained source evidence; catalog bootstrap choices are not live model facts. */
function retainedSourceStatus(catalog: AgentCatalog, identity: string): SourceStatus | undefined {
	try {
		const view = catalog.read(identity).view;
		const hint = view?.profiles?.rows.find((candidate) => candidate.identity === identity);
		const row = view?.rows.find((candidate) => candidate.id === identity);
		if (view === undefined || (row === undefined && hint === undefined)) return undefined;
		return {
			senderKind: "agent",
			retainedAt: view.updatedAt,
			...(hint === undefined ? {} : { handle: hint.handle }),
			...(row === undefined
				? {}
				: { name: row.name, agent: { model: row.model, thinkingLevel: row.model?.thinkingLevel } }),
		};
	} catch {
		return undefined;
	}
}

/** Read one canonical sender endpoint without discovery or connection side effects. */
function primarySourceStatus(sessionsRoot: string, identity: string): SourceStatus | undefined {
	const endpoint = readPrimaryEndpointDescriptor(sessionsRoot, identity);
	const info = endpoint.info;
	if (!info || endpoint.state === "incompatible") return undefined;
	return {
		senderKind: "session",
		name: info.name,
		observedPurpose: info.observedPurpose?.text,
		agent: { model: info.model, thinkingLevel: info.thinkingLevel },
		metadataSource: "primary-endpoint",
	};
}

/**
 * Admission origin of one receipt. A missing or malformed origin is corruption,
 * not a default: the row retains a terminal reason instead of silently
 * waking or suppressing one owner.
 */
function receiptOrigin(receipt: DeliveryReceipt): DeliveryOrigin {
	const origin = receipt.origin;
	if (origin !== "operator" && origin !== "model")
		throw new Error(`retained delivery ${receipt.submissionId} has no valid admission origin`);
	return origin;
}

function deliverySender(row: DeliveryRow, host: DurableHost): string {
	return row.kind === "receipt" ? host.identity(row.receipt.conversationId) : row.report.senderIdentity;
}

function stateNoteIds(states: readonly ReceiptState[]): Set<number> {
	return new Set(
		states
			.filter(({ receipt, work }) => work !== undefined && (receipt.status === "done" || receipt.recoveredWork))
			.map(({ receipt }) => receipt.submissionId),
	);
}

function onlyStateNotes(row: ReceiptRow, states: readonly ReceiptState[]): boolean {
	if (row.groupDecision) return row.groupDecision.onlyNotes;
	const notes = stateNoteIds(states);
	return row.receipts.length > 0 && row.receipts.every((receipt) => notes.has(receipt.submissionId));
}

/**
 * A receipt wakes its model owner unless it carries only state notes: the answer of a request whose declared work
 * continues is context, and its final report arrives as a separate report that wakes. `states` names the declared
 * work of the receipts it covers; a receipt without a state there counts as a result.
 */
export function rowWakes(row: DeliveryRow, recipient: string, states: readonly ReceiptState[] = []): boolean {
	if (row.kind === "report")
		return row.report.passive !== true && (row.report.checkIn === undefined || row.report.checkIn.origin === "model");
	if (row.groupDecision && recipient === row.receipt.ownerId) return row.groupDecision.wake;
	const own = row.receipts.filter((receipt) => receipt.ownerId === recipient);
	if (own.length === 0) return true;
	const stateNotes = stateNoteIds(states);
	return own.some((receipt) => receiptOrigin(receipt) === "model" && !stateNotes.has(receipt.submissionId));
}

/** A delivery page shares one receiver key with all receipts of the same answer and recipient. */
export async function groupWakeDecision(
	first: ReceiptReferencePage,
	next: (cursor: string) => Promise<ReceiptReferencePage>,
	classify: (id: number) => Promise<{ note: boolean; model: boolean }>,
) {
	let page = first;
	let result: ResultReference | undefined;
	for (;;) {
		for (const ref of page.results) {
			const { note, model } = await classify(ref.submissionId);
			if (!note) {
				result ??= ref;
				if (model) return { wake: true, onlyNotes: false, result };
			}
		}
		if (page.next === null) return { wake: false, onlyNotes: !result, ...(result ? { result } : {}) };
		page = await next(page.next);
	}
}

/** Plain outcome words for one settled receipt: an answer completes the native input, not declared work. */
function receiptOutcome(receipt: DeliveryReceipt): "completed native input" | "failed" | "stopped" {
	if (receipt.status === "done") return "completed native input";
	return receipt.reason === "aborted" ? "stopped" : "failed";
}

const DISPLAY_NAME_LIMIT = 60;

/** Collapse whitespace and bound one display name or first-task excerpt. */
function displayExcerpt(value: string): string {
	const collapsed = value.replace(/\s+/gu, " ").trim();
	return collapsed.length > DISPLAY_NAME_LIMIT ? `${collapsed.slice(0, DISPLAY_NAME_LIMIT - 1)}…` : collapsed;
}

/** Names and handles identify agents; primary purposes precede a short session ID. */
function displayName(status: SourceStatus | undefined, identity: string): string {
	const handle = typeof status?.handle === "string" ? displayExcerpt(status.handle) : "";
	if (handle !== "") return handle;
	const name = typeof status?.name === "string" ? displayExcerpt(status.name) : "";
	if (name !== "") return name;
	const purpose = status?.observedPurpose ? displayExcerpt(status.observedPurpose) : "";
	if (purpose !== "") return purpose;
	return identity;
}

/** Stable request ID for one settled receipt; reused across retries and reopens. */
function receiptRequestId(metadata: HostMetadata, receipt: DeliveryReceipt): string {
	return receiptDeliveryRequestId(metadata.storageId, receipt);
}

/** Stable request ID for one report, bounded by a digest of the source identity. */
function reportRequestId(metadata: HostMetadata, report: DeliveryReport): string {
	const digest = createHash("sha256").update(report.sourceId).digest("hex").slice(0, REPORT_KEY_CHARS);
	return `deliver:${metadata.storageId}:report:${digest}`;
}

/** Stable receiver dedup key for one routed row. */
function rowSourceId(metadata: HostMetadata, row: DeliveryRow): string {
	return row.kind === "receipt"
		? receiptSourceIdentity(metadata.storageId, row.receipt)
		: `${metadata.storageId}:${row.report.sourceId}`;
}
function receiptGroupContinuation(row: ReceiptRow, storageId: string, next = row.receiptGroup?.next) {
	return next == null
		? {}
		: {
				receiptContinuation: {
					tool: "agent_inspect",
					view: "result",
					sessionId: canonicalIdentity(storageId, row.receipt.conversationId),
					submissionId: row.receipt.submissionId,
					receiptCursor: next,
				} as const,
			};
}
function receiptGroupContinuationText(row: ReceiptRow, storageId: string): string {
	const page = row.receiptGroup;
	if (!page) return "";
	const shown = row.receipts.slice(0, RECEIPT_STATE_LINES);
	const ids = page.results.map((member) => member.submissionId);
	const same = ids.length === shown.length && ids.every((id, index) => id === shown[index].submissionId);
	const prefix = same ? "" : `\n\nFirst receipt page (submission IDs): ${ids.join(", ")}`;
	const continuation = receiptGroupContinuation(row, storageId).receiptContinuation;
	return continuation === undefined
		? prefix
		: `${prefix}\n\nReceipt references continue: ${JSON.stringify(continuation)}`;
}
function receiptAssociation(metadata: HostMetadata, row: ReceiptRow): ReceiptAssociation {
	return {
		sourceId: rowSourceId(metadata, row),
		requestId: receiptRequestId(metadata, row.receipt),
		recipient: row.receipt.ownerId,
		producerStorageId: metadata.storageId,
		...(row.receipt.answerEntryId === null ? {} : { answerEntryId: row.receipt.answerEntryId }),
		results:
			row.receiptGroup?.results ??
			row.receipts.slice(0, 16).map((receipt) => ({
				sessionId: canonicalIdentity(metadata.storageId, receipt.conversationId),
				submissionId: receipt.submissionId,
				requestId: receipt.requestId,
			})),
		complete: row.receiptGroup?.complete === true,
		...receiptGroupContinuation(row, metadata.storageId),
	};
}

function rowIsSaved(row: DeliveryRow): boolean {
	return row.kind === "report" || row.receipt.entryId !== null || row.receipt.answerEntryId !== null;
}
function passiveThreadDetails(row: DeliveryRow, host: DurableHost, metadata: HostMetadata) {
	if (row.kind !== "report" || row.report.passive !== true || row.report.threadId === undefined) return {};
	const value = deliveryCommunication(row, host);
	if (value?.kind !== "notice") return {};
	const communicationPassive = parseCommunicationPassive({
		format: "agent.communication-passive/1",
		requestId: reportRequestId(metadata, row.report),
		value,
	});
	return communicationPassive === undefined ? {} : { communicationPassive, passive: true, wake: false };
}
function rowOwners(row: DeliveryRow): string[] {
	return row.kind === "receipt"
		? [...new Set(row.receipts.filter((receipt) => !receipt.acknowledged).map((receipt) => receipt.ownerId))]
		: row.report.acknowledged
			? []
			: [row.report.ownerId];
}

/** A receipt without length facts may end halfway through a surrogate pair. */
function inlineAnswer(receipt: DeliveryReceipt): string | null {
	return receipt.answerTruncated === undefined
		? (receipt.answer?.replace(/[\uD800-\uDBFF]$/u, "") ?? null)
		: receipt.answer;
}

/** The displayed excerpt belongs to the shared answer, but only an undeclared request uses it as its result. */
function receiptContinuation(
	metadata: HostMetadata,
	row: ReceiptRow,
	states: readonly ReceiptState[],
	displayOffset?: number,
) {
	const { receipt } = row;
	if (
		receipt.status !== "done" ||
		receipt.answerEntryId === null ||
		(displayOffset === undefined && receipt.answerTruncated === false)
	)
		return undefined;
	const plain = states.find((state) => state.work === undefined)?.receipt;
	const target = plain
		? {
				sessionId: canonicalIdentity(metadata.storageId, plain.conversationId),
				submissionId: plain.submissionId,
				requestId: plain.requestId,
			}
		: row.groupDecision?.result;
	if (!target || (!plain && states.some((state) => state.receipt.submissionId === target.submissionId)))
		return undefined;
	return {
		tool: "agent_inspect",
		view: "result",
		...target,
		offset: displayOffset ?? (receipt.answerTruncated === true ? (receipt.answer?.length ?? 0) : 0),
	} as const;
}

function receiptContinuationDetails(
	metadata: HostMetadata,
	row: ReceiptRow,
	states: readonly ReceiptState[],
	displayOffset?: number,
) {
	const continuation = receiptContinuation(metadata, row, states, displayOffset);
	return continuation === undefined ? {} : { continuation };
}

function receiptContinuationText(metadata: HostMetadata, row: ReceiptRow, states: readonly ReceiptState[]): string {
	const continuation = receiptContinuation(metadata, row, states);
	if (continuation === undefined) return row.receipt.answerTruncated === true ? "\n\n[State note excerpt]" : "";
	return `\n\n${continuation.offset === 0 ? "Read retained answer" : "Answer continues"}: ${JSON.stringify(continuation)}`;
}

/** Entries read for the attempts of one failed run; more entries since its last task started give no evidence. */
const ATTEMPT_SCAN_ENTRIES = 64;

/**
 * True when the stored run of an unanswered input shows that a provider error ended it at the first attempt. The
 * newest failed run of the conversation has to be the run of this input, and the task that ended it has to have
 * left exactly one failed attempt. A conversation whose later run replaced that record gives no evidence, and
 * neither does a task with more entries since its start than this read visits.
 */
async function failedAtFirstAttempt(
	harness: Harness,
	conversationId: ConversationId,
	submissionId: number,
): Promise<boolean> {
	const failure = (await harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT))?.runFailure;
	if (failure?.reason !== "model_error" || !failure.inputs.some((id) => id === submissionId)) return false;
	const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
	if (conversation === undefined) return false;
	// Identities come from one sequence, so every entry of the task is newer than the task itself.
	const page = await conversation.entries(
		{ minEntryId: failure.taskId as number as EntryId, order: "descending" },
		ATTEMPT_SCAN_ENTRIES,
		undefined,
		BACKGROUND_CONTEXT,
	);
	if (page.next !== undefined) return false;
	const attempts = page.items.filter((entry) => {
		const message = entry.byTaskId === failure.taskId ? entry.model?.at(-1) : undefined;
		return message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
	});
	return attempts.length === 1;
}

/** Catalog follow-up text; the peer body is bounded. */
/** A check-in stays current while its input is unsettled, or settled with declared open work that owes a final report. */
async function checkInCurrent(tx: Tx, conversationId: ConversationId, requestId: string): Promise<boolean> {
	const submission = await tx.submissionByRequest(conversationId, requestId);
	if (submission?.status !== "done" && submission?.status !== "unanswered") return true;
	return requestHasOpenWork(tx, conversationId, requestId);
}

function receiptDisplayBody(row: ReceiptRow): string {
	const { receipt } = row;
	if (receipt.status === "done") return inlineAnswer(receipt) ?? "";
	return [row.displayReason ?? receipt.reason, receipt.providerBlock && providerBlockText(receipt.providerBlock)]
		.filter(Boolean)
		.join("\n\n");
}

function receiptFailureText(receipt: DeliveryReceipt, displayReason = receipt.reason): string {
	return `No answer: ${displayReason ?? "the submission settled unanswered"}${receipt.providerBlock === undefined ? "" : `\n${providerBlockText(receipt.providerBlock)}`}`;
}
/** Only the outcome of a request closes it in the requester's continuity record. */
function arrivedReferences(marks: readonly DependencyMark[]): { deliveredResults?: ResultReference[] } {
	const deliveredResults = marks.flatMap(({ state, ...reference }) => (state === "arrived" ? [reference] : []));
	return deliveredResults.length === 0 ? {} : { deliveredResults };
}
function receiptUnusable(receipt: DeliveryReceipt): boolean {
	return receipt.status !== "done" || (receipt.answer ?? "").trim() === "";
}

/** Requests of one answer group that the delivery text names one by one. */
const RECEIPT_STATE_LINES = 16;
/**
 * One request of an answer group with its declared work, read from the producer's committed facts. For an input that
 * ended without an answer and without declared work, `delegated` counts the producer's own requests that have no
 * delivered result yet: their results return to the producer, and nothing routes its later work to this recipient.
 */
type ReceiptState = { readonly receipt: DeliveryReceipt; readonly work?: RequestWork; readonly delegated?: number };

/** Classify every receipt for the wake decision, even when its explanation does not fit in the notice. */
export async function readReceiptStates(
	row: ReceiptRow,
	readWork: (receipt: DeliveryReceipt) => Promise<RequestWork | undefined>,
	openDelegations: (id: ConversationId) => Promise<number>,
) {
	const states: ReceiptState[] = [];
	for (const receipt of row.receipts) {
		const work = await readWork(receipt);
		const delegated =
			states.length < RECEIPT_STATE_LINES && !work && receipt.status !== "done"
				? await openDelegations(receipt.conversationId)
				: 0;
		states.push({ receipt, ...(work ? { work } : {}), ...(delegated ? { delegated } : {}) });
	}
	return states;
}

function inspectCallText(call: FinalReportRead): string {
	const { tool: _tool, ...args } = call;
	return `agent_inspect(${JSON.stringify(args)})`;
}

/**
 * The state of one request in host words: native input completed with its result, work still open with a
 * state note, or work closed with a separate final report. An input without an answer keeps that outcome;
 * when its work closed before the run ended, the line also names the retained final report. Producer
 * prose never decides it.
 */
export function receiptStateLine(state: ReceiptState): string {
	const { receipt, work } = state;
	const request = `Request ${receipt.requestId} (submission ${receipt.submissionId})`;
	if (receipt.status !== "done") {
		const outcome = `${request}: native input ${receiptOutcome(receipt)} without an answer`;
		if (work === undefined && (state.delegated ?? 0) > 0)
			return `${outcome}; no result arrived. Its conversation still waits for ${state.delegated} request(s) that it delegated: their results return to it, and none of its later work reports to you. Send it a follow-up to finish the work and report.`;
		if (work?.work === "open")
			return `${outcome}; the host recovered its delegated work. The integrator owes you a separate final report.`;
		if (work?.work !== "closed") return `${outcome}; no result arrived.`;
		const { finalReport } = work;
		return `${outcome}; declared work completed${finalReport.status === undefined ? "" : ` (${finalReport.status})`} with final report ${finalReport.requestId}. The final report is the result of this request. Read the final report: ${inspectCallText(finalReport.read)}`;
	}
	if (work === undefined)
		return `${request}: native input completed; no declared work. This answer is its result: dependency arrived.`;
	if (work.work === "open")
		return `${request}: native input completed; declared work remains open. This answer is a state note, not the final result; the final report arrives as a separate report.`;
	const { finalReport } = work;
	return `${request}: native input completed; declared work completed${finalReport.status === undefined ? "" : ` (${finalReport.status})`} with final report ${finalReport.requestId}. This answer is a state note, not the final result. Read the final report: ${inspectCallText(finalReport.read)}`;
}

/** Work facts of observation details. The label marks an answer as a state note; a receipt without an answer has none. */
function receiptWorkDetails(
	receipt: DeliveryReceipt,
	work: RequestWork | undefined,
): { work?: RequestWork["work"]; workLabel?: string } {
	if (work === undefined) return {};
	return receipt.status === "done" ? { work: work.work, workLabel: work.label } : { work: work.work };
}

function receiptStateText(states: readonly ReceiptState[]): string {
	const lines = states.slice(0, RECEIPT_STATE_LINES).map(receiptStateLine);
	if (states.length > RECEIPT_STATE_LINES)
		lines.push(
			`${states.length - RECEIPT_STATE_LINES} more requests share this answer; read the state of each with agent_inspect view: result.`,
		);
	return lines.join("\n");
}

function receiptFollowText(
	metadata: HostMetadata,
	row: ReceiptRow,
	continuity: readonly string[],
	states: readonly ReceiptState[],
): string {
	const receipt = row.receipt;
	const result =
		receipt.status === "done"
			? (inlineAnswer(receipt) ?? "No assistant text.")
			: receiptFailureText(receipt, row.displayReason);
	return `Agent result from ${metadata.storageId}:${receipt.conversationId} (${submissionLabel(row)}).\n${receiptStateText(states)}\nResults do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.\n\n${boundedPeerText(result).text}${receiptContinuationText(metadata, row, states)}${receiptGroupContinuationText(row, metadata.storageId)}${continuity.length === 0 ? "" : `\n\n${continuity.join("\n")}`}`;
}

/** The request and close status of a final report; a cut body names the exact call that continues it. */
function finalReportLead(facts: FinalReportDeliveryFacts): string {
	return `Work completed with a final report${facts.status === undefined ? "" : ` (${facts.status})`} for request ${facts.requestId} (report ${facts.reportRequestId}). This report is the result of that request: dependency arrived.`;
}
function reportBody(
	report: DeliveryReport,
	facts: FinalReportDeliveryFacts | undefined,
): { text: string; truncated: boolean } {
	const body = boundedReportText(report);
	if (facts === undefined || !body.truncated) return body;
	const kept = body.text.length - PEER_TRUNCATION_MARKER.length;
	return {
		text: `${body.text.slice(0, kept)}\n\n[text truncated] Final report continues: ${inspectCallText({ ...facts.read, offset: kept })}`,
		truncated: true,
	};
}

function reportDisplayBody(report: DeliveryReport, finalReport: FinalReportDeliveryFacts | undefined) {
	const authored = report.operatorMessage ?? (report.threadId === undefined ? report.message : "");
	const operatorMessage =
		report.threadId === undefined ? peerTextPrefix(authored) : threadExcerpt(authored, PEER_TEXT_LIMIT).text;
	return {
		operatorMessage,
		operatorTextTruncated: operatorMessage !== authored,
		...(finalReport === undefined
			? {}
			: {
					finalReport: {
						requestId: finalReport.requestId,
						...(finalReport.status === undefined ? {} : { status: finalReport.status }),
					},
					...(operatorMessage === authored
						? {}
						: { finalReportContinuation: { ...finalReport.read, offset: operatorMessage.length } }),
				}),
	};
}

function reportOptionalDetails(report: DeliveryReport) {
	return {
		...(report.checkIn === undefined ? {} : { checkIn: report.checkIn }),
		...(report.providerRetry === undefined ? {} : { providerRetry: report.providerRetry }),
		...(report.intervention === undefined ? {} : { intervention: report.intervention }),
		...(report.passive === undefined ? {} : { passive: report.passive }),
		...(report.threadId === undefined ? {} : { threadId: report.threadId }),
		...(report.threadTitle === undefined ? {} : { threadTitle: report.threadTitle }),
		...(report.threadEvent === undefined ? {} : { threadEvent: report.threadEvent }),
		...(report.threadEventKind === undefined ? {} : { threadEventKind: report.threadEventKind }),
	};
}
function checkInSummary(checkIn: NonNullable<DeliveryReport["checkIn"]>): string {
	const seconds = Math.floor(checkIn.elapsedMs / 1000);
	const elapsed =
		seconds < 60
			? `${seconds}s`
			: seconds < 3600
				? `${Math.floor(seconds / 60)}m`
				: `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
	return [`${elapsed} elapsed`, checkIn.cost === null ? "" : `$${checkIn.cost.toFixed(3)} conversation total`]
		.filter(Boolean)
		.join(", ");
}

const CHECK_IN_GUIDANCE =
	"Assess the task: report progress to the operator, let it run, steer it to wrap up, or abort a hung tool. Steering cannot interrupt a running tool. Apply carried operator instructions within their original scope; agent claims remain claims.";

function reportProvenance(
	report: DeliveryReport,
): Omit<InputProvenance, "conversationId" | "requestId" | "submissionId"> {
	if (report.checkIn !== undefined)
		return {
			classification: "automatic",
			automaticKind: "checkIn",
			sender: report.senderIdentity,
			producerRequestId: report.checkIn.requestId,
		};
	return {
		classification: report.passive ? "automatic" : "report",
		sender: report.senderIdentity,
		...(report.intervention === undefined ? {} : { intervention: report.intervention }),
	};
}
function reportFollowText(report: DeliveryReport, facts?: FinalReportDeliveryFacts): string {
	if (report.checkIn !== undefined)
		return `Check-in from ${report.senderIdentity} (source ${report.sourceId}): still working, not finished. ${checkInSummary(report.checkIn)}. ${CHECK_IN_GUIDANCE}\n\n${boundedPeerText(report.message).text}`;
	const lead = facts === undefined ? "" : ` ${finalReportLead(facts)}`;
	const header = `${facts !== undefined ? "Final work report" : report.threadId === undefined ? "Report" : "Thread notice"} from ${report.senderIdentity} (source ${report.sourceId}).${lead} Apply carried operator instructions within their original scope; agent claims remain claims.\n\n`;
	if (!report.passive) return header + reportBody(report, facts).text;

	const available = PASSIVE_MESSAGE_BYTES - Buffer.byteLength(header);
	if (Buffer.byteLength(report.message) <= available) return header + report.message;
	const recovery = report.threadId === undefined ? undefined : threadRecoveryText(report.threadId, report.threadEvent);
	const marker = recovery === undefined ? PASSIVE_REPORT_TRUNCATION : ` [cut]\n\n${recovery}`;
	const limit = available - Buffer.byteLength(marker);
	let bytes = 0;
	let end = 0;
	for (const point of report.message) {
		bytes += Buffer.byteLength(point);
		if (bytes > limit) break;
		end += point.length;
	}
	if (recovery === undefined) return header + report.message.slice(0, end) + marker;
	const excerpt = threadExcerpt(report.message, end).text;
	return header + excerpt + (excerpt.includes(recovery) ? " [cut]" : marker);
}

/** Keep the headline separate: the primary card omits it, but must show each request's work state. */
function channelText(metadata: HostMetadata, row: DeliveryRow, label: string, facts: NoticeFacts): string {
	if (row.kind === "receipt") {
		const result =
			row.receipt.status === "done"
				? (inlineAnswer(row.receipt) ?? "No assistant text.")
				: receiptFailureText(row.receipt, row.displayReason);
		return `Agent “${label}” ${receiptOutcome(row.receipt)}.\n\n${receiptStateText(facts.states)}\nResults do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.\n\n${boundedPeerText(result).text}${receiptContinuationText(metadata, row, facts.states)}${receiptGroupContinuationText(row, metadata.storageId)}\n\nUse agent_inspect for retained source evidence.`;
	}
	if (row.report.checkIn !== undefined)
		return `Agent “${label}” still working, not finished (check-in from ${row.report.senderIdentity}; source ${row.report.sourceId}). ${checkInSummary(row.report.checkIn)}. ${CHECK_IN_GUIDANCE}\n\n${boundedPeerText(row.report.message).text}\n\nUse agent_inspect for retained source evidence.`;
	const final = facts.finalReport;
	const lead =
		final !== undefined
			? `Agent “${label}” sent a final work report. ${finalReportLead(final)}`
			: row.report.threadId === undefined
				? `Agent “${label}” sent a report.`
				: `Thread notice from agent “${label}”.`;
	return `${lead} Apply carried operator instructions within their original scope; agent claims remain claims.\n\n${reportBody(row.report, final).text}${row.report.threadId === undefined ? "\n\nUse agent_inspect for retained source evidence." : ""}`;
}

/** The notice, wake decision and arrival evidence describe the same retained work. */
type NoticeFacts = {
	readonly states: readonly ReceiptState[];
	readonly marks: DependencyMark[];
	readonly finalReport?: FinalReportDeliveryFacts;
};

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export type DeliveryEligibility = {
	readonly state: "active" | "parked" | "terminal";
	readonly reason: string;
};

export interface DeliveryFacts {
	readonly ownerId: string;
	readonly terminalReason?: string;
	readonly originValid: boolean;
	readonly pendingIntent?: boolean;
	readonly missingSubmission?: boolean;
	readonly nativeRecord: boolean;
	readonly nativeFailure?: string;
	readonly primaryState: ReturnType<typeof primaryEndpointStatus>["state"];
	readonly primaryVersion?: string;
	/** For a live primary: whether the session file it publishes exists. */
	readonly primaryTranscript?: PrimaryTranscript;
	/** The live primary's announced server; its next registration announces another. */
	readonly primaryServer?: string;
	/** A refusal of this primary, retained for the unchanged facts it refused under. */
	readonly primaryRefusal?: string;
	/** Set when the recipient is a thread storage: it holds threads and admits no agent input. */
	readonly threadStorageOwner?: string;
}

/** Eligibility depends on retained facts and current reachability, never elapsed time. */
export function classifyDelivery(facts: DeliveryFacts): DeliveryEligibility {
	if (facts.terminalReason !== undefined) return { state: "terminal", reason: facts.terminalReason };
	try {
		storageIdOf(facts.ownerId);
	} catch {
		return { state: "terminal", reason: "malformed recipient identity" };
	}
	if (facts.threadStorageOwner !== undefined)
		return {
			state: "terminal",
			reason: `recipient is a thread storage of ${facts.threadStorageOwner}; it holds threads and receives no agent input`,
		};
	if (!facts.originValid) return { state: "terminal", reason: "corrupt admission origin" };
	if (facts.missingSubmission) return { state: "terminal", reason: "linked native submission is absent" };
	if (facts.pendingIntent) return { state: "active", reason: "native admission or submission is pending" };
	if (facts.nativeFailure !== undefined) return { state: "parked", reason: facts.nativeFailure };
	if (facts.nativeRecord) return { state: "active", reason: "native recipient is available" };
	if (!PRIMARY_ID.test(facts.ownerId)) return { state: "parked", reason: "native recipient has no catalog record" };
	return classifyPrimary(facts);
}

/** An ordinary owner takes the row only in its own saved session; no state selects another recipient. */
function classifyPrimary(facts: DeliveryFacts): DeliveryEligibility {
	const owner = facts.ownerId;
	if (facts.primaryState === "incompatible")
		return {
			state: "parked",
			reason: primaryEndpointIncompatibleError(owner, facts.primaryVersion ?? "unadvertised").message,
		};
	if (facts.primaryState !== "live")
		return {
			state: "parked",
			reason: `primary session ${owner} has ${facts.primaryState === "unknown" ? "an unverified endpoint" : facts.primaryState === "dead" ? "an endpoint whose process ended" : "no live endpoint"}; the row waits at its source for that session and reaches no other session`,
		};
	if (facts.primaryTranscript === "none")
		return {
			state: "parked",
			reason: `primary session ${owner} keeps no transcript; the row waits at its source and reaches no other session`,
		};
	if (facts.primaryTranscript === "unsaved")
		return {
			state: "parked",
			reason: `primary session ${owner} has no saved transcript yet; the row waits at its source until that session saves its first message`,
		};
	if (facts.primaryRefusal !== undefined) return { state: "parked", reason: facts.primaryRefusal };
	return { state: "active", reason: "primary recipient is live with a compatible delivery contract" };
}

type EligibilityRow = {
	readonly key: string;
	readonly kind: "intent" | "receipt" | "report";
	readonly row: DeliveryIntent | DeliveryReceipt | DeliveryReport;
	readonly eligibility: DeliveryEligibility;
	readonly recipientRevision: string;
};

interface EligibilityOptions {
	readonly catalog: AgentCatalog;
	readonly sessionsRoot: string;
	readonly storageId?: string;
	readonly readTarget?: DurableDeliveryOptions["readTarget"];
	readonly unavailableTargets?: ReadonlyMap<string, NativeTargetFailure>;
	readonly packageDir?: string;
	/** Refusals of primary owners that hold for all their rows, each with the facts the refused attempt used. */
	readonly primaryRefusals?: ReadonlyMap<string, PrimaryRefusalRecord>;
	/** Refusals of one row's content, by report or by answer and owner, each with the facts the refused attempt used. */
	readonly rowRefusals?: ReadonlyMap<string, PrimaryRefusalRecord>;
	readonly activeOnly?: boolean;
	/** The owner of the observing storage when that storage is itself a thread storage. */
	readonly threadStorageOwner?: string;
}

/** A primary's refusal; it holds while the owner's facts equal `facts`, the facts of the refused attempt. */
export interface PrimaryRefusalRecord {
	readonly reason: string;
	readonly facts: string;
}

type PrimaryFacts = Pick<DeliveryFacts, "primaryState" | "primaryVersion" | "primaryTranscript" | "primaryServer">;

/** One comparable form of an owner's primary facts, from any object that carries them. */
function primaryFactsKey(facts: PrimaryFacts): string {
	return JSON.stringify({
		primaryState: facts.primaryState,
		...(facts.primaryVersion === undefined ? {} : { primaryVersion: facts.primaryVersion }),
		...(facts.primaryTranscript === undefined ? {} : { primaryTranscript: facts.primaryTranscript }),
		...(facts.primaryServer === undefined ? {} : { primaryServer: facts.primaryServer }),
	});
}

function primaryFacts(sessionsRoot: string, ownerId: string): PrimaryFacts {
	if (!PRIMARY_ID.test(ownerId)) return { primaryState: "absent" };
	const status = primaryRecipientStatus(sessionsRoot, ownerId);
	return {
		primaryState: status.state,
		...(status.version === undefined ? {} : { primaryVersion: status.version }),
		...(status.transcript === undefined ? {} : { primaryTranscript: status.transcript }),
		...(status.serverId === undefined ? {} : { primaryServer: status.serverId }),
	};
}

/** Namespace lookup failure is unavailability, not permission to assume a live route. */
function recipientFacts(
	ownerId: string,
	options: EligibilityOptions,
): Pick<
	DeliveryFacts,
	| "nativeRecord"
	| "nativeFailure"
	| "primaryState"
	| "primaryVersion"
	| "primaryTranscript"
	| "primaryServer"
	| "primaryRefusal"
	| "threadStorageOwner"
> {
	if (options.storageId !== undefined && ownerStorageId(ownerId) === options.storageId)
		return {
			nativeRecord: true,
			primaryState: "absent",
			...(options.threadStorageOwner === undefined ? {} : { threadStorageOwner: options.threadStorageOwner }),
		};
	let record: CatalogRecord | undefined;
	try {
		record = options.readTarget ? options.readTarget(ownerId) : options.catalog.read(ownerId);
	} catch (error) {
		if (options.readTarget !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT")
			return { nativeRecord: false, primaryState: "unknown", nativeFailure: asError(error).message };
	}
	const primary = primaryFacts(options.sessionsRoot, ownerId);
	const refusal = options.primaryRefusals?.get(ownerId);
	const failed = options.unavailableTargets?.get(ownerStorageId(ownerId));
	const nativeFailure =
		record && failed?.availability === nativeRecipientAvailability(record, options.packageDir)
			? failed.reason
			: undefined;
	return {
		nativeRecord: record !== undefined,
		...primary,
		...(refusal !== undefined && refusal.facts === primaryFactsKey(primary) ? { primaryRefusal: refusal.reason } : {}),
		nativeFailure,
		...(record !== undefined && isThreadStorage(record, options.catalog.root)
			? { threadStorageOwner: record.ownerId }
			: {}),
	};
}

/** One observation supplies routing, status, recovery and the retirement seal. */
export async function observeDeliveryEligibility(
	harness: Harness,
	options: EligibilityOptions,
	current?: AgentDeliveryState,
): Promise<readonly EligibilityRow[]> {
	const state = current ?? (await deliveryState(harness, BACKGROUND_CONTEXT, false, !options.activeOnly));
	if (state === undefined) return [];
	const missing = await harness.commit(async (tx) => {
		const ids = new Set<string>();
		for (const intent of state.intents) {
			if (intent.submissionId === null || state.receipts[String(intent.submissionId)] !== undefined) continue;
			const record = await tx.submissionByRequest(intent.conversationId, intent.requestId);
			if (record?.id !== intent.submissionId) ids.add(`${intent.conversationId}:${intent.requestId}`);
		}
		return ids;
	}, BACKGROUND_CONTEXT);
	const result: EligibilityRow[] = [];
	const add = (
		kind: EligibilityRow["kind"],
		key: string,
		row: EligibilityRow["row"],
		originValid: boolean,
		intent?: DeliveryIntent,
	) => {
		const terminalReason = row.delivery?.state === "terminal" ? row.delivery.reason : undefined;
		const recipient = recipientFacts(row.ownerId, options);
		const refused = options.rowRefusals?.get(kind === "receipt" ? receiptRefusalKey(row as DeliveryReceipt) : key);
		const eligibility = classifyDelivery({
			ownerId: row.ownerId,
			originValid,
			terminalReason,
			...recipient,
			...(recipient.primaryRefusal === undefined &&
			refused !== undefined &&
			refused.facts === primaryFactsKey(recipient)
				? { primaryRefusal: refused.reason }
				: {}),
			...(intent === undefined
				? {}
				: { pendingIntent: true, missingSubmission: missing.has(`${intent.conversationId}:${intent.requestId}`) }),
		});
		result.push({ key, kind, row, eligibility, recipientRevision: JSON.stringify(recipient) });
	};
	for (const intent of state.intents) {
		if (intent.submissionId !== null && state.receipts[String(intent.submissionId)] !== undefined) continue;
		add(
			"intent",
			`intent:${intent.conversationId}:${intent.requestId}`,
			intent,
			intent.origin === "model" || intent.origin === "operator",
			intent,
		);
	}
	for (const receipt of Object.values(state.receipts))
		if (!receipt.acknowledged)
			add(
				"receipt",
				`receipt:${receipt.submissionId}`,
				receipt,
				receipt.origin === "model" || receipt.origin === "operator",
			);
	for (const report of state.reports)
		if (!report.acknowledged)
			add(
				"report",
				`report:${report.sourceId}:${report.ownerId}`,
				report,
				report.checkIn === undefined || report.checkIn.origin === "model" || report.checkIn.origin === "operator",
			);
	return result;
}

function withDisposition<T extends { readonly delivery?: DeliveryDisposition }>(
	row: T,
	disposition: DeliveryDisposition | undefined,
): T {
	const { delivery: _prior, ...rest } = row;
	return { ...rest, ...(disposition === undefined ? {} : { delivery: disposition }) } as T;
}

async function retainRowEligibility(tx: Tx, item: EligibilityRow): Promise<void> {
	const disposition: DeliveryDisposition | undefined =
		item.eligibility.state === "active"
			? undefined
			: { state: item.eligibility.state, reason: item.eligibility.reason };
	if (item.kind === "receipt") {
		const key = String((item.row as DeliveryReceipt).submissionId);
		const receipt = await retainedReceipt(tx, Number(key));
		if (receipt && !receipt.acknowledged) await storeDeliveryRow(tx, "receipt", withDisposition(receipt, disposition));
		return;
	}
	if (item.kind === "intent") {
		const intent = item.row as DeliveryIntent;
		const current = await retainedIntent(tx, intent.conversationId, intent.requestId);
		if (current) await storeDeliveryRow(tx, "intent", withDisposition(current, disposition));
		return;
	}
	const report = item.row as DeliveryReport;
	const current = await retainedReport(tx, report.ownerId, report.sourceId);
	if (current && !current.acknowledged) await storeDeliveryRow(tx, "report", withDisposition(current, disposition));
}

/** Diagnostics are retained beside each row; terminal decisions survive reopen. */
async function retainEligibility(harness: Harness, rows: readonly EligibilityRow[]): Promise<void> {
	await harness.commit(async (tx) => {
		for (const item of rows) await retainRowEligibility(tx, item);
	}, BACKGROUND_CONTEXT);
}

export function deliveryEligibilityError(rows: readonly EligibilityRow[]): Error | undefined {
	const row =
		rows.find((item) => item.eligibility.state === "terminal") ??
		rows.find((item) => item.eligibility.state === "parked");
	return row === undefined
		? undefined
		: new Error(`Delivery ${row.key} to ${row.row.ownerId}: ${row.eligibility.state}: ${row.eligibility.reason}`);
}

function transientTargetFailure(error: unknown): boolean {
	return (
		error instanceof HostLeaseBusyError ||
		((error instanceof HostError || isChordError(error)) && error.code === "unavailable")
	);
}

/** The source ID of a parked check-in notice. */
function newlyParkedCheckIn(item: EligibilityRow): string[] {
	if (item.kind !== "report" || item.eligibility.state !== "parked") return [];
	const report = item.row as DeliveryReport;
	return report.checkIn === undefined ? [] : [report.sourceId];
}

/** Sleeping check-in deadline tasks that wait on the park signal of one of `keys`. */
function parkedCheckInWaits(
	graph: Awaited<ReturnType<typeof readTaskGraph>>,
	keys: ReadonlySet<string>,
): { id: TaskId; key: string }[] {
	return Object.values(graph.tasks).flatMap((node) =>
		node.kind === CHECK_IN_DEADLINE_TASK && node.state.status === "sleeping"
			? (node.state.signals ?? [])
					.filter((wait) => wait.signal === CheckInParkedSignal.name && keys.has(wait.key))
					.map((wait) => ({ id: node.id, key: wait.key }))
			: [],
	);
}

/**
 * Start the source-side delivery watcher. The watcher owns its commit
 * subscription, target links, primary-channel connections, and retry timer;
 * `close()` releases all of them.
 */
export function startDurableDelivery(options: DurableDeliveryOptions): DurableDelivery {
	const { host, metadata, catalog, signal, onError } = options;
	const acquire = options.acquire ?? acquireHost;
	const sessionsRoot = resolve(
		options.sessionsRoot ?? process.env.PI_AGENT_SESSIONS_DIR ?? join(metadata.agentDir, "agent-sessions"),
	);
	const retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
	const targets = new Map<string, HostConnection>();
	const failedLinks = new Map<string, HostConnection>();
	let closed = false;
	let running = false;
	let dirty = false;
	let activityPending = false;
	let nextRetryDelayMs = Math.min(retryDelayMs, MAX_RETRY_DELAY_MS);
	let timer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Active routes to owners outside this storage that failed, by source and owner. Any commit of the source
	 * starts a pass, but no commit of this storage changes what such an owner accepts: a live primary that queued
	 * the notice refuses every attempt until it retains the notice at its next boundary. A held route is sent
	 * again only by the pass that the retry timer or an explicit refresh starts, so the count of transmissions
	 * follows the wait of the owner and not the activity of the source.
	 */
	const heldRoutes = new Set<string>();
	const metHolds = new Set<string>();
	/** The next traversal attempts held routes; the first traversal of a watcher attempts every route. */
	let retryDue = true;
	let attemptHeld = false;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;
	let closePromise: Promise<void> | undefined;
	let unsubscribe: (() => void) | undefined;
	const unavailableTargets = options.unavailableTargets ?? new Map<string, NativeTargetFailure>();
	/**
	 * Refusals that park rows without a retry timer until the owner's facts differ from those of the refused attempt
	 * (a saved file, a new registration or another state), or until an explicit refresh: by owner for a refusal about
	 * the session, by row for a refusal of one row's content.
	 */
	const primaryRefusals = new Map<string, PrimaryRefusalRecord>();
	const rowRefusals = new Map<string, PrimaryRefusalRecord>();
	const eligibilityOptions = {
		catalog,
		sessionsRoot,
		storageId: metadata.storageId,
		packageDir: metadata.packageDir,
		readTarget: options.readTarget,
		unavailableTargets,
		primaryRefusals,
		rowRefusals,
		...(isThreadStorage(metadata, catalog.root) ? { threadStorageOwner: metadata.ownerId } : {}),
	};
	let eligibility = new Map<string, DeliveryEligibility>();
	const retryOwners = new Set<string>();
	let routingFailed = false;
	let completed: DeliverySummary = {
		pendingCount: 0,
		active: false,
		complete: false,
		fresh: false,
		blocker: "Delivery observation has not completed",
		parkedRecipients: [],
		parkedRows: {},
		parkedOmitted: 0,
		activeRecipients: [],
		demand: new Map(),
		traversal: 0,
		started: 0,
	};
	let observationFailure: string | undefined;
	let invalidated = true;
	let parked = new Map<string, string>();
	let parkedOmitted = 0;
	let parkedRows: Record<string, number> = {};
	let active = false;
	let activeRecipients = new Set<string>();
	let completedRecipients = new Map<string, string>();
	let demand = new Map<string, boolean>();
	let started = 0;

	function recipientRevision(identity: string): string {
		return JSON.stringify(recipientFacts(identity, eligibilityOptions));
	}
	function recipientsChanged(recipients: ReadonlyMap<string, string>): boolean {
		for (const [identity, revision] of recipients) if (recipientRevision(identity) !== revision) return true;
		return false;
	}
	function observationBlocker(): string | undefined {
		if (observationFailure) return observationFailure;
		if (traversing) return "Delivery observation has unfinished pages";
		if (invalidated) return "Delivery observation requires a fresh pass";
		if (running || inFlight !== undefined) return "Delivery effects are in flight";
		if (timer !== undefined || dirty) return "Delivery observation is scheduled";
		return undefined;
	}
	function summary(validateRecipients = false): DeliverySummary {
		if (validateRecipients && !invalidated && recipientsChanged(completedRecipients)) schedule(0, true);
		const blocker = observationBlocker();
		return {
			...completed,
			active: completed.active || active,
			activeRecipients: [...new Set([...completed.activeRecipients, ...activeRecipients])].slice(
				0,
				DELIVERY_WAKE_RECIPIENT_LIMIT,
			),
			complete: completed.complete && !traversing,
			fresh: completed.complete && blocker === undefined,
			started,
			...(blocker === undefined ? {} : { blocker }),
		};
	}

	/** Report one routing failure. The host keeps the latest failure in its status. */
	const fail = (error: unknown): void => {
		const failure = asError(error);
		routingFailed = true;
		host.reportDeliveryError(failure);
		try {
			onError?.(failure);
		} catch {
			// A reporting failure must not stop delivery.
		}
	};

	/** Reuse one target link per storage; a closed link is replaced on the next pass. */
	const targetConnection = async (record: CatalogRecord): Promise<HostConnection> => {
		const existing = targets.get(record.storageId);
		if (existing && !existing.closed) return existing;
		if (existing) targets.delete(record.storageId);
		let connection: HostConnection;
		try {
			connection = await (options.connectTarget
				? options.connectTarget(record)
				: acquire(hostMetadata(record, metadata.packageDir)));
		} catch (error) {
			if (!transientTargetFailure(error))
				unavailableTargets.set(record.storageId, {
					reason: `native host cannot start: ${asError(error).message}`,
					availability: nativeRecipientAvailability(record, metadata.packageDir),
				});
			throw error;
		}
		unavailableTargets.delete(record.storageId);
		if (closed || signal.aborted) {
			await connection.close().catch(() => undefined);
			throw new Error("durable delivery is closed");
		}
		targets.set(record.storageId, connection);
		return connection;
	};

	/** Catalog lookup: an absent record alone permits primary-channel routing; every other failure refuses. */
	const ownerRecord = (ownerId: string): CatalogRecord | undefined => {
		if (options.readTarget) return options.readTarget(ownerId);
		try {
			return catalog.read(ownerId);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	};

	/** Automatic notices recheck exact source settlement after asynchronous route preparation. */
	/** Snapshot reads of open work: a transaction read would create the document of a conversation that has none. */
	const workReader = { harness: host.harness, context: BACKGROUND_CONTEXT };

	const receiptStates = (row: ReceiptRow) =>
		readReceiptStates(
			row,
			(receipt) =>
				requestWork(workReader, metadata.storageId, receipt.conversationId, {
					requestId: receipt.requestId,
					submissionId: receipt.submissionId,
					ownerId: receipt.ownerId,
				}),
			openDelegations,
		);
	/** The producer's own requests without a delivered result, from its retained admission facts. */
	const openDelegations = async (conversationId: ConversationId): Promise<number> => {
		try {
			const state = await host.harness.snapshot(ContinuityDoc, conversationId, BACKGROUND_CONTEXT);
			return state === undefined
				? 0
				: foldContinuity(state.events).filter((fact) => fact.phase === "requested" || fact.phase === "admitted").length;
		} catch {
			return 0;
		}
	};
	const deliveryFacts = async (row: DeliveryRow): Promise<NoticeFacts> => {
		if (row.kind === "receipt") {
			const states = await receiptStates(row);
			return {
				states,
				marks: states.map(({ receipt, work }) => receiptDependencyMark(metadata.storageId, receipt, work)),
			};
		}
		const { report } = row;
		const marks = report.passive
			? []
			: await host.harness.commit((tx) => reportDependencyMarks(tx, metadata.storageId, report), BACKGROUND_CONTEXT);
		const finalReport = finalReportDeliveryFacts(report, marks);
		return { states: [], marks, ...(finalReport === undefined ? {} : { finalReport }) };
	};
	const nativeEvidence = ({ marks }: NoticeFacts) =>
		marks.length === 0
			? {}
			: {
					dependencyMarks: marks,
					...arrivedReferences(marks),
				};

	const reportCurrent = async (row: DeliveryRow): Promise<boolean> => {
		if (
			row.kind !== "report" ||
			(row.report.checkIn === undefined &&
				row.report.providerRetry === undefined &&
				row.report.recoveryWork === undefined)
		)
			return true;
		const report = row.report;
		return host.harness.commit(async (tx) => {
			const current = await retainedReport(tx, report.ownerId, report.sourceId);
			if (current === undefined || current.acknowledged) return false;
			if (
				(current.recoveryWork &&
					!(await requestHasOpenWork(tx, current.recoveryWork.conversationId, current.recoveryWork.requestId))) ||
				(await providerRetryReportSettled(tx, current))
			) {
				await storeDeliveryRow(tx, "report", { ...current, acknowledged: true });
				return false;
			}
			if (
				current.checkIn === undefined ||
				(await checkInCurrent(tx, current.checkIn.conversationId as ConversationId, current.checkIn.requestId))
			)
				return true;
			await storeDeliveryRow(tx, "report", { ...current, acknowledged: true });
			await resumePausedCheckIn(tx, current.ownerId, current.checkIn, host.currentTime());
			return false;
		}, BACKGROUND_CONTEXT);
	};

	/** A receipt carries the same wake and dependency evidence on local and foreign routes. */
	const receiptSubmission = async (row: ReceiptRow, owner: string) => {
		const requestId = receiptRequestId(metadata, row.receipt);
		const communicationParams = deliveryCommunicationParams(row, host);
		const continuity = await host.childContinuityLines(row.receipt.conversationId, receiptUnusable(row.receipt));
		const facts = await deliveryFacts(row);
		const { states } = facts;
		return {
			sessionId: owner,
			message: receiptFollowText(metadata, row, continuity, states),
			requestId,
			provenance: { classification: "automatic" },
			...communicationParams,
			...nativeEvidence(facts),
			...(onlyStateNotes(row, states) ? { stateNotesOnly: true } : {}),
			whenBusy: "followUp",
		};
	};

	/** Same-storage owners are agent conversations in this storage; their answer arrives as an in-storage follow-up. */
	const deliverSameStorage = async (row: DeliveryRow, owner: string): Promise<void> => {
		if (row.kind === "receipt") {
			const params = await receiptSubmission(row, owner);
			await hostAttempt(() => host.request("submit", params), undefined, signal);
			return;
		}
		if (!(await reportCurrent(row))) return;
		const requestId = reportRequestId(metadata, row.report);
		const communicationParams = deliveryCommunicationParams(row, host);
		const facts = await deliveryFacts(row);
		await hostAttempt(
			() =>
				host.request(row.report.passive ? "passive-submit" : "submit", {
					sessionId: row.report.ownerId,
					message: reportFollowText(row.report, facts.finalReport),
					requestId,
					...communicationParams,
					...nativeEvidence(facts),
					provenance: reportProvenance(row.report),
					...(row.report.providerRetry === undefined ? {} : { providerRetry: row.report.providerRetry }),
					whenBusy: row.report.steer ? "steer" : "followUp",
				}),
			undefined,
			signal,
		);
	};

	const acknowledgeRow = async (row: DeliveryRow, owners: readonly string[]): Promise<void> => {
		if (owners.length === 0) return;
		// Acknowledgement of a check-in notice re-arms its paused watch in the same commit, as the acknowledge request
		// does, so a crash on either side of the commit leaves the same outcome.
		if (row.kind === "report") {
			await acknowledgeReports(
				host.harness,
				row.report.ownerId,
				[row.report.sourceId],
				BACKGROUND_CONTEXT,
				host.currentTime(),
			);
			return;
		}
		await host.harness.commit(async (tx) => {
			for (const receipt of row.receipts) {
				const current = await retainedReceipt(tx, receipt.submissionId);
				if (
					current !== undefined &&
					current.ownerId === receipt.ownerId &&
					owners.includes(current.ownerId) &&
					!current.acknowledged
				)
					await storeDeliveryRow(tx, "receipt", { ...current, acknowledged: true });
			}
		}, BACKGROUND_CONTEXT);
	};

	/** Foreign senders use an exact retained agent row or published primary endpoint, never a new host. */
	const readSourceStatus = async (identity: string): Promise<SourceStatus | undefined> => {
		const retained = retainedSourceStatus(catalog, identity);
		if (ownerStorageId(identity) !== metadata.storageId) return retained ?? primarySourceStatus(sessionsRoot, identity);
		try {
			const response = (await hostAttempt(
				() => host.request("status", { sessionId: identity }),
				undefined,
				signal,
			)) as { conversation?: SourceStatus };
			return response?.conversation === undefined
				? retained
				: {
						...response.conversation,
						senderKind: "agent",
						...(retained?.handle === undefined ? {} : { handle: retained.handle }),
					};
		} catch {
			return retained;
		}
	};

	/** Source metadata from live status or a dated retained row; absent model evidence stays unknown. */
	const actualMetadata = (status: SourceStatus | undefined): { fields: Record<string, string>; unknown: boolean } => {
		if (status === undefined) return { fields: {}, unknown: true };
		const fields: Record<string, string> = {};
		const observed = {
			provider: status.agent?.model?.provider,
			modelId: status.agent?.model?.modelId,
			thinkingLevel: status.agent?.thinkingLevel,
			name: status.name,
			sourceOwner: status.owner,
			handle: status.handle,
			observedPurpose: status.observedPurpose,
			metadataSource: status.metadataSource,
		};
		for (const [key, value] of Object.entries(observed)) {
			if (typeof value === "string" && value !== "") fields[key] = value;
		}
		if (status.retainedAt !== undefined) {
			fields.metadataSource = "retained-catalog";
			fields.metadataObservedAt = status.retainedAt;
		}
		return { fields, unknown: fields.provider === undefined || fields.modelId === undefined };
	};

	/** Fields shared by receipt and report delivery details; the owner is the only recipient. */
	const sharedRowDetails = (
		row: DeliveryRow,
		identity: string,
		owner: string,
		status: SourceStatus | undefined,
		body: { text: string; truncated: boolean },
		states: readonly ReceiptState[],
	): Record<string, unknown> => {
		const actual = actualMetadata(status);
		const sourceId = rowSourceId(metadata, row);
		const saved = rowIsSaved(row);
		const senderKind = row.kind === "receipt" ? "agent" : status?.senderKind;
		return {
			kind: row.kind,
			...(senderKind === undefined ? {} : { senderKind }),
			storageId: metadata.storageId,
			sourceId,
			source: sourceId,
			identity,
			label: displayName(status, identity),
			originalOwnerId: owner,
			deliveryRecipient: owner,
			liveOwner: true,
			saved,
			wake: rowWakes(row, owner, states),
			...(body.truncated ? { textTruncated: true } : {}),
			...actual.fields,
			...(actual.unknown ? { metadataUnknown: true } : {}),
		};
	};

	/** Fields of the displayed receipt and the exact related submissions on this delivery. */
	const receiptFields = (row: ReceiptRow, states: readonly ReceiptState[]) => {
		const receipt = row.receipt;
		const workBySubmission = new Map(states.map(({ receipt, work }) => [receipt.submissionId, work]));
		const work = workBySubmission.get(receipt.submissionId);
		return {
			...receiptWorkDetails(receipt, work),
			submissions: row.receipts.map((member) => ({
				submissionId: member.submissionId,
				requestId: member.requestId,
				operationId: member.operationId,
				entryId: member.entryId,
				ownerId: member.ownerId,
				origin: receiptOrigin(member),
				status: member.status,
				...receiptWorkDetails(member, workBySubmission.get(member.submissionId)),
			})),
			conversationId: receipt.conversationId,
			status: receipt.status,
			answerEntryId: receipt.answerEntryId,
			...(receipt.answerTruncated ? { textTruncated: true } : {}),
			...receiptGroupContinuation(row, metadata.storageId),
			...(work?.work === "closed" ? { readFinalReport: work.finalReport.read } : {}),
			receiptAssociation: receiptAssociation(metadata, row),
			reason: row.displayReason ?? receipt.reason,
			...(receipt.providerBlock === undefined ? {} : { providerBlock: receipt.providerBlock }),
			acknowledged: row.receipts.every((member) => member.acknowledged),
		};
	};

	/** Observation details: actual source metadata, owner flags, origin, wake intent, and retained row ids. */
	const rowDetails = (
		row: DeliveryRow,
		identity: string,
		owner: string,
		status: SourceStatus | undefined,
		{ states, marks, finalReport }: NoticeFacts,
	): JsonValue => {
		const body =
			row.kind === "receipt" ? boundedPeerText(inlineAnswer(row.receipt) ?? "") : reportBody(row.report, finalReport);
		const shared = sharedRowDetails(row, identity, owner, status, body, states);
		const arrivals = arrivedReferences(marks);
		if (row.kind === "receipt") {
			const { receipt } = row;
			const authored = receiptDisplayBody(row);
			const operatorMessage = peerTextPrefix(authored);
			return {
				...shared,
				...arrivals,
				...receiptFields(row, states),
				...receiptContinuationDetails(
					metadata,
					row,
					states,
					operatorMessage !== authored ? operatorMessage.length : undefined,
				),
				answer: body.text,
				operatorMessage,
				operatorTextTruncated: operatorMessage !== authored || receipt.answerTruncated === true,
			} as unknown as JsonValue;
		}
		const report = row.report;
		return {
			...shared,
			...passiveThreadDetails(row, host, metadata),
			...arrivals,
			reportSourceId: report.sourceId,
			requestId: report.requestId,
			senderIdentity: report.senderIdentity,
			message: body.text,
			...reportDisplayBody(report, finalReport),
			...reportOptionalDetails(report),
			replyTo: report.replyTo,
			acknowledged: report.acknowledged,
			createdAt: report.createdAt,
		} as unknown as JsonValue;
	};

	/** Deliver one row to its owner's registered primary channel; the owner is the only recipient it names. */
	const deliverLiveOwner = async (row: DeliveryRow, identity: string, owner: string): Promise<void> => {
		const status = await readSourceStatus(identity);
		const facts = await deliveryFacts(row);
		const message: PrimaryDelivery = {
			requireRetained: true,
			sourceId: rowSourceId(metadata, row),
			text: channelText(metadata, row, displayName(status, identity), facts),
			details: rowDetails(row, identity, owner, status, facts),
		};
		if (!(await reportCurrent(row))) return;
		// A refusal holds only for the registration that gave it: the facts are read before this attempt and name
		// the server that the connection verified.
		const attempt = primaryFacts(sessionsRoot, owner);
		const connection = await connectPrimaryChannel({ id: owner, sessionsRoot });
		try {
			await connection.deliver(message);
		} catch (error) {
			notePrimaryRefusal(row, owner, error, primaryFactsKey({ ...attempt, primaryServer: connection.serverId }));
			throw error;
		} finally {
			await connection.close().catch(() => undefined);
		}
		row.deliveredTo.add(`primary:${owner}`);
	};

	/** An ordinary owner receives its row in its own live session; every other state leaves the row parked. */
	const deliverPrimary = async (row: DeliveryRow, owner: string): Promise<boolean> => {
		if (row.deliveredTo.has(`primary:${owner}`)) return true;
		if (!PRIMARY_ID.test(owner))
			throw new Error(`delivery owner ${owner} has no catalog record and is not a canonical primary id`);
		await verifyPrimaryOwners(sessionsRoot, [owner]);
		const status = primaryEndpointStatus(sessionsRoot, owner);
		if (status.state === "incompatible")
			throw primaryEndpointIncompatibleError(owner, status.version ?? "unadvertised");
		if (status.state !== "live")
			throw new Error(`primary owner ${owner} is ${status.state}; the row waits for that session`);
		await deliverLiveOwner(row, deliverySender(row, host), owner);
		return true;
	};

	/** Catalog owners: untrusted follow-up into the owner's own host; no ownerId intent. */
	const deliverCatalog = async (record: CatalogRecord, row: DeliveryRow, owner: string): Promise<void> => {
		const connection = await targetConnection(record);
		if (row.kind === "receipt") {
			const params = await receiptSubmission(row, owner);
			await connection.request("submit", params, { requestId: params.requestId, signal });
		} else {
			if (!(await reportCurrent(row))) return;
			const requestId = reportRequestId(metadata, row.report);
			const communicationParams = deliveryCommunicationParams(row, host);
			const facts = await deliveryFacts(row);
			await connection.request(
				row.report.passive ? "passive-submit" : "submit",
				{
					sessionId: row.report.ownerId,
					message: reportFollowText(row.report, facts.finalReport),
					requestId,
					...communicationParams,
					...nativeEvidence(facts),
					provenance: reportProvenance(row.report),
					...(row.report.providerRetry === undefined ? {} : { providerRetry: row.report.providerRetry }),
					whenBusy: row.report.steer ? "steer" : "followUp",
				},
				{ requestId, signal },
			);
		}
	};

	const deliverNative = async (record: CatalogRecord, row: DeliveryRow, owner: string): Promise<void> => {
		try {
			await deliverCatalog(record, row, owner);
			failedLinks.delete(record.storageId);
		} catch (error) {
			const lost = targets.get(record.storageId);
			if (lost?.closed) {
				const previous = failedLinks.get(record.storageId);
				if (previous && previous !== lost)
					unavailableTargets.set(record.storageId, {
						reason: "native host repeatedly disconnected before acknowledgement",
						availability: nativeRecipientAvailability(record, metadata.packageDir),
					});
				failedLinks.set(record.storageId, lost);
			}
			throw error;
		}
	};

	const routeOwner = async (row: DeliveryRow, owner: string): Promise<boolean> => {
		if (!(await reportCurrent(row))) return false;
		if (ownerStorageId(owner) === metadata.storageId) {
			// The producing conversation already retains its outcome; another input would restart it.
			if (
				row.kind === "receipt" &&
				resolveSessionConversationId(metadata.storageId, owner, undefined) === row.receipt.conversationId
			)
				return true;
			// A final work report to its declaring conversation stays readable in its row; an input would start a run of that conversation.
			if (row.kind === "report" && finalReportToItself(metadata.storageId, row.report)) return true;
			await deliverSameStorage(row, owner);
			return true;
		}
		const record = ownerRecord(owner);
		if (record !== undefined) {
			await deliverNative(record, row, owner);
			return true;
		}
		return deliverPrimary(row, owner);
	};

	const ownerEligibility = (row: DeliveryRow, owner: string): DeliveryEligibility => {
		const key =
			row.kind === "report"
				? `report:${row.report.sourceId}:${owner}`
				: `receipt:${row.receipts.find((receipt) => receipt.ownerId === owner)?.submissionId}`;
		return eligibility.get(key) ?? { state: "terminal", reason: "delivery row is absent" };
	};

	/** The refusal identity of one row: a report, or one answer for its owner across every delivery page. */
	const refusalKey = (row: DeliveryRow, owner: string): string =>
		row.kind === "report"
			? `report:${row.report.sourceId}:${owner}`
			: receiptRefusalKey({ ...row.receipt, ownerId: owner });

	/**
	 * A refusal of the row's content (`copy`, `misaddressed`) parks that row only. A refusal about the session
	 * (`no-transcript`, `not-held`) parks all the owner's rows. Each holds while the owner's facts equal those of the
	 * refused attempt, so the owner's next registration, or an explicit refresh, tries again. A refusal for a file
	 * that the owner had not written yet parks only while the file is still absent: a file written since is a reason
	 * to try again.
	 */
	const notePrimaryRefusal = (row: DeliveryRow, owner: string, error: unknown, facts: string): void => {
		const kind = primaryRefusalKind(error);
		if (kind === undefined || kind === "unsaved") return;
		const refusal = { reason: `primary session ${owner} refused the row (${kind}): ${asError(error).message}`, facts };
		if (kind === "no-transcript" || kind === "not-held") primaryRefusals.set(owner, refusal);
		else rowRefusals.set(refusalKey(row, owner), refusal);
	};

	/** True while a refusal of this row's content holds under the owner's current facts. */
	const rowRefused = (row: DeliveryRow, owner: string): boolean => {
		const current = primaryFactsKey(primaryFacts(sessionsRoot, owner));
		return rowRefusals.get(refusalKey(row, owner))?.facts === current;
	};

	/** A failed native acquisition or a primary refusal parks the route; a reachable transport retries. */
	const routeFailure = (row: DeliveryRow, owner: string, error: unknown): Error | undefined => {
		if (rowRefused(row, owner)) return undefined;
		const current = classifyDelivery({
			ownerId: owner,
			originValid: true,
			...recipientFacts(owner, eligibilityOptions),
		});
		if (current.state !== "active") return undefined;
		retryOwners.add(owner);
		return new Error(
			`Delivery ${rowSourceId(metadata, row)} to ${owner}: active: transient transport failure: ${asError(error).message}`,
			{ cause: error },
		);
	};

	/** A commit of this storage can change what an owner inside it accepts, so such a route has no hold. */
	const holdKey = (row: DeliveryRow, owner: string): string | undefined =>
		ownerStorageId(owner) === metadata.storageId ? undefined : `${rowSourceId(metadata, row)}\n${owner}`;

	/** True for a held route in a pass that does not attempt held routes. */
	const waitsForRetry = (key: string | undefined): boolean => {
		if (key === undefined || !heldRoutes.has(key)) return false;
		metHolds.add(key);
		return !attemptHeld;
	};

	const releaseHold = (key: string | undefined): void => {
		if (key !== undefined) heldRoutes.delete(key);
	};

	const holdFailedRoute = (key: string | undefined, failure: Error | undefined): void => {
		if (key === undefined) return;
		if (failure === undefined) {
			heldRoutes.delete(key);
			return;
		}
		heldRoutes.add(key);
		metHolds.add(key);
	};

	const tryRouteOwner = async (row: DeliveryRow, owner: string): Promise<{ accepted: boolean; failure?: Error }> => {
		const state = ownerEligibility(row, owner);
		if (state.state !== "active") return { accepted: false };
		const key = holdKey(row, owner);
		if (waitsForRetry(key)) return { accepted: false };
		try {
			const accepted = await routeOwner(row, owner);
			releaseHold(key);
			return { accepted };
		} catch (error) {
			const failure = routeFailure(row, owner, error);
			holdFailedRoute(key, failure);
			return { accepted: false, failure };
		}
	};

	/** Acknowledge only owners that accepted their normal route, not informational copies. */
	const routeRow = async (row: DeliveryRow, owners: readonly string[]): Promise<void> => {
		let failure: Error | undefined;
		const accepted: string[] = [];
		for (const owner of owners) {
			if (closed || signal.aborted) return;
			const outcome = await tryRouteOwner(row, owner);
			if (outcome.accepted) accepted.push(owner);
			failure ??= outcome.failure;
		}
		if (!closed && !signal.aborted) await acknowledgeRow(row, accepted);
		if (failure !== undefined) throw failure;
	};

	/** Route independent answers and reports even when another route fails; corruption is contained per row. */
	const routed = (owner: string): boolean => {
		if (options.recipients === undefined) return true;
		const recipient = recipientStorage(owner);
		return recipient !== undefined && options.recipients.has(recipient);
	};
	const routeRows = async (rows: readonly DeliveryRow[]): Promise<Error | undefined> => {
		let failure: Error | undefined;
		for (const row of rows) {
			const owners = rowOwners(row).filter(routed);
			if (owners.length === 0) continue;
			try {
				await routeRow(row, owners);
			} catch (error) {
				failure ??= asError(error);
			}
		}
		return failure;
	};

	let pendingCursor: string | null | undefined;
	let automaticCursor: string | null | undefined;
	let traversing = false;
	let traversalFailure: Error | undefined;
	/** A hold whose route a complete traversal did not meet belongs to a row that is no longer pending or active. */
	const forgetUnmetHolds = (): void => {
		for (const key of heldRoutes) if (!metHolds.has(key)) heldRoutes.delete(key);
	};
	const finishTraversal = async (): Promise<void> => {
		if (pendingCursor !== null || automaticCursor !== null) return;
		const pendingCount = await deliveryPendingCount(host.harness, BACKGROUND_CONTEXT);
		if (recipientsChanged(parked)) activityPending = true;
		traversing = false;
		forgetUnmetHolds();
		if (activityPending) dirty = true;
		if (traversalFailure !== undefined) throw traversalFailure;
		if (activityPending) return;
		completed = {
			pendingCount,
			active,
			complete: true,
			fresh: true,
			parkedRecipients: [...parked.keys()],
			parkedRows,
			parkedOmitted,
			activeRecipients: [...activeRecipients],
			demand,
			traversal: started,
			started,
		};
		completedRecipients = parked;
		invalidated = false;
		observationFailure = undefined;
	};
	function rowKey(item: EligibilityRow): string {
		if (item.kind === "receipt") return storedReceiptKey((item.row as DeliveryReceipt).submissionId);
		if (item.kind === "intent") {
			const intent = item.row as DeliveryIntent;
			return intentKey(intent.conversationId, intent.requestId);
		}
		return reportKey(item.row.ownerId, (item.row as DeliveryReport).sourceId);
	}
	function includeSummaryRow(item: EligibilityRow): void {
		const identity = item.row.ownerId;
		includeDemand(item);
		if (item.eligibility.state === "active") {
			active = true;
			if (activeRecipients.size < DELIVERY_WAKE_RECIPIENT_LIMIT) activeRecipients.add(identity);
			return;
		}
		if (item.eligibility.state !== "parked") return;
		if (!parked.has(identity) && parked.size >= DELIVERY_WAKE_RECIPIENT_LIMIT) {
			parkedOmitted++;
			return;
		}
		const revision = parked.get(identity);
		if (revision !== undefined && revision !== item.recipientRevision) activityPending = true;
		else parked.set(identity, item.recipientRevision);
		parkedRows[identity] = (parkedRows[identity] ?? 0) + 1;
	}
	function includeDemand(item: EligibilityRow): void {
		if (item.eligibility.state === "terminal") return;
		const recipient = recipientStorage(item.row.ownerId);
		if (recipient === undefined || recipient === metadata.storageId) return;
		demand.set(recipient, demand.get(recipient) === true || item.kind === "intent");
	}
	const firstReceiptGroup = async (row: ReceiptRow) => {
		// Empty physical pages can precede the first receipt for this recipient. The cursor pins the original tail.
		let cursor: string | undefined;
		for (;;) {
			const { page, members } = await host.harness.commit(
				(tx) =>
					// The page shares its envelope with the answer: a page that leaves no room for the whole inline
					// answer gives up references, which the receipt continuation still reaches, and never answer text.
					receiptReferenceSlice(tx, metadata.storageId, row.receipt, cursor, (candidate, receipts) =>
						communicationFits(withBoundedBody(receiptCommunication(row, metadata.storageId, candidate, receipts))),
					),
				BACKGROUND_CONTEXT,
			);
			if (members.length > 0) return { ...page, members };
			if (page.next === null) throw new Error("Selected receipt is absent from its retained answer group");
			cursor = page.next;
		}
	};
	const prepareReceiptRow = async (row: ReceiptRow): Promise<void> => {
		// The reason is part of the envelope that the reference page is fitted against.
		await prepareDisplayReason(row);
		row.receiptGroup = await firstReceiptGroup(row);
		if (
			!row.receiptGroup.complete ||
			row.receiptGroup.results.some((ref) => !row.receipts.some((member) => member.submissionId === ref.submissionId))
		) {
			row.groupDecision = await groupWakeDecision(
				row.receiptGroup,
				(cursor) =>
					host.harness.commit(
						(tx) => receiptReferencePage(tx, metadata.storageId, row.receipt, cursor),
						BACKGROUND_CONTEXT,
					),
				async (id) => {
					const receipt = await snapshotReceipt(host.harness, id, BACKGROUND_CONTEXT);
					if (!receipt) throw new Error("Answer group references an unavailable receipt");
					const work =
						receipt.status === "done"
							? await requestWork(workReader, metadata.storageId, receipt.conversationId, receipt)
							: undefined;
					return { note: work !== undefined, model: receiptOrigin(receipt) === "model" };
				},
			);
		}
	};
	/**
	 * True when this host does not retry provider errors and the stored run of the input shows one attempt. The
	 * settings of this host say nothing about a run that another host made, so the stored run decides.
	 */
	const endedWithoutRetry = async (conversationId: ConversationId, submissionId: number): Promise<boolean> =>
		options.retriesProviderErrors?.() === false &&
		(await failedAtFirstAttempt(host.harness, conversationId, submissionId));
	const prepareDisplayReason = async (row: ReceiptRow): Promise<void> => {
		if (row.receipt.status !== "unanswered") return;
		const input = await host.harness.submission(row.receipt.submissionId, BACKGROUND_CONTEXT);
		const native = await input?.status(BACKGROUND_CONTEXT);
		if (
			native?.type !== "input" ||
			native.status !== "unanswered" ||
			native.conversationId !== row.receipt.conversationId ||
			native.requestId !== row.receipt.requestId
		)
			return;
		if (eligibilityOptions.threadStorageOwner !== undefined) {
			row.displayReason = `${native.reason}: ${threadStorageUnanswered(metadata.storageId, eligibilityOptions.threadStorageOwner)}`;
			return;
		}
		const retryOff =
			native.reason === "model_error" && (await endedWithoutRetry(native.conversationId, row.receipt.submissionId));
		row.displayReason = modelFailureText(native.reason, native.detail, row.receipt.providerBlock, retryOff);
	};
	const prepareReceiptGroups = async (rows: readonly DeliveryRow[]): Promise<void> => {
		for (const row of rows) if (row.kind === "receipt") await prepareReceiptRow(row);
	};
	/** Notices whose park this watcher already signalled to the deadline task that waits on them. */
	const signalledCheckIns = new Set<string>();
	/**
	 * Wake the deadline task of each newly parked check-in notice, which pauses its watch. The task waits on the
	 * notice's source ID, so the graph names it without a stored task reference; at its deadline it pauses anyway.
	 */
	const signalParkedCheckIns = async (rows: readonly EligibilityRow[]): Promise<void> => {
		// A signal starts the scheduler; a paused deadline task pauses its watch at its deadline instead.
		if (options.recipients !== undefined) return;
		const keys = new Set(rows.flatMap(newlyParkedCheckIn).filter((key) => !signalledCheckIns.has(key)));
		if (keys.size === 0) return;
		try {
			const graph = await readTaskGraph(host.harness, BACKGROUND_CONTEXT);
			for (const { id, key } of parkedCheckInWaits(graph, keys))
				await host.harness.signal(id, CheckInParkedSignal, key, {}, BACKGROUND_CONTEXT);
			for (const key of keys) signalledCheckIns.add(key);
		} catch (error) {
			fail(new Error(`check-in pause signal: ${asError(error).message}`));
		}
	};

	/** One bounded pending page per pass; stable source identities join later recipient chunks. */
	const scan = async (): Promise<void> => {
		if (!traversing) {
			traversing = true;
			activityPending = false;
			pendingCursor = undefined;
			automaticCursor = undefined;
			routingFailed = false;
			metHolds.clear();
			attemptHeld = retryDue;
			retryDue = false;
			retryOwners.clear();
			traversalFailure = undefined;
			parked = new Map();
			parkedOmitted = 0;
			parkedRows = {};
			active = false;
			activeRecipients = new Set();
			demand = new Map();
			started++;
		}
		automaticCursor = await settleDeliveries(
			host.harness,
			BACKGROUND_CONTEXT,
			automaticCursor,
			options.recipients && routed,
		);
		const page =
			pendingCursor === null
				? { state: { intents: [], receipts: {}, reports: [] } as AgentDeliveryState, keys: [], next: null }
				: await pendingDeliveryPage(host.harness, BACKGROUND_CONTEXT, pendingCursor);
		pendingCursor = page.next;
		if (pendingCursor !== null || automaticCursor !== null) dirty = true;
		const state = options.recipients
			? {
					intents: page.state.intents.filter((row) => routed(row.ownerId)),
					receipts: Object.fromEntries(Object.entries(page.state.receipts).filter(([, row]) => routed(row.ownerId))),
					reports: page.state.reports.filter((row) => routed(row.ownerId)),
				}
			: page.state;
		const observed = await observeDeliveryEligibility(host.harness, eligibilityOptions, state);
		eligibility = new Map(observed.map((item) => [item.key, item.eligibility]));
		const rows: DeliveryRow[] = [
			...receiptRows(
				Object.values(state.receipts).filter(
					(receipt) => eligibility.get(`receipt:${receipt.submissionId}`)?.state !== "terminal",
				),
			),
			...state.reports.map((report): DeliveryRow => ({ kind: "report", report, deliveredTo: new Set() })),
		];
		await prepareReceiptGroups(rows);
		const failure = await routeRows(rows);
		const current = await reloadDeliveryRows(host.harness, state, BACKGROUND_CONTEXT);
		const after = await observeDeliveryEligibility(host.harness, eligibilityOptions, current);
		await retainEligibility(host.harness, after);
		await signalParkedCheckIns(after);
		const keys = new Set(page.keys);
		after.filter((item) => keys.has(rowKey(item))).forEach(includeSummaryRow);
		const terminal = await observeDeliveryEligibility(
			host.harness,
			eligibilityOptions,
			await terminalDeliveryState(host.harness, BACKGROUND_CONTEXT),
		);
		const diagnostic = deliveryEligibilityError([...terminal, ...after]);
		if (diagnostic !== undefined) fail(diagnostic);
		if (
			failure !== undefined &&
			after.some((item) => retryOwners.has(item.row.ownerId) && item.eligibility.state === "active")
		)
			traversalFailure ??= failure;
		await finishTraversal();
	};

	/** A held route keeps its reported failure and its backoff until it is accepted or its row ends. */
	const settleTraversal = (): void => {
		if (heldRoutes.size === 0) {
			if (!routingFailed) host.reportDeliveryError(undefined);
			nextRetryDelayMs = Math.min(retryDelayMs, MAX_RETRY_DELAY_MS);
		} else if (retryDue) dirty = true;
		else armRetry();
	};

	const run = async (): Promise<void> => {
		if (closed || signal.aborted) return;
		running = true;
		try {
			await scan();
			if (!traversing) settleTraversal();
		} catch (error) {
			observationFailure = `Delivery observation failed: ${asError(error).message}`;
			invalidated = true;
			fail(error);
			traversing = false;
			pendingCursor = undefined;
			automaticCursor = undefined;
			traversalFailure = undefined;
			armRetry();
		} finally {
			running = false;
			if (dirty) {
				dirty = false;
				schedule(0);
			}
		}
	};

	const startPass = (): void => {
		inFlight = run().finally(() => {
			inFlight = undefined;
			if (!closed) options.onIdle?.();
		});
	};

	/**
	 * One retry time stands until it passes; each new one doubles to the cap. The pass that it starts attempts
	 * the held routes. New activity starts its own pass and leaves this time in place.
	 */
	function armRetry(): void {
		if (retryTimer !== undefined || closed || signal.aborted) return;
		const delay = nextRetryDelayMs;
		nextRetryDelayMs = Math.min(nextRetryDelayMs * 2, MAX_RETRY_DELAY_MS);
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			retryDue = true;
			if (running) {
				dirty = true;
				return;
			}
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			startPass();
		}, delay);
	}

	/** New activity starts a pass at once; commits during a pass coalesce into one follow-up. */
	function schedule(delayMs: number, activity = false): void {
		if (closed || signal.aborted) return;
		if (activity) {
			activityPending = true;
			invalidated = true;
		}
		if (running) {
			dirty = true;
			return;
		}
		if (timer) {
			if (delayMs !== 0) return;
			clearTimeout(timer);
		}
		timer = setTimeout(
			() => {
				timer = undefined;
				startPass();
			},
			Math.max(0, delayMs),
		);
	}

	const sealAdmission = (): void => {
		closed = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = undefined;
		}
	};

	const close = (): Promise<void> => {
		if (closePromise) return closePromise;
		sealAdmission();
		signal.removeEventListener("abort", onAbort);
		unsubscribe?.();
		closePromise = (async () => {
			// Close target links first so an in-flight submit settles before close resolves.
			await Promise.all(
				[...targets.values()].map(async (connection) => {
					await connection.close().catch(() => undefined);
				}),
			);
			targets.clear();
			if (inFlight) await inFlight.catch(() => undefined);
			await options.onClose?.();
		})();
		return closePromise;
	};

	function onAbort(): void {
		void close();
	}

	signal.addEventListener("abort", onAbort, { once: true });
	const observation = host.harness.observeCommits({
		advance: (publication) => {
			if (
				publication.changes.some(
					(change) =>
						change.type === "submission" ||
						change.type === "task" ||
						((change.type === "document" || change.type === "document.copy") &&
							change.record.kind.startsWith("agent.delivery")),
				)
			)
				schedule(0, true);
		},
		end: () => {},
	});
	unsubscribe = () => observation.detach();
	if (!signal.aborted) schedule(0);
	return {
		get busy() {
			return running || inFlight !== undefined;
		},
		summary,
		refresh: () => {
			unavailableTargets.clear();
			failedLinks.clear();
			heldRoutes.clear();
			primaryRefusals.clear();
			rowRefusals.clear();
			schedule(0, true);
		},
		sealAdmission,
		close,
	};
}
