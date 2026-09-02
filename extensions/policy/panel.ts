/** Interactive /policy browser plus bounded activity-tail loading and pure formatting helpers. */

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
import { agentClass, type AgentRule, type AgentState, MAX_FIRE_SCAN_BYTES, type StateLine } from "./agent-rules.ts";

export const MAX_ACTIVITY_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVITY_RECORDS = 200;
const MAX_PANEL_ROWS = 46;
const ACTIVITY_READ_CHUNK_BYTES = 64 * 1024;
const DAILY_STORE_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const BUILTIN_GROUPS = ["routing", "form", "bounds"] as const;

export type BuiltinGroup = (typeof BUILTIN_GROUPS)[number];
export type PolicyView = "rules" | "activity";

type ModelFireMap = ReadonlyMap<string | null, number>;

export interface RuleFireSummary {
	/** Counts for every class id observed by the bounded fire scan. */
	fires: ReadonlyMap<string, number>;
	/** Counts by record model for every class id observed by the same scan. */
	firesByModel: ReadonlyMap<string, ModelFireMap>;
	partial: boolean;
}

export interface BuiltinRuleInfo {
	id: string;
	note: string;
}

/** The safe subset of a stored record used by the Activity view. */
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
}

export interface ActivityReadResult {
	records: PolicyActivityRecord[];
	partial: boolean;
	byteLimited: boolean;
	recordLimited: boolean;
	bytesRead: number;
}

export interface PolicyPanelData {
	agentRules: AgentRule[];
	builtins: BuiltinRuleInfo[];
	fireSummary: RuleFireSummary;
	activity: ActivityReadResult;
}

export type PolicyPanelAction =
	| { kind: "state"; slug: string; state: AgentState }
	| { kind: "draft"; record: PolicyActivityRecord };

export interface PolicyPanelResult {
	action?: PolicyPanelAction;
	view: PolicyView;
	filter: string;
	expandedGroups: BuiltinGroup[];
	selectedRuleKey?: string;
	selectedActivityKey?: string;
}

interface PolicyPanelDeps {
	data: PolicyPanelData;
	theme: Theme;
	tui: { requestRender(): void };
	getMaxRows: () => number;
	done: (result: PolicyPanelResult) => void;
	copyRule: (rule: AgentRule) => Promise<void>;
	initialView?: PolicyView;
	initialFilter?: string;
	initialExpandedGroups?: readonly BuiltinGroup[];
	initialSelectedRuleKey?: string;
	initialSelectedActivityKey?: string;
	now?: Date;
}

export type RuleListRow =
	| { kind: "agent"; key: string; rule: AgentRule }
	| { kind: "group"; key: string; group: BuiltinGroup; rules: BuiltinRuleInfo[]; fires: number }
	| { kind: "builtin"; key: string; group: BuiltinGroup; rule: BuiltinRuleInfo; fires: number };

interface Layout {
	total: number;
	framed: boolean;
	bodyRows: number;
	innerWidth: number;
	listWidth: number;
	detailWidth: number;
}

