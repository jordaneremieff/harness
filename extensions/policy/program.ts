/** Closed facts grammar and private correction plans. No action commits occur here. */
import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import {
	checkSchema,
	cloneJson,
	DataNameSchema,
	lookupData,
	readPath,
	safeKey,
	ScalarSchema,
	UNKNOWN,
	validPath,
	type DataSnapshot,
	type Scalar,
	type Truth,
} from "./data.ts";
import type { StateView } from "./state.ts";

export { UNKNOWN } from "./data.ts";
export type { Truth } from "./data.ts";
export const RULE_CAPACITY = { package: 1024, local: 256, active: 1280 } as const;
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
	schemaData?: string;
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
			description: `A nested condition using the same closed grammar: exactly one of {all:[conditions]}, {any:[conditions]}, {not:condition}, or {op,path,value?,table?}. Use the parent's leaf operators and field types. All/any arrays have 1-${PROGRAM_LIMITS.children} children. Conditions share a ${PROGRAM_LIMITS.nodes}-node budget across when, observe, and resetWhen; maximum nesting depth is ${PROGRAM_LIMITS.depth} from each root. Every nested object receives strict local validation.`,
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
									schemaData: Type.Optional(DataNameSchema),
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
const roots = new Set([
	"input",
	"original",
	"result",
	"outcome",
	"state",
	"tool",
	"operation",
	"schema",
	"data",
	"context",
]);

