/** Agent-authored shell policy rules and their append-only registry. */

import { constants, readFileSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseStatements, type Stage, type Statement } from "./shell.ts";
import { flags, operands, RULES } from "./shell-rules.ts";
import type { PromotionWarrant, WarrantEvidence } from "./promotion.ts";
import { ensurePrivateDirectory } from "./store.ts";

const FIRST_SCHEMA_VERSION = 1;

type SchemaTransitionKind = "additive" | "breaking";
type SchemaVersionDecision = { load: true; version: number } | { load: false; reason: string };

/** Build a version gate from transitions keyed by the version each enters. */
export function defineRuleSchema(
	currentVersion: number,
	transitions: Readonly<Record<number, SchemaTransitionKind>>,
): (version: unknown) => SchemaVersionDecision {
	if (!Number.isSafeInteger(currentVersion) || currentVersion < FIRST_SCHEMA_VERSION) {
		throw new Error(`invalid current rule schema version ${currentVersion}`);
	}
	for (let target = FIRST_SCHEMA_VERSION + 1; target <= currentVersion; target++) {
		const kind = transitions[target];
		if (kind === undefined) throw new Error(`rule schema transition ${target - 1} to ${target} is undeclared`);
		if (kind !== "additive" && kind !== "breaking") {
			throw new Error(`invalid rule schema transition kind for version ${target}`);
		}
	}

	return (version: unknown): SchemaVersionDecision => {
		if (typeof version !== "number" || !Number.isSafeInteger(version) || version < FIRST_SCHEMA_VERSION) {
			return {
				load: false,
				reason: `record has a missing or invalid schema version; this build uses schema version ${currentVersion}`,
			};
		}
		if (version > currentVersion) {
			return {
				load: false,
				reason: `record schema version ${version} is newer than this build's schema version ${currentVersion}`,
			};
		}
		for (let target = version + 1; target <= currentVersion; target++) {
			if (transitions[target] === "breaking") {
				return {
					load: false,
					reason: `record schema version ${version} crosses breaking transition ${target - 1} to ${target}, which requires an explicit migration`,
				};
			}
		}
		return { load: true, version };
	};
}

export const SCHEMA_VERSION = 2;
const SCHEMA_TRANSITIONS = {
	// Version 2 adds only the optional `suggest` field.
	2: "additive",
} as const satisfies Readonly<Record<number, SchemaTransitionKind>>;
const checkSchemaVersion = defineRuleSchema(SCHEMA_VERSION, SCHEMA_TRANSITIONS);
export const MAX_AGENT_RULES = 64;
export const MAX_NOTE_BYTES = 200;
export const MAX_MATCH_BYTES = 4096;
export const MAX_RULES_FILE_BYTES = 256 * 1024;
export const MAX_FIRE_SCAN_BYTES = 32 * 1024 * 1024;
export const RULES_FILE = "agent-rules.jsonl";

export type AgentState = "active" | "promoted" | "disabled" | "discarded";
export type StateOrigin = "tool" | "command";

export interface StateLine {
	slug: string;
	state: AgentState;
	model: string;
	session: string;
	at: string;
	origin: StateOrigin | "unknown";
	warrant?: PromotionWarrant;
}

interface AgentOperandsMatch {
	min?: number;
	max?: number;
	any?: string[];
	at?: Record<string, string | string[]>;
}

interface AgentPipeMatch {
	from?: boolean;
	to?: boolean;
	fromRedirect?: boolean;
	toRedirect?: boolean;
	next?: string | string[];
	later?: string[];
}

export interface AgentMatch {
	tool: "bash";
	command: string | string[];
	flags?: string[];
	absentFlags?: string[];
	operands?: AgentOperandsMatch;
	pipe?: AgentPipeMatch;
}

export interface AgentScope {
	exclude?: string[];
	providers?: string[];
	models?: string[];
}

export interface AgentSuggestion {
	command: string;
	flags?: string[];
}

export interface AgentRule {
	version: number;
	slug: string;
	note: string;
	match: AgentMatch;
	suggest?: AgentSuggestion;
	scope?: AgentScope;
	state: AgentState;
	model: string;
	session: string;
	at: string;
}

