/**
 * Policy registry content for the policy view and the text commands: rule, proposal and activity
 * detail lines, filters, list formatting, and the bounded readers of fire counts and recent activity.
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { ruleScopeVisibility } from "./classify.ts";
import { type PendingProposal, proposalRevision, type RuleSnapshot, ruleStoreHealthLine } from "./local-rules.ts";
import { readTelemetryInventory, TELEMETRY_DIRECTORY } from "./telemetry-files.ts";
import {
	declaredAction,
	effectiveEffect,
	effectiveState,
	factsProgram,
	permitsEffectChoice,
	type RuleMatchContext,
	type RuleRecord,
	type SessionRuleAudit,
} from "./rule.ts";

export const MAX_FIRE_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVITY_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVITY_RECORDS = 200;
const READ_CHUNK_BYTES = 64 * 1024;

type ModelFireMap = ReadonlyMap<string | null, number>;

export interface RuleFireSummary {
	fires: ReadonlyMap<string, number>;
	firesByModel: ReadonlyMap<string, ModelFireMap>;
	partial: boolean;
}

export interface PolicyActivityRecord {
	at: string;
	model: string | null;
	thinkingLevel: string | null;
	tool: string;
	classes: string[];
	blocked: boolean;
	error: boolean;
	captured?: string;
	policyMode: string;
	session: string;
	ruleStoreDegraded: boolean;
	callId?: string;
	outcome?: string;
	abortRequested?: boolean;
	observationComplete?: boolean;
	policy?: Record<string, unknown>;
}

export interface ActivityFilter {
	session?: string;
	callId?: string;
	includeUnmatched?: boolean;
}

export interface ActivityReadResult {
	records: PolicyActivityRecord[];
	partial: boolean;
	byteLimited: boolean;
	recordLimited: boolean;
	bytesRead: number;
}

export interface PolicyPanelData {
	snapshot: RuleSnapshot;
	fireSummary: RuleFireSummary;
	activity: ActivityReadResult;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove terminal controls while preserving printable text and ordinary whitespace. */
export function terminalSafe(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) => {
		const code = character.codePointAt(0) ?? 0;
		return `\\x${code.toString(16).padStart(2, "0")}`;
	});
}

function auditLines(label: string, audit: SessionRuleAudit | undefined): string[] {
	if (!audit) return [`${label}: (none)`];
	return [
		`${label}:`,
		`  at: ${audit.at}`,
		`  session: ${audit.session}`,
		`  model: ${audit.model ?? "(none)"}`,
		`  surface: ${audit.surface}`,
	];
}

function sourceText(record: RuleRecord): string {
	return record.source.kind === "package"
		? "package"
		: record.source.kind === "import"
			? `catalog import (${record.source.importId})`
			: `local (proposal ${record.source.proposalId})`;
}

function matcherText(record: RuleRecord): string {
	return record.matcher.kind === "code" ? `code (${record.matcher.key})` : `declarative (${record.matcher.language})`;
}

export function ruleDetailLines(record: RuleRecord, context: RuleMatchContext, summary: RuleFireSummary): string[] {
	const lines = [
		`id: ${record.id}`,
		`purpose: ${record.definition.purpose}`,
		`source: ${sourceText(record)}`,
		`evidence syntax: ${matcherText(record)}`,
		`authority: ${record.definition.authority}`,
		`declared action: ${JSON.stringify(declaredAction(record))}`,
		`effect control: ${permitsEffectChoice(record) ? "steer or block; steer never denies; no correction authority" : "exact action only"}`,
		`effective state: ${effectiveState(record)}`,
		`effective effect: ${effectiveEffect(record)}`,
		`definition state: ${record.definition.state}`,
		`definition effect: ${record.definition.effect}`,
		`definition revision: ${record.definition.revision}`,
		`note: ${record.definition.note}`,
		`suggestion: ${record.definition.suggestion ? JSON.stringify(record.definition.suggestion) : "(none)"}`,
		`applicability: ${record.definition.applicability ? JSON.stringify(record.definition.applicability) : "(always)"}`,
		`scope: ${record.definition.scope ? JSON.stringify(record.definition.scope) : "(none)"}`,
		ruleScopeVisibility(record, context),
		`matcher available: ${record.matcherAvailable ? "yes" : "no"}`,
		`stale override: ${record.staleOverride ? "yes" : "no"}`,
		`total fires: ${summary.fires.get(record.id) ?? 0}`,
		"fires by model:",
		...fireBreakdownLines(summary, record.id),
	];
	lines.push(
		...matcherContractLine(record),
		...programLines(record),
		...provenanceAuditLines(record),
		...overrideLines(record),
	);
	if (summary.partial) lines.push("", "[fire counts partial: store scan incomplete]");
	return lines;
}

