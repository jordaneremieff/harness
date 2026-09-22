/** Closed facts grammar and private correction plans. No action commits occur here. */
import { type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import { type CommandEvidence, captureEvidence, type RuleEvidence } from "./compiler.ts";
import {
	checkToolSchema,
	cloneJson,
	DataNameSchema,
	type DataSnapshot,
	lookupData,
	readPath,
	type Scalar,
	ScalarSchema,
	safeKey,
	type Truth,
	UNKNOWN,
	validPath,
} from "./data.ts";
import type { PolicyMode } from "./mode.ts";
import type { RuleMatchContext } from "./rule.ts";
import type { StateView } from "./state.ts";

export type { Truth } from "./data.ts";
export { UNKNOWN } from "./data.ts";
export const RULE_CAPACITY = { catalog: 1280, active: 1280 } as const;
export const GUIDANCE_BYTES = 2048;
export const GUIDANCE_PREFIX = "[policy]";
export const PROGRAM_LIMITS = {
	rules: RULE_CAPACITY.active,
	nodes: 128,
	depth: 8,
	children: 16,
	paths: 16,
	data: 16,
	text: 2000,
} as const;
export type Condition =
	| { all: Condition[] }
	| { any: Condition[] }
	| { not: Condition }
	| {
			op:
				| "eq"
				| "in"
				| "exists"
				| "type"
				| "gt"
				| "gte"
				| "lt"
				| "lte"
				| "starts-with"
				| "ends-with"
				| "contains"
				| "lookup";
			path: string[];
			value?: Scalar | Scalar[];
			table?: string;
	  };
export interface StateSpec {
	observe: Condition;
	resetWhen?: Condition;
	totalPath?: string[];
	/** The last maxEvents matching completions intersected with the age bound. */
	window?: { maxEvents: number; maxAgeMs: number };
	cooldownMs?: number;
	once?: "period" | "turn";
	expiresAfterMs?: number;
}
export type ProgramAction =
	| { kind: "deny" }
	| { kind: "rename-key"; path: string[]; from: string; to: string }
	| { kind: "substitute"; path: string[]; table: string; stage?: "logical-target" | "values" }
	| { kind: "assert-error" }
	| { kind: "guide"; text: string }
	| { kind: "observe"; label: string };
export type ProgramPhase = "input" | "result" | "completion" | "context";
export interface ArgumentCodec {
	argumentsPath: string[];
	operationPath?: string[];
}
export interface FactsProgram {
	phase: ProgramPhase;
	selector?: { tools?: string[]; operations?: string[]; codec?: ArgumentCodec };
	when: Condition;
	action: ProgramAction;
	onUnavailable: "skip" | "deny";
	inputView?: "original" | "effective";
	data?: string[];
	state?: StateSpec;
}
const PathSchema = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 16 });
const ParentPathSchema = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 16 });
const closed = { additionalProperties: false };
function conditionShape<C extends TSchema>(child: C) {
	return Type.Union([
		Type.Object({ all: Type.Array(child, { minItems: 1, maxItems: PROGRAM_LIMITS.children }) }, closed),
		Type.Object({ any: Type.Array(child, { minItems: 1, maxItems: PROGRAM_LIMITS.children }) }, closed),
		Type.Object({ not: child }, closed),
		Type.Object(
			{
				op: Type.Union(
					[
						"eq",
						"in",
						"exists",
						"type",
						"gt",
						"gte",
						"lt",
						"lte",
						"starts-with",
						"ends-with",
						"contains",
						"lookup",
					].map((entry) => Type.Literal(entry)),
				),
				path: PathSchema,
				value: Type.Optional(Type.Union([ScalarSchema, Type.Array(ScalarSchema, { maxItems: 64 })])),
				table: Type.Optional(DataNameSchema),
			},
			closed,
		),
	]);
}
export const ConditionSchema = Type.Cyclic({ Condition: conditionShape(Type.Ref("Condition")) }, "Condition");