const BUILTIN_IDS = RULES.map((rule) => rule.id);
const AGENT_PREFIX = "agent.";
const STATES = new Set<AgentState>(["active", "promoted", "disabled", "discarded"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: readonly string[], path: string): string | null {
	const allowedKeys = new Set(allowed);
	const key = Object.keys(value).find((candidate) => !allowedKeys.has(candidate));
	return key === undefined ? null : `${path} has unknown key "${key}"`;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(value, key);
}

function validateStringArray(value: unknown, path: string): string | null {
	if (!Array.isArray(value) || value.length === 0) return `${path} must be a non-empty string array`;
	if (value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
		return `${path} entries must be non-empty strings`;
	}
	return null;
}

function validateStringChoice(value: unknown, path: string): string | null {
	if (typeof value === "string") return value.length === 0 ? `${path} must not be empty` : null;
	return validateStringArray(value, path);
}

function validateNonNegativeInteger(value: unknown, path: string): string | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? null
		: `${path} must be a non-negative integer`;
}

function byteLengthOfJson(value: unknown): number | null {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
	} catch {
		return null;
	}
}

/** Class id persisted for an agent-authored slug. */
export function agentClass(slug: string): string {
	return `${AGENT_PREFIX}${slug}`;
}

/** Whether an id belongs to the agent-authored class namespace. */
export function isAgentClass(id: string): boolean {
	return id.startsWith(AGENT_PREFIX);
}

/** Validate a rule slug against its syntax and the built-in id namespace. */
export function validateSlug(
	slug: unknown,
	builtinIds: readonly string[] | ReadonlySet<string> = BUILTIN_IDS,
): string | null {
	if (typeof slug !== "string" || slug.length === 0) return "slug must be a non-empty string";
	if (!/^[a-z][a-z0-9._-]{0,63}$/.test(slug)) {
		return "slug must match ^[a-z][a-z0-9._-]{0,63}$";
	}
	if (slug.startsWith(AGENT_PREFIX)) return `slug must not start with "${AGENT_PREFIX}"`;
	const conflicts = "has" in builtinIds ? builtinIds.has(slug) : builtinIds.includes(slug);
	if (conflicts) return `slug conflicts with built-in rule id "${slug}"`;
	return null;
}

/** Validate model-visible rule guidance. */
export function validateNote(note: unknown): string | null {
	if (typeof note !== "string" || note.length === 0) return "note must be a non-empty string";
	if (/[\r\n]/.test(note)) return "note must not contain a newline";
	if (Buffer.byteLength(note, "utf8") > MAX_NOTE_BYTES) return `note exceeds ${MAX_NOTE_BYTES} UTF-8 bytes`;
	return null;
}

/** Validate the closed shell-stage match vocabulary. */
export function validateMatch(match: unknown): string | null {
	if (!isObject(match)) return "match must be an object";
	const topLevelFailure = unknownKey(match, ["tool", "command", "flags", "absentFlags", "operands", "pipe"], "match");
	if (topLevelFailure) return topLevelFailure;
	if (match.tool !== "bash") return `match.tool must equal "bash"`;
	const commandFailure = validateStringChoice(match.command, "match.command");
	if (commandFailure) return commandFailure;

	for (const key of ["flags", "absentFlags"] as const) {
		if (!hasOwn(match, key)) continue;
		const failure = validateStringArray(match[key], `match.${key}`);
		if (failure) return failure;
	}

	if (hasOwn(match, "operands")) {
		const operandMatch = match.operands;
		if (!isObject(operandMatch)) return "match.operands must be an object";
		const operandKeyFailure = unknownKey(operandMatch, ["min", "max", "any", "at"], "match.operands");
		if (operandKeyFailure) return operandKeyFailure;
		for (const key of ["min", "max"] as const) {
			if (!hasOwn(operandMatch, key)) continue;
			const failure = validateNonNegativeInteger(operandMatch[key], `match.operands.${key}`);
			if (failure) return failure;
		}
		if (
			typeof operandMatch.min === "number" &&
			typeof operandMatch.max === "number" &&
			operandMatch.min > operandMatch.max
		) {
			return "match.operands.min must not exceed match.operands.max";
		}
		if (hasOwn(operandMatch, "any")) {
			const failure = validateStringArray(operandMatch.any, "match.operands.any");
			if (failure) return failure;
		}
		if (hasOwn(operandMatch, "at")) {
			const at = operandMatch.at;
			if (!isObject(at)) return "match.operands.at must be an object";
			for (const [index, expected] of Object.entries(at)) {
				if (!/^\d+$/.test(index)) return `match.operands.at has non-numeric key "${index}"`;
				const failure = validateStringChoice(expected, `match.operands.at.${index}`);
				if (failure) return failure;
			}
		}
	}

	if (hasOwn(match, "pipe")) {
		const pipe = match.pipe;
		if (!isObject(pipe)) return "match.pipe must be an object";
		const pipeKeyFailure = unknownKey(
			pipe,
			["from", "to", "fromRedirect", "toRedirect", "next", "later"],
			"match.pipe",
		);
		if (pipeKeyFailure) return pipeKeyFailure;
		for (const key of ["from", "to", "fromRedirect", "toRedirect"] as const) {
			if (hasOwn(pipe, key) && typeof pipe[key] !== "boolean") return `match.pipe.${key} must be a boolean`;
		}
		if (hasOwn(pipe, "next")) {
			const failure = validateStringChoice(pipe.next, "match.pipe.next");
			if (failure) return failure;
		}
		if (hasOwn(pipe, "later")) {
			const failure = validateStringArray(pipe.later, "match.pipe.later");
			if (failure) return failure;
		}
	}

	const bytes = byteLengthOfJson(match);
	if (bytes === null) return "match must be JSON-serializable";
	if (bytes > MAX_MATCH_BYTES) return `match exceeds ${MAX_MATCH_BYTES} UTF-8 bytes`;
	return null;
}

