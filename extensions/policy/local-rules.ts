/** Unified append-only rule store, strict event validation, and reduction. */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	contentRevision,
	effectiveState,
	FACTS_DOMAIN,
	packageRowRevision,
	POLICY_DOMAIN,
	ruleDefinitionRevision,
	ruleGuidance,
	type AgentRuleAudit,
	type AuditSurface,
	type CommandShapeSpec,
	type DefinitionEffect,
	type OperatorRuleAudit,
	type PackageDefinitionRow,
	type PackageRuleAudit,
	type PolicyDomain,
	type RuleAudit,
	type RuleEffect,
	type RuleMatcher,
	type RuleOverride,
	type RuleRecord,
	type RuleScope,
	type RuleSuggestion,
	type SessionRuleAudit,
} from "./rule.ts";
import { hasCodeMatcher, PACKAGE_CATALOG } from "./shell-rules.ts";
import { PROGRAM_LIMITS, RULE_CAPACITY, validateFactsProgram, type FactsProgram } from "./program.ts";
import { validateNamedData, type NamedData } from "./data.ts";
import { ensurePrivateDirectory } from "./store.ts";

export const RULES_FILE = "rules.jsonl";
export const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
export const MAX_RULE_EVENT_BYTES = 64 * 1024;
export const MAX_CATALOG_EVENT_BYTES = 512 * 1024;
export const MAX_LOCAL_RULES = RULE_CAPACITY.local;
export const MAX_PENDING_PROPOSALS = 256;
export const MAX_RULE_ID_LENGTH = 80;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_GUIDANCE_TEXT_BYTES = 400;
export const MAX_REASON_LENGTH = 1000;
export const MAX_COMMAND_LENGTH = 200;
export const MAX_LIST_ENTRIES = 64;
export const MAX_LIST_ENTRY_LENGTH = 200;
export const MAX_CWD_PREFIX_LENGTH = 500;
export const MAX_AUDIT_FIELD_LENGTH = 500;
export const MAX_CATALOG_ROWS = RULE_CAPACITY.package;

const RULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^[0-9a-f]{12}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EFFECTS = ["steer", "block"] as const;
const SESSION_SURFACES = ["agent-tool", "command", "panel"] as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface LocalRuleCandidate {
	id: string;
	domain: PolicyDomain;
	matcher: Extract<RuleMatcher, { kind: "declarative" }>;
	note: string;
	suggestion?: RuleSuggestion;
	scope?: RuleScope;
}

export interface PersistedLocalCandidate {
	domain: PolicyDomain;
	matcher: Extract<RuleMatcher, { kind: "declarative" }>;
	note: string;
	suggestion?: RuleSuggestion;
	scope?: RuleScope;
}

export type ProposalOperation = "add" | "replace" | "retire" | "disable";