/** Provider descriptions stop at child objects; recursive validation owns every nested condition. */
export const ProposalConditionSchema = conditionShape(
	Type.Object(
		{},
		{
			additionalProperties: true,
			description: `A nested condition using the same closed grammar: exactly one of {all:[conditions]}, {any:[conditions]}, {not:condition}, or {op,path,value?,table?}. Use the parent's leaf operators and field types. All/any arrays have 1-${PROGRAM_LIMITS.children} children. Conditions share a ${PROGRAM_LIMITS.nodes}-node budget across applicability, when, observe, and resetWhen; maximum nesting depth is ${PROGRAM_LIMITS.depth} from each root. Every nested object receives strict local validation.`,
		},
	),
);
function stateShape<C extends TSchema>(condition: C) {
	return Type.Object(
		{
			observe: condition,
			resetWhen: Type.Optional(condition),
			totalPath: Type.Optional(PathSchema),
			window: Type.Optional(
				Type.Object(
					{
						maxEvents: Type.Integer({ minimum: 1, maximum: 1024 }),
						maxAgeMs: Type.Integer({ minimum: 1, maximum: 86400000 }),
					},
					closed,
				),
			),
			cooldownMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86400000 })),
			once: Type.Optional(Type.Union([Type.Literal("period"), Type.Literal("turn")])),
			expiresAfterMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400000 })),
		},
		closed,
	);
}
export const StateSpecSchema = stateShape(ConditionSchema);
function programShape<C extends TSchema>(condition: C) {
	return Type.Object(
		{
			phase: Type.Union(["input", "result", "completion", "context"].map((entry) => Type.Literal(entry))),
			selector: Type.Optional(
				Type.Object(
					{
						tools: Type.Optional(
							Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 64 }),
						),
						operations: Type.Optional(
							Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 64 }),
						),
						codec: Type.Optional(
							Type.Object(
								{
									argumentsPath: PathSchema,
									operationPath: Type.Optional(PathSchema),
								},
								closed,
							),
						),
					},
					closed,
				),
			),
			when: condition,
			action: Type.Union([
				Type.Object({ kind: Type.Literal("deny") }, closed),
				Type.Object(
					{
						kind: Type.Literal("rename-key"),
						path: ParentPathSchema,
						from: Type.String({ minLength: 1, maxLength: 128 }),
						to: Type.String({ minLength: 1, maxLength: 128 }),
					},
					closed,
				),
				Type.Object(
					{
						kind: Type.Literal("substitute"),
						path: PathSchema,
						table: DataNameSchema,
						stage: Type.Optional(Type.Union([Type.Literal("logical-target"), Type.Literal("values")])),
					},
					closed,
				),
				Type.Object({ kind: Type.Literal("assert-error") }, closed),
				Type.Object(
					{ kind: Type.Literal("guide"), text: Type.String({ minLength: 1, maxLength: PROGRAM_LIMITS.text }) },
					closed,
				),
				Type.Object({ kind: Type.Literal("observe"), label: Type.String({ minLength: 1, maxLength: 80 }) }, closed),
			]),
			onUnavailable: Type.Union([Type.Literal("skip"), Type.Literal("deny")]),
			inputView: Type.Optional(Type.Union([Type.Literal("original"), Type.Literal("effective")])),
			data: Type.Optional(Type.Array(DataNameSchema, { maxItems: PROGRAM_LIMITS.data, uniqueItems: true })),
			state: Type.Optional(stateShape(condition)),
		},
		closed,
	);
}
export const FactsProgramSchema = programShape(ConditionSchema);
export const ProposalProgramSchema = programShape(ProposalConditionSchema);
const programValidator = Compile(FactsProgramSchema);
const conditionValidator = Compile(ConditionSchema);
const roots = new Set([
	"input",
	"original",
	"outer",
	"originalOuter",
	"result",
	"outcome",
	"state",
	"tool",
	"operation",
	"schema",
	"data",
	"context",
]);

function typedConditionValueError(condition: LeafCondition): string | undefined {
	if (["gt", "gte", "lt", "lte"].includes(condition.op) && typeof condition.value !== "number")
		return "Numeric condition requires a number";
	if (["starts-with", "ends-with", "contains"].includes(condition.op) && typeof condition.value !== "string")
		return "String condition requires a string";
	if (
		condition.op === "type" &&
		!["string", "number", "integer", "boolean", "null", "array", "object"].includes(String(condition.value))
	)
		return "Unknown JSON type";
	return undefined;
}

function conditionValueError(condition: LeafCondition): string | undefined {
	if (condition.op === "exists")
		return condition.value !== undefined || condition.table !== undefined ? "exists has no value or table" : undefined;
	if (condition.op === "lookup")
		return !condition.table || !["missing", "unique", "ambiguous"].includes(String(condition.value))
			? "lookup requires a table and lookup status"
			: undefined;
	if (condition.table !== undefined) return "Only lookup accepts a table";
	if (condition.value === undefined) return "Condition requires a value";
	if (condition.op === "in")
		return !Array.isArray(condition.value) || condition.value.length === 0
			? "in requires a nonempty scalar array"
			: undefined;
	if (Array.isArray(condition.value)) return "Only in accepts an array";
	return typedConditionValueError(condition);
}

function leafConditionError(condition: LeafCondition): string | undefined {
	if (!validPath(condition.path) || !roots.has(condition.path[0]))
		return "Condition requires a safe declared fact path";
	return conditionValueError(condition);
}

