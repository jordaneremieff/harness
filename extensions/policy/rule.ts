/** Unified policy rule aggregate and matcher contracts. */

import { createHash } from "node:crypto";
import type { Condition, FactsProgram, ProgramAction } from "./program.ts";

export type RuleAuthority = "exact" | "steer-or-block";
export type RuleEffect = "steer" | "block";
export type DefinitionEffect = RuleEffect | "correct" | "observe";
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

/** The starter catalog records bundled provenance, not continuing authority. */
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
	| { kind: "declarative"; language: "command-shape/v1"; spec: CommandShapeSpec }
	| { kind: "declarative"; language: "facts/v1"; spec: FactsProgram };

export interface RuleDefinition {
	/** Positive outcome this policy protects. */
	purpose: string;
	/** Exact actions never acquire correction authority through an effect override. */
	authority: RuleAuthority;
	/** False or unavailable applicability leaves this rule inactive for the event. */
	applicability?: Condition;
	revision: string;
	state: RuleDefinitionState;
	effect: DefinitionEffect;
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
	source:
		| { kind: "package" }
		| { kind: "local"; proposalId: string; approvedAudit: OperatorRuleAudit }
		| { kind: "import"; importId: string; approvedAudit: OperatorRuleAudit };
	matcher: RuleMatcher;
	definition: RuleDefinition;
	override?: RuleOverride;
	/** Derived from the predicates installed with this package. */
	matcherAvailable: boolean;
	/** Derived by comparing the override target with the current definition. */
	staleOverride: boolean;
}

/** A bundled starter definition available for initial seeding or explicit import. */
export interface PackageDefinitionRow {
	id: string;
	purpose: string;
	authority: RuleAuthority;
	applicability?: Condition;
	matcher: RuleMatcher;
	effect: DefinitionEffect;
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

/** Retirement takes precedence over an operator override for every rule. */
export function effectiveState(record: Pick<RuleRecord, "definition" | "override">): "active" | "disabled" | "retired" {
	return record.definition.state === "retired" ? "retired" : (record.override?.state ?? "active");
}

export interface RuleBehavior {
	matcher: RuleMatcher;
	definition: Pick<RuleDefinition, "authority" | "note"> & Partial<Pick<RuleDefinition, "effect" | "suggestion">>;
}

/** Decode authoring syntax at the rule boundary, not in operator controls. */
export function declaredAction(record: RuleBehavior): ProgramAction {
	const program = factsProgram(record);
	if (program) return program.action;
	return record.definition.effect === "block" ? { kind: "deny" } : { kind: "guide", text: ruleGuidance(record) };
}

export function permitsEffectChoice(record: RuleBehavior): boolean {
	const action = declaredAction(record);
	const program = factsProgram(record);
	return (
		record.definition.authority === "steer-or-block" &&
		(!program || program.phase === "input") &&
		(action.kind === "guide" || action.kind === "deny")
	);
}

export function actionEffect(action: ProgramAction): DefinitionEffect {
	if (action.kind === "deny") return "block";
	if (action.kind === "guide") return "steer";
	if (action.kind === "observe") return "observe";
	return "correct";
}

export function effectiveEffect(record: Pick<RuleRecord, "definition" | "override" | "matcher">): DefinitionEffect {
	return permitsEffectChoice(record) ? (record.override?.effect ?? record.definition.effect) : record.definition.effect;
}

export function factsProgram(record: Pick<RuleRecord, "matcher">): FactsProgram | undefined {
	return record.matcher.kind === "declarative" && record.matcher.language === "facts/v1"
		? record.matcher.spec
		: undefined;
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
	purpose: string;
	authority: RuleAuthority;
	applicability?: Condition;
	matcher: RuleMatcher;
	effect: DefinitionEffect;
	note: string;
	suggestion?: RuleSuggestion;
	scope?: RuleScope;
}

/**
 * Short content identity for behavior-bearing definition fields.
 * Lifecycle state is excluded so retirement and return retain the same identity.
 */
export function contentRevision(input: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(input)))
		.digest("hex")
		.slice(0, 12);
}

export function ruleDefinitionRevision(input: RevisionInput): string {
	return contentRevision(input);
}

export function packageRowRevision(row: Omit<PackageDefinitionRow, "revision">): string {
	return ruleDefinitionRevision(row);
}

/** One-line guidance shared by code and declarative records. */
export function ruleGuidance(record: { definition: Pick<RuleDefinition, "note" | "suggestion"> }): string {
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
