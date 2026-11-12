/** Native keyed delivery records and bounded reference pages. Payloads have one retained owner. */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalIdentity } from "./native-identity.ts";
import type { ReceiptReferencePage } from "./result-schema.ts";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, type Cursor, type Harness, type Session, type Storage, type Tx } from "@earendil-works/pi-durable";
import type { AgentDeliveryState, DeliveryIntent, DeliveryReceipt, DeliveryReport } from "./durable-controls.ts";

export const DELIVERY_PAGE_SIZE = 64;
type Kind = "intent" | "receipt" | "report";
type Row = DeliveryIntent | DeliveryReceipt | DeliveryReport;
type StoredRow = { kind: Kind; value: Row | null; pendingPage: string | null; kindPage: string | null; terminalPage: string | null; terminalKindPage: string | null; automaticPage: string | null };
type List = { head: string | null; tail: string | null; count: number };
type Page = { ownerList: string; refs: string[]; previous: string | null; next: string | null };
type StoreState = { ready: boolean; nextPage: number; migrationKind: number; migrationOffset: number };
type StorageReader = Pick<Storage, "scanDocuments" | "findDocument" | "document" | "scanTasks">;

/** Retained only until a completed representation transition retires it. */
export const DeliveryArchiveDoc = defineDoc<AgentDeliveryState>({ kind: "agent.delivery", version: 1, scope: "session", initial: () => ({ intents: [], receipts: {}, reports: [] }), checkpointWhen: () => true });
export const DeliveryStoreDoc = defineDoc<StoreState>({ kind: "agent.delivery-store", version: 1, scope: "session", initial: () => ({ ready: false, nextPage: 0, migrationKind: 0, migrationOffset: 0 }), checkpointWhen: () => true });
export const DeliveryRowDoc = defineDocFamily<StoredRow, Kind>({ kind: "agent.delivery-row", version: 1, scope: "session", family: true, initial: (kind) => ({ kind, value: null, pendingPage: null, kindPage: null, terminalPage: null, terminalKindPage: null, automaticPage: null }), checkpointWhen: () => true });
const DeliveryPointerDoc = defineDocFamily<{ key: string | null }, null>({ kind: "agent.delivery-pointer", version: 1, scope: "session", family: true, initial: () => ({ key: null }), checkpointWhen: () => true });
const CheckInFallbackDoc = defineDocFamily<{ accepted: boolean }, null>({ kind: "agent.check-in-fallback", version: 1, scope: "session", family: true, initial: () => ({ accepted: false }), checkpointWhen: () => true });
const DeliveryListDoc = defineDocFamily<List, null>({ kind: "agent.delivery-list", version: 1, scope: "session", family: true, initial: () => ({ head: null, tail: null, count: 0 }), checkpointWhen: () => true });
const DeliveryPageDoc = defineDocFamily<Page, null>({ kind: "agent.delivery-page", version: 2, scope: "session", family: true, initial: () => ({ ownerList: "", refs: [], previous: null, next: null }), checkpointWhen: () => true });
/** Exact manual command that adopts version 1 pages; it ships beside this module. */
export const ADOPTION_COMMAND = `node ${fileURLToPath(new URL("./adopt-delivery-pages.ts", import.meta.url))}`;

/** Pi refuses a version 1 page; the refusal stays and names its cause and remedy. */
function pageRefusal(error: unknown): unknown {
	if (!(error instanceof Error) || !/requires migration from version 1/u.test(error.message)) return error;
	return new Error(`${error.message}. This storage keeps delivery reference pages in the format of an earlier release, so delivery appends and reads refuse here. Run \`${ADOPTION_COMMAND}\` for a dry run, then add --apply (and --storage <id> for one storage) to adopt the pages.`, { cause: error });
}
async function pageAt(tx: Tx, id: string): Promise<Page> {
	try { return await tx.doc(DeliveryPageDoc, id, null); }
	catch (error) { throw pageRefusal(error); }
}
async function pageSnapshot(session: Pick<Session, "snapshot">, id: string, context: Context): Promise<Page | undefined> {
	try { return await session.snapshot(DeliveryPageDoc, id, context); }
	catch (error) { throw pageRefusal(error); }
}
function requirePageOwner(page: Page, name: string): void {
	if (page.ownerList !== name) throw new Error("Delivery reference page has no current owner-list identity or belongs to another list");
}

