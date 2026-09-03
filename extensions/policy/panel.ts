/** Interactive unified rule browser plus bounded telemetry readers and formatters. */

import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { ruleScopeVisibility } from "./classify.ts";
import { ruleStoreHealthLine, type PendingProposal, type RuleSnapshot } from "./local-rules.ts";
import {
	effectiveEffect,
	effectiveState,
	type RuleEffect,
	type RuleMatchContext,
	type RuleRecord,
	type SessionRuleAudit,
} from "./rule.ts";

export const MAX_FIRE_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVITY_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVITY_RECORDS = 200;
const MAX_PANEL_ROWS = 46;
const READ_CHUNK_BYTES = 64 * 1024;
const DAILY_STORE_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export type PolicyView = "rules" | "proposals" | "activity";
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

export interface PolicyPanelResult {
	view: PolicyView;
	filter: string;
	selectedRuleId?: string;
	selectedProposalId?: string;
	selectedActivityKey?: string;
}

export interface PanelActionResult {
	snapshot: RuleSnapshot;
	outcome: string;
}

export interface PolicyPanelActionHost {
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	approve(proposalId: string, effect?: RuleEffect): Promise<PanelActionResult>;
	reject(proposalId: string): Promise<PanelActionResult>;
}

interface PolicyPanelDeps {
	data: PolicyPanelData;
	scopeContext: RuleMatchContext;
	theme: Theme;
	tui: { requestRender(): void };
	getMaxRows: () => number;
	done: (result: PolicyPanelResult) => void;
	actionHost?: PolicyPanelActionHost;
	initialView?: PolicyView;
	initialFilter?: string;
	initialSelectedRuleId?: string;
	initialSelectedProposalId?: string;
	initialSelectedActivityKey?: string;
}