/** Validate the closed suggested-command vocabulary. */
export function validateSuggestion(suggest: unknown): string | null {
	if (suggest === undefined) return null;
	if (!isObject(suggest)) return "suggest must be an object";
	const keyFailure = unknownKey(suggest, ["command", "flags"], "suggest");
	if (keyFailure) return keyFailure;
	if (typeof suggest.command !== "string" || suggest.command.length === 0) {
		return "suggest.command must be a non-empty string";
	}
	if (suggest.command.includes("/")) return "suggest.command must be a command name without /";
	if (hasOwn(suggest, "flags")) {
		const failure = validateStringArray(suggest.flags, "suggest.flags");
		if (failure) return failure;
		if ((suggest.flags as string[]).some((flag) => flag.startsWith("-") || flag.includes("="))) {
			return "suggest.flags entries must be normalized names without a leading - or = value";
		}
	}
	return null;
}

/** Validate the closed provider/model scope vocabulary. */
export function validateScope(scope: unknown): string | null {
	if (scope === undefined) return null;
	if (!isObject(scope)) return "scope must be an object";
	const keyFailure = unknownKey(scope, ["exclude", "providers", "models"], "scope");
	if (keyFailure) return keyFailure;
	if (hasOwn(scope, "exclude") && hasOwn(scope, "providers")) {
		return "scope.exclude and scope.providers are mutually exclusive";
	}
	if (hasOwn(scope, "models") && !hasOwn(scope, "providers")) return "scope.models requires scope.providers";
	// An empty object is a trap: "everywhere" must be an omitted scope, not a
	// scoped-but-empty form that behaves differently with and without a model.
	if (!hasOwn(scope, "exclude") && !hasOwn(scope, "providers")) {
		return "scope must name exclude or providers";
	}

	for (const key of ["exclude", "providers", "models"] as const) {
		if (!hasOwn(scope, key)) continue;
		const failure = validateStringArray(scope[key], `scope.${key}`);
		if (failure) return failure;
		for (const entry of scope[key] as string[]) {
			const slashCount = entry.split("/").length - 1;
			if (key === "providers" && slashCount !== 0) return "scope.providers entries must not contain /";
			if (key !== "providers" && slashCount > 1) return `scope.${key} entries must contain at most one /`;
		}
	}
	return null;
}

/** Whether a state transition needs a dialog-capable operator decision. */
export function needsOperatorConfirm(from: AgentState, to: AgentState): boolean {
	return from === "promoted" && to !== "promoted";
}

/** Whether a rule's provider/model scope includes the current model. */
export function scopeAllows(scope: AgentScope | undefined, model: string | null): boolean {
	if (scope === undefined) return true;
	if (model === null) return false;
	const separator = model.indexOf("/");
	const provider = separator === -1 ? model : model.slice(0, separator);
	if (scope.exclude) {
		if (scope.exclude.some((entry) => (entry.includes("/") ? entry === model : entry === provider))) return false;
	}
	if (scope.providers && !scope.providers.includes(provider)) return false;
	if (scope.models && !scope.models.includes(model)) return false;
	return true;
}

function choiceAllows(expected: string | string[], actual: string): boolean {
	return typeof expected === "string" ? expected === actual : expected.includes(actual);
}