export interface CatalogEvent {
	kind: "catalog";
	/** Complete installed package definition set. */
	rows: PackageDefinitionRow[];
	audit: PackageRuleAudit;
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
	/** Facts approvals bind the exact inert proposal, including action parameters. */
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
export type RuleEvent = CatalogEvent | ProposalEvent | DecisionEvent | OverrideEvent | DefinitionEvent | DataEvent;
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

function factsCandidate(candidate: PersistedLocalCandidate | undefined): candidate is PersistedLocalCandidate & {
	matcher: { kind: "declarative"; language: "facts/v1"; spec: FactsProgram };
} {
	return candidate?.matcher.language === "facts/v1";
}

function candidateEffect(candidate: PersistedLocalCandidate, effect?: RuleEffect): DefinitionEffect | undefined {
	if (!factsCandidate(candidate)) return effect;
	switch (candidate.matcher.spec.action.kind) {
		case "deny":
			return "block";
		case "guide":
			return "steer";
		case "observe":
			return "observe";
		default:
			return "correct";
	}
}

export interface RuleStoreHealth {
	status: "ok" | "degraded";
	path: string;
	/** Present when one append-in-flight suffix was skipped. */
	incompleteFinalLine?: number;
	/** Installed package ids shadowed by retained local records. */
	catalogCollisions?: string[];
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

function validateMatcher(value: unknown, expected?: "code" | "declarative"): RuleMatcher {
	if (!object(value)) throw new Error("matcher must be an object");
	const kind = oneOf(value.kind, ["code", "declarative"] as const, "matcher.kind");
	if (expected && kind !== expected) throw new Error(`matcher.kind must be ${expected}`);
	if (kind === "code") {
		exact(value, ["kind", "key"]);
		return { kind, key: text(value.key, "matcher.key", MAX_RULE_ID_LENGTH) };
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

function validatePersistedCandidate(value: unknown): PersistedLocalCandidate {
	if (!object(value)) throw new Error("candidate must be an object");
	exact(value, ["domain", "matcher", "note"], ["suggestion", "scope"]);
	const matcher = validateMatcher(value.matcher, "declarative") as PersistedLocalCandidate["matcher"];
	const domain = matcher.language === "facts/v1" ? FACTS_DOMAIN : POLICY_DOMAIN;
	if (value.domain !== domain) throw new Error(`candidate.domain must be ${domain}`);
	if (matcher.language === "facts/v1" && value.suggestion !== undefined)
		throw new Error("facts candidates do not accept a shell suggestion");
	const candidate: PersistedLocalCandidate = {
		domain,
		matcher,
		note: text(value.note, "candidate.note", MAX_NOTE_LENGTH),
	};
	if (value.suggestion !== undefined) candidate.suggestion = validateSuggestion(value.suggestion);
	if (value.scope !== undefined) candidate.scope = validateScope(value.scope);
	const guidance = ruleGuidance({
		definition: {
			revision: "000000000000",
			state: "active",
			effect: "steer",
			note: candidate.note,
			...(candidate.suggestion ? { suggestion: candidate.suggestion } : {}),
		},
	});
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
	exact(value, ["id", "domain", "matcher", "note"], ["suggestion", "scope"]);
	const id = validateRuleId(value.id);
	const candidate = validatePersistedCandidate({
		domain: value.domain,
		matcher: value.matcher,
		note: value.note,
		...(value.suggestion !== undefined ? { suggestion: value.suggestion } : {}),
		...(value.scope !== undefined ? { scope: value.scope } : {}),
	});
	return { id, ...candidate };
}

export function validatePackageDefinitionRow(value: unknown): PackageDefinitionRow {
	if (!object(value)) throw new Error("catalog row must be an object");
	exact(value, ["id", "domain", "matcher", "effect", "note", "revision"], ["suggestion", "scope"]);
	const matcher = validateMatcher(value.matcher);
	if (matcher.kind === "declarative" && matcher.language !== "facts/v1")
		throw new Error("package rows require a code or facts/v1 matcher");
	const domain = matcher.kind === "code" ? POLICY_DOMAIN : FACTS_DOMAIN;
	if (value.domain !== domain) throw new Error(`catalog row domain must be ${domain}`);
	if (matcher.kind === "declarative" && value.suggestion !== undefined)
		throw new Error("facts package definitions do not accept a shell suggestion");
	const effect =
		matcher.kind === "code"
			? oneOf(value.effect, EFFECTS, "catalog row effect")
			: candidateEffect({ domain, matcher, note: "Package definition" })!;
	if (value.effect !== effect) throw new Error("catalog row effect must match its program action");
	const rowWithoutRevision = {
		id: validateRuleId(value.id),
		domain,
		matcher,
		effect,
		note: text(value.note, "catalog row note", MAX_NOTE_LENGTH),
		...(value.suggestion !== undefined ? { suggestion: validateSuggestion(value.suggestion) } : {}),
		...(value.scope !== undefined ? { scope: validateScope(value.scope) } : {}),
	};
	if (rowWithoutRevision.matcher.kind === "code" && rowWithoutRevision.matcher.key !== rowWithoutRevision.id) {
		throw new Error("package rule id must equal its code matcher key");
	}
	const guidanceBytes = Buffer.byteLength(
		ruleGuidance({
			definition: {
				revision: "000000000000",
				state: "active",
				effect: rowWithoutRevision.effect,
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
		["catalog", "proposal", "decision", "override", "definition", "data"] as const,
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

function refreshDerived(record: RuleRecord, available: (domain: string, key: string) => boolean): RuleRecord {
	return {
		...record,
		matcherAvailable: record.matcher.kind === "declarative" ? true : available(record.domain, record.matcher.key),
		staleOverride:
			record.override !== undefined && record.override.againstDefinitionRevision !== record.definition.revision,
	};
}

function packageRecord(
	row: PackageDefinitionRow,
	override: RuleRecord["override"],
	available: (domain: string, key: string) => boolean,
): RuleRecord {
	return refreshDerived(
		{
			id: row.id,
			source: { kind: "package" },
			domain: row.domain,
			matcher: clone(row.matcher),
			definition: {
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

function orderedRecords(
	records: ReadonlyMap<string, RuleRecord>,
	packageOrder: readonly string[],
): Map<string, RuleRecord> {
	const ordered = new Map<string, RuleRecord>();
	for (const id of packageOrder) {
		const record = records.get(id);
		if (record?.source.kind === "package") ordered.set(id, record);
	}
	for (const record of [...records.values()]
		.filter((entry) => entry.source.kind === "package" && !ordered.has(entry.id))
		.sort((left, right) => left.id.localeCompare(right.id))) {
		ordered.set(record.id, record);
	}
	for (const record of [...records.values()]
		.filter((entry) => entry.source.kind === "local")
		.sort((left, right) => left.id.localeCompare(right.id))) {
		ordered.set(record.id, record);
	}
	return ordered;
}

function assertActiveCapacity(records: ReadonlyMap<string, RuleRecord>, additional = 0, excludedId?: string): void {
	let active = additional;
	for (const record of records.values()) {
		if (record.id !== excludedId && effectiveState(record) === "active") active++;
	}
	if (active > PROGRAM_LIMITS.rules) throw new Error(`active policy definitions exceed ${PROGRAM_LIMITS.rules}`);
}

function catalogCollisionIds(reduction: RuleReduction, catalog: readonly PackageDefinitionRow[]): string[] {
	return catalog
		.filter((row) => reduction.records.get(row.id)?.source.kind === "local")
		.map((row) => row.id)
		.sort((left, right) => left.localeCompare(right));
}

/** Reduce valid events in file order into the single rule map. */
export function reduceRuleEvents(
	events: readonly RuleEvent[],
	available: (domain: string, key: string) => boolean = hasCodeMatcher,
	eventLines?: readonly number[],
): RuleReduction {
	const records = new Map<string, RuleRecord>();
	const data = new Map<string, NamedData>();
	const pending = new Map<string, ProposalEvent>();
	const pendingByRule = new Map<string, string>();
	const localLines = new Map<string, number>();
	const pendingLines = new Map<string, number>();
	let packageOrder: string[] = [];
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
				packageOrder = event.rows.map((row) => row.id);
				const installed = new Set(event.rows.map((row) => row.id));
				for (const row of event.rows) {
					const existing = records.get(row.id);
					if (existing?.source.kind === "local") continue;
					records.set(row.id, packageRecord(row, existing?.override, available));
				}
				for (const [id, existing] of records) {
					if (existing.source.kind !== "package" || installed.has(id)) continue;
					records.set(
						id,
						refreshDerived({ ...existing, definition: { ...existing.definition, state: "retired" } }, available),
					);
				}
				continue;
			}
			if (event.kind === "proposal") {
				if (pendingByRule.has(event.ruleId)) continue;
				const existing = records.get(event.ruleId);
				if (event.operation === "add" && existing) continue;
				if (
					event.operation === "replace" &&
					(existing?.source.kind !== "local" ||
						existing.definition.revision !== event.expectedRevision ||
						existing.definition.state === "retired")
				)
					continue;
				if (event.operation === "retire" && existing?.source.kind !== "local") continue;
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
							: existing?.source.kind === "local" &&
								existing.definition.state === "active" &&
								existing.definition.revision === proposal.expectedRevision;
					const exactApproval = factsCandidate(candidate) || proposal.operation === "replace";
					const approvalValid = !exactApproval || event.proposalRevision === proposalRevision(proposal);
					const effect = candidate && candidateEffect(candidate, event.effect);
					if (
						candidate &&
						effect &&
						targetValid &&
						approvalValid &&
						(!factsCandidate(candidate) || event.effect === undefined)
					) {
						const revision = ruleDefinitionRevision({ id: proposal.ruleId, ...candidate, effect });
						records.set(
							proposal.ruleId,
							refreshDerived(
								{
									id: proposal.ruleId,
									source: { kind: "local", proposalId: proposal.id, approvedAudit: clone(operatorAudit(event.audit)) },
									domain: candidate.domain,
									matcher: clone(candidate.matcher),
									definition: {
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
						if (eventLine !== undefined) localLines.set(proposal.ruleId, eventLine);
						decided = true;
					}
				} else if (event.decision === "approved" && proposal.operation === "retire") {
					const existing = records.get(proposal.ruleId);
					if (event.effect === undefined && existing?.source.kind === "local") {
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
			if (existing?.source.kind !== "local") continue;
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
	const localCount = [...records.values()].filter((record) => record.source.kind === "local").length;
	if (localCount > MAX_LOCAL_RULES) {
		const line = [...localLines.values()].sort((left, right) => left - right)[MAX_LOCAL_RULES];
		if (line !== undefined) throw new RuleLineError(line, `rule store exceeds ${MAX_LOCAL_RULES} local rules`);
		throw new Error(`rule store exceeds ${MAX_LOCAL_RULES} local rules`);
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
		records: orderedRecords(records, packageOrder),
		pending: [...pending.values()].sort(
			(left, right) => left.ruleId.localeCompare(right.ruleId) || left.id.localeCompare(right.id),
		),
	};
}

function applyInstalledCatalog(
	reduction: RuleReduction,
	catalog: readonly PackageDefinitionRow[],
	available: (domain: string, key: string) => boolean,
): RuleReduction {
	const records = new Map(reduction.records);
	const installed = new Set(catalog.map((row) => row.id));
	for (const row of catalog) {
		const existing = records.get(row.id);
		if (existing?.source.kind === "local") continue;
		records.set(row.id, packageRecord(row, existing?.override, available));
	}
	for (const [id, record] of records) {
		if (record.source.kind === "package" && !installed.has(id)) {
			records.set(id, refreshDerived({ ...record, definition: { ...record.definition, state: "retired" } }, available));
		}
	}
	assertActiveCapacity(records);
	return {
		records: orderedRecords(
			records,
			catalog.map((row) => row.id),
		),
		pending: reduction.pending,
		data: reduction.data,
	};
}

function catalogChange(reduction: RuleReduction, catalog: readonly PackageDefinitionRow[]): CatalogEvent | undefined {
	const installed = new Map(catalog.map((row) => [row.id, row]));
	let differs = false;
	for (const row of catalog) {
		const existing = reduction.records.get(row.id);
		if (existing?.source.kind === "local") continue;
		if (!existing || existing.definition.revision !== row.revision || existing.definition.state === "retired") {
			differs = true;
		}
	}
	if (
		[...reduction.records.values()].some(
			(record) => record.source.kind === "package" && record.definition.state === "active" && !installed.has(record.id),
		)
	) {
		differs = true;
	}
	if (!differs) return undefined;
	return {
		kind: "catalog",
		rows: [...catalog].sort((left, right) => left.id.localeCompare(right.id)).map(clone),
		audit: { surface: "package" },
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
				if (event.kind !== "catalog" && line.length + 1 > MAX_RULE_EVENT_BYTES)
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
	if (event.kind === "catalog") throw new Error("catalog events may only be written by package synchronization");
	if (event.kind === "proposal") {
		if (event.audit.surface !== "agent-tool") throw new Error("proposals may only be written by policy_propose");
		return;
	}
	if (eventSurface(event) === "agent-tool") {
		throw new Error(`${event.kind} events require an operator surface`);
	}
}

function assertTransition(event: Exclude<RuleEvent, CatalogEvent>, reduction: RuleReduction): void {
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
			const localCount = [...reduction.records.values()].filter((record) => record.source.kind === "local").length;
			if (localCount >= MAX_LOCAL_RULES) throw new Error(`rule store already contains ${MAX_LOCAL_RULES} local rules`);
		} else if (event.operation === "replace") {
			if (existing?.source.kind !== "local")
				throw new Error(`replacement target "${event.ruleId}" is not a local rule`);
			if (existing.definition.state === "retired") throw new Error(`local rule "${event.ruleId}" is retired`);
			if (existing.definition.revision !== event.expectedRevision)
				throw new Error(`replacement target "${event.ruleId}" revision changed`);
		} else if (event.operation === "retire") {
			if (existing?.source.kind !== "local")
				throw new Error(`retire proposal target "${event.ruleId}" is not a local rule`);
			if (effectiveState(existing) === "retired") throw new Error(`local rule "${event.ruleId}" is already retired`);
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
			const isFacts = factsCandidate(proposal.candidate);
			if (isFacts && event.effect !== undefined)
				throw new Error("facts approval uses the exact proposed action, not steer or block");
			if (!isFacts && !event.effect)
				throw new Error("approving an add or replace command proposal requires effect steer or block");
			if ((isFacts || proposal.operation === "replace") && event.proposalRevision !== proposalRevision(proposal))
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
				if (current?.source.kind !== "local" || current.definition.revision !== proposal.expectedRevision)
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
			existing.matcher.kind === "declarative" &&
			existing.matcher.language === "facts/v1" &&
			event.override.effect !== undefined &&
			event.override.effect !== existing.override?.effect
		)
			throw new Error("facts actions require an exact replacement proposal; steer/block overrides do not change them");
		return;
	}
	if (existing.source.kind !== "local") throw new Error(`only local rules can be retired directly`);
	if (existing.definition.state === "retired") throw new Error(`local rule "${event.ruleId}" is already retired`);
}

export interface RuleRegistryOptions {
	catalog?: readonly PackageDefinitionRow[];
	matcherAvailable?: (domain: string, key: string) => boolean;
	onNotice?: (message: string) => void;
}

export class RuleRegistry {
	readonly path: string;
	private readonly dir: string;
	private readonly catalog: PackageDefinitionRow[];
	private readonly matcherAvailable: (domain: string, key: string) => boolean;
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

	private defaults(): RuleReduction {
		return applyInstalledCatalog(
			{ records: new Map(), pending: [], data: new Map() },
			this.catalog,
			this.matcherAvailable,
		);
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
			"Installed package defaults are active in memory; mechanisms are capped at notice and rule writes are refused.";
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

	private async append(eventValue: RuleEvent, internalCatalog = false): Promise<void> {
		const event = validateRuleEvent(eventValue);
		if (!internalCatalog) assertWritableAuthority(event);
		const serialized = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
		const maximum = event.kind === "catalog" ? MAX_CATALOG_EVENT_BYTES : MAX_RULE_EVENT_BYTES;
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

	private async synchronizeCatalog(): Promise<void> {
		if (this.degradedHealth) return;
		try {
			const read = await this.readReduction();
			if (read.incompleteFinalLine) {
				this.reportIncomplete(read.incompleteFinalLine);
				// Completion can happen in this process; retry synchronization on
				// the next use before admitting any later mutation.
				this.firstUse = undefined;
				return;
			}
			applyInstalledCatalog(read.reduction, this.catalog, this.matcherAvailable);
			const change = catalogChange(read.reduction, this.catalog);
			if (change) await this.append(change, true);
		} catch (error) {
			this.degrade(error);
		}
	}

	private ensureFirstUse(): Promise<void> {
		this.firstUse ??= this.synchronizeCatalog();
		return this.firstUse;
	}

	async snapshot(): Promise<RuleSnapshot> {
		await this.ensureFirstUse();
		if (this.degradedHealth) return { ...this.defaults(), health: clone(this.degradedHealth) };
		try {
			const read = await this.readReduction();
			const collisions = catalogCollisionIds(read.reduction, this.catalog);
			const reduction = applyInstalledCatalog(read.reduction, this.catalog, this.matcherAvailable);
			const health: RuleStoreHealth = { status: "ok", path: this.path };
			if (collisions.length > 0) health.catalogCollisions = collisions;
			if (read.incompleteFinalLine) {
				health.incompleteFinalLine = read.incompleteFinalLine;
				health.message = this.reportIncomplete(read.incompleteFinalLine);
			}
			return { ...reduction, health };
		} catch (error) {
			this.degrade(error);
			return { ...this.defaults(), health: clone(this.degradedHealth!) };
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
			const reduction = applyInstalledCatalog(read.reduction, this.catalog, this.matcherAvailable);
			const built = build(reduction);
			const event = validateRuleEvent(built.event) as Exclude<RuleEvent, CatalogEvent>;
			assertWritableAuthority(event);
			assertTransition(event, reduction);
			await this.append(event);
			return built.result;
		};
		const running = this.mutationTail.then(action);
		this.mutationTail = running.then(
			() => undefined,
			() => undefined,
		);
		return running;
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
				domain: candidate.domain,
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
			if (existing?.matcher.kind === "declarative" && existing.matcher.language === "facts/v1")
				throw new Error(
					"facts actions require an exact replacement proposal; steer/block overrides do not change them",
				);
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
	if (health.catalogCollisions && health.catalogCollisions.length > 0) {
		conditions.push(
			`catalog collision: local record retained and installed package row skipped for ${health.catalogCollisions
				.map((id) => `"${id}"`)
				.join(", ")}`,
		);
	}
	return `registry health: degraded=false | ${conditions.length > 0 ? conditions.join(" | ") : "ok"}`;
}
