import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import {
	type Cell,
	COUNTERS,
	dayNumber,
	inWindow,
	type Snapshot,
	slotFor,
	validateCell,
	validateShard,
	zero,
} from "./capacity.ts";

export const PAGE_ROWS = 24;
export const MAX_ROWS = 61_500;
export const MAX_BYTES = 64 * 1024 * 1024;
export const PAGE_BYTES = 32_768;
export const TTL_MS = 600_000;
const HEAP_WORK_BYTES = 192 * 1024 * 1024;
const HEAP_RESERVE_BYTES = 128 * 1024 * 1024;
export const JOINT_KEYS = [
	"day",
	"observationStage",
	"resourceClass",
	"resourceId",
	"model",
	"reasoning",
	"referenceBodyDigest",
	"observerVersion",
	"piVersion",
] as const;
export const MEANING = Object.freeze({
	countedUnit: "observed_read_event_not_session_application_or_effectiveness",
	observation:
		"Request and result callbacks are independent observations. Result callbacks do not establish final provider delivery.",
	bodyIdentity:
		"Verified means complete returned bytes matched the reference bytes at observation. It does not establish semantic correctness, adherence, application, or effectiveness.",
	cause:
		"Tool-result errors and checkpoint-write failures are different observations. These counts do not identify inaccessible files, collector crashes, lost-read counts, or any causal link between those observations.",
	coverage:
		"Only retained persisted aggregates are described. Absent observers, refused admissions, unflushed tails, and failures unable to persist remain unknown, even when all recorded counters are zero.",
	healthScope:
		"Storage incidents cover detection days in all retained shards, not the selected read-event window and not live collector health. Receipt quota days count marked days, not refused observers or lost events.",
	absentRows:
		"An absent joint row means zero attributed events in this retained capture only. Folded dimensions do not establish zero for a concrete identity.",
});
export const TOOL_DESCRIPTION =
	'Read retained Pillars access evidence, not application or effectiveness. Omit arguments for a 30-UTC-day resource overview. Use view:"revisions" for all joint day/resource/reference-digest/model/reasoning/stage/version rows, without per-resource queries. windowDays selects 1–30 trailing days. Follow nextCursor with cursor alone to finish a frozen view. Counts and storage incidents do not diagnose causes or establish live coverage.';
export type ErrorCode =
	| "store_unreadable"
	| "store_corrupt"
	| "cursor_expired"
	| "cursor_invalid"
	| "response_overflow";
const MESSAGES: Record<ErrorCode, string> = {
	store_unreadable: "The retained aggregate store is unreadable.",
	store_corrupt: "The retained aggregate store is invalid.",
	cursor_expired: "The frozen capture expired or was replaced.",
	cursor_invalid: "The continuation cursor is invalid.",
	response_overflow: "The bounded capture exceeded its row, byte, or memory limit.",
};
export function errorResponse(code: ErrorCode) {
	return {
		schema: "pillars-usage-response" as const,
		schemaVersion: 2 as const,
		kind: "error" as const,
		meaning: MEANING,
		code,
		retryable: code !== "store_corrupt",
		message: MESSAGES[code],
	};
}
export type ErrorResponse = ReturnType<typeof errorResponse>;
type Counters = Cell["counters"];
export interface ResourceRow {
	resourceClass: Cell["resourceClass"];
	resourceId: string;
	lastSeenDay: string;
	counters: Counters;
}
export interface Header {
	schema: "pillars-usage-response";
	schemaVersion: 2;
	enabled: boolean;
	window: { fromDay: string; toDay: string; requestedDays: number; retentionDays: 30 };
	meaning: typeof MEANING;
	coverage: {
		retainedDayShards: number;
		liveCollectors: "unknown";
		wholeWindowCoverage: "unknown";
		unpersistedLoss: "unknown";
		dataState: "retained_aggregates" | "no_persisted_aggregate";
		captureScope: "validated_retained_shards_not_live_observer_census";
		captureOmissions: string[];
	};
	storageEvidence: {
		scope: "retained_shard_detection_days_not_selected_event_window";
		assessment: "no_recorded_evidence" | "recorded_incidents" | "no_incidents_recorded";
		checkpointWriteFailures: number;
		foldedEvents: number;
		receiptQuotaDays: number;
		unresolvedAccessEvents: number;
		forkResets: number;
		forkDroppedEvents: number;
		pendingDroppedEvents: number;
	};
	totals: Counters;
	summary: { foldedResourceIdentities: number; revisionRows: number; revisionView: "revisions" };
}
export interface Pagination {
	pageNumber: number;
	pageCount: number;
	totalRows: number;
	nextCursor?: string;
	cursorExpiresAt?: string;
}
export type Page = Header & { kind: "page"; pagination: Pagination } & (
		| { view: "overview"; byResource: ResourceRow[] }
		| { view: "revisions"; rows: Cell[] }
	);