function stageMatches(match: AgentMatch, statement: Statement, index: number): boolean {
	const stage: Stage = statement[index];
	if (!choiceAllows(match.command, stage.command)) return false;
	const presentFlags = flags(stage);
	if (match.flags?.some((name) => !presentFlags.includes(name))) return false;
	if (match.absentFlags?.some((name) => presentFlags.includes(name))) return false;

	if (match.operands) {
		const values = operands(stage);
		if (match.operands.min !== undefined && values.length < match.operands.min) return false;
		if (match.operands.max !== undefined && values.length > match.operands.max) return false;
		if (match.operands.any && !values.some((value) => match.operands!.any!.includes(value))) return false;
		if (match.operands.at) {
			for (const [position, expected] of Object.entries(match.operands.at)) {
				const actual = values[Number(position)];
				if (actual === undefined || !choiceAllows(expected, actual)) return false;
			}
		}
	}

	if (match.pipe) {
		const pipe = match.pipe;
		if (pipe.from !== undefined && stage.fromPipe !== pipe.from) return false;
		if (pipe.to !== undefined && stage.toPipe !== pipe.to) return false;
		if (pipe.fromRedirect !== undefined && stage.fromRedirect !== pipe.fromRedirect) return false;
		if (pipe.toRedirect !== undefined && stage.toRedirect !== pipe.toRedirect) return false;
		if (pipe.next !== undefined) {
			const next = statement[index + 1];
			if (next === undefined || !choiceAllows(pipe.next, next.command)) return false;
		}
		if (pipe.later && !statement.slice(index + 1).some((candidate) => pipe.later!.includes(candidate.command))) {
			return false;
		}
	}
	return true;
}

function suggestionStatement(suggest: AgentSuggestion): Statement {
	return [
		{
			command: suggest.command,
			args: (suggest.flags ?? []).map((flag) => (flag.length === 1 ? `-${flag}` : `--${flag}`)),
			fromPipe: false,
			toPipe: false,
			fromRedirect: false,
			toRedirect: false,
		},
	];
}

function errorMessage(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "unknown agent-rule data failure";
	}
}

/** Append one checked line to the private agent-rule data file. */
export async function appendLine(dir: string, line: string): Promise<string | null> {
	try {
		const serialized = Buffer.from(`${line}\n`, "utf8");
		await ensurePrivateDirectory(dir);
		const path = join(dir, RULES_FILE);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600);
		try {
			await handle.chmod(0o600);
			const info = await handle.stat();
			if (info.size + serialized.length > MAX_RULES_FILE_BYTES) {
				throw new Error(`agent rules file exceeds ${MAX_RULES_FILE_BYTES} bytes`);
			}
			const { bytesWritten } = await handle.write(serialized, 0, serialized.length, null);
			if (bytesWritten !== serialized.length) {
				throw new Error(`agent rule write stopped at ${bytesWritten} of ${serialized.length} bytes`);
			}
		} finally {
			await handle.close();
		}
		return null;
	} catch (error) {
		return errorMessage(error);
	}
}

function isState(value: unknown): value is AgentState {
	return typeof value === "string" && STATES.has(value as AgentState);
}

function validateAttribution(model: unknown, session: unknown, at: unknown): string | null {
	if (typeof model !== "string" || model.length === 0) return "rule model must be a non-empty string";
	if (typeof session !== "string" || session.length === 0) return "rule session must be a non-empty string";
	if (typeof at !== "string" || at.length === 0 || Number.isNaN(Date.parse(at))) {
		return "rule timestamp must be an ISO timestamp";
	}
	return null;
}

function validatePromotionWarrant(warrant: unknown): string | null {
	if (!isObject(warrant)) return "warrant must be an object";
	const keyFailure = unknownKey(
		warrant,
		["criteria", "fires", "errors", "errorKinds", "truncated", "partial", "pass"],
		"warrant",
	);
	if (keyFailure) return keyFailure;
	if (typeof warrant.criteria !== "number" || !Number.isInteger(warrant.criteria) || warrant.criteria <= 0) {
		return "warrant.criteria must be a positive integer";
	}
	const firesFailure = validateNonNegativeInteger(warrant.fires, "warrant.fires");
	if (firesFailure) return firesFailure;
	const errorsFailure = validateNonNegativeInteger(warrant.errors, "warrant.errors");
	if (errorsFailure) return errorsFailure;
	if ((warrant.errors as number) > (warrant.fires as number)) {
		return "warrant.errors must not exceed warrant.fires";
	}
	const truncatedFailure = validateNonNegativeInteger(warrant.truncated, "warrant.truncated");
	if (truncatedFailure) return truncatedFailure;
	if (!isObject(warrant.errorKinds)) return "warrant.errorKinds must be an object";
	const kindKeys = Object.keys(warrant.errorKinds).sort();
	if (kindKeys.length !== 3 || kindKeys.join(",") !== "aborted,other,timeout") {
		return "warrant.errorKinds must contain exactly timeout, aborted, other";
	}
	for (const kind of ["timeout", "aborted", "other"] as const) {
		const kindFailure = validateNonNegativeInteger(warrant.errorKinds[kind], `warrant.errorKinds.${kind}`);
		if (kindFailure) return kindFailure;
	}
	if (
		(warrant.errorKinds.timeout as number) +
			(warrant.errorKinds.aborted as number) +
			(warrant.errorKinds.other as number) !==
		(warrant.errors as number)
	) {
		return "warrant.errorKinds must sum to warrant.errors";
	}
	if (typeof warrant.partial !== "boolean") return "warrant.partial must be a boolean";
	if (typeof warrant.pass !== "boolean") return "warrant.pass must be a boolean";
	return null;
}