function matcherContractLine(record: RuleRecord): string[] {
	if (record.matcher.kind !== "declarative" || record.matcher.language !== "command-shape/v1") return [];
	return [`matcher contract: ${JSON.stringify(record.matcher)}`];
}

function programLines(record: RuleRecord): string[] {
	const program = factsProgram(record);
	if (!program) return [];
	return [
		`phase: ${program.phase}`,
		`action: ${JSON.stringify(program.action)}`,
		`program: ${JSON.stringify(program)}`,
	];
}

function provenanceAuditLines(record: RuleRecord): string[] {
	if (record.source.kind === "package") return [];
	return auditLines("approved audit", record.source.approvedAudit);
}

function overrideLines(record: RuleRecord): string[] {
	if (!record.override) return ["override: (none)"];
	return [
		`override state: ${record.override.state ?? "(none)"}`,
		`override effect: ${record.override.effect ?? "(none)"}`,
		`override reason: ${record.override.reason}`,
		`override against revision: ${record.override.againstDefinitionRevision}`,
		...auditLines("override audit", record.override.audit),
	];
}

export function proposalDetailLines(proposal: PendingProposal): string[] {
	return [
		`proposal id: ${proposal.id}`,
		`proposal revision: ${proposalRevision(proposal)}`,
		...(proposal.expectedRevision ? [`expected definition revision: ${proposal.expectedRevision}`] : []),
		`operation: ${proposal.operation}`,
		`rule id: ${proposal.ruleId}`,
		`reason: ${proposal.reason}`,
		...auditLines("proposal audit", proposal.audit),
		...(proposal.candidate
			? [
					`candidate purpose: ${proposal.candidate.purpose}`,
					`candidate authority: ${proposal.candidate.authority}`,
					`candidate applicability: ${proposal.candidate.applicability ? JSON.stringify(proposal.candidate.applicability) : "(always)"}`,
					`candidate matcher: ${JSON.stringify(proposal.candidate.matcher)}`,
					`candidate note: ${proposal.candidate.note}`,
					`candidate suggestion: ${proposal.candidate.suggestion ? JSON.stringify(proposal.candidate.suggestion) : "(none)"}`,
					`candidate scope: ${proposal.candidate.scope ? JSON.stringify(proposal.candidate.scope) : "(none)"}`,
				]
			: []),
	];
}

function modelFireEntries(summary: RuleFireSummary, id: string): Array<[string | null, number]> {
	return [...(summary.firesByModel.get(id)?.entries() ?? [])].sort(
		(left, right) => right[1] - left[1] || (left[0] ?? "").localeCompare(right[0] ?? ""),
	);
}

export function fireBreakdownLines(summary: RuleFireSummary, id: string): string[] {
	const entries = modelFireEntries(summary, id);
	return entries.length === 0
		? ["  (none)"]
		: entries.map(([model, count]) => `  ${terminalSafe(model ?? "(no model)")}: ${count}`);
}

function matchesFilter(values: readonly string[], filter: string): boolean {
	if (!filter) return true;
	const needle = filter.toLocaleLowerCase();
	return values.some((value) => value.toLocaleLowerCase().includes(needle));
}