export function intentKey(conversationId: number, requestId: string): string { return JSON.stringify(["intent", conversationId, requestId]); }
export function receiptKey(submissionId: number): string { return JSON.stringify(["receipt", submissionId]); }
export function reportKey(ownerId: string, sourceId: string): string { return JSON.stringify(["report", ownerId, sourceId]); }
function keyOf(kind: Kind, value: Row): string {
	if (kind === "intent") { const row = value as DeliveryIntent; return intentKey(row.conversationId, row.requestId); }
	if (kind === "receipt") return receiptKey((value as DeliveryReceipt).submissionId);
	const row = value as DeliveryReport; return reportKey(row.ownerId, row.sourceId);
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

async function appendReference(tx: Tx, name: string, key: string): Promise<string> {
	const list = await tx.doc(DeliveryListDoc, name, null);
	let page = list.tail === null ? undefined : await pageAt(tx, list.tail);
	if (page) requirePageOwner(page, name);
	if (!page || page.refs.length === DELIVERY_PAGE_SIZE) {
		const root = await tx.doc(DeliveryStoreDoc);
		if (!Number.isSafeInteger(root.nextPage + 1)) throw new Error("Delivery page identity exhausted");
		const id = String(++root.nextPage);
		const next = await pageAt(tx, id);
		next.ownerList = name;
		next.previous = list.tail;
		if (page) page.next = id;
		else list.head = id;
		list.tail = id;
		page = next;
	}
	page.refs.push(key);
	list.count += 1;
	const tail = list.tail;
	if (tail === null) throw new Error("Delivery reference tail is absent");
	return tail;
}

async function removePending(tx: Tx, key: string, pageId: string, name = "pending"): Promise<void> {
	const list = await tx.doc(DeliveryListDoc, name, null);
	const page = await pageAt(tx, pageId);
	requirePageOwner(page, name);
	const index = page.refs.indexOf(key);
	if (index < 0) throw new Error("Delivery pending reference is inconsistent");
	page.refs.splice(index, 1);
	list.count -= 1;
	if (page.refs.length !== 0) return;
	if (page.previous !== null) (await pageAt(tx, page.previous)).next = page.next;
	else list.head = page.next;
	if (page.next !== null) (await pageAt(tx, page.next)).previous = page.previous;
	else list.tail = page.previous;
	await tx.retireDoc(DeliveryPageDoc, pageId);
}

export async function snapshotIntent(harness: Harness, conversationId: number, requestId: string, context: Context): Promise<DeliveryIntent | undefined> {
	const row = await harness.snapshot(DeliveryRowDoc, intentKey(conversationId, requestId), context);
	return row?.value == null ? undefined : copy(row.value as DeliveryIntent);
}
export async function snapshotReceipt(harness: Harness, submissionId: number, context: Context): Promise<DeliveryReceipt | undefined> {
	const row = await harness.snapshot(DeliveryRowDoc, receiptKey(submissionId), context);
	return row?.value == null ? undefined : copy(row.value as DeliveryReceipt);
}

/** Acquire only admitted identities or already-resolved rows on the mutation line. */
export async function retainedIntent(tx: Tx, conversationId: number, requestId: string): Promise<DeliveryIntent | undefined> {
	const row = await tx.doc(DeliveryRowDoc, intentKey(conversationId, requestId), "intent");
	return row.value === null ? undefined : copy(row.value as DeliveryIntent);
}
export async function retainedReceipt(tx: Tx, submissionId: number): Promise<DeliveryReceipt | undefined> {
	const row = await tx.doc(DeliveryRowDoc, receiptKey(submissionId), "receipt");
	return row.value === null ? undefined : copy(row.value as DeliveryReceipt);
}
export async function retainedReport(tx: Tx, ownerId: string, sourceId: string): Promise<DeliveryReport | undefined> {
	const row = await tx.doc(DeliveryRowDoc, reportKey(ownerId, sourceId), "report");
	return row.value === null ? undefined : copy(row.value as DeliveryReport);
}

async function pendingRow(tx: Tx, kind: Kind, value: Row): Promise<boolean> {
	if (kind !== "intent") return !(value as DeliveryReport | DeliveryReceipt).acknowledged;
	const intent = value as DeliveryIntent;
	return intent.submissionId === null || await retainedReceipt(tx, intent.submissionId) === undefined;
}

async function requireReadyStore(tx: Tx, migration: boolean): Promise<void> {
	const root = await tx.doc(DeliveryStoreDoc);
	if (root.ready || migration) return;
	const archive = await tx.doc(DeliveryArchiveDoc);
	if (archive.intents.length || Object.keys(archive.receipts).length || archive.reports.length)
		throw new Error("Delivery representation requires migration before admission");
	root.ready = true;
	await tx.retireDoc(DeliveryArchiveDoc);
}

async function indexReceipt(tx: Tx, receipt: DeliveryReceipt, key: string): Promise<void> {
	if (receipt.operationId !== null) await appendReference(tx, `operation:${receipt.operationId}`, key);
	if (receipt.answerEntryId !== null) await appendReference(tx, `answer:${receipt.answerEntryId}`, key);
	if (receipt.entryId !== null) (await tx.doc(DeliveryPointerDoc, `input:${receipt.conversationId}:${receipt.entryId}`, null)).key = key;
	(await tx.doc(DeliveryPointerDoc, `receipt-request:${JSON.stringify([receipt.conversationId, receipt.requestId])}`, null)).key = key;
	const latest = await tx.doc(DeliveryPointerDoc, `latest:${receipt.conversationId}`, null);
	const previous = latest.key === null ? undefined : (await tx.doc(DeliveryRowDoc, latest.key, "receipt")).value as DeliveryReceipt | null;
	if (!previous || previous.submissionId < receipt.submissionId) latest.key = key;
}

async function indexReport(tx: Tx, report: DeliveryReport, key: string, created: boolean): Promise<void> {
	if (created) {
		const request = await tx.doc(DeliveryPointerDoc, `request:${JSON.stringify([report.ownerId, report.requestId])}`, null);
		if (request.key === null) request.key = key;
	}
	if (!report.checkIn) return;
	const checkIn = JSON.stringify([report.ownerId, report.checkIn.conversationId, report.checkIn.requestId]);
	if (created) (await tx.doc(DeliveryPointerDoc, `check-in:${checkIn}`, null)).key = key;
	if (report.checkIn.fallbackBroadcast) (await tx.doc(CheckInFallbackDoc, checkIn, null)).accepted = true;
}

type ReferenceField = "pendingPage" | "kindPage" | "terminalPage" | "terminalKindPage" | "automaticPage";
async function setReference(tx: Tx, stored: StoredRow, key: string, field: ReferenceField, name: string, needed: boolean): Promise<void> {
	const page = stored[field];
	if (needed && page === null) stored[field] = await appendReference(tx, name, key);
	else if (!needed && page !== null) {
		await removePending(tx, key, page, name);
		stored[field] = null;
	}
}

/** One point update plus bounded reference pages; a create retry never replaces its retained outcome. */
export async function storeDeliveryRow<T extends Row>(tx: Tx, kind: Kind, value: T, create = false, migrationPending?: boolean): Promise<T> {
	await requireReadyStore(tx, migrationPending !== undefined);
	const key = keyOf(kind, value);
	const stored = await tx.doc(DeliveryRowDoc, key, kind);
	if (create && stored.value !== null) return copy(stored.value as T);
	const created = stored.value === null;
	if (created) {
		await appendReference(tx, `all:${kind}`, key);
		if (kind === "receipt") await indexReceipt(tx, value as DeliveryReceipt, key);
	}
	if (kind === "report") await indexReport(tx, value as DeliveryReport, key, created);
	const unacknowledged = migrationPending ?? await pendingRow(tx, kind, value);
	const terminal = unacknowledged && value.delivery?.state === "terminal";
	const pending = unacknowledged && !terminal;
	const automatic = kind === "report" && !(value as DeliveryReport).acknowledged && ((value as DeliveryReport).checkIn !== undefined || (value as DeliveryReport).providerRetry !== undefined);
	await setReference(tx, stored, key, "pendingPage", "pending", pending);
	await setReference(tx, stored, key, "kindPage", `pending:${kind}`, pending);
	await setReference(tx, stored, key, "terminalPage", "terminal", terminal);
	await setReference(tx, stored, key, "terminalKindPage", `terminal:${kind}`, terminal);
	await setReference(tx, stored, key, "automaticPage", "automatic", automatic);
	if (JSON.stringify(stored.value) !== JSON.stringify(value)) stored.value = copy(value);
	return copy(value);
}

async function listReferences(tx: Tx, name: string): Promise<string[]> {
	const list = await tx.doc(DeliveryListDoc, name, null);
	const refs: string[] = [];
	let id = list.head;
	while (id !== null) {
		const page = await pageAt(tx, id);
		requirePageOwner(page, name);
		refs.push(...page.refs);
		id = page.next;
	}
	return refs;
}
const drafts = new WeakMap<AgentDeliveryState, Map<string, { kind: Kind; value: Row }>>();

function includeDeliveryRow(state: AgentDeliveryState, kind: Kind, value: Row): void {
	if (kind === "intent") state.intents.push(value as DeliveryIntent);
	else if (kind === "receipt") state.receipts[String((value as DeliveryReceipt).submissionId)] = value as DeliveryReceipt;
	else state.reports.push(value as DeliveryReport);
}

/** Current pending work, or an explicit historical read, detached from its keyed records. */
export async function readDeliveryDraft(tx: Tx, history = false, kind?: Kind, includeTerminal = false): Promise<AgentDeliveryState> {
	const kinds: readonly Kind[] = kind ? [kind] : ["intent", "receipt", "report"];
	const refs = history ? (await Promise.all(kinds.map((item) => listReferences(tx, `all:${item}`)))).flat() : await listReferences(tx, kind ? `pending:${kind}` : "pending");
	if (!history && includeTerminal) refs.push(...await listReferences(tx, kind ? `terminal:${kind}` : "terminal"));
	const state: AgentDeliveryState = { intents: [], receipts: {}, reports: [] };
	const originals = new Map<string, { kind: Kind; value: Row }>();
	for (const key of refs) {
		const kind = JSON.parse(key)[0] as Kind;
		const stored = await tx.doc(DeliveryRowDoc, key, kind);
		if (stored.value === null) throw new Error("Delivery reference has no retained row");
		const value = copy(stored.value);
		originals.set(key, { kind, value: copy(value) });
		includeDeliveryRow(state, kind, value);
	}
	drafts.set(state, originals);
	return state;
}

async function writeDraftRow(tx: Tx, kind: Kind, value: Row, original: Row | undefined): Promise<void> {
	if (original === undefined) {
		await storeDeliveryRow(tx, kind, value, true);
		return;
	}
	if (kind === "intent" || JSON.stringify(original) !== JSON.stringify(value)) await storeDeliveryRow(tx, kind, value);
}

/** Commit changed current rows, retaining removed automatic reports as acknowledged dedupe outcomes. */
export async function writeDeliveryDraft(tx: Tx, state: AgentDeliveryState): Promise<void> {
	const originals = drafts.get(state);
	if (!originals) throw new Error("Delivery state is not a transaction draft");
	const seen = new Set<string>();
	// Receipt creation precedes intent membership removal in the same native commit.
	for (const [kind, rows] of [["receipt", Object.values(state.receipts)], ["intent", state.intents], ["report", state.reports]] as const) {
		for (const value of rows) {
			const key = keyOf(kind, value);
			seen.add(key);
			await writeDraftRow(tx, kind, value, originals.get(key)?.value);
		}
	}
	for (const [key, original] of originals) {
		if (seen.has(key)) continue;
		if (original.kind !== "report") throw new Error("Delivery draft removed a non-report row");
		await storeDeliveryRow(tx, "report", { ...original.value as DeliveryReport, acknowledged: true });
	}
}

async function snapshotListRows(session: Pick<Session, "snapshot">, state: AgentDeliveryState, name: string, context: Context): Promise<void> {
	const list = await session.snapshot(DeliveryListDoc, name, context);
	let id = list?.head ?? null;
	while (id !== null) {
		const page = await pageSnapshot(session, id, context);
		if (!page) throw new Error("Delivery reference has no retained page");
		requirePageOwner(page, name);
		for (const key of page.refs) {
			const row = await session.snapshot(DeliveryRowDoc, key, context);
			if (!row?.value) throw new Error("Delivery reference has no retained row");
			includeDeliveryRow(state, row.kind, copy(row.value));
		}
		id = page.next;
	}
}

/** Noncreating reads of one frozen copy; live writers use an atomic delivery draft. */
export async function snapshotDeliveryState(session: Pick<Session, "snapshot">, context: Context, history = false, includeTerminal = true): Promise<AgentDeliveryState> {
	const names = history ? ["all:intent", "all:receipt", "all:report"] : includeTerminal ? ["pending", "terminal"] : ["pending"];
	const state: AgentDeliveryState = { intents: [], receipts: {}, reports: [] };
	for (const name of names) await snapshotListRows(session, state, name, context);
	return state;
}

export async function deliveryState(harness: Harness, context: Context, history = false, includeTerminal = true): Promise<AgentDeliveryState> {
	await migrateDeliveryStore(harness, context);
	return harness.commit((tx) => readDeliveryDraft(tx, history, undefined, includeTerminal), context);
}

/** Counts preserve terminal acknowledgement work without enumerating retained diagnostics. */
export async function deliveryPendingCount(harness: Harness, context: Context): Promise<number> {
	const active = await harness.snapshot(DeliveryListDoc, "pending", context);
	const terminal = await harness.snapshot(DeliveryListDoc, "terminal", context);
	return (active?.count ?? 0) + (terminal?.count ?? 0);
}

/** One retained terminal diagnostic per kind, independent of terminal history length. */
export async function terminalDeliveryState(harness: Harness, context: Context): Promise<AgentDeliveryState> {
	const result: AgentDeliveryState = { intents: [], receipts: {}, reports: [] };
	for (const kind of ["intent", "receipt", "report"] as const) {
		const list = await harness.snapshot(DeliveryListDoc, `terminal:${kind}`, context);
		if (list?.head == null) continue;
		const page = await pageSnapshot(harness, list.head, context);
		if (!page?.refs.length) continue;
		requirePageOwner(page, `terminal:${kind}`);
		const row = await harness.snapshot(DeliveryRowDoc, page.refs[0], context);
		if (row?.value == null) continue;
		if (kind === "intent") result.intents.push(copy(row.value as DeliveryIntent));
		else if (kind === "receipt") result.receipts[String((row.value as DeliveryReceipt).submissionId)] = copy(row.value as DeliveryReceipt);
		else result.reports.push(copy(row.value as DeliveryReport));
	}
	return result;
}
async function pendingReferencePage(harness: Harness, context: Context, cursor: string | undefined, kind: Kind | undefined) {
	const list = await harness.snapshot(DeliveryListDoc, kind ? `pending:${kind}` : "pending", context);
	let id = cursor ?? list?.head ?? null;
	let page = id === null ? undefined : await pageSnapshot(harness, id, context);
	if (!page && cursor !== undefined) {
		id = list?.head ?? null;
		page = id === null ? undefined : await pageSnapshot(harness, id, context);
	}
	if (page) requirePageOwner(page, kind ? `pending:${kind}` : "pending");
	return { id, page };
}

async function includePendingRow(harness: Harness, context: Context, state: AgentDeliveryState, key: string, id: string, kind: Kind | undefined): Promise<void> {
	const stored = await harness.snapshot(DeliveryRowDoc, key, context);
	if (!stored?.value || (kind ? stored.kindPage : stored.pendingPage) !== id) return;
	includeDeliveryRow(state, stored.kind, copy(stored.value));
}

/** One current page per scheduler turn; a removed continuation restarts from the live head. */
export async function pendingDeliveryPage(harness: Harness, context: Context, cursor?: string, kind?: Kind): Promise<{ state: AgentDeliveryState; keys: readonly string[]; next: string | null }> {
	const { id, page } = await pendingReferencePage(harness, context, cursor, kind);
	const state: AgentDeliveryState = { intents: [], receipts: {}, reports: [] };
	if (!page || id === null) return { state, keys: [], next: null };
	for (const key of page.refs) await includePendingRow(harness, context, state, key, id, kind);
	return { state, keys: [...page.refs], next: page.next };
}

/** Completion checks remain current work regardless of routing eligibility. */
export async function automaticDeliveryPage(harness: Harness, context: Context, cursor?: string): Promise<{ reports: DeliveryReport[]; next: string | null }> {
	const list = await harness.snapshot(DeliveryListDoc, "automatic", context);
	let id = cursor ?? list?.head ?? null;
	let page = id === null ? undefined : await pageSnapshot(harness, id, context);
	if (!page && cursor !== undefined) {
		id = list?.head ?? null;
		page = id === null ? undefined : await pageSnapshot(harness, id, context);
	}
	const reports: DeliveryReport[] = [];
	if (!page || id === null) return { reports, next: null };
	requirePageOwner(page, "automatic");
	for (const key of page.refs) {
		const row = await harness.snapshot(DeliveryRowDoc, key, context);
		if (row?.value != null && row.automaticPage === id) reports.push(copy(row.value as DeliveryReport));
	}
	return { reports, next: page.next };
}

export async function currentCheckInReport(tx: Tx, owner: string, conversationId: number, requestId: string): Promise<DeliveryReport | undefined> {
	const pointer = await tx.doc(DeliveryPointerDoc, `check-in:${JSON.stringify([owner, conversationId, requestId])}`, null);
	if (pointer.key === null) return undefined;
	const row = await tx.doc(DeliveryRowDoc, pointer.key, "report");
	return row.value === null ? undefined : copy(row.value as DeliveryReport);
}
export async function checkInFallback(tx: Tx, owner: string, conversationId: number, requestId: string): Promise<boolean> {
	return (await tx.doc(CheckInFallbackDoc, JSON.stringify([owner, conversationId, requestId]), null)).accepted;
}
async function receiptFromPointer(harness: Harness, key: string, context: Context): Promise<DeliveryReceipt | undefined> {
	const pointer = await harness.snapshot(DeliveryPointerDoc, key, context);
	if (pointer?.key == null) return undefined;
	const row = await harness.snapshot(DeliveryRowDoc, pointer.key, context);
	return row?.value == null ? undefined : copy(row.value as DeliveryReceipt);
}
export function receiptForRequest(harness: Harness, conversationId: number, requestId: string, context: Context): Promise<DeliveryReceipt | undefined> {
	return receiptFromPointer(harness, `receipt-request:${JSON.stringify([conversationId, requestId])}`, context);
}
export function latestReceipt(harness: Harness, conversationId: number, context: Context): Promise<DeliveryReceipt | undefined> {
	return receiptFromPointer(harness, `latest:${conversationId}`, context);
}
export function receiptAtInput(harness: Harness, conversationId: number, entryId: number, context: Context): Promise<DeliveryReceipt | undefined> {
	return receiptFromPointer(harness, `input:${conversationId}:${entryId}`, context);
}
export async function retainedReportRequest(tx: Tx, ownerId: string, requestId: string): Promise<DeliveryReport | undefined> {
	const pointer = await tx.doc(DeliveryPointerDoc, `request:${JSON.stringify([ownerId, requestId])}`, null);
	if (pointer.key === null) return undefined;
	const row = await tx.doc(DeliveryRowDoc, pointer.key, "report");
	return row.value === null ? undefined : copy(row.value as DeliveryReport);
}

/** Reload visited rows after effects without a historical traversal or a creating read. */
export async function reloadDeliveryRows(harness: Harness, state: AgentDeliveryState, context: Context): Promise<AgentDeliveryState> {
	const result: AgentDeliveryState = { intents: [], receipts: {}, reports: [] };
	for (const [kind, rows] of [["intent", state.intents], ["receipt", Object.values(state.receipts)], ["report", state.reports]] as const) {
		for (const value of rows) {
			const stored = await harness.snapshot(DeliveryRowDoc, keyOf(kind, value), context);
			if (stored?.value == null || stored.pendingPage === null) continue;
			if (kind === "intent") result.intents.push(copy(stored.value as DeliveryIntent));
			else if (kind === "receipt") result.receipts[String((stored.value as DeliveryReceipt).submissionId)] = copy(stored.value as DeliveryReceipt);
			else result.reports.push(copy(stored.value as DeliveryReport));
		}
	}
	return result;
}
export function receiptSourceIdentity(storageId: string, receipt: Pick<DeliveryReceipt, "answerEntryId" | "submissionId" | "ownerId">): string {
	const answer = receipt.answerEntryId === null ? ["unanswered", receipt.submissionId] : ["answer", receipt.answerEntryId];
	return `${storageId}:result:${createHash("sha256").update(JSON.stringify([storageId, answer, receipt.ownerId])).digest("hex")}`;
}
export function receiptDeliveryRequestId(storageId: string, receipt: Pick<DeliveryReceipt, "answerEntryId" | "submissionId" | "ownerId">): string {
	return `deliver:${receiptSourceIdentity(storageId, receipt)}`;
}

type ReceiptCursorValue = { storageId: string; recipient: string; selectedSubmissionId: number; answerEntryId: number; pageId: string; offset: number; endPageId: string; endOffset: number };
const cursorFields = ["storageId", "recipient", "selectedSubmissionId", "answerEntryId", "pageId", "offset", "endPageId", "endOffset"];
function decodeReceiptCursor(cursor: string): ReceiptCursorValue {
	if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error("Invalid receipt cursor");
	try {
		const bytes = Buffer.from(cursor, "base64url");
		if (bytes.toString("base64url") !== cursor) throw new Error();
		const value = JSON.parse(bytes.toString("utf8")) as ReceiptCursorValue;
		if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== cursorFields.length || !cursorFields.every((key) => Object.hasOwn(value, key))) throw new Error();
		if (typeof value.storageId !== "string" || typeof value.recipient !== "string" || typeof value.pageId !== "string" || typeof value.endPageId !== "string" || !/^[1-9][0-9]*$/u.test(value.pageId) || !/^[1-9][0-9]*$/u.test(value.endPageId)) throw new Error();
		if (![value.selectedSubmissionId, value.answerEntryId, Number(value.pageId), Number(value.endPageId)].every((number) => Number.isSafeInteger(number) && number > 0) || ![value.offset, value.endOffset].every((number) => Number.isSafeInteger(number) && number >= 0 && number <= DELIVERY_PAGE_SIZE)) throw new Error();
		return value;
	} catch { throw new Error("Invalid receipt cursor"); }
}
function encodeReceiptCursor(value: ReceiptCursorValue): string {
	const cursor = Buffer.from(JSON.stringify(value)).toString("base64url");
	if (cursor.length > 2048) throw new Error("Receipt cursor exceeds its bound");
	return cursor;
}
function validateAnswerPage(page: Page, answerEntryId: number): void {
	requirePageOwner(page, `answer:${answerEntryId}`);
	if (page.refs.length < 1 || page.refs.length > DELIVERY_PAGE_SIZE) throw new Error("Receipt cursor page is absent or invalid");
}

