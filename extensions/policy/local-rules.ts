/** Append-only local rule registry, validation, reduction, and shell-shape matching. */

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseStatements, type Stage } from "./shell.ts";
import { ensurePrivateDirectory } from "./store.ts";

export const LOCAL_RULES_FILE = "rules.jsonl";
export const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
export const MAX_RULE_EVENT_BYTES = 64 * 1024;
export const MAX_LOCAL_RULES = 256;
export const MAX_PENDING_PROPOSALS = 256;
export const MAX_SLUG_LENGTH = 80;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_GUIDANCE_TEXT_BYTES = 400;
export const MAX_REASON_LENGTH = 1000;
export const MAX_COMMAND_LENGTH = 200;
export const MAX_LIST_ENTRIES = 64;
export const MAX_LIST_ENTRY_LENGTH = 200;
export const MAX_CWD_PREFIX_LENGTH = 500;
export const MAX_AUDIT_FIELD_LENGTH = 500;

const SLUG = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const BUILTIN_PREFIXES = ["routing.", "form.", "bounds."];
const SURFACES = ["agent-tool", "command", "panel"] as const;
const EFFECTS = ["steer", "block"] as const;
const STATES = ["active", "disabled", "discarded"] as const;
/** Serializes transition checks and appends across registry instances in this process. */
const MUTATION_TAILS = new Map<string, Promise<void>>();
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type AuditSurface = (typeof SURFACES)[number];
export type LocalRuleEffect = (typeof EFFECTS)[number];
export type LocalRuleState = (typeof STATES)[number];
export type ProposalOperation = "upsert" | "discard";

export interface RuleAudit {
	at: string;
	session: string;
	model: string | null;
	surface: AuditSurface;
}

export interface OperandMatch {
	min?: number;
	max?: number;
	any?: string[];
	at?: Record<string, string[]>;
}

export interface PipeMatch {
	from?: boolean;
	to?: boolean;
	fromRedirect?: boolean;
	toRedirect?: boolean;
	next?: string[];
	later?: string[];
}

export interface LocalRuleMatch {
	command: string;
	flags?: string[];
	absentFlags?: string[];
	operands?: OperandMatch;
	pipe?: PipeMatch;
}

export interface LocalRuleSuggestion {
	command: string;
	flags?: string[];
}

export interface LocalRuleScope {
	providers?: string[];
	models?: string[];
	cwdPrefixes?: string[];
}

export interface LocalRuleCandidate {
	slug: string;
	note: string;
	match: LocalRuleMatch;
	suggest?: LocalRuleSuggestion;
	scope?: LocalRuleScope;
}

export interface ProposalEvent {
	kind: "proposal";
	id: string;
	operation: ProposalOperation;
	slug: string;
	reason: string;
	candidate?: LocalRuleCandidate;
	audit: RuleAudit;
}

export interface DecisionEvent {
	kind: "decision";
	id: string;
	proposalId: string;
	decision: "approved" | "rejected";
	effect?: LocalRuleEffect;
	audit: RuleAudit;
}

export interface StateEvent {
	kind: "state";
	id: string;
	slug: string;
	state: LocalRuleState;
	audit: RuleAudit;
}

export interface EffectEvent {
	kind: "effect";
	id: string;
	slug: string;
	effect: LocalRuleEffect;
	audit: RuleAudit;
}

export type LocalRuleEvent = ProposalEvent | DecisionEvent | StateEvent | EffectEvent;
export type PendingProposal = ProposalEvent;

export interface LocalRule extends LocalRuleCandidate {
	state: LocalRuleState;
	effect: LocalRuleEffect;
	proposalId: string;
	proposedAudit: RuleAudit;
	approvedAudit: RuleAudit;
	updatedAudit?: RuleAudit;
}

export interface LocalRuleSnapshot {
	/** Active and disabled entries available to operator surfaces. */
	rules: LocalRule[];
	/** Terminal entries retained internally so a slug cannot be reused. */
	discarded: LocalRule[];
	pending: PendingProposal[];
}

export interface RuleMatchContext {
	provider?: string | null;
	model?: string | null;
	cwd: string;
}

