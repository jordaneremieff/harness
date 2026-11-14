import { str, int, bool, nul, lit, union, arr, opt, obj, type Static } from "@earendil-works/pi-schema";
import { constants } from "node:fs";
import { open, lstat, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import type { PrimaryInfo } from "./primary-channel.ts";

/** Independent limits apply before parsing, text scanning, and serialization. */
export const PRIMARY_OBSERVATION_LIMITS = {
	headerBytes: 16 * 1024, bytes: 512 * 1024, lines: 2048, lineBytes: 64 * 1024,
	parentVisits: 256, items: 20, textSlots: 128, textScanBytes: 32 * 1024,
	textBytes: 2048, outputBytes: 24 * 1024, exactPageBytes: 16 * 1024,
} as const;
const AncestryViewSchema = union([lit("status"), lit("activity"), lit("history")]);
const ViewSchema = union([lit("status"), lit("activity"), lit("history"), lit("exact")]);
const locatorProperties = { id: str(), parentId: union([str(), nul()]), timestamp: str(), byteOffset: int({ minimum: 0 }) };
const LocatorSchema = obj(locatorProperties);
const PinSchema = obj({ dev: str(), ino: str(), size: int({ minimum: 0 }), mtimeNs: str(), ctimeNs: str() });
const CursorSchema = obj({ version: lit(1), sessionId: str(), path: str(), pin: PinSchema, headId: str(), nextId: str(), view: AncestryViewSchema });
/** Locates one immutable record of an append-only session file: its identity survives later appends. */
const ExactCursorSchema = obj({
	version: lit(1), view: lit("exact"), sessionId: str(), file: obj({ dev: str(), ino: str() }),
	entryId: str(), byteOffset: int({ minimum: 0 }), offset: int({ minimum: 0 }),
});
const EntrySchema = obj({
	...locatorProperties, kind: str(), role: opt(str()), text: opt(str()),
	toolNames: opt(arr(str(), { maxItems: 16 })), isError: opt(bool()),
	error: opt(str()), stopReason: opt(str()),
	targetId: opt(str()), firstKeptEntryId: opt(str()), fromId: opt(str()),
	textCursor: opt(ExactCursorSchema),
});
const PageSchema = obj({ offset: int({ minimum: 0 }), endOffset: int({ minimum: 0 }), totalUnits: int({ minimum: 0 }) });
const IntentSchema = obj({
	purpose: str(), integration: str(), authority: str(), updatedAt: str(),
	contactThread: opt(str()),
	scope: obj({ paths: arr(str()), branches: arr(str()), fullGate: opt(bool()) }),
});
export const OrdinaryPrimaryObservationSchema = obj({
	kind: lit("ordinary-primary"), view: ViewSchema, sessionId: str(), observedAt: str(),
	presence: obj({
		basis: lit("endpoint-record"), cwd: str(), name: opt(str()),
		model: opt(obj({ provider: str(), modelId: str() })),
		intentClaim: opt(IntentSchema), lastActivityAt: opt(str()),
		process: obj({ pid: int(), hostname: str(), state: union([lit("live"), lit("dead"), lit("unknown")]), basis: lit("local-pid-probe"), attribution: lit("process-existence-not-session-progress") }),
	}),
	unknown: obj({ idle: lit("unknown"), selectedLeaf: lit("unknown"), timers: lit("unknown"), tasks: lit("unknown"), unretainedActivity: lit("unknown") }),
	source: obj({ path: opt(str()), pin: opt(PinSchema), ancestry: union([lit("latest-retained-ancestry"), lit("retained-entry")]), head: opt(LocatorSchema), latestKnown: bool() }),
	entries: arr(EntrySchema, { maxItems: PRIMARY_OBSERVATION_LIMITS.items }),
	page: opt(PageSchema),
	coverage: obj({ complete: bool(), reasons: arr(str()), bytesRead: int(), linesVisited: int(), parentVisits: int(), textScanBytes: int(), omissions: obj({ credentials: int(), fields: int(), text: int() }) }),
	nextCursor: opt(union([CursorSchema, ExactCursorSchema])),
});
export type OrdinaryPrimaryObservation = Static<typeof OrdinaryPrimaryObservationSchema>;
type Entry = Static<typeof EntrySchema>;
type Cursor = Static<typeof CursorSchema>;
type ExactCursor = Static<typeof ExactCursorSchema>;
/** Set when a text field of the projected entry was clipped or omitted for size. */
type Clip = { clipped: boolean };
type Pin = Static<typeof PinSchema>;
type Raw = Record<string, unknown>;
const ENTRY_ID = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const KINDS = new Set(["message", "model_change", "thinking_level_change", "usage", "compaction", "context_edit", "branch_summary", "custom", "custom_message", "label", "session_info"]);
function object(value: unknown): value is Raw { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === "string" && value.length <= 36 && ENTRY_ID.test(value); }
function fromId(value: unknown): value is string { return value === "root" || id(value); }
function timestamp(value: unknown): value is string { return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)); }
type TextObservation = Pick<OrdinaryPrimaryObservation, "coverage">;
function reason(result: TextObservation, why: string): void {
	result.coverage.complete = false;
	if (!result.coverage.reasons.includes(why)) result.coverage.reasons.push(why);
}
/** Cut only after a complete Unicode code point. */
function excerpt(text: string, bytes: number): string {
	let end = 0, used = 0;
	for (const point of text) { const width = Buffer.byteLength(point); if (used + width > bytes) break; used += width; end += point.length; }
	return text.slice(0, end);
}
interface Span { start: number; end: number }
interface MatchView { text: string; starts: number[]; ends: number[] }
const CREDENTIAL_PATTERNS = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gu,
	/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gu,
	/\bBearer[ \t]+[A-Za-z0-9._~+/-]{16,}={0,2}/giu,
	/\b(?:Authorization|Proxy-Authorization)[ \t]*:[ \t]*(?:Basic|Bearer|Token|ApiKey)[ \t]+[A-Za-z0-9._~+/-]{8,}={0,2}/giu,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
];
const CREDENTIAL_ASSIGNMENT = /\b(?:[a-z][a-z0-9_]*_)?(?:x-api-key|x-auth-token|api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key|secret[_-]?access[_-]?key|password|passwd)["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9_./+~!$%=-]{8,})["']?/giu;
const CONTROL_TEXT = /[\p{Cc}\p{Cf}]/gu;
function unsafeControl(code: number): boolean {
	return code >= 0 && code <= 0x10ffff && /[\p{Cc}\p{Cf}]/u.test(String.fromCodePoint(code));
}
function escapeControls(text: string): string {
	return text.replace(CONTROL_TEXT, character => {
		const code = character.codePointAt(0) ?? 0;
		return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
	});
}
function credentialSpans(text: string): Span[] {
	const spans: Span[] = [];
	for (const pattern of CREDENTIAL_PATTERNS) for (const match of text.matchAll(pattern)) spans.push({ start: match.index, end: match.index + match[0].length });
	for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
		if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.?$/iu.test(match[1] ?? "")) continue;
		spans.push({ start: match.index, end: match.index + match[0].length });
	}
	return spans;
}
/** Decode controls only in a bounded match view; decoded controls never reach output. */
function controlView(escaped: string): MatchView {
	const text: string[] = [], starts: number[] = [], ends: number[] = [];
	const pattern = /\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([nrt]))/iy;
	for (let offset = 0; offset < escaped.length;) {
		const unit = controlUnit(escaped, offset, pattern);
		text.push(unit.text);
		for (let index = 0; index < unit.text.length; index++) { starts.push(offset); ends.push(unit.end); }
		offset = unit.end;
	}
	return { text: text.join(""), starts, ends };
}
function controlUnit(text: string, offset: number, pattern: RegExp): { text: string; end: number } {
	pattern.lastIndex = offset;
	const match = pattern.exec(text);
	if (!match) return { text: text[offset] ?? "", end: offset + 1 };
	const short: Record<string, number> = { n: 10, r: 13, t: 9 };
	const code = match[4] ? short[match[4]] : Number.parseInt(match[1] ?? match[2] ?? match[3] ?? "", 16);
	if (code === undefined || !unsafeControl(code)) return { text: text[offset] ?? "", end: offset + 1 };
	return { text: String.fromCodePoint(code), end: offset + match[0].length };
}
function normalizedView(decoded: MatchView, whitespace: boolean): MatchView {
	const excluded = new Uint8Array(decoded.text.length);
	const ansi = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\|$)|[ -/]*[@-~])|\u009b[0-?]*[ -/]*[@-~]|[\u0090\u0098\u009d-\u009f][^\u0007\u001b\u009c]*(?:\u0007|\u009c|\u001b\\|$)/gu;
	for (const match of decoded.text.matchAll(ansi)) excluded.fill(1, match.index, match.index + match[0].length);
	const text: string[] = [], starts: number[] = [], ends: number[] = [];
	let offset = 0;
	for (const point of decoded.text) {
		const start = offset; offset += point.length;
		if (excluded[start]) continue;
		const character = normalizedCharacter(point, whitespace);
		if (!character) continue;
		text.push(character);
		for (let index = 0; index < character.length; index++) { starts.push(decoded.starts[start + index] ?? 0); ends.push(decoded.ends[start + index] ?? 0); }
	}
	return { text: text.join(""), starts, ends };
}
function normalizedCharacter(character: string, whitespace: boolean): string {
	const code = character.codePointAt(0) ?? -1;
	if (!unsafeControl(code)) return character;
	// Line boundaries separate declarations; normalization must not join their values.
	if (code === 10 || code === 13) return "\n";
	return whitespace && code === 9 ? " " : "";
}
function mergeSpans(spans: Span[]): Span[] {
	const merged: Span[] = [];
	for (const span of spans.sort((left, right) => left.start - right.start || left.end - right.end)) {
		const previous = merged.at(-1);
		if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
		else merged.push({ ...span });
	}
	return merged;
}
function redact(escaped: string, result: TextObservation): string {
	const spans = credentialSpans(escaped);
	const decoded = controlView(escaped);
	for (const whitespace of [false, true]) {
		const view = normalizedView(decoded, whitespace);
		for (const span of credentialSpans(view.text)) spans.push({ start: view.starts[span.start] ?? 0, end: view.ends[span.end - 1] ?? 0 });
	}
	const merged = mergeSpans(spans);
	result.coverage.omissions.credentials += merged.length;
	const chunks: string[] = [];
	let offset = 0;
	for (const span of merged) { chunks.push(escaped.slice(offset, span.start), "[credential omitted]"); offset = span.end; }
	chunks.push(escaped.slice(offset));
	return chunks.join("");
}
/** Reuse credential recognition and control escaping before bounding displayed facts. */
export function safeFactText(value: string, maxBytes = 512): { text: string; truncated: boolean } {
	const result: TextObservation = { coverage: { complete: true, reasons: [], bytesRead: 0, linesVisited: 0, parentVisits: 0, textScanBytes: 0, omissions: { credentials: 0, fields: 0, text: 0 } } };
	const text = safe(value, result, maxBytes);
	return { text: text ?? "[text unavailable: scan budget exceeded]", truncated: text === undefined || result.coverage.reasons.includes("text-output-budget") };
}
/** Bounded provider evidence with explicit credential and size omissions. */
export function safeProviderError(value: string, maxBytes = 4096): { text: string; redacted: boolean; truncated: boolean } {
	const result: TextObservation = { coverage: { complete: true, reasons: [], bytesRead: 0, linesVisited: 0, parentVisits: 0, textScanBytes: 0, omissions: { credentials: 0, fields: 0, text: 0 } } };
	const text = safe(value, result, maxBytes);
	return { text: text ?? "[text unavailable: scan budget exceeded]", redacted: result.coverage.omissions.credentials > 0, truncated: text === undefined || result.coverage.reasons.includes("text-output-budget") };
}
function safe(value: unknown, result: TextObservation, maxBytes = 512, clip?: Clip, scanLimit: number = PRIMARY_OBSERVATION_LIMITS.textScanBytes): string | undefined {
	if (typeof value !== "string") return undefined;
	// Oversized fields are omitted intact so a credential is never cut before recognition.
	const available = scanLimit - result.coverage.textScanBytes;
	if (value.length > available || Buffer.byteLength(value) > available) {
		result.coverage.omissions.fields++; reason(result, "text-scan-budget");
		if (clip) clip.clipped = true;
		return undefined;
	}
	result.coverage.textScanBytes += Buffer.byteLength(value);
	const wellFormed = Buffer.from(value, "utf8").toString("utf8");
	if (wellFormed !== value) { result.coverage.omissions.text++; reason(result, "invalid-unicode-omitted"); }
	const escaped = escapeControls(wellFormed);
	if (escaped !== wellFormed) { result.coverage.omissions.text++; reason(result, "control-text-escaped"); }
	const redacted = redact(escaped, result);
	const short = excerpt(redacted, maxBytes);
	if (short !== redacted) {
		result.coverage.omissions.text++; reason(result, "text-output-budget");
		if (clip) clip.clipped = true;
	}
	return short;
}
function presence(primary: PrimaryInfo, result: OrdinaryPrimaryObservation): void {
	const p = result.presence;
	p.cwd = safe(primary.cwd, result) ?? "[omitted]";
	p.name = safe(primary.name, result);
	p.lastActivityAt = timestamp(primary.lastActivityAt) ? primary.lastActivityAt : undefined;
	if (primary.model) p.model = { provider: safe(primary.model.provider, result, 128) ?? "[omitted]", modelId: safe(primary.model.modelId, result, 128) ?? "[omitted]" };
	projectIntent(primary.intentClaim, result);
	p.process.state = processState(primary);
}
function projectIntent(claim: PrimaryInfo["intentClaim"], result: OrdinaryPrimaryObservation): void {
	if (!claim) return;
	const strings = (values: string[]) => values.slice(0, 8).map(value => safe(value, result, 128) ?? "[omitted]");
	result.presence.intentClaim = {
		purpose: safe(claim.purpose, result, 768) ?? "[omitted]", integration: safe(claim.integration, result, 768) ?? "[omitted]",
		authority: safe(claim.authority, result, 768) ?? "[omitted]", updatedAt: timestamp(claim.updatedAt) ? claim.updatedAt : "unknown",
		scope: { paths: strings(claim.scope.paths), branches: strings(claim.scope.branches), fullGate: claim.scope.fullGate },
		contactThread: safe(claim.contactThread, result, 128),
	};
	if (claim.scope.paths.length > 8 || claim.scope.branches.length > 8) { result.coverage.omissions.fields++; reason(result, "presence-budget"); }
}
function processState(primary: PrimaryInfo): "live" | "dead" | "unknown" {
	if (primary.hostname !== hostname() || !Number.isSafeInteger(primary.pid) || primary.pid <= 0) return "unknown";
	try { process.kill(primary.pid, 0); return "live"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}
function pin(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): Pin {
	return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
function same(a: Pin, b: Pin): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function exactKeys(value: Raw, allowed: readonly string[]): boolean {
	let count = 0;
	for (const key in value) {
		if (!Object.hasOwn(value, key) || !allowed.includes(key) || ++count > allowed.length) return false;
	}
	return count === allowed.length;
}
function digits(value: unknown): boolean { return typeof value === "string" && value.length <= 32 && /^\d+$/u.test(value); }
function exactCursor(value: unknown): value is ExactCursor {
	if (!object(value) || !exactKeys(value, ["version", "view", "sessionId", "file", "entryId", "byteOffset", "offset"]) || value.version !== 1 || value.view !== "exact") return false;
	if (typeof value.sessionId !== "string" || value.sessionId.length > 128 || !id(value.entryId)) return false;
	if (!object(value.file) || !exactKeys(value.file, ["dev", "ino"]) || !digits(value.file.dev) || !digits(value.file.ino)) return false;
	return [value.byteOffset, value.offset].every(n => Number.isSafeInteger(n) && Number(n) >= 0);
}
function cursor(value: unknown): value is Cursor {
	if (!object(value) || !exactKeys(value, ["version", "sessionId", "path", "pin", "headId", "nextId", "view"]) || value.version !== 1 || typeof value.sessionId !== "string" || value.sessionId.length > 128 || typeof value.path !== "string" || value.path.length > 4096 || !id(value.headId) || !id(value.nextId) || typeof value.view !== "string" || !["status", "activity", "history"].includes(value.view)) return false;
	if (!object(value.pin) || !exactKeys(value.pin, ["dev", "ino", "size", "mtimeNs", "ctimeNs"])) return false;
	const p = value.pin;
	return [p.dev, p.ino, p.mtimeNs, p.ctimeNs].every(v => typeof v === "string" && v.length <= 32 && /^\d+$/u.test(v)) && Number.isSafeInteger(p.size) && Number(p.size) >= 0;
}
function parse(bytes: Buffer): Raw | undefined {
	try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); return object(value) ? value : undefined; } catch { return undefined; }
}
function valid(entry: Raw): boolean {
	if (!id(entry.id) || !(entry.parentId === null || id(entry.parentId)) || !timestamp(entry.timestamp) || typeof entry.type !== "string" || !KINDS.has(entry.type)) return false;
	return validFields(entry);
}
function content(value: unknown): boolean { return typeof value === "string" || Array.isArray(value); }
const ENTRY_FIELDS: Record<string, (entry: Raw) => boolean> = {
	message: entry => object(entry.message) && validMessage(entry.message),
	compaction: entry => id(entry.firstKeptEntryId) && typeof entry.summary === "string" && typeof entry.tokensBefore === "number",
	context_edit: entry => id(entry.targetId) && (entry.replacement === null || (object(entry.replacement) && content(entry.replacement.content))),
	branch_summary: entry => fromId(entry.fromId) && typeof entry.summary === "string",
	model_change: entry => typeof entry.provider === "string" && typeof entry.modelId === "string",
	thinking_level_change: entry => typeof entry.thinkingLevel === "string",
	usage: entry => typeof entry.kind === "string" && typeof entry.provider === "string" && typeof entry.model === "string" && object(entry.usage),
	custom: entry => typeof entry.customType === "string",
	custom_message: entry => typeof entry.customType === "string" && typeof entry.display === "boolean" && content(entry.content),
	label: entry => id(entry.targetId) && (entry.label === undefined || typeof entry.label === "string"),
	session_info: entry => entry.name === undefined || typeof entry.name === "string",
};
function validFields(entry: Raw): boolean { return ENTRY_FIELDS[String(entry.type)]?.(entry) ?? false; }
const MESSAGE_FIELDS: Record<string, (message: Raw) => boolean> = {
	user: message => content(message.content), system: message => content(message.content),
	assistant: message => Array.isArray(message.content) && ["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(String(message.stopReason)),
	toolResult: message => Array.isArray(message.content) && typeof message.toolName === "string" && typeof message.toolCallId === "string" && typeof message.isError === "boolean",
	custom: message => content(message.content) && typeof message.customType === "string" && typeof message.display === "boolean",
	bashExecution: message => typeof message.command === "string" && typeof message.output === "string" && typeof message.cancelled === "boolean" && typeof message.truncated === "boolean",
	compactionSummary: message => typeof message.summary === "string", branchSummary: message => typeof message.summary === "string",
};
function validMessage(message: Raw): boolean {
	return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) && typeof message.role === "string" && Object.hasOwn(MESSAGE_FIELDS, message.role) && (MESSAGE_FIELDS[message.role]?.(message) ?? false);
}
/** Text limits of one projection: compact ancestry entries, or the complete text of one exact entry. */
interface Projection { textBytes: number; scanLimit: number; clip: Clip }
const compactProjection = (): Projection => ({ textBytes: PRIMARY_OBSERVATION_LIMITS.textBytes, scanLimit: PRIMARY_OBSERVATION_LIMITS.textScanBytes, clip: { clipped: false } });
function project(raw: Raw, offset: number, result: OrdinaryPrimaryObservation, p: Projection = compactProjection()): Entry {
	const entry: Entry = { id: raw.id as string, parentId: raw.parentId as string | null, timestamp: raw.timestamp as string, byteOffset: offset, kind: raw.type as string };
	for (const key of ["targetId", "firstKeptEntryId"] as const) if (id(raw[key])) entry[key] = raw[key];
	if (raw.type === "branch_summary" && fromId(raw.fromId)) entry.fromId = raw.fromId;
	if (raw.type === "message" && object(raw.message)) projectMessage(raw.message, entry, result, p);
	return entry;
}
function projectMessage(message: Raw, entry: Entry, result: OrdinaryPrimaryObservation, p: Projection): void {
	entry.role = String(message.role);
	if (!["user", "assistant", "toolResult"].includes(entry.role)) return;
	entry.isError = entry.role === "toolResult" ? message.isError === true : entry.role === "assistant" && ["error", "aborted"].includes(String(message.stopReason));
	if (entry.role === "assistant" && ["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(String(message.stopReason))) entry.stopReason = String(message.stopReason);
	entry.error = entry.role === "assistant" ? safe(message.errorMessage, result, 1024) : undefined;
	const names: string[] = [];
	const toolName = entry.role === "toolResult" ? safe(message.toolName, result, 128) : undefined;
	if (toolName !== undefined) names.push(toolName);
	const text = projectContent(message.content, names, result, entry.role === "assistant", p);
	if (text) entry.text = text;
	if (names.length) entry.toolNames = names;
}
function appendText(text: string, value: unknown, result: OrdinaryPrimaryObservation, p: Projection): string {
	const chunk = safe(value, result, p.textBytes, p.clip, p.scanLimit);
	if (chunk === undefined) return text;
	const joined = text ? `${text}\n${chunk}` : chunk;
	const short = excerpt(joined, p.textBytes);
	if (short !== joined) { result.coverage.omissions.text++; reason(result, "text-output-budget"); p.clip.clipped = true; }
	return short;
}
function projectContent(content: unknown, names: string[], result: OrdinaryPrimaryObservation, allowCalls: boolean, p: Projection): string {
	if (typeof content === "string") return appendText("", content, result, p);
	if (!Array.isArray(content)) return "";
	let text = "", slots = 0;
	for (const block of content) {
		if (++slots > PRIMARY_OBSERVATION_LIMITS.textSlots) { reason(result, "text-slot-budget"); break; }
		text = projectBlock(block, text, names, result, allowCalls, p);
	}
	return text;
}
function projectBlock(block: unknown, text: string, names: string[], result: OrdinaryPrimaryObservation, allowCalls: boolean, p: Projection): string {
	if (!object(block)) { reason(result, "malformed-content-block"); return text; }
	if (block.type === "text" && typeof block.text === "string") return appendText(text, block.text, result, p);
	if (block.type === "image" || block.type === "thinking") return text;
	if (block.type === "toolCall" && allowCalls && typeof block.name === "string") { appendToolName(block.name, names, result, p.scanLimit); return text; }
	reason(result, "malformed-content-block");
	return text;
}
function appendToolName(value: unknown, names: string[], result: OrdinaryPrimaryObservation, scanLimit: number): void {
	if (names.length >= 16) { reason(result, "tool-name-budget"); return; }
	const name = safe(value, result, 128, undefined, scanLimit);
	if (name !== undefined) names.push(name);
}

type Input = { view?: "status" | "activity" | "history" | "exact"; limit?: number; cursor?: unknown; signal?: AbortSignal };
type RecordLocation = { raw: Raw; offset: number };
type Records = Map<string, RecordLocation>;
interface Snapshot { records: Records; pin: Pin }

function initial(primary: PrimaryInfo, input: Input): OrdinaryPrimaryObservation {
	const result: OrdinaryPrimaryObservation = {
		kind: "ordinary-primary", view: input.view ?? "status", sessionId: primary.id, observedAt: new Date().toISOString(),
		presence: { basis: "endpoint-record", cwd: "", process: { pid: primary.pid, hostname: "", state: "unknown", basis: "local-pid-probe", attribution: "process-existence-not-session-progress" } },
		unknown: { idle: "unknown", selectedLeaf: "unknown", timers: "unknown", tasks: "unknown", unretainedActivity: "unknown" },
		source: { ancestry: "latest-retained-ancestry", latestKnown: false }, entries: [],
		coverage: { complete: true, reasons: [], bytesRead: 0, linesVisited: 0, parentVisits: 0, textScanBytes: 0, omissions: { credentials: 0, fields: 0, text: 0 } },
	};
	presence(primary, result);
	result.presence.process.hostname = safe(primary.hostname, result, 128) ?? "[omitted]";
	return result;
}
function validateInput(input: Input, result: OrdinaryPrimaryObservation): boolean {
	if (result.view === "exact") {
		if (!exactCursor(input.cursor)) { reason(result, "invalid-cursor"); return false; }
		if (input.cursor.sessionId !== result.sessionId) { reason(result, "cursor-source-mismatch"); return false; }
		return true;
	}
	if (input.cursor !== undefined && !cursor(input.cursor)) { reason(result, "invalid-cursor"); return false; }
	if (!["status", "activity", "history"].includes(result.view) || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))) { reason(result, "invalid-input"); return false; }
	return true;
}
function validatePath(path: string | undefined, continuation: Cursor | ExactCursor | undefined, result: OrdinaryPrimaryObservation): path is string {
	if (!path) { reason(result, "no-session-file"); return false; }
	if (!isAbsolute(path) || path.length > 4096 || Buffer.byteLength(path) > 4096 || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(path)) { reason(result, "invalid-session-path"); return false; }
	if (safe(path, result, 4096) !== path) { reason(result, "sensitive-session-path"); return false; }
	result.source.path = path;
	if (continuation && continuation.view !== "exact" && (continuation.path !== path || continuation.sessionId !== result.sessionId || continuation.view !== result.view)) { reason(result, "cursor-source-mismatch"); return false; }
	return true;
}
async function readRange(file: FileHandle, offset: number, length: number, result: OrdinaryPrimaryObservation, signal?: AbortSignal): Promise<Buffer> {
	signal?.throwIfAborted();
	const data = Buffer.alloc(length);
	const { bytesRead } = await file.read(data, 0, length, offset);
	result.coverage.bytesRead += bytesRead;
	if (bytesRead !== length) reason(result, "source-changed");
	return data.subarray(0, bytesRead);
}
/** Offset of the first entry record after a valid header of this session, or undefined. */
async function headerEnd(file: FileHandle, size: number, result: OrdinaryPrimaryObservation, signal?: AbortSignal): Promise<number | undefined> {
	const headerBytes = await readRange(file, 0, Math.min(size, PRIMARY_OBSERVATION_LIMITS.headerBytes), result, signal);
	const newline = headerBytes.indexOf(10);
	const header = newline < 0 ? undefined : parse(headerBytes.subarray(0, newline));
	if (header?.type !== "session" || header.version !== 3 || header.id !== result.sessionId || !timestamp(header.timestamp) || typeof header.cwd !== "string") { reason(result, "invalid-header-or-identity"); return undefined; }
	return newline + 1;
}
async function snapshot(file: FileHandle, continuation: Cursor | undefined, result: OrdinaryPrimaryObservation, signal?: AbortSignal): Promise<Snapshot | undefined> {
	const stat = await file.stat({ bigint: true });
	if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) { reason(result, "not-regular-file"); return undefined; }
	const sourcePin = pin(stat);
	result.source.pin = sourcePin;
	if (continuation && !same(sourcePin, continuation.pin)) { reason(result, "source-changed"); return undefined; }
	const size = Number(stat.size);
	const firstOffset = await headerEnd(file, size, result, signal);
	if (firstOffset === undefined) return undefined;
	const start = Math.max(firstOffset, size - PRIMARY_OBSERVATION_LIMITS.bytes);
	const data = await readRange(file, start, size - start, result, signal);
	return { pin: sourcePin, records: scanRecords(data, start, firstOffset, result, signal) };
}
function parseRecord(data: Buffer, start: number, end: number, result: OrdinaryPrimaryObservation): Raw | undefined {
	if (end - start > PRIMARY_OBSERVATION_LIMITS.lineBytes) { reason(result, "oversize-record"); return undefined; }
	const raw = parse(data.subarray(start, end));
	if (!raw || !valid(raw)) { reason(result, "malformed-record"); return undefined; }
	return raw;
}
function retainRecord(records: Records, raw: Raw | undefined, offset: number, result: OrdinaryPrimaryObservation): void {
	if (!raw) return;
	// The final record alone establishes latestness. Invalid tails never fall back to older heads.
	if (result.coverage.linesVisited === 1) {
		result.source.head = { id: raw.id as string, parentId: raw.parentId as string | null, timestamp: raw.timestamp as string, byteOffset: offset };
		result.source.latestKnown = true;
	}
	if (records.has(raw.id as string)) { reason(result, "duplicate-entry-id"); result.source.latestKnown = false; }
	else records.set(raw.id as string, { raw, offset });
}
function scanRecords(data: Buffer, start: number, firstOffset: number, result: OrdinaryPrimaryObservation, signal?: AbortSignal): Records {
	const records: Records = new Map();
	if (!data.length) return records;
	if (data[data.length - 1] !== 10) { reason(result, "partial-tail-record"); return records; }
	let end = data.length - 1;
	while (end >= 0 && result.coverage.linesVisited < PRIMARY_OBSERVATION_LIMITS.lines) {
		signal?.throwIfAborted();
		const previous = end === 0 ? -1 : data.lastIndexOf(10, end - 1);
		if (previous < 0 && start !== firstOffset) { reason(result, "byte-budget"); break; }
		const offset = previous + 1;
		result.coverage.linesVisited++;
		retainRecord(records, parseRecord(data, offset, end, result), start + offset, result);
		end = previous;
	}
	if (end >= 0 && result.coverage.linesVisited >= PRIMARY_OBSERVATION_LIMITS.lines) reason(result, "line-budget");
	return records;
}
function continuationFor(nextId: string, snapshot: Snapshot, result: OrdinaryPrimaryObservation): Cursor | undefined {
	const head = result.source.head;
	const path = result.source.path;
	return head && path ? { version: 1, sessionId: result.sessionId, path, pin: snapshot.pin, headId: head.id, nextId, view: result.view as Cursor["view"] } : undefined;
}
function emit(record: RecordLocation, snapshot: Snapshot, limit: number, result: OrdinaryPrimaryObservation): boolean {
	const candidate = continuationFor(record.raw.id as string, snapshot, result);
	if (result.entries.length >= limit) { reason(result, "item-budget"); result.nextCursor = candidate; return false; }
	const projection = compactProjection();
	const entry = project(record.raw, record.offset, result, projection);
	if (projection.clip.clipped && result.view !== "status") {
		entry.textCursor = { version: 1, view: "exact", sessionId: result.sessionId, file: { dev: snapshot.pin.dev, ino: snapshot.pin.ino }, entryId: entry.id, byteOffset: record.offset, offset: 0 };
	}
	result.entries.push(entry);
	// Only bounded projected fields reach serialization, never raw entries.
	if (Buffer.byteLength(JSON.stringify({ ...result, nextCursor: candidate })) > PRIMARY_OBSERVATION_LIMITS.outputBytes - 1024) {
		result.entries.pop(); reason(result, "output-budget");
		if (result.entries.length) result.nextCursor = candidate;
		return false;
	}
	return true;
}
function parentOf(record: RecordLocation, records: Records, result: OrdinaryPrimaryObservation): string | null {
	const parent = record.raw.parentId as string | null;
	const parentRecord = parent === null ? undefined : records.get(parent);
	if (parentRecord && parentRecord.offset >= record.offset) { reason(result, "invalid-parent-order"); return null; }
	return parent;
}
function walk(snapshot: Snapshot, continuation: Cursor | undefined, limit: number, result: OrdinaryPrimaryObservation, signal?: AbortSignal): void {
	const head = result.source.head;
	if (!result.source.latestKnown || !head) return;
	if (continuation && continuation.headId !== head.id) { reason(result, "source-changed"); result.source.latestKnown = false; return; }
	walkParents(head.id, snapshot, continuation, limit, result, signal);
}
function walkParents(headId: string, snapshot: Snapshot, continuation: Cursor | undefined, limit: number, result: OrdinaryPrimaryObservation, signal?: AbortSignal): void {
	let next: string | null = headId;
	let emitting = continuation === undefined;
	const visited = new Set<string>();
	while (next !== null && result.coverage.parentVisits < PRIMARY_OBSERVATION_LIMITS.parentVisits) {
		signal?.throwIfAborted();
		const record = visit(next, visited, snapshot.records, result);
		if (!record) break;
		if (next === continuation?.nextId) emitting = true;
		if (emitting && !emit(record, snapshot, limit, result)) break;
		next = parentOf(record, snapshot.records, result);
	}
	if (!emitting) reason(result, "invalid-cursor-ancestry");
	if (next !== null && result.coverage.parentVisits >= PRIMARY_OBSERVATION_LIMITS.parentVisits) reason(result, "parent-visit-budget");
}
function visit(next: string, visited: Set<string>, records: Records, result: OrdinaryPrimaryObservation): RecordLocation | undefined {
	if (visited.has(next)) { reason(result, "parent-cycle"); return undefined; }
	const record = records.get(next);
	if (!record) { reason(result, "unknown-parent"); return undefined; }
	visited.add(next); result.coverage.parentVisits++;
	return record;
}
function discard(result: OrdinaryPrimaryObservation): void { result.entries = []; result.source.latestKnown = false; delete result.nextCursor; delete result.page; }
async function verifySnapshot(file: FileHandle, path: string, sourcePin: Pin, result: OrdinaryPrimaryObservation): Promise<void> {
	const after = pin(await file.stat({ bigint: true }));
	const named = await lstat(path, { bigint: true });
	if (!named.isFile() || !same(sourcePin, after) || !same(sourcePin, pin(named)) || result.coverage.reasons.includes("source-changed")) { reason(result, "source-changed"); discard(result); }
}
function readError(error: unknown, signal: AbortSignal | undefined, result: OrdinaryPrimaryObservation): void {
	const code = (error as NodeJS.ErrnoException).code;
	const failures: Record<string, string> = { ENOENT: "session-file-unavailable", ELOOP: "symlink-refused" };
	reason(result, signal?.aborted ? "aborted" : failures[code ?? ""] ?? "session-file-read-failed");
	discard(result);
}
function splitsPair(text: string, offset: number): boolean {
	const low = text.charCodeAt(offset), high = text.charCodeAt(offset - 1);
	return offset > 0 && low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
}
/** Read the one record that the cursor locates: its line starts at byteOffset, after a newline. */
async function exactRecord(file: FileHandle, at: ExactCursor, result: OrdinaryPrimaryObservation, signal?: AbortSignal): Promise<Raw | undefined> {
	const stat = await file.stat({ bigint: true });
	if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) { reason(result, "not-regular-file"); return undefined; }
	result.source.pin = pin(stat);
	if (result.source.pin.dev !== at.file.dev || result.source.pin.ino !== at.file.ino) { reason(result, "source-changed"); return undefined; }
	const size = Number(stat.size);
	const firstOffset = await headerEnd(file, size, result, signal);
	if (firstOffset === undefined) return undefined;
	if (at.byteOffset < firstOffset || at.byteOffset >= size) { reason(result, "unknown-entry"); return undefined; }
	const length = Math.min(size - at.byteOffset + 1, PRIMARY_OBSERVATION_LIMITS.lineBytes + 2);
	const data = await readRange(file, at.byteOffset - 1, length, result, signal);
	const end = data.indexOf(10, 1);
	if (data[0] !== 10) { reason(result, "unknown-entry"); return undefined; }
	if (end < 0) { reason(result, data.length < PRIMARY_OBSERVATION_LIMITS.lineBytes + 2 ? "partial-tail-record" : "oversize-record"); return undefined; }
	result.coverage.linesVisited = 1;
	const raw = parseRecord(data, 1, end, result);
	if (raw && raw.id !== at.entryId) { reason(result, "unknown-entry"); return undefined; }
	return raw;
}
/** Page the complete allowed text of one record under the same projection and redaction rules. */
function pageExact(raw: Raw, at: ExactCursor, result: OrdinaryPrimaryObservation): void {
	// The record's own content gets the full line bound, whatever presence facts already scanned.
	const scanLimit = result.coverage.textScanBytes + PRIMARY_OBSERVATION_LIMITS.lineBytes;
	const entry = project(raw, at.byteOffset, result, { textBytes: Number.POSITIVE_INFINITY, scanLimit, clip: { clipped: false } });
	const text = entry.text ?? "";
	if (at.offset > text.length || splitsPair(text, at.offset)) { reason(result, "invalid-cursor"); return; }
	// JSON escaping can grow a page, so the page shrinks until the whole observation fits.
	for (let budget: number = PRIMARY_OBSERVATION_LIMITS.exactPageBytes; budget >= 256; budget = Math.floor(budget / 2)) {
		const candidate = exactPage(entry, text, at, result, budget);
		if (Buffer.byteLength(JSON.stringify(candidate)) <= PRIMARY_OBSERVATION_LIMITS.outputBytes - 1024) { Object.assign(result, candidate); return; }
	}
	reason(result, "output-budget");
}
function exactPage(entry: Entry, text: string, at: ExactCursor, result: OrdinaryPrimaryObservation, budget: number): OrdinaryPrimaryObservation {
	const page = excerpt(text.slice(at.offset), budget);
	const endOffset = at.offset + page.length;
	const { text: _whole, ...rest } = entry;
	const candidate: OrdinaryPrimaryObservation = { ...result, entries: [page ? { ...rest, text: page } : rest], page: { offset: at.offset, endOffset, totalUnits: text.length } };
	if (endOffset < text.length) candidate.nextCursor = { ...at, offset: endOffset };
	return candidate;
}
async function verifyIdentity(file: FileHandle, path: string, result: OrdinaryPrimaryObservation): Promise<void> {
	const after = await file.stat({ bigint: true });
	const named = await lstat(path, { bigint: true });
	const sourcePin = result.source.pin;
	const kept = (stat: typeof after) => sourcePin !== undefined && String(stat.dev) === sourcePin.dev && String(stat.ino) === sourcePin.ino;
	if (!named.isFile() || !kept(after) || !kept(named) || result.coverage.reasons.includes("source-changed")) { reason(result, "source-changed"); discard(result); }
}
async function readExactObservation(path: string, at: ExactCursor, result: OrdinaryPrimaryObservation, signal?: AbortSignal): Promise<OrdinaryPrimaryObservation> {
	result.source.ancestry = "retained-entry";
	let file: FileHandle | undefined;
	try {
		signal?.throwIfAborted();
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const raw = await exactRecord(file, at, result, signal);
		if (raw) { pageExact(raw, at, result); await verifyIdentity(file, path, result); }
		signal?.throwIfAborted();
	} catch (error) { readError(error, signal, result); }
	finally {
		try { await file?.close(); }
		catch { reason(result, "session-file-close-failed"); discard(result); }
	}
	return result;
}
/** Observe retained public v3 evidence without opening a session or contacting its endpoint. */
export async function readPrimaryObservation(primary: PrimaryInfo & { sessionFile?: string }, input: Input = {}): Promise<OrdinaryPrimaryObservation> {
	const result = initial(primary, input);
	if (!validateInput(input, result)) return result;
	const path = primary.sessionFile;
	if (result.view === "exact") {
		const at = input.cursor as ExactCursor;
		return validatePath(path, at, result) ? readExactObservation(path, at, result, input.signal) : result;
	}
	const continuation = input.cursor as Cursor | undefined;
	if (!validatePath(path, continuation, result)) return result;
	const limit = Math.min(input.limit ?? (result.view === "status" ? 5 : 10), PRIMARY_OBSERVATION_LIMITS.items);
	let file: FileHandle | undefined;
	try {
		input.signal?.throwIfAborted();
		// NONBLOCK prevents a raced FIFO from turning a read-only observation into a wait.
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const captured = await snapshot(file, continuation, result, input.signal);
		if (captured) { walk(captured, continuation, limit, result, input.signal); await verifySnapshot(file, path, captured.pin, result); }
		input.signal?.throwIfAborted();
	} catch (error) { readError(error, input.signal, result); }
	finally {
		try { await file?.close(); }
		catch { reason(result, "session-file-close-failed"); discard(result); }
	}
	return result;
}