export function filteredRecords(snapshot: RuleSnapshot, filter = ""): RuleRecord[] {
	return [...snapshot.records.values()].filter((record) =>
		matchesFilter(
			[
				record.id,
				sourceText(record),
				matcherText(record),
				effectiveState(record),
				effectiveEffect(record),
				record.definition.purpose,
				record.definition.authority,
				record.definition.note,
				record.override?.reason ?? "",
			],
			filter,
		),
	);
}

export function filteredProposals(snapshot: RuleSnapshot, filter = ""): PendingProposal[] {
	return snapshot.pending.filter((proposal) =>
		matchesFilter(
			[
				proposal.id,
				proposal.operation,
				proposal.ruleId,
				proposal.reason,
				proposal.candidate?.purpose ?? "",
				proposal.candidate?.authority ?? "",
			],
			filter,
		),
	);
}

export function capText(text: string, maxBytes = 50 * 1024): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const marker = "\n[policy text truncated]";
	const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	let prefix = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
	while (Buffer.byteLength(prefix, "utf8") > budget) prefix = Array.from(prefix).slice(0, -1).join("");
	return `${prefix}${marker}`;
}

/** Text equivalent of the Rules and Proposals views. */
export function formatPolicyList(data: Pick<PolicyPanelData, "snapshot" | "fireSummary">): string {
	const lines = [
		"RULES",
		ruleStoreHealthLine(data.snapshot.health),
		`record count: ${data.snapshot.records.size} | pending proposal count: ${data.snapshot.pending.length}`,
		"",
	];
	if (data.snapshot.records.size === 0) lines.push("(none)");
	for (const record of data.snapshot.records.values()) {
		lines.push(
			[
				record.id,
				`source: ${sourceText(record)}`,
				`matcher: ${matcherText(record)}`,
				`state: ${effectiveState(record)}`,
				`effect: ${effectiveEffect(record)}`,
				`override reason: ${record.override?.reason ?? "(none)"}`,
				`override audit: ${record.override ? `${record.override.audit.surface} ${record.override.audit.at}` : "(none)"}`,
				`stale override: ${record.staleOverride ? "yes" : "no"}`,
				`available: ${record.matcherAvailable ? "yes" : "no"}`,
				`fires: ${data.fireSummary.fires.get(record.id) ?? 0}`,
				`note: ${record.definition.note}`,
			].join(" | "),
		);
	}
	lines.push("", "PENDING PROPOSALS");
	if (data.snapshot.pending.length === 0) lines.push("(none)");
	else {
		for (const proposal of data.snapshot.pending) {
			lines.push(`${proposal.id} | ${proposal.operation} | ${proposal.ruleId} | ${proposal.reason}`);
		}
	}
	if (data.fireSummary.partial) lines.push("", "firing counts partial: store scan incomplete");
	return capText(lines.map(terminalSafe).join("\n"));
}

export function formatPolicyShow(
	data: Pick<PolicyPanelData, "snapshot" | "fireSummary">,
	ref: string,
	context: RuleMatchContext,
): string | undefined {
	const health = [ruleStoreHealthLine(data.snapshot.health), ""];
	const record = data.snapshot.records.get(ref);
	if (record)
		return capText([...health, ...ruleDetailLines(record, context, data.fireSummary)].map(terminalSafe).join("\n"));
	const proposal = data.snapshot.pending.find((entry) => entry.id === ref);
	if (proposal) return capText([...health, ...proposalDetailLines(proposal)].map(terminalSafe).join("\n"));
	return undefined;
}

const DECISION_SCALAR_NAMES = ["decision", "inputCorrected", "resultCorrected"] as const;
const ENTRY_GROUP_NAMES = ["evaluations", "corrections", "generations", "metadata", "dataSnapshots"] as const;
const RETAINED_ENTRY_KEYS = [
	"id",
	"revision",
	"phase",
	"inputView",
	"applicable",
	"truth",
	"action",
	"stage",
	"unavailable",
	"deny",
	"generation",
	"label",
	"name",
	"status",
	"capturedAt",
	"ageMs",
	"maxAgeMs",
	"snapshotAt",
] as const;

