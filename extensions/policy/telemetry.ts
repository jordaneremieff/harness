/** Bounded, resumable summaries of retained policy telemetry segments, without input or session payloads. */

import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import type { CallOutcome } from "./record.ts";
import {
	readTelemetryInventory,
	type TelemetryHealth,
	type TelemetryInventoryEntry,
	telemetryDirectory,
} from "./telemetry-files.ts";

export const TELEMETRY_LIMITS = Object.freeze({
	days: 31,
	/** Bytes read from segments by one page. */
	bytes: 8 * 1024 * 1024,
	/** Segment visits by one page. */
	segments: 32,
	lineBytes: 256 * 1024,
	/** Complete lines parsed by one page. */
	lines: 20_000,
	entriesPerRecord: 512,
	groups: 64,
	coverageLines: 64,
	outputBytes: 24 * 1024 - 1,
	/** Serialized structured page, reached only at maximal groups and counts. */
	structuredBytes: 96 * 1024,
	cursorChars: 1024,
});
const CHUNK_BYTES = 64 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Civil UTC offsets span -12:00 to +14:00, so these margins cover every writer's local day. */
const EARLIEST_OFFSET_MS = -12 * HOUR_MS;
const LATEST_OFFSET_MS = 14 * HOUR_MS;
const RULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const SEGMENT_NAME = /^(\d{4}-\d{2}-\d{2})\.(\d{6})\.jsonl$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
export const TELEMETRY_INSTANT_PATTERN =
	"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$";
export const TELEMETRY_CURSOR_PATTERN = "^[A-Za-z0-9_-]{1,1024}$";
const OUTCOMES: readonly CallOutcome[] = [
	"success",
	"execution-error",
	"denied",
	"invalid",
	"aborted",
	"unexecuted",
	"incomplete",
];
const ACTIONS = ["deny", "rename-key", "substitute", "assert-error", "guide", "observe"];
type OutcomeCounts = Record<CallOutcome | "unavailable", number>;
type CoverageStatus = "complete" | "partial" | "unavailable";
export type TelemetryDayIssue =
	| "missing"
	| "nonregular"
	| "symlink"
	| "read-error"
	| "source-changed"
	| "total-byte-limit"
	| "line-limit"
	| "segment-limit"
	| "incomplete-line"
	| "malformed-line"
	| "oversized-line";
/** Issues that only stop this page; the next cursor reaches the bytes they leave. */
const PAGE_LIMIT_ISSUES: readonly TelemetryDayIssue[] = ["total-byte-limit", "line-limit", "segment-limit"];

/** Inclusive writer-local day files, or a half-open interval of recorded instants. */
export type TelemetryRequest = ({ from: string; to: string } | { since: string; until: string }) & {
	cursor?: string;
};
export interface TelemetryReadOptions {
	/** This process's telemetry writer health, joined to the recording evidence. */
	health?: TelemetryHealth;
}
export type TelemetrySelection =
	| { kind: "dates"; from: string; to: string; calendar: "writer-local-day-files" }
	| {
			kind: "instants";
			since: string;
			until: string;
			/** The same interval normalized to UTC; records match when since <= at < until. */
			sinceUtc: string;
			untilUtc: string;
			end: "exclusive";
			/** Writer-local day files that can hold the interval for any writer UTC offset. */
			dayFiles: { from: string; to: string; offsets: "utc-12:00-to-utc+14:00" };
			/** Segments last modified before since cannot hold a matching record unless the wall clock stepped back. */
			segmentsModifiedBeforeSince: "excluded";
	  };
export interface TelemetrySegmentRead {
	name: string;
	ordinal: number;
	status: "complete" | "partial" | "missing" | "unavailable" | "excluded" | "skipped";
	/** Bytes this page read from the file. */
	bytesRead: number;
	/** File size when this page opened it, or null when the segment could not be inspected. */
	size: number | null;
	/** Covered byte range [startOffset, endOffset); later bytes were covered earlier or appended after the first visit. */
	startOffset: number | null;
	endOffset: number | null;
	/** Bytes before startOffset left for a later page; null means the size was not available. */
	bytesNotRead: number | null;
	issues: TelemetryDayIssue[];
}
export interface TelemetryDay {
	day: string;
	status: "complete" | "partial" | "missing" | "unavailable" | "skipped";
	/** Segments this page visited, newest first. */
	segments: TelemetrySegmentRead[];
	/** Segments of this day that this page did not reach; the next cursor reaches them. */
	segmentsNotReached: number;
	bytesRead: number;
	issues: TelemetryDayIssue[];
}
export interface TelemetryTool {
	name: string;
	records: number;
	errors: number;
	denied: number;
	truncated: number;
	/** Null means the sum exceeds exact JavaScript integer arithmetic. */
	outputBytes: number | null;
}
export interface TelemetryRule {
	id: string;
	matchedCalls: number;
	evaluations: number;
	trueEvaluations: number;
	falseEvaluations: number;
	unknownEvaluations: number;
	inapplicableEvaluations: number;
	unknownApplicabilityEvaluations: number;
	denialEvaluations: number;
	/** Distinct calls for this rule; one call can contribute to several rules. */
	deniedCalls: number;
}
export interface TelemetryContinuation {
	page: "first" | "resumed";
	/** Whether the cursor's segment still had the identity and size the cursor named. */
	position: "start" | "resumed" | "vanished" | "changed";
	/** Whether the oldest selected segment of the first page remains; retention removes oldest segments first. */
	olderSegments: "retained" | "removed" | "none";
	/** Repeat the same selection with this cursor for the next older page; null when the selection is exhausted. */
	nextCursor: string | null;
}
export interface TelemetryRecording {
	/** Never complete: other writers and earlier processes report no losses to this reader. */
	status: "incomplete" | "unknown";
	writer:
		| { scope: "this-process-since-start"; health: TelemetryHealth }
		| { scope: "unavailable" };
	otherWriters: "unknown";
}
export interface TelemetrySummary {
	/** Writer-local day files that this selection reads. */
	from: string;
	to: string;
	calendar: "writer-local-day-files";
	selection: TelemetrySelection;
	continuation: TelemetryContinuation;
	recording: TelemetryRecording;
	coverage: {
		/** This page together with every older byte that the next cursor still has to reach. */
		status: CoverageStatus;
		/** Only the bytes this page covered; page limits that a cursor continues are not gaps. */
		pageStatus: CoverageStatus;
		order: "newest-first-contiguous";
		directory: "available" | "missing" | "nonregular" | "symlink" | "unreadable";
		inventory: "complete" | "incomplete";
		/** Selected days from this page's start position, newest first. */
		days: TelemetryDay[];
		bytesRead: number;
		completeLines: number;
		malformedLines: number;
		oversizedLines: number;
		incompleteLines: number;
		/** Valid records whose recorded instant lies outside an instant selection. */
		outsideWindowLines: number;
	};
	records: number;
	outcomes: OutcomeCounts;
	observations: { complete: number; incomplete: number; unavailable: number };
	errors: { total: number; timeout: number; aborted: number; other: number; unavailable: number };
	truncated: number;
	outputBytes: number | null;
	denials: {
		confirmed: number;
		policyConfirmed: number;
		withRuleAttribution: number;
		withoutRuleAttribution: number;
		ruleAttributionLinks: number;
	};
	evaluations: {
		retained: number;
		malformed: number;
		readerOmitted: number;
		writerOmitted: number | null;
		irrelevant: number | null;
		recordsUnavailable: number;
		recordsWithUnknownCoverage: number;
	};
	matches: { retained: number; malformed: number; readerOmitted: number };
	toolNamesUnavailable: number;
	tools: TelemetryTool[];
	otherTools: TelemetryTool;
	rules: TelemetryRule[];
	otherRules: TelemetryRule;
	workerOutcomes: { status: "unavailable"; reason: "not-recorded-by-policy" };
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function safeName(value: unknown, pattern: RegExp): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 80 && pattern.test(value);
}
function sum(left: number | null, right: number): number | null {
	return left !== null && Number.isSafeInteger(left + right) ? left + right : null;
}
function dateValue(value: string): number {
	if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value))
		throw new RangeError("Policy telemetry dates must use YYYY-MM-DD.");
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
		throw new RangeError("Policy telemetry dates must be valid calendar dates.");
	return parsed;
}
function dayName(ms: number): string {
	return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}