interface Column {
	label: string;
	value: string;
	minimum: number;
	weight: number;
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

/** Side-by-side panes with enough room for the Rules-view columns. */
export function computePolicyPanes(innerWidth: number, dividerWidth = 3): { listWidth: number; detailWidth: number } {
	const available = Math.max(2, innerWidth - dividerWidth);
	let listWidth = Math.max(44, Math.min(86, Math.floor(innerWidth * 0.64)));
	let detailWidth = available - listWidth;
	if (detailWidth < 28) {
		listWidth = Math.max(28, available - 28);
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
	return {
		total,
		framed: true,
		bodyRows: Math.max(1, total - 4),
		innerWidth,
		...computePolicyPanes(innerWidth),
	};
}

export function formatAge(at: string, now: Date = new Date()): string {
	const timestamp = Date.parse(at);
	if (Number.isNaN(timestamp)) return "?";
	const elapsed = Math.max(0, now.getTime() - timestamp);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (elapsed < minute) return "<1m";
	if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
	if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
	if (elapsed < 30 * day) return `${Math.floor(elapsed / day)}d`;
	if (elapsed < 365 * day) return `${Math.floor(elapsed / (30 * day))}mo`;
	return `${Math.floor(elapsed / (365 * day))}y`;
}

export function agentPosture(state: AgentState): string {
	switch (state) {
		case "active":
			return "steer";
		case "promoted":
			return "block";
		case "disabled":
			return "off";
		case "discarded":
			return "gone";
	}
}

export function formatScope(rule: Pick<AgentRule, "scope">): string {
	const scope = rule.scope;
	if (scope === undefined) return "all";
	if (scope.exclude) return `except:${scope.exclude.length}`;
	if (scope.models) return `models:${scope.models.length}`;
	return `providers:${scope.providers?.length ?? 0}`;
}

function builtinGroup(id: string): BuiltinGroup | undefined {
	const namespace = id.split(".", 1)[0];
	return BUILTIN_GROUPS.find((group) => group === namespace);
}

export function groupBuiltins(builtins: readonly BuiltinRuleInfo[]): Map<BuiltinGroup, BuiltinRuleInfo[]> {
	const groups = new Map<BuiltinGroup, BuiltinRuleInfo[]>(BUILTIN_GROUPS.map((group) => [group, []]));
	for (const rule of builtins) {
		const group = builtinGroup(rule.id);
		if (group) groups.get(group)!.push(rule);
	}
	for (const rules of groups.values()) rules.sort((left, right) => left.id.localeCompare(right.id));
	return groups;
}

function matchesFilter(fields: readonly string[], filter: string): boolean {
	if (!filter) return true;
	const needle = filter.toLocaleLowerCase();
	return fields.some((field) => field.toLocaleLowerCase().includes(needle));
}

/** Agent rows followed by exactly the routing, form, and bounds group rows. */
export function buildRuleRows(
	agentRules: readonly AgentRule[],
	builtins: readonly BuiltinRuleInfo[],
	fires: ReadonlyMap<string, number>,
	expandedGroups: ReadonlySet<BuiltinGroup>,
	filter = "",
): RuleListRow[] {
	const rows: RuleListRow[] = [];
	for (const rule of agentRules) {
		if (
			!matchesFilter(
				[
					"agent",
					rule.slug,
					rule.state,
					agentPosture(rule.state),
					formatScope(rule),
					rule.note,
					rule.model,
					JSON.stringify(rule.match),
					JSON.stringify(rule.scope ?? "all"),
				],
				filter,
			)
		)
			continue;
		rows.push({ kind: "agent", key: `agent:${rule.slug}`, rule });
	}

	const groups = groupBuiltins(builtins);
	for (const group of BUILTIN_GROUPS) {
		const allRules = groups.get(group) ?? [];
		const matchingRules = allRules.filter((rule) => matchesFilter([group, rule.id, rule.note], filter));
		if (filter && matchingRules.length === 0 && !matchesFilter([group], filter)) continue;
		const groupFires = allRules.reduce((total, rule) => total + (fires.get(rule.id) ?? 0), 0);
		rows.push({ kind: "group", key: `group:${group}`, group, rules: allRules, fires: groupFires });
		if (!expandedGroups.has(group)) continue;
		for (const rule of filter ? matchingRules : allRules) {
			rows.push({ kind: "builtin", key: `builtin:${rule.id}`, group, rule, fires: fires.get(rule.id) ?? 0 });
		}
	}
	return rows;
}

function allocateColumns(columns: readonly Column[], width: number): number[] {
	if (columns.length === 0) return [];
	const separators = columns.length - 1;
	const available = Math.max(columns.length, width - separators);
	const widths = columns.map((column) => Math.max(1, column.minimum));
	let remaining = available - widths.reduce((sum, value) => sum + value, 0);
	while (remaining > 0) {
		let changed = false;
		for (let weight = 3; weight >= 1 && remaining > 0; weight--) {
			for (let index = 0; index < columns.length && remaining > 0; index++) {
				if (columns[index].weight !== weight) continue;
				widths[index]++;
				remaining--;
				changed = true;
			}
		}
		if (!changed) break;
	}
	while (remaining < 0) {
		let changed = false;
		for (let weight = 1; weight <= 3 && remaining < 0; weight++) {
			for (let index = columns.length - 1; index >= 0 && remaining < 0; index--) {
				if (columns[index].weight !== weight || widths[index] <= 1) continue;
				widths[index]--;
				remaining++;
				changed = true;
			}
		}
		if (!changed) break;
	}
	return widths;
}

function renderColumns(columns: readonly Column[], width: number, header: boolean): string {
	const widths = allocateColumns(columns, width);
	return columns.map((column, index) => fitText(header ? column.label : column.value, widths[index])).join(" ");
}

function agentColumns(rule: AgentRule, fires: number, now: Date): Column[] {
	return [
		{ label: "origin", value: "agent", minimum: 6, weight: 1 },
		{ label: "slug", value: oneLine(rule.slug), minimum: 9, weight: 3 },
		{ label: "state", value: rule.state, minimum: 5, weight: 2 },
		{ label: "posture", value: agentPosture(rule.state), minimum: 7, weight: 1 },
		{ label: "scope", value: formatScope(rule), minimum: 5, weight: 2 },
		{ label: "fires", value: String(fires), minimum: 5, weight: 1 },
		{ label: "author model", value: oneLine(rule.model), minimum: 10, weight: 3 },
		{ label: "age", value: formatAge(rule.at, now), minimum: 4, weight: 1 },
	];
}

function activityColumns(record: PolicyActivityRecord): Column[] {
	const time = record.at.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? oneLine(record.at);
	return [
		{ label: "time", value: time, minimum: 8, weight: 1 },
		{ label: "model", value: oneLine(record.model ?? "(none)"), minimum: 10, weight: 2 },
		{ label: "rule ids", value: record.classes.map(oneLine).join(","), minimum: 12, weight: 3 },
		{ label: "blocked", value: record.blocked ? "yes" : "no", minimum: 7, weight: 1 },
		{ label: "redacted command", value: oneLine(record.captured ?? "(not captured)"), minimum: 14, weight: 3 },
	];
}

function modelFireEntries(summary: RuleFireSummary, classId: string): Array<[string | null, number]> {
	return [...(summary.firesByModel.get(classId)?.entries() ?? [])].sort(
		(left, right) => right[1] - left[1] || (left[0] ?? "").localeCompare(right[0] ?? ""),
	);
}

/** Text lines for the required per-model fire evidence. */
export function fireBreakdownLines(summary: RuleFireSummary, classId: string): string[] {
	const entries = modelFireEntries(summary, classId);
	if (entries.length === 0) return ["  (none)"];
	return entries.map(([model, count]) => `  ${terminalSafe(model ?? "(no model)")}: ${count}`);
}

function wrapDetail(lines: readonly string[], width: number): string[] {
	const wrapped: string[] = [];
	for (const source of lines) {
		const safe = terminalSafe(source);
		const parts = safe.split("\n");
		for (const part of parts) {
			const rendered = wrapTextWithAnsi(part, Math.max(8, width));
			wrapped.push(...(rendered.length > 0 ? rendered : [""]));
		}
	}
	return wrapped;
}

function jsonLines(label: string, value: unknown): string[] {
	const serialized = JSON.stringify(value, null, 2) ?? "none";
	const lines = serialized.split("\n");
	return [`${label}: ${lines[0]}`, ...lines.slice(1)];
}

export function agentDetailLines(rule: AgentRule, summary: RuleFireSummary): string[] {
	const classId = agentClass(rule.slug);
	return [
		classId,
		`state: ${rule.state}`,
		`posture: ${agentPosture(rule.state)}`,
		"",
		`note: ${rule.note}`,
		...jsonLines("match", rule.match),
		...jsonLines("suggested form", rule.suggest ?? "none"),
		...jsonLines("scope", rule.scope ?? "everywhere"),
		"",
		`author model: ${rule.model}`,
		`session: ${rule.session}`,
		`timestamp: ${rule.at}`,
		`total fires: ${summary.fires.get(classId) ?? 0}`,
		"fires by model:",
		...fireBreakdownLines(summary, classId),
		...(summary.partial ? ["", `[fire counts partial: ${MAX_FIRE_SCAN_BYTES} byte scan bound reached]`] : []),
	];
}

export function builtinDetailLines(rule: BuiltinRuleInfo, summary: RuleFireSummary): string[] {
	return [
		`id: ${rule.id}`,
		`note: ${rule.note}`,
		`total fires: ${summary.fires.get(rule.id) ?? 0}`,
		"fires by model:",
		...fireBreakdownLines(summary, rule.id),
		...(summary.partial ? ["", `[fire counts partial: ${MAX_FIRE_SCAN_BYTES} byte scan bound reached]`] : []),
	];
}

function activityPartialReason(activity: ActivityReadResult): string {
	const reasons: string[] = [];
	if (activity.byteLimited) reasons.push(`${MAX_ACTIVITY_SCAN_BYTES} byte tail bound`);
	if (activity.recordLimited) reasons.push(`${MAX_ACTIVITY_RECORDS} record limit`);
	return reasons.length > 0 ? reasons.join(" and ") : "read failure";
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
		`session: ${record.session}`,
		"",
		"redacted command:",
		record.captured ?? "(not captured)",
		...(activity.partial ? ["", `[activity partial: ${activityPartialReason(activity)}]`] : []),
	];
}

function activityKey(record: PolicyActivityRecord): string {
	return `${record.at}\0${record.session}\0${record.tool}\0${record.classes.join(",")}\0${record.captured ?? ""}`;
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
	let complete = false;
	try {
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		handle = await open(path, constants.O_RDONLY | noFollow);
		const size = (await handle.stat()).size;
		const length = Math.min(size, Math.max(0, byteLimit));
		const start = size - length;
		const buffer = Buffer.alloc(length);
		while (bytesRead < length) {
			const chunkLength = Math.min(ACTIVITY_READ_CHUNK_BYTES, length - bytesRead);
			const result = await handle.read(buffer, bytesRead, chunkLength, start + bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		complete = start === 0 && bytesRead === length;
		return { buffer: buffer.subarray(0, bytesRead), bytesRead, complete };
	} finally {
		await handle?.close();
	}
}

/** Read newest daily-record tails only, then order matched records by their timestamps. */
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
				// One malformed record does not hide valid activity around it.
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

/** Model request drafted from only the redacted command held by a selected record. */
export function draftRuleMessage(record: PolicyActivityRecord): string {
	return [
		"Author a focused shell policy rule for the recorded command below if the visible evidence warrants one.",
		"Use policy_rule_add so the match, note, optional suggested form, and optional scope stay in the closed policy schema.",
		"The command is redacted telemetry. Use only the visible shape and do not reconstruct or guess redacted values.",
		"",
		`Redacted command (JSON string): ${JSON.stringify(record.captured ?? "(not captured)")}`,
		`Matched rule ids: ${record.classes.join(", ")}`,
		`Observed model: ${record.model ?? "(none)"}`,
	].join("\n");
}

function capText(text: string, maxBytes = 50 * 1024): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const marker = "\n[policy text truncated]";
	const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	let prefix = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
	while (Buffer.byteLength(prefix, "utf8") > budget) prefix = Array.from(prefix).slice(0, -1).join("");
	return `${prefix}${marker}`;
}

/** Text equivalent of the Rules view, including expanded built-in group members. */
export function formatPolicyList(
	data: Pick<PolicyPanelData, "agentRules" | "builtins" | "fireSummary">,
	now = new Date(),
): string {
	const lines = ["AGENT RULES", "origin | slug | state | posture | scope | fires | author model | age"];
	if (data.agentRules.length === 0) lines.push("(none; use the Activity view to draft a first rule)");
	for (const rule of data.agentRules) {
		lines.push(
			[
				"agent",
				rule.slug,
				rule.state,
				agentPosture(rule.state),
				formatScope(rule),
				String(data.fireSummary.fires.get(agentClass(rule.slug)) ?? 0),
				rule.model,
				formatAge(rule.at, now),
			].join(" | "),
		);
	}
	lines.push("", "BUILT-IN GROUPS");
	const groups = groupBuiltins(data.builtins);
	for (const group of BUILTIN_GROUPS) {
		const rules = groups.get(group) ?? [];
		const total = rules.reduce((sum, rule) => sum + (data.fireSummary.fires.get(rule.id) ?? 0), 0);
		lines.push(`${group} | rules: ${rules.length} | fires: ${total}`);
		for (const rule of rules) {
			lines.push(`  ${rule.id} | fires: ${data.fireSummary.fires.get(rule.id) ?? 0} | ${rule.note}`);
		}
	}
	if (data.fireSummary.partial) {
		lines.push("", `firing counts partial: store scan exceeded ${MAX_FIRE_SCAN_BYTES} bytes`);
	}
	return capText(lines.map(terminalSafe).join("\n"));
}

/** Full text detail for an agent slug or built-in id. */
export function formatPolicyShow(
	data: Pick<PolicyPanelData, "agentRules" | "builtins" | "fireSummary">,
	slugOrId: string,
): string | undefined {
	const agentSlug = slugOrId.startsWith("agent.") ? slugOrId.slice("agent.".length) : slugOrId;
	const agent = data.agentRules.find((rule) => rule.slug === agentSlug);
	if (agent) return capText(agentDetailLines(agent, data.fireSummary).map(terminalSafe).join("\n"));
	const builtin = data.builtins.find((rule) => rule.id === slugOrId);
	return builtin ? capText(builtinDetailLines(builtin, data.fireSummary).map(terminalSafe).join("\n")) : undefined;
}

/** Append-only state history ordered newest first without disturbing equal timestamps. */
export function formatPolicyHistory(lines: StateLine[]): string {
	if (lines.length === 0) return "No state transitions were recorded.";
	const ordered = lines
		.map((line, index) => ({ line, index }))
		.sort((left, right) => Date.parse(right.line.at) - Date.parse(left.line.at) || left.index - right.index);
	const sections = ordered.map(({ line }) => {
		const section = [
			`timestamp: ${line.at}`,
			`state: ${line.state}`,
			`origin: ${line.origin}`,
			`model: ${line.model}`,
			`session: ${line.session}`,
		];
		if (line.warrant) {
			section.push(
				`warrant: criteria v${line.warrant.criteria} ${line.warrant.pass ? "pass" : "fail"} · ${line.warrant.fires} fires · ${line.warrant.errors} errors · ${line.warrant.truncated} truncated · scan ${line.warrant.partial ? "partial" : "complete"}`,
			);
		} else if (line.warrantUnreadable) {
			section.push("warrant: unreadable");
		}
		return section.map(terminalSafe).join("\n");
	});
	return capText(sections.join("\n\n"));
}

export class PolicyPanel {
	private readonly deps: PolicyPanelDeps;
	private view: PolicyView;
	private filter: string;
	private filtering = false;
	private readonly expandedGroups: Set<BuiltinGroup>;
	private selectedRule = 0;
	private selectedActivity = 0;
	private ruleScroll = 0;
	private activityScroll = 0;
	private detailScroll = 0;
	private notice: string | undefined;
	private copying = false;
	private finished = false;
	private version = 0;
	private lastWidth = 112;
	private cachedWidth = -1;
	private cachedRows = -1;
	private cachedVersion = -1;
	private cachedLines: string[] = [];
	private readonly now: Date;

	constructor(deps: PolicyPanelDeps) {
		this.deps = deps;
		this.view = deps.initialView ?? "rules";
		this.filter = deps.initialFilter ?? "";
		this.expandedGroups = new Set(deps.initialExpandedGroups ?? []);
		this.now = deps.now ?? new Date();
		if (deps.initialSelectedRuleKey) {
			const selected = this.ruleRows.findIndex((row) => row.key === deps.initialSelectedRuleKey);
			if (selected >= 0) this.selectedRule = selected;
		}
		if (deps.initialSelectedActivityKey) {
			const selected = deps.data.activity.records.findIndex(
				(record) => activityKey(record) === deps.initialSelectedActivityKey,
			);
			if (selected >= 0) this.selectedActivity = selected;
		}
	}

	private get ruleRows(): RuleListRow[] {
		return buildRuleRows(
			this.deps.data.agentRules,
			this.deps.data.builtins,
			this.deps.data.fireSummary.fires,
			this.expandedGroups,
			this.filter,
		);
	}

	private currentRule(): RuleListRow | undefined {
		return this.ruleRows[this.selectedRule];
	}

	private currentActivity(): PolicyActivityRecord | undefined {
		return this.deps.data.activity.records[this.selectedActivity];
	}

	private layout(width = this.lastWidth): Layout {
		return computeLayout(this.deps.getMaxRows(), width);
	}

	private pageSize(): number {
		return Math.max(1, this.layout().bodyRows - 1);
	}

	private detailSource(width = this.layout().detailWidth): string[] {
		if (this.view === "activity") {
			const record = this.currentActivity();
			if (!record) {
				return [
					"No recorded activity matched a policy rule.",
					...(this.deps.data.activity.partial ? ["The bounded tail read is partial."] : []),
				];
			}
			return wrapDetail(activityDetailLines(record, this.deps.data.activity), width);
		}
		const row = this.currentRule();
		if (!row) return [this.filter ? "No rules match the filter." : "No policy rules are available."];
		if (row.kind === "agent") return wrapDetail(agentDetailLines(row.rule, this.deps.data.fireSummary), width);
		if (row.kind === "builtin") return wrapDetail(builtinDetailLines(row.rule, this.deps.data.fireSummary), width);
		return wrapDetail(
			[
				`${row.group} built-ins`,
				`rules: ${row.rules.length}`,
				`summed fires: ${row.fires}`,
				"",
				`${this.expandedGroups.has(row.group) ? "Press g to collapse." : "Press g to expand in place."}`,
				...(this.deps.data.fireSummary.partial
					? ["", `[fire counts partial: ${MAX_FIRE_SCAN_BYTES} byte scan bound reached]`]
					: []),
			],
			width,
		);
	}

	private detailMaxScroll(): number {
		const layout = this.layout();
		return Math.max(0, this.detailSource(layout.detailWidth).length - layout.bodyRows);
	}

	private bump(): void {
		this.version++;
		this.deps.tui.requestRender();
	}

	private clearTransient(): void {
		this.notice = undefined;
		this.detailScroll = 0;
	}

	private finish(action?: PolicyPanelAction): void {
		this.finished = true;
		this.deps.done({
			action,
			view: this.view,
			filter: this.filter,
			expandedGroups: [...this.expandedGroups],
			selectedRuleKey: this.currentRule()?.key,
			selectedActivityKey: this.currentActivity() ? activityKey(this.currentActivity()!) : undefined,
		});
	}

	private move(delta: number): void {
		if (this.view === "rules") {
			const rows = this.ruleRows;
			this.selectedRule = Math.max(0, Math.min(Math.max(0, rows.length - 1), this.selectedRule + delta));
		} else {
			const records = this.deps.data.activity.records;
			this.selectedActivity = Math.max(0, Math.min(Math.max(0, records.length - 1), this.selectedActivity + delta));
		}
		this.clearTransient();
	}

	private toggleGroup(): void {
		const row = this.currentRule();
		if (row?.kind !== "group") {
			this.notice = "Select a built-in group row to expand or collapse it.";
			return;
		}
		if (this.expandedGroups.has(row.group)) this.expandedGroups.delete(row.group);
		else this.expandedGroups.add(row.group);
		const selected = this.ruleRows.findIndex((candidate) => candidate.key === row.key);
		this.selectedRule = Math.max(0, selected);
		this.clearTransient();
	}

	private requestState(state: AgentState): void {
		const row = this.currentRule();
		if (row?.kind === "builtin") {
			this.notice = "Built-in rules are code and change by commit.";
			this.bump();
			return;
		}
		if (row?.kind !== "agent") {
			this.notice = "Select an agent rule for a state action.";
			this.bump();
			return;
		}
		if (row.rule.state === state) {
			this.notice = `Rule ${row.rule.slug} is already ${state}.`;
			this.bump();
			return;
		}
		this.finish({ kind: "state", slug: row.rule.slug, state });
	}

	private copySelectedRule(): void {
		const row = this.currentRule();
		if (row?.kind !== "agent") {
			this.notice = "Select an agent rule to copy its JSON.";
			this.bump();
			return;
		}
		if (this.copying) return;
		this.copying = true;
		this.notice = "copying…";
		this.bump();
		void this.deps.copyRule(row.rule).then(
			() => {
				if (this.finished) return;
				this.copying = false;
				this.notice = "Rule JSON copied.";
				this.bump();
			},
			() => {
				if (this.finished) return;
				this.copying = false;
				this.notice = "Could not copy rule JSON.";
				this.bump();
			},
		);
	}

	handleInput(raw: string): void {
		const decoded = decodeKittyPrintable(raw);
		const data = decoded ?? raw;
		if (this.filtering) {
			if (matchesKey(raw, "escape") || matchesKey(raw, "enter")) {
				this.filtering = false;
			} else if (matchesKey(raw, "backspace")) {
				this.filter = Array.from(this.filter).slice(0, -1).join("");
				this.selectedRule = 0;
				this.ruleScroll = 0;
				this.clearTransient();
			} else if (matchesKey(raw, "up")) {
				this.move(-1);
			} else if (matchesKey(raw, "down")) {
				this.move(1);
			} else if (data.length > 0 && !matchesKey(raw, "ctrl+c") && /^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(data)) {
				this.filter += data;
				this.selectedRule = 0;
				this.ruleScroll = 0;
				this.clearTransient();
			} else {
				return;
			}
			this.bump();
			return;
		}

		if (matchesKey(raw, "escape")) {
			this.finish();
			return;
		}
		if (matchesKey(raw, "up")) {
			this.move(-1);
			this.bump();
			return;
		}
		if (matchesKey(raw, "down")) {
			this.move(1);
			this.bump();
			return;
		}
		if (data === "v") {
			this.view = this.view === "rules" ? "activity" : "rules";
			this.clearTransient();
			this.bump();
			return;
		}
		if (data === "b") {
			this.detailScroll = Math.max(0, this.detailScroll - this.pageSize());
			this.bump();
			return;
		}
		if (matchesKey(raw, "space")) {
			this.detailScroll = Math.min(this.detailMaxScroll(), this.detailScroll + this.pageSize());
			this.bump();
			return;
		}
		if (this.view === "activity") {
			if (data === "d") {
				const record = this.currentActivity();
				if (record?.captured === undefined) {
					this.notice = "The selected record has no captured redacted command.";
					this.bump();
					return;
				}
				if (record) this.finish({ kind: "draft", record });
			}
			return;
		}
		if (data === "/") {
			this.filtering = true;
			this.clearTransient();
			this.bump();
			return;
		}
		if (data === "g") {
			this.toggleGroup();
			this.bump();
			return;
		}
		if (data === "p") {
			this.requestState("promoted");
			return;
		}
		if (data === "m") {
			this.requestState("active");
			return;
		}
		if (data === "x") {
			this.requestState("disabled");
			return;
		}
		if (data === "a") {
			this.requestState("active");
			return;
		}
		if (data === "d") {
			this.requestState("discarded");
			return;
		}
		if (data === "c") this.copySelectedRule();
	}

	private keyPair(key: string, label: string): string {
		return `${this.deps.theme.fg("accent", key)}${this.deps.theme.fg("dim", ` ${label}`)}`;
	}

	private footerText(innerWidth: number): string {
		const theme = this.deps.theme;
		if (this.notice) return theme.fg(this.notice.includes("Could not") ? "error" : "warning", this.notice);
		if (this.filtering) {
			const suffix = ` · ↑↓ select · enter/esc done · ${this.ruleRows.length} match`;
			const queryWidth = Math.max(1, innerWidth - visibleWidth("filter ") - visibleWidth(suffix));
			return `${theme.fg("accent", "filter ")}${theme.fg("text", keepTail(`${oneLine(this.filter)}▌`, queryWidth))}${theme.fg("dim", suffix)}`;
		}
		const common = [this.keyPair("↑↓", "select"), this.keyPair("b/spc", "detail"), this.keyPair("v", "view")];
		if (this.view === "activity") {
			common.push(this.keyPair("d", "draft rule"), this.keyPair("esc", "close"));
			return common.join(theme.fg("dim", " · "));
		}
		common.push(
			this.keyPair("g", "group"),
			this.keyPair("/", "filter"),
			this.keyPair("p/m", "promote/demote"),
			this.keyPair("x/a", "disable/enable"),
			this.keyPair("d", "discard"),
			this.keyPair("c", "copy"),
			this.keyPair("esc", "close"),
		);
		return common.join(theme.fg("dim", " · "));
	}

	private titleBorder(width: number, position: string): string {
		const theme = this.deps.theme;
		const partial = this.view === "rules" ? this.deps.data.fireSummary.partial : this.deps.data.activity.partial;
		const title = `◆ Policy · ${this.view === "rules" ? "Rules" : "Activity"}${partial ? " · partial" : ""}`;
		const right = ` ${position} ─┐`;
		const leftBudget = Math.max(1, width - visibleWidth(right) - 4);
		const shown = truncateToWidth(title, leftBudget);
		const left = `┌─ ${shown} `;
		const fill = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
		return theme.bg(
			"customMessageBg",
			`${theme.fg("borderMuted", left.slice(0, 3))}${theme.bold(theme.fg("accent", left.slice(3)))}${theme.fg("borderMuted", "─".repeat(fill))}${theme.fg("dim", ` ${position}`)}${theme.fg("borderMuted", " ─┐")}`,
		);
	}

	private listHeader(width: number): string {
		if (this.view === "activity") {
			const sample: PolicyActivityRecord = {
				at: "00:00:00",
				model: "model",
				thinkingLevel: null,
				tool: "bash",
				classes: ["rule ids"],
				blocked: false,
				error: false,
				policyMode: "observe",
				session: "session",
			};
			return renderColumns(activityColumns(sample), width, true);
		}
		const sample: AgentRule = {
			version: 1,
			slug: "slug",
			note: "note",
			match: { tool: "bash", command: "command" },
			state: "active",
			model: "author model",
			session: "session",
			at: this.now.toISOString(),
		};
		return renderColumns(agentColumns(sample, 0, this.now), width, true);
	}

	private listRow(rowIndex: number, width: number): string {
		if (this.view === "activity") {
			const record = this.deps.data.activity.records[rowIndex];
			if (!record) return "";
			const body = renderColumns(activityColumns(record), Math.max(1, width - 2), false);
			return `${rowIndex === this.selectedActivity ? "› " : "  "}${body}`;
		}
		const row = this.ruleRows[rowIndex];
		if (!row) return "";
		const prefix = rowIndex === this.selectedRule ? "› " : "  ";
		if (row.kind === "agent") {
			return `${prefix}${renderColumns(
				agentColumns(row.rule, this.deps.data.fireSummary.fires.get(agentClass(row.rule.slug)) ?? 0, this.now),
				Math.max(1, width - 2),
				false,
			)}`;
		}
		if (row.kind === "group") {
			const mark = this.expandedGroups.has(row.group) ? "▾" : "▸";
			return `${prefix}${mark} ${row.group} · ${row.rules.length} rules · ${row.fires} fires`;
		}
		return `${prefix}  ${row.rule.id} · ${oneLine(row.rule.note)} · ${row.fires} fires`;
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const layout = this.layout(width);
		if (this.cachedWidth === width && this.cachedRows === layout.total && this.cachedVersion === this.version) {
			return this.cachedLines;
		}
		const theme = this.deps.theme;
		const itemCount = this.view === "rules" ? this.ruleRows.length : this.deps.data.activity.records.length;
		const selected = this.view === "rules" ? this.selectedRule : this.selectedActivity;
		const position = itemCount === 0 ? "0/0" : `${selected + 1}/${itemCount}`;
		const paint = (text: string): string => theme.bg("customMessageBg", fitText(text, width));
		const lines: string[] = [];
		const noAgentsHint =
			this.view === "rules" && this.filter === "" && this.deps.data.agentRules.length === 0
				? "No agent rules; press v, select activity, then d to draft one."
				: undefined;

		if (!layout.framed) {
			if (layout.total > 1) lines.push(paint(`Policy · ${this.view === "rules" ? "Rules" : "Activity"} · ${position}`));
			if (layout.bodyRows > 0) lines.push(paint(this.listHeader(width)));
			const hintRows = noAgentsHint && layout.bodyRows > 1 ? 1 : 0;
			if (hintRows) lines.push(paint(noAgentsHint!));
			const available = Math.max(0, layout.bodyRows - 1 - hintRows);
			if (available > 0) {
				if (this.view === "rules") {
					if (this.selectedRule < this.ruleScroll) this.ruleScroll = this.selectedRule;
					if (this.selectedRule >= this.ruleScroll + available) {
						this.ruleScroll = this.selectedRule - available + 1;
					}
				} else {
					if (this.selectedActivity < this.activityScroll) this.activityScroll = this.selectedActivity;
					if (this.selectedActivity >= this.activityScroll + available) {
						this.activityScroll = this.selectedActivity - available + 1;
					}
				}
			}
			const scroll = this.view === "rules" ? this.ruleScroll : this.activityScroll;
			for (let slot = 0; slot < available; slot++) lines.push(paint(this.listRow(scroll + slot, width)));
			lines.push(paint(this.footerText(width)));
			this.cachedWidth = width;
			this.cachedRows = layout.total;
			this.cachedVersion = this.version;
			this.cachedLines = lines.slice(0, layout.total);
			return this.cachedLines;
		}

		lines.push(this.titleBorder(width, position));
		const hintRows = noAgentsHint ? 1 : 0;
		const listItemRows = Math.max(0, layout.bodyRows - 1 - hintRows);
		if (this.view === "rules") {
			if (this.selectedRule < this.ruleScroll) this.ruleScroll = this.selectedRule;
			if (this.selectedRule >= this.ruleScroll + listItemRows) {
				this.ruleScroll = Math.max(0, this.selectedRule - listItemRows + 1);
			}
		} else {
			if (this.selectedActivity < this.activityScroll) this.activityScroll = this.selectedActivity;
			if (this.selectedActivity >= this.activityScroll + listItemRows) {
				this.activityScroll = Math.max(0, this.selectedActivity - listItemRows + 1);
			}
		}
		this.detailScroll = Math.min(this.detailScroll, this.detailMaxScroll());
		const detail = this.detailSource(layout.detailWidth).slice(this.detailScroll, this.detailScroll + layout.bodyRows);
		const scroll = this.view === "rules" ? this.ruleScroll : this.activityScroll;
		for (let bodyIndex = 0; bodyIndex < layout.bodyRows; bodyIndex++) {
			let listCell = "";
			if (bodyIndex === 0) listCell = theme.bold(theme.fg("dim", this.listHeader(layout.listWidth)));
			else if (noAgentsHint && bodyIndex === 1) listCell = theme.fg("warning", noAgentsHint);
			else {
				const rowSlot = bodyIndex - 1 - hintRows;
				if (rowSlot >= 0) {
					const absolute = scroll + rowSlot;
					const row = this.listRow(absolute, layout.listWidth);
					const isSelected = absolute === selected;
					listCell = theme.fg(isSelected ? "accent" : "text", row);
				}
			}
			lines.push(
				theme.bg(
					"customMessageBg",
					`${theme.fg("borderMuted", "│ ")}${fitText(listCell, layout.listWidth)}${theme.fg("borderMuted", " │ ")}${fitText(detail[bodyIndex] ?? "", layout.detailWidth)}${theme.fg("borderMuted", " │")}`,
				),
			);
		}
		lines.push(theme.bg("customMessageBg", theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`)));
		lines.push(
			theme.bg(
				"customMessageBg",
				`${theme.fg("borderMuted", "│ ")}${fitText(this.footerText(layout.innerWidth), layout.innerWidth)}${theme.fg("borderMuted", " │")}`,
			),
		);
		lines.push(theme.bg("customMessageBg", theme.fg("borderMuted", `└${"─".repeat(Math.max(0, width - 2))}┘`)));

		this.cachedWidth = width;
		this.cachedRows = layout.total;
		this.cachedVersion = this.version;
		this.cachedLines = lines.slice(0, layout.total);
		return this.cachedLines;
	}

	dispose(): void {
		this.finished = true;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedRows = -1;
		this.cachedVersion = -1;
		this.cachedLines = [];
	}
}