interface Layout {
	total: number;
	framed: boolean;
	bodyRows: number;
	innerWidth: number;
	listWidth: number;
	detailWidth: number;
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

function oneLine(value: string): string {
	return terminalSafe(value)
		.replace(/[\r\n]+/g, "↵")
		.replace(/\s+/g, " ")
		.trim();
}

function fitText(text: string, width: number): string {
	if (width <= 0) return "";
	const hadAnsi = text.includes("\x1b");
	let fitted = truncateToWidth(text, width);
	if (!hadAnsi) fitted = fitted.replace(/\x1b\[[0-9;]*m/g, "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function keepTail(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const characters = Array.from(text);
	while (characters.length > 0 && visibleWidth(`…${characters.join("")}`) > width) characters.shift();
	return `…${characters.join("")}`;
}

export function computePolicyPanes(innerWidth: number, dividerWidth = 3): { listWidth: number; detailWidth: number } {
	const available = Math.max(2, innerWidth - dividerWidth);
	let listWidth = Math.max(44, Math.min(86, Math.floor(innerWidth * 0.58)));
	let detailWidth = available - listWidth;
	if (detailWidth < 32) {
		listWidth = Math.max(24, available - 32);
		detailWidth = available - listWidth;
	}
	if (detailWidth < 8) {
		detailWidth = Math.max(1, Math.min(8, available - 1));
		listWidth = Math.max(1, available - detailWidth);
	}
	return { listWidth, detailWidth };
}

function computeLayout(maxRows: number, width: number): Layout {
	const total = Math.min(MAX_PANEL_ROWS, Math.max(1, Math.floor(maxRows)));
	if (total < 6 || width < 78) {
		return {
			total,
			framed: false,
			bodyRows: Math.max(0, total - 2),
			innerWidth: width,
			listWidth: width,
			detailWidth: 0,
		};
	}
	const innerWidth = Math.max(1, width - 4);
	return { total, framed: true, bodyRows: Math.max(1, total - 4), innerWidth, ...computePolicyPanes(innerWidth) };
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
	return record.source.kind === "package" ? "package" : `local (proposal ${record.source.proposalId})`;
}

function matcherText(record: RuleRecord): string {
	return record.matcher.kind === "code" ? `code (${record.matcher.key})` : `declarative (${record.matcher.language})`;
}

export function ruleDetailLines(
	record: RuleRecord,
	context: RuleMatchContext,
	summary: RuleFireSummary,
	catalogCollision = false,
): string[] {
	const lines = [
		`id: ${record.id}`,
		`source: ${sourceText(record)}`,
		`matcher: ${matcherText(record)}`,
		`effective state: ${effectiveState(record)}`,
		`effective effect: ${effectiveEffect(record)}`,
		`definition state: ${record.definition.state}`,
		`definition effect: ${record.definition.effect}`,
		`definition revision: ${record.definition.revision}`,
		`note: ${record.definition.note}`,
		`suggestion: ${record.definition.suggestion ? JSON.stringify(record.definition.suggestion) : "(none)"}`,
		`scope: ${record.definition.scope ? JSON.stringify(record.definition.scope) : "(none)"}`,
		ruleScopeVisibility(record, context),
		`matcher available: ${record.matcherAvailable ? "yes" : "no"}`,
		`catalog collision: ${catalogCollision ? "yes (local record retained; installed package row skipped)" : "no"}`,
		`stale override: ${record.staleOverride ? "yes" : "no"}`,
		`total fires: ${summary.fires.get(record.id) ?? 0}`,
		"fires by model:",
		...fireBreakdownLines(summary, record.id),
	];
	if (record.source.kind === "local") lines.push(...auditLines("approved audit", record.source.approvedAudit));
	if (record.override) {
		lines.push(
			`override state: ${record.override.state ?? "(none)"}`,
			`override effect: ${record.override.effect ?? "(none)"}`,
			`override reason: ${record.override.reason}`,
			`override against revision: ${record.override.againstDefinitionRevision}`,
			...auditLines("override audit", record.override.audit),
		);
	} else lines.push("override: (none)");
	if (summary.partial) lines.push("", `[fire counts partial: ${MAX_FIRE_SCAN_BYTES} byte scan bound reached]`);
	return lines;
}

export function proposalDetailLines(proposal: PendingProposal): string[] {
	return [
		`proposal id: ${proposal.id}`,
		`operation: ${proposal.operation}`,
		`rule id: ${proposal.ruleId}`,
		`reason: ${proposal.reason}`,
		...auditLines("proposal audit", proposal.audit),
		...(proposal.candidate
			? [
					`candidate domain: ${proposal.candidate.domain}`,
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
				record.definition.note,
				record.override?.reason ?? "",
			],
			filter,
		),
	);
}

function filteredProposals(snapshot: RuleSnapshot, filter = ""): PendingProposal[] {
	return snapshot.pending.filter((proposal) =>
		matchesFilter([proposal.id, proposal.operation, proposal.ruleId, proposal.reason], filter),
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
	if (data.fireSummary.partial)
		lines.push("", `firing counts partial: store scan exceeded ${MAX_FIRE_SCAN_BYTES} bytes`);
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
		return capText(
			[
				...health,
				...ruleDetailLines(
					record,
					context,
					data.fireSummary,
					data.snapshot.health.catalogCollisions?.includes(record.id) === true,
				),
			]
				.map(terminalSafe)
				.join("\n"),
		);
	const proposal = data.snapshot.pending.find((entry) => entry.id === ref);
	if (proposal) return capText([...health, ...proposalDetailLines(proposal)].map(terminalSafe).join("\n"));
	return undefined;
}

function readActivityRecord(value: unknown): PolicyActivityRecord | undefined {
	if (!isObject(value) || typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) return undefined;
	if (!Array.isArray(value.classes)) return undefined;
	const classes = [
		...new Set(value.classes.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)),
	];
	if (classes.length === 0) return undefined;
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
	if (typeof value.captured === "string") record.captured = value.captured;
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
		handle = await open(path, constants.O_RDONLY | noFollow);
		const size = (await handle.stat()).size;
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

/** Read newest daily-record tails only, then order matched records by timestamp. */
export async function readRecentActivity(
	dir: string,
	byteBound: number = MAX_ACTIVITY_SCAN_BYTES,
	recordLimit: number = MAX_ACTIVITY_RECORDS,
): Promise<ActivityReadResult> {
	const normalizedBytes = Number.isFinite(byteBound) ? Math.max(0, Math.floor(byteBound)) : MAX_ACTIVITY_SCAN_BYTES;
	const normalizedRecords = Number.isFinite(recordLimit) ? Math.max(0, Math.floor(recordLimit)) : MAX_ACTIVITY_RECORDS;
	let files: string[];
	try {
		files = (await readdir(dir))
			.filter((name) => DAILY_STORE_FILE.test(name))
			.sort()
			.reverse();
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			return { records: [], partial: false, byteLimited: false, recordLimited: false, bytesRead: 0 };
		}
		return { records: [], partial: true, byteLimited: false, recordLimited: false, bytesRead: 0 };
	}
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
			tail = await readFileTail(join(dir, files[fileIndex]), remaining);
		} catch {
			return {
				records: matched.sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, normalizedRecords),
				partial: true,
				byteLimited,
				recordLimited: matched.length > normalizedRecords,
				bytesRead,
			};
		}
		bytesRead += tail.bytesRead;
		remaining -= tail.bytesRead;
		let buffer = tail.buffer;
		if (!tail.complete) {
			byteLimited = true;
			const newline = buffer.indexOf(0x0a);
			buffer = newline === -1 ? Buffer.alloc(0) : buffer.subarray(newline + 1);
		}
		const lines = buffer.toString("utf8").split(/\r?\n/);
		for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
			const line = lines[lineIndex];
			if (!line) continue;
			try {
				const record = readActivityRecord(JSON.parse(line) as unknown);
				if (record) matched.push(record);
			} catch {
				// One malformed telemetry record does not hide valid activity around it.
			}
		}
		if (!tail.complete) break;
		if (fileIndex < files.length - 1 && remaining === 0) byteLimited = true;
	}
	matched.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
	const recordLimited = matched.length > normalizedRecords;
	return {
		records: matched.slice(0, normalizedRecords),
		partial: byteLimited || recordLimited,
		byteLimited,
		recordLimited,
		bytesRead,
	};
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
		handle = await open(path, constants.O_RDONLY | noFollow);
		const size = (await handle.stat()).size;
		let position = 0;
		let fragments: Buffer[] = [];
		let fragmentBytes = 0;
		while (position < size && bytesRead < byteBound) {
			const length = Math.min(READ_CHUNK_BYTES, size - position, byteBound - bytesRead);
			const buffer = Buffer.allocUnsafe(length);
			const result = await handle.read(buffer, 0, length, position);
			if (result.bytesRead === 0) break;
			const chunk = buffer.subarray(0, result.bytesRead);
			let start = 0;
			for (let index = 0; index < chunk.length; index++) {
				if (chunk[index] !== 0x0a) continue;
				const tail = chunk.subarray(start, index);
				let line = tail;
				if (fragments.length > 0) {
					if (tail.length > 0) fragments.push(tail);
					line = Buffer.concat(fragments, fragmentBytes + tail.length);
				}
				consumeLine(line);
				fragments = [];
				fragmentBytes = 0;
				start = index + 1;
			}
			if (start < chunk.length) {
				const tail = chunk.subarray(start);
				fragments.push(tail);
				fragmentBytes += tail.length;
			}
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

/** Count rule firings through one bounded scan of daily store files. */
export async function readFireSummary(dir: string, byteBound: number = MAX_FIRE_SCAN_BYTES): Promise<RuleFireSummary> {
	const fires = new Map<string, number>();
	const firesByModel = new Map<string, Map<string | null, number>>();
	const countLine = (line: Buffer): void => {
		if (line.length === 0) return;
		try {
			const value: unknown = JSON.parse(line.toString("utf8"));
			if (!isObject(value) || !Array.isArray(value.classes)) return;
			const model = typeof value.model === "string" ? value.model : null;
			for (const id of value.classes) {
				if (typeof id !== "string") continue;
				fires.set(id, (fires.get(id) ?? 0) + 1);
				let models = firesByModel.get(id);
				if (!models) {
					models = new Map();
					firesByModel.set(id, models);
				}
				models.set(model, (models.get(model) ?? 0) + 1);
			}
		} catch {
			// One malformed telemetry record does not hide valid counts around it.
		}
	};
	try {
		const files = (await readdir(dir)).filter((name) => DAILY_STORE_FILE.test(name)).sort();
		let remaining = Number.isFinite(byteBound) ? Math.max(0, Math.floor(byteBound)) : MAX_FIRE_SCAN_BYTES;
		for (const file of files) {
			const scanned = await scanJsonlPrefix(join(dir, file), remaining, countLine);
			remaining -= scanned.bytesRead;
			if (!scanned.complete) return { fires, firesByModel, partial: true };
		}
		return { fires, firesByModel, partial: false };
	} catch (error) {
		return { fires, firesByModel, partial: (error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT" };
	}
}

function wrapDetail(lines: readonly string[], width: number): string[] {
	const wrapped: string[] = [];
	for (const source of lines) {
		for (const part of terminalSafe(source).split("\n")) {
			const rendered = wrapTextWithAnsi(part, Math.max(8, width));
			wrapped.push(...(rendered.length > 0 ? rendered : [""]));
		}
	}
	return wrapped;
}

function activityKey(record: PolicyActivityRecord): string {
	return `${record.at}\0${record.session}\0${record.tool}\0${record.classes.join(",")}\0${record.captured ?? ""}`;
}

function activityDetailLines(record: PolicyActivityRecord, activity: ActivityReadResult): string[] {
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

export class PolicyPanel {
	private readonly deps: PolicyPanelDeps;
	private view: PolicyView;
	private filter: string;
	private filtering = false;
	private selectedRule = 0;
	private selectedProposal = 0;
	private selectedActivity = 0;
	private listScroll = 0;
	private detailScroll = 0;
	private outcome = "";
	private actionPending = false;
	private version = 0;
	private lastWidth = 112;
	private cachedWidth = -1;
	private cachedRows = -1;
	private cachedVersion = -1;
	private cachedLines: string[] = [];

	constructor(deps: PolicyPanelDeps) {
		this.deps = deps;
		this.view = deps.initialView ?? "rules";
		this.filter = deps.initialFilter ?? "";
		if (deps.initialSelectedRuleId) {
			const selected = this.rules.findIndex((record) => record.id === deps.initialSelectedRuleId);
			if (selected >= 0) this.selectedRule = selected;
		}
		if (deps.initialSelectedProposalId) {
			const selected = this.proposals.findIndex((proposal) => proposal.id === deps.initialSelectedProposalId);
			if (selected >= 0) this.selectedProposal = selected;
		}
		if (deps.initialSelectedActivityKey) {
			const selected = deps.data.activity.records.findIndex(
				(record) => activityKey(record) === deps.initialSelectedActivityKey,
			);
			if (selected >= 0) this.selectedActivity = selected;
		}
	}

	private get rules(): RuleRecord[] {
		return filteredRecords(this.deps.data.snapshot, this.filter);
	}

	private get proposals(): PendingProposal[] {
		return filteredProposals(this.deps.data.snapshot, this.filter);
	}

	private currentRule(): RuleRecord | undefined {
		return this.rules[this.selectedRule];
	}

	private currentProposal(): PendingProposal | undefined {
		return this.proposals[this.selectedProposal];
	}

	private currentActivity(): PolicyActivityRecord | undefined {
		return this.deps.data.activity.records[this.selectedActivity];
	}

	private layout(width = this.lastWidth): Layout {
		return computeLayout(this.deps.getMaxRows(), width);
	}

	private itemCount(): number {
		return this.view === "rules"
			? this.rules.length
			: this.view === "proposals"
				? this.proposals.length
				: this.deps.data.activity.records.length;
	}

	private selectedIndex(): number {
		return this.view === "rules"
			? this.selectedRule
			: this.view === "proposals"
				? this.selectedProposal
				: this.selectedActivity;
	}

	private detailSource(width = this.layout().detailWidth): string[] {
		const status = this.outcome ? ["", this.outcome] : [];
		const health = [ruleStoreHealthLine(this.deps.data.snapshot.health), ""];
		if (this.view === "rules") {
			const record = this.currentRule();
			return wrapDetail(
				record
					? [
							...status,
							...health,
							...ruleDetailLines(
								record,
								this.deps.scopeContext,
								this.deps.data.fireSummary,
								this.deps.data.snapshot.health.catalogCollisions?.includes(record.id) === true,
							),
						]
					: [...health, "No rules match the filter.", ...status],
				width,
			);
		}
		if (this.view === "proposals") {
			const proposal = this.currentProposal();
			return wrapDetail(
				proposal
					? [...status, ...health, ...proposalDetailLines(proposal)]
					: [...health, "No pending proposals match the filter.", ...status],
				width,
			);
		}
		const record = this.currentActivity();
		return wrapDetail(
			record
				? [...health, ...activityDetailLines(record, this.deps.data.activity)]
				: [...health, "No matched policy activity."],
			width,
		);
	}

	private pageSize(): number {
		return Math.max(1, this.layout().bodyRows - 1);
	}

	private detailMaxScroll(): number {
		const layout = this.layout();
		return Math.max(0, this.detailSource(layout.detailWidth).length - layout.bodyRows);
	}

	private bump(): void {
		this.version++;
		this.deps.tui.requestRender();
	}

	private move(delta: number): void {
		const last = Math.max(0, this.itemCount() - 1);
		if (this.view === "rules") this.selectedRule = Math.max(0, Math.min(last, this.selectedRule + delta));
		else if (this.view === "proposals")
			this.selectedProposal = Math.max(0, Math.min(last, this.selectedProposal + delta));
		else this.selectedActivity = Math.max(0, Math.min(last, this.selectedActivity + delta));
		this.detailScroll = 0;
	}

	private finish(): void {
		this.deps.done({
			view: this.view,
			filter: this.filter,
			selectedRuleId: this.currentRule()?.id,
			selectedProposalId: this.currentProposal()?.id,
			selectedActivityKey: this.currentActivity() ? activityKey(this.currentActivity()!) : undefined,
		});
	}

	private async runProposalAction(action: "approve" | "reject"): Promise<void> {
		const host = this.deps.actionHost;
		const proposal = this.currentProposal();
		if (!host || !proposal || this.actionPending) return;
		this.actionPending = true;
		this.outcome = "working…";
		this.bump();
		try {
			let effect: RuleEffect | undefined;
			if (action === "approve" && proposal.operation === "add") {
				const selected = await host.select(`Choose effect for ${proposal.ruleId}`, ["steer", "block"]);
				if (selected !== "steer" && selected !== "block") return;
				effect = selected;
			}
			const decision = action === "approve" ? "approve" : "reject";
			const effectText = effect ? ` with effect ${effect}` : "";
			const confirmed = await host.confirm(
				`${decision === "approve" ? "Approve" : "Reject"} policy proposal`,
				`${decision === "approve" ? "Approve" : "Reject"} ${proposal.operation} proposal ${proposal.id} for ${proposal.ruleId}${effectText}?`,
			);
			if (!confirmed) return;
			const result = action === "approve" ? await host.approve(proposal.id, effect) : await host.reject(proposal.id);
			this.applyResult(result);
		} catch (error) {
			this.outcome = `Action failed: ${terminalSafe(error instanceof Error ? error.message : String(error))}`;
		} finally {
			if (this.outcome === "working…") this.outcome = "Action cancelled.";
			this.actionPending = false;
			this.detailScroll = 0;
			this.bump();
		}
	}

	private applyResult(result: PanelActionResult): void {
		this.deps.data.snapshot = result.snapshot;
		this.outcome = terminalSafe(result.outcome);
		this.selectedRule = Math.min(this.selectedRule, Math.max(0, this.rules.length - 1));
		this.selectedProposal = Math.min(this.selectedProposal, Math.max(0, this.proposals.length - 1));
	}

	private showRuleActionCommand(action: "disable" | "enable" | "effect" | "retire"): void {
		const record = this.currentRule();
		if (!record) return;
		if (action === "retire" && record.source.kind !== "local") {
			this.outcome = "Only local rules can be retired.";
		} else {
			const tail = action === "effect" ? "<steer|block> <reason...>" : "<reason...>";
			this.outcome = `Run: /policy ${action} ${record.id} ${tail}`;
		}
		this.detailScroll = 0;
		this.bump();
	}

	handleInput(raw: string): void {
		const decoded = decodeKittyPrintable(raw);
		const data = decoded ?? raw;
		if (this.filtering) {
			if (matchesKey(raw, "escape") || matchesKey(raw, "enter")) this.filtering = false;
			else if (matchesKey(raw, "backspace")) {
				this.filter = Array.from(this.filter).slice(0, -1).join("");
				this.selectedRule = 0;
				this.selectedProposal = 0;
				this.listScroll = 0;
			} else if (matchesKey(raw, "up")) this.move(-1);
			else if (matchesKey(raw, "down")) this.move(1);
			else if (data.length > 0 && !matchesKey(raw, "ctrl+c") && /^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(data)) {
				this.filter += data;
				this.selectedRule = 0;
				this.selectedProposal = 0;
				this.listScroll = 0;
			} else return;
			this.detailScroll = 0;
			this.bump();
			return;
		}
		if (matchesKey(raw, "escape")) {
			this.finish();
			return;
		}
		if (matchesKey(raw, "up")) this.move(-1);
		else if (matchesKey(raw, "down")) this.move(1);
		else if (data === "v") {
			this.view = this.view === "rules" ? "proposals" : this.view === "proposals" ? "activity" : "rules";
			this.listScroll = 0;
			this.detailScroll = 0;
		} else if (data === "b") this.detailScroll = Math.max(0, this.detailScroll - this.pageSize());
		else if (matchesKey(raw, "space"))
			this.detailScroll = Math.min(this.detailMaxScroll(), this.detailScroll + this.pageSize());
		else if ((this.view === "rules" || this.view === "proposals") && data === "/") this.filtering = true;
		else if (this.view === "proposals" && data === "a") void this.runProposalAction("approve");
		else if (this.view === "proposals" && data === "x") void this.runProposalAction("reject");
		else if (this.view === "rules" && data === "d") this.showRuleActionCommand("disable");
		else if (this.view === "rules" && data === "n") this.showRuleActionCommand("enable");
		else if (this.view === "rules" && data === "e") this.showRuleActionCommand("effect");
		else if (this.view === "rules" && data === "r") this.showRuleActionCommand("retire");
		else return;
		this.bump();
	}

	private keyPair(key: string, label: string): string {
		return `${this.deps.theme.fg("accent", key)}${this.deps.theme.fg("dim", ` ${label}`)}`;
	}

	private footerText(innerWidth: number): string {
		if (this.outcome.startsWith("Run: ")) {
			return this.deps.theme.fg("accent", this.outcome);
		}
		if (this.filtering) {
			const suffix = ` · ↑↓ select · enter/esc done · ${this.itemCount()} match`;
			const queryWidth = Math.max(1, innerWidth - visibleWidth("filter ") - visibleWidth(suffix));
			return `${this.deps.theme.fg("accent", "filter ")}${this.deps.theme.fg("text", keepTail(`${oneLine(this.filter)}▌`, queryWidth))}${this.deps.theme.fg("dim", suffix)}`;
		}
		const keys = [this.keyPair("↑↓", "select"), this.keyPair("b/spc", "detail"), this.keyPair("v", "view")];
		if (this.view === "rules")
			keys.push(
				this.keyPair("d/n", "disable/enable"),
				this.keyPair("e", "effect"),
				this.keyPair("r", "retire"),
				this.keyPair("/", "filter"),
			);
		if (this.view === "proposals") keys.push(this.keyPair("a/x", "approve/reject"), this.keyPair("/", "filter"));
		keys.push(this.keyPair("esc", "close"));
		return keys.join(this.deps.theme.fg("dim", " · "));
	}

	private listHeader(width: number): string {
		const text =
			this.view === "rules"
				? "rule · source · state · effect · fires"
				: this.view === "proposals"
					? "proposal · operation · rule"
					: "time · model · rule ids · degraded · command";
		return fitText(text, width);
	}

	private listRow(index: number, _width: number): string {
		if (this.view === "rules") {
			const record = this.rules[index];
			if (!record) return "";
			return `${index === this.selectedRule ? "› " : "  "}${record.id} · ${record.source.kind} · ${effectiveState(record)} · ${effectiveEffect(record)} · ${this.deps.data.fireSummary.fires.get(record.id) ?? 0}`;
		}
		if (this.view === "proposals") {
			const proposal = this.proposals[index];
			if (!proposal) return "";
			return `${index === this.selectedProposal ? "› " : "  "}${proposal.id} · ${proposal.operation} · ${proposal.ruleId}`;
		}
		const record = this.deps.data.activity.records[index];
		if (!record) return "";
		const time = record.at.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? record.at;
		return `${index === this.selectedActivity ? "› " : "  "}${time} · ${record.model ?? "(none)"} · ${record.classes.join(",")} · ${record.ruleStoreDegraded ? "degraded" : "healthy"} · ${oneLine(record.captured ?? "(not captured)")}`;
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const layout = this.layout(width);
		if (this.cachedWidth === width && this.cachedRows === layout.total && this.cachedVersion === this.version)
			return this.cachedLines;
		const count = this.itemCount();
		const selected = this.selectedIndex();
		const position = count === 0 ? "0/0" : `${selected + 1}/${count}`;
		const label = this.view === "rules" ? "Rules" : this.view === "proposals" ? "Proposals" : "Activity";
		const healthLabel =
			this.deps.data.snapshot.health.status === "degraded"
				? "degraded"
				: this.deps.data.snapshot.health.incompleteFinalLine !== undefined
					? "append-in-flight"
					: "healthy";
		const paint = (text: string) => this.deps.theme.bg("customMessageBg", fitText(text, width));
		if (!layout.framed) {
			const lines = [paint(`Policy · ${label} · ${position} · ${healthLabel}`), paint(this.listHeader(width))];
			const available = Math.max(0, layout.total - 3);
			if (selected < this.listScroll) this.listScroll = selected;
			if (selected >= this.listScroll + available) this.listScroll = Math.max(0, selected - available + 1);
			for (let slot = 0; slot < available; slot++) lines.push(paint(this.listRow(this.listScroll + slot, width)));
			lines.push(paint(this.footerText(width)));
			this.cachedLines = lines.slice(0, layout.total);
		} else {
			const title = `┌─ ◆ Policy · ${label} · ${position} · ${healthLabel} `;
			const top = `${title}${"─".repeat(Math.max(0, width - visibleWidth(title) - 1))}┐`;
			const lines = [this.deps.theme.bg("customMessageBg", this.deps.theme.fg("borderMuted", top))];
			const listRows = Math.max(0, layout.bodyRows - 1);
			if (selected < this.listScroll) this.listScroll = selected;
			if (selected >= this.listScroll + listRows) this.listScroll = Math.max(0, selected - listRows + 1);
			this.detailScroll = Math.min(this.detailScroll, this.detailMaxScroll());
			const detail = this.detailSource(layout.detailWidth).slice(
				this.detailScroll,
				this.detailScroll + layout.bodyRows,
			);
			for (let body = 0; body < layout.bodyRows; body++) {
				const absolute = this.listScroll + body - 1;
				const list =
					body === 0
						? this.deps.theme.bold(this.deps.theme.fg("dim", this.listHeader(layout.listWidth)))
						: this.deps.theme.fg(absolute === selected ? "accent" : "text", this.listRow(absolute, layout.listWidth));
				lines.push(
					this.deps.theme.bg(
						"customMessageBg",
						`${this.deps.theme.fg("borderMuted", "│ ")}${fitText(list, layout.listWidth)}${this.deps.theme.fg("borderMuted", " │ ")}${fitText(detail[body] ?? "", layout.detailWidth)}${this.deps.theme.fg("borderMuted", " │")}`,
					),
				);
			}
			lines.push(
				this.deps.theme.bg(
					"customMessageBg",
					this.deps.theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`),
				),
			);
			lines.push(
				this.deps.theme.bg(
					"customMessageBg",
					`${this.deps.theme.fg("borderMuted", "│ ")}${fitText(this.footerText(layout.innerWidth), layout.innerWidth)}${this.deps.theme.fg("borderMuted", " │")}`,
				),
			);
			lines.push(
				this.deps.theme.bg(
					"customMessageBg",
					this.deps.theme.fg("borderMuted", `└${"─".repeat(Math.max(0, width - 2))}┘`),
				),
			);
			this.cachedLines = lines.slice(0, layout.total);
		}
		this.cachedWidth = width;
		this.cachedRows = layout.total;
		this.cachedVersion = this.version;
		return this.cachedLines;
	}

	dispose(): void {}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedRows = -1;
		this.cachedVersion = -1;
		this.cachedLines = [];
	}
}