function retainedScalar(field: unknown): boolean {
	return typeof field === "boolean" || (typeof field === "string" && field.length <= 80);
}

function retainedEntryField(field: unknown): boolean {
	return (
		typeof field === "boolean" ||
		(typeof field === "number" && Number.isFinite(field)) ||
		(typeof field === "string" && field.length <= 160)
	);
}

function validReasonCodes(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 16 &&
		value.every((reason: unknown) => typeof reason === "string" && reason.length <= 80 && /^[a-z0-9.-]+$/.test(reason))
	);
}

function validPath(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 16 &&
		value.every((key: unknown) => typeof key === "string" && key.length <= 128)
	);
}

function retainedEntry(entry: unknown, name: string): Record<string, unknown> {
	if (!isObject(entry)) return {};
	const item: Record<string, unknown> = {};
	for (const key of RETAINED_ENTRY_KEYS) {
		const field = entry[key];
		if (retainedEntryField(field)) item[key] = field;
	}
	if (name === "evaluations" && validReasonCodes(entry.unavailableReasons)) item.unavailableReasons = [...entry.unavailableReasons];
	if (validPath(entry.path)) item.path = [...entry.path];
	return item;
}

function retainedEntries(name: string, entries: unknown[]): unknown[] {
	return entries.slice(0, 64).flatMap((entry: unknown) => {
		if (!isObject(entry)) return [];
		return [retainedEntry(entry, name)];
	});
}

function coverageMatches(entries: unknown, counts: unknown, selected: boolean): counts is { total: number; omitted: number; irrelevant?: number } {
	if (!isObject(counts) || !Array.isArray(entries)) return false;
	if (typeof counts.total !== "number" || typeof counts.omitted !== "number") return false;
	if (!Number.isSafeInteger(counts.total) || !Number.isSafeInteger(counts.omitted)) return false;
	const irrelevant = selected ? counts.irrelevant : 0;
	if (typeof irrelevant !== "number" || !Number.isSafeInteger(irrelevant) || irrelevant < 0) return false;
	return counts.omitted >= 0 && counts.total === entries.length + counts.omitted + irrelevant;
}

function readCoverage(value: Record<string, unknown>, result: Record<string, unknown>): void {
	const raw = value.coverage;
	if (!isObject(raw)) return;
	const coverage: Record<string, unknown> = {};
	for (const name of ENTRY_GROUP_NAMES) {
		const counts = raw[name];
		const entries = value[name];
		if (coverageMatches(entries, counts, name === "evaluations" || name === "generations"))
			coverage[name] = { total: counts.total, omitted: counts.omitted,
				...(counts.irrelevant !== undefined ? { irrelevant: counts.irrelevant } : {}) };
		else if (counts !== undefined) result.coverageUnavailable = true;
	}
	result.recordedCoverage = coverage;
}

function readDecisionSummary(value: unknown): Record<string, unknown> | undefined {
	if (!isObject(value)) return undefined;
	const result: Record<string, unknown> = {};
	for (const name of DECISION_SCALAR_NAMES) {
		const field = value[name];
		if (retainedScalar(field)) result[name] = field;
	}
	for (const name of ENTRY_GROUP_NAMES) {
		const entries = value[name];
		if (!Array.isArray(entries)) continue;
		result[name] = retainedEntries(name, entries);
		if (entries.length > 64) result[`${name}OmittedFromView`] = entries.length - 64;
	}
	const preGuidanceBytes = value.preGuidanceBytes;
	if (typeof preGuidanceBytes === "number" && Number.isSafeInteger(preGuidanceBytes) && preGuidanceBytes >= 0)
		result.preGuidanceBytes = preGuidanceBytes;
	readCoverage(value, result);
	return result;
}