export interface AuditContextLike {
	sessionManager: { getSessionId(): string };
	model?: { provider: string; id: string } | null;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of required) if (!(key in value)) throw new Error(`missing field "${key}"`);
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown field "${key}"`);
}

function text(value: unknown, name: string, maximum: number, allowEmpty = false): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	if ((!allowEmpty && value.trim().length === 0) || value.length > maximum) {
		throw new Error(`${name} must be ${allowEmpty ? "at most" : "between 1 and"} ${maximum} characters`);
	}
	return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${name} must be one of ${values.join(", ")}`);
	}
	return value as T;
}

function stringList(value: unknown, name: string, maximumLength = MAX_LIST_ENTRY_LENGTH): string[] {
	if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
		throw new Error(`${name} must be an array of at most ${MAX_LIST_ENTRIES} strings`);
	}
	return value.map((entry, index) => text(entry, `${name}[${index}]`, maximumLength));
}

export function validateSlug(value: unknown): string {
	const slug = text(value, "slug", MAX_SLUG_LENGTH);
	if (!SLUG.test(slug)) throw new Error("slug must start with a letter and contain lowercase letters, digits, dots, or hyphens");
	if (BUILTIN_PREFIXES.some((prefix) => slug.startsWith(prefix))) {
		throw new Error(`slug "${slug}" collides with a built-in rule namespace`);
	}
	return slug;
}

function validateAudit(value: unknown): RuleAudit {
	if (!object(value)) throw new Error("audit must be an object");
	exact(value, ["at", "session", "model", "surface"]);
	const at = text(value.at, "audit.at", MAX_AUDIT_FIELD_LENGTH);
	if (!ISO_8601.test(at) || Number.isNaN(Date.parse(at))) throw new Error("audit.at must be an ISO-8601 timestamp");
	const session = text(value.session, "audit.session", MAX_AUDIT_FIELD_LENGTH);
	const model = value.model === null ? null : text(value.model, "audit.model", MAX_AUDIT_FIELD_LENGTH);
	if (model !== null && (!model.includes("/") || model.startsWith("/") || model.endsWith("/"))) {
		throw new Error("audit.model must be provider/id or null");
	}
	return { at, session, model, surface: oneOf(value.surface, SURFACES, "audit.surface") };
}

function validateMatch(value: unknown): LocalRuleMatch {
	if (!object(value)) throw new Error("match must be an object");
	exact(value, ["command"], ["flags", "absentFlags", "operands", "pipe"]);
	const match: LocalRuleMatch = { command: text(value.command, "match.command", MAX_COMMAND_LENGTH) };
	if (value.flags !== undefined) match.flags = stringList(value.flags, "match.flags");
	if (value.absentFlags !== undefined) match.absentFlags = stringList(value.absentFlags, "match.absentFlags");
	if (value.operands !== undefined) {
		if (!object(value.operands)) throw new Error("match.operands must be an object");
		exact(value.operands, [], ["min", "max", "any", "at"]);
		const operands: OperandMatch = {};
		for (const bound of ["min", "max"] as const) {
			const number = value.operands[bound];
			if (number !== undefined) {
				if (!Number.isSafeInteger(number) || (number as number) < 0 || (number as number) > 100_000) {
					throw new Error(`match.operands.${bound} must be a non-negative integer`);
				}
				operands[bound] = number as number;
			}
		}
		if (operands.min !== undefined && operands.max !== undefined && operands.min > operands.max) {
			throw new Error("match.operands.min must not exceed max");
		}
		if (value.operands.any !== undefined) operands.any = stringList(value.operands.any, "match.operands.any");
		if (value.operands.at !== undefined) {
			if (!object(value.operands.at) || Object.keys(value.operands.at).length > MAX_LIST_ENTRIES) {
				throw new Error(`match.operands.at must be an object with at most ${MAX_LIST_ENTRIES} indexes`);
			}
			operands.at = {};
			for (const [index, choices] of Object.entries(value.operands.at)) {
				if (!/^(0|[1-9][0-9]*)$/.test(index) || Number(index) > 100_000) {
					throw new Error("match.operands.at keys must be non-negative integer indexes");
				}
				operands.at[index] = stringList(choices, `match.operands.at.${index}`);
			}
		}
		match.operands = operands;
	}
	if (value.pipe !== undefined) {
		if (!object(value.pipe)) throw new Error("match.pipe must be an object");
		exact(value.pipe, [], ["from", "to", "fromRedirect", "toRedirect", "next", "later"]);
		const pipe: PipeMatch = {};
		for (const flag of ["from", "to", "fromRedirect", "toRedirect"] as const) {
			if (value.pipe[flag] !== undefined) {
				if (typeof value.pipe[flag] !== "boolean") throw new Error(`match.pipe.${flag} must be boolean`);
				pipe[flag] = value.pipe[flag] as boolean;
			}
		}
		if (value.pipe.next !== undefined) pipe.next = stringList(value.pipe.next, "match.pipe.next", MAX_COMMAND_LENGTH);
		if (value.pipe.later !== undefined) pipe.later = stringList(value.pipe.later, "match.pipe.later", MAX_COMMAND_LENGTH);
		match.pipe = pipe;
	}
	return match;
}