/** One answer-list page, filtered to the selected recipient, with a frozen append-only tail. */
function receiptReference(storageId: string, receipt: DeliveryReceipt) { return { sessionId: canonicalIdentity(storageId, receipt.conversationId), submissionId: receipt.submissionId, requestId: receipt.requestId }; }
type ReceiptRange = { position: ReceiptCursorValue; page: Page; limit: number };
function selectedCursor(cursor: string | undefined, storageId: string, selected: DeliveryReceipt): ReceiptCursorValue | undefined {
	if (cursor === undefined) return undefined;
	const value = decodeReceiptCursor(cursor);
	if (value.storageId !== storageId || value.recipient !== selected.ownerId || value.selectedSubmissionId !== selected.submissionId || value.answerEntryId !== selected.answerEntryId) throw new Error("Receipt cursor disagrees with the selected result or recipient");
	return value;
}
async function receiptEnd(tx: Tx, tail: string, answerEntryId: number, captured?: ReceiptCursorValue) {
	const endPageId = captured?.endPageId ?? tail;
	const end = await pageAt(tx, endPageId);
	validateAnswerPage(end, answerEntryId);
	const endOffset = captured?.endOffset ?? end.refs.length;
	if (endOffset < 1 || endOffset > end.refs.length) throw new Error("Receipt cursor terminal boundary changed or is invalid");
	return { endPageId, endOffset, end };
}
async function receiptRange(tx: Tx, storageId: string, selected: DeliveryReceipt, answerEntryId: number, cursor?: string): Promise<ReceiptRange> {
	const list = await tx.doc(DeliveryListDoc, `answer:${answerEntryId}`, null);
	if (list.head === null || list.tail === null) throw new Error("Selected answer has no receipt list");
	const captured = selectedCursor(cursor, storageId, selected);
	const { endPageId, endOffset, end } = await receiptEnd(tx, list.tail, answerEntryId, captured);
	const pageId = captured?.pageId ?? list.head;
	const page = pageId === endPageId ? end : await pageAt(tx, pageId);
	if (pageId !== endPageId) validateAnswerPage(page, answerEntryId);
	const offset = captured?.offset ?? 0;
	const limit = pageId === endPageId ? endOffset : page.refs.length;
	if (Number(pageId) > Number(endPageId) || offset >= limit || (pageId !== endPageId && page.next === null)) throw new Error("Receipt cursor offset or page is outside its captured range");
	return { page, limit, position: { storageId, recipient: selected.ownerId, selectedSubmissionId: selected.submissionId, answerEntryId, pageId, offset, endPageId, endOffset } };
}
async function readReceiptRange(tx: Tx, range: ReceiptRange) {
	const results: ReceiptReferencePage["results"] = [];
	const { position, page, limit } = range;
	let offset = position.offset;
	while (offset < limit && results.length < 16) {
		const key = page.refs[offset++];
		const stored = await tx.doc(DeliveryRowDoc, key, "receipt");
		const receipt = stored.value as DeliveryReceipt | null;
		if (stored.kind !== "receipt" || receipt === null || receipt.answerEntryId !== position.answerEntryId || keyOf("receipt", receipt) !== key) throw new Error("Receipt group reference is invalid");
		if (receipt.ownerId === position.recipient) results.push(receiptReference(position.storageId, receipt));
	}
	return { results, offset };
}
function receiptNext(range: ReceiptRange, offset: number): string | null {
	const { position, page } = range;
	if (position.pageId === position.endPageId && offset === position.endOffset) return null;
	const nextPage = offset === page.refs.length ? page.next : position.pageId;
	if (nextPage === null) throw new Error("Receipt group ended before its captured tail");
	return encodeReceiptCursor({ ...position, pageId: nextPage, offset: nextPage === position.pageId ? offset : 0 });
}
export async function receiptReferencePage(tx: Tx, storageId: string, selected: DeliveryReceipt, cursor?: string): Promise<ReceiptReferencePage> {
	if (selected.answerEntryId === null) {
		if (cursor !== undefined) throw new Error("An unanswered input has no receipt cursor");
		return { recipient: selected.ownerId, results: [receiptReference(storageId, selected)], complete: true, next: null };
	}
	const range = await receiptRange(tx, storageId, selected, selected.answerEntryId, cursor);
	const { results, offset } = await readReceiptRange(tx, range);
	const next = receiptNext(range, offset);
	return { recipient: selected.ownerId, results, complete: next === null, next };
}

