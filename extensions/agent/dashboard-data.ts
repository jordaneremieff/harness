/** Read-only, process-local observations of ordinary native sessions. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, type Stats } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION, parseSessionEntries, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import type { AgentSessionSummary } from "./command.ts";
import type { DetachedRunView } from "./detached.ts";
import { MAX_CAPTURE_BYTES } from "./store.ts";

export interface SessionDigest extends AgentSessionSummary {
	path: string;
	createdAt: number;
	state: "working" | "idle" | "done" | "failed" | "stopped" | "interrupted" | "new" | "orphaned" | "unavailable";
	owner?: "here" | "window" | "detached" | "unknown";
	ownerLabel?: string;
	/** All captured native usage, across branches; incomplete when partial. */
	cost: number;
	partial: boolean;
	latestReply: string;
	error?: string;
	/** Tool calls on the captured active branch. */
	toolCalls: number;
	/** First unresolved call in the latest assistant batch, not proof of execution. */
	currentTool?: { name: string; argument: string };
	/** Latest user turn's observed span; absent without an established start. */
	durationMs?: number;
}

export interface DashboardOverlay {
	held: string[];
	active: string[];
	busy?: string[];
	runs: DetachedRunView[];
}

export interface DashboardConversation {
	entries: SessionEntry[];
	partial: boolean;
	revision: string;
}

interface Capture extends DashboardConversation {
	header: SessionHeader;
	head: SessionEntry[];
	all: SessionEntry[];
	modifiedAt: number;
}
interface CachedDigest {
	revision: string;
	digest: SessionDigest;
	turnStart?: number;
	readError?: string;
}
interface Claim {
	kind: "absent" | "live" | "dead" | "unknown";
	label?: string;
	error?: string;
}

const HEADER_BYTES = 16 * 1024;
const HEAD_BYTES = 1024 * 1024;
const CLAIM_BYTES = 16 * 1024;
const REPLY_CHARS = 32 * 1024;
const TASK_CHARS = 4096;
const ENTRY_TYPES = new Set(["message", "model_change", "thinking_level_change", "usage", "compaction", "branch_summary", "custom", "custom_message", "context_edit", "label", "session_info"]);
const STOP_REASONS = new Set(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]);

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === "string"; }
function nonempty(value: unknown): value is string { return text(value) && value.length > 0; }
function timestamp(value: unknown): value is string { return text(value) && Number.isFinite(Date.parse(value)); }
function number(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function revision(stat: Stats): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }

function validContent(value: unknown, stringAllowed = true): boolean {
	if (stringAllowed && text(value)) return true;
	return Array.isArray(value) && value.every((block: unknown) => {
		if (!record(block)) return false;
		switch (block.type) {
			case "text": return text(block.text);
			case "image": return text(block.data) && text(block.mimeType);
			case "thinking": return text(block.thinking) || block.redacted === true;
			case "toolCall": return nonempty(block.id) && nonempty(block.name) && record(block.arguments);
			default: return false;
		}
	});
}

function validMessage(message: unknown): boolean {
	if (!record(message) || !nonempty(message.role) || !number(message.timestamp)) return false;
	if (message.role === "bashExecution") return text(message.command) && text(message.output) && typeof message.cancelled === "boolean" && typeof message.truncated === "boolean";
	if (message.role === "branchSummary" || message.role === "compactionSummary") return text(message.summary);
	if (!validContent(message.content, message.role !== "assistant" && message.role !== "toolResult")) return false;
	if (message.role === "assistant") return nonempty(message.provider) && nonempty(message.model) && nonempty(message.api) && text(message.stopReason) && STOP_REASONS.has(message.stopReason) && (message.errorMessage === undefined || text(message.errorMessage));
	if (message.role === "toolResult") return nonempty(message.toolCallId) && nonempty(message.toolName) && typeof message.isError === "boolean";
	return true;
}