function validateSuggestion(value: unknown): LocalRuleSuggestion {
	if (!object(value)) throw new Error("suggest must be an object");
	exact(value, ["command"], ["flags"]);
	const suggestion: LocalRuleSuggestion = { command: text(value.command, "suggest.command", MAX_COMMAND_LENGTH) };
	if (value.flags !== undefined) suggestion.flags = stringList(value.flags, "suggest.flags");
	return suggestion;
}

function validateScope(value: unknown): LocalRuleScope {
	if (!object(value)) throw new Error("scope must be an object");
	exact(value, [], ["providers", "models", "cwdPrefixes"]);
	const scope: LocalRuleScope = {};
	if (value.providers !== undefined) scope.providers = stringList(value.providers, "scope.providers");
	if (value.models !== undefined) {
		scope.models = stringList(value.models, "scope.models");
		for (const model of scope.models) {
			if (!model.includes("/") || model.startsWith("/") || model.endsWith("/")) {
				throw new Error("scope.models entries must be provider/id strings");
			}
		}
	}
	if (value.cwdPrefixes !== undefined) {
		scope.cwdPrefixes = stringList(value.cwdPrefixes, "scope.cwdPrefixes", MAX_CWD_PREFIX_LENGTH);
		for (const prefix of scope.cwdPrefixes) if (!isAbsolute(prefix)) throw new Error("scope.cwdPrefixes entries must be absolute paths");
	}
	return scope;
}

export function validateCandidate(value: unknown): LocalRuleCandidate {
	if (!object(value)) throw new Error("candidate must be an object");
	exact(value, ["slug", "note", "match"], ["suggest", "scope"]);
	const candidate: LocalRuleCandidate = {
		slug: validateSlug(value.slug),
		note: text(value.note, "note", MAX_NOTE_LENGTH),
		match: validateMatch(value.match),
	};
	if (value.suggest !== undefined) candidate.suggest = validateSuggestion(value.suggest);
	if (value.scope !== undefined) candidate.scope = validateScope(value.scope);
	const guidanceBytes = Buffer.byteLength(localRuleGuidance(candidate), "utf8");
	if (guidanceBytes > MAX_GUIDANCE_TEXT_BYTES) {
		throw new Error(
			`rendered guidance is ${guidanceBytes} UTF-8 bytes; shorten note or suggestion to at most ${MAX_GUIDANCE_TEXT_BYTES} bytes`,
		);
	}
	return candidate;
}

function eventId(value: unknown, name: string): string {
	const id = text(value, name, 64);
	if (!UUID.test(id)) throw new Error(`${name} must be a UUID`);
	return id;
}