function dayRange(from: string, to: string): string[] {
	const first = dateValue(from);
	const last = dateValue(to);
	const count = (last - first) / DAY_MS + 1;
	if (count < 1 || count > TELEMETRY_LIMITS.days)
		throw new RangeError(`Policy telemetry needs an ordered range of at most ${TELEMETRY_LIMITS.days} days.`);
	return Array.from({ length: count }, (_, index) => dayName(first + index * DAY_MS));
}
/** One instant with an explicit zone; calendar fields must round-trip exactly. */
export function telemetryInstant(value: unknown): number {
	const match = typeof value === "string" && value.length <= 40 ? INSTANT.exec(value) : null;
	if (!match)
		throw new RangeError(
			"Policy telemetry instants need YYYY-MM-DDTHH:MM:SS[.mmm] with Z or an explicit +HH:MM or -HH:MM offset.",
		);
	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
	const millis = Number((match[7] ?? "0").padEnd(3, "0"));
	const local = Date.UTC(year, month - 1, day, hour, minute, second, millis);
	const check = new Date(local);
	const offsetHours = Number(match[9] ?? 0);
	const offsetMinutes = Number(match[10] ?? 0);
	if (
		year < 1970 ||
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== month - 1 ||
		check.getUTCDate() !== day ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetMinutes > 59 ||
		offsetHours * 60 + offsetMinutes > 14 * 60
	)
		throw new RangeError("Policy telemetry instants must name a valid calendar time and UTC offset.");
	const sign = match[8] === "-" ? -1 : 1;
	return local - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
}

interface ResolvedSelection {
	selection: TelemetrySelection;
	/** Newest first. */
	days: string[];
	window: { since: number; until: number } | null;
}
function resolveSelection(request: TelemetryRequest): ResolvedSelection {
	if (!object(request)) throw new RangeError("Policy telemetry needs a date or instant selection.");
	const dates = "from" in request || "to" in request;
	const instants = "since" in request || "until" in request;
	if (dates === instants)
		throw new RangeError("Policy telemetry needs exactly one selection: from and to dates, or since and until instants.");
	if ("from" in request) {
		const days = dayRange(request.from, request.to);
		return {
			selection: { kind: "dates", from: request.from, to: request.to, calendar: "writer-local-day-files" },
			days: days.reverse(),
			window: null,
		};
	}
	const since = telemetryInstant(request.since);
	const until = telemetryInstant(request.until);
	if (until <= since) throw new RangeError("Policy telemetry needs since earlier than until.");
	const from = dayName(since + EARLIEST_OFFSET_MS);
	const to = dayName(until - 1 + LATEST_OFFSET_MS);
	const days = dayRange(from, to);
	return {
		selection: {
			kind: "instants",
			since: request.since,
			until: request.until,
			sinceUtc: new Date(since).toISOString(),
			untilUtc: new Date(until).toISOString(),
			end: "exclusive",
			dayFiles: { from, to, offsets: "utc-12:00-to-utc+14:00" },
			segmentsModifiedBeforeSince: "excluded",
		},
		days: days.reverse(),
		window: { since, until },
	};
}