function validMetadata(value: Record<string, unknown>): boolean {
	switch (value.type) {
		case "message": return validMessage(value.message);
		case "model_change": return nonempty(value.provider) && nonempty(value.modelId);
		case "thinking_level_change": return text(value.thinkingLevel);
		case "session_info": return value.name === undefined || text(value.name);
		case "usage": return nonempty(value.kind) && nonempty(value.provider) && nonempty(value.model);
		case "compaction": return text(value.summary) && nonempty(value.firstKeptEntryId) && number(value.tokensBefore);
		case "branch_summary": return text(value.summary) && (value.fromId === null || nonempty(value.fromId));
		case "custom": return nonempty(value.customType);
		case "custom_message": return nonempty(value.customType) && validContent(value.content) && typeof value.display === "boolean";
		case "context_edit": return nonempty(value.targetId) && (value.replacement === null || (record(value.replacement) && validContent(value.replacement.content)));
		case "label": return nonempty(value.targetId) && (value.label === undefined || text(value.label));
		default: return false;
	}
}

/** Native parsing tolerates broken JSON; these checks protect consumers from broken entry shapes. */
function validEntry(value: unknown): value is SessionEntry {
	return record(value) && text(value.type) && ENTRY_TYPES.has(value.type) && nonempty(value.id)
		&& (value.parentId === null || nonempty(value.parentId)) && timestamp(value.timestamp) && validMetadata(value);
}

function readBytes(fd: number, start: number, length: number): Buffer {
	const buffer = Buffer.alloc(length);
	let bytes = 0;
	while (bytes < length) {
		const count = readSync(fd, buffer, bytes, length - bytes, start + bytes);
		if (!count) break;
		bytes += count;
	}
	return buffer.subarray(0, bytes);
}

function activeBranch(entries: SessionEntry[]): { entries: SessionEntry[]; partial: boolean } {
	const byId = new Map<string, SessionEntry>();
	const duplicates = new Set<string>();
	for (const entry of entries) {
		if (byId.has(entry.id)) duplicates.add(entry.id);
		byId.set(entry.id, entry);
	}
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let id: string | null = entries.at(-1)?.id ?? null;
	let partial = duplicates.size > 0;
	while (id !== null) {
		const entry = byId.get(id);
		if (!entry || duplicates.has(id) || seen.has(id)) { partial = true; break; }
		seen.add(id);
		branch.push(entry);
		id = entry.parentId;
	}
	return { entries: branch.reverse(), partial };
}

function capture(path: string): Capture {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("Native session is not a regular file");
		const head = readBytes(fd, 0, Math.min(HEADER_BYTES, stat.size));
		const newline = head.indexOf(10);
		if (newline < 0) throw new Error("Native session header is unfinished or exceeds its read bound");
		const header: unknown = JSON.parse(head.toString("utf8", 0, newline));
		if (!record(header) || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION
			|| !nonempty(header.id) || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(header.id)
			|| !text(header.cwd) || !isAbsolute(header.cwd) || !timestamp(header.timestamp)) throw new Error("Not a current native session header");
		let content: string;
		let headEntries: SessionEntry[] = [];
		let partial = stat.size > MAX_CAPTURE_BYTES;
		if (partial) {
			const prefix = Buffer.concat([head, readBytes(fd, head.length, HEAD_BYTES - head.length)]);
			headEntries = parseSessionEntries(prefix.toString("utf8", newline + 1, prefix.lastIndexOf(10) + 1)).filter(validEntry);
			const start = stat.size - (MAX_CAPTURE_BYTES - HEAD_BYTES) + 1;
			const tail = readBytes(fd, start - 1, stat.size - start + 1);
			// The preceding byte decides whether the bounded tail starts at a full line.
			const boundary = tail.indexOf(10);
			content = boundary < 0 ? "" : tail.toString("utf8", boundary + 1);
		} else {
			const rest = readBytes(fd, head.length, stat.size - head.length);
			content = Buffer.concat([head, rest]).subarray(newline + 1).toString("utf8");
			if (head.length + rest.length !== stat.size) partial = true;
		}
		const parsed: unknown[] = parseSessionEntries(content);
		const lineCount = content.split("\n").filter((line) => line.trim()).length;
		const all = parsed.filter(validEntry);
		if (parsed.length !== lineCount || all.length !== parsed.length) partial = true;
		const branch = activeBranch(all);
		if (revision(fstatSync(fd)) !== revision(stat)) partial = true;
		return {
			header: header as unknown as SessionHeader, head: headEntries, all, entries: branch.entries,
			partial: partial || branch.partial, revision: revision(stat), modifiedAt: stat.mtimeMs,
		};
	} finally { closeSync(fd); }
}