export function validateLocalRuleEvent(value: unknown): LocalRuleEvent {
	if (!object(value)) throw new Error("event must be an object");
	const kind = oneOf(value.kind, ["proposal", "decision", "state", "effect"] as const, "event kind");
	if (kind === "proposal") {
		exact(value, ["kind", "id", "operation", "slug", "reason", "audit"], ["candidate"]);
		const operation = oneOf(value.operation, ["upsert", "discard"] as const, "proposal operation");
		const slug = validateSlug(value.slug);
		const proposal: ProposalEvent = {
			kind,
			id: eventId(value.id, "proposal.id"),
			operation,
			slug,
			reason: text(value.reason, "reason", MAX_REASON_LENGTH),
			audit: validateAudit(value.audit),
		};
		if (operation === "upsert") {
			proposal.candidate = validateCandidate(value.candidate);
			if (proposal.candidate.slug !== slug) throw new Error("proposal slug must equal candidate slug");
		} else if (value.candidate !== undefined) throw new Error("discard proposal must not contain a candidate");
		return proposal;
	}
	if (kind === "decision") {
		exact(value, ["kind", "id", "proposalId", "decision", "audit"], ["effect"]);
		const event: DecisionEvent = {
			kind,
			id: eventId(value.id, "decision.id"),
			proposalId: eventId(value.proposalId, "decision.proposalId"),
			decision: oneOf(value.decision, ["approved", "rejected"] as const, "decision"),
			audit: validateAudit(value.audit),
		};
		if (event.audit.surface === "agent-tool") throw new Error("decision audit must name an operator surface");
		if (value.effect !== undefined) event.effect = oneOf(value.effect, EFFECTS, "effect");
		if (event.decision === "rejected" && event.effect !== undefined) throw new Error("rejected decision must not contain an effect");
		return event;
	}
	if (kind === "state") {
		exact(value, ["kind", "id", "slug", "state", "audit"]);
		const event: StateEvent = {
			kind,
			id: eventId(value.id, "state.id"),
			slug: validateSlug(value.slug),
			state: oneOf(value.state, STATES, "state"),
			audit: validateAudit(value.audit),
		};
		if (event.audit.surface === "agent-tool") throw new Error("state audit must name an operator surface");
		return event;
	}
	exact(value, ["kind", "id", "slug", "effect", "audit"]);
	const event: EffectEvent = {
		kind,
		id: eventId(value.id, "effect.id"),
		slug: validateSlug(value.slug),
		effect: oneOf(value.effect, EFFECTS, "effect"),
		audit: validateAudit(value.audit),
	};
	if (event.audit.surface === "agent-tool") throw new Error("effect audit must name an operator surface");
	return event;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

/** Reduce valid events. Missing-target decision/state/effect events are intentionally ignored. */
export function reduceLocalRuleEvents(events: readonly LocalRuleEvent[]): LocalRuleSnapshot {
	const rules = new Map<string, LocalRule>();
	const pending = new Map<string, ProposalEvent>();
	const pendingBySlug = new Map<string, string>();
	for (const event of events) {
		if (event.kind === "proposal") {
			if (pendingBySlug.has(event.slug)) continue;
			const prior = rules.get(event.slug);
			if (prior?.state === "discarded" || (event.operation === "discard" && !prior)) continue;
			pending.set(event.id, clone(event));
			pendingBySlug.set(event.slug, event.id);
			continue;
		}
		if (event.kind === "decision") {
			if (event.audit.surface === "agent-tool") continue;
			const proposal = pending.get(event.proposalId);
			if (!proposal) continue;
			if (event.decision === "approved") {
				if (proposal.operation === "upsert") {
					if (!event.effect || !proposal.candidate) continue;
					const existing = rules.get(proposal.slug);
					if (existing?.state === "discarded") continue;
					rules.set(proposal.slug, {
						...clone(proposal.candidate),
						state: "active",
						effect: event.effect,
						proposalId: proposal.id,
						proposedAudit: clone(proposal.audit),
						approvedAudit: clone(event.audit),
					});
				} else {
					if (event.effect !== undefined) continue;
					const existing = rules.get(proposal.slug);
					if (!existing || existing.state === "discarded") continue;
					rules.set(proposal.slug, { ...existing, state: "discarded", updatedAudit: clone(event.audit) });
				}
			}
			pending.delete(proposal.id);
			pendingBySlug.delete(proposal.slug);
			continue;
		}
		if (event.audit.surface === "agent-tool") continue;
		const rule = rules.get(event.slug);
		if (!rule || rule.state === "discarded") continue;
		if (event.kind === "state") rules.set(event.slug, { ...rule, state: event.state, updatedAudit: clone(event.audit) });
		else rules.set(event.slug, { ...rule, effect: event.effect, updatedAudit: clone(event.audit) });
	}
	if (rules.size > MAX_LOCAL_RULES) throw new Error(`registry exceeds ${MAX_LOCAL_RULES} rules`);
	if (pending.size > MAX_PENDING_PROPOSALS) throw new Error(`registry exceeds ${MAX_PENDING_PROPOSALS} pending proposals`);
	const all = [...rules.values()].sort((left, right) => left.slug.localeCompare(right.slug));
	return {
		rules: all.filter((rule) => rule.state !== "discarded"),
		discarded: all.filter((rule) => rule.state === "discarded"),
		pending: [...pending.values()].sort((left, right) => left.slug.localeCompare(right.slug) || left.id.localeCompare(right.id)),
	};
}

function privateFile(info: Awaited<ReturnType<typeof lstat>>, path: string): void {
	if (!info.isFile() || info.isSymbolicLink()) throw new Error(`local rule registry is not a regular file: ${path}`);
	if ((Number(info.mode) & 0o077) !== 0) throw new Error(`local rule registry permissions are not private: ${path}`);
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
		throw new Error(`local rule registry is not owned by this user: ${path}`);
	}
}