function validateRule(rule: AgentRule, expectedVersion: number = SCHEMA_VERSION): string | null {
	if (rule.version !== expectedVersion) return `rule version must equal ${expectedVersion}`;
	const shapeFailure =
		validateSlug(rule.slug) ??
		validateNote(rule.note) ??
		validateMatch(rule.match) ??
		validateSuggestion(rule.suggest) ??
		validateScope(rule.scope);
	if (shapeFailure) return shapeFailure;
	if (rule.state !== "active") return 'new rules must have state "active"';
	return validateAttribution(rule.model, rule.session, rule.at);
}

function copyRule(rule: AgentRule): AgentRule {
	return JSON.parse(JSON.stringify(rule)) as AgentRule;
}

function readRule(value: Record<string, unknown>, version: number): AgentRule | undefined {
	if (value.kind !== "rule" || value.state !== "active") return undefined;
	const candidate: AgentRule = {
		version: value.version as number,
		slug: value.slug as string,
		note: value.note as string,
		match: value.match as AgentMatch,
		state: "active",
		model: value.model as string,
		session: value.session as string,
		at: value.at as string,
	};
	if (version >= 2 && hasOwn(value, "suggest")) candidate.suggest = value.suggest as AgentSuggestion;
	if (hasOwn(value, "scope")) candidate.scope = value.scope as AgentScope;
	return validateRule(candidate, version) === null ? candidate : undefined;
}

function canTransition(from: AgentState, to: AgentState): boolean {
	return from !== "discarded" || to === "discarded";
}

function warnLoad(error: unknown): void {
	try {
		console.warn(`[policy] agent rules ignored: ${errorMessage(error)}`);
	} catch {
		// A failing warning channel cannot make registration fail.
	}
}

const DAILY_STORE_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const FIRE_SCAN_CHUNK_BYTES = 64 * 1024;

export interface FireCounts {
	/** Agent-class counts retained for the model-facing registry tool. */
	fires: Map<string, number>;
	/** Counts for every class id, including built-ins, from the same scan. */
	allFires: Map<string, number>;
	/** Per-model counts for every class id, derived from each record's model field. */
	firesByModel: Map<string, Map<string | null, number>>;
	partial: boolean;
}

function incrementCount<Key>(counts: Map<Key, number>, key: Key): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

function countFireRecord(
	line: Buffer,
	fires: Map<string, number>,
	allFires: Map<string, number>,
	firesByModel: Map<string, Map<string | null, number>>,
): void {
	if (line.length === 0) return;
	try {
		const value: unknown = JSON.parse(line.toString("utf8"));
		if (!isObject(value) || !Array.isArray(value.classes)) return;
		const model = typeof value.model === "string" ? value.model : null;
		for (const classId of value.classes) {
			if (typeof classId !== "string") continue;
			incrementCount(allFires, classId);
			let modelCounts = firesByModel.get(classId);
			if (!modelCounts) {
				modelCounts = new Map();
				firesByModel.set(classId, modelCounts);
			}
			incrementCount(modelCounts, model);
			if (isAgentClass(classId)) incrementCount(fires, classId);
		}
	} catch {
		// One malformed store record does not hide counts from other records.
	}
}