function contentText(content: unknown): string {
	if (text(content)) return content;
	return Array.isArray(content) ? content.flatMap((block: unknown) => record(block) && block.type === "text" && text(block.text) ? [block.text] : []).join("\n") : "";
}
function shortArgument(value: unknown): string {
	if (!record(value)) return "";
	const preferred = ["command", "path", "query", "url"].find((key) => text(value[key]));
	return (preferred ? String(value[preferred]) : JSON.stringify(value)).replace(/\s+/gu, " ").slice(0, 180);
}

function digestCapture(path: string, captured: Capture): CachedDigest {
	const row: SessionDigest = {
		sessionId: captured.header.id, cwd: captured.header.cwd, path,
		createdAt: Date.parse(captured.header.timestamp), modifiedAt: captured.modifiedAt,
		live: false, provenance: "stored", state: "new", cost: 0, partial: captured.partial,
		latestReply: "", toolCalls: 0,
	};
	for (const entry of [...captured.head, ...captured.all]) {
		if (entry.type === "session_info") row.name = entry.name?.trim().slice(0, TASK_CHARS) || undefined;
		addCost(row, entry);
	}
	const branch: BranchState = { row, thinkingLevel: "", explicitModel: false, meaningful: false, rooted: captured.entries[0]?.parentId === null, pending: new Map() };
	seedIdentity(branch, captured.head);
	for (const entry of captured.entries) observeEntry(branch, entry);
	if (!branch.meaningful && captured.partial) row.state = "unavailable";
	row.currentTool = branch.pending.values().next().value;
	if (branch.turnStart === undefined && captured.head.length) branch.turnStart = capturedTurnStart(captured);
	row.durationMs = branch.turnStart === undefined || branch.turnEnd === undefined ? undefined : Math.max(0, branch.turnEnd - branch.turnStart);
	return { revision: captured.revision, digest: row, turnStart: branch.turnStart };
}

function capturedTurnStart(captured: Capture): number | undefined {
	if (!captured.entries.length) return undefined;
	// A head timestamp is usable only when retained ancestry connects it to the tail.
	const entries = activeBranch([...captured.head, ...captured.all]).entries;
	const user = entries.findLast((entry) => entry.type === "message" && entry.message.role === "user");
	return user?.type === "message" ? user.message.timestamp : undefined;
}

function entryUsage(entry: SessionEntry): { usage: unknown; required: boolean } {
	if (entry.type === "usage") return { usage: entry.usage, required: true };
	if (entry.type === "compaction" || entry.type === "branch_summary") return { usage: entry.usage, required: false };
	if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) return { usage: entry.message.usage, required: entry.message.role === "assistant" };
	return { usage: undefined, required: false };
}

function addCost(row: SessionDigest, entry: SessionEntry): void {
	const { usage, required } = entryUsage(entry);
	if (usage === undefined && !required) return;
	const total = record(usage) && record(usage.cost) ? usage.cost.total : undefined;
	if (number(total) && total >= 0 && Number.isFinite(row.cost + total)) row.cost += total;
	else row.partial = true;
}

interface BranchState {
	row: SessionDigest;
	thinkingLevel: string;
	explicitModel: boolean;
	meaningful: boolean;
	rooted: boolean;
	turnStart?: number;
	turnEnd?: number;
	pending: Map<string, { name: string; argument: string }>;
}

