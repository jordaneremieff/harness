/** Unified policy rule aggregate and matcher contracts. */

import { createHash } from "node:crypto";

export const POLICY_DOMAIN = "tool-call" as const;
export type PolicyDomain = typeof POLICY_DOMAIN;
export type RuleEffect = "steer" | "block";
export type RuleDefinitionState = "active" | "retired";

export interface OperandShape {
	min?: number;
	max?: number;
	any?: string[];
	at?: Record<string, string[]>;
}

export interface PipeShape {
	from?: boolean;
	to?: boolean;
	fromRedirect?: boolean;
	toRedirect?: boolean;
	next?: string[];
	later?: string[];
}

/** Declarative shell command shape. Parsing never expands shell data. */
export interface CommandShapeSpec {
	command: string;
	flags?: string[];
	absentFlags?: string[];
	operands?: OperandShape;
	pipe?: PipeShape;
}

export interface RuleSuggestion {
	command: string;
	flags?: string[];
}

export interface RuleScope {
	modelProviders?: string[];
	models?: string[];
	cwdPrefixes?: string[];
}

export type AuditSurface = "package" | "agent-tool" | "command" | "panel";

/** Package catalog events are content-identical across concurrent sessions. */
export interface PackageRuleAudit {
	surface: "package";
}

export interface SessionRuleAudit {
	at: string;
	session: string;
	model: string | null;
	surface: Exclude<AuditSurface, "package">;
}

export type RuleAudit = PackageRuleAudit | SessionRuleAudit;
export type OperatorRuleAudit = SessionRuleAudit & { surface: "command" | "panel" };
export type AgentRuleAudit = SessionRuleAudit & { surface: "agent-tool" };

export type RuleMatcher =
	| { kind: "code"; key: string }
	| { kind: "declarative"; language: "command-shape/v1"; spec: CommandShapeSpec };

export interface RuleDefinition {
	revision: string;
	state: RuleDefinitionState;
	effect: RuleEffect;
	note: string;
	suggestion?: RuleSuggestion;
	scope?: RuleScope;
}

/** The override is replaced as one complete unit by every set event. */
export interface RuleOverride {
	state?: "disabled";
	effect?: RuleEffect;
	reason: string;
	audit: OperatorRuleAudit;
	againstDefinitionRevision: string;
}

/** One reduced rule, irrespective of package or local provenance. */
export interface RuleRecord {
	id: string;
	source: { kind: "package" } | { kind: "local"; proposalId: string; approvedAudit: OperatorRuleAudit };
	domain: PolicyDomain;
	matcher: RuleMatcher;
	definition: RuleDefinition;
	override?: RuleOverride;
	/** Derived from the predicates installed with this package. */
	matcherAvailable: boolean;
	/** Derived by comparing the override target with the current definition. */
	staleOverride: boolean;
}

/** Persisted package definition row. Package definitions always use code matchers. */
export interface PackageDefinitionRow {
	id: string;
	domain: PolicyDomain;
	matcher: { kind: "code"; key: string };
	effect: RuleEffect;
	note: string;
	suggestion?: RuleSuggestion;
	scope?: RuleScope;
	revision: string;
}

export interface RuleMatchContext {
	provider?: string | null;
	model?: string | null;
	cwd: string;
}

/** Effective state gives package retirement precedence over an operator override. */
export function effectiveState(record: Pick<RuleRecord, "definition" | "override">): "active" | "disabled" | "retired" {
	return record.definition.state === "retired" ? "retired" : (record.override?.state ?? "active");
}

export function effectiveEffect(record: Pick<RuleRecord, "definition" | "override">): RuleEffect {
	return record.override?.effect ?? record.definition.effect;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonical(entry)]),
	);
}

export interface RevisionInput {
	id: string;
	domain: PolicyDomain;
	matcher: RuleMatcher;
	effect: RuleEffect;
	note: string;
	suggestion?: RuleSuggestion;
	scope?: RuleScope;
}

/**
 * Short content identity for behavior-bearing definition fields.
 * Lifecycle state is excluded so retirement and return retain the same identity.
 */
export function ruleDefinitionRevision(input: RevisionInput): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(input)))
		.digest("hex")
		.slice(0, 12);
}

export function packageRowRevision(row: Omit<PackageDefinitionRow, "revision">): string {
	return ruleDefinitionRevision(row);
}

/** One-line guidance shared by code and declarative records. */
export function ruleGuidance(record: Pick<RuleRecord, "definition">): string {
	const safe = (value: string) =>
		value
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) => {
				const code = character.codePointAt(0) ?? 0;
				return `\\x${code.toString(16).padStart(2, "0")}`;
			})
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	const note = safe(record.definition.note);
	const suggestion = record.definition.suggestion;
	if (!suggestion) return note;
	const form = safe([suggestion.command, ...(suggestion.flags ?? [])].join(" ")).replace(/[.]+$/, "");
	return `${note} Suggested form: ${form}.`;
}