function retainedClasses(classes: unknown[]): string[] {
	return [...new Set(classes.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}

function attachOptionalFields(value: Record<string, unknown>, record: PolicyActivityRecord): void {
	if (typeof value.captured === "string") record.captured = value.captured;
	if (typeof value.callId === "string" && value.callId.length <= 256) record.callId = value.callId;
	if (typeof value.outcome === "string" && value.outcome.length <= 40) record.outcome = value.outcome;
	if (typeof value.abortRequested === "boolean") record.abortRequested = value.abortRequested;
	if (typeof value.observationComplete === "boolean") record.observationComplete = value.observationComplete;
}

function readActivityRecord(value: unknown, includeUnmatched = false): PolicyActivityRecord | undefined {
	if (!isObject(value)) return undefined;
	if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) return undefined;
	if (!Array.isArray(value.classes)) return undefined;
	const classes = retainedClasses(value.classes);
	if (classes.length === 0 && !includeUnmatched) return undefined;
	const record: PolicyActivityRecord = {
		at: value.at,
		model: typeof value.model === "string" ? value.model : null,
		thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : null,
		tool: typeof value.tool === "string" ? value.tool : "(unknown)",
		classes,
		blocked: value.blocked === true,
		error: value.error === true,
		policyMode: typeof value.policyMode === "string" ? value.policyMode : "(unknown)",
		session: typeof value.session === "string" ? value.session : "(unknown)",
		ruleStoreDegraded: value.ruleStoreDegraded === true,
	};
	attachOptionalFields(value, record);
	const policy = readDecisionSummary(value.policy);
	if (policy) record.policy = policy;
	return record;
}

async function readFileTail(
	path: string,
	byteLimit: number,
): Promise<{ buffer: Buffer; bytesRead: number; complete: boolean }> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let bytesRead = 0;
	try {
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Policy telemetry source is not a regular file");
		const size = info.size;
		const length = Math.min(size, Math.max(0, byteLimit));
		const start = size - length;
		const buffer = Buffer.alloc(length);
		while (bytesRead < length) {
			const result = await handle.read(
				buffer,
				bytesRead,
				Math.min(READ_CHUNK_BYTES, length - bytesRead),
				start + bytesRead,
			);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		return { buffer: buffer.subarray(0, bytesRead), bytesRead, complete: start === 0 && bytesRead === length };
	} finally {
		await handle?.close();
	}
}

function normalizeBound(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/** Segment names oldest first; an undefined result means the directory itself could not be read. */
async function listDailyFiles(dir: string): Promise<{ names: string[]; partial: boolean } | undefined> {
	const inventory = await readTelemetryInventory(dir);
	if (inventory.directory === "missing") return { names: [], partial: false };
	if (inventory.directory !== "available") return undefined;
	return {
		names: inventory.entries.filter((entry) => entry.unsafe === null).map((entry) => entry.name),
		partial: inventory.incomplete || inventory.entries.some((entry) => entry.unsafe !== null),
	};
}

/** Record matching the activity filter, or undefined for malformed or filtered lines. */
function matchingRecord(line: string, filter: ActivityFilter): PolicyActivityRecord | undefined {
	try {
		const record = readActivityRecord(JSON.parse(line) as unknown, filter.includeUnmatched);
		if (!record) return undefined;
		if (filter.session !== undefined && record.session !== filter.session) return undefined;
		if (filter.callId !== undefined && record.callId !== filter.callId) return undefined;
		return record;
	} catch {
		return undefined;
	}
}

/** Keep only the part after the first newline so a cut first record cannot be counted twice. */
function trimTailBuffer(buffer: Buffer): Buffer {
	const newline = buffer.indexOf(0x0a);
	return newline === -1 ? Buffer.alloc(0) : buffer.subarray(newline + 1);
}

function collectActivityLines(buffer: Buffer, filter: ActivityFilter, matched: PolicyActivityRecord[]): void {
	for (const line of buffer.toString("utf8").split(/\r?\n/).reverse()) {
		if (!line) continue;
		const record = matchingRecord(line, filter);
		if (record) matched.push(record);
	}
}

function sortByTimeDescending(records: PolicyActivityRecord[]): void {
	records.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

/** Read newest daily-record tails only, then order matched records by timestamp. */
export async function readRecentActivity(
	dir: string,
	byteBound: number = MAX_ACTIVITY_SCAN_BYTES,
	recordLimit: number = MAX_ACTIVITY_RECORDS,
	filter: ActivityFilter = {},
): Promise<ActivityReadResult> {
	const normalizedBytes = normalizeBound(byteBound, MAX_ACTIVITY_SCAN_BYTES);
	const normalizedRecords = normalizeBound(recordLimit, MAX_ACTIVITY_RECORDS);
	const listed = await listDailyFiles(dir);
	if (listed === undefined)
		return { records: [], partial: true, byteLimited: false, recordLimited: false, bytesRead: 0 };
	const files = [...listed.names].reverse();
	if (files.length === 0)
		return { records: [], partial: listed.partial, byteLimited: false, recordLimited: false, bytesRead: 0 };
	const segments = join(dir, TELEMETRY_DIRECTORY);
	const matched: PolicyActivityRecord[] = [];
	let remaining = normalizedBytes;
	let bytesRead = 0;
	let byteLimited = false;
	for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
		if (remaining === 0) {
			byteLimited = true;
			break;
		}
		let tail: Awaited<ReturnType<typeof readFileTail>>;
		try {
			tail = await readFileTail(join(segments, files[fileIndex]), remaining);
		} catch {
			sortByTimeDescending(matched);
			return {
				records: matched.slice(0, normalizedRecords),
				partial: true,
				byteLimited,
				recordLimited: matched.length > normalizedRecords,
				bytesRead,
			};
		}
		bytesRead += tail.bytesRead;
		remaining -= tail.bytesRead;
		if (!tail.complete) {
			byteLimited = true;
			collectActivityLines(trimTailBuffer(tail.buffer), filter, matched);
			break;
		}
		collectActivityLines(tail.buffer, filter, matched);
		if (fileIndex < files.length - 1 && remaining === 0) byteLimited = true;
	}
	sortByTimeDescending(matched);
	const recordLimited = matched.length > normalizedRecords;
	return {
		records: matched.slice(0, normalizedRecords),
		partial: listed.partial || byteLimited || recordLimited,
		byteLimited,
		recordLimited,
		bytesRead,
	};
}

function mergeLine(fragments: Buffer[], fragmentBytes: number, tail: Buffer): Buffer {
	if (fragments.length === 0) return tail;
	if (tail.length > 0) fragments.push(tail);
	return Buffer.concat(fragments, fragmentBytes + tail.length);
}

/** Feed whole lines from one chunk, returning the fragment state the caller owns. */
function consumeChunk(
	chunk: Buffer,
	fragments: Buffer[],
	fragmentBytes: number,
	consumeLine: (line: Buffer) => void,
): { fragments: Buffer[]; fragmentBytes: number } {
	let next = fragments;
	let nextBytes = fragmentBytes;
	let start = 0;
	for (let index = 0; index < chunk.length; index++) {
		if (chunk[index] !== 0x0a) continue;
		consumeLine(mergeLine(next, nextBytes, chunk.subarray(start, index)));
		next = [];
		nextBytes = 0;
		start = index + 1;
	}
	if (start < chunk.length) {
		const tail = chunk.subarray(start);
		next.push(tail);
		nextBytes += tail.length;
	}
	return { fragments: next, fragmentBytes: nextBytes };
}

async function scanJsonlPrefix(
	path: string,
	byteBound: number,
	consumeLine: (line: Buffer) => void,
): Promise<{ bytesRead: number; complete: boolean }> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let bytesRead = 0;
	let complete = false;
	try {
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Policy telemetry source is not a regular file");
		const size = info.size;
		let position = 0;
		let fragments: Buffer[] = [];
		let fragmentBytes = 0;
		while (position < size && bytesRead < byteBound) {
			const length = Math.min(READ_CHUNK_BYTES, size - position, byteBound - bytesRead);
			const buffer = Buffer.allocUnsafe(length);
			const result = await handle.read(buffer, 0, length, position);
			if (result.bytesRead === 0) break;
			const state = consumeChunk(buffer.subarray(0, result.bytesRead), fragments, fragmentBytes, consumeLine);
			fragments = state.fragments;
			fragmentBytes = state.fragmentBytes;
			position += result.bytesRead;
			bytesRead += result.bytesRead;
		}
		complete = position >= size;
		if (complete && fragmentBytes > 0)
			consumeLine(fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes));
	} catch {
		complete = false;
	} finally {
		try {
			await handle?.close();
		} catch {
			complete = false;
		}
	}
	return { bytesRead, complete };
}