function toolGroup(name: string): TelemetryTool {
	return { name, records: 0, errors: 0, denied: 0, truncated: 0, outputBytes: 0 };
}
function ruleGroup(id: string): TelemetryRule {
	return {
		id,
		matchedCalls: 0,
		evaluations: 0,
		trueEvaluations: 0,
		falseEvaluations: 0,
		unknownEvaluations: 0,
		inapplicableEvaluations: 0,
		unknownApplicabilityEvaluations: 0,
		denialEvaluations: 0,
		deniedCalls: 0,
	};
}
function recording(health: TelemetryHealth | undefined): TelemetryRecording {
	if (!health) return { status: "unknown", writer: { scope: "unavailable" }, otherWriters: "unknown" };
	const lost = health.state === "failed" || health.lostRecords > 0 || health.lostBytes > 0;
	return {
		status: lost ? "incomplete" : "unknown",
		writer: { scope: "this-process-since-start", health },
		otherWriters: "unknown",
	};
}
function initialSummary(resolved: ResolvedSelection, days: string[], health: TelemetryHealth | undefined): TelemetrySummary {
	const fileRange = resolved.selection.kind === "dates" ? resolved.selection : resolved.selection.dayFiles;
	return {
		from: fileRange.from,
		to: fileRange.to,
		calendar: "writer-local-day-files",
		selection: resolved.selection,
		continuation: { page: "first", position: "start", olderSegments: "none", nextCursor: null },
		recording: recording(health),
		coverage: {
			status: "complete",
			pageStatus: "complete",
			order: "newest-first-contiguous",
			directory: "available",
			inventory: "complete",
			days: days.map((day) => ({
				day,
				status: "skipped",
				segments: [],
				segmentsNotReached: 0,
				bytesRead: 0,
				issues: [],
			})),
			bytesRead: 0,
			completeLines: 0,
			malformedLines: 0,
			oversizedLines: 0,
			incompleteLines: 0,
			outsideWindowLines: 0,
		},
		records: 0,
		outcomes: {
			success: 0,
			"execution-error": 0,
			denied: 0,
			invalid: 0,
			aborted: 0,
			unexecuted: 0,
			incomplete: 0,
			unavailable: 0,
		},
		observations: { complete: 0, incomplete: 0, unavailable: 0 },
		errors: { total: 0, timeout: 0, aborted: 0, other: 0, unavailable: 0 },
		truncated: 0,
		outputBytes: 0,
		denials: {
			confirmed: 0,
			policyConfirmed: 0,
			withRuleAttribution: 0,
			withoutRuleAttribution: 0,
			ruleAttributionLinks: 0,
		},
		evaluations: {
			retained: 0,
			malformed: 0,
			readerOmitted: 0,
			writerOmitted: 0,
			irrelevant: 0,
			recordsUnavailable: 0,
			recordsWithUnknownCoverage: 0,
		},
		matches: { retained: 0, malformed: 0, readerOmitted: 0 },
		toolNamesUnavailable: 0,
		tools: [],
		otherTools: toolGroup("(other tools)"),
		rules: [],
		otherRules: ruleGroup("(other rules)"),
		workerOutcomes: { status: "unavailable", reason: "not-recorded-by-policy" },
	};
}

interface RecordFields {
	at: string;
	tool: string;
	error: boolean;
	truncated: boolean;
	outputBytes: number;
	classes: unknown[];
	[key: string]: unknown;
}
function recordFields(value: unknown): value is RecordFields {
	return (
		object(value) &&
		typeof value.at === "string" &&
		value.at.length <= 32 &&
		Number.isFinite(Date.parse(value.at)) &&
		typeof value.tool === "string" &&
		typeof value.error === "boolean" &&
		typeof value.truncated === "boolean" &&
		integer(value.outputBytes) &&
		Array.isArray(value.classes)
	);
}
function truth(value: unknown): value is boolean | "unknown" {
	return typeof value === "boolean" || value === "unknown";
}
interface Evaluation {
	id: string;
	phase: string;
	truth: boolean | "unknown";
	applicable: boolean | "unknown";
	deny: boolean;
}
function evaluation(value: unknown): value is Evaluation {
	return (
		object(value) &&
		safeName(value.id, RULE_ID) &&
		["input", "result", "completion", "context"].includes(value.phase as string) &&
		truth(value.truth) &&
		truth(value.applicable) &&
		typeof value.deny === "boolean" &&
		typeof value.unavailable === "boolean" &&
		ACTIONS.includes(value.action as string)
	);
}

class Aggregator {
	private readonly tools = new Map<string, TelemetryTool>();
	private readonly rules = new Map<string, TelemetryRule>();
	readonly summary: TelemetrySummary;
	constructor(summary: TelemetrySummary) {
		this.summary = summary;
	}
	private rule(id: string): TelemetryRule {
		let row = this.rules.get(id);
		if (row) return row;
		if (this.rules.size >= TELEMETRY_LIMITS.groups) return this.summary.otherRules;
		row = ruleGroup(id);
		this.rules.set(id, row);
		return row;
	}
	private tool(name: string): TelemetryTool {
		let row = this.tools.get(name);
		if (row) return row;
		if (this.tools.size >= TELEMETRY_LIMITS.groups) return this.summary.otherTools;
		row = toolGroup(name);
		this.tools.set(name, row);
		return row;
	}
	private matches(classes: unknown[]): void {
		const counts = this.summary.matches;
		counts.readerOmitted += Math.max(0, classes.length - TELEMETRY_LIMITS.entriesPerRecord);
		const ids = new Set<string>();
		for (const id of classes.slice(0, TELEMETRY_LIMITS.entriesPerRecord)) {
			if (!safeName(id, RULE_ID)) counts.malformed++;
			else ids.add(id);
		}
		for (const id of ids) {
			counts.retained++;
			this.rule(id).matchedCalls++;
		}
	}
	private countEvaluation(entry: Evaluation): void {
		this.summary.evaluations.retained++;
		const row = this.rule(entry.id);
		row.evaluations++;
		if (entry.truth === true) row.trueEvaluations++;
		else if (entry.truth === false) row.falseEvaluations++;
		else row.unknownEvaluations++;
		if (entry.applicable === false) row.inapplicableEvaluations++;
		else if (entry.applicable === "unknown") row.unknownApplicabilityEvaluations++;
		if (entry.deny) row.denialEvaluations++;
	}
	private evaluations(policy: unknown, policyDenied: boolean): Set<string> {
		const counts = this.summary.evaluations;
		const attributed = new Set<string>();
		if (!object(policy) || !Array.isArray(policy.evaluations)) {
			counts.recordsUnavailable++;
			return attributed;
		}
		const entries = policy.evaluations;
		const coverage = object(policy.coverage) ? policy.coverage.evaluations : undefined;
		if (
			object(coverage) &&
			integer(coverage.total) &&
			integer(coverage.omitted) &&
			integer(coverage.irrelevant) &&
			coverage.total - entries.length === coverage.omitted + coverage.irrelevant
		) {
			counts.writerOmitted = sum(counts.writerOmitted, coverage.omitted);
			counts.irrelevant = sum(counts.irrelevant, coverage.irrelevant);
		}
		else counts.recordsWithUnknownCoverage++;
		counts.readerOmitted += Math.max(0, entries.length - TELEMETRY_LIMITS.entriesPerRecord);
		for (const entry of entries.slice(0, TELEMETRY_LIMITS.entriesPerRecord)) {
			if (!evaluation(entry)) {
				counts.malformed++;
				continue;
			}
			this.countEvaluation(entry);
			if (policyDenied && entry.phase === "input" && entry.deny && entry.applicable === true && entry.truth !== false)
				attributed.add(entry.id);
		}
		for (const id of attributed) this.rule(id).deniedCalls++;
		return attributed;
	}
	private error(record: RecordFields, tool: TelemetryTool): void {
		if (!record.error) return;
		this.summary.errors.total++;
		tool.errors++;
		const kind =
			record.errorKind === "timeout" || record.errorKind === "aborted" || record.errorKind === "other"
				? record.errorKind
				: "unavailable";
		this.summary.errors[kind]++;
	}
	accept(record: RecordFields): void {
		const summary = this.summary;
		summary.records++;
		const named = safeName(record.tool, TOOL_NAME);
		if (!named) summary.toolNamesUnavailable++;
		const tool = this.tool(named ? record.tool : "(unavailable tool name)");
		tool.records++;
		tool.outputBytes = sum(tool.outputBytes, record.outputBytes);
		summary.outputBytes = sum(summary.outputBytes, record.outputBytes);
		const outcome = OUTCOMES.includes(record.outcome as CallOutcome) ? (record.outcome as CallOutcome) : "unavailable";
		summary.outcomes[outcome]++;
		const observation =
			record.observationComplete === true
				? "complete"
				: record.observationComplete === false
					? "incomplete"
					: "unavailable";
		summary.observations[observation]++;
		this.error(record, tool);
		if (record.truncated) {
			summary.truncated++;
			tool.truncated++;
		}
		this.matches(record.classes);
		const denied = outcome === "denied";
		const policyDenied =
			denied && record.policyMode === "enforce" && object(record.policy) && record.policy.decision === "deny";
		const attributed = this.evaluations(record.policy, policyDenied);
		if (denied) {
			summary.denials.confirmed++;
			tool.denied++;
			if (policyDenied) summary.denials.policyConfirmed++;
			if (attributed.size > 0) summary.denials.withRuleAttribution++;
			else summary.denials.withoutRuleAttribution++;
			summary.denials.ruleAttributionLinks += attributed.size;
		}
	}
	finish(): void {
		this.summary.tools = [...this.tools.values()].sort((a, b) => b.records - a.records || a.name.localeCompare(b.name));
		this.summary.rules = [...this.rules.values()].sort(
			(a, b) => b.deniedCalls - a.deniedCalls || a.id.localeCompare(b.id),
		);
	}
}