type RenderText = (value: unknown, bytes?: number) => string;
function formatEntry(entry: Entry, render: RenderText, textBytes: number): string[] {
	const names = entry.toolNames?.slice(0, 16).map(name => render(name, 128));
	const tools = names?.length ? ` tools: ${names.join(", ")}` : "";
	const lines = [`${render(entry.timestamp, 64)} ${render(entry.id, 36)} ${render(entry.role ?? entry.kind, 64)}${entry.isError ? " ERROR" : ""}${tools}`];
	if (entry.text) lines.push(render(entry.text, textBytes));
	if (entry.error) lines.push(render(entry.error, 1024));
	if (entry.textCursor) lines.push("Text clipped; its textCursor reads the complete text.");
	return lines;
}
function formatterState(result: OrdinaryPrimaryObservation): OrdinaryPrimaryObservation {
	return { ...result, coverage: { complete: true, reasons: [], bytesRead: 0, linesVisited: 0, parentVisits: 0, textScanBytes: 0, omissions: { credentials: 0, fields: 0, text: 0 } } };
}
function formatHeader(result: OrdinaryPrimaryObservation, render: RenderText): string[] {
	const name = result.presence.name ? ` (${render(result.presence.name)})` : "";
	const lines = [
		`Ordinary primary ${render(result.sessionId, 128)}${name}`,
		`Process: ${render(result.presence.process.state, 64)} (${render(result.presence.process.attribution, 128)}); idle/selected leaf/timers/tasks: unknown.`,
		result.source.ancestry === "retained-entry"
			? `Source: ${render(result.source.path ?? "unavailable", 4096)}; one retained entry by identity, not proof that it is on the live selected branch.`
			: `Source: ${render(result.source.path ?? "unavailable", 4096)}; latest-retained ancestry, not the live selected branch.`,
	];
	if (result.presence.model) lines.push(`Recorded model: ${render(result.presence.model.provider, 128)}/${render(result.presence.model.modelId, 128)}`);
	if (result.presence.intentClaim) lines.push(`Declared purpose: ${render(result.presence.intentClaim.purpose, 768)}`);
	if (!result.source.latestKnown) lines.push("Latest retained entry: unknown.");
	return lines;
}
/** Render factual evidence through the same bounded escape and credential projection as tool data. */
export function formatPrimaryObservation(result: OrdinaryPrimaryObservation): string {
	const state = formatterState(result);
	const render: RenderText = (value, bytes) => safe(value, state, bytes) ?? "[omitted]";
	const lines = formatHeader(result, render);
	const exact = result.view === "exact";
	if (exact && result.page) lines.push(`Entry text UTF-16 units ${result.page.offset}-${result.page.endOffset} of ${result.page.totalUnits}.`);
	const textBytes = exact ? PRIMARY_OBSERVATION_LIMITS.exactPageBytes : PRIMARY_OBSERVATION_LIMITS.textBytes;
	for (const entry of result.entries.slice(0, PRIMARY_OBSERVATION_LIMITS.items)) lines.push(...formatEntry(entry, render, textBytes));
	if (!result.coverage.complete) lines.push(`Incomplete: ${result.coverage.reasons.slice(0, 32).map(value => render(value, 64)).join(", ")}`);
	if (!state.coverage.complete) lines.push(`Presentation limits: ${state.coverage.reasons.join(", ")}`);
	const original = result.coverage.omissions, projected = state.coverage.omissions;
	const credentials = original.credentials + projected.credentials, fields = original.fields + projected.fields, text = original.text + projected.text;
	if (credentials || fields || text) lines.push(`Omissions: credentials=${credentials}, fields=${fields}, text=${text}.`);
	if (result.nextCursor) lines.push(exact ? "More text of this entry is available with nextCursor." : "More retained ancestry is available with nextCursor.");
	return excerpt(lines.join("\n"), PRIMARY_OBSERVATION_LIMITS.outputBytes);
}