async function checkExistingDirectory(dir: string): Promise<void> {
	try {
		const info = await lstat(dir);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`policy store is not a regular directory: ${dir}`);
		if ((info.mode & 0o077) !== 0) throw new Error(`policy store permissions are not private: ${dir}`);
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
			throw new Error(`policy store is not owned by this user: ${dir}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function cacheKey(info: Awaited<ReturnType<typeof lstat>>): string {
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

async function readChecked(path: string, expected: Awaited<ReturnType<typeof lstat>>): Promise<Buffer> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const info = await handle.stat();
		privateFile(info, path);
		if (info.dev !== expected.dev || info.ino !== expected.ino || info.size !== expected.size) {
			throw new Error("local rule registry changed while it was being read");
		}
		if (info.size > MAX_REGISTRY_BYTES) throw new Error(`local rule registry exceeds ${MAX_REGISTRY_BYTES} bytes`);
		const buffer = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < buffer.length) {
			const read = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (read.bytesRead === 0) throw new Error("local rule registry ended during read");
			offset += read.bytesRead;
		}
		return buffer;
	} finally {
		await handle.close();
	}
}

function parseRegistry(buffer: Buffer): LocalRuleSnapshot {
	if (buffer.length === 0) return { rules: [], discarded: [], pending: [] };
	if (buffer[buffer.length - 1] !== 0x0a) throw new Error("local rule registry has an incomplete final line");
	const events: LocalRuleEvent[] = [];
	let start = 0;
	let lineNumber = 0;
	for (let index = 0; index < buffer.length; index++) {
		if (buffer[index] !== 0x0a) continue;
		lineNumber++;
		const line = buffer.subarray(start, index);
		start = index + 1;
		if (line.length === 0) throw new Error(`local rule registry line ${lineNumber} is empty`);
		if (line.length + 1 > MAX_RULE_EVENT_BYTES) throw new Error(`local rule registry line ${lineNumber} exceeds ${MAX_RULE_EVENT_BYTES} bytes`);
		try {
			events.push(validateLocalRuleEvent(JSON.parse(UTF8.decode(line)) as unknown));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`invalid local rule registry line ${lineNumber}: ${reason}`);
		}
	}
	return reduceLocalRuleEvents(events);
}

export class LocalRuleRegistry {
	private readonly dir: string;
	private readonly path: string;
	private cachedKey: string | undefined;
	private cachedSnapshot: LocalRuleSnapshot | undefined;

	constructor(dir: string) {
		this.dir = dir;
		this.path = join(dir, LOCAL_RULES_FILE);
	}

	async snapshot(): Promise<LocalRuleSnapshot> {
		await checkExistingDirectory(this.dir);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(this.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const empty = { rules: [], discarded: [], pending: [] } satisfies LocalRuleSnapshot;
			this.cachedKey = "missing";
			this.cachedSnapshot = empty;
			return clone(empty);
		}
		privateFile(info, this.path);
		if (info.size > MAX_REGISTRY_BYTES) throw new Error(`local rule registry exceeds ${MAX_REGISTRY_BYTES} bytes`);
		const key = cacheKey(info);
		if (key === this.cachedKey && this.cachedSnapshot) return clone(this.cachedSnapshot);
		const snapshot = parseRegistry(await readChecked(this.path, info));
		this.cachedKey = key;
		this.cachedSnapshot = snapshot;
		return clone(snapshot);
	}

	private async mutate<T>(action: () => Promise<T>): Promise<T> {
		const prior = MUTATION_TAILS.get(this.path) ?? Promise.resolve();
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = prior.then(() => gate);
		MUTATION_TAILS.set(this.path, tail);
		await prior;
		try {
			return await action();
		} finally {
			release();
			if (MUTATION_TAILS.get(this.path) === tail) MUTATION_TAILS.delete(this.path);
		}
	}

	private async append(event: LocalRuleEvent): Promise<void> {
		const checked = validateLocalRuleEvent(event);
		const serialized = Buffer.from(`${JSON.stringify(checked)}\n`, "utf8");
		if (serialized.length > MAX_RULE_EVENT_BYTES) throw new Error(`local rule event exceeds ${MAX_RULE_EVENT_BYTES} bytes`);
		await ensurePrivateDirectory(this.dir);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const handle = await open(
			this.path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow,
			0o600,
		);
		try {
			const info = await handle.stat();
			privateFile(info, this.path);
			await handle.chmod(0o600);
			if (info.size + serialized.length > MAX_REGISTRY_BYTES) {
				throw new Error(`local rule registry would exceed ${MAX_REGISTRY_BYTES} bytes`);
			}
			const result = await handle.write(serialized, 0, serialized.length, null);
			if (result.bytesWritten !== serialized.length) {
				throw new Error(`local rule event write stopped at ${result.bytesWritten} of ${serialized.length} bytes`);
			}
		} finally {
			await handle.close();
		}
		this.cachedKey = undefined;
		this.cachedSnapshot = undefined;
	}

	private async proposeUpsertUnlocked(candidateValue: LocalRuleCandidate, reasonValue: string, auditValue: RuleAudit): Promise<ProposalEvent> {
		const candidate = validateCandidate(candidateValue);
		const reason = text(reasonValue, "reason", MAX_REASON_LENGTH);
		const audit = validateAudit(auditValue);
		if (audit.surface !== "agent-tool") throw new Error("upsert proposals may only be written by policy_propose");
		const snapshot = await this.snapshot();
		if (snapshot.pending.some((proposal) => proposal.slug === candidate.slug)) throw new Error(`a proposal is already pending for "${candidate.slug}"`);
		if (snapshot.discarded.some((rule) => rule.slug === candidate.slug)) throw new Error(`rule "${candidate.slug}" was discarded and its slug cannot be reused`);
		if (snapshot.rules.length + snapshot.discarded.length >= MAX_LOCAL_RULES && !snapshot.rules.some((rule) => rule.slug === candidate.slug)) {
			throw new Error(`registry already contains ${MAX_LOCAL_RULES} rules`);
		}
		if (snapshot.pending.length >= MAX_PENDING_PROPOSALS) throw new Error(`registry already contains ${MAX_PENDING_PROPOSALS} pending proposals`);
		const event: ProposalEvent = { kind: "proposal", id: randomUUID(), operation: "upsert", slug: candidate.slug, reason, candidate, audit };
		await this.append(event);
		return event;
	}

	private async proposeDiscardUnlocked(slugValue: string, reasonValue: string, auditValue: RuleAudit): Promise<ProposalEvent> {
		const slug = validateSlug(slugValue);
		const reason = text(reasonValue, "reason", MAX_REASON_LENGTH);
		const audit = validateAudit(auditValue);
		if (audit.surface !== "agent-tool") throw new Error("discard proposals may only be written by policy_propose");
		const snapshot = await this.snapshot();
		if (snapshot.pending.some((proposal) => proposal.slug === slug)) throw new Error(`a proposal is already pending for "${slug}"`);
		if (!snapshot.rules.some((rule) => rule.slug === slug)) throw new Error(`no retained rule named "${slug}" exists`);
		if (snapshot.pending.length >= MAX_PENDING_PROPOSALS) throw new Error(`registry already contains ${MAX_PENDING_PROPOSALS} pending proposals`);
		const event: ProposalEvent = { kind: "proposal", id: randomUUID(), operation: "discard", slug, reason, audit };
		await this.append(event);
		return event;
	}

	private async decideUnlocked(
		proposalIdValue: string,
		decisionValue: "approved" | "rejected",
		effectValue: LocalRuleEffect | undefined,
		auditValue: RuleAudit,
	): Promise<DecisionEvent> {
		const proposalId = eventId(proposalIdValue, "proposal id");
		const decision = oneOf(decisionValue, ["approved", "rejected"] as const, "decision");
		const audit = validateAudit(auditValue);
		if (audit.surface === "agent-tool") throw new Error("only operator surfaces may decide proposals");
		const snapshot = await this.snapshot();
		const proposal = snapshot.pending.find((entry) => entry.id === proposalId);
		if (!proposal) throw new Error(`no pending proposal with id "${proposalId}"`);
		if (snapshot.discarded.some((rule) => rule.slug === proposal.slug)) {
			throw new Error(`rule "${proposal.slug}" is discarded and the pending proposal cannot be decided`);
		}
		if (proposal.operation === "discard" && !snapshot.rules.some((rule) => rule.slug === proposal.slug)) {
			throw new Error(`discard proposal target "${proposal.slug}" is no longer retained`);
		}
		let effect: LocalRuleEffect | undefined;
		if (decision === "approved" && proposal.operation === "upsert") {
			if (effectValue === undefined) throw new Error("approving an upsert proposal requires effect steer or block");
			effect = oneOf(effectValue, EFFECTS, "effect");
		} else if (effectValue !== undefined) {
			throw new Error(`${decision === "approved" ? "approving a discard proposal" : "rejecting a proposal"} does not accept an effect`);
		}
		const event: DecisionEvent = { kind: "decision", id: randomUUID(), proposalId, decision, audit };
		if (effect !== undefined) event.effect = effect;
		await this.append(event);
		return event;
	}

	private async setStateUnlocked(slugValue: string, stateValue: LocalRuleState, auditValue: RuleAudit): Promise<StateEvent> {
		const slug = validateSlug(slugValue);
		const state = oneOf(stateValue, STATES, "state");
		const audit = validateAudit(auditValue);
		if (audit.surface === "agent-tool") throw new Error("only operator surfaces may change rule state");
		const snapshot = await this.snapshot();
		if (snapshot.discarded.some((rule) => rule.slug === slug)) throw new Error(`rule "${slug}" is discarded and terminal`);
		if (!snapshot.rules.some((rule) => rule.slug === slug)) throw new Error(`no retained rule named "${slug}" exists`);
		if (state === "discarded" && snapshot.pending.some((proposal) => proposal.slug === slug)) {
			throw new Error(`reject the pending proposal for "${slug}" before discarding the rule directly`);
		}
		const event: StateEvent = { kind: "state", id: randomUUID(), slug, state, audit };
		await this.append(event);
		return event;
	}

	private async setEffectUnlocked(slugValue: string, effectValue: LocalRuleEffect, auditValue: RuleAudit): Promise<EffectEvent> {
		const slug = validateSlug(slugValue);
		const effect = oneOf(effectValue, EFFECTS, "effect");
		const audit = validateAudit(auditValue);
		if (audit.surface === "agent-tool") throw new Error("only operator surfaces may change rule effect");
		const snapshot = await this.snapshot();
		if (snapshot.discarded.some((rule) => rule.slug === slug)) throw new Error(`rule "${slug}" is discarded and terminal`);
		if (!snapshot.rules.some((rule) => rule.slug === slug)) throw new Error(`no retained rule named "${slug}" exists`);
		const event: EffectEvent = { kind: "effect", id: randomUUID(), slug, effect, audit };
		await this.append(event);
		return event;
	}

	proposeUpsert(candidate: LocalRuleCandidate, reason: string, audit: RuleAudit): Promise<ProposalEvent> {
		return this.mutate(() => this.proposeUpsertUnlocked(candidate, reason, audit));
	}

	proposeDiscard(slug: string, reason: string, audit: RuleAudit): Promise<ProposalEvent> {
		return this.mutate(() => this.proposeDiscardUnlocked(slug, reason, audit));
	}

	decide(
		proposalId: string,
		decision: "approved" | "rejected",
		effect: LocalRuleEffect | undefined,
		audit: RuleAudit,
	): Promise<DecisionEvent> {
		return this.mutate(() => this.decideUnlocked(proposalId, decision, effect, audit));
	}

	setState(slug: string, state: LocalRuleState, audit: RuleAudit): Promise<StateEvent> {
		return this.mutate(() => this.setStateUnlocked(slug, state, audit));
	}

	setEffect(slug: string, effect: LocalRuleEffect, audit: RuleAudit): Promise<EffectEvent> {
		return this.mutate(() => this.setEffectUnlocked(slug, effect, audit));
	}
}

export function makeRuleAudit(ctx: AuditContextLike, surface: AuditSurface, now: Date = new Date()): RuleAudit {
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
	return validateAudit({ at: now.toISOString(), session: ctx.sessionManager.getSessionId(), model, surface });
}

function scopeMatches(scope: LocalRuleScope | undefined, context: RuleMatchContext): boolean {
	if (!scope) return true;
	if (scope.providers && !scope.providers.includes(context.provider ?? "")) return false;
	if (scope.models && !scope.models.includes(context.model ?? "")) return false;
	if (scope.cwdPrefixes && !scope.cwdPrefixes.some((prefix) => context.cwd.startsWith(prefix))) return false;
	return true;
}

function stageMatches(stage: Stage, position: number, statement: readonly Stage[], match: LocalRuleMatch): boolean {
	if (stage.command !== match.command) return false;
	if (match.flags && !match.flags.every((flag) => stage.args.includes(flag))) return false;
	if (match.absentFlags?.some((flag) => stage.args.includes(flag))) return false;
	const operands = stage.args.filter((arg) => !arg.startsWith("-"));
	if (match.operands?.min !== undefined && operands.length < match.operands.min) return false;
	if (match.operands?.max !== undefined && operands.length > match.operands.max) return false;
	if (match.operands?.any && !operands.some((operand) => match.operands!.any!.includes(operand))) return false;
	if (match.operands?.at) {
		for (const [index, choices] of Object.entries(match.operands.at)) if (!choices.includes(operands[Number(index)])) return false;
	}
	const pipe = match.pipe;
	if (pipe?.from !== undefined && stage.fromPipe !== pipe.from) return false;
	if (pipe?.to !== undefined && stage.toPipe !== pipe.to) return false;
	if (pipe?.fromRedirect !== undefined && stage.fromRedirect !== pipe.fromRedirect) return false;
	if (pipe?.toRedirect !== undefined && stage.toRedirect !== pipe.toRedirect) return false;
	if (pipe?.next && !pipe.next.includes(statement[position + 1]?.command ?? "")) return false;
	if (pipe?.later && !statement.slice(position + 1).some((later) => pipe.later!.includes(later.command))) return false;
	return true;
}

/** Match active entries against parsed shell shape; no shell data is expanded. */
export function matchLocalRules(
	capturedCommand: string,
	rules: readonly LocalRule[],
	context: RuleMatchContext,
): LocalRule[] {
	const statements = parseStatements(capturedCommand);
	return rules
		.filter(
			(rule) =>
				rule.state === "active" &&
				scopeMatches(rule.scope, context) &&
				statements.some((statement) => statement.some((stage, index) => stageMatches(stage, index, statement, rule.match))),
		)
		.sort((left, right) => left.slug.localeCompare(right.slug));
}

function safeOneLine(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) => {
			const code = character.codePointAt(0) ?? 0;
			return `\\x${code.toString(16).padStart(2, "0")}`;
		})
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Plain, one-line guidance for one local rule. */
export function localRuleGuidance(rule: Pick<LocalRuleCandidate, "note" | "suggest">): string {
	const note = safeOneLine(rule.note);
	if (!rule.suggest) return note;
	const form = safeOneLine([rule.suggest.command, ...(rule.suggest.flags ?? [])].join(" ")).replace(/[.]+$/, "");
	return `${note} Suggested form: ${form}.`;
}
