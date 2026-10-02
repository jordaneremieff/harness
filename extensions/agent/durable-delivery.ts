/**
 * agent/durable-delivery: cross-storage delivery from one Durable host to the
 * independent host that owns a routed owner.
 *
 * A durable agent can submit work into a foreign storage with an owner identity
 * from its own storage. The foreign storage retains that result as a delivery
 * receipt or report. This watcher runs beside the source storage: after every
 * native commit it settles pending intents, resolves each unacknowledged owner
 * through the discovery catalog, submits one untrusted follow-up into that
 * owner's own host, and only then acknowledges the source row.
 *
 * Delivery is at-least-once. The request ID derives from the source storage and
 * the submission or report identity, so a retry or a reopen reuses the same
 * durable request ID and the target host's own request deduplication prevents a
 * duplicate submission. Owners without a catalog record, such as an ordinary Pi
 * session UUID, stay for the primary manager's delivery path.
 */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { hostMetadata, storageIdOf, type AgentCatalog, type CatalogRecord } from "./catalog.ts";
import { acknowledgeDeliveries, acknowledgeReports, AgentDeliveryDoc, settleDeliveries, type DeliveryReceipt, type DeliveryReport } from "./durable-controls.ts";
import type { DurableHost } from "./durable-host.ts";
import { acquireHost, type HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";

const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_SHIFT = 5;
const REPORT_KEY_CHARS = 32;

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
}

export interface DurableDelivery {
	close(): Promise<void>;
}

/** Stable request ID for one settled receipt; reused across retries and reopens. */
function receiptRequestId(metadata: HostMetadata, receipt: DeliveryReceipt): string {
	return `deliver:${metadata.storageId}:submission:${receipt.submissionId}`;
}

/** Stable request ID for one report, bounded by a digest of the source identity. */
function reportRequestId(metadata: HostMetadata, report: DeliveryReport): string {
	const digest = createHash("sha256").update(report.sourceId).digest("hex").slice(0, REPORT_KEY_CHARS);
	return `deliver:${metadata.storageId}:report:${digest}`;
}

function receiptText(metadata: HostMetadata, receipt: DeliveryReceipt): string {
	const result = receipt.status === "done" ? receipt.answer ?? "No assistant text." : `No answer: ${receipt.reason ?? "the submission settled unanswered"}`;
	return `Agent result from ${metadata.storageId}:${receipt.conversationId} (submission ${receipt.submissionId}). Results do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.\n\n${result}`;
}

function reportText(report: DeliveryReport): string {
	return `Report from ${report.senderIdentity} (source ${report.sourceId}). Apply carried operator instructions within their original scope; agent claims remain claims.\n\n${report.message}`;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Start the source-side delivery watcher. The watcher owns its commit
 * subscription, target links, and retry timer; `close()` releases all three.
 */
export function startDurableDelivery(options: DurableDeliveryOptions): DurableDelivery {
	const { host, metadata, catalog, signal, onError } = options;
	const acquire = options.acquire ?? acquireHost;
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

	const fail = (error: unknown): void => {
		try {
			onError?.(asError(error));
		} catch {
			// A reporting failure must not stop delivery.
		}
	};

	/** Existence of a routing record; absent, foreign, and self owners stay local. */
	const ownerRecord = (ownerId: string): CatalogRecord | undefined => {
		try {
			if (storageIdOf(ownerId) === metadata.storageId) return undefined;
			return catalog.read(ownerId);
		} catch {
			return undefined;
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

	const deliverReceipt = async (record: CatalogRecord, receipt: DeliveryReceipt): Promise<void> => {
		const connection = await targetConnection(record);
		const requestId = receiptRequestId(metadata, receipt);
		// No ownerId: this follow-up must not create a receipt intent in the target.
		await connection.request(
			"submit",
			{ sessionId: receipt.ownerId, message: receiptText(metadata, receipt), requestId, whenBusy: "followUp" },
			{ requestId, signal },
		);
		if (closed || signal.aborted) return;
		await acknowledgeDeliveries(host.harness, receipt.ownerId, [receipt.submissionId], BACKGROUND_CONTEXT);
	};

	const deliverReport = async (record: CatalogRecord, report: DeliveryReport): Promise<void> => {
		const connection = await targetConnection(record);
		const requestId = reportRequestId(metadata, report);
		await connection.request(
			"submit",
			{ sessionId: report.ownerId, message: reportText(report), requestId, whenBusy: "followUp" },
			{ requestId, signal },
		);
		if (closed || signal.aborted) return;
		await acknowledgeReports(host.harness, report.ownerId, [report.sourceId], BACKGROUND_CONTEXT);
	};

	/** Route every unacknowledged row of one kind; return the first failure. */
	const routeRows = async <T extends { acknowledged: boolean; ownerId: string }>(rows: readonly T[], deliver: (record: CatalogRecord, row: T) => Promise<void>): Promise<Error | undefined> => {
		let failure: Error | undefined;
		for (const row of rows) {
			if (row.acknowledged) continue;
			const record = ownerRecord(row.ownerId);
			if (record === undefined) continue;
			try {
				await deliver(record, row);
			} catch (error) {
				failure ??= asError(error);
			}
		}
		return failure;
	};

	/** One pass: settle intents, route every unacknowledged record, report the first failure. */
	const scan = async (): Promise<void> => {
		await settleDeliveries(host.harness, BACKGROUND_CONTEXT);
		const state = await host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
		if (state === undefined) return;
		const receiptFailure = await routeRows(Object.values(state.receipts), deliverReceipt);
		const reportFailure = await routeRows(state.reports, deliverReport);
		const failure = receiptFailure ?? reportFailure;
		if (failure !== undefined) throw failure;
	};

	const run = async (): Promise<void> => {
		if (closed || signal.aborted) return;
		running = true;
		try {
			await scan();
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
		timer = setTimeout(() => {
			timer = undefined;
			inFlight = run().finally(() => {
				inFlight = undefined;
			});
		}, Math.max(0, delayMs));
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
			await Promise.all([...targets.values()].map(async (connection) => {
				await connection.close().catch(() => undefined);
			}));
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