async function scanJsonlFile(
	path: string,
	byteBound: number,
	consumeLine: (line: Buffer) => void,
): Promise<{ bytesRead: number; complete: boolean }> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let bytesReadTotal = 0;
	let complete = false;
	try {
		handle = await open(path, constants.O_RDONLY);
		const size = (await handle.stat()).size;
		let position = 0;
		let fragments: Buffer[] = [];
		let fragmentBytes = 0;
		const consume = (chunk: Buffer): void => {
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
		};

		while (position < size && bytesReadTotal < byteBound) {
			const length = Math.min(FIRE_SCAN_CHUNK_BYTES, size - position, byteBound - bytesReadTotal);
			const chunk = Buffer.allocUnsafe(length);
			const result = await handle.read(chunk, 0, length, position);
			if (result.bytesRead === 0) break;
			const read = chunk.subarray(0, result.bytesRead);
			consume(read);
			position += result.bytesRead;
			bytesReadTotal += result.bytesRead;
		}
		complete = position >= size;
		if (complete && fragmentBytes > 0) {
			consumeLine(fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes));
		}
	} catch {
		complete = false;
	} finally {
		if (handle) {
			try {
				await handle.close();
			} catch {
				complete = false;
			}
		}
	}
	return { bytesRead: bytesReadTotal, complete };
}

async function scanFireFile(
	path: string,
	byteBound: number,
	fires: Map<string, number>,
	allFires: Map<string, number>,
	firesByModel: Map<string, Map<string | null, number>>,
): Promise<{ bytesRead: number; complete: boolean }> {
	return scanJsonlFile(path, byteBound, (line) => countFireRecord(line, fires, allFires, firesByModel));
}

