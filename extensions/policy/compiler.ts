/** Authoring syntax becomes execution steps and closed, batch-captured evidence. */
import { captureFor, CommandEvidence, evaluateCommandRecords, ruleScopeMatches } from "./classify.ts";
export { CommandEvidence } from "./classify.ts";
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
		onUnavailable:
			record.matcher.kind === "declarative" && record.matcher.language === "command-shape/v1"
				? (record.matcher.onUnavailable ?? "skip")
				: "skip",
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
): CommandEvidence {
	const records = rules.flatMap((rule) => (rule.evidence ? [rule.evidence.record] : []));
	if (!records.length) return new CommandEvidence();
	if (tool !== "bash") return new CommandEvidence(records.map((record) => [record.id, false]));
	const captured =
		input !== null && typeof input === "object" && !Array.isArray(input)
			? captureFor(tool, input as Record<string, unknown>)
			: undefined;
	if (captured === undefined) {
		const evidence = new CommandEvidence();
		for (const record of records) {
			const eligible =
				record.definition.state === "active" &&
				record.override?.state !== "disabled" &&
				record.matcherAvailable &&
				ruleScopeMatches(record.definition.scope, scope);
			evidence.set(record.id, eligible ? "unknown" : false);
			if (eligible) evidence.reasons.set(record.id, ["command-unavailable"]);
		}
		return evidence;
	}
	return evaluateCommandRecords(tool, captured, records, scope);
}