function conditionError(condition: Condition, budget: { nodes: number }, depth = 0): string | undefined {
	if (++budget.nodes > PROGRAM_LIMITS.nodes || depth > PROGRAM_LIMITS.depth) return "Condition exceeds grammar bounds";
	if ("all" in condition || "any" in condition) {
		const children = "all" in condition ? condition.all : condition.any;
		for (const child of children) {
			const error = conditionError(child, budget, depth + 1);
			if (error) return error;
		}
		return undefined;
	}
	if ("not" in condition) return conditionError(condition.not, budget, depth + 1);
	return leafConditionError(condition);
}

function bindingsValid(condition: Condition, bindings: ReadonlySet<string>): boolean {
	return "all" in condition
		? condition.all.every((child) => bindingsValid(child, bindings))
		: "any" in condition
			? condition.any.every((child) => bindingsValid(child, bindings))
			: "not" in condition
				? bindingsValid(condition.not, bindings)
				: condition.op !== "lookup" || bindings.has(condition.table ?? "");
}

/** Applicability and the approved program share one condition budget and data authority. */
export function validateApplicability(value: unknown, program?: FactsProgram): string | undefined {
	try {
		const copied = cloneJson(value);
		if (!conditionValidator.Check(copied)) return "Invalid applicability condition shape";
		const condition = copied as Condition;
		const budget = { nodes: 0 };
		for (const entry of [condition, program?.when, program?.state?.observe, program?.state?.resetWhen]) {
			if (!entry) continue;
			const error = conditionError(entry, budget);
			if (error) return error;
		}
		return bindingsValid(condition, new Set(program?.data ?? []))
			? undefined
			: "Applicability requires declared data bindings";
	} catch {
		return "Applicability exceeds bounds or contains unsafe JSON";
	}
}

/** Phase, action, and path compatibility for one validated facts program. */
function programActionError(program: FactsProgram): string | undefined {
	const permitted: Record<ProgramAction["kind"], ProgramPhase[]> = {
		deny: ["input"],
		"rename-key": ["input"],
		substitute: ["input"],
		"assert-error": ["result"],
		guide: ["input", "result", "completion", "context"],
		observe: ["completion"],
	};
	if (!permitted[program.action.kind].includes(program.phase)) return "Action is unavailable in this phase";
	if (program.onUnavailable === "deny" && program.phase !== "input") return "Unavailable denial requires the input phase";
	if (program.inputView && program.phase !== "input") return "inputView requires the input phase";
	if (program.inputView === "effective" && program.action.kind !== "deny" && program.action.kind !== "guide")
		return "Only denial or guidance uses an effective-input gate";
	if ("path" in program.action && !validPath(program.action.path, program.action.kind === "rename-key"))
		return "Unsafe correction path";
	if (
		program.action.kind === "rename-key" &&
		(!safeKey(program.action.from) || !safeKey(program.action.to) || program.action.from === program.action.to)
	)
		return "Invalid key rename";
	return undefined;
}

/** Selector, codec, and data-binding compatibility for one validated facts program. */
function programSelectorError(program: FactsProgram): string | undefined {
	const selector = program.selector;
	if (
		selector?.codec &&
		(!validPath(selector.codec.argumentsPath) ||
			(selector.codec.operationPath && !validPath(selector.codec.operationPath)))
	)
		return "Unsafe codec path";
	if (
		selector?.codec &&
		(program.action.kind === "rename-key" || (program.action.kind === "substitute" && program.action.stage !== "logical-target"))
	)
		return "Decoded argument corrections are unsupported; use a direct-tool correction";
	const bindings = new Set(program.data ?? []);
	if (program.action.kind === "substitute" && !bindings.has(program.action.table))
		return "Substitution table requires a declared data binding";
	if (
		![program.when, program.state?.observe, program.state?.resetWhen].every(
			(entry) => !entry || bindingsValid(entry, bindings),
		)
	)
		return "Lookup requires a declared data binding";
	return undefined;
}

function programConditionsError(program: FactsProgram, budget: { nodes: number }): string | undefined {
	for (const condition of [program.when, program.state?.observe, program.state?.resetWhen]) {
		if (condition) {
			const error = conditionError(condition, budget);
			if (error) return error;
		}
	}
	return undefined;
}

