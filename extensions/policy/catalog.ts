/** Installed policies share purpose, declared authority, and one execution contract. */
import { actionEffect, packageRowRevision, type PackageDefinitionRow } from "./rule.ts";
import type { FactsProgram } from "./program.ts";
import { RULES } from "./shell-rules.ts";

/** Conservative intervention bounds, not estimates of an optimal workload. */
export const DEFAULT_LIMITS = {
	errorCount: 3,
	periodMs: 300_000,
	outputBytes: 65_536,
	outputEvents: 16,
} as const;
export const RESULT_ERROR_SCHEMA = "policy.result-errors";

function row(definition: Omit<PackageDefinitionRow, "revision">): PackageDefinitionRow {
	return { ...definition, revision: packageRowRevision(definition) };
}
function policy(id: string, purpose: string, note: string, program: FactsProgram): PackageDefinitionRow {
	return row({
		id,
		purpose,
		authority: "exact",
		matcher: { kind: "declarative", language: "facts/v1", spec: program },
		effect: actionEffect(program.action),
		note,
	});
}
const commandPurpose: Record<string, string> = {
	routing: "Use an appropriate reader or direct command input for the requested information.",
	form: "Use purpose-built commands and explicit traversal scope.",
	bounds: "Keep discovery and text output within explicit limits.",
};

const READER_RULES = new Set([
	"routing.cat-read",
	"routing.sed-slice",
	"routing.head-slice",
	"routing.tail-slice",
	"routing.inline-script-read",
]);

export const PACKAGE_CATALOG: PackageDefinitionRow[] = [
	...RULES.map((rule) =>
		row({
			id: rule.id,
			purpose: commandPurpose[rule.id.split(".")[0]],
			authority: "steer-or-block",
			matcher: { kind: "code", key: rule.key },
			...(READER_RULES.has(rule.id)
				? { applicability: { op: "eq" as const, path: ["context", "tools", "read", "active"], value: true } }
				: {}),
			effect: "block",
			note: rule.note,
		}),
	),
	policy(
		"arguments.schema",
		"Keep the final tool arguments within the tool's declared schema.",
		"The final arguments violate the available tool schema. Use the declared parameter names and value types.",
		{
			phase: "input",
			inputView: "effective",
			when: { op: "eq", path: ["schema", "valid"], value: false },
			action: { kind: "deny" },
			onUnavailable: "skip",
		},
	),
	policy(
		"results.declared-error",
		"Preserve failure semantics defined by an approved result contract.",
		"The result matches the operator-approved failure schema.",
		{
			phase: "result",
			data: [RESULT_ERROR_SCHEMA],
			when: { op: "matches-schema", path: ["result"], schemaData: RESULT_ERROR_SCHEMA },
			action: { kind: "assert-error" },
			onUnavailable: "skip",
		},
	),
	policy(
		"recovery.repeated-errors",
		"Reconsider the approach after repeated failed tool executions.",
		"Recent tool executions failed repeatedly. Check the errors and revise the arguments or approach before another attempt.",
		{
			phase: "context",
			when: { op: "gte", path: ["state", "windowCount"], value: DEFAULT_LIMITS.errorCount },
			state: {
				observe: { op: "eq", path: ["outcome", "kind"], value: "execution-error" },
				resetWhen: { op: "eq", path: ["outcome", "kind"], value: "success" },
				window: { maxEvents: DEFAULT_LIMITS.errorCount, maxAgeMs: DEFAULT_LIMITS.periodMs },
				expiresAfterMs: DEFAULT_LIMITS.periodMs,
				once: "period",
			},
			action: {
				kind: "guide",
				text: "Recent tool executions failed repeatedly. Check the errors and revise the arguments or approach before another attempt.",
			},
			onUnavailable: "skip",
		},
	),
	policy(
		"resources.output-volume",
		"Limit repeated large text results before they consume more context.",
		"Recent tool results contain substantial text. Narrow the requested fields, paths, or result count before the next tool call.",
		{
			phase: "context",
			when: { op: "gte", path: ["state", "windowTotal"], value: DEFAULT_LIMITS.outputBytes },
			state: {
				observe: { op: "eq", path: ["outcome", "executed"], value: true },
				totalPath: ["outcome", "preGuidanceBytes"],
				window: { maxEvents: DEFAULT_LIMITS.outputEvents, maxAgeMs: DEFAULT_LIMITS.periodMs },
				expiresAfterMs: DEFAULT_LIMITS.periodMs,
				once: "period",
			},
			action: {
				kind: "guide",
				text: "Recent tool results contain substantial text. Narrow the requested fields, paths, or result count before the next tool call.",
			},
			onUnavailable: "skip",
		},
	),
];