function seedIdentity(branch: BranchState, head: SessionEntry[]): void {
	const entries = activeBranch(head).entries;
	const rooted = entries[0]?.parentId === null;
	for (const entry of entries) {
		if (entry.type === "model_change" || entry.type === "thinking_level_change") observeEntry(branch, entry);
		else if (entry.type === "message" && entry.message.role === "user" && rooted && !branch.rooted && branch.row.firstMessage === undefined) {
			branch.row.firstMessage = contentText(entry.message.content).slice(0, TASK_CHARS);
		}
	}
}

function observeEntry(branch: BranchState, entry: SessionEntry): void {
	if (entry.type === "model_change") {
		branch.row.model = { provider: entry.provider, modelId: entry.modelId, thinkingLevel: branch.thinkingLevel };
		branch.explicitModel = true;
	} else if (entry.type === "thinking_level_change") {
		branch.thinkingLevel = entry.thinkingLevel;
		if (branch.row.model) branch.row.model.thinkingLevel = entry.thinkingLevel;
	}
	if (entry.type === "message") observeMessage(branch, entry);
}

function observeMessage(branch: BranchState, entry: Extract<SessionEntry, { type: "message" }>): void {
	const { row, pending } = branch;
	const message = entry.message;
	if (message.role === "user") {
		if (row.firstMessage === undefined && branch.rooted) row.firstMessage = contentText(message.content).slice(0, TASK_CHARS);
		branch.turnStart = message.timestamp;
		row.state = "interrupted";
		row.error = undefined;
		pending.clear();
	} else if (message.role === "assistant") {
		observeAssistant(branch, message);
	} else if (message.role === "toolResult") {
		pending.delete(message.toolCallId);
		// Error/abort can retain cancelled tool results after the terminal response.
		if (row.state !== "failed" && row.state !== "stopped") row.state = "interrupted";
	} else return;
	branch.meaningful = true;
	branch.turnEnd = Date.parse(entry.timestamp);
}

function assistantState(message: AssistantMessage, hasTools: boolean): SessionDigest["state"] {
	if (message.stopReason === "error") return "failed";
	if (message.stopReason === "aborted") return "stopped";
	if (["stop", "length"].includes(message.stopReason) && !hasTools) return "done";
	return "interrupted";
}

function observeAssistant(branch: BranchState, message: AssistantMessage): void {
	const { row, pending } = branch;
	if (!branch.explicitModel) row.model = { provider: message.provider, modelId: message.model, thinkingLevel: branch.thinkingLevel };
	const reply = contentText(message.content).trim();
	if (reply) row.latestReply = reply.length > REPLY_CHARS ? `${reply.slice(0, REPLY_CHARS)}\n…` : reply;
	pending.clear();
	for (const block of message.content) if (block.type === "toolCall") {
		row.toolCalls += 1;
		pending.set(block.id, { name: block.name, argument: shortArgument(block.arguments) });
	}
	row.state = assistantState(message, pending.size > 0);
	row.error = message.errorMessage?.slice(0, TASK_CHARS);
	if (row.state !== "interrupted") pending.clear();
}

function observeClaim(nativeRoot: string, row: SessionDigest): Claim {
	let fd: number | undefined;
	try {
		const directory = join(nativeRoot, ".claims");
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: "unknown", error: "Writer claim directory is not a regular directory" };
		const key = createHash("sha256").update(JSON.stringify([resolve(row.cwd), row.sessionId])).digest("hex");
		fd = openSync(join(directory, `${key}.lock`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > CLAIM_BYTES) return { kind: "unknown", error: "Writer claim exceeds its read bound or is not a regular file" };
		const bytes = readBytes(fd, 0, CLAIM_BYTES + 1);
		if (bytes.length > CLAIM_BYTES) return { kind: "unknown", error: "Writer claim exceeds its read bound" };
		const claim: unknown = JSON.parse(bytes.toString("utf8"));
		return classifyClaim(claim, row);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unknown", error: `Writer claim is unreadable: ${reason(error)}` };
	} finally { if (fd !== undefined) closeSync(fd); }
}