export async function answerReceipts(tx: Tx, receipt: DeliveryReceipt): Promise<DeliveryReceipt[]> {
	if (receipt.answerEntryId === null) return [receipt];
	const rows: DeliveryReceipt[] = [];
	for (const key of await listReferences(tx, `answer:${receipt.answerEntryId}`)) {
		const row = await tx.doc(DeliveryRowDoc, key, "receipt");
		if (row.value !== null) rows.push(copy(row.value as DeliveryReceipt));
	}
	return rows;
}
export async function operationReceipts(harness: Harness, operationId: string, context: Context): Promise<DeliveryReceipt[]> {
	if (await harness.snapshot(DeliveryListDoc, `operation:${operationId}`, context) === undefined) return [];
	return harness.commit(async (tx) => {
		const rows: DeliveryReceipt[] = [];
		for (const key of await listReferences(tx, `operation:${operationId}`)) {
			const row = await tx.doc(DeliveryRowDoc, key, "receipt");
			if (row.value !== null) rows.push(copy(row.value as DeliveryReceipt));
		}
		return rows;
	}, context);
}

function migrationRowPending(kind: Kind, value: Row, receipts: Readonly<AgentDeliveryState["receipts"]> | undefined): boolean {
	if (kind !== "intent") return !(value as DeliveryReceipt | DeliveryReport).acknowledged;
	const intent = value as DeliveryIntent;
	return intent.submissionId === null || receipts?.[String(intent.submissionId)] === undefined;
}