export type Response = Page | ErrorResponse;
export type ExportDocument = Omit<Header, "schema"> & { schema: "pillars-export"; rows: Cell[] };
export type Request = { cursor: string } | { view: "overview" | "revisions"; windowDays: number };

type Schema = {
	oneOf?: Schema[];
	const?: unknown;
	enum?: unknown[];
	type?: string;
	properties?: Record<string, Schema>;
	required?: string[];
	additionalProperties?: boolean;
	items?: Schema;
	maxItems?: number;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};
const loadSchema = (name: string): Schema =>
	JSON.parse(readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url), "utf8"));
export const requestSchema = loadSchema("request");
const responseSchema = loadSchema("response");
const exportSchema = loadSchema("export");
function object(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		[Object.prototype, null].includes(Object.getPrototypeOf(value))
	);
}
function shape(schema: Schema, value: unknown): boolean {
	if (schema.oneOf) return schema.oneOf.filter((branch) => shape(branch, value)).length === 1;
	if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
	if (schema.enum && !schema.enum.includes(value)) return false;
	if (schema.type === "object") {
		if (!object(value)) return false;
		if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
		return Object.entries(value).every(([key, field]) =>
			schema.properties?.[key] ? shape(schema.properties[key], field) : schema.additionalProperties !== false,
		);
	}
	if (schema.type === "array")
		return (
			Array.isArray(value) &&
			(schema.maxItems === undefined || value.length <= schema.maxItems) &&
			value.every((item) => !schema.items || shape(schema.items, item))
		);
	if (schema.type === "integer")
		return (
			Number.isSafeInteger(value) &&
			(schema.minimum === undefined || (value as number) >= schema.minimum) &&
			(schema.maximum === undefined || (value as number) <= schema.maximum)
		);
	if (schema.type === "boolean") return typeof value === "boolean";
	if (schema.type === "string")
		return (
			typeof value === "string" &&
			(schema.minLength === undefined || value.length >= schema.minLength) &&
			(schema.maxLength === undefined || value.length <= schema.maxLength) &&
			(!schema.pattern || new RegExp(schema.pattern).test(value))
		);
	return true;
}
export function parseRequest(input: unknown = {}): Request {
	if (!shape(requestSchema, input)) throw new Error("invalid_input");
	const request = input as Partial<Request> & { view?: "overview" | "revisions"; windowDays?: number };
	return "cursor" in request
		? { cursor: request.cursor! }
		: { view: request.view ?? "overview", windowDays: request.windowDays ?? 30 };
}
function add(a: number, b: number): number {
	const value = a + b;
	if (!Number.isSafeInteger(value)) throw new Error("response_overflow");
	return value;
}
export function sum(rows: readonly { counters: Counters }[]): Counters {
	const result = zero();
	for (const row of rows) for (const counter of COUNTERS) result[counter] = add(result[counter], row.counters[counter]);
	return result;
}
const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const resourceOrder = (a: ResourceRow, b: ResourceRow) =>
	Number(a.resourceClass === "overflow") - Number(b.resourceClass === "overflow") ||
	b.counters.readRequests - a.counters.readRequests ||
	ordinal(a.resourceClass, b.resourceClass) ||
	ordinal(a.resourceId, b.resourceId);
const order = (a: Cell, b: Cell) =>
	ordinal(b.day, a.day) || JOINT_KEYS.slice(1).reduce((result, key) => result || ordinal(a[key], b[key]), 0);