/** Count agent and built-in classes through one bounded scan of daily store files. */
export async function countFires(dir: string, byteBound: number = MAX_FIRE_SCAN_BYTES): Promise<FireCounts> {
	const fires = new Map<string, number>();
	const allFires = new Map<string, number>();
	const firesByModel = new Map<string, Map<string | null, number>>();
	try {
		const files = (await readdir(dir)).filter((name) => DAILY_STORE_FILE.test(name)).sort();
		const normalizedBound = Number.isFinite(byteBound) ? Math.max(0, Math.floor(byteBound)) : MAX_FIRE_SCAN_BYTES;
		let remaining = normalizedBound;
		for (const file of files) {
			const scanned = await scanFireFile(join(dir, file), remaining, fires, allFires, firesByModel);
			remaining -= scanned.bytesRead;
			if (!scanned.complete) return { fires, allFires, firesByModel, partial: true };
		}
		return { fires, allFires, firesByModel, partial: false };
	} catch (error) {
		return {
			fires,
			allFires,
			firesByModel,
			partial: (error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT",
		};
	}
}

/** Scan bounded daily records for the measured evidence behind one agent rule. */
export async function scanWarrantEvidence(
	dir: string,
	slug: string,
	byteBound: number = MAX_FIRE_SCAN_BYTES,
): Promise<WarrantEvidence> {
	const evidence: WarrantEvidence = {
		fires: 0,
		errors: 0,
		errorKinds: { timeout: 0, aborted: 0, other: 0 },
		truncated: 0,
		partial: false,
	};
	const classId = agentClass(slug);
	const countRecord = (line: Buffer): void => {
		if (line.length === 0) return;
		try {
			const value: unknown = JSON.parse(line.toString("utf8"));
			if (!isObject(value) || !Array.isArray(value.classes) || !value.classes.includes(classId)) return;
			evidence.fires++;
			if (value.error === true) {
				evidence.errors++;
				const kind = value.errorKind === "timeout" || value.errorKind === "aborted" ? value.errorKind : "other";
				evidence.errorKinds[kind]++;
			}
			if (value.truncated === true) evidence.truncated++;
		} catch {
			// One malformed store record does not hide evidence from other records.
		}
	};

	try {
		const files = (await readdir(dir)).filter((name) => DAILY_STORE_FILE.test(name)).sort();
		const normalizedBound = Number.isFinite(byteBound) ? Math.max(0, Math.floor(byteBound)) : MAX_FIRE_SCAN_BYTES;
		let remaining = normalizedBound;
		for (const file of files) {
			const scanned = await scanJsonlFile(join(dir, file), remaining, countRecord);
			remaining -= scanned.bytesRead;
			if (!scanned.complete) return { ...evidence, partial: true };
		}
		return evidence;
	} catch (error) {
		return {
			...evidence,
			partial: (error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT",
		};
	}
}

/** Read attributed state transitions without changing registry replay behavior. */
export function readStateLines(dir: string): StateLine[] {
	let text: string;
	try {
		text = readFileSync(join(dir, RULES_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") warnLoad(error);
		return [];
	}

	try {
		const lines: StateLine[] = [];
		for (const [index, source] of text.split(/\r?\n/).entries()) {
			if (source.length === 0) continue;
			let value: unknown;
			try {
				value = JSON.parse(source);
			} catch (error) {
				throw new Error(`cannot parse ${RULES_FILE} line ${index + 1}: ${errorMessage(error)}`);
			}
			if (!isObject(value) || value.kind !== "state" || typeof value.slug !== "string" || !isState(value.state)) {
				continue;
			}
			if (validateAttribution(value.model, value.session, value.at)) continue;
			let origin: StateLine["origin"] = "unknown";
			if (hasOwn(value, "origin")) {
				if (value.origin !== "tool" && value.origin !== "command") continue;
				origin = value.origin;
			}
			if (hasOwn(value, "warrant") && validatePromotionWarrant(value.warrant)) continue;
			const line: StateLine = {
				slug: value.slug,
				state: value.state,
				model: value.model as string,
				session: value.session as string,
				at: value.at as string,
				origin,
			};
			if (hasOwn(value, "warrant")) line.warrant = value.warrant as unknown as PromotionWarrant;
			lines.push(line);
		}
		return lines;
	} catch (error) {
		warnLoad(error);
		return [];
	}
}

/** In-memory replay of the append-only agent-rule data file. */
export class AgentRules {
	private readonly dir: string;
	private readonly rules = new Map<string, AgentRule>();
	private tail: Promise<void> = Promise.resolve();

	constructor(dir: string) {
		this.dir = dir;
	}

	/** Load and replay the registry without making extension registration fail. */
	static load(dir: string): AgentRules {
		const loaded = new AgentRules(dir);
		let text: string;
		try {
			text = readFileSync(join(dir, RULES_FILE), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return loaded;
			warnLoad(error);
			return loaded;
		}

		try {
			let versionMismatches = 0;
			const versionFailures = new Set<string>();
			for (const [index, line] of text.split(/\r?\n/).entries()) {
				if (line.length === 0) continue;
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch (error) {
					throw new Error(`cannot parse ${RULES_FILE} line ${index + 1}: ${errorMessage(error)}`);
				}
				if (!isObject(value)) continue;
				if (value.kind === "rule") {
					const version = checkSchemaVersion(value.version);
					if (!version.load) {
						versionMismatches++;
						versionFailures.add(version.reason);
						continue;
					}
					const rule = readRule(value, version.version);
					if (!rule) continue;
					if (!loaded.rules.has(rule.slug) && loaded.rules.size >= MAX_AGENT_RULES) continue;
					loaded.rules.set(rule.slug, rule);
					continue;
				}
				if (value.kind !== "state" || typeof value.slug !== "string" || !isState(value.state)) continue;
				if (validateAttribution(value.model, value.session, value.at)) continue;
				const rule = loaded.rules.get(value.slug);
				if (!rule || !canTransition(rule.state, value.state)) continue;
				rule.state = value.state;
			}
			if (versionMismatches > 0) {
				warnLoad(
					`skipped ${versionMismatches} rule record${versionMismatches === 1 ? "" : "s"}: ${[...versionFailures].join("; ")}`,
				);
			}
			return loaded;
		} catch (error) {
			warnLoad(error);
			return new AgentRules(dir);
		}
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Every non-discarded rule, sorted by slug. */
	list(): AgentRule[] {
		return [...this.rules.values()]
			.filter((rule) => rule.state !== "discarded")
			.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0))
			.map(copyRule);
	}

	/** Look up a rule, including a discarded terminal entry. */
	get(slug: string): AgentRule | undefined {
		const rule = this.rules.get(slug);
		return rule && copyRule(rule);
	}

	/** Resolve model-visible guidance for an in-scope agent class. */
	noteFor(classId: string, model: string | null): string | undefined {
		if (!isAgentClass(classId)) return undefined;
		const rule = this.rules.get(classId.slice(AGENT_PREFIX.length));
		return rule && scopeAllows(rule.scope, model) ? rule.note : undefined;
	}

	/** Whether an agent class has blocking, in-scope posture. */
	isBlocking(classId: string, model: string | null): boolean {
		if (!isAgentClass(classId)) return false;
		const rule = this.rules.get(classId.slice(AGENT_PREFIX.length));
		return rule?.state === "promoted" && scopeAllows(rule.scope, model);
	}

	/** Classify captured shell text under every enabled rule, independent of scope. */
	classify(captured: string): string[] {
		const matched = new Set<string>();
		const statements = parseStatements(captured);
		for (const rule of this.rules.values()) {
			if (rule.state !== "active" && rule.state !== "promoted") continue;
			for (const statement of statements) {
				if (statement.some((_stage, index) => stageMatches(rule.match, statement, index))) {
					matched.add(agentClass(rule.slug));
					break;
				}
			}
		}
		return [...matched].sort();
	}

	private suggestedFormFailure(owner: AgentRule, prospectiveRule: AgentRule = owner): string | null {
		if (owner.suggest === undefined) return null;
		const statement = suggestionStatement(owner.suggest);
		const stage = statement[0];
		const matched = new Set<string>();
		const context = { statement, stage, index: 0 };
		for (const builtin of RULES) if (builtin.matches(context)) matched.add(builtin.id);

		let includedProspectiveRule = false;
		for (const stored of this.rules.values()) {
			const candidate = stored.slug === prospectiveRule.slug ? prospectiveRule : stored;
			if (stored.slug === prospectiveRule.slug) includedProspectiveRule = true;
			if (candidate.state !== "active" && candidate.state !== "promoted") continue;
			if (stageMatches(candidate.match, statement, 0)) matched.add(agentClass(candidate.slug));
		}
		if (
			!includedProspectiveRule &&
			(prospectiveRule.state === "active" || prospectiveRule.state === "promoted") &&
			stageMatches(prospectiveRule.match, statement, 0)
		) {
			matched.add(agentClass(prospectiveRule.slug));
		}
		if (matched.size === 0) return null;
		return `rule "${owner.slug}" suggests a command form matched by ${[...matched].sort().join(", ")}`;
	}

	private promotionFailure(prospectiveRule: AgentRule): string | null {
		const targetFailure = this.suggestedFormFailure(prospectiveRule, prospectiveRule);
		if (targetFailure) return targetFailure;
		const owners = [...this.rules.values()]
			.filter((rule) => rule.slug !== prospectiveRule.slug && (rule.state === "active" || rule.state === "promoted"))
			.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
		for (const owner of owners) {
			if (owner.suggest === undefined) continue;
			const statement = suggestionStatement(owner.suggest);
			if (stageMatches(prospectiveRule.match, statement, 0)) {
				return `rule "${owner.slug}" suggests a command form matched by ${agentClass(prospectiveRule.slug)}`;
			}
		}
		return null;
	}

	/** Append and install a new active rule at the current rule-schema version. */
	async add(rule: Omit<AgentRule, "version">): Promise<string | null> {
		return this.serialize(async () => {
			const versioned: AgentRule = { ...rule, version: SCHEMA_VERSION };
			if (this.rules.has(versioned.slug)) return `rule "${versioned.slug}" already exists`;
			if (this.rules.size >= MAX_AGENT_RULES) return `agent rule registry is full at ${MAX_AGENT_RULES} rules`;
			const validation = validateRule(versioned);
			if (validation) return validation;
			const suggestedFormFailure = this.suggestedFormFailure(versioned);
			if (suggestedFormFailure) return suggestedFormFailure;
			let line: string;
			try {
				line = JSON.stringify({ kind: "rule", ...versioned });
			} catch (error) {
				return errorMessage(error);
			}
			const failure = await appendLine(this.dir, line);
			if (failure) return failure;
			this.rules.set(versioned.slug, copyRule(versioned));
			return null;
		});
	}

	/** Append and apply one valid state transition. */
	async setState(
		slug: string,
		state: AgentState,
		model: string,
		session: string,
		at: string,
		origin: StateOrigin,
		warrant?: PromotionWarrant,
	): Promise<string | null> {
		return this.serialize(async () => {
			const rule = this.rules.get(slug);
			if (!rule) return `unknown agent rule "${slug}"`;
			if (!isState(state)) return `invalid agent rule state "${String(state)}"`;
			if (!canTransition(rule.state, state)) return `discarded agent rule "${slug}" cannot change state`;
			const attributionFailure = validateAttribution(model, session, at);
			if (attributionFailure) return attributionFailure;
			if (origin !== "tool" && origin !== "command") return "state origin must be one of tool, command";
			if (state === "promoted" && warrant === undefined) return "promotion requires a recorded warrant";
			if (warrant !== undefined && state !== "promoted") return "a warrant applies only to promotion";
			if (warrant !== undefined) {
				const warrantFailure = validatePromotionWarrant(warrant);
				if (warrantFailure) return warrantFailure;
			}
			if (state === "promoted") {
				const promotionFailure = this.promotionFailure({ ...rule, state });
				if (promotionFailure) return promotionFailure;
			}
			const line = JSON.stringify(
				warrant === undefined
					? { kind: "state", slug, state, model, session, at, origin }
					: { kind: "state", slug, state, model, session, at, origin, warrant },
			);
			const failure = await appendLine(this.dir, line);
			if (failure) return failure;
			rule.state = state;
			return null;
		});
	}
}
