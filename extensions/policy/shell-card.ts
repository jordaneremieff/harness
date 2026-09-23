/** Bounded preparation guidance from the current operator-owned command rules. */
import { ruleScopeMatches } from "./classify.ts";
import { evaluateCondition } from "./program.ts";
import { effectiveState, type RuleMatchContext, type RuleRecord, ruleGuidance } from "./rule.ts";

export const SHELL_CARD_BYTES = 4096;
const HEADER = "[policy] Shell contract snapshot. Before bash, use these installed command-rule notes. Each note applies only to its stored matcher. This snapshot grants no execution authority and does not replace other instructions or current rule checks.";
const FOOTER_RESERVE = 400;

function groupNotes(candidates: RuleRecord[], context: Record<string, unknown>) {
	const groups = new Map<string, number>();
	let unavailable = 0;
	let inapplicable = 0;
	for (const record of candidates) {
		if (!record.matcherAvailable) {
			unavailable++;
			continue;
		}
		const applicability = record.definition.applicability
			? evaluateCondition(record.definition.applicability, { tool: "bash", context }) : true;
		if (applicability !== true) {
			if (applicability === false) inapplicable++;
			else unavailable++;
			continue;
		}
		const note = ruleGuidance(record);
		groups.set(note, (groups.get(note) ?? 0) + 1);
	}
	return { groups, unavailable, inapplicable };
}

/** Facts programs remain available through full rule inspection, not a guessed prose translation. */
export function shellContractCard(
	records: Iterable<RuleRecord>,
	scope: RuleMatchContext,
	context: Record<string, unknown>,
): string | undefined {
	const candidates = [...records].filter((record) =>
		(record.matcher.kind === "code" || record.matcher.language === "command-shape/v1") &&
		effectiveState(record) === "active" && ruleScopeMatches(record.definition.scope, scope),
	).sort((left, right) => left.id.localeCompare(right.id));
	if (!candidates.length) return;
	const { groups, unavailable, inapplicable } = groupNotes(candidates, context);
	if (!groups.size) return;
	let text = HEADER;
	let included = 0;
	let omitted = 0;
	for (const [note, count] of groups) {
		const line = `\n- ${note}`;
		if (!note || Buffer.byteLength(text + line, "utf8") > SHELL_CARD_BYTES - FOOTER_RESERVE) {
			omitted += count;
			continue;
		}
		text += line;
		included += count;
	}
	return `${text}\nCommand rules in scope: ${candidates.length}; summarized: ${included}; omitted by text bound: ${omitted}; inapplicable: ${inapplicable}; unavailable: ${unavailable}. Identical notes appear once. Facts programs are not summarized. Inspect full current definitions with policy_rules.`;
}