async function copyMigrationPage(tx: Tx, state: StoreState, groups: readonly (readonly Row[])[], receipts: Readonly<AgentDeliveryState["receipts"]> | undefined): Promise<void> {
	let left = DELIVERY_PAGE_SIZE;
	while (state.migrationKind < 3 && left > 0) {
		const group = groups[state.migrationKind];
		if (state.migrationOffset === group.length) {
			state.migrationKind += 1;
			state.migrationOffset = 0;
			continue;
		}
		const kind = (["intent", "receipt", "report"] as const)[state.migrationKind];
		const value = group[state.migrationOffset];
		const retained = await storeDeliveryRow(tx, kind, value, true, migrationRowPending(kind, value, receipts));
		if (JSON.stringify(retained) !== JSON.stringify(value)) throw new Error("Delivery migration payload differs");
		state.migrationOffset += 1;
		left -= 1;
	}
}

async function validateMigrationCounts(tx: Tx, groups: readonly (readonly Row[])[]): Promise<void> {
	for (const [index, kind] of (["intent", "receipt", "report"] as const).entries()) {
		const list = await tx.doc(DeliveryListDoc, `all:${kind}`, null);
		if (list.count !== groups[index].length) throw new Error("Delivery migration row count differs");
	}
}

/** Owner-less page shape of earlier releases; only the page adoption below reads it. */
const DeliveryPageV1Doc = defineDocFamily<{ refs: string[]; previous: string | null; next: string | null }, null>({ kind: "agent.delivery-page", version: 1, scope: "session", family: true, initial: () => ({ refs: [], previous: null, next: null }), checkpointWhen: () => true });
const SESSION_SCOPE = { kind: "session" } as const;