function classifyClaim(claim: unknown, row: SessionDigest): Claim {
	if (!record(claim) || claim.sessionId !== row.sessionId || claim.cwd !== resolve(row.cwd)
		|| !nonempty(claim.host) || !timestamp(claim.createdAt) || new Date(claim.createdAt).toISOString() !== claim.createdAt || !Number.isSafeInteger(claim.pid)
		|| Number(claim.pid) <= 0 || Number(claim.pid) > 2147483647) return { kind: "unknown", error: "Writer claim is invalid" };
	if (claim.host !== hostname()) return { kind: "unknown", label: claim.host, error: "Writer claim belongs to another host" };
	const pid = Number(claim.pid);
	try { process.kill(pid, 0); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return { kind: "dead", label: `PID ${pid}`, error: "Writer claim remains after its process exited" };
		if (code !== "EPERM") return { kind: "unknown", error: `Writer process check failed (${code ?? "unknown"})` };
	}
	return { kind: "live", label: `PID ${pid}` };
}

function applyLocalOwner(row: SessionDigest, overlay: DashboardOverlay): void {
	row.owner = "here"; row.ownerLabel = "This window"; row.live = true; row.provenance = "live";
	if (overlay.active.includes(row.sessionId)) row.state = "working";
	else if (overlay.busy?.includes(row.sessionId)) { row.state = "unavailable"; row.error = "Session host is busy or unavailable"; }
	else if (row.state !== "failed" && row.state !== "stopped") row.state = "idle";
}

function applyDetachedOwner(row: SessionDigest, run: DetachedRunView): void {
	row.owner = "detached"; row.ownerLabel = `PID ${run.pid}`; row.live = true; row.state = "working";
	row.detachedRunId = run.runId;
	if (run.progress?.currentTool) row.currentTool = { name: run.progress.currentTool, argument: "" };
	if (run.progress?.error) row.error = run.progress.error;
}

function applyClaim(row: SessionDigest, claim: Claim): void {
	if (claim.kind === "dead" || claim.kind === "unknown") {
		row.owner = "unknown"; row.ownerLabel = claim.label; row.error = claim.error;
		row.state = claim.kind === "dead" ? "orphaned" : "unavailable";
	} else if (claim.kind === "live") {
		row.owner = "window"; row.ownerLabel = claim.label; row.live = true;
		if (row.state === "interrupted") row.state = "working";
		else if (row.state === "new") row.state = "idle";
	}
}

function applyRunResult(row: SessionDigest, runs: DetachedRunView[]): void {
	const terminal = runs.filter((run) => run.finishedAt && Date.parse(run.finishedAt) >= row.modifiedAt)
		.sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
	if (!terminal) return;
	if (terminal.state === "failed") { row.state = "failed"; row.error = terminal.error; }
	else if (terminal.state === "finished" && row.state !== "failed" && row.state !== "stopped") row.state = "done";
	if (terminal.summary && !row.latestReply) row.latestReply = terminal.summary;
}

function applyOverlay(cached: CachedDigest, nativeRoot: string, overlay?: DashboardOverlay): SessionDigest {
	const row = { ...cached.digest,
		model: cached.digest.model ? { ...cached.digest.model } : undefined,
		currentTool: cached.digest.currentTool ? { ...cached.digest.currentTool } : undefined,
	};
	if (cached.readError) return row;
	const runs = overlay?.runs.filter((run) => (run.currentSessionId ?? run.sessionId) === row.sessionId && resolve(run.cwd) === resolve(row.cwd)) ?? [];
	const liveRun = runs.filter((run) => run.state === "running" || run.state === "launching").sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
	if (overlay?.held.includes(row.sessionId)) applyLocalOwner(row, overlay);
	else if (liveRun) applyDetachedOwner(row, liveRun);
	else {
		const claim = observeClaim(nativeRoot, row);
		if (claim.kind === "absent") applyRunResult(row, runs);
		else applyClaim(row, claim);
	}
	if (row.state === "working" && cached.turnStart !== undefined) row.durationMs = Math.max(0, Date.now() - cached.turnStart);
	if (row.state !== "working" && row.state !== "interrupted") row.currentTool = undefined;
	return row;
}