export function validateFactsProgram(value: unknown): string | undefined {
	try {
		const copied = cloneJson(value);
		if (!programValidator.Check(copied)) return "Invalid facts program shape";
		const program = copied as FactsProgram;
		const conditionsError = programConditionsError(program, { nodes: 0 });
		if (conditionsError) return conditionsError;
		if (program.state?.totalPath && (!validPath(program.state.totalPath) || !roots.has(program.state.totalPath[0])))
			return "Invalid aggregate total path";
		if (program.phase === "context" && program.selector && !program.state)
			return "Context selectors require an observation state";
		if (
			program.action.kind === "guide" &&
			(!program.action.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim() ||
				Buffer.byteLength(`${GUIDANCE_PREFIX} ${program.action.text}`, "utf8") > GUIDANCE_BYTES)
		)
			return "Guidance exceeds its UTF-8 projection bound or has no text";
		const actionError = programActionError(program);
		if (actionError) return actionError;
		const selectorError = programSelectorError(program);
		if (selectorError) return selectorError;
		return undefined;
	} catch {
		return "Facts program exceeds bounds or contains unsafe JSON";
	}
}

interface ConditionBudget {
	nodes: number;
}

function typeComparison(value: unknown, expected: unknown): Truth {
	if (expected === "null") return value === null;
	if (expected === "array") return Array.isArray(value);
	if (expected === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
	if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
	return typeof value === expected;
}

function numericComparison(value: unknown, expected: unknown, op: "gt" | "gte" | "lt" | "lte"): Truth {
	if (op === "gt") return typeof value === "number" && typeof expected === "number" && value > expected;
	if (op === "gte") return typeof value === "number" && typeof expected === "number" && value >= expected;
	if (op === "lt") return typeof value === "number" && typeof expected === "number" && value < expected;
	if (op === "lte") return typeof value === "number" && typeof expected === "number" && value <= expected;
	return "unknown";
}

function stringComparison(
	value: unknown,
	expected: unknown,
	op: "starts-with" | "ends-with" | "contains",
): Truth {
	if (op === "starts-with") return typeof value === "string" && typeof expected === "string" && value.startsWith(expected);
	if (op === "ends-with") return typeof value === "string" && typeof expected === "string" && value.endsWith(expected);
	if (op === "contains") return typeof value === "string" && typeof expected === "string" && value.includes(expected);
	return "unknown";
}

/** Kleene comparison of one actual value against its declared expectation. */
function compareValue(value: unknown, expected: unknown, op: LeafCondition["op"]): Truth {
	if (op === "type") return typeComparison(value, expected);
	if (op === "in") return Array.isArray(expected) ? expected.some((candidate) => candidate === value) : "unknown";
	if (op === "gt" || op === "gte" || op === "lt" || op === "lte") return numericComparison(value, expected, op);
	if (op === "starts-with" || op === "ends-with" || op === "contains") return stringComparison(value, expected, op);
	return value === expected;
}

type LeafCondition = Extract<Condition, { op: string; path: string[] }>;

function evaluateLeaf(entry: LeafCondition, facts: Record<string, unknown>): Truth {
	const found = readPath(facts, entry.path);
	if (found.value === UNKNOWN) return "unknown";
	if (entry.op === "exists") return found.exists;
	if (!found.exists || found.value === undefined) return "unknown";
	if (entry.op !== "lookup") return compareValue(found.value, entry.value, entry.op);
	const data = readPath(facts, ["data", entry.table ?? ""]);
	const lookup = lookupData(data.value as DataSnapshot | undefined, found.value);
	return lookup.status === "unavailable" ? "unknown" : lookup.status === entry.value;
}

function evaluateComposition(
	entry: Condition,
	facts: Record<string, unknown>,
	budget: ConditionBudget,
	depth: number,
): Truth {
	const children: readonly Condition[] = "all" in entry ? entry.all : "any" in entry ? entry.any : [];
	if (!children.length || children.length > PROGRAM_LIMITS.children) return "unknown";
	const values = children.map((child: Condition) => evaluateEntry(child, facts, budget, depth + 1));
	if ("all" in entry) return values.includes(false) ? false : values.includes("unknown") ? "unknown" : true;
	return values.includes(true) ? true : values.includes("unknown") ? "unknown" : false;
}

function evaluateEntry(
	entry: Condition,
	facts: Record<string, unknown>,
	budget: ConditionBudget,
	depth: number,
): Truth {
	if (++budget.nodes > PROGRAM_LIMITS.nodes || depth > PROGRAM_LIMITS.depth) return "unknown";
	if ("not" in entry) {
		const truth = evaluateEntry(entry.not, facts, budget, depth + 1);
		return truth === "unknown" ? truth : !truth;
	}
	if ("all" in entry || "any" in entry) return evaluateComposition(entry, facts, budget, depth);
	return evaluateLeaf(entry, facts);
}

/** Kleene logic preserves unavailable evidence under negation and composition. */
export function evaluateCondition(condition: Condition, facts: Record<string, unknown>): Truth {
	const budget: ConditionBudget = { nodes: 0 };
	try {
		return evaluateEntry(condition, facts, budget, 0);
	} catch {
		return "unknown";
	}
}

export interface ProgramStep extends FactsProgram {
	/** A later step requires a true input match from this admitted call. */
	requiresMatch?: boolean;
}
export interface ProgramRule {
	id: string;
	revision: string;
	program: ProgramStep;
	applicability?: Condition;
	/** Internal steps share the rule identity and its single observation period. */
	steps?: ProgramStep[];
	evidence?: RuleEvidence;
	projectionModes?: PolicyMode[];
}
export function programSteps(rule: ProgramRule): ProgramRule[] {
	return [rule.program, ...(rule.steps ?? [])].map((program) => ({ ...rule, program, steps: undefined }));
}
export interface EvaluationContext {
	tool: string;
	operation?: string;
	facts?: Record<string, unknown>;
	data?: Record<string, DataSnapshot>;
	states?: Record<string, StateView>;
	schema?: TSchema;
	now?: number;
	/** False keeps candidate effects hypothetical and checks effective gates on actual input. */
	applyCorrections?: boolean;
	mode?: PolicyMode;
	scope?: RuleMatchContext;
	/** Input evidence uses a fixed snapshot; later phases use admitted matches. */
	evidence?: ReadonlyMap<string, Truth> & { readonly reasons?: ReadonlyMap<string, readonly string[]> };
	matched?: ReadonlySet<string>;
	staleRules?: ReadonlySet<string>;
}
export interface ProgramEvaluation {
	id: string;
	revision: string;
	phase: ProgramPhase;
	inputView?: "original" | "effective";
	applicable: Truth;
	truth: Truth;
	action: ProgramAction;
	unavailable: boolean;
	/** Fixed evidence codes only, without raw arguments or command text. */
	unavailableReasons?: readonly string[];
	deny: boolean;
}
export interface InputPlan {
	candidate: Record<string, unknown>;
	changed: boolean;
	denied: boolean;
	valid: boolean;
	evaluations: ProgramEvaluation[];
	problems: string[];
	matches: string[];
	corrections: { id: string; stage: "logical-target" | "keys" | "values"; path: string[] }[];
}

function decoded(input: unknown, codec: ArgumentCodec | undefined): unknown {
	if (!codec) return input;
	const raw = readPath(input, codec.argumentsPath).value;
	if (typeof raw !== "string") return UNKNOWN;
	if (Buffer.byteLength(raw, "utf8") > 131072) return UNKNOWN;
	try {
		const value = cloneJson(JSON.parse(raw));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : UNKNOWN;
	} catch {
		return UNKNOWN;
	}
}
export function programFacts(
	rule: ProgramRule,
	context: EvaluationContext,
	input?: unknown,
	original?: unknown,
): Record<string, unknown> {
	const outer = input ?? context.facts?.input;
	const originalOuter = original ?? context.facts?.original ?? outer;
	const codec = rule.program.selector?.codec;
	const args = decoded(outer, codec);
	const operation = codec?.operationPath ? readPath(outer, codec.operationPath).value : context.operation;
	const schemaTruth = codec ? "unknown" : checkToolSchema(context.schema, args);
	return {
		...context.facts,
		tool: context.tool || UNKNOWN,
		operation: operation ?? UNKNOWN,
		input: args ?? UNKNOWN,
		original: decoded(originalOuter, codec) ?? UNKNOWN,
		outer: outer ?? UNKNOWN,
		originalOuter: originalOuter ?? UNKNOWN,
		state: context.states?.[rule.id] ?? context.facts?.state ?? UNKNOWN,
		data: context.data ?? {},
		schema: { valid: schemaTruth === "unknown" ? UNKNOWN : schemaTruth },
	};
}
function applicabilityTruth(rule: ProgramRule, context: EvaluationContext, input?: unknown, original?: unknown): Truth {
	return rule.applicability
		? evaluateCondition(rule.applicability, programFacts(rule, context, input, original))
		: true;
}

/** Capture only rules whose applicability facts authorize this snapshot. */
export function captureProgramEvidence(
	rules: readonly ProgramRule[],
	context: EvaluationContext,
	input?: unknown,
	original?: unknown,
): CommandEvidence {
	const applicable = new Map(rules.map((rule) => [rule.id, applicabilityTruth(rule, context, input, original)]));
	const evidence = captureEvidence(
		rules.filter((rule) => applicable.get(rule.id) === true),
		context.tool,
		input ?? context.facts?.input,
		context.scope ?? { cwd: "" },
	);
	for (const rule of rules) {
		const truth = applicable.get(rule.id) ?? "unknown";
		if (rule.evidence && truth !== true) evidence.set(rule.id, truth);
	}
	return evidence;
}

/** Tool and operation selector truth for one compiled rule. */
function selectorTruth(rule: ProgramRule, context: EvaluationContext, facts: Record<string, unknown>): Truth {
	const program = rule.program;
	if (program.phase !== "context" && program.selector?.tools && !program.selector.tools.includes(context.tool))
		return false;
	if (program.phase !== "context" && program.selector?.operations) {
		const operation = facts.operation;
		const selected: Truth =
			operation === UNKNOWN || typeof operation !== "string"
				? "unknown"
				: program.selector.operations.includes(operation);
		return selected === false ? false : selected === "unknown" ? "unknown" : true;
	}
	return true;
}

/** Evidence, match, and projection-mode gates for one compiled rule. */
function truthGates(rule: ProgramRule, context: EvaluationContext, truth: Truth): Truth {
	const program = rule.program;
	if (truth !== false && rule.evidence) {
		const evidence = context.evidence?.get(rule.id) ?? context.matched?.has(rule.id) ?? "unknown";
		truth = evidence === false ? false : truth === "unknown" || evidence === "unknown" ? "unknown" : true;
	}
	if (truth !== false && program.requiresMatch && !context.matched?.has(rule.id)) truth = false;
	if (
		truth !== false &&
		program.phase !== "input" &&
		program.action.kind === "guide" &&
		rule.projectionModes &&
		!rule.projectionModes.includes(context.mode ?? "enforce")
	)
		truth = false;
	return truth;
}

/** Completed evaluation record with unavailable reasons and denial truth. */
function evaluationResult(
	rule: ProgramRule,
	context: EvaluationContext,
	applicable: Truth,
	truth: Truth,
): ProgramEvaluation {
	const program = rule.program;
	return {
		id: rule.id,
		revision: rule.revision,
		phase: program.phase,
		applicable,
		...(program.phase === "input" ? { inputView: program.inputView ?? "original" } : {}),
		truth,
		action: program.action,
		unavailable: truth === "unknown",
		...(truth === "unknown" && context.evidence?.reasons?.has(rule.id)
			? { unavailableReasons: context.evidence.reasons.get(rule.id) }
			: {}),
		deny:
			applicable === true &&
			((truth === true && program.action.kind === "deny") || (truth === "unknown" && program.onUnavailable === "deny")),
	};
}

function evaluateRule(
	rule: ProgramRule,
	context: EvaluationContext,
	input?: unknown,
	original?: unknown,
): ProgramEvaluation {
	const program = rule.program;
	const facts = programFacts(rule, context, input, original);
	const applicable = applicabilityTruth(rule, context, input, original);
	let truth: Truth = applicable;
	if (truth !== false) {
		const selected = selectorTruth(rule, context, facts);
		truth = selected === false ? false : truth === "unknown" || selected === "unknown" ? "unknown" : true;
	}
	truth = truthGates(rule, context, truth);
	if (truth !== false) {
		const missing = program.data?.some((name) => context.data?.[name]?.status !== "ready");
		if (missing || truth === "unknown") truth = "unknown";
		else truth = evaluateCondition(program.when, facts);
	}
	return evaluationResult(rule, context, applicable, truth);
}
export function observationSelected(rule: ProgramRule, context: EvaluationContext): Truth {
	return evaluateRule(
		{
			...rule,
			program: {
				...rule.program,
				phase: "completion",
				requiresMatch: false,
				when: { op: "exists", path: ["tool"] },
				action: { kind: "observe", label: "state" },
			},
		},
		context,
	).truth;
}
export function evaluatePrograms(
	rules: readonly ProgramRule[],
	phase: ProgramPhase,
	context: EvaluationContext,
): ProgramEvaluation[] {
	if (rules.length > PROGRAM_LIMITS.rules) throw new Error("Too many facts programs");
	return rules
		.flatMap(programSteps)
		.filter((rule) => rule.program.phase === phase)
		.sort((left, right) => left.id.localeCompare(right.id))
		.map((rule) => evaluateRule(rule, context));
}
function overlap(left: readonly string[], right: readonly string[]): boolean {
	return left.slice(0, Math.min(left.length, right.length)).every((part, index) => part === right[index]);
}
function parentAt(input: unknown, path: readonly string[]): Record<string, unknown> | undefined {
	const value = readPath(input, path).value;
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function writeAt(input: unknown, path: readonly string[], value: unknown): boolean {
	if (!validPath(path)) return false;
	const parent = parentAt(input, path.slice(0, -1));
	const key = path.at(-1);
	if (!parent || key === undefined || !Object.hasOwn(parent, key)) return false;
	parent[key] = value;
	return true;
}
interface Patch {
	rule: ProgramRule;
	paths: string[][];
	apply: (input: Record<string, unknown>) => boolean;
}

interface PlanState {
	plan: InputPlan;
	original: Record<string, unknown>;
	ordered: ProgramRule[];
	captured: ProgramRule[];
	rules: readonly ProgramRule[];
	context: EvaluationContext;
	matches: Set<string>;
	originalEvidence: ReadonlyMap<string, Truth>;
}

function freshPlan(): InputPlan {
	return {
		candidate: {},
		changed: false,
		denied: false,
		valid: true,
		evaluations: [],
		problems: [],
		matches: [],
		corrections: [],
	};
}

function captureEvidenceFor(state: PlanState, candidate: Record<string, unknown>): ReadonlyMap<string, Truth> {
	const evidence = captureProgramEvidence(
		state.rules.filter((rule) => !state.context.staleRules?.has(rule.id)),
		state.context,
		candidate,
		state.original,
	);
	for (const [id, truth] of evidence) if (truth === true) state.matches.add(id);
	state.plan.matches = [...state.matches];
	return evidence;
}

function recordRule(
	state: PlanState,
	rule: ProgramRule,
	candidate: Record<string, unknown>,
	evidence?: ReadonlyMap<string, Truth>,
): ProgramEvaluation {
	const evaluation = evaluateRule(
		rule,
		{ ...state.context, evidence: evidence ?? state.originalEvidence },
		candidate,
		state.original,
	);
	state.plan.evaluations.push(evaluation);
	if (evaluation.truth === true) state.matches.add(rule.id);
	state.plan.matches = [...state.matches];
	state.plan.denied ||= evaluation.deny;
	return evaluation;
}

/** Stage-gated patch for one evaluated correction rule, or its plan problem. */
function correctionPatch(
	rule: ProgramRule,
	snapshot: Record<string, unknown>,
	context: EvaluationContext,
): { patch?: Patch; problem?: string; unknownTruth?: boolean } {
	const action = rule.program.action;
	if (action.kind === "rename-key") {
		const parent = parentAt(snapshot, action.path);
		if (!parent || !Object.hasOwn(parent, action.from)) return {};
		if (Object.hasOwn(parent, action.to)) return { problem: `${rule.id}: rename destination exists` };
		const paths = [
			[...action.path, action.from],
			[...action.path, action.to],
		];
		const apply = (value: Record<string, unknown>): boolean => {
			const object = parentAt(value, action.path);
			if (!object || !Object.hasOwn(object, action.from) || Object.hasOwn(object, action.to)) return false;
			object[action.to] = object[action.from];
			delete object[action.from];
			return true;
		};
		return { patch: { rule, paths, apply } };
	}
	if (action.kind !== "substitute") return {};
	const path = action.path;
	const current = readPath(snapshot, path);
	if (!current.exists || current.value === UNKNOWN) return {};
	const lookup = lookupData(context.data?.[action.table], current.value);
	if (lookup.status === "ambiguous") return { problem: `${rule.id}: substitution is ambiguous` };
	if (lookup.status !== "unique") return { unknownTruth: true };
	if (current.value === lookup.value) return {};
	const paths = [path];
	const apply = (value: Record<string, unknown>): boolean => writeAt(value, path, lookup.value);
	return { patch: { rule, paths, apply } };
}

/** Evaluate one correction rule on the stage snapshot and build its pending patch. */
function buildStagePatch(
	state: PlanState,
	stage: "logical-target" | "keys" | "values",
	rule: ProgramRule,
	snapshot: Record<string, unknown>,
	pending: Patch[],
): Patch | undefined {
	const plan = state.plan;
	const action = rule.program.action;
	const actionStage =
		action.kind === "rename-key" ? "keys" : action.kind === "substitute" ? (action.stage ?? "values") : undefined;
	if (actionStage !== stage) return undefined;
	const evaluation = recordRule(state, rule, snapshot);
	if (evaluation.truth !== true) return undefined;
	if (checkToolSchema(state.context.schema, null) === "unknown") {
		evaluation.truth = "unknown";
		evaluation.unavailable = true;
		evaluation.deny = rule.program.onUnavailable === "deny";
		plan.denied ||= evaluation.deny;
		return undefined;
	}
	const built = correctionPatch(rule, snapshot, state.context);
	if (built.unknownTruth) {
		evaluation.truth = "unknown";
		evaluation.unavailable = true;
		evaluation.deny = rule.program.onUnavailable === "deny";
		plan.denied ||= evaluation.deny;
		return undefined;
	}
	if (built.problem) {
		plan.valid = false;
		plan.problems.push(built.problem);
		return undefined;
	}
	const patch = built.patch;
	if (!patch) return undefined;
	if (pending.some((prior) => prior.paths.some((left) => patch.paths.some((right) => overlap(left, right))))) {
		plan.valid = false;
		plan.problems.push(`${rule.id}: conflicting correction writes`);
	}
	return patch;
}

function planCorrectionStage(state: PlanState, stage: "logical-target" | "keys" | "values"): void {
	const plan = state.plan;
	if (plan.denied || !plan.valid) return;
	const snapshot = cloneJson(plan.candidate);
	const patches: Patch[] = [];
	for (const rule of state.ordered) {
		const patch = buildStagePatch(state, stage, rule, snapshot, patches);
		if (patch) patches.push(patch);
	}
	if (!plan.valid || plan.denied) return;
	for (const patch of patches) {
		if (!patch.apply(plan.candidate)) {
			plan.valid = false;
			plan.problems.push(`${patch.rule.id}: invalid correction target`);
			break;
		}
		plan.corrections.push({ id: patch.rule.id, stage, path: patch.paths[0] });
	}
}

function finalizePlan(state: PlanState): void {
	const plan = state.plan;
	if (plan.valid) {
		try {
			plan.candidate = cloneJson(plan.candidate);
		} catch {
			plan.valid = false;
			plan.problems.push("Corrected input exceeds JSON bounds");
		}
	}
	plan.changed = plan.corrections.length > 0;
	if (plan.valid && plan.changed && checkToolSchema(state.context.schema, plan.candidate) !== true) {
		plan.valid = false;
		plan.problems.push("Corrected input fails or lacks the tool schema");
	}
	if (
		state.context.applyCorrections !== false &&
		plan.changed &&
		state.captured.some(
			(rule) =>
				state.context.staleRules?.has(rule.id) &&
				rule.program.action.kind === "deny" &&
				rule.program.inputView === "effective" &&
				applicabilityTruth(rule, state.context, plan.candidate, state.original) === true &&
				(!rule.program.selector?.tools || rule.program.selector.tools.includes(state.context.tool)),
		)
	) {
		plan.valid = false;
		plan.problems.push("Captured final-input rule observation periods changed before candidate validation");
	}
	const effective = state.context.applyCorrections === false || !plan.valid || plan.denied ? state.original : plan.candidate;
	const effectiveEvidence = captureEvidenceFor(state, effective);
	for (const rule of state.ordered.filter(
		(entry) =>
			(entry.program.action.kind === "deny" || entry.program.action.kind === "guide") &&
			entry.program.inputView === "effective",
	))
		recordRule(state, rule, effective, effectiveEvidence);
	if (!plan.valid || plan.denied) {
		plan.candidate = cloneJson(state.original);
		plan.changed = false;
	}
}

/** Fixed stages use fixed snapshots. Any invalid or conflicting write invalidates the whole plan. */
export function planInput(
	rules: readonly ProgramRule[],
	input: Record<string, unknown>,
	context: EvaluationContext,
): InputPlan {
	const plan = freshPlan();
	if (rules.length > PROGRAM_LIMITS.rules) {
		plan.valid = false;
		plan.problems.push("Too many facts programs");
		return plan;
	}
	let original: Record<string, unknown>;
	try {
		original = cloneJson(input);
		plan.candidate = cloneJson(original);
	} catch {
		plan.valid = false;
		plan.problems.push("Input is unavailable or exceeds JSON bounds");
		return plan;
	}
	const captured = rules.flatMap(programSteps).filter((rule) => rule.program.phase === "input");
	const ordered = captured
		.filter((rule) => !context.staleRules?.has(rule.id))
		.sort((left, right) => left.id.localeCompare(right.id));
	if (
		ordered.some(
			(rule) =>
				validateFactsProgram(rule.program) ||
				(rule.applicability && validateApplicability(rule.applicability, rule.program)),
		)
	) {
		plan.valid = false;
		plan.problems.push("Invalid facts program");
		return plan;
	}
	const state: PlanState = {
		plan,
		original,
		ordered,
		captured,
		rules,
		context,
		matches: new Set(),
		originalEvidence: new Map(),
	};
	state.originalEvidence = captureEvidenceFor(state, original);
	for (const rule of ordered.filter(
		(entry) =>
			(entry.program.action.kind === "deny" || entry.program.action.kind === "guide") &&
			entry.program.inputView !== "effective",
	))
		recordRule(state, rule, original);
	for (const stage of ["logical-target", "keys", "values"] as const) planCorrectionStage(state, stage);
	finalizePlan(state);
	return plan;
}