function memoryGuard(start: number): void {
	const used = process.memoryUsage().heapUsed;
	if (used - start > HEAP_WORK_BYTES || getHeapStatistics().heap_size_limit - used < HEAP_RESERVE_BYTES)
		throw new Error("response_overflow");
}
function resourceRows(rows: readonly Cell[], memoryStart: number) {
	const map = new Map<string, ResourceRow>();
	for (const row of rows) {
		if (map.size % 2048 === 0) memoryGuard(memoryStart);
		const key = `${row.resourceClass}:${row.resourceId}`;
		const previous = map.get(key);
		if (previous) {
			previous.counters = sum([previous, row]);
			if (row.day > previous.lastSeenDay) previous.lastSeenDay = row.day;
		} else
			map.set(key, {
				resourceClass: row.resourceClass,
				resourceId: row.resourceId,
				lastSeenDay: row.day,
				counters: { ...row.counters },
			});
	}
	const concrete = [...map.values()].filter((row) => row.resourceClass !== "overflow").sort(resourceOrder);
	const selected = concrete.slice(0, 63),
		folded = concrete.slice(63);
	const overflow = map.get("overflow:overflow");
	if (overflow) folded.push(overflow);
	if (folded.length)
		selected.push({
			resourceClass: "overflow",
			resourceId: "overflow",
			lastSeenDay: folded.reduce((day, row) => (row.lastSeenDay > day ? row.lastSeenDay : day), ""),
			counters: sum(folded),
		});
	return { rows: selected, foldedResourceIdentities: Math.max(0, concrete.length - 63) };
}
function project(snapshot: Snapshot, today: string, windowDays: number, enabled: boolean, memoryStart: number) {
	dayNumber(today);
	if (
		!object(snapshot) ||
		Object.keys(snapshot).length !== 1 ||
		!object(snapshot.shards) ||
		Object.keys(snapshot.shards).length > 30
	)
		throw new Error("store_corrupt");
	const fromDay = new Date(Date.parse(`${today}T00:00:00Z`) - (windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
	const rows: Cell[] = [];
	const slots = new Set<string>();
	let shardCount = 0,
		sourceBytes = 0;
	const health = {
		checkpointWriteFailures: 0,
		foldedEvents: 0,
		receiptQuotaDays: 0,
		unresolvedAccessEvents: 0,
		forkResets: 0,
		forkDroppedEvents: 0,
		pendingDroppedEvents: 0,
	};
	for (const [name, shard] of Object.entries(snapshot.shards)) {
		validateShard(shard);
		if (name !== shard.day || shard.retentionThroughDay > today || shard.day > today || slots.has(slotFor(shard.day)))
			throw new Error("store_corrupt");
		slots.add(slotFor(shard.day));
		sourceBytes += Buffer.byteLength(JSON.stringify(shard));
		if (sourceBytes > 60 * 1024 * 1024) throw new Error("response_overflow");
		if (!inWindow(shard.day, today)) continue;
		shardCount++;
		health.checkpointWriteFailures = add(health.checkpointWriteFailures, shard.health.writeFailures);
		health.foldedEvents = add(health.foldedEvents, shard.health.cellsOverflowedEvents);
		health.receiptQuotaDays += Number(shard.health.receiptQuotaReached);
		for (const key of ["unresolvedAccessEvents", "forkResets", "forkDroppedEvents", "pendingDroppedEvents"] as const)
			health[key] = add(health[key], shard.health[key]);
		if (shard.day >= fromDay) rows.push(...shard.cells);
		if (rows.length > MAX_ROWS) throw new Error("response_overflow");
		memoryGuard(memoryStart);
	}
	rows.sort(order);
	const resource = resourceRows(rows, memoryStart);
	const omissions: string[] = [];
	if (health.checkpointWriteFailures) omissions.push("checkpoint_write_failures_recorded");
	if (health.foldedEvents) omissions.push("dimensions_folded");
	if (health.receiptQuotaDays) omissions.push("receipt_quota_days_recorded");
	if (health.unresolvedAccessEvents) omissions.push("source_unresolved");
	if (health.forkDroppedEvents || health.pendingDroppedEvents) omissions.push("pending_events_dropped");
	const header: Header = {
		schema: "pillars-usage-response",
		schemaVersion: 2,
		enabled,
		window: { fromDay, toDay: today, requestedDays: windowDays, retentionDays: 30 },
		meaning: MEANING,
		coverage: {
			retainedDayShards: shardCount,
			liveCollectors: "unknown",
			wholeWindowCoverage: "unknown",
			unpersistedLoss: "unknown",
			dataState: shardCount ? "retained_aggregates" : "no_persisted_aggregate",
			captureScope: "validated_retained_shards_not_live_observer_census",
			captureOmissions: omissions,
		},
		storageEvidence: {
			scope: "retained_shard_detection_days_not_selected_event_window",
			assessment: !shardCount
				? "no_recorded_evidence"
				: Object.values(health).some(Boolean)
					? "recorded_incidents"
					: "no_incidents_recorded",
			...health,
		},
		totals: sum(rows),
		summary: {
			foldedResourceIdentities: resource.foldedResourceIdentities,
			revisionRows: rows.length,
			revisionView: "revisions",
		},
	};
	memoryGuard(memoryStart);
	return { header, rows, resources: resource.rows };
}
function validateHeader(value: Header | ExportDocument): void {
	dayNumber(value.window.fromDay);
	dayNumber(value.window.toDay);
	if (dayNumber(value.window.toDay) - dayNumber(value.window.fromDay) !== value.window.requestedDays - 1)
		throw new Error("invalid_response");
	if ((value.coverage.retainedDayShards === 0) !== (value.coverage.dataState === "no_persisted_aggregate"))
		throw new Error("invalid_response");
	const h = value.storageEvidence;
	const incidents = [
		h.checkpointWriteFailures,
		h.foldedEvents,
		h.receiptQuotaDays,
		h.unresolvedAccessEvents,
		h.forkResets,
		h.forkDroppedEvents,
		h.pendingDroppedEvents,
	].some(Boolean);
	const assessment =
		value.coverage.retainedDayShards === 0
			? "no_recorded_evidence"
			: incidents
				? "recorded_incidents"
				: "no_incidents_recorded";
	if (
		h.assessment !== assessment ||
		(!value.coverage.retainedDayShards && incidents) ||
		h.receiptQuotaDays > value.coverage.retainedDayShards
	)
		throw new Error("invalid_response");
	const omissions = [
		h.checkpointWriteFailures ? "checkpoint_write_failures_recorded" : "",
		h.foldedEvents ? "dimensions_folded" : "",
		h.receiptQuotaDays ? "receipt_quota_days_recorded" : "",
		h.unresolvedAccessEvents ? "source_unresolved" : "",
		h.forkDroppedEvents || h.pendingDroppedEvents ? "pending_events_dropped" : "",
	].filter(Boolean);
	if (
		JSON.stringify(omissions) !== JSON.stringify(value.coverage.captureOmissions) ||
		(!value.coverage.retainedDayShards && value.summary.revisionRows !== 0) ||
		(!value.summary.revisionRows && COUNTERS.some((key) => value.totals[key] !== 0)) ||
		value.summary.foldedResourceIdentities > Math.max(0, value.summary.revisionRows - 63)
	)
		throw new Error("invalid_response");
	validatePartitions(value.totals);
}
function validatePartitions(c: Counters): void {
	if (
		add(add(c.resultComplete, c.resultPartial), add(c.resultError, c.resultUnknown)) !== c.readResults ||
		add(add(c.bodyVerifiedAtObservation, c.bodyMismatchedAtObservation), c.bodyUnverifiable) !== c.readResults ||
		add(c.bodyVerifiedAtObservation, c.bodyMismatchedAtObservation) > c.resultComplete
	)
		throw new Error("invalid_response");
}
export function validateResponse(value: unknown): asserts value is Response {
	if (!shape(responseSchema, value)) throw new Error("invalid_response");
	const response = value as Response;
	if (response.kind === "error") {
		if (response.message !== MESSAGES[response.code] || response.retryable !== (response.code !== "store_corrupt"))
			throw new Error("invalid_response");
	} else {
		validateHeader(response);
		const p = response.pagination,
			rows = response.view === "overview" ? response.byResource : response.rows;
		if (
			p.pageCount !== Math.max(1, Math.ceil(p.totalRows / PAGE_ROWS)) ||
			p.pageNumber > p.pageCount ||
			rows.length !== Math.min(PAGE_ROWS, Math.max(0, p.totalRows - (p.pageNumber - 1) * PAGE_ROWS)) ||
			p.pageNumber < p.pageCount !== (p.nextCursor !== undefined && p.cursorExpiresAt !== undefined)
		)
			throw new Error("invalid_response");
		if (p.pageNumber === p.pageCount && (p.nextCursor !== undefined || p.cursorExpiresAt !== undefined))
			throw new Error("invalid_response");
		if (p.cursorExpiresAt) {
			const expires = Date.parse(p.cursorExpiresAt);
			if (!Number.isFinite(expires) || new Date(expires).toISOString() !== p.cursorExpiresAt)
				throw new Error("invalid_response");
		}
		const pageTotals = sum(rows);
		if (
			COUNTERS.some(
				(key) =>
					pageTotals[key] > response.totals[key] || (p.pageCount === 1 && pageTotals[key] !== response.totals[key]),
			)
		)
			throw new Error("invalid_response");
		if (response.view === "revisions") {
			if (response.summary.revisionRows !== p.totalRows) throw new Error("invalid_response");
			for (let i = 0; i < response.rows.length; i++) {
				const row = response.rows[i];
				validateCell(row, row.day);
				if (
					row.day < response.window.fromDay ||
					row.day > response.window.toDay ||
					(i > 0 && order(response.rows[i - 1], row) >= 0)
				)
					throw new Error("invalid_response");
			}
		} else {
			if (p.totalRows > 64 || p.totalRows > response.summary.revisionRows) throw new Error("invalid_response");
			const identities = new Set<string>();
			for (const [index, row] of response.byResource.entries()) {
				dayNumber(row.lastSeenDay);
				validatePartitions(row.counters);
				if (
					row.lastSeenDay < response.window.fromDay ||
					row.lastSeenDay > response.window.toDay ||
					(row.resourceClass !== "entry" && row.resourceId !== row.resourceClass) ||
					identities.has(`${row.resourceClass}:${row.resourceId}`) ||
					(index > 0 && resourceOrder(response.byResource[index - 1], row) >= 0) ||
					(row.resourceClass === "overflow" && (index !== rows.length - 1 || p.pageNumber !== p.pageCount))
				)
					throw new Error("invalid_response");
				identities.add(`${row.resourceClass}:${row.resourceId}`);
			}
		}
	}
	if (Buffer.byteLength(JSON.stringify(value)) > PAGE_BYTES) throw new Error("response_overflow");
}
export function validateExport(value: unknown): asserts value is ExportDocument {
	if (!shape(exportSchema, value)) throw new Error("invalid_export");
	const doc = value as ExportDocument;
	validateHeader(doc);
	const totals = sum(doc.rows);
	if (doc.summary.revisionRows !== doc.rows.length || COUNTERS.some((key) => totals[key] !== doc.totals[key]))
		throw new Error("invalid_export");
	let previous: Cell | undefined;
	for (const row of doc.rows) {
		validateCell(row, row.day);
		if (row.day < doc.window.fromDay || row.day > doc.window.toDay || (previous && order(previous, row) >= 0))
			throw new Error("invalid_export");
		previous = row;
	}
}
interface Capture {
	key: string;
	expires: number;
	view: "overview" | "revisions";
	header: Header;
	rows: string[];
}
export interface ReaderOptions {
	now?: () => number;
	enabled?: () => boolean;
}
export function createReader(
	getSnapshot: (signal?: AbortSignal) => Snapshot | Promise<Snapshot>,
	options: ReaderOptions = {},
) {
	const now = options.now ?? Date.now;
	let capture: Capture | undefined;
	const retired = new Set<string>();
	let generation = 0;
	function clear() {
		generation++;
		if (capture) {
			retired.add(capture.key);
			if (retired.size > 8) retired.delete(retired.values().next().value!);
			capture = undefined;
		}
	}
	function page(index: number): Response {
		if (!capture || index < 0 || index >= Math.max(1, Math.ceil(capture.rows.length / PAGE_ROWS)))
			return errorResponse("cursor_invalid");
		const { header, rows, view, key, expires } = capture;
		const pagination: Pagination = {
			pageNumber: index + 1,
			pageCount: Math.max(1, Math.ceil(rows.length / PAGE_ROWS)),
			totalRows: rows.length,
		};
		if (pagination.pageNumber < pagination.pageCount) {
			pagination.nextCursor = Buffer.from(`${key}:${index + 1}`).toString("base64url");
			pagination.cursorExpiresAt = new Date(expires).toISOString();
		}
		const parsed = rows.slice(index * PAGE_ROWS, (index + 1) * PAGE_ROWS).map((row) => JSON.parse(row));
		const result: Page = {
			...structuredClone(header),
			kind: "page",
			pagination,
			...(view === "overview" ? { view, byResource: parsed } : { view, rows: parsed }),
		};
		validateResponse(result);
		return result;
	}
	async function fresh(windowDays: number, signal?: AbortSignal) {
		const start = process.memoryUsage().heapUsed;
		memoryGuard(start);
		signal?.throwIfAborted();
		const snapshot = await getSnapshot(signal);
		signal?.throwIfAborted();
		memoryGuard(start);
		return project(
			snapshot,
			new Date(now()).toISOString().slice(0, 10),
			windowDays,
			options.enabled?.() ?? true,
			start,
		);
	}
	function failure(error: unknown): ErrorResponse {
		const code = error instanceof Error ? error.message : "";
		return errorResponse(
			code === "response_overflow"
				? code
				: code === "store_corrupt" ||
						code === "counter_saturated" ||
						code === "clock_rollback" ||
						code.startsWith("invalid_")
					? "store_corrupt"
					: "store_unreadable",
		);
	}
	return {
		clear,
		async read(input: unknown = {}, signal?: AbortSignal): Promise<Response> {
			const request = parseRequest(input);
			if ("cursor" in request) {
				const decoded = Buffer.from(request.cursor, "base64url").toString("utf8"),
					match = /^([-_A-Za-z0-9]{22}):(0|[1-9]\d{0,5})$/.exec(decoded);
				if (!match || Buffer.from(decoded).toString("base64url") !== request.cursor)
					return errorResponse("cursor_invalid");
				if (capture && now() >= capture.expires) clear();
				if (!capture || capture.key !== match[1])
					return errorResponse(retired.has(match[1]) ? "cursor_expired" : "cursor_invalid");
				try {
					return page(Number(match[2]));
				} catch (error) {
					return failure(error);
				}
			}
			clear();
			const current = generation;
			const created = now();
			const memoryStart = process.memoryUsage().heapUsed;
			try {
				const projected = await fresh(request.windowDays, signal);
				if (generation !== current) return errorResponse("cursor_expired");
				const selected = request.view === "overview" ? projected.resources : projected.rows;
				let bytes = Buffer.byteLength(JSON.stringify(projected.header)) + 32;
				const rows: string[] = [];
				for (const row of selected) {
					const text = JSON.stringify(row);
					bytes += Buffer.byteLength(text) + 1;
					if (bytes > MAX_BYTES) throw new Error("response_overflow");
					rows.push(text);
					if (rows.length % 2048 === 0) memoryGuard(memoryStart);
				}
				memoryGuard(memoryStart);
				capture = {
					header: projected.header,
					rows,
					view: request.view,
					key: randomBytes(16).toString("base64url"),
					expires: created + TTL_MS,
				};
				if (now() >= capture.expires) {
					clear();
					return errorResponse("cursor_expired");
				}
				return page(0);
			} catch (error) {
				return failure(error);
			}
		},
		async exportCapture(windowDays = 30, signal?: AbortSignal): Promise<ExportDocument | ErrorResponse> {
			parseRequest({ view: "revisions", windowDays });
			clear();
			const memoryStart = process.memoryUsage().heapUsed;
			try {
				const { header, rows } = await fresh(windowDays, signal);
				const result: ExportDocument = {
					...header,
					schema: "pillars-export",
					rows: rows.map((row) => ({ ...row, counters: { ...row.counters } })),
				};
				memoryGuard(memoryStart);
				validateExport(result);
				let bytes = Buffer.byteLength(JSON.stringify({ ...header, schema: "pillars-export", rows: [] }));
				for (const [index, row] of result.rows.entries()) {
					bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
					if (bytes > MAX_BYTES) throw new Error("response_overflow");
					if (index % 2048 === 0) memoryGuard(memoryStart);
				}
				memoryGuard(memoryStart);
				return result;
			} catch (error) {
				return failure(error);
			}
		},
	};
}
