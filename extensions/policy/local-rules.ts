/** Unified append-only rule store, strict event validation, and reduction. */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PACKAGE_CATALOG } from "./catalog.ts";
import { type NamedData, validateNamedData } from "./data.ts";
import {
	type Condition,
	type FactsProgram,
	PROGRAM_LIMITS,
	RULE_CAPACITY,
	validateApplicability,
	validateFactsProgram,
} from "./program.ts";
import {
	type AgentRuleAudit,
	type AuditSurface,
	actionEffect,
	type CommandShapeSpec,
	contentRevision,
	type DefinitionEffect,
	declaredAction,
	effectiveEffect,
	effectiveState,
	factsProgram,
	type OperatorRuleAudit,
	type PackageDefinitionRow,
	type PackageRuleAudit,
	packageRowRevision,
	permitsEffectChoice,
	type RuleAudit,
	type RuleAuthority,
	type RuleEffect,
	type RuleMatcher,
	type RuleOverride,
	type RuleRecord,
	type RuleScope,
	type RuleSuggestion,
	ruleDefinitionRevision,
	ruleGuidance,
	type SessionRuleAudit,
} from "./rule.ts";
import { hasCodeMatcher } from "./shell-rules.ts";
import { ensurePrivateDirectory } from "./store.ts";

export const RULES_FILE = "rules.jsonl";
const RULES_LOCK_FILE = ".rules-lock";
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_MS = 25;
export const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
export const MAX_RULE_EVENT_BYTES = 64 * 1024;
export const MAX_CATALOG_EVENT_BYTES = 512 * 1024;
export const MAX_RULES = RULE_CAPACITY.catalog;
export const MAX_PENDING_PROPOSALS = 256;
export const MAX_RULE_ID_LENGTH = 80;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_PURPOSE_LENGTH = 400;
export const MAX_GUIDANCE_TEXT_BYTES = 400;
export const MAX_REASON_LENGTH = 1000;
export const MAX_COMMAND_LENGTH = 200;
export const MAX_LIST_ENTRIES = 64;
export const MAX_LIST_ENTRY_LENGTH = 200;
export const MAX_CWD_PREFIX_LENGTH = 500;
export const MAX_AUDIT_FIELD_LENGTH = 500;
export const MAX_CATALOG_ROWS = RULE_CAPACITY.catalog;

const RULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^[0-9a-f]{12}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EFFECTS = ["steer", "block"] as const;
const SESSION_SURFACES = ["agent-tool", "command", "panel"] as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface LocalRuleCandidate {
	id: string;
	purpose: string;
	authority: RuleAuthority;
	applicability?: Condition;
	matcher: RuleMatcher;
	note: string;
	suggestion?: RuleSuggestion;
	scope?: RuleScope;
}

export interface PersistedLocalCandidate {
	purpose: string;
	authority: RuleAuthority;
	applicability?: Condition;
	matcher: RuleMatcher;
	note: string;
	suggestion?: RuleSuggestion;
	scope?: RuleScope;
}

export type ProposalOperation = "add" | "replace" | "retire" | "disable";

export interface CatalogEvent {
	kind: "catalog";
	/** Starter definitions, accepted only as the first event. */
	rows: PackageDefinitionRow[];
	audit: PackageRuleAudit;
}

export interface CatalogImportTarget {
	id: string;
	identity: string | null;
}

export interface CatalogImportPlan {
	rows: PackageDefinitionRow[];
	targets: CatalogImportTarget[];
	revision: string;
}

export interface CatalogImportPreview extends CatalogImportPlan {
	/** Exact target records behind the identity hashes, for complete operator review. */
	current: Array<RuleRecord | null>;
	resulting: Array<{ id: string; state: ReturnType<typeof effectiveState>; effect: DefinitionEffect }>;
}

export interface CatalogImportEvent extends CatalogImportPlan {
	kind: "import";
	id: string;
	audit: SessionRuleAudit;
}

export interface ProposalEvent {
	kind: "proposal";
	/** Proposal identity. */
	id: string;
	operation: ProposalOperation;
	ruleId: string;
	reason: string;
	candidate?: PersistedLocalCandidate;
	/** Replacement compares the complete behavior revision at approval time. */
	expectedRevision?: string;
	audit: AgentRuleAudit;
}

export interface DecisionEvent {
	kind: "decision";
	id: string;
	proposalId: string;
	decision: "approved" | "rejected";
	effect?: RuleEffect;
	/** Exact approvals bind the complete inert proposal, including action parameters. */
	proposalRevision?: string;
	audit: SessionRuleAudit;
}

export interface OverrideEventSlot extends Omit<RuleOverride, "audit"> {
	/** Agent-surface slots validate so reduction can ignore them defensively. */
	audit: SessionRuleAudit;
}

export interface SetOverrideEvent {
	kind: "override";
	id: string;
	ruleId: string;
	operation: "set";
	/** Complete intended override slot, composed against the current record at write time. */
	override: OverrideEventSlot;
}

export interface ClearOverrideEvent {
	kind: "override";
	id: string;
	ruleId: string;
	operation: "clear";
	reason: string;
	audit: SessionRuleAudit;
}

export type OverrideEvent = SetOverrideEvent | ClearOverrideEvent;

export interface DefinitionEvent {
	kind: "definition";
	id: string;
	ruleId: string;
	state: "retired";
	reason: string;
	audit: SessionRuleAudit;
}

export interface DataSetEvent {
	kind: "data";
	id: string;
	operation: "set";
	data: NamedData;
	expectedRevision: string | null;
	audit: SessionRuleAudit;
}

export interface DataRemoveEvent {
	kind: "data";
	id: string;
	operation: "remove";
	name: string;
	expectedRevision: string;
	audit: SessionRuleAudit;
}

export type DataEvent = DataSetEvent | DataRemoveEvent;
export type RuleEvent =
	| CatalogEvent
	| CatalogImportEvent
	| ProposalEvent
	| DecisionEvent
	| OverrideEvent
	| DefinitionEvent
	| DataEvent;
export type PendingProposal = ProposalEvent;

export interface RuleReduction {
	records: Map<string, RuleRecord>;
	pending: PendingProposal[];
	/** Operator-approved source bindings, never tool results or rule-selected paths. */
	data: Map<string, NamedData>;
}

export const MAX_NAMED_DATA = 64;

export function proposalRevision(proposal: ProposalEvent): string {
	return contentRevision(proposal);
}

export function namedDataRevision(data: Omit<NamedData, "revision"> | NamedData): string {
	const { revision: _revision, ...contract } = data as NamedData;
	return contentRevision(contract);
}

export function candidatePermitsEffectChoice(candidate: PersistedLocalCandidate | undefined): boolean {
	return candidate !== undefined && permitsEffectChoice({ matcher: candidate.matcher, definition: candidate });
}

function candidateEffect(candidate: PersistedLocalCandidate, effect?: RuleEffect): DefinitionEffect | undefined {
	return candidatePermitsEffectChoice(candidate)
		? effect
		: actionEffect(declaredAction({ matcher: candidate.matcher, definition: candidate }));
}

export interface RuleStoreHealth {
	status: "ok" | "degraded";
	path: string;
	/** Present when one append-in-flight suffix was skipped. */
	incompleteFinalLine?: number;
	message?: string;
	line?: number;
	property?: string;
	repair?: string;
}

