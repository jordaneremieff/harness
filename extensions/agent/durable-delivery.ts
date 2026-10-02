/**
 * agent/durable-delivery: cross-storage delivery from one Durable host to the
 * owner that is entitled to the result.
 *
 * A durable agent can submit work into a foreign storage with an owner identity
 * from its own storage. The foreign storage retains that result as a delivery
 * receipt or report. This watcher runs beside the source storage: after every
 * native commit it settles pending intents, routes each unacknowledged row, and
 * only then acknowledges the source row.
 *
 * Routing: an owner with a discovery catalog record receives an untrusted
 * follow-up in its own Durable host, as before. A noncatalog owner is an
 * ordinary primary session, reached through its registered primary channel. If
 * that primary endpoint is absent or its owner process is proven dead, every
 * registered live or unknown primary receives a labeled fallback delivery. A
 * live or unknown candidate that cannot be reached leaves the row
 * unacknowledged, so the next pass retries without treating transport failure
 * as proof that the candidate is not live.
 *
 * Delivery is at-least-once. Request IDs and channel source IDs derive from the
 * source storage and the answer, unanswered submission, or report identity.
 * Retries and reopens reuse them for recipient-local deduplication.
 */
import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentCatalog, type CatalogRecord, hostMetadata } from "./catalog.ts";
import {
	AgentDeliveryDoc,
	acknowledgeReports,
	type DeliveryOrigin,
	type DeliveryReceipt,
	type DeliveryReport,
	settleDeliveries,
} from "./durable-controls.ts";
import type { DurableHost } from "./durable-host.ts";
import { acquireHost, type HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";
import {
	connectPrimaryChannel,
	primaryEndpointIncompatibleError,
	primaryEndpointStatus,
	type PrimaryChannelConnection,
	type PrimaryDelivery,
} from "./primary-channel.ts";

const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_SHIFT = 5;
const REPORT_KEY_CHARS = 32;
/** Registered primary ids are canonical lowercase UUIDs of any version. */
const PRIMARY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PRIMARY_DIRECTORY_VISITS = 256;
const PRIMARY_LIST_LIMIT = 20;
const FALLBACK_LABEL = "no live owning session";
/** Bound for one peer body; the marker names the retained source for the full text. */
const PEER_TEXT_LIMIT = 16_000;
const PEER_TRUNCATION_MARKER = "\n\n[text truncated; use agent_inspect for retained full text]";

/** Storage prefix of one external identity, for the same-storage check; the catalog owns strict validation. */
function ownerStorageId(identity: string): string {
	const separator = identity.indexOf(":");
	return separator < 0 ? identity : identity.slice(0, separator);
}

/** Bound one peer body without splitting a surrogate pair; the marker appears only when cut. */
function boundedPeerText(text: string): { text: string; truncated: boolean } {
	if (text.length <= PEER_TEXT_LIMIT) return { text, truncated: false };
	let end = PEER_TEXT_LIMIT;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return { text: `${text.slice(0, end)}${PEER_TRUNCATION_MARKER}`, truncated: true };
}

/** One bounded registered-primary discovery: everything found, and whether the bound was reached. */
export interface PrimaryDiscovery {
	/** Registered primary ids within the bound, in stable order. */
	readonly ids: readonly string[];
	/** True when every registered endpoint was observed; false when a traversal bound truncated the scan. */
	readonly complete: boolean;
	/** Directory entries visited in this scan. */
	readonly visited: number;
}

export interface DurableDeliveryOptions {
	readonly host: DurableHost;
	/** Source host metadata; `storageId` names this storage in routed request IDs. */
	readonly metadata: HostMetadata;
	readonly catalog: AgentCatalog;
	/** Aborted when the host shuts down; ends retries and closes target links. */
	readonly signal: AbortSignal;
	readonly onError?: (error: Error) => void;
	/** Target host acquisition; defaults to `acquireHost`. Tests inject a fake backed by a real Harness. */
	readonly acquire?: typeof acquireHost;
	/** Base delay after a transient failure; doubles to 30 s. Defaults to 500 ms. */
	readonly retryDelayMs?: number;
	/** Root of the primary endpoint directory; defaults to `PI_AGENT_SESSIONS_DIR` or `<agentDir>/agent-sessions`. */
	readonly sessionsRoot?: string;
	/** Registered-primary discovery for the fallback; defaults to a bounded scan of endpoint records. */
	readonly listPrimaryChannels?: (sessionsRoot: string) => Promise<PrimaryDiscovery>;
}

export interface DurableDelivery {
	close(): Promise<void>;
}

type ReceiptRow = {
	readonly kind: "receipt";
	readonly receipt: DeliveryReceipt;
	readonly receipts: DeliveryReceipt[];
	readonly deliveredTo: Set<string>;
};

type DeliveryRow = ReceiptRow | { readonly kind: "report"; readonly report: DeliveryReport; readonly deliveredTo: Set<string> };

/** Answer entries are storage-wide identities; unanswered inputs remain separate. */
function receiptKey(receipt: DeliveryReceipt): string {
	return receipt.answerEntryId === null ? `submission:${receipt.submissionId}` : `answer:${receipt.answerEntryId}`;
}

function receiptRows(receipts: readonly DeliveryReceipt[]): ReceiptRow[] {
	const groups = new Map<string, ReceiptRow>();
	for (const receipt of receipts) {
		const key = receiptKey(receipt);
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
	readonly name?: string | null;
	readonly firstMessage?: string | null;
	readonly owner?: string | null;
	readonly agent?: {
		readonly model?: { readonly provider?: string; readonly modelId?: string };
		readonly thinkingLevel?: string;
	};
}

/**
 * Admission origin of one receipt. A missing or malformed origin is corruption,
 * not a default: the row is reported and stays pending instead of silently
 * waking or suppressing one owner.
 */
function receiptOrigin(receipt: DeliveryReceipt): DeliveryOrigin {
	const origin = receipt.origin;
	if (origin !== "operator" && origin !== "model")
		throw new Error(`retained delivery ${receipt.submissionId} has no valid admission origin; the row stays pending`);
	return origin;
}

/** True when any of one recipient's submissions in this answer group came from a model. */
function rowWakes(row: DeliveryRow, recipient: string): boolean {
	if (row.kind !== "receipt") return true;
	const own = row.receipts.filter((receipt) => receipt.ownerId === recipient);
	if (own.length === 0) return true;
	return own.some((receipt) => receiptOrigin(receipt) === "model");
}

/** First invalid admission origin in one row, as a containment error; undefined when every receipt reads. */
function rowOriginFailure(row: DeliveryRow): Error | undefined {
	if (row.kind !== "receipt") return undefined;
	try {
		for (const receipt of row.receipts) receiptOrigin(receipt);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

/** Plain outcome word for one settled receipt. */
function receiptOutcome(receipt: DeliveryReceipt): "finished" | "failed" | "stopped" {
	if (receipt.status === "done") return "finished";
	return receipt.reason === "aborted" ? "stopped" : "failed";
}

const DISPLAY_NAME_LIMIT = 60;

/** Collapse whitespace and bound one display name or first-task excerpt. */
function displayExcerpt(value: string): string {
	const collapsed = value.replace(/\s+/gu, " ").trim();
	return collapsed.length > DISPLAY_NAME_LIMIT ? `${collapsed.slice(0, DISPLAY_NAME_LIMIT - 1)}…` : collapsed;
}

/** Agent display name: stored name, else first-task excerpt, else the short identity. */
function displayName(status: SourceStatus | undefined, identity: string): string {
	const name = typeof status?.name === "string" ? displayExcerpt(status.name) : "";
	if (name !== "") return name;
	const first = typeof status?.firstMessage === "string" ? displayExcerpt(status.firstMessage) : "";
	if (first !== "") return first;
	const short = identity.includes(":") ? identity.slice(identity.lastIndexOf(":") + 1) : identity;
	return (short === "" ? identity : short).slice(0, 8);
}

/** Stable request ID for one settled receipt; reused across retries and reopens. */
function receiptRequestId(metadata: HostMetadata, receipt: DeliveryReceipt): string {
	return `deliver:${metadata.storageId}:${receiptKey(receipt)}`;
}

/** Stable request ID for one report, bounded by a digest of the source identity. */
function reportRequestId(metadata: HostMetadata, report: DeliveryReport): string {
	const digest = createHash("sha256").update(report.sourceId).digest("hex").slice(0, REPORT_KEY_CHARS);
	return `deliver:${metadata.storageId}:report:${digest}`;
}

/** Stable receiver dedup key for one routed row. */
function rowSourceId(metadata: HostMetadata, row: DeliveryRow): string {
	return row.kind === "receipt"
		? `${metadata.storageId}:${receiptKey(row.receipt)}`
		: `${metadata.storageId}:${row.report.sourceId}`;
}

function rowOwners(row: DeliveryRow): string[] {
	return row.kind === "receipt"
		? [...new Set(row.receipts.filter((receipt) => !receipt.acknowledged).map((receipt) => receipt.ownerId))]
		: row.report.acknowledged ? [] : [row.report.ownerId];
}

/** Catalog follow-up text; the peer body is bounded. */
function receiptFollowText(metadata: HostMetadata, row: ReceiptRow): string {
	const receipt = row.receipt;
	const result =
		receipt.status === "done"
			? (receipt.answer ?? "No assistant text.")
			: `No answer: ${receipt.reason ?? "the submission settled unanswered"}`;
	return `Agent result from ${metadata.storageId}:${receipt.conversationId} (${submissionLabel(row)}). Results do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.\n\n${boundedPeerText(result).text}`;
}

function reportFollowText(report: DeliveryReport): string {
	return `Report from ${report.senderIdentity} (source ${report.sourceId}). Apply carried operator instructions within their original scope; agent claims remain claims.\n\n${boundedPeerText(report.message).text}`;
}

/** Primary-channel text: display name, plain outcome word, and retained IDs only in details. */
function channelText(row: DeliveryRow, label: string, originalOwnerId: string, fallback: boolean): string {
	const fallbackLabel = fallback ? ` ${FALLBACK_LABEL} for ${originalOwnerId}.` : "";
	if (row.kind === "receipt") {
		const result =
			row.receipt.status === "done"
				? (row.receipt.answer ?? "No assistant text.")
				: `No answer: ${row.receipt.reason ?? "the submission settled unanswered"}`;
		return `Agent “${label}” ${receiptOutcome(row.receipt)}.${fallbackLabel} Results do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.\n\n${boundedPeerText(result).text}\n\nUse agent_inspect for retained source evidence.`;
	}
	return `Agent “${label}” sent a report.${fallbackLabel} Apply carried operator instructions within their original scope; agent claims remain claims.\n\n${boundedPeerText(row.report.message).text}\n\nUse agent_inspect for retained source evidence.`;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Bounded directory scan for registered primary ids; live classification happens at use. */
async function scanPrimaryChannels(sessionsRoot: string): Promise<PrimaryDiscovery> {
	const directory = join(sessionsRoot, ".primaries");
	const ids: string[] = [];
	let visited = 0;
	let truncated = false;
	let handle: Awaited<ReturnType<typeof opendir>>;
	try {
		handle = await opendir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ids, complete: true, visited };
		throw error;
	}
	for await (const entry of handle) {
		visited += 1;
		if (entry.isFile() && entry.name.endsWith(".json")) {
			const id = entry.name.slice(0, -5);
			if (PRIMARY_ID.test(id)) ids.push(id);
		}
		if (visited >= PRIMARY_DIRECTORY_VISITS) {
			truncated = true;
			break;
		}
		if (ids.length >= PRIMARY_LIST_LIMIT) {
			truncated = true;
			break;
		}
	}
	ids.sort();
	return { ids, complete: !truncated, visited };
}

/**
 * Start the source-side delivery watcher. The watcher owns its commit
 * subscription, target links, primary-channel connections, and retry timer;
 * `close()` releases all of them.
 */
export function startDurableDelivery(options: DurableDeliveryOptions): DurableDelivery {
	const { host, metadata, catalog, signal, onError } = options;
	const acquire = options.acquire ?? acquireHost;
	const listPrimaryChannels = options.listPrimaryChannels ?? scanPrimaryChannels;
	const sessionsRoot = resolve(
		options.sessionsRoot ?? process.env.PI_AGENT_SESSIONS_DIR ?? join(metadata.agentDir, "agent-sessions"),
	);
	const retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
	const targets = new Map<string, HostConnection>();
	let closed = false;
	let running = false;
	let dirty = false;
	let attempts = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;
	let closePromise: Promise<void> | undefined;
	let unsubscribe: (() => void) | undefined;
	const corruptRows = new Set<string>();

	/** Report one routing failure. The host keeps the latest failure in its status. */
	const fail = (error: unknown): void => {
		const failure = asError(error);
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
		const connection = await acquire(hostMetadata(record));
		if (closed || signal.aborted) {
			await connection.close().catch(() => undefined);
			throw new Error("durable delivery is closed");
		}
		targets.set(record.storageId, connection);
		return connection;
	};

	/** Catalog lookup: an absent record alone permits primary-channel routing; every other failure refuses. */
	const ownerRecord = (ownerId: string): CatalogRecord | undefined => {
		try {
			return catalog.read(ownerId);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	};

	/** Same-storage owners are agent conversations in this storage; their answer arrives as an in-storage follow-up. */
	const deliverSameStorage = async (row: DeliveryRow, owner: string): Promise<void> => {
		if (row.kind === "receipt") {
			const requestId = receiptRequestId(metadata, row.receipt);
			await host.request("submit", { sessionId: owner, message: receiptFollowText(metadata, row), requestId, whenBusy: "followUp" });
			return;
		}
		const requestId = reportRequestId(metadata, row.report);
		await host.request("submit", { sessionId: row.report.ownerId, message: reportFollowText(row.report), requestId, whenBusy: "followUp" });
	};

	const acknowledgeRow = async (row: DeliveryRow): Promise<void> => {
		if (row.kind === "report") {
			await acknowledgeReports(host.harness, row.report.ownerId, [row.report.sourceId], BACKGROUND_CONTEXT);
			return;
		}
		await host.harness.commit(async (tx) => {
			const state = await tx.doc(AgentDeliveryDoc);
			for (const receipt of row.receipts) {
				const key = String(receipt.submissionId);
				const current = state.receipts[key];
				if (current !== undefined && current.ownerId === receipt.ownerId && !current.acknowledged)
					state.receipts[key] = { ...current, acknowledged: true };
			}
		}, BACKGROUND_CONTEXT);
	};

	/** Read the source conversation status; absent or failed stays undefined. */
	const readSourceStatus = async (identity: string): Promise<SourceStatus | undefined> => {
		try {
			const response = (await host.request("status", { sessionId: identity })) as { conversation?: SourceStatus };
			return response?.conversation;
		} catch {
			return undefined;
		}
	};

	/** Actual source metadata; status-only, with an explicit unknown marker when the status is unavailable. */
	const actualMetadata = (status: SourceStatus | undefined): { fields: Record<string, string>; unknown: boolean } => {
		const nonEmpty = (value: unknown): string | undefined =>
			typeof value === "string" && value !== "" ? value : undefined;
		if (status === undefined) return { fields: {}, unknown: true };
		const fields: Record<string, string> = {};
		const provider = nonEmpty(status.agent?.model?.provider);
		const modelId = nonEmpty(status.agent?.model?.modelId);
		const thinkingLevel = nonEmpty(status.agent?.thinkingLevel);
		const name = nonEmpty(status.name);
		const sourceOwner = nonEmpty(status.owner);
		if (provider !== undefined) fields.provider = provider;
		if (modelId !== undefined) fields.modelId = modelId;
		if (thinkingLevel !== undefined) fields.thinkingLevel = thinkingLevel;
		if (name !== undefined) fields.name = name;
		if (sourceOwner !== undefined) fields.sourceOwner = sourceOwner;
		return { fields, unknown: provider === undefined || modelId === undefined };
	};

	/** Fields shared by receipt and report delivery details. */
	const sharedRowDetails = (
		row: DeliveryRow,
		identity: string,
		originalOwnerId: string,
		deliveryRecipient: string,
		liveOwner: boolean,
		fallback: boolean,
		status: SourceStatus | undefined,
		body: { text: string; truncated: boolean },
	): Record<string, unknown> => {
		const actual = actualMetadata(status);
		const sourceId = rowSourceId(metadata, row);
		const saved = row.kind === "receipt" ? row.receipt.entryId !== null || row.receipt.answerEntryId !== null : true;
		return {
			kind: row.kind,
			storageId: metadata.storageId,
			sourceId,
			source: sourceId,
			identity,
			label: displayName(status, identity),
			originalOwnerId,
			deliveryRecipient,
			liveOwner,
			saved,
			wake: fallback ? false : rowWakes(row, deliveryRecipient),
			...(body.truncated ? { textTruncated: true } : {}),
			...actual.fields,
			...(actual.unknown ? { metadataUnknown: true } : {}),
			...(fallback ? { fallback: true, fallbackLabel: FALLBACK_LABEL } : {}),
		};
	};

	/** Observation details: actual source metadata, owner flags, origin, wake intent, and retained row ids. */
	const rowDetails = async (
		row: DeliveryRow,
		identity: string,
		originalOwnerId: string,
		deliveryRecipient: string,
		liveOwner: boolean,
		fallback: boolean,
		status: SourceStatus | undefined,
	): Promise<JsonValue> => {
		const body = boundedPeerText(row.kind === "receipt" ? (row.receipt.answer ?? "") : row.report.message);
		const shared = sharedRowDetails(row, identity, originalOwnerId, deliveryRecipient, liveOwner, fallback, status, body);
		if (row.kind === "receipt") {
			const receipt = row.receipt;
			return {
				...shared,
				submissions: row.receipts.map((member) => ({
					submissionId: member.submissionId,
					requestId: member.requestId,
					operationId: member.operationId,
					entryId: member.entryId,
					ownerId: member.ownerId,
					origin: receiptOrigin(member),
				})),
				conversationId: receipt.conversationId,
				status: receipt.status,
				answerEntryId: receipt.answerEntryId,
				answer: body.text,
				reason: receipt.reason,
				acknowledged: row.receipts.every((member) => member.acknowledged),
			} as unknown as JsonValue;
		}
		const report = row.report;
		return {
			...shared,
			reportSourceId: report.sourceId,
			requestId: report.requestId,
			senderIdentity: report.senderIdentity,
			message: body.text,
			replyTo: report.replyTo,
			acknowledged: report.acknowledged,
			createdAt: report.createdAt,
		} as unknown as JsonValue;
	};

	/** Deliver one row to the owner's registered primary channel. */
	const deliverChannel = async (
		connection: PrimaryChannelConnection,
		row: DeliveryRow,
		identity: string,
		originalOwnerId: string,
		deliveryRecipient: string,
		liveOwner: boolean,
		fallback: boolean,
	): Promise<void> => {
		const status = await readSourceStatus(identity);
		const message: PrimaryDelivery = {
			sourceId: rowSourceId(metadata, row),
			text: channelText(row, displayName(status, identity), originalOwnerId, fallback),
			details: await rowDetails(row, identity, originalOwnerId, deliveryRecipient, liveOwner, fallback, status),
		};
		await connection.deliver(message);
		row.deliveredTo.add(`primary:${deliveryRecipient}`);
	};

	/** Direct delivery to the registered owner: the endpoint is live and the recipient is the owner. */
	const deliverLiveOwner = async (row: DeliveryRow, identity: string, owner: string): Promise<void> => {
		const connection = await connectPrimaryChannel({ id: owner, sessionsRoot });
		try {
			await deliverChannel(connection, row, identity, owner, owner, true, false);
		} finally {
			await connection.close().catch(() => undefined);
		}
	};

	/** One fallback candidate's outcome; an incompatible endpoint never receives a quiet notice. */
	type CandidateOutcome =
		| { readonly kind: "delivered" }
		| { readonly kind: "skipped" }
		| { readonly kind: "failed" }
		| { readonly kind: "incompatible"; readonly version: number };

	/** Deliver one fallback candidate; absent or proven dead endpoints are skipped, incompatible ones refuse. */
	const deliverFallbackCandidate = async (
		id: string,
		row: DeliveryRow,
		identity: string,
		owner: string,
	): Promise<CandidateOutcome> => {
		if (row.deliveredTo.has(`primary:${id}`)) return { kind: "delivered" };
		const status = primaryEndpointStatus(sessionsRoot, id);
		if (status.state === "absent" || status.state === "dead") return { kind: "skipped" };
		if (status.state === "incompatible") return { kind: "incompatible", version: status.version ?? 0 };
		let connection: PrimaryChannelConnection;
		try {
			connection = await connectPrimaryChannel({ id, sessionsRoot });
		} catch {
			// A live or unknown candidate that cannot be reached is not proven absent.
			return { kind: "failed" };
		}
		try {
			await deliverChannel(connection, row, identity, owner, id, false, true);
			return { kind: "delivered" };
		} catch {
			return { kind: "failed" };
		} finally {
			await connection.close().catch(() => undefined);
		}
	};

	/** Registered candidates for an absent or dead owner; incomplete discovery refuses before any delivery. */
	const fallbackCandidates = async (owner: string): Promise<readonly string[]> => {
		const discovery = await listPrimaryChannels(sessionsRoot);
		if (!discovery.complete)
			throw new Error(
				`primary discovery is incomplete after ${discovery.visited} visits; refusing to acknowledge fallback for ${owner}`,
			);
		const candidates = discovery.ids.filter((id) => id !== owner);
		if (candidates.length === 0)
			throw new Error(`no live owning session for ${owner} and no registered primary accepted delivery`);
		return candidates;
	};

	/** Deliver one row to every candidate; an unavailable or incompatible candidate holds the row. */
	const broadcastFallback = async (
		candidates: readonly string[],
		row: DeliveryRow,
		identity: string,
		owner: string,
	): Promise<{ delivered: number; unavailable: string | undefined; incompatible: { id: string; version: number } | undefined }> => {
		let delivered = 0;
		let unavailable: string | undefined;
		let incompatible: { id: string; version: number } | undefined;
		for (const id of candidates) {
			if (closed || signal.aborted) return { delivered, unavailable, incompatible };
			const outcome = await deliverFallbackCandidate(id, row, identity, owner);
			if (outcome.kind === "delivered") delivered += 1;
			else if (outcome.kind === "failed") unavailable ??= id;
			else if (outcome.kind === "incompatible") incompatible ??= { id, version: outcome.version };
		}
		return { delivered, unavailable, incompatible };
	};

	const incompatibleFallbackError = (id: string, version: number, owner: string): Error =>
		new Error(`${primaryEndpointIncompatibleError(id, version).message} The fallback for ${owner} stays unacknowledged.`);

	/** Check every candidate before one delivery, so an older registered primary never sees a quiet notice. */
	const preflightFallback = (candidates: readonly string[], owner: string): void => {
		for (const id of candidates) {
			if (closed || signal.aborted) return;
			const status = primaryEndpointStatus(sessionsRoot, id);
			if (status.state === "incompatible") throw incompatibleFallbackError(id, status.version ?? 0, owner);
		}
	};

	/** Broadcast the fallback to every registered primary; an older, unreachable, or absent audience holds the row. */
	const deliverFallbackOwner = async (row: DeliveryRow, identity: string, owner: string): Promise<void> => {
		const candidates = await fallbackCandidates(owner);
		preflightFallback(candidates, owner);
		const { delivered, unavailable, incompatible } = await broadcastFallback(candidates, row, identity, owner);
		if (incompatible !== undefined) throw incompatibleFallbackError(incompatible.id, incompatible.version, owner);
		if (unavailable !== undefined)
			throw new Error(
				`registered primary ${unavailable} is live or unknown but unreachable; the fallback for ${owner} stays unacknowledged`,
			);
		if (delivered === 0)
			throw new Error(`no live owning session for ${owner} and no registered primary accepted delivery`);
	};

	/** Noncatalog owners: an older, unknown, or dead endpoint never falls back to a broadcast. */
	const deliverPrimary = async (row: DeliveryRow, owner: string): Promise<void> => {
		if (row.deliveredTo.has(`primary:${owner}`)) return;
		if (!PRIMARY_ID.test(owner))
			throw new Error(`delivery owner ${owner} is not a canonical primary id; refusing fallback`);
		const identity = row.kind === "receipt" ? host.identity(row.receipt.conversationId) : row.report.senderIdentity;
		const status = primaryEndpointStatus(sessionsRoot, owner);
		if (status.state === "live") await deliverLiveOwner(row, identity, owner);
		else if (status.state === "incompatible") throw primaryEndpointIncompatibleError(owner, status.version ?? 0);
		else if (status.state === "unknown") throw new Error(`primary owner ${owner} has an unknown endpoint; refusing fallback`);
		else await deliverFallbackOwner(row, identity, owner);
	};

	/** Catalog owners: untrusted follow-up into the owner's own host; no ownerId intent. */
	const deliverCatalog = async (record: CatalogRecord, row: DeliveryRow, owner: string): Promise<void> => {
		const connection = await targetConnection(record);
		if (row.kind === "receipt") {
			const requestId = receiptRequestId(metadata, row.receipt);
			await connection.request(
				"submit",
				{
					sessionId: owner,
					message: receiptFollowText(metadata, row),
					requestId,
					whenBusy: "followUp",
				},
				{ requestId, signal },
			);
		} else {
			const requestId = reportRequestId(metadata, row.report);
			await connection.request(
				"submit",
				{ sessionId: row.report.ownerId, message: reportFollowText(row.report), requestId, whenBusy: "followUp" },
				{ requestId, signal },
			);
		}
	};

	const routeOwner = async (row: DeliveryRow, owner: string): Promise<void> => {
		if (ownerStorageId(owner) === metadata.storageId) {
			await deliverSameStorage(row, owner);
			return;
		}
		const record = ownerRecord(owner);
		if (record !== undefined) await deliverCatalog(record, row, owner);
		else await deliverPrimary(row, owner);
	};

	/** All owner routes must complete before the answer group is acknowledged. */
	const routeRow = async (row: DeliveryRow, owners: readonly string[]): Promise<void> => {
		let failure: Error | undefined;
		for (const owner of owners) {
			if (closed || signal.aborted) return;
			try { await routeOwner(row, owner); }
			catch (error) { failure ??= asError(error); }
		}
		if (failure !== undefined) throw failure;
		if (!closed && !signal.aborted) await acknowledgeRow(row);
	};

	/** Route independent answers and reports even when another route fails; corruption is contained per row. */
	const routeRows = async (rows: readonly DeliveryRow[]): Promise<Error | undefined> => {
		let failure: Error | undefined;
		for (const row of rows) {
			const corruption = rowOriginFailure(row);
			if (corruption !== undefined) {
				corruptRows.add(rowSourceId(metadata, row));
				fail(corruption);
				continue;
			}
			const owners = rowOwners(row);
			if (owners.length === 0) continue;
			try { await routeRow(row, owners); }
			catch (error) { failure ??= asError(error); }
		}
		return failure;
	};

	/** One pass: settle intents, route every unacknowledged record, report the first failure. */
	const scan = async (): Promise<void> => {
		corruptRows.clear();
		await settleDeliveries(host.harness, BACKGROUND_CONTEXT);
		const state = await host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
		if (state === undefined) return;
		const rows: DeliveryRow[] = [
			...receiptRows(Object.values(state.receipts)),
			...state.reports.map((report): DeliveryRow => ({ kind: "report", report, deliveredTo: new Set() })),
		];
		const failure = await routeRows(rows);
		if (failure !== undefined) throw failure;
	};

	const run = async (): Promise<void> => {
		if (closed || signal.aborted) return;
		running = true;
		try {
			await scan();
			if (corruptRows.size === 0) host.reportDeliveryError(undefined);
			attempts = 0;
		} catch (error) {
			fail(error);
			attempts += 1;
			schedule(Math.min(retryDelayMs * 2 ** Math.min(attempts - 1, MAX_RETRY_SHIFT), MAX_RETRY_DELAY_MS));
		} finally {
			running = false;
			if (dirty) {
				dirty = false;
				schedule(0);
			}
		}
	};

	/** Coalesced schedule: a commit during a pass marks one follow-up pass. */
	function schedule(delayMs: number): void {
		if (closed || signal.aborted) return;
		if (running) {
			dirty = true;
			return;
		}
		if (timer) return;
		timer = setTimeout(
			() => {
				timer = undefined;
				inFlight = run().finally(() => {
					inFlight = undefined;
				});
			},
			Math.max(0, delayMs),
		);
	}

	const close = (): Promise<void> => {
		if (closePromise) return closePromise;
		closed = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
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
		})();
		return closePromise;
	};

	function onAbort(): void {
		void close();
	}

	signal.addEventListener("abort", onAbort, { once: true });
	unsubscribe = host.harness.subscribeCommits(() => schedule(0));
	if (!signal.aborted) schedule(0);
	return { close };
}
