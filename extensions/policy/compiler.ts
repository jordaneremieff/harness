/** Authoring syntax becomes execution steps and closed, batch-captured evidence. */
import { captureFor, matchRuleRecords } from "./classify.ts";
import type { Truth } from "./data.ts";
import type { FactsProgram, ProgramRule } from "./program.ts";
import {
	declaredAction,
	effectiveEffect,
	factsProgram,
	permitsEffectChoice,
	ruleGuidance,
	type RuleMatchContext,
	type RuleRecord,
} from "./rule.ts";

export interface RuleEvidence {
	kind: "command";
	record: RuleRecord;
}

/** A rule retains one identity and observation period across all execution steps. */
export function compileRule(record: RuleRecord): ProgramRule {
	const approved = factsProgram(record);
	const effect = effectiveEffect(record);
	if (approved) {
		const program = structuredClone(approved);
		if (permitsEffectChoice(record)) {
			program.action =
				effect === "block"
					? { kind: "deny" }
					: program.action.kind === "guide"
						? program.action
						: { kind: "guide", text: ruleGuidance(record) };
			if (effect === "steer") program.onUnavailable = "skip";
		}
		const guidance = program.phase === "input" && program.action.kind === "guide" ? program.action : undefined;
		return {
			id: record.id,
			revision: record.definition.revision,
			program,
			...(record.definition.applicability ? { applicability: structuredClone(record.definition.applicability) } : {}),
			...(guidance
				? {
						steps: [
							{
								phase: "result" as const,
								...(program.selector ? { selector: program.selector } : {}),
								...(program.data ? { data: program.data } : {}),
								requiresMatch: true,
								when: { op: "eq" as const, path: ["result", "isError"], value: false },
								action: guidance,
								onUnavailable: "skip" as const,
							},
						],
					}
				: {}),
		};
	}
	const action = declaredAction(record);
	const gate: FactsProgram = {
		phase: "input",
		selector: { tools: ["bash"] },
		when: { op: "exists", path: ["input"] },
		action: { kind: "deny" },
		onUnavailable: "skip",
	};
	return {
		id: record.id,
		revision: record.definition.revision,
		...(record.definition.applicability ? { applicability: structuredClone(record.definition.applicability) } : {}),
		evidence: { kind: "command", record: structuredClone(record) },
		program: {
			phase: "result",
			selector: { tools: ["bash"] },
			when: { op: "eq", path: ["result", "isError"], value: false },
			action: { kind: "guide", text: ruleGuidance(record) },
			onUnavailable: "skip",
			state: { observe: { op: "eq", path: ["outcome", "kind"], value: "success" }, once: "period" },
		},
		projectionModes: effect === "block" ? ["annotate"] : ["annotate", "enforce"],
		steps:
			effect === "block" && (action.kind === "deny" || action.kind === "guide")
				? [
						{ ...gate, inputView: "original" },
						{ ...gate, inputView: "effective" },
					]
				: [],
	};
}

/** Parse a snapshot once for every command predicate. No command expands or executes. */
export function captureEvidence(
	rules: readonly ProgramRule[],
	tool: string,
	input: unknown,
	scope: RuleMatchContext,
): Map<string, Truth> {
	const records = rules.flatMap((rule) => (rule.evidence ? [rule.evidence.record] : []));
	if (!records.length) return new Map();
	if (tool !== "bash") return new Map(records.map((record) => [record.id, false]));
	const captured =
		input !== null && typeof input === "object" && !Array.isArray(input)
			? captureFor(tool, input as Record<string, unknown>)
			: undefined;
	if (captured === undefined) return new Map(records.map((record) => [record.id, "unknown"]));
	const matches = new Set(matchRuleRecords(tool, captured, records, scope).map((record) => record.id));
	return new Map(records.map((record) => [record.id, matches.has(record.id)]));
}