export interface RuleSnapshot extends RuleReduction {
	health: RuleStoreHealth;
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

function text(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	if (value.trim().length === 0 || value.length > maximum) {
		throw new Error(`${name} must be between 1 and ${maximum} characters`);
	}
	return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${name} must be one of ${values.join(", ")}`);
	}
	return value as T;
}

function validateRevision(value: unknown, name: string): string {
	const revision = text(value, name, 12);
	if (!REVISION.test(revision)) throw new Error(`${name} must be 12 lowercase hexadecimal characters`);
	return revision;
}

function eventId(value: unknown, name: string): string {
	const id = text(value, name, 64);
	if (!UUID.test(id)) throw new Error(`${name} must be a UUID`);
	return id;
}

export function validateRuleId(value: unknown): string {
	const id = text(value, "rule id", MAX_RULE_ID_LENGTH);
	if (!RULE_ID.test(id)) {
		throw new Error("rule id must start with a letter and contain lowercase letters, digits, dots, or hyphens");
	}
	return id;
}

function stringList(value: unknown, name: string, maximumLength = MAX_LIST_ENTRY_LENGTH): string[] {
	if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
		throw new Error(`${name} must be an array of at most ${MAX_LIST_ENTRIES} strings`);
	}
	return value.map((entry, index) => text(entry, `${name}[${index}]`, maximumLength));
}

function validateAudit(value: unknown): RuleAudit {
	if (!object(value)) throw new Error("audit must be an object");
	if (value.surface === "package") {
		exact(value, ["surface"]);
		return { surface: "package" };
	}
	exact(value, ["at", "session", "model", "surface"]);
	const at = text(value.at, "audit.at", MAX_AUDIT_FIELD_LENGTH);
	if (!ISO_8601.test(at) || Number.isNaN(Date.parse(at))) throw new Error("audit.at must be an ISO-8601 timestamp");
	const session = text(value.session, "audit.session", MAX_AUDIT_FIELD_LENGTH);
	const model = value.model === null ? null : text(value.model, "audit.model", MAX_AUDIT_FIELD_LENGTH);
	if (model !== null && (!model.includes("/") || model.startsWith("/") || model.endsWith("/"))) {
		throw new Error("audit.model must be provider/id or null");
	}
	return {
		at,
		session,
		model,
		surface: oneOf(value.surface, SESSION_SURFACES, "audit.surface"),
	};
}

function validateCommandShape(value: unknown): CommandShapeSpec {
	if (!object(value)) throw new Error("matcher.spec must be an object");
	exact(value, ["command"], ["flags", "absentFlags", "operands", "pipe"]);
	const spec: CommandShapeSpec = { command: text(value.command, "matcher.spec.command", MAX_COMMAND_LENGTH) };
	if (value.flags !== undefined) spec.flags = stringList(value.flags, "matcher.spec.flags");
	if (value.absentFlags !== undefined) spec.absentFlags = stringList(value.absentFlags, "matcher.spec.absentFlags");
	if (value.operands !== undefined) {
		if (!object(value.operands)) throw new Error("matcher.spec.operands must be an object");
		exact(value.operands, [], ["min", "max", "any", "at"]);
		const operands: NonNullable<CommandShapeSpec["operands"]> = {};
		for (const bound of ["min", "max"] as const) {
			const number = value.operands[bound];
			if (number !== undefined) {
				if (!Number.isSafeInteger(number) || (number as number) < 0 || (number as number) > 100_000) {
					throw new Error(`matcher.spec.operands.${bound} must be a non-negative integer`);
				}
				operands[bound] = number as number;
			}
		}
		if (operands.min !== undefined && operands.max !== undefined && operands.min > operands.max) {
			throw new Error("matcher.spec.operands.min must not exceed max");
		}
		if (value.operands.any !== undefined) operands.any = stringList(value.operands.any, "matcher.spec.operands.any");
		if (value.operands.at !== undefined) {
			if (!object(value.operands.at) || Object.keys(value.operands.at).length > MAX_LIST_ENTRIES) {
				throw new Error(`matcher.spec.operands.at must be an object with at most ${MAX_LIST_ENTRIES} indexes`);
			}
			operands.at = {};
			for (const [index, choices] of Object.entries(value.operands.at)) {
				if (!/^(0|[1-9][0-9]*)$/.test(index) || Number(index) > 100_000) {
					throw new Error("matcher.spec.operands.at keys must be non-negative integer indexes");
				}
				operands.at[index] = stringList(choices, `matcher.spec.operands.at.${index}`);
			}
		}
		spec.operands = operands;
	}
	if (value.pipe !== undefined) {
		if (!object(value.pipe)) throw new Error("matcher.spec.pipe must be an object");
		exact(value.pipe, [], ["from", "to", "fromRedirect", "toRedirect", "next", "later"]);
		const pipe: NonNullable<CommandShapeSpec["pipe"]> = {};
		for (const flag of ["from", "to", "fromRedirect", "toRedirect"] as const) {
			if (value.pipe[flag] !== undefined) {
				if (typeof value.pipe[flag] !== "boolean") throw new Error(`matcher.spec.pipe.${flag} must be boolean`);
				pipe[flag] = value.pipe[flag] as boolean;
			}
		}
		if (value.pipe.next !== undefined)
			pipe.next = stringList(value.pipe.next, "matcher.spec.pipe.next", MAX_COMMAND_LENGTH);
		if (value.pipe.later !== undefined)
			pipe.later = stringList(value.pipe.later, "matcher.spec.pipe.later", MAX_COMMAND_LENGTH);
		spec.pipe = pipe;
	}
	return spec;
}

function validateMatcher(value: unknown): RuleMatcher {
	if (!object(value)) throw new Error("matcher must be an object");
	const kind = oneOf(value.kind, ["code", "declarative"] as const, "matcher.kind");
	if (kind === "code") {
		exact(value, ["kind", "key"]);
		return { kind, key: validateRuleId(value.key) };
	}
	exact(value, ["kind", "language", "spec"]);
	if (value.language === "facts/v1") {
		const error = validateFactsProgram(value.spec);
		if (error) throw new Error(`matcher.spec: ${error}`);
		return { kind, language: "facts/v1", spec: structuredClone(value.spec) as FactsProgram };
	}
	if (value.language !== "command-shape/v1") throw new Error("matcher.language must be command-shape/v1 or facts/v1");
	return { kind, language: "command-shape/v1", spec: validateCommandShape(value.spec) };
}

function validateSuggestion(value: unknown): RuleSuggestion {
	if (!object(value)) throw new Error("suggestion must be an object");
	exact(value, ["command"], ["flags"]);
	const suggestion: RuleSuggestion = { command: text(value.command, "suggestion.command", MAX_COMMAND_LENGTH) };
	if (value.flags !== undefined) suggestion.flags = stringList(value.flags, "suggestion.flags");
	return suggestion;
}

function validateScope(value: unknown): RuleScope {
	if (!object(value)) throw new Error("scope must be an object");
	exact(value, [], ["modelProviders", "models", "cwdPrefixes"]);
	const scope: RuleScope = {};
	if (value.modelProviders !== undefined)
		scope.modelProviders = stringList(value.modelProviders, "scope.modelProviders");
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
		for (const prefix of scope.cwdPrefixes) {
			if (!isAbsolute(prefix)) throw new Error("scope.cwdPrefixes entries must be absolute paths");
		}
	}
	return scope;
}

function checkedApplicability(value: unknown, matcher: RuleMatcher): Condition {
	const error = validateApplicability(value, factsProgram({ matcher }));
	if (error) throw new Error(`applicability: ${error}`);
	return structuredClone(value) as Condition;
}

function validatePersistedCandidate(value: unknown): PersistedLocalCandidate {
	if (!object(value)) throw new Error("candidate must be an object");
	exact(value, ["purpose", "authority", "matcher", "note"], ["applicability", "suggestion", "scope"]);
	const candidate: PersistedLocalCandidate = {
		purpose: text(value.purpose, "candidate.purpose", MAX_PURPOSE_LENGTH),
		authority: oneOf(value.authority, ["exact", "steer-or-block"] as const, "candidate.authority"),
		matcher: validateMatcher(value.matcher),
		note: text(value.note, "candidate.note", MAX_NOTE_LENGTH),
	};
	if (value.applicability !== undefined)
		candidate.applicability = checkedApplicability(value.applicability, candidate.matcher);
	if (value.suggestion !== undefined) candidate.suggestion = validateSuggestion(value.suggestion);
	if (value.scope !== undefined) candidate.scope = validateScope(value.scope);
	if (candidate.authority === "steer-or-block" && !candidatePermitsEffectChoice(candidate))
		throw new Error("steer-or-block authority requires an input guide or deny action");
	if (
		candidate.suggestion &&
		actionEffect(declaredAction({ matcher: candidate.matcher, definition: candidate })) !== "steer" &&
		!candidatePermitsEffectChoice(candidate)
	)
		throw new Error("only guidance or steer-or-block actions accept a suggestion");
	const guidance = ruleGuidance({ definition: candidate });
	const guidanceBytes = Buffer.byteLength(guidance, "utf8");
	if (guidanceBytes > MAX_GUIDANCE_TEXT_BYTES) {
		throw new Error(
			`rendered guidance is ${guidanceBytes} UTF-8 bytes; shorten note or suggestion to at most ${MAX_GUIDANCE_TEXT_BYTES} bytes`,
		);
	}
	return candidate;
}

export function validateLocalCandidate(value: unknown): LocalRuleCandidate {
	if (!object(value)) throw new Error("candidate must be an object");
	exact(value, ["id", "purpose", "authority", "matcher", "note"], ["applicability", "suggestion", "scope"]);
	const id = validateRuleId(value.id);
	const candidate = validatePersistedCandidate({
		purpose: value.purpose,
		authority: value.authority,
		...(value.applicability !== undefined ? { applicability: value.applicability } : {}),
		matcher: value.matcher,
		note: value.note,
		...(value.suggestion !== undefined ? { suggestion: value.suggestion } : {}),
		...(value.scope !== undefined ? { scope: value.scope } : {}),
	});
	return { id, ...candidate };
}

export function validatePackageDefinitionRow(value: unknown): PackageDefinitionRow {
	if (!object(value)) throw new Error("catalog row must be an object");
	exact(
		value,
		["id", "purpose", "authority", "matcher", "effect", "note", "revision"],
		["applicability", "suggestion", "scope"],
	);
	const matcher = validateMatcher(value.matcher);
	const rowWithoutRevision = {
		id: validateRuleId(value.id),
		purpose: text(value.purpose, "catalog row purpose", MAX_PURPOSE_LENGTH),
		authority: oneOf(value.authority, ["exact", "steer-or-block"] as const, "catalog row authority"),
		matcher,
		...(value.applicability !== undefined ? { applicability: checkedApplicability(value.applicability, matcher) } : {}),
		effect: oneOf(value.effect, ["steer", "block", "correct", "observe"] as const, "catalog row effect"),
		note: text(value.note, "catalog row note", MAX_NOTE_LENGTH),
		...(value.suggestion !== undefined ? { suggestion: validateSuggestion(value.suggestion) } : {}),
		...(value.scope !== undefined ? { scope: validateScope(value.scope) } : {}),
	};
	const behavior = { matcher: rowWithoutRevision.matcher, definition: rowWithoutRevision };
	if (rowWithoutRevision.authority === "steer-or-block" && !permitsEffectChoice(behavior))
		throw new Error("steer-or-block authority requires an input guide or deny action");
	if (permitsEffectChoice(behavior)) oneOf(value.effect, EFFECTS, "catalog row effect");
	else if (value.effect !== actionEffect(declaredAction(behavior)))
		throw new Error("catalog row effect must match its declared action");
	if (
		rowWithoutRevision.suggestion &&
		actionEffect(declaredAction(behavior)) !== "steer" &&
		!permitsEffectChoice(behavior)
	)
		throw new Error("only guidance or steer-or-block actions accept a suggestion");
	const guidanceBytes = Buffer.byteLength(
		ruleGuidance({
			definition: {
				note: rowWithoutRevision.note,
				...(rowWithoutRevision.suggestion ? { suggestion: rowWithoutRevision.suggestion } : {}),
			},
		}),
		"utf8",
	);
	if (guidanceBytes > MAX_GUIDANCE_TEXT_BYTES) {
		throw new Error(`catalog row guidance exceeds ${MAX_GUIDANCE_TEXT_BYTES} UTF-8 bytes`);
	}
	const revision = text(value.revision, "catalog row revision", 12);
	if (!REVISION.test(revision)) throw new Error("catalog row revision must be 12 lowercase hexadecimal characters");
	if (revision !== packageRowRevision(rowWithoutRevision)) {
		throw new Error(`catalog row revision does not describe rule "${rowWithoutRevision.id}"`);
	}
	return { ...rowWithoutRevision, revision };
}

function boundedCatalogRows(value: unknown, name: string): PackageDefinitionRow[] {
	if (!Array.isArray(value) || value.length > MAX_CATALOG_ROWS) {
		throw new Error(`${name} must be an array of at most ${MAX_CATALOG_ROWS} catalog rows`);
	}
	return value.map((row) => validatePackageDefinitionRow(row));
}

export function validateRuleEvent(value: unknown): RuleEvent {
	if (!object(value)) throw new Error("event must be an object");
	const kind = oneOf(
		value.kind,
		["catalog", "import", "proposal", "decision", "override", "definition", "data"] as const,
		"event kind",
	);
	if (kind === "data") {
		const operation = oneOf(value.operation, ["set", "remove"] as const, "data operation");
		exact(value, ["kind", "id", "operation", "expectedRevision", "audit", operation === "set" ? "data" : "name"]);
		const audit = validateAudit(value.audit);
		if (audit.surface === "package") throw new Error("data audit must name a session surface");
		const id = eventId(value.id, "data.id");
		if (operation === "remove")
			return {
				kind,
				id,
				operation,
				name: validateRuleId(value.name),
				expectedRevision: validateRevision(value.expectedRevision, "expectedRevision"),
				audit,
			};
		const error = validateNamedData(value.data);
		if (error) throw new Error(`data: ${error}`);
		const data = structuredClone(value.data) as NamedData;
		validateRuleId(data.name);
		if (data.revision !== namedDataRevision(data))
			throw new Error("data revision does not describe its complete contract");
		return {
			kind,
			id,
			operation,
			data,
			expectedRevision:
				value.expectedRevision === null ? null : validateRevision(value.expectedRevision, "expectedRevision"),
			audit,
		};
	}
	if (kind === "catalog") {
		exact(value, ["kind", "rows", "audit"]);
		const audit = validateAudit(value.audit);
		if (audit.surface !== "package") throw new Error("catalog audit surface must be package");
		const rows = boundedCatalogRows(value.rows, "catalog.rows");
		if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("catalog row ids must be unique");
		return { kind, rows, audit };
	}
	if (kind === "import") {
		exact(value, ["kind", "id", "rows", "targets", "revision", "audit"]);
		const audit = validateAudit(value.audit);
		if (audit.surface === "package") throw new Error("import audit must name a session surface");
		const rows = boundedCatalogRows(value.rows, "import.rows");
		if (!rows.length || new Set(rows.map((row) => row.id)).size !== rows.length)
			throw new Error("import requires nonempty unique rows");
		if (!Array.isArray(value.targets) || value.targets.length !== rows.length)
			throw new Error("import targets must match selected rows");
		const targets = value.targets.map((target: unknown, index: number): CatalogImportTarget => {
			if (!object(target)) throw new Error("import target must be an object");
			exact(target, ["id", "identity"]);
			if (target.id !== rows[index].id) throw new Error("import target ids must match row order");
			return {
				id: rows[index].id,
				identity: target.identity === null ? null : validateRevision(target.identity, "target identity"),
			};
		});
		const revision = validateRevision(value.revision, "import revision");
		if (revision !== contentRevision({ rows, targets }))
			throw new Error("import revision does not describe its complete plan");
		return { kind, id: eventId(value.id, "import.id"), rows, targets, revision, audit };
	}
	if (kind === "proposal") {
		exact(value, ["kind", "id", "operation", "ruleId", "reason", "audit"], ["candidate", "expectedRevision"]);
		const audit = validateAudit(value.audit);
		if (audit.surface !== "agent-tool") throw new Error("proposal audit surface must be agent-tool");
		const operation = oneOf(value.operation, ["add", "replace", "retire", "disable"] as const, "proposal operation");
		const event: ProposalEvent = {
			kind,
			id: eventId(value.id, "proposal.id"),
			operation,
			ruleId: validateRuleId(value.ruleId),
			reason: text(value.reason, "reason", MAX_REASON_LENGTH),
			audit: audit as AgentRuleAudit,
		};
		if (operation === "add" || operation === "replace") event.candidate = validatePersistedCandidate(value.candidate);
		else if (value.candidate !== undefined) throw new Error(`${operation} proposal must not contain a candidate`);
		if (operation === "replace") event.expectedRevision = validateRevision(value.expectedRevision, "expectedRevision");
		else if (value.expectedRevision !== undefined)
			throw new Error(`${operation} proposal must not contain expectedRevision`);
		return event;
	}
	if (kind === "decision") {
		exact(value, ["kind", "id", "proposalId", "decision", "audit"], ["effect", "proposalRevision"]);
		const audit = validateAudit(value.audit);
		if (audit.surface === "package") throw new Error("decision audit must name a session surface");
		const event: DecisionEvent = {
			kind,
			id: eventId(value.id, "decision.id"),
			proposalId: eventId(value.proposalId, "decision.proposalId"),
			decision: oneOf(value.decision, ["approved", "rejected"] as const, "decision"),
			audit,
		};
		if (value.effect !== undefined) event.effect = oneOf(value.effect, EFFECTS, "effect");
		if (value.proposalRevision !== undefined)
			event.proposalRevision = validateRevision(value.proposalRevision, "proposalRevision");
		if (event.decision === "rejected" && (event.effect !== undefined || event.proposalRevision !== undefined))
			throw new Error("rejected decision must not contain an effect or proposal revision");
		return event;
	}
	if (kind === "override") {
		const operation = oneOf(value.operation, ["set", "clear"] as const, "override operation");
		const id = eventId(value.id, "override.id");
		const ruleId = validateRuleId(value.ruleId);
		if (operation === "set") {
			exact(value, ["kind", "id", "ruleId", "operation", "override"]);
			if (!object(value.override)) throw new Error("override set requires an override object");
			exact(value.override, ["reason", "audit", "againstDefinitionRevision"], ["state", "effect"]);
			const audit = validateAudit(value.override.audit);
			if (audit.surface === "package") throw new Error("override audit must name a session surface");
			const slot: OverrideEventSlot = {
				reason: text(value.override.reason, "override.reason", MAX_REASON_LENGTH),
				audit,
				againstDefinitionRevision: text(
					value.override.againstDefinitionRevision,
					"override.againstDefinitionRevision",
					12,
				),
			};
			if (!REVISION.test(slot.againstDefinitionRevision)) {
				throw new Error("override.againstDefinitionRevision must be 12 lowercase hexadecimal characters");
			}
			if (value.override.state !== undefined) {
				if (value.override.state !== "disabled") throw new Error("override.state must be disabled");
				slot.state = "disabled";
			}
			if (value.override.effect !== undefined) slot.effect = oneOf(value.override.effect, EFFECTS, "override.effect");
			if (slot.state === undefined && slot.effect === undefined)
				throw new Error("override set requires state or effect");
			return { kind, id, ruleId, operation, override: slot };
		}
		exact(value, ["kind", "id", "ruleId", "operation", "reason", "audit"]);
		const audit = validateAudit(value.audit);
		if (audit.surface === "package") throw new Error("override audit must name a session surface");
		return {
			kind,
			id,
			ruleId,
			operation,
			reason: text(value.reason, "reason", MAX_REASON_LENGTH),
			audit,
		};
	}
	exact(value, ["kind", "id", "ruleId", "state", "reason", "audit"]);
	const audit = validateAudit(value.audit);
	if (audit.surface === "package") throw new Error("definition audit must name a session surface");
	if (value.state !== "retired") throw new Error("definition state must be retired");
	return {
		kind,
		id: eventId(value.id, "definition.id"),
		ruleId: validateRuleId(value.ruleId),
		state: "retired",
		reason: text(value.reason, "reason", MAX_REASON_LENGTH),
		audit,
	};
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function isAgentSurface(audit: SessionRuleAudit): audit is AgentRuleAudit {
	return audit.surface === "agent-tool";
}

function operatorAudit(audit: SessionRuleAudit): OperatorRuleAudit {
	return audit as OperatorRuleAudit;
}

function refreshDerived(record: RuleRecord, available: (key: string) => boolean): RuleRecord {
	return {
		...record,
		matcherAvailable: record.matcher.kind === "declarative" ? true : available(record.matcher.key),
		staleOverride:
			record.override !== undefined && record.override.againstDefinitionRevision !== record.definition.revision,
	};
}

function packageRecord(
	row: PackageDefinitionRow,
	override: RuleRecord["override"],
	available: (key: string) => boolean,
): RuleRecord {
	return refreshDerived(
		{
			id: row.id,
			source: { kind: "package" },
			matcher: clone(row.matcher),
			definition: {
				purpose: row.purpose,
				authority: row.authority,
				...(row.applicability ? { applicability: clone(row.applicability) } : {}),
				revision: row.revision,
				state: "active",
				effect: row.effect,
				note: row.note,
				...(row.suggestion ? { suggestion: clone(row.suggestion) } : {}),
				...(row.scope ? { scope: clone(row.scope) } : {}),
			},
			...(override ? { override: clone(override) } : {}),
			matcherAvailable: false,
			staleOverride: false,
		},
		available,
	);
}

function orderedRecords(records: ReadonlyMap<string, RuleRecord>): Map<string, RuleRecord> {
	return new Map([...records].sort(([left], [right]) => left.localeCompare(right)));
}

function targetIdentity(record: RuleRecord | undefined): string | null {
	if (!record) return null;
	const { matcherAvailable: _available, staleOverride: _stale, ...identity } = record;
	return contentRevision(identity);
}

function importTargetsMatch(plan: CatalogImportPlan, records: ReadonlyMap<string, RuleRecord>): boolean {
	return plan.targets.every((target) => target.identity === targetIdentity(records.get(target.id)));
}

function importedRecords(
	plan: CatalogImportPlan,
	records: ReadonlyMap<string, RuleRecord>,
	available: (key: string) => boolean,
	source?: RuleRecord["source"],
): Map<string, RuleRecord> {
	const next = new Map(records);
	for (const row of plan.rows) {
		const record = packageRecord(row, records.get(row.id)?.override, available);
		if (source) record.source = clone(source);
		next.set(row.id, record);
	}
	if (next.size > MAX_RULES) throw new Error(`rule store exceeds ${MAX_RULES} rules`);
	assertActiveCapacity(next);
	return next;
}

function assertActiveCapacity(records: ReadonlyMap<string, RuleRecord>, additional = 0, excludedId?: string): void {
	let active = additional;
	for (const record of records.values()) {
		if (record.id !== excludedId && effectiveState(record) === "active") active++;
	}
	if (active > PROGRAM_LIMITS.rules) throw new Error(`active policy definitions exceed ${PROGRAM_LIMITS.rules}`);
}

/** Reduce valid events in file order into the single rule map. */
export function reduceRuleEvents(
	events: readonly RuleEvent[],
	available: (key: string) => boolean = hasCodeMatcher,
	eventLines?: readonly number[],
): RuleReduction {
	const records = new Map<string, RuleRecord>();
	const data = new Map<string, NamedData>();
	const pending = new Map<string, ProposalEvent>();
	const pendingByRule = new Map<string, string>();
	const recordLines = new Map<string, number>();
	const pendingLines = new Map<string, number>();
	for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
		const event = events[eventIndex];
		const eventLine = eventLines?.[eventIndex];
		try {
			if (event.kind === "data") {
				if (isAgentSurface(event.audit)) continue;
				const name = event.operation === "set" ? event.data.name : event.name;
				if ((data.get(name)?.revision ?? null) !== event.expectedRevision) continue;
				if (event.operation === "remove") data.delete(name);
				else {
					if (!data.has(name) && data.size >= MAX_NAMED_DATA)
						throw new Error(`data store exceeds ${MAX_NAMED_DATA} bindings`);
					data.set(name, clone(event.data));
				}
				continue;
			}
			if (event.kind === "catalog") {
				if (eventIndex !== 0) throw new Error("starter catalog must be the first event");
				for (const row of event.rows) {
					records.set(row.id, packageRecord(row, undefined, available));
					if (eventLine !== undefined) recordLines.set(row.id, eventLine);
				}
				continue;
			}
			if (event.kind === "import") {
				if (isAgentSurface(event.audit) || !importTargetsMatch(event, records)) continue;
				const selected = new Set(event.rows.map((row) => row.id));
				const count = records.size + event.rows.filter((row) => !records.has(row.id)).length;
				const active =
					[...records.values()].filter((record) => !selected.has(record.id) && effectiveState(record) === "active")
						.length + event.rows.filter((row) => records.get(row.id)?.override?.state !== "disabled").length;
				if (count > MAX_RULES || active > PROGRAM_LIMITS.rules) continue;
				const next = importedRecords(event, records, available, {
					kind: "import",
					importId: event.id,
					approvedAudit: clone(operatorAudit(event.audit)),
				});
				for (const row of event.rows) {
					records.set(row.id, next.get(row.id)!);
					if (eventLine !== undefined && !recordLines.has(row.id)) recordLines.set(row.id, eventLine);
				}
				continue;
			}
			if (event.kind === "proposal") {
				if (pendingByRule.has(event.ruleId)) continue;
				const existing = records.get(event.ruleId);
				if (event.operation === "add" && existing) continue;
				if (
					event.operation === "replace" &&
					(!existing ||
						existing.definition.revision !== event.expectedRevision ||
						existing.definition.state === "retired")
				)
					continue;
				if (event.operation === "retire" && !existing) continue;
				if (event.operation === "disable" && !existing) continue;
				pending.set(event.id, clone(event));
				pendingByRule.set(event.ruleId, event.id);
				if (eventLine !== undefined) pendingLines.set(event.id, eventLine);
				continue;
			}
			if (event.kind === "decision") {
				if (isAgentSurface(event.audit)) continue;
				const proposal = pending.get(event.proposalId);
				if (!proposal) continue;
				let decided = event.decision === "rejected";
				if (event.decision === "approved" && (proposal.operation === "add" || proposal.operation === "replace")) {
					const candidate = proposal.candidate;
					const existing = records.get(proposal.ruleId);
					const targetValid =
						proposal.operation === "add"
							? !existing
							: existing !== undefined &&
								existing.definition.state === "active" &&
								existing.definition.revision === proposal.expectedRevision;
					const exactApproval = !candidatePermitsEffectChoice(candidate) || proposal.operation === "replace";
					const approvalValid = !exactApproval || event.proposalRevision === proposalRevision(proposal);
					const effect = candidate && candidateEffect(candidate, event.effect);
					if (
						candidate &&
						effect &&
						targetValid &&
						approvalValid &&
						(candidatePermitsEffectChoice(candidate) || event.effect === undefined)
					) {
						const revision = ruleDefinitionRevision({ id: proposal.ruleId, ...candidate, effect });
						records.set(
							proposal.ruleId,
							refreshDerived(
								{
									id: proposal.ruleId,
									source: { kind: "local", proposalId: proposal.id, approvedAudit: clone(operatorAudit(event.audit)) },
									matcher: clone(candidate.matcher),
									definition: {
										purpose: candidate.purpose,
										authority: candidate.authority,
										...(candidate.applicability ? { applicability: clone(candidate.applicability) } : {}),
										revision,
										state: "active",
										effect,
										note: candidate.note,
										...(candidate.suggestion ? { suggestion: clone(candidate.suggestion) } : {}),
										...(candidate.scope ? { scope: clone(candidate.scope) } : {}),
									},
									...(existing?.override ? { override: clone(existing.override) } : {}),
									matcherAvailable: true,
									staleOverride: false,
								},
								available,
							),
						);
						if (eventLine !== undefined && !recordLines.has(proposal.ruleId))
							recordLines.set(proposal.ruleId, eventLine);
						decided = true;
					}
				} else if (event.decision === "approved" && proposal.operation === "retire") {
					const existing = records.get(proposal.ruleId);
					if (event.effect === undefined && existing) {
						records.set(
							proposal.ruleId,
							refreshDerived({ ...existing, definition: { ...existing.definition, state: "retired" } }, available),
						);
						decided = true;
					}
				} else if (event.decision === "approved" && proposal.operation === "disable") {
					const existing = records.get(proposal.ruleId);
					if (event.effect === undefined && existing) {
						records.set(
							proposal.ruleId,
							refreshDerived(
								{
									...existing,
									override: {
										state: "disabled",
										...(existing.override?.effect ? { effect: existing.override.effect } : {}),
										reason: proposal.reason,
										audit: clone(operatorAudit(event.audit)),
										againstDefinitionRevision: existing.definition.revision,
									},
								},
								available,
							),
						);
						decided = true;
					}
				}
				if (decided) {
					pending.delete(proposal.id);
					pendingByRule.delete(proposal.ruleId);
					pendingLines.delete(proposal.id);
				}
				continue;
			}
			if (event.kind === "override") {
				const audit = event.operation === "set" ? event.override.audit : event.audit;
				if (isAgentSurface(audit)) continue;
				const existing = records.get(event.ruleId);
				if (!existing) continue;
				if (event.operation === "clear") {
					const cleared = { ...existing };
					delete cleared.override;
					records.set(event.ruleId, refreshDerived(cleared, available));
				} else {
					records.set(
						event.ruleId,
						refreshDerived(
							{
								...existing,
								override: {
									...clone(event.override),
									audit: clone(operatorAudit(event.override.audit)),
								},
							},
							available,
						),
					);
				}
				continue;
			}
			if (isAgentSurface(event.audit)) continue;
			const existing = records.get(event.ruleId);
			if (!existing) continue;
			records.set(
				event.ruleId,
				refreshDerived({ ...existing, definition: { ...existing.definition, state: "retired" } }, available),
			);
		} catch (error) {
			if (eventLine === undefined) throw error;
			const reason = error instanceof Error ? error.message : String(error);
			throw new RuleLineError(eventLine, reason);
		}
	}
	if (records.size > MAX_RULES) {
		const line = [...recordLines.values()].sort((left, right) => left - right)[MAX_RULES];
		if (line !== undefined) throw new RuleLineError(line, `rule store exceeds ${MAX_RULES} rules`);
		throw new Error(`rule store exceeds ${MAX_RULES} rules`);
	}
	if (pending.size > MAX_PENDING_PROPOSALS) {
		const line = [...pendingLines.values()].sort((left, right) => left - right)[MAX_PENDING_PROPOSALS];
		if (line !== undefined)
			throw new RuleLineError(line, `rule store exceeds ${MAX_PENDING_PROPOSALS} pending proposals`);
		throw new Error(`rule store exceeds ${MAX_PENDING_PROPOSALS} pending proposals`);
	}
	assertActiveCapacity(records);
	return {
		data,
		records: orderedRecords(records),
		pending: [...pending.values()].sort(
			(left, right) => left.ruleId.localeCompare(right.ruleId) || left.id.localeCompare(right.id),
		),
	};
}

class RuleLineError extends Error {
	readonly line: number;

	constructor(line: number, message: string) {
		super(message);
		this.line = line;
	}
}

class RuleFileError extends Error {
	readonly property: string;
	readonly repairAction: string;

	constructor(property: string, message: string, repairAction: string) {
		super(message);
		this.property = property;
		this.repairAction = repairAction;
	}
}

function privateFile(info: Awaited<ReturnType<typeof lstat>>, path: string): void {
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new RuleFileError(
			"file type",
			`policy rule store is not a regular non-symlink file: ${path}`,
			`replace ${path} with a regular non-symlink file`,
		);
	}
	if ((Number(info.mode) & 0o077) !== 0) {
		throw new RuleFileError("file mode", `policy rule store mode is not private: ${path}`, `set ${path} mode to 0600`);
	}
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
		throw new RuleFileError(
			"file ownership",
			`policy rule store is not owned by this user: ${path}`,
			`make ${path} owned by the current user`,
		);
	}
}

async function checkExistingDirectory(dir: string): Promise<void> {
	try {
		const info = await lstat(dir);
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new RuleFileError(
				"directory type",
				`policy store is not a regular non-symlink directory: ${dir}`,
				`replace ${dir} with a regular non-symlink directory`,
			);
		}
		if ((info.mode & 0o077) !== 0) {
			throw new RuleFileError("directory mode", `policy store mode is not private: ${dir}`, `set ${dir} mode to 0700`);
		}
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
			throw new RuleFileError(
				"directory ownership",
				`policy store is not owned by this user: ${dir}`,
				`make ${dir} owned by the current user`,
			);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		if (error instanceof RuleFileError) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		throw new RuleFileError(
			"directory access",
			`policy store directory cannot be inspected: ${dir}: ${reason}`,
			`restore current-user access to ${dir}`,
		);
	}
}

interface ReadEventsResult {
	events: RuleEvent[];
	eventLines: number[];
	incompleteFinalLine?: number;
}

async function readEvents(dir: string, path: string): Promise<ReadEventsResult> {
	await checkExistingDirectory(dir);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		handle = await open(path, constants.O_RDONLY | noFollow);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], eventLines: [] };
		const reason = error instanceof Error ? error.message : String(error);
		throw new RuleFileError(
			"file access",
			`policy rule store cannot be opened: ${path}: ${reason}`,
			`restore current-user read access to ${path}`,
		);
	}
	try {
		const info = await handle.stat();
		privateFile(info, path);
		if (info.size > MAX_REGISTRY_BYTES) {
			throw new RuleFileError(
				"file size",
				`policy rule store exceeds ${MAX_REGISTRY_BYTES} bytes: ${path}`,
				`remove complete JSONL event lines from ${path} until it is at most ${MAX_REGISTRY_BYTES} bytes`,
			);
		}
		const buffer = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < buffer.length) {
			const result = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		const content = buffer.subarray(0, offset);
		const events: RuleEvent[] = [];
		const eventLines: number[] = [];
		let start = 0;
		let lineNumber = 0;
		for (let index = 0; index < content.length; index++) {
			if (content[index] !== 0x0a) continue;
			lineNumber++;
			const line = content.subarray(start, index);
			start = index + 1;
			if (line.length === 0) throw new RuleLineError(lineNumber, "line is empty");
			if (line.length + 1 > MAX_CATALOG_EVENT_BYTES) {
				throw new RuleLineError(lineNumber, `line exceeds ${MAX_CATALOG_EVENT_BYTES} bytes`);
			}
			try {
				const event = validateRuleEvent(JSON.parse(UTF8.decode(line)) as unknown);
				if (event.kind !== "catalog" && event.kind !== "import" && line.length + 1 > MAX_RULE_EVENT_BYTES)
					throw new Error(`line exceeds ${MAX_RULE_EVENT_BYTES} bytes`);
				events.push(event);
				eventLines.push(lineNumber);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new RuleLineError(lineNumber, reason);
			}
		}
		return start < content.length
			? { events, eventLines, incompleteFinalLine: lineNumber + 1 }
			: { events, eventLines };
	} finally {
		await handle.close();
	}
}

function eventSurface(event: Exclude<RuleEvent, CatalogEvent | ProposalEvent>): AuditSurface {
	return event.kind === "override" && event.operation === "set" ? event.override.audit.surface : event.audit.surface;
}

function assertWritableAuthority(event: RuleEvent): void {
	if (event.kind === "catalog") throw new Error("starter catalogs require exclusive initialization");
	if (event.kind === "proposal") {
		if (event.audit.surface !== "agent-tool") throw new Error("proposals may only be written by policy_propose");
		return;
	}
	if (eventSurface(event) === "agent-tool") {
		throw new Error(`${event.kind} events require an operator surface`);
	}
}

function assertTransition(event: Exclude<RuleEvent, CatalogEvent>, reduction: RuleReduction): void {
	if (event.kind === "import") {
		if (!importTargetsMatch(event, reduction.records))
			throw new Error("import target identity changed; inspect a fresh import plan");
		importedRecords(event, reduction.records, hasCodeMatcher);
		return;
	}
	if (event.kind === "data") {
		const name = event.operation === "set" ? event.data.name : event.name;
		const current = reduction.data.get(name);
		if ((current?.revision ?? null) !== event.expectedRevision)
			throw new Error(`data "${name}" revision changed; inspect the current binding`);
		if (event.operation === "set" && !current && reduction.data.size >= MAX_NAMED_DATA)
			throw new Error(`data store already contains ${MAX_NAMED_DATA} bindings`);
		return;
	}
	if (event.kind === "proposal") {
		if (reduction.pending.some((proposal) => proposal.ruleId === event.ruleId)) {
			throw new Error(`a proposal is already pending for "${event.ruleId}"`);
		}
		const existing = reduction.records.get(event.ruleId);
		if (event.operation === "add") {
			if (existing) throw new Error(`rule id "${event.ruleId}" is already taken`);
			if (reduction.records.size >= MAX_RULES) throw new Error(`rule store already contains ${MAX_RULES} rules`);
		} else if (event.operation === "replace") {
			if (!existing) throw new Error(`no rule named "${event.ruleId}" exists`);
			if (existing.definition.state === "retired") throw new Error(`rule "${event.ruleId}" is retired`);
			if (existing.definition.revision !== event.expectedRevision)
				throw new Error(`replacement target "${event.ruleId}" revision changed`);
		} else if (event.operation === "retire") {
			if (!existing) throw new Error(`no rule named "${event.ruleId}" exists`);
			if (effectiveState(existing) === "retired") throw new Error(`rule "${event.ruleId}" is already retired`);
		} else if (!existing) throw new Error(`no rule named "${event.ruleId}" exists`);
		if (reduction.pending.length >= MAX_PENDING_PROPOSALS) {
			throw new Error(`rule store already contains ${MAX_PENDING_PROPOSALS} pending proposals`);
		}
		return;
	}
	if (event.kind === "decision") {
		const proposal = reduction.pending.find((entry) => entry.id === event.proposalId);
		if (!proposal) throw new Error(`no pending proposal with id "${event.proposalId}"`);
		if (event.decision === "approved" && proposal.operation !== "add") {
			const target = reduction.records.get(proposal.ruleId);
			if (target && effectiveState(target) === "retired") {
				throw new Error(`cannot approve ${proposal.operation} proposal: target "${proposal.ruleId}" is retired`);
			}
		}
		if (event.decision === "approved" && (proposal.operation === "add" || proposal.operation === "replace")) {
			const choice = candidatePermitsEffectChoice(proposal.candidate);
			if (!choice && event.effect !== undefined)
				throw new Error("exact approval uses the exact proposed action, not steer or block");
			if (choice && !event.effect)
				throw new Error("approving a steer-or-block proposal requires effect steer or block");
			if ((!choice || proposal.operation === "replace") && event.proposalRevision !== proposalRevision(proposal))
				throw new Error("approval requires the current exact proposal revision");
			if (event.proposalRevision !== undefined && event.proposalRevision !== proposalRevision(proposal))
				throw new Error("proposal revision changed");
			assertActiveCapacity(
				reduction.records,
				reduction.records.get(proposal.ruleId)?.override?.state === "disabled" ? 0 : 1,
				proposal.ruleId,
			);
			if (proposal.operation === "add" && reduction.records.has(proposal.ruleId))
				throw new Error(`rule id "${proposal.ruleId}" is already taken`);
			if (proposal.operation === "replace") {
				const current = reduction.records.get(proposal.ruleId);
				if (!current || current.definition.revision !== proposal.expectedRevision)
					throw new Error("replacement target revision changed");
			}
		} else if (event.effect !== undefined || event.proposalRevision !== undefined) {
			throw new Error(
				`${event.decision === "approved" ? `approving a ${proposal.operation} proposal` : "rejecting a proposal"} does not accept an effect or proposal revision`,
			);
		}
		return;
	}
	const existing = reduction.records.get(event.ruleId);
	if (!existing) throw new Error(`no rule named "${event.ruleId}" exists`);
	if (event.kind === "override") {
		if (existing.definition.state === "active") {
			assertActiveCapacity(
				reduction.records,
				event.operation === "set" && event.override.state === "disabled" ? 0 : 1,
				existing.id,
			);
		}
		if (event.operation === "clear" && !existing.override)
			throw new Error(`rule "${event.ruleId}" has no override to clear`);
		if (event.operation === "set" && event.override.againstDefinitionRevision !== existing.definition.revision) {
			throw new Error(`override for "${event.ruleId}" must target its current definition revision`);
		}
		if (
			event.operation === "set" &&
			!permitsEffectChoice(existing) &&
			event.override.effect !== undefined &&
			event.override.effect !== existing.override?.effect
		)
			throw new Error("this action requires an exact replacement proposal; steer/block overrides do not change it");
		return;
	}
	if (existing.definition.state === "retired") throw new Error(`rule "${event.ruleId}" is already retired`);
}

export interface RuleRegistryOptions {
	catalog?: readonly PackageDefinitionRow[];
	matcherAvailable?: (key: string) => boolean;
	onNotice?: (message: string) => void;
}

export class RuleRegistry {
	readonly path: string;
	private readonly dir: string;
	private readonly catalog: PackageDefinitionRow[];
	private readonly matcherAvailable: (key: string) => boolean;
	private readonly onNotice: (message: string) => void;
	private firstUse: Promise<void> | undefined;
	private mutationTail: Promise<void> = Promise.resolve();
	private degradedHealth: RuleStoreHealth | undefined;
	private incompleteReported = false;

	constructor(dir: string, options: RuleRegistryOptions = {}) {
		this.dir = dir;
		this.path = join(dir, RULES_FILE);
		this.catalog = boundedCatalogRows([...(options.catalog ?? PACKAGE_CATALOG)], "installed package catalog");
		const catalogBytes = Buffer.byteLength(
			`${JSON.stringify({ kind: "catalog", rows: this.catalog, audit: { surface: "package" } })}\n`,
			"utf8",
		);
		if (catalogBytes > MAX_CATALOG_EVENT_BYTES)
			throw new Error(`installed package catalog exceeds ${MAX_CATALOG_EVENT_BYTES} bytes`);
		if (new Set(this.catalog.map((row) => row.id)).size !== this.catalog.length) {
			throw new Error("installed package catalog contains duplicate rule ids");
		}
		this.matcherAvailable = options.matcherAvailable ?? hasCodeMatcher;
		this.onNotice = options.onNotice ?? ((message) => console.warn(message));
		assertActiveCapacity(
			new Map(this.catalog.map((row) => [row.id, packageRecord(row, undefined, this.matcherAvailable)])),
		);
	}

	private notice(message: string): void {
		try {
			this.onNotice(message);
		} catch {
			// A reporting channel cannot change rule authority or matching.
		}
	}

	private degrade(error: unknown): void {
		if (this.degradedHealth) return;
		const reason = error instanceof Error ? error.message : String(error);
		const line = error instanceof RuleLineError ? error.line : undefined;
		const property = line === undefined ? (error instanceof RuleFileError ? error.property : "file access") : undefined;
		const location = line !== undefined ? `line ${line}` : `failing property "${property}"`;
		const repair =
			line !== undefined
				? `Repair ${this.path}: the file is append-only JSONL with one event per line; edit or remove line ${line}, then start a new policy session.`
				: `Repair ${this.path}: ${error instanceof RuleFileError ? error.repairAction : `restore current-user access to ${this.path}`}, then start a new policy session.`;
		const message =
			`Policy rule store unreadable: ${this.path}, ${location}: ${reason}. ${repair} ` +
			"No rules are active; mechanisms are capped at notice and rule writes are refused.";
		this.degradedHealth = {
			status: "degraded",
			path: this.path,
			...(line !== undefined ? { line } : {}),
			...(property !== undefined ? { property } : {}),
			message,
			repair,
		};
		this.notice(message);
	}

	private reportIncomplete(line: number): string {
		const message =
			`Policy rule store append in flight: skipped incomplete final line ${line} in ${this.path}; ` +
			"every complete line remains active, and rule writes are refused until the append completes or the suffix is repaired.";
		if (!this.incompleteReported) {
			this.incompleteReported = true;
			this.notice(message);
		}
		return message;
	}

	private async readReduction(): Promise<{ reduction: RuleReduction; incompleteFinalLine?: number }> {
		const read = await readEvents(this.dir, this.path);
		return {
			reduction: reduceRuleEvents(read.events, this.matcherAvailable, read.eventLines),
			...(read.incompleteFinalLine ? { incompleteFinalLine: read.incompleteFinalLine } : {}),
		};
	}

	private async append(eventValue: Exclude<RuleEvent, CatalogEvent>): Promise<void> {
		const event = validateRuleEvent(eventValue);
		assertWritableAuthority(event);
		const serialized = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
		const maximum = event.kind === "import" ? MAX_CATALOG_EVENT_BYTES : MAX_RULE_EVENT_BYTES;
		if (serialized.length > maximum) throw new Error(`policy rule event exceeds ${maximum} bytes`);
		await ensurePrivateDirectory(this.dir);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const handle = await open(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600);
		try {
			const info = await handle.stat();
			privateFile(info, this.path);
			await handle.chmod(0o600);
			if (info.size + serialized.length > MAX_REGISTRY_BYTES) {
				throw new Error(`policy rule store would exceed ${MAX_REGISTRY_BYTES} bytes`);
			}
			const result = await handle.write(serialized, 0, serialized.length, null);
			if (result.bytesWritten !== serialized.length) {
				throw new Error(`policy rule event write stopped at ${result.bytesWritten} of ${serialized.length} bytes`);
			}
		} finally {
			await handle.close();
		}
	}

	/** Serialize reload, validation, and append across instances and processes. */
	private async transaction<T>(action: () => Promise<T>): Promise<T> {
		await checkExistingDirectory(this.dir);
		await ensurePrivateDirectory(this.dir);
		const path = join(this.dir, RULES_LOCK_FILE);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
			try {
				handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					privateFile(await lstat(path), path);
				} catch (inspection) {
					if ((inspection as NodeJS.ErrnoException).code !== "ENOENT") throw inspection;
				}
				if (attempt + 1 < LOCK_ATTEMPTS) await delay(LOCK_RETRY_MS);
			}
		}
		if (!handle) {
			throw new RuleFileError(
				"transaction lock",
				`policy rule transaction conflict: lock remains held at ${path}`,
				`retry after the other writer completes; if its process stopped, remove ${path} only after all policy writers stop`,
			);
		}
		try {
			const owned = await handle.stat();
			privateFile(owned, path);
			const release = async (): Promise<void> => {
				const current = await lstat(path);
				if (current.dev !== owned.dev || current.ino !== owned.ino || current.isSymbolicLink())
					throw new Error(`policy rule transaction lock changed; refusing to remove ${path}`);
				await unlink(path);
			};
			try {
				return await action();
			} finally {
				await release();
			}
		} finally {
			await handle.close();
		}
	}

	private async seedAbsentStore(): Promise<void> {
		let staged: string | undefined;
		try {
			await checkExistingDirectory(this.dir);
			try {
				await lstat(this.path);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await ensurePrivateDirectory(this.dir);
			const path = join(this.dir, `.rules-seed-${randomUUID()}`);
			const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			staged = path;
			try {
				const event: CatalogEvent = { kind: "catalog", rows: this.catalogRows(), audit: { surface: "package" } };
				const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
				const result = await handle.write(bytes, 0, bytes.length, null);
				if (result.bytesWritten !== bytes.length) throw new Error("starter catalog write was incomplete");
				await handle.sync();
			} finally {
				await handle.close();
			}
			try {
				// A hard link publishes complete bytes without replacing an existing store.
				await link(path, this.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		} catch (error) {
			this.degrade(error);
		} finally {
			if (staged) {
				try {
					await unlink(staged);
				} catch (error) {
					this.degrade(error);
				}
			}
		}
	}

	private ensureFirstUse(): Promise<void> {
		this.firstUse ??= this.transaction(() => this.seedAbsentStore()).catch((error: unknown) => this.degrade(error));
		return this.firstUse;
	}

	async snapshot(): Promise<RuleSnapshot> {
		await this.ensureFirstUse();
		if (this.degradedHealth)
			return { records: new Map(), pending: [], data: new Map(), health: clone(this.degradedHealth) };
		try {
			const read = await this.readReduction();
			const reduction = read.reduction;
			const health: RuleStoreHealth = { status: "ok", path: this.path };
			if (read.incompleteFinalLine) {
				health.incompleteFinalLine = read.incompleteFinalLine;
				health.message = this.reportIncomplete(read.incompleteFinalLine);
			}
			return { ...reduction, health };
		} catch (error) {
			this.degrade(error);
			return { records: new Map(), pending: [], data: new Map(), health: clone(this.degradedHealth!) };
		}
	}

	private async mutate<T>(
		build: (reduction: RuleReduction) => { event: Exclude<RuleEvent, CatalogEvent>; result: T },
	): Promise<T> {
		await this.ensureFirstUse();
		const action = async (): Promise<T> => {
			if (this.degradedHealth) throw new Error(this.degradedHealth.message);
			let read: Awaited<ReturnType<RuleRegistry["readReduction"]>>;
			try {
				read = await this.readReduction();
			} catch (error) {
				this.degrade(error);
				throw new Error(this.degradedHealth!.message);
			}
			if (read.incompleteFinalLine) throw new Error(this.reportIncomplete(read.incompleteFinalLine));
			const reduction = read.reduction;
			const built = build(reduction);
			const event = validateRuleEvent(built.event) as Exclude<RuleEvent, CatalogEvent>;
			assertWritableAuthority(event);
			if (event.kind === "import") {
				for (const row of event.rows) {
					if (this.catalog.find((installed) => installed.id === row.id)?.revision !== row.revision)
						throw new Error(`import source "${row.id}" changed or is not in the bundled catalog`);
				}
			}
			if (
				event.kind === "proposal" &&
				event.candidate?.matcher.kind === "code" &&
				!this.matcherAvailable(event.candidate.matcher.key)
			)
				throw new Error(`installed predicate "${event.candidate.matcher.key}" is unavailable`);
			assertTransition(event, reduction);
			await this.append(event);
			if (event.kind === "import") {
				const committed = await this.readReduction();
				if (
					!event.rows.every((row) => {
						const source = committed.reduction.records.get(row.id)?.source;
						return source?.kind === "import" && source.importId === event.id;
					})
				)
					throw new Error("import conflict: selected targets changed; inspect the current rules");
			}
			return built.result;
		};
		const running = this.mutationTail.then(() => this.transaction(action));
		this.mutationTail = running.then(
			() => undefined,
			() => undefined,
		);
		return running;
	}

	catalogRows(id?: string): PackageDefinitionRow[] {
		const rows = this.catalog.filter((row) => id === undefined || row.id === id);
		if (id !== undefined && rows.length === 0) throw new Error(`no bundled catalog rule named "${id}"`);
		return rows.map(clone).sort((left, right) => left.id.localeCompare(right.id));
	}

	private buildImport(selection: string, records: ReadonlyMap<string, RuleRecord>): CatalogImportPlan {
		const rows = this.catalogRows(selection === "--all" ? undefined : validateRuleId(selection));
		if (!rows.length) throw new Error("bundled catalog selection is empty");
		const targets = rows.map((row) => ({ id: row.id, identity: targetIdentity(records.get(row.id)) }));
		return { rows, targets, revision: contentRevision({ rows, targets }) };
	}

	async planImport(selection: string): Promise<CatalogImportPreview> {
		const snapshot = await this.snapshot();
		if (snapshot.health.status === "degraded") throw new Error(snapshot.health.message);
		if (snapshot.health.incompleteFinalLine) throw new Error(snapshot.health.message);
		const plan = this.buildImport(selection, snapshot.records);
		const next = importedRecords(plan, snapshot.records, this.matcherAvailable);
		return {
			...plan,
			current: plan.rows.map((row) => clone(snapshot.records.get(row.id) ?? null)),
			resulting: plan.rows.map((row) => ({
				id: row.id,
				state: effectiveState(next.get(row.id)!),
				effect: effectiveEffect(next.get(row.id)!),
			})),
		};
	}

	importCatalog(selection: string, expectedRevision: string, audit: SessionRuleAudit): Promise<CatalogImportEvent> {
		return this.mutate((reduction) => {
			const plan = this.buildImport(selection, reduction.records);
			if (plan.revision !== expectedRevision) throw new Error("import revision changed; inspect a fresh import plan");
			const event: CatalogImportEvent = { kind: "import", id: randomUUID(), ...plan, audit };
			return { event, result: event };
		});
	}

	/** Strict public event writer used by sanctioned command, panel, and tool surfaces. */
	writeEvent(event: Exclude<RuleEvent, CatalogEvent>): Promise<RuleEvent> {
		return this.mutate(() => ({ event, result: event }));
	}

	proposeAdd(candidateValue: LocalRuleCandidate, reason: string, audit: AgentRuleAudit): Promise<ProposalEvent> {
		const candidate = validateLocalCandidate(candidateValue);
		const event: ProposalEvent = {
			kind: "proposal",
			id: randomUUID(),
			operation: "add",
			ruleId: candidate.id,
			reason,
			candidate: {
				purpose: candidate.purpose,
				authority: candidate.authority,
				...(candidate.applicability ? { applicability: candidate.applicability } : {}),
				matcher: candidate.matcher,
				note: candidate.note,
				...(candidate.suggestion ? { suggestion: candidate.suggestion } : {}),
				...(candidate.scope ? { scope: candidate.scope } : {}),
			},
			audit,
		};
		return this.mutate(() => ({ event, result: event }));
	}

	proposeReplace(
		candidateValue: LocalRuleCandidate,
		expectedRevision: string,
		reason: string,
		audit: AgentRuleAudit,
	): Promise<ProposalEvent> {
		const { id: ruleId, ...candidate } = validateLocalCandidate(candidateValue);
		const event: ProposalEvent = {
			kind: "proposal",
			id: randomUUID(),
			operation: "replace",
			ruleId,
			candidate,
			expectedRevision,
			reason,
			audit,
		};
		return this.mutate(() => ({ event, result: event }));
	}

	setData(data: NamedData, expectedRevision: string | null, audit: SessionRuleAudit): Promise<DataSetEvent> {
		const event: DataSetEvent = { kind: "data", id: randomUUID(), operation: "set", data, expectedRevision, audit };
		return this.mutate(() => ({ event, result: event }));
	}

	removeData(name: string, expectedRevision: string, audit: SessionRuleAudit): Promise<DataRemoveEvent> {
		const event: DataRemoveEvent = {
			kind: "data",
			id: randomUUID(),
			operation: "remove",
			name,
			expectedRevision,
			audit,
		};
		return this.mutate(() => ({ event, result: event }));
	}

	proposeRetire(ruleId: string, reason: string, audit: AgentRuleAudit): Promise<ProposalEvent> {
		const event: ProposalEvent = { kind: "proposal", id: randomUUID(), operation: "retire", ruleId, reason, audit };
		return this.mutate(() => ({ event, result: event }));
	}

	proposeDisable(ruleId: string, reason: string, audit: AgentRuleAudit): Promise<ProposalEvent> {
		const event: ProposalEvent = { kind: "proposal", id: randomUUID(), operation: "disable", ruleId, reason, audit };
		return this.mutate(() => ({ event, result: event }));
	}

	decide(
		proposalId: string,
		decision: "approved" | "rejected",
		effect: RuleEffect | undefined,
		audit: SessionRuleAudit,
		expectedProposalRevision?: string,
	): Promise<DecisionEvent> {
		const event: DecisionEvent = { kind: "decision", id: randomUUID(), proposalId, decision, audit };
		if (effect !== undefined) event.effect = effect;
		if (expectedProposalRevision !== undefined) event.proposalRevision = expectedProposalRevision;
		return this.mutate(() => ({ event, result: event }));
	}

	disable(ruleId: string, reason: string, audit: SessionRuleAudit): Promise<OverrideEvent> {
		return this.mutate((reduction) => {
			const existing = reduction.records.get(ruleId);
			const event: SetOverrideEvent = {
				kind: "override",
				id: randomUUID(),
				ruleId,
				operation: "set",
				override: {
					state: "disabled",
					...(existing?.override?.effect ? { effect: existing.override.effect } : {}),
					reason,
					audit,
					againstDefinitionRevision: existing?.definition.revision ?? "000000000000",
				},
			};
			return { event, result: event };
		});
	}

	enable(ruleId: string, reason: string, audit: SessionRuleAudit): Promise<OverrideEvent> {
		return this.mutate((reduction) => {
			const existing = reduction.records.get(ruleId);
			const event: OverrideEvent = existing?.override?.effect
				? {
						kind: "override",
						id: randomUUID(),
						ruleId,
						operation: "set",
						override: {
							effect: existing.override.effect,
							reason,
							audit,
							againstDefinitionRevision: existing.definition.revision,
						},
					}
				: {
						kind: "override",
						id: randomUUID(),
						ruleId,
						operation: "clear",
						reason,
						audit,
					};
			return { event, result: event };
		});
	}

	setEffect(ruleId: string, effect: RuleEffect, reason: string, audit: SessionRuleAudit): Promise<OverrideEvent> {
		return this.mutate((reduction) => {
			const existing = reduction.records.get(ruleId);
			if (existing && !permitsEffectChoice(existing))
				throw new Error("this action requires an exact replacement proposal; steer/block overrides do not change it");
			const event: SetOverrideEvent = {
				kind: "override",
				id: randomUUID(),
				ruleId,
				operation: "set",
				override: {
					...(existing?.override?.state ? { state: existing.override.state } : {}),
					effect,
					reason,
					audit,
					againstDefinitionRevision: existing?.definition.revision ?? "000000000000",
				},
			};
			return { event, result: event };
		});
	}

	retire(ruleId: string, reason: string, audit: SessionRuleAudit): Promise<DefinitionEvent> {
		const event: DefinitionEvent = {
			kind: "definition",
			id: randomUUID(),
			ruleId,
			state: "retired",
			reason,
			audit,
		};
		return this.mutate(() => ({ event, result: event }));
	}
}

export function makeRuleAudit<TSurface extends Exclude<AuditSurface, "package">>(
	ctx: AuditContextLike,
	surface: TSurface,
	now: Date = new Date(),
): SessionRuleAudit & { surface: TSurface } {
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
	const audit = validateAudit({
		at: now.toISOString(),
		session: ctx.sessionManager.getSessionId(),
		model,
		surface,
	});
	if (audit.surface === "package") throw new Error("session audit cannot use package surface");
	return audit as SessionRuleAudit & { surface: TSurface };
}

export function ruleStoreHealthLine(health: RuleStoreHealth): string {
	if (health.status === "degraded") return `registry health: degraded=true | ${health.message}`;
	const conditions: string[] = [];
	if (health.incompleteFinalLine !== undefined && health.message) conditions.push(health.message);
	return `registry health: degraded=false | ${conditions.length > 0 ? conditions.join(" | ") : "ok"}`;
}
