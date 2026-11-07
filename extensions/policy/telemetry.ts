/** Bounded summaries of retained policy telemetry segments, without input or session payloads. */

import { constants, type Stats } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import type { CallOutcome } from "./record.ts";
import { readTelemetryInventory, type TelemetryInventoryEntry, telemetryDirectory } from "./telemetry-files.ts";

export const TELEMETRY_LIMITS = Object.freeze({
	days: 31,
	bytes: 8 * 1024 * 1024,
	segmentBytes: 4 * 1024 * 1024,
	lineBytes: 256 * 1024,
	lines: 20_000,
	entriesPerRecord: 512,
	groups: 64,
	coverageLines: 64,
	outputBytes: 24 * 1024 - 1,
});
const CHUNK_BYTES = 64 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const DAY_MS = 86_400_000;
const RULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
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
	| "segment-byte-limit"
	| "total-byte-limit"
	| "line-limit"
	| "incomplete-line"
	| "cutoff-line"
	| "malformed-line"
	| "oversized-line";
export interface TelemetrySegmentRead {
	name: string;
	ordinal: number;
	status: "complete" | "partial" | "missing" | "unavailable" | "skipped";
	bytesRead: number;
	/** Snapshot size, or null when the segment could not be inspected. */
	size: number | null;
	/** Byte range selected from the snapshot, newest tail first. */
	startOffset: number | null;
	endOffset: number | null;
	/** Snapshot bytes not read; null means the size was not available. */
	bytesNotRead: number | null;
	/** Bytes read but not parsed after the complete-line limit. */
	unprocessedBytes: number;
	issues: TelemetryDayIssue[];
}
export interface TelemetryDay {
	day: string;
	status: "complete" | "partial" | "missing" | "unavailable" | "skipped";
	/** Segments read newest first; coverage records the offsets selected per segment. */
	segments: TelemetrySegmentRead[];
	bytesRead: number;
	unprocessedBytes: number;
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
export interface TelemetrySummary {
	from: string;
	to: string;
	calendar: "writer-local-day-files";
	coverage: {
		status: CoverageStatus;
		order: "newest-days-tail-denials-first";
		directory: "available" | "missing" | "nonregular" | "symlink" | "unreadable";
		inventory: "complete" | "incomplete";
		days: TelemetryDay[];
		bytesRead: number;
		completeLines: number;
		malformedLines: number;
		oversizedLines: number;
		incompleteLines: number;
		cutoffLines: number;
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
function dayRange(from: string, to: string): string[] {
	const first = dateValue(from);
	const last = dateValue(to);
	const count = (last - first) / DAY_MS + 1;
	if (count < 1 || count > TELEMETRY_LIMITS.days)
		throw new RangeError(`Policy telemetry needs an ordered range of at most ${TELEMETRY_LIMITS.days} days.`);
	return Array.from({ length: count }, (_, index) => new Date(first + index * DAY_MS).toISOString().slice(0, 10));
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
function initialSummary(from: string, to: string, days: string[]): TelemetrySummary {
	return {
		from,
		to,
		calendar: "writer-local-day-files",
		coverage: {
			status: "complete",
			order: "newest-days-tail-denials-first",
			directory: "available",
			inventory: "complete",
			days: days.map((day) => ({
				day,
				status: "skipped",
				segments: [],
				bytesRead: 0,
				unprocessedBytes: 0,
				issues: [],
			})),
			bytesRead: 0,
			completeLines: 0,
			malformedLines: 0,
			oversizedLines: 0,
			incompleteLines: 0,
			cutoffLines: 0,
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
function completeLineRange(
	buffer: Buffer,
	segment: TelemetrySegmentRead,
	coverage: TelemetrySummary["coverage"],
	reachesEnd: boolean,
) {
	let first = 0;
	let last = buffer.length;
	if ((segment.startOffset ?? 0) > 0) {
		first = buffer.indexOf(10) + 1;
		if (first === 0) first = buffer.length;
		coverage.cutoffLines++;
		issue(segment, "cutoff-line");
	}
	if (last > first && buffer[last - 1] !== 10) {
		last = Math.max(first, buffer.lastIndexOf(10) + 1);
		if (reachesEnd) {
			coverage.incompleteLines++;
			issue(segment, "incomplete-line");
		} else {
			coverage.cutoffLines++;
			issue(segment, "cutoff-line");
		}
	}
	return { first, last };
}
function acceptLine(
	segment: TelemetrySegmentRead,
	aggregate: Aggregator,
	oversized: boolean,
	value: RecordFields | undefined,
): void {
	const coverage = aggregate.summary.coverage;
	coverage.completeLines++;
	if (oversized) {
		coverage.oversizedLines++;
		issue(segment, "oversized-line");
	} else if (value) aggregate.accept(value);
	else {
		coverage.malformedLines++;
		issue(segment, "malformed-line");
	}
}
function parsePassLine(
	buffer: Buffer,
	start: number,
	end: number,
	segment: TelemetrySegmentRead,
	aggregate: Aggregator,
	denials: boolean,
): number {
	if (aggregate.summary.coverage.completeLines >= TELEMETRY_LIMITS.lines) return 0;
	const oversized = end - start + 1 > TELEMETRY_LIMITS.lineBytes;
	const value = oversized ? undefined : parseRecord(buffer.subarray(start, end));
	if ((value?.outcome === "denied") !== denials) return 0;
	acceptLine(segment, aggregate, oversized, value);
	return end - start + 1;
}

function parsePass(
	buffer: Buffer,
	range: { first: number; last: number },
	segment: TelemetrySegmentRead,
	aggregate: Aggregator,
	denials: boolean,
): number {
	let processed = 0;
	let end = range.last - 1;
	while (end >= range.first) {
		const start = end === 0 ? 0 : buffer.lastIndexOf(10, end - 1) + 1;
		if (start === end) {
			// Both passes visit separators; only the second accounts for their bytes.
			if (!denials) processed += 1;
		} else processed += parsePassLine(buffer, start, end, segment, aggregate, denials);
		end = start - 1;
	}
	return processed;
}
/** Two bounded passes prioritise denials without retaining a second record inventory. */
function parseLines(
	buffer: Buffer,
	segment: TelemetrySegmentRead,
	aggregate: Aggregator,
	reachesEnd: boolean,
): void {
	const range = completeLineRange(buffer, segment, aggregate.summary.coverage, reachesEnd);
	const processed =
		parsePass(buffer, range, segment, aggregate, true) + parsePass(buffer, range, segment, aggregate, false);
	segment.unprocessedBytes = Math.max(0, range.last - range.first - processed);
	if (segment.unprocessedBytes > 0) issue(segment, "line-limit");
}
async function readSnapshot(
	handle: FileHandle,
	info: Stats,
	segment: TelemetrySegmentRead,
	aggregate: Aggregator,
): Promise<void> {
	const coverage = aggregate.summary.coverage;
	segment.status = "complete";
	const remaining = TELEMETRY_LIMITS.bytes - coverage.bytesRead;
	const length = Math.min(info.size, TELEMETRY_LIMITS.segmentBytes, remaining);
	const buffer = Buffer.alloc(length);
	const startOffset = Math.max(0, info.size - length);
	segment.startOffset = startOffset;
	try {
		while (segment.bytesRead < length) {
			const result = await handle.read(
				buffer,
				segment.bytesRead,
				Math.min(CHUNK_BYTES, length - segment.bytesRead),
				startOffset + segment.bytesRead,
			);
			if (result.bytesRead === 0) break;
			segment.bytesRead += result.bytesRead;
			coverage.bytesRead += result.bytesRead;
		}
	} catch {
		issue(segment, "read-error");
	}
	segment.endOffset = startOffset + segment.bytesRead;
	segment.bytesNotRead = Math.max(0, info.size - segment.bytesRead);
	if (info.size > TELEMETRY_LIMITS.segmentBytes) issue(segment, "segment-byte-limit");
	if (info.size > remaining) issue(segment, "total-byte-limit");
	if (segment.bytesRead < length) issue(segment, "read-error");
	const after = await handle.stat();
	if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) issue(segment, "source-changed");
	parseLines(buffer.subarray(0, segment.bytesRead), segment, aggregate, segment.endOffset === info.size);
}
async function readSegment(
	entry: TelemetryInventoryEntry,
	path: string,
	segment: TelemetrySegmentRead,
	aggregate: Aggregator,
): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		const info = await handle.stat();
		if (!info.isFile() || info.ino !== entry.ino || info.dev !== entry.dev) {
			segment.status = "unavailable";
			issue(segment, "source-changed");
			return;
		}
		await readSnapshot(handle, info, segment, aggregate);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			segment.status = "missing";
			issue(segment, "missing");
		} else {
			segment.status = "unavailable";
			issue(segment, "read-error");
		}
	} finally {
		try {
			await handle?.close();
		} catch {
			issue(segment, "read-error");
		}
	}
}
function newSegment(entry: TelemetryInventoryEntry, issues: TelemetryDayIssue[]): TelemetrySegmentRead {
	return {
		name: entry.name,
		ordinal: entry.ordinal,
		status: "skipped",
		bytesRead: 0,
		size: entry.unsafe ? null : entry.size,
		startOffset: null,
		endOffset: null,
		bytesNotRead: null,
		unprocessedBytes: 0,
		issues,
	};
}
function budgetIssue(coverage: TelemetrySummary["coverage"]): TelemetryDayIssue | undefined {
	if (coverage.bytesRead >= TELEMETRY_LIMITS.bytes) return "total-byte-limit";
	return coverage.completeLines >= TELEMETRY_LIMITS.lines ? "line-limit" : undefined;
}
function summarizeDay(day: TelemetryDay): void {
	for (const segment of day.segments) {
		day.bytesRead += segment.bytesRead;
		day.unprocessedBytes += segment.unprocessedBytes;
		for (const reason of segment.issues) if (!day.issues.includes(reason)) day.issues.push(reason);
	}
	const statuses = day.segments.map((segment) => segment.status);
	if (statuses.every((status) => status === "skipped")) day.status = "skipped";
	else if (statuses.every((status) => status === "unavailable")) day.status = "unavailable";
	else day.status = statuses.every((status) => status === "complete") ? "complete" : "partial";
}
async function readDay(
	dir: string,
	entries: readonly TelemetryInventoryEntry[],
	day: TelemetryDay,
	aggregate: Aggregator,
): Promise<void> {
	if (entries.length === 0) {
		day.status = "missing";
		issue(day, "missing");
		return;
	}
	for (const entry of [...entries].reverse()) {
		const exhausted = budgetIssue(aggregate.summary.coverage);
		const segment = newSegment(entry, exhausted ? [exhausted] : []);
		day.segments.push(segment);
		if (exhausted) continue;
		if (entry.unsafe) {
			segment.status = "unavailable";
			issue(segment, entry.unsafe === "symlink" ? "symlink" : "nonregular");
		} else await readSegment(entry, join(dir, entry.name), segment, aggregate);
	}
	summarizeDay(day);
}

/** Read an inclusive range of writer-local calendar segments. No directories or files are created. */
export async function readTelemetry(dir: string, from: string, to: string): Promise<TelemetrySummary> {
	const days = dayRange(from, to).reverse();
	if (typeof dir !== "string" || dir.length === 0 || dir.length > 4096 || dir.includes("\0"))
		throw new RangeError("Policy telemetry needs a bounded directory path.");
	const summary = initialSummary(from, to, days);
	const inventory = await readTelemetryInventory(dir);
	summary.coverage.directory = inventory.directory;
	summary.coverage.inventory = inventory.incomplete ? "incomplete" : "complete";
	if (summary.coverage.directory !== "available") {
		summary.coverage.status = "unavailable";
		return summary;
	}
	const byDay = new Map<string, TelemetryInventoryEntry[]>();
	for (const entry of inventory.entries) {
		const group = byDay.get(entry.day);
		if (group) group.push(entry);
		else byDay.set(entry.day, [entry]);
	}
	const aggregate = new Aggregator(summary);
	const segments = telemetryDirectory(dir);
	for (const day of summary.coverage.days) await readDay(segments, byDay.get(day.day) ?? [], day, aggregate);
	aggregate.finish();
	const readable = summary.coverage.days.some((day) => day.status === "complete" || day.status === "partial");
	const incomplete =
		summary.coverage.inventory === "incomplete" ||
		summary.coverage.days.some((day) => day.status !== "complete") ||
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
		summary.toolNamesUnavailable > 0;
	summary.coverage.status = !readable ? "unavailable" : incomplete ? "partial" : "complete";
	return summary;
}

function segmentLine(segment: TelemetrySegmentRead): string {
	const range = `${segment.startOffset ?? "unknown"}..${segment.endOffset ?? "unknown"}`;
	return `    ${segment.name}: ${segment.status}; read ${segment.bytesRead} (range ${range}); unread ${segment.bytesNotRead ?? "unknown"}; unprocessed ${segment.unprocessedBytes}; ${segment.issues.join(", ") || "no file gaps"}`;
}
/** Day lines always show; clean segments are omitted and segment lines stop at the display bound. */
function dayCoverageLines(days: readonly TelemetryDay[]): string[] {
	const lines: string[] = [];
	let omitted = 0;
	for (const day of days) {
		lines.push(
			`  ${day.day}: ${day.status}; ${day.segments.length} segments; read ${day.bytesRead}; unprocessed ${day.unprocessedBytes}; ${day.issues.join(", ") || "no file gaps"}`,
		);
		for (const segment of day.segments) {
			if (segment.status === "complete" && segment.issues.length === 0) continue;
			if (lines.length >= TELEMETRY_LIMITS.coverageLines) omitted++;
			else lines.push(segmentLine(segment));
		}
	}
	if (omitted > 0) lines.push(`  Coverage omits ${omitted} segment lines at the display bound.`);
	return lines;
}

/** Plain bounded text. Counts describe retained records, never live coverage or worker success. */
export function formatTelemetry(summary: TelemetrySummary): string {
	const c = summary.coverage;
	const e = summary.evaluations;
	const d = summary.denials;
	const bytes = (value: number | null) => (value === null ? "unavailable (integer overflow)" : String(value));
	const coverageLines = dayCoverageLines(c.days);
	const introduction = [
		`Policy telemetry: ${summary.from} through ${summary.to} (inclusive writer-local calendar segments)`,
		`Retained evidence: ${c.status}; ${summary.records} tool records; ${d.confirmed} confirmed denials; ${summary.errors.total} errors; ${summary.truncated} truncated outputs.`,
		`Confirmed denials: ${d.confirmed}; policy-confirmed ${d.policyConfirmed}; with rule attribution ${d.withRuleAttribution}; without ${d.withoutRuleAttribution}.`,
		`Errors: ${summary.errors.total}; inferred text classes: timeout ${summary.errors.timeout}; aborted ${summary.errors.aborted}; other ${summary.errors.other}; unavailable ${summary.errors.unavailable}.`,
		`Truncated tool outputs: ${summary.truncated}; text output bytes: ${bytes(summary.outputBytes)}. Nontext payloads are excluded.`,
		"Worker outcomes: unavailable. Policy records do not record worker outcomes; a tool result does not establish a worker outcome.",
		"Tool volume (records, errors, denials, truncated, text bytes):",
	];
	const details = [
		"",
		"Evidence coverage:",
		`Directory: ${c.directory}. Inventory: ${c.inventory}.`,
		"Segments use the writer's local calendar and a per-day ordinal, not UTC timestamp filtering. Segments are read newest first, from their tails; denials precede other records within each bounded snapshot.",
		"These are per-segment snapshots, not an atomic snapshot or proof of complete live activity. Retention can remove segments during a read; every skipped, vanished, or partially read segment stays visible.",
		`Read: ${c.bytesRead} bytes; ${c.completeLines} complete lines; ${summary.records} accepted records.`,
		`Excluded lines: malformed ${c.malformedLines}; oversized ${c.oversizedLines}; incomplete ${c.incompleteLines}; byte cutoff ${c.cutoffLines}.`,
		`Outcomes: ${Object.entries(summary.outcomes)
			.map(([key, value]) => `${key} ${value}`)
			.join("; ")}.`,
		`Observation completeness: complete ${summary.observations.complete}; incomplete ${summary.observations.incomplete}; unavailable ${summary.observations.unavailable}.`,
		`Tool names unavailable: ${summary.toolNamesUnavailable}.`,
		`Rule attribution links: ${d.ruleAttributionLinks}. A denied call can count under several rules; rule totals are not distinct calls.`,
		`Rule evaluations: retained ${e.retained}; irrelevant ${bytes(e.irrelevant)}; malformed ${e.malformed}; reader omitted ${e.readerOmitted}; writer omitted ${bytes(e.writerOmitted)}.`,
		"Irrelevant evaluations are intentionally excluded, not missing decision facts. Denials outside the byte snapshots remain unknown.",
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