interface IssueTarget {
	status: string;
	issues: TelemetryDayIssue[];
}
function issue(target: IssueTarget, reason: TelemetryDayIssue): void {
	if (!target.issues.includes(reason)) target.issues.push(reason);
	if (target.status === "complete") target.status = "partial";
}
function parseRecord(buffer: Buffer): RecordFields | undefined {
	if (buffer.length === 0) return undefined;
	try {
		const value: unknown = JSON.parse(UTF8.decode(buffer));
		return recordFields(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

interface CursorPosition {
	name: string;
	dev: number;
	ino: number;
	/** Bytes at or above this offset were covered; null means the segment was not yet visited. */
	offset: number | null;
	/** The bytes just below offset belong to an oversized or incomplete line already counted. */
	midLine: boolean;
}
interface CursorState {
	selection: string;
	position: CursorPosition;
	oldest: { name: string; ino: number } | null;
}
function selectionDigest(dir: string, selection: TelemetrySelection): string {
	const bounds = selection.kind === "dates" ? [selection.from, selection.to] : [selection.sinceUtc, selection.untilUtc];
	return createHash("sha256").update(JSON.stringify([dir, selection.kind, ...bounds])).digest("hex").slice(0, 16);
}
function encodeCursor(state: CursorState): string {
	const { position, oldest } = state;
	const value = {
		v: 1,
		s: state.selection,
		n: position.name,
		d: position.dev,
		i: position.ino,
		o: position.offset,
		m: position.midLine,
		...(oldest ? { on: oldest.name, oi: oldest.ino } : {}),
	};
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function cursorNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
function decodeCursor(text: unknown, selection: string): CursorState {
	let value: unknown;
	try {
		if (typeof text !== "string" || text.length > TELEMETRY_LIMITS.cursorChars || !/^[A-Za-z0-9_-]+$/.test(text))
			throw new Error("format");
		value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
	} catch {
		throw new RangeError("Policy telemetry cursor is malformed; start again without a cursor.");
	}
	const keys = object(value) ? Object.keys(value) : [];
	if (
		!object(value) ||
		value.v !== 1 ||
		typeof value.s !== "string" ||
		typeof value.n !== "string" ||
		!SEGMENT_NAME.test(value.n) ||
		!cursorNumber(value.d) ||
		!cursorNumber(value.i) ||
		!(value.o === null || (cursorNumber(value.o) && value.o > 0)) ||
		typeof value.m !== "boolean" ||
		("on" in value && !(typeof value.on === "string" && SEGMENT_NAME.test(value.on) && cursorNumber(value.oi))) ||
		keys.some((key) => !["v", "s", "n", "d", "i", "o", "m", "on", "oi"].includes(key))
	)
		throw new RangeError("Policy telemetry cursor is malformed; start again without a cursor.");
	if (value.s !== selection)
		throw new RangeError("Policy telemetry cursor belongs to another selection; repeat the selection that returned it.");
	return {
		selection: value.s,
		position: { name: value.n, dev: value.d, ino: value.i, offset: value.o as number | null, midLine: value.m },
		oldest: typeof value.on === "string" ? { name: value.on, ino: value.oi as number } : null,
	};
}

interface PageState {
	aggregate: Aggregator;
	window: { since: number; until: number } | null;
	visits: number;
}
interface BufferOutcome {
	frontier: number;
	midLine: boolean;
	lineCut: boolean;
}
function acceptLine(segment: TelemetrySegmentRead, page: PageState, line: Buffer, bytes: number): void {
	const coverage = page.aggregate.summary.coverage;
	coverage.completeLines++;
	if (bytes > TELEMETRY_LIMITS.lineBytes) {
		coverage.oversizedLines++;
		issue(segment, "oversized-line");
		return;
	}
	const value = parseRecord(line);
	if (!value) {
		coverage.malformedLines++;
		issue(segment, "malformed-line");
		return;
	}
	if (page.window) {
		const at = Date.parse(value.at);
		if (at < page.window.since || at >= page.window.until) {
			coverage.outsideWindowLines++;
			return;
		}
	}
	page.aggregate.accept(value);
}
/** The first line start at or after the line budget, counted newest first over [first, last). */
function lineBudgetCut(buffer: Buffer, first: number, last: number, remaining: number): number {
	let count = 0;
	let end = last - 1;
	while (end >= first) {
		const start = end === 0 ? 0 : buffer.lastIndexOf(10, end - 1) + 1;
		if (start < end) {
			if (count === remaining) return end + 1;
			count++;
		}
		end = start - 1;
	}
	return first;
}
/**
 * The end of the last complete line, after an incomplete final line at the snapshot end or the rest
 * of a line that an earlier page already counted. Null means the whole buffer lies inside that line.
 */
function completeEnd(
	buffer: Buffer,
	snapshotEnd: boolean,
	midLine: boolean,
	segment: TelemetrySegmentRead,
	page: PageState,
): number | null {
	if (!midLine && !(snapshotEnd && buffer[buffer.length - 1] !== 10)) return buffer.length;
	if (!midLine) {
		page.aggregate.summary.coverage.incompleteLines++;
		issue(segment, "incomplete-line");
	}
	const newline = buffer.lastIndexOf(10);
	return newline < 0 ? null : newline + 1;
}
/**
 * Parse the complete lines of one buffer read from [start, start + length). The returned frontier is
 * the lowest covered offset: a cut leading line, a line-budget cut, or 0 stays for a later page.
 */
function processBuffer(
	buffer: Buffer,
	start: number,
	snapshotEnd: boolean,
	midLine: boolean,
	segment: TelemetrySegmentRead,
	page: PageState,
): BufferOutcome {
	const coverage = page.aggregate.summary.coverage;
	if (buffer.length === 0) return { frontier: start, midLine, lineCut: false };
	const last = completeEnd(buffer, snapshotEnd, midLine, segment, page);
	if (last === null) return { frontier: start, midLine: start > 0, lineCut: false };
	let first = 0;
	if (start > 0) {
		first = buffer.indexOf(10) + 1;
		if (first === buffer.length) {
			// One line fills the whole read, which exceeds the line bound; it is counted once here.
			coverage.completeLines++;
			coverage.oversizedLines++;
			issue(segment, "oversized-line");
			return { frontier: start, midLine: true, lineCut: false };
		}
	}
	const cut = lineBudgetCut(buffer, first, last, TELEMETRY_LIMITS.lines - coverage.completeLines);
	let end = last - 1;
	while (end >= cut) {
		const lineStart = end === 0 ? 0 : buffer.lastIndexOf(10, end - 1) + 1;
		if (lineStart < end) acceptLine(segment, page, buffer.subarray(lineStart, end), end - lineStart + 1);
		end = lineStart - 1;
	}
	return { frontier: start + cut, midLine: false, lineCut: cut > first };
}
async function readRange(handle: FileHandle, segment: TelemetrySegmentRead, page: PageState, start: number, length: number): Promise<Buffer> {
	const coverage = page.aggregate.summary.coverage;
	const buffer = Buffer.alloc(length);
	while (segment.bytesRead < length) {
		const result = await handle.read(
			buffer,
			segment.bytesRead,
			Math.min(CHUNK_BYTES, length - segment.bytesRead),
			start + segment.bytesRead,
		);
		if (result.bytesRead === 0) break;
		segment.bytesRead += result.bytesRead;
		coverage.bytesRead += result.bytesRead;
	}
	return buffer;
}
type SegmentOutcome = { stopped: TelemetryDayIssue } | { frontier: number; midLine: boolean };
async function readSnapshot(
	handle: FileHandle,
	info: Stats,
	segment: TelemetrySegmentRead,
	page: PageState,
	from: Pick<CursorPosition, "offset" | "midLine">,
): Promise<SegmentOutcome> {
	const coverage = page.aggregate.summary.coverage;
	const end = from.offset ?? info.size;
	if (end > info.size) {
		segment.status = "unavailable";
		issue(segment, "source-changed");
		return { frontier: 0, midLine: false };
	}
	const length = Math.min(end, TELEMETRY_LIMITS.bytes - coverage.bytesRead);
	if (length < end && length <= TELEMETRY_LIMITS.lineBytes) return { stopped: "total-byte-limit" };
	if (end > 0 && coverage.completeLines >= TELEMETRY_LIMITS.lines) return { stopped: "line-limit" };
	segment.status = "complete";
	const start = end - length;
	let buffer: Buffer;
	try {
		buffer = await readRange(handle, segment, page, start, length);
	} catch {
		segment.status = "unavailable";
		issue(segment, "read-error");
		return { frontier: 0, midLine: false };
	}
	if (segment.bytesRead < length) {
		segment.status = "unavailable";
		issue(segment, "read-error");
		return { frontier: 0, midLine: false };
	}
	const after = await handle.stat();
	if (after.size < end || after.ino !== info.ino || after.dev !== info.dev) issue(segment, "source-changed");
	const outcome = processBuffer(buffer, start, from.offset === null, from.midLine, segment, page);
	segment.startOffset = outcome.frontier;
	segment.endOffset = end;
	segment.bytesNotRead = outcome.frontier;
	if (outcome.frontier > 0) issue(segment, outcome.lineCut ? "line-limit" : "total-byte-limit");
	return { frontier: outcome.frontier, midLine: outcome.midLine };
}
async function readSegment(
	entry: TelemetryInventoryEntry,
	path: string,
	segment: TelemetrySegmentRead,
	page: PageState,
	from: Pick<CursorPosition, "offset" | "midLine">,
): Promise<SegmentOutcome> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		const info = await handle.stat();
		if (!info.isFile() || info.ino !== entry.ino || info.dev !== entry.dev) {
			segment.status = "unavailable";
			issue(segment, "source-changed");
			return { frontier: 0, midLine: false };
		}
		segment.size = info.size;
		if (page.window && info.mtimeMs < page.window.since) {
			segment.status = "excluded";
			segment.bytesNotRead = 0;
			return { frontier: 0, midLine: false };
		}
		return await readSnapshot(handle, info, segment, page, from);
	} catch (error) {
		segment.status = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unavailable";
		issue(segment, segment.status === "missing" ? "missing" : "read-error");
		return { frontier: 0, midLine: false };
	} finally {
		try {
			await handle?.close();
		} catch {
			issue(segment, "read-error");
		}
	}
}
function newSegment(name: string, ordinal: number, size: number | null): TelemetrySegmentRead {
	return {
		name,
		ordinal,
		status: "skipped",
		bytesRead: 0,
		size,
		startOffset: null,
		endOffset: null,
		bytesNotRead: null,
		issues: [],
	};
}
function segmentKey(name: string): { day: string; ordinal: number } {
	const match = SEGMENT_NAME.exec(name);
	return { day: match?.[1] ?? "", ordinal: Number(match?.[2] ?? 0) };
}
/** Newest first: later days, then higher ordinals. */
function newerFirst(left: { day: string; ordinal: number }, right: { day: string; ordinal: number }): number {
	return right.day.localeCompare(left.day) || right.ordinal - left.ordinal;
}
function summarizeDay(day: TelemetryDay): void {
	for (const segment of day.segments) {
		day.bytesRead += segment.bytesRead;
		for (const reason of segment.issues) if (!day.issues.includes(reason)) day.issues.push(reason);
	}
	if (day.status === "missing") return;
	const statuses = day.segments.map((segment) => segment.status);
	if (statuses.length === 0) day.status = "skipped";
	else if (statuses.every((status) => status === "unavailable" || status === "missing")) day.status = "unavailable";
	else
		day.status =
			day.segmentsNotReached === 0 && statuses.every((status) => status === "complete" || status === "excluded")
				? "complete"
				: "partial";
}

interface PageStart {
	index: number;
	from: Pick<CursorPosition, "offset" | "midLine">;
	oldest: CursorState["oldest"];
}
/** Locate a cursor's segment in the current inventory, or record why it can no longer continue there. */
function resumeAt(
	summary: TelemetrySummary,
	selected: readonly TelemetryInventoryEntry[],
	all: readonly TelemetryInventoryEntry[],
	rows: Map<string, TelemetryDay>,
	cursor: CursorState,
): PageStart {
	const continuation = summary.continuation;
	continuation.page = "resumed";
	const oldest = cursor.oldest;
	continuation.olderSegments = oldest
		? all.some((entry) => entry.name === oldest.name && entry.ino === oldest.ino)
			? "retained"
			: "removed"
		: "none";
	const position = cursor.position;
	const found = selected.findIndex((entry) => entry.name === position.name);
	const entry = selected[found];
	if (
		entry &&
		entry.unsafe === null &&
		entry.dev === position.dev &&
		entry.ino === position.ino &&
		(position.offset === null || entry.size >= position.offset)
	) {
		continuation.position = "resumed";
		return { index: found, from: position, oldest };
	}
	continuation.position = entry ? "changed" : "vanished";
	const key = segmentKey(position.name);
	const row = newSegment(position.name, key.ordinal, entry && entry.unsafe === null ? entry.size : null);
	row.status = entry ? "unavailable" : "missing";
	row.bytesNotRead = position.offset;
	issue(row, entry ? "source-changed" : "missing");
	rows.get(key.day)?.segments.push(row);
	const older = selected.findIndex((candidate) => newerFirst(key, candidate) < 0);
	return { index: older < 0 ? selected.length : older, from: { offset: null, midLine: false }, oldest };
}
function hasGaps(summary: TelemetrySummary): boolean {
	const coverage = summary.coverage;
	const segmentGap = coverage.days.some((day) =>
		day.segments.some((segment) => segment.issues.some((reason) => !PAGE_LIMIT_ISSUES.includes(reason))),
	);
	const missingDay = summary.selection.kind === "dates" && coverage.days.some((day) => day.status === "missing");
	return (
		segmentGap ||
		missingDay ||
		coverage.inventory === "incomplete" ||
		summary.continuation.olderSegments === "removed" ||
		summary.observations.incomplete > 0 ||
		summary.observations.unavailable > 0 ||
		summary.outcomes.unavailable > 0 ||
		summary.evaluations.recordsUnavailable > 0 ||
		summary.evaluations.recordsWithUnknownCoverage > 0 ||
		summary.evaluations.malformed > 0 ||
		summary.evaluations.readerOmitted > 0 ||
		summary.evaluations.writerOmitted !== 0 ||
		summary.matches.malformed > 0 ||
		summary.matches.readerOmitted > 0 ||
		summary.errors.unavailable > 0 ||
		summary.toolNamesUnavailable > 0
	);
}
/** Visit segments newest first from the start position until the selection ends or a page limit stops it. */
async function readPage(
	dir: string,
	selected: readonly TelemetryInventoryEntry[],
	rows: Map<string, TelemetryDay>,
	page: PageState,
	start: PageStart,
): Promise<CursorPosition | null> {
	const notReached = (index: number): void => {
		for (const entry of selected.slice(index)) {
			const day = rows.get(entry.day);
			if (day) day.segmentsNotReached++;
		}
	};
	const stopAt = (index: number, reason: TelemetryDayIssue, position: CursorPosition): CursorPosition => {
		const row = rows.get(selected[index].day);
		if (row && !row.issues.includes(reason)) row.issues.push(reason);
		notReached(index);
		return position;
	};
	for (let index = start.index; index < selected.length; index++) {
		const entry = selected[index];
		const from = index === start.index ? start.from : { offset: null, midLine: false };
		const here = { name: entry.name, dev: entry.dev, ino: entry.ino, ...from };
		if (page.visits >= TELEMETRY_LIMITS.segments) return stopAt(index, "segment-limit", here);
		page.visits++;
		const outcome = await visitSegment(dir, entry, rows, page, from);
		if ("stopped" in outcome) return stopAt(index, outcome.stopped, here);
		if (outcome.frontier > 0) {
			notReached(index + 1);
			return { ...here, offset: outcome.frontier, midLine: outcome.midLine };
		}
	}
	return null;
}
async function visitSegment(
	dir: string,
	entry: TelemetryInventoryEntry,
	rows: Map<string, TelemetryDay>,
	page: PageState,
	from: Pick<CursorPosition, "offset" | "midLine">,
): Promise<SegmentOutcome> {
	const segment = newSegment(entry.name, entry.ordinal, entry.unsafe ? null : entry.size);
	let outcome: SegmentOutcome = { frontier: 0, midLine: false };
	if (entry.unsafe) {
		segment.status = "unavailable";
		issue(segment, entry.unsafe === "symlink" ? "symlink" : "nonregular");
	} else outcome = await readSegment(entry, join(dir, entry.name), segment, page, from);
	if (!("stopped" in outcome)) rows.get(entry.day)?.segments.push(segment);
	return outcome;
}

/**
 * Read one page of retained telemetry: inclusive writer-local day files, or day files that can hold
 * a half-open instant interval filtered by each record's recorded instant. Pages run newest first;
 * the next cursor continues at the oldest covered byte. No directories or files are created.
 */
export async function readTelemetryPage(
	dir: string,
	request: TelemetryRequest,
	options: TelemetryReadOptions = {},
): Promise<TelemetrySummary> {
	const resolved = resolveSelection(request);
	if (typeof dir !== "string" || dir.length === 0 || dir.length > 4096 || dir.includes("\0"))
		throw new RangeError("Policy telemetry needs a bounded directory path.");
	const digest = selectionDigest(dir, resolved.selection);
	const cursor = request.cursor === undefined ? undefined : decodeCursor(request.cursor, digest);
	const positionDay = cursor ? segmentKey(cursor.position.name).day : undefined;
	const days = positionDay ? resolved.days.filter((day) => day <= positionDay) : resolved.days;
	const summary = initialSummary(resolved, days, options.health);
	const inventory = await readTelemetryInventory(dir);
	summary.coverage.directory = inventory.directory;
	summary.coverage.inventory = inventory.incomplete ? "incomplete" : "complete";
	if (summary.coverage.directory !== "available") {
		summary.coverage.status = "unavailable";
		summary.coverage.pageStatus = "unavailable";
		return summary;
	}
	const rows = new Map(summary.coverage.days.map((day) => [day.day, day]));
	const selected = inventory.entries.filter((entry) => rows.has(entry.day)).sort(newerFirst);
	const start = cursor
		? resumeAt(summary, selected, inventory.entries, rows, cursor)
		: firstPageStart(summary, selected);
	for (const day of summary.coverage.days)
		if (day.segments.length === 0 && !selected.some((entry) => entry.day === day.day)) {
			day.status = "missing";
			day.issues.push("missing");
		}
	const aggregate = new Aggregator(summary);
	const page: PageState = { aggregate, window: resolved.window, visits: 0 };
	const next = await readPage(telemetryDirectory(dir), selected, rows, page, start);
	aggregate.finish();
	for (const day of summary.coverage.days) summarizeDay(day);
	if (next) summary.continuation.nextCursor = encodeCursor({ selection: digest, position: next, oldest: start.oldest });
	settleStatus(summary);
	return summary;
}
function firstPageStart(summary: TelemetrySummary, selected: readonly TelemetryInventoryEntry[]): PageStart {
	const oldest = selected.at(-1);
	summary.continuation.olderSegments = oldest ? "retained" : "none";
	return {
		index: 0,
		from: { offset: null, midLine: false },
		oldest: oldest ? { name: oldest.name, ino: oldest.ino } : null,
	};
}
function settleStatus(summary: TelemetrySummary): void {
	const coverage = summary.coverage;
	const readable = coverage.days.some((day) => day.status === "complete" || day.status === "partial");
	const gaps = hasGaps(summary);
	coverage.pageStatus = !readable ? "unavailable" : gaps ? "partial" : "complete";
	coverage.status = !readable ? "unavailable" : gaps || summary.continuation.nextCursor ? "partial" : "complete";
}

/** Read the first page of an inclusive range of writer-local calendar day files. */
export function readTelemetry(
	dir: string,
	from: string,
	to: string,
	options: TelemetryReadOptions = {},
): Promise<TelemetrySummary> {
	return readTelemetryPage(dir, { from, to }, options);
}

function segmentLine(segment: TelemetrySegmentRead): string {
	const range = `${segment.startOffset ?? "unknown"}..${segment.endOffset ?? "unknown"}`;
	return `    ${segment.name}: ${segment.status}; read ${segment.bytesRead} (covered ${range}); earlier bytes left ${segment.bytesNotRead ?? "unknown"}; ${segment.issues.join(", ") || "no file gaps"}`;
}
/** Day lines always show; clean segments are omitted and segment lines stop at the display bound. */
function dayCoverageLines(days: readonly TelemetryDay[]): string[] {
	const lines: string[] = [];
	let omitted = 0;
	for (const day of days) {
		lines.push(
			`  ${day.day}: ${day.status}; ${day.segments.length} segments visited; ${day.segmentsNotReached} not reached; read ${day.bytesRead}; ${day.issues.join(", ") || "no file gaps"}`,
		);
		for (const segment of day.segments) {
			if ((segment.status === "complete" || segment.status === "excluded") && segment.issues.length === 0) continue;
			if (lines.length >= TELEMETRY_LIMITS.coverageLines) omitted++;
			else lines.push(segmentLine(segment));
		}
	}
	if (omitted > 0) lines.push(`  Coverage omits ${omitted} segment lines at the display bound.`);
	return lines;
}
function selectionLine(summary: TelemetrySummary): string {
	const selection = summary.selection;
	if (selection.kind === "dates")
		return `Policy telemetry: ${selection.from} through ${selection.to} (inclusive writer-local calendar day files)`;
	return `Policy telemetry: recorded instants from ${selection.sinceUtc} up to ${selection.untilUtc} (exclusive; requested ${selection.since} to ${selection.until}), from writer-local day files ${selection.dayFiles.from} through ${selection.dayFiles.to}`;
}
function recordingLine(recording: TelemetryRecording): string {
	if (recording.writer.scope === "unavailable")
		return "Recording: unknown. This host exposes no writer health; losses of every writer are unknown.";
	const health = recording.writer.health;
	const uncertain =
		health.uncertainRecords === undefined
			? ""
			: `; records whose batch failed after bytes may have reached storage ${health.uncertainRecords} (${health.uncertainBytes ?? 0} bytes; each may be absent, torn, or present)`;
	const recovery =
		health.recovery === undefined
			? ""
			: `; stops ${health.recovery.stops}, resumes ${health.recovery.resumes}, stale locks taken over ${health.recovery.staleLocks}`;
	return `Recording: ${recording.status}. This process's writer since its start: ${health.state}; lost records ${health.lostRecords}; lost bytes ${health.lostBytes}${uncertain}${recovery}. Losses of other writers and earlier processes are unknown; complete parsing of retained files does not prove complete recording.`;
}
function continuationLine(summary: TelemetrySummary): string {
	const continuation = summary.continuation;
	const start =
		continuation.page === "first"
			? "First page."
			: `Resumed page; cursor position ${continuation.position}; oldest first-page segment ${continuation.olderSegments}.`;
	return continuation.nextCursor
		? `${start} Older bytes remain. Repeat the same selection with cursor ${continuation.nextCursor}`
		: `${start} No older bytes remain in this selection.`;
}

/** Plain bounded text. Counts describe retained records, never live coverage or worker success. */
export function formatTelemetry(summary: TelemetrySummary): string {
	const c = summary.coverage;
	const e = summary.evaluations;
	const d = summary.denials;
	const bytes = (value: number | null) => (value === null ? "unavailable (integer overflow)" : String(value));
	const coverageLines = dayCoverageLines(c.days);
	const introduction = [
		selectionLine(summary),
		`Retained evidence: ${c.status} (this page: ${c.pageStatus}); ${summary.records} tool records; ${d.confirmed} confirmed denials; ${summary.errors.total} errors; ${summary.truncated} truncated outputs.`,
		continuationLine(summary),
		recordingLine(summary.recording),
		`Confirmed denials: ${d.confirmed}; policy-confirmed ${d.policyConfirmed}; with rule attribution ${d.withRuleAttribution}; without ${d.withoutRuleAttribution}.`,
		`Errors: ${summary.errors.total}; inferred text classes: timeout ${summary.errors.timeout}; aborted ${summary.errors.aborted}; other ${summary.errors.other}; unavailable ${summary.errors.unavailable}.`,
		`Truncated tool outputs: ${summary.truncated}; text output bytes: ${bytes(summary.outputBytes)}. Nontext payloads are excluded.`,
		"Worker outcomes: unavailable. Policy records do not record worker outcomes; a tool result does not establish a worker outcome.",
		"Tool volume (records, errors, denials, truncated, text bytes):",
	];
	const window =
		summary.selection.kind === "instants"
			? "Instant selections read every day file that a writer at any UTC offset from -12:00 to +14:00 could use and match each record's recorded instant. An absent day file of such a selection is not a gap. Segments last modified before the start instant are excluded; a wall-clock step backwards can defeat that exclusion."
			: "Dates name the writer's local-calendar day files, not UTC timestamp filters.";
	const details = [
		"",
		"Evidence coverage:",
		`Directory: ${c.directory}. Inventory: ${c.inventory}.`,
		window,
		"Pages read segments newest first and contiguously; each page continues below the oldest byte of the page before. These are per-segment snapshots, not an atomic snapshot or proof of complete live activity. Bytes appended to a segment after its first visit are outside the chain. Retention can remove segments between pages; every vanished, changed, or partially read segment stays visible.",
		`Read: ${c.bytesRead} bytes; ${c.completeLines} complete lines; ${summary.records} accepted records; ${c.outsideWindowLines} records outside the instants.`,
		`Excluded lines: malformed ${c.malformedLines}; oversized ${c.oversizedLines}; incomplete ${c.incompleteLines}.`,
		`Outcomes: ${Object.entries(summary.outcomes)
			.map(([key, value]) => `${key} ${value}`)
			.join("; ")}.`,
		`Observation completeness: complete ${summary.observations.complete}; incomplete ${summary.observations.incomplete}; unavailable ${summary.observations.unavailable}.`,
		`Tool names unavailable: ${summary.toolNamesUnavailable}.`,
		`Rule attribution links: ${d.ruleAttributionLinks}. A denied call can count under several rules; rule totals are not distinct calls.`,
		`Rule evaluations: retained ${e.retained}; irrelevant ${bytes(e.irrelevant)}; malformed ${e.malformed}; reader omitted ${e.readerOmitted}; writer omitted ${bytes(e.writerOmitted)}.`,
		"Irrelevant evaluations are intentionally excluded, not missing decision facts. Denials in bytes that no page covered remain unknown.",
		`Evaluation records unavailable: ${e.recordsUnavailable}; records with unknown evaluation coverage: ${e.recordsWithUnknownCoverage}.`,
		`Matched call-rule pairs: ${summary.matches.retained}; malformed entries ${summary.matches.malformed}; reader omitted ${summary.matches.readerOmitted}.`,
		"Matches and denial evaluations do not prove enforcement. Attribution requires a confirmed policy denial and an applicable input deny evaluation.",
		"Day coverage:",
		...coverageLines,
	].join("\n");
	let output = `${introduction.join("\n")}\n`;
	const reservedBytes = Buffer.byteLength(details) + 300;
	let omittedTools = 0;
	let omittedRules = 0;
	const append = (line: string): boolean => {
		if (Buffer.byteLength(output) + Buffer.byteLength(line) + reservedBytes > TELEMETRY_LIMITS.outputBytes)
			return false;
		output += `${line}\n`;
		return true;
	};
	for (const row of [...summary.tools, summary.otherTools]) {
		if (row.records === 0) continue;
		if (
			!append(
				`  ${row.name}: ${row.records}, ${row.errors}, ${row.denied}, ${row.truncated}, ${bytes(row.outputBytes)}`,
			)
		)
			omittedTools++;
	}
	append(
		"Rules (matched calls; evaluations true/false/unknown; applicability false/unknown; deny evaluations; attributed denied calls):",
	);
	for (const row of [...summary.rules, summary.otherRules]) {
		if (row.matchedCalls + row.evaluations + row.deniedCalls === 0) continue;
		if (
			!append(
				`  ${row.id}: ${row.matchedCalls}; ${row.evaluations} (${row.trueEvaluations}/${row.falseEvaluations}/${row.unknownEvaluations}); ${row.inapplicableEvaluations}/${row.unknownApplicabilityEvaluations}; ${row.denialEvaluations}; ${row.deniedCalls}`,
			)
		)
			omittedRules++;
	}
	output += `${details}\n`;
	output += `Other groups retain overflow contributions beyond ${TELEMETRY_LIMITS.groups} names per group.\n`;
	output += `Output omits ${omittedTools} tool rows and ${omittedRules} rule rows.\n`;
	return output;
}