export type DeliveryPageAdoption = {
	/** Version 1 pages that this call gave their owner list. */
	adopted: number;
	/** Reachable pages that already carried their owner list. */
	current: number;
	/** Current version 1 pages that no list reaches; they stay unchanged. */
	unreached: string[];
	/** Live `agent.reporter` tasks of version 1; Pi blocks them, and the adoption leaves them unchanged. */
	activeReporterTasks: number[];
};

async function scanKeys(storage: StorageReader, kind: string, context: Context): Promise<string[]> {
	const keys: string[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanDocuments({ scope: SESSION_SCOPE, at: "current", kind }, 256, cursor, context);
		for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
		cursor = page.next ?? undefined;
	} while (cursor !== undefined);
	return keys;
}

async function storedPage(storage: StorageReader, id: string, context: Context) {
	const record = await storage.findDocument({ kind: DeliveryPageDoc.definition.kind, scope: SESSION_SCOPE, key: id }, "current", context);
	return record === undefined ? undefined : storage.document(record.id, "current", context);
}

/** Each reachable version 1 page with its owner list, from one enumeration of the current lists. */
async function ownerlessPages(storage: StorageReader, context: Context): Promise<{ owned: Map<string, string>; current: number }> {
	const owned = new Map<string, string>();
	const seen = new Set<string>();
	let current = 0;
	for (const name of await scanKeys(storage, "agent.delivery-list", context)) current += await walkList(storage, name, seen, owned, context);
	return { owned, current };
}

