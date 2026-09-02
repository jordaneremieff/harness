/** Promotion evidence criteria and promotion-mode resolution. */

export const PROMOTION_CRITERIA_VERSION = 1;

export const PROMOTION_CRITERIA_SOURCE =
	"Promote a rule only when the recorded history of its matching calls shows the pattern the rule blocks actually fails. The history must hold enough matching calls to rule out chance, and failures must outnumber successes among those calls. A rule whose matching calls mostly succeed must not promote. A promotion without recorded evidence must be refused. Record the measured evidence, the criteria version, and the judgment with every promotion.";

export const MIN_WARRANT_FIRES = 5;

export interface WarrantEvidence {
	fires: number;
	errors: number;
	errorKinds: {
		timeout: number;
		aborted: number;
		other: number;
	};
	truncated: number;
	partial: boolean;
}

export interface PromotionWarrant extends WarrantEvidence {
	criteria: number;
	pass: boolean;
}

/** Judge measured evidence against every promotion criterion. */
export function evaluateWarrant(evidence: WarrantEvidence): { pass: boolean; reasons: string[] } {
	const reasons: string[] = [];
	if (evidence.fires < MIN_WARRANT_FIRES) {
		reasons.push(`fewer than ${MIN_WARRANT_FIRES} matching calls (${evidence.fires})`);
	}
	if (evidence.errors <= evidence.fires - evidence.errors) {
		reasons.push(`failures do not outnumber successes (${evidence.errors} of ${evidence.fires})`);
	}
	if (evidence.partial) reasons.push("the evidence scan is partial");
	return { pass: reasons.length === 0, reasons };
}

export type PromotionMode = "agent" | "operator";

export const PROMOTION_MODES: readonly PromotionMode[] = ["agent", "operator"];

const DEFAULT_MODE: PromotionMode = "agent";

function isPromotionMode(value: string): value is PromotionMode {
	return (PROMOTION_MODES as readonly string[]).includes(value);
}

/** Resolve one explicit promotion-mode setting, rejecting empty and unrecognized values. */
export function resolvePromotionModeValue(value: string, source: string): PromotionMode {
	const raw = value.trim();
	if (!isPromotionMode(raw)) {
		throw new Error(`${source} must be one of ${PROMOTION_MODES.join(", ")}; received "${raw}"`);
	}
	return raw;
}

/** Promotion mode from `PI_POLICY_PROMOTION_MODE`; `agent` when unset or empty. */
export function resolvePromotionMode(env: NodeJS.ProcessEnv = process.env): PromotionMode {
	const raw = env.PI_POLICY_PROMOTION_MODE?.trim();
	if (raw === undefined || raw === "") return DEFAULT_MODE;
	return resolvePromotionModeValue(raw, "PI_POLICY_PROMOTION_MODE");
}

/** Human-readable source criteria and the checks implemented by this version. */
export function formatPromotionCriteria(): string {
	return [
		`promotion criteria version: ${PROMOTION_CRITERIA_VERSION}`,
		PROMOTION_CRITERIA_SOURCE,
		"implemented checks:",
		`- at least ${MIN_WARRANT_FIRES} matching calls`,
		"- failures outnumber successes",
		"- a partial evidence scan refuses",
	].join("\n");
}