function conditionError(condition: Condition, budget: { nodes: number }, depth = 0): string | undefined {
	if (++budget.nodes > PROGRAM_LIMITS.nodes || depth > PROGRAM_LIMITS.depth) return "Condition exceeds grammar bounds";
	if ("all" in condition || "any" in condition) {
		for (const child of "all" in condition ? condition.all : condition.any) {
			const error = conditionError(child, budget, depth + 1);
			if (error) return error;
		}
		return undefined;
	}
	if ("not" in condition) return conditionError(condition.not, budget, depth + 1);
	if (!validPath(condition.path) || !roots.has(condition.path[0]))
		return "Condition requires a safe declared fact path";
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

export function validateFactsProgram(value: unknown): string | undefined {
	try {
		const copied = cloneJson(value);
		if (!programValidator.Check(copied)) return "Invalid facts program shape";
		const program = copied as FactsProgram;
		const budget = { nodes: 0 };
		for (const condition of [program.when, program.state?.observe, program.state?.resetWhen]) {
			if (condition) {
				const error = conditionError(condition, budget);
				if (error) return error;
			}
		}
		if (program.state?.totalPath && (!validPath(program.state.totalPath) || !roots.has(program.state.totalPath[0])))
			return "Invalid aggregate total path";
		const { action, phase, selector } = program;
		if (phase === "context" && selector && !program.state) return "Context selectors require an observation state";
		if (
			action.kind === "guide" &&
			(!action.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim() ||
				Buffer.byteLength(`${GUIDANCE_PREFIX} ${action.text}`, "utf8") > GUIDANCE_BYTES)
		)
			return "Guidance exceeds its UTF-8 projection bound or has no text";
		const permitted: Record<ProgramAction["kind"], ProgramPhase[]> = {
			deny: ["input"],
			"rename-key": ["input"],
			substitute: ["input"],
			"assert-error": ["result"],
			guide: ["result", "context"],
			observe: ["completion"],
		};
		if (!permitted[action.kind].includes(phase)) return "Action is unavailable in this phase";
		if (program.onUnavailable === "deny" && phase !== "input") return "Unavailable denial requires the input phase";
		if (program.inputView && phase !== "input") return "inputView requires the input phase";
		if (program.inputView === "effective" && action.kind !== "deny")
			return "Only a denial uses an effective-input gate";
		if ("path" in action && !validPath(action.path, action.kind === "rename-key")) return "Unsafe correction path";
		if (action.kind === "rename-key" && (!safeKey(action.from) || !safeKey(action.to) || action.from === action.to))
			return "Invalid key rename";
		if (
			selector?.codec &&
			(!validPath(selector.codec.argumentsPath) ||
				(selector.codec.operationPath && !validPath(selector.codec.operationPath)))
		)
			return "Unsafe codec path";
		const bindings = new Set(program.data ?? []);
		if (action.kind === "substitute" && !bindings.has(action.table))
			return "Substitution table requires a declared data binding";
		if (selector?.codec?.schemaData && !bindings.has(selector.codec.schemaData))
			return "Codec schema requires a declared data binding";
		const checkBindings = (condition: Condition): boolean =>
			"all" in condition
				? condition.all.every(checkBindings)
				: "any" in condition
					? condition.any.every(checkBindings)
					: "not" in condition
						? checkBindings(condition.not)
						: condition.op !== "lookup" || bindings.has(condition.table ?? "");
		if (
			![program.when, program.state?.observe, program.state?.resetWhen].every((entry) => !entry || checkBindings(entry))
		)
			return "Lookup requires a declared data binding";
		return undefined;
	} catch {
		return "Facts program exceeds bounds or contains unsafe JSON";
	}
}

/** Kleene logic preserves unavailable evidence under negation and composition. */
export function evaluateCondition(condition: Condition, facts: Record<string, unknown>): Truth {
	const budget = { nodes: 0 };
	const evaluate = (entry: Condition, depth: number): Truth => {
		if (++budget.nodes > PROGRAM_LIMITS.nodes || depth > PROGRAM_LIMITS.depth) return "unknown";
		if ("not" in entry) {
			const truth = evaluate(entry.not, depth + 1);
			return truth === "unknown" ? truth : !truth;
		}
		if ("all" in entry || "any" in entry) {
			const children = "all" in entry ? entry.all : entry.any;
			if (!children.length || children.length > PROGRAM_LIMITS.children) return "unknown";
			const values = children.map((child) => evaluate(child, depth + 1));
			if ("all" in entry) return values.includes(false) ? false : values.includes("unknown") ? "unknown" : true;
			return values.includes(true) ? true : values.includes("unknown") ? "unknown" : false;
		}
		const found = readPath(facts, entry.path);
		if (found.value === UNKNOWN) return "unknown";
		if (entry.op === "exists") return found.exists;
		if (!found.exists || found.value === undefined) return "unknown";
		const value = found.value;
		const expected = entry.value;
		switch (entry.op) {
			case "eq":
				return value === expected;
			case "in":
				return Array.isArray(expected) ? expected.some((candidate) => candidate === value) : "unknown";
			case "type":
				return expected === "null"
					? value === null
					: expected === "array"
						? Array.isArray(value)
						: expected === "object"
							? typeof value === "object" && value !== null && !Array.isArray(value)
							: expected === "integer"
								? typeof value === "number" && Number.isInteger(value)
								: typeof value === expected;
			case "gt":
				return typeof value === "number" && typeof expected === "number" && value > expected;
			case "gte":
				return typeof value === "number" && typeof expected === "number" && value >= expected;
			case "lt":
				return typeof value === "number" && typeof expected === "number" && value < expected;
			case "lte":
				return typeof value === "number" && typeof expected === "number" && value <= expected;
			case "starts-with":
				return typeof value === "string" && typeof expected === "string" && value.startsWith(expected);
			case "ends-with":
				return typeof value === "string" && typeof expected === "string" && value.endsWith(expected);
			case "contains":
				return typeof value === "string" && typeof expected === "string" && value.includes(expected);
			case "lookup": {
				const data = readPath(facts, ["data", entry.table ?? ""]);
				const lookup = lookupData(data.value as DataSnapshot | undefined, value);
				return lookup.status === "unavailable" ? "unknown" : lookup.status === expected;
			}
		}
	};
	try {
		return evaluate(condition, 0);
	} catch {
		return "unknown";
	}
}

export interface ProgramRule {
	id: string;
	revision: string;
	program: FactsProgram;
}
export interface EvaluationContext {
	tool: string;
	operation?: string;
	facts?: Record<string, unknown>;
	data?: Record<string, DataSnapshot>;
	states?: Record<string, StateView>;
	schema?: unknown;
	now?: number;
	/** False keeps candidate effects hypothetical and checks effective gates on actual input. */
	applyCorrections?: boolean;
}
export interface ProgramEvaluation {
	id: string;
	revision: string;
	truth: Truth;
	action: ProgramAction;
	unavailable: boolean;
	deny: boolean;
}
export interface InputPlan {
	candidate: Record<string, unknown>;
	changed: boolean;
	denied: boolean;
	valid: boolean;
	evaluations: ProgramEvaluation[];
	problems: string[];
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
function schemaFor(program: FactsProgram, context: EvaluationContext): unknown {
	const codec = program.selector?.codec;
	if (!codec) return context.schema;
	const binding = codec.schemaData ? context.data?.[codec.schemaData] : undefined;
	return binding?.status === "ready" && binding.data?.kind === "schema" ? binding.data.schema : undefined;
}
export function programFacts(
	rule: ProgramRule,
	context: EvaluationContext,
	input?: unknown,
	original?: unknown,
): Record<string, unknown> {
	const outer = input ?? context.facts?.input;
	const codec = rule.program.selector?.codec;
	const args = decoded(outer, codec);
	const operation = codec?.operationPath ? readPath(outer, codec.operationPath).value : context.operation;
	const schemaTruth = checkSchema(schemaFor(rule.program, context), args);
	return {
		...context.facts,
		tool: context.tool || UNKNOWN,
		operation: operation ?? UNKNOWN,
		input: args ?? UNKNOWN,
		original: decoded(original ?? context.facts?.original ?? outer, codec) ?? UNKNOWN,
		state: context.states?.[rule.id] ?? context.facts?.state ?? UNKNOWN,
		data: context.data ?? {},
		schema: { valid: schemaTruth === "unknown" ? UNKNOWN : schemaTruth },
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
	let truth: Truth = true;
	if (program.phase !== "context" && program.selector?.tools && !program.selector.tools.includes(context.tool))
		truth = false;
	if (program.phase !== "context" && truth !== false && program.selector?.operations) {
		const operation = facts.operation;
		truth =
			operation === UNKNOWN || typeof operation !== "string"
				? "unknown"
				: program.selector.operations.includes(operation);
	}
	if (truth !== false) {
		const missing = program.data?.some((name) => context.data?.[name]?.status !== "ready");
		if (missing || truth === "unknown") truth = "unknown";
		else truth = evaluateCondition(program.when, facts);
	}
	return {
		id: rule.id,
		revision: rule.revision,
		truth,
		action: program.action,
		unavailable: truth === "unknown",
		deny:
			(truth === true && program.action.kind === "deny") || (truth === "unknown" && program.onUnavailable === "deny"),
	};
}
export function evaluatePrograms(
	rules: readonly ProgramRule[],
	phase: ProgramPhase,
	context: EvaluationContext,
): ProgramEvaluation[] {
	if (rules.length > PROGRAM_LIMITS.rules) throw new Error("Too many facts programs");
	return rules
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
	if (!parent || !Object.hasOwn(parent, path.at(-1)!)) return false;
	parent[path.at(-1)!] = value;
	return true;
}
interface Patch {
	rule: ProgramRule;
	paths: string[][];
	apply: (input: Record<string, unknown>) => boolean;
	check?: (input: Record<string, unknown>) => Truth;
}

/** Fixed stages use fixed snapshots. Any invalid or conflicting write invalidates the whole plan. */
export function planInput(
	rules: readonly ProgramRule[],
	input: Record<string, unknown>,
	context: EvaluationContext,
): InputPlan {
	const plan: InputPlan = {
		candidate: {},
		changed: false,
		denied: false,
		valid: true,
		evaluations: [],
		problems: [],
		corrections: [],
	};
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
	const ordered = rules
		.filter((rule) => rule.program.phase === "input")
		.sort((left, right) => left.id.localeCompare(right.id));
	if (ordered.some((rule) => validateFactsProgram(rule.program))) {
		plan.valid = false;
		plan.problems.push("Invalid facts program");
		return plan;
	}
	const finalChecks: Patch[] = [];
	const record = (rule: ProgramRule, candidate: Record<string, unknown>): ProgramEvaluation => {
		const evaluation = evaluateRule(rule, context, candidate, original);
		plan.evaluations.push(evaluation);
		plan.denied ||= evaluation.deny;
		return evaluation;
	};
	for (const rule of ordered.filter(
		(entry) => entry.program.action.kind === "deny" && entry.program.inputView !== "effective",
	))
		record(rule, original);
	if (plan.denied) return plan;
	for (const stage of ["logical-target", "keys", "values"] as const) {
		const snapshot = cloneJson(plan.candidate);
		const patches: Patch[] = [];
		for (const rule of ordered) {
			const action = rule.program.action;
			const actionStage =
				action.kind === "rename-key" ? "keys" : action.kind === "substitute" ? (action.stage ?? "values") : undefined;
			if (actionStage !== stage) continue;
			const evaluation = record(rule, snapshot);
			if (evaluation.truth !== true || (action.kind !== "rename-key" && action.kind !== "substitute")) continue;
			if (checkSchema(context.schema, null) === "unknown") {
				evaluation.truth = "unknown";
				evaluation.unavailable = true;
				evaluation.deny = rule.program.onUnavailable === "deny";
				plan.denied ||= evaluation.deny;
				continue;
			}
			const codec = stage === "logical-target" ? undefined : rule.program.selector?.codec;
			const target = decoded(snapshot, codec);
			if (target === UNKNOWN || (codec && checkSchema(schemaFor(rule.program, context), null) === "unknown")) {
				evaluation.truth = "unknown";
				evaluation.unavailable = true;
				evaluation.deny = rule.program.onUnavailable === "deny";
				plan.denied ||= evaluation.deny;
				continue;
			}
			let paths: string[][];
			let change: (value: unknown) => boolean;
			if (action.kind === "rename-key") {
				const parent = parentAt(target, action.path);
				if (!parent || !Object.hasOwn(parent, action.from)) continue;
				if (Object.hasOwn(parent, action.to)) {
					plan.valid = false;
					plan.problems.push(`${rule.id}: rename destination exists`);
					continue;
				}
				paths = [
					[...action.path, action.from],
					[...action.path, action.to],
				];
				change = (value) => {
					const object = parentAt(value, action.path);
					if (!object || !Object.hasOwn(object, action.from) || Object.hasOwn(object, action.to)) return false;
					object[action.to] = object[action.from];
					delete object[action.from];
					return true;
				};
			} else {
				const current = readPath(target, action.path);
				if (!current.exists || current.value === UNKNOWN) continue;
				const lookup = lookupData(context.data?.[action.table], current.value);
				if (lookup.status === "ambiguous") {
					plan.valid = false;
					plan.problems.push(`${rule.id}: substitution is ambiguous`);
					continue;
				}
				if (lookup.status !== "unique") {
					evaluation.truth = "unknown";
					evaluation.unavailable = true;
					evaluation.deny = rule.program.onUnavailable === "deny";
					plan.denied ||= evaluation.deny;
					continue;
				}
				if (current.value === lookup.value) continue;
				paths = [action.path];
				change = (value) => writeAt(value, action.path, lookup.value);
			}
			const physicalPaths = codec ? paths.map((path) => [...codec.argumentsPath, ...path]) : paths;
			const patch: Patch = {
				rule,
				paths: physicalPaths,
				apply: (value) => {
					if (!codec) return change(value);
					const args = decoded(value, codec);
					if (args === UNKNOWN || !change(args)) return false;
					return writeAt(value, codec.argumentsPath, JSON.stringify(args));
				},
				...(codec
					? {
							check: (value: Record<string, unknown>) =>
								checkSchema(schemaFor(rule.program, context), decoded(value, codec)),
						}
					: {}),
			};
			if (patches.some((prior) => prior.paths.some((left) => patch.paths.some((right) => overlap(left, right))))) {
				plan.valid = false;
				plan.problems.push(`${rule.id}: conflicting correction writes`);
			}
			patches.push(patch);
		}
		if (!plan.valid || plan.denied) break;
		for (const patch of patches) {
			if (!patch.apply(plan.candidate)) {
				plan.valid = false;
				plan.problems.push(`${patch.rule.id}: invalid correction target`);
				break;
			}
			plan.corrections.push({ id: patch.rule.id, stage, path: patch.paths[0] });
		}
		finalChecks.push(...patches);
		if (!plan.valid) break;
	}
	if (plan.valid) {
		try {
			plan.candidate = cloneJson(plan.candidate);
		} catch {
			plan.valid = false;
			plan.problems.push("Corrected input exceeds JSON bounds");
		}
	}
	if (plan.valid)
		for (const patch of finalChecks) {
			if (patch.check && patch.check(plan.candidate) !== true) {
				plan.valid = false;
				plan.problems.push(`${patch.rule.id}: decoded arguments fail the approved schema`);
			}
		}
	plan.changed = plan.corrections.length > 0;
	if (plan.valid && plan.changed && checkSchema(context.schema, plan.candidate) !== true) {
		plan.valid = false;
		plan.problems.push("Corrected input fails or lacks the tool schema");
	}
	if (plan.valid || context.applyCorrections === false)
		for (const rule of ordered.filter(
			(entry) => entry.program.action.kind === "deny" && entry.program.inputView === "effective",
		))
			record(rule, context.applyCorrections === false ? original : plan.candidate);
	if (!plan.valid || plan.denied) {
		plan.candidate = cloneJson(original);
		plan.changed = false;
	}
	return plan;
}