/** Record the version 1 pages of one list; returns its count of pages that already name it. */
async function walkList(storage: StorageReader, name: string, seen: Set<string>, owned: Map<string, string>, context: Context): Promise<number> {
	const list = await storage.findDocument({ kind: "agent.delivery-list", scope: SESSION_SCOPE, key: name }, "current", context);
	let id = list === undefined ? null : ((await storage.document(list.id, "current", context))?.value as List | undefined)?.head ?? null;
	let current = 0;
	while (id !== null) {
		if (seen.has(id)) throw new Error(`Delivery reference page ${id} belongs to more than one list or forms a cycle`);
		seen.add(id);
		const stored = await storedPage(storage, id, context);
		if (stored === undefined) throw new Error(`Delivery list ${name} names an absent page ${id}`);
		if (stored.version === 1) owned.set(id, name);
		else {
			requirePageOwner(stored.value as Page, name);
			current += 1;
		}
		id = (stored.value as { next: string | null }).next;
	}
	return current;
}

/** Live `agent.reporter` tasks of version 1, read from the stored task records without loading the scheduler. */
async function activeReporterTasks(storage: StorageReader, context: Context): Promise<number[]> {
	const ids: number[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanTasks({ kind: "agent.reporter" }, 256, cursor, context);
		for (const task of page.items) if (task.version === 1 && task.state.status !== "terminal") ids.push(task.id);
		cursor = page.next ?? undefined;
	} while (cursor !== undefined);
	return ids;
}