/** Digest cache holds no transcripts. Only the selected conversation retains native entries. */
export class AgentDashboardData {
	private readonly nativeRoot: string;
	private readonly cache = new Map<string, CachedDigest>();
	private selected?: { path: string; sessionId: string; value: DashboardConversation };

	constructor(nativeRoot: string) { this.nativeRoot = resolve(nativeRoot); }

	async read(overlay?: DashboardOverlay): Promise<SessionDigest[]> {
		let files: string[];
		try {
			const root = lstatSync(this.nativeRoot);
			if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Native session root is not a regular directory");
			files = readdirSync(this.nativeRoot).filter((name) => name.endsWith(".jsonl"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.cache.clear(); this.selected = undefined; return [];
		}
		const found = new Set<string>();
		for (const name of files) this.refreshFile(join(this.nativeRoot, name), found);
		for (const path of this.cache.keys()) if (!found.has(path)) this.cache.delete(path);
		if (this.selected && !found.has(this.selected.path)) this.selected = undefined;
		const byId = new Map<string, CachedDigest[]>();
		for (const cached of this.cache.values()) {
			const group = byId.get(cached.digest.sessionId) ?? [];
			group.push(cached); byId.set(cached.digest.sessionId, group);
		}
		return [...byId.values()].map((group): SessionDigest => group.length === 1 ? applyOverlay(group[0], this.nativeRoot, overlay) : {
			...group[0].digest, state: "unavailable", owner: "unknown", partial: true, live: false,
			latestReply: "", cost: 0, toolCalls: 0, currentTool: undefined, durationMs: undefined,
			error: `Session ID occurs in ${group.length} native files; observation is ambiguous`,
		}).sort((a, b) => b.modifiedAt - a.modifiedAt || a.sessionId.localeCompare(b.sessionId));
	}

	private refreshFile(path: string, found: Set<string>): void {
		let stat: Stats;
		try { stat = lstatSync(path); } catch { return; }
		if (!stat.isFile() || stat.isSymbolicLink()) return;
		found.add(path);
		const cached = this.cache.get(path);
		if (cached?.revision === revision(stat)) return;
		if (this.selected?.path === path) this.selected = undefined;
		try { this.cache.set(path, digestCapture(path, capture(path))); }
		catch (error) {
			if (cached) this.cache.set(path, { revision: revision(stat), readError: reason(error), digest: {
				...cached.digest, modifiedAt: stat.mtimeMs, state: "unavailable", partial: true, live: false,
				latestReply: "", cost: 0, toolCalls: 0, durationMs: undefined, currentTool: undefined, error: reason(error),
			} });
		}
	}

	async conversation(sessionId: string): Promise<DashboardConversation> {
		await this.read();
		const matches = [...this.cache.values()].filter((item) => item.digest.sessionId === sessionId);
		if (matches.length !== 1) throw new Error(matches.length ? "Session ID occurs in multiple native files" : "Native session is not available");
		const cached = matches[0];
		if (cached.readError) throw new Error(cached.readError);
		const path = cached.digest.path;
		if (this.selected?.path !== path || this.selected.sessionId !== sessionId || this.selected.value.revision !== cached.revision) {
			const captured = capture(path);
			if (captured.header.id !== sessionId) throw new Error("Native session identity changed during observation");
			this.cache.set(path, digestCapture(path, captured));
			this.selected = { path, sessionId, value: { entries: captured.entries, partial: captured.partial, revision: captured.revision } };
		}
		return structuredClone(this.selected.value);
	}
}