function countFireRecord(
	classes: unknown[],
	model: string | null,
	fires: Map<string, number>,
	firesByModel: Map<string, Map<string | null, number>>,
): void {
	for (const id of classes) {
		if (typeof id !== "string") continue;
		fires.set(id, (fires.get(id) ?? 0) + 1);
		let models = firesByModel.get(id);
		if (!models) {
			models = new Map();
			firesByModel.set(id, models);
		}
		models.set(model, (models.get(model) ?? 0) + 1);
	}
}

/** Parse one telemetry line and add its class ids to the fire maps. */
function makeFireCounter(
	fires: Map<string, number>,
	firesByModel: Map<string, Map<string | null, number>>,
): (line: Buffer) => void {
	return (line: Buffer): void => {
		if (line.length === 0) return;
		try {
			const value: unknown = JSON.parse(line.toString("utf8"));
			if (!isObject(value) || !Array.isArray(value.classes)) return;
			countFireRecord(value.classes, typeof value.model === "string" ? value.model : null, fires, firesByModel);
		} catch {
			// One malformed telemetry record does not hide valid counts around it.
		}
	};
}

/** Count rule firings through one bounded scan of daily store files. */
export async function readFireSummary(dir: string, byteBound: number = MAX_FIRE_SCAN_BYTES): Promise<RuleFireSummary> {
	const fires = new Map<string, number>();
	const firesByModel = new Map<string, Map<string | null, number>>();
	const countLine = makeFireCounter(fires, firesByModel);
	const listed = await listDailyFiles(dir);
	if (listed === undefined) return { fires, firesByModel, partial: true };
	try {
		const segments = join(dir, TELEMETRY_DIRECTORY);
		let remaining = normalizeBound(byteBound, MAX_FIRE_SCAN_BYTES);
		for (const file of listed.names) {
			const scanned = await scanJsonlPrefix(join(segments, file), remaining, countLine);
			remaining -= scanned.bytesRead;
			if (!scanned.complete) return { fires, firesByModel, partial: true };
		}
		return { fires, firesByModel, partial: listed.partial };
	} catch {
		return { fires, firesByModel, partial: true };
	}
}

export function activityKey(record: PolicyActivityRecord): string {
	return `${record.at}\0${record.session}\0${record.tool}\0${record.classes.join(",")}\0${record.captured ?? ""}`;
}

export function activityDetailLines(record: PolicyActivityRecord, activity: ActivityReadResult): string[] {
	return [
		`time: ${record.at}`,
		`model: ${record.model ?? "(none)"}`,
		`thinking: ${record.thinkingLevel ?? "(none)"}`,
		`rule ids: ${record.classes.join(", ")}`,
		`blocked: ${record.blocked ? "yes" : "no"}`,
		`error: ${record.error ? "yes" : "no"}`,
		`tool: ${record.tool}`,
		`policy mode: ${record.policyMode}`,
		`rule store degraded: ${record.ruleStoreDegraded ? "yes" : "no"}`,
		`session: ${record.session}`,
		"",
		"redacted command:",
		record.captured ?? "(not captured)",
		...(activity.partial ? ["", "[activity is partial because a configured scan bound was reached]"] : []),
	];
}