/**
 * Give every retained version 1 reference page its owner list, so a store written by an earlier release accepts
 * appends and owner-checked reads again. An explicit call of the storage owner runs it; opening a store does not.
 * One commit replaces every reachable version 1 page: its incarnation is retired and stays in Pi history, and a
 * version 2 incarnation at the same address keeps its references and links. Rows, pointers and lists are not
 * rewritten. An interruption therefore leaves the store wholly unadopted or wholly adopted; a call on an adopted
 * store changes nothing. The commit needs only a Session: a plain Session over the storage runs no task scheduler,
 * so task records stay as stored. Live version 1 Reporter tasks are reported, never changed.
 */
export async function adoptDeliveryPages(session: Pick<Session, "commit">, storage: StorageReader, context: Context): Promise<DeliveryPageAdoption> {
	const { owned, current } = await ownerlessPages(storage, context);
	const unreached: string[] = [];
	for (const id of await scanKeys(storage, DeliveryPageDoc.definition.kind, context)) {
		if (owned.has(id)) continue;
		if ((await storedPage(storage, id, context))?.version === 1) unreached.push(id);
	}
	if (owned.size > 0) await session.commit(async (tx) => {
		for (const [id, name] of owned) {
			const old = copy(await tx.doc(DeliveryPageV1Doc, id, null));
			await tx.retireDoc(DeliveryPageV1Doc, id);
			const page = await tx.doc(DeliveryPageDoc, id, null);
			page.ownerList = name;
			page.refs.push(...old.refs);
			page.previous = old.previous;
			page.next = old.next;
		}
	}, context);
	return { adopted: owned.size, current, unreached, activeReporterTasks: await activeReporterTasks(storage, context) };
}

/** Copy one bounded batch with its cursor. The original document remains authoritative until completion. */
export async function migrateDeliveryStore(harness: Pick<Session, "snapshot" | "commit">, context: Context, afterBatch?: () => void | Promise<void>): Promise<void> {
	if ((await harness.snapshot(DeliveryStoreDoc, context))?.ready) return;
	const archive = await harness.snapshot(DeliveryArchiveDoc, context);
	const groups: readonly (readonly Row[])[] = archive ? [archive.intents, Object.values(archive.receipts), archive.reports] : [[], [], []];
	for (;;) {
		const done = await harness.commit(async (tx) => {
			const state = await tx.doc(DeliveryStoreDoc);
			if (state.ready) return true;
			await copyMigrationPage(tx, state, groups, archive?.receipts);
			if (state.migrationKind !== 3) return false;
			// All bounded copies and their cursor committed before this final validation.
			await validateMigrationCounts(tx, groups);
			state.ready = true;
			if (archive) await tx.retireDoc(DeliveryArchiveDoc);
			return true;
		}, context);
		await afterBatch?.();
		if (done) return;
	}
}
