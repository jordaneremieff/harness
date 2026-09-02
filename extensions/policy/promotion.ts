/** Promotion evidence criteria and promotion-mode resolution. */

export const PROMOTION_CRITERIA_VERSION = 2;

export const PROMOTION_CRITERIA_SOURCE =
	"Promote a rule only when the recorded history of its matching calls shows that the pattern the rule blocks actually costs. A matching call is harmful when it fails, when its result is truncated, when its output reaches 16 KiB, or when it runs for 10 seconds or more. A call that the policy blocked never ran, so it is not evidence and does not count. The history must hold at least five matching calls that ran, and the harmful calls must outnumber the calls that ran without harm. A rule whose matching calls are mostly cheap and successful must not promote. A promotion without recorded evidence must be refused. The mechanism applies these criteria without a decision in the loop and promotes every rule that passes. It records the measured evidence, the criteria version, and the judgment with every promotion. Lowering a promoted rule stays with the operator.";

export const MIN_WARRANT_FIRES = 5;

/** Output size at which one call's context cost counts as harm. */
export const HARMFUL_OUTPUT_BYTES = 16384;

/** Duration at which one call's wall-clock cost counts as harm. */
export const HARMFUL_DURATION_MS = 10000;

/** Reasons a call counts as harmful, in the order the tally applies them. */
export interface HarmKinds {
	error: number;
	truncated: number;
	output: number;
	duration: number;
}

export interface WarrantEvidence {
	/** Matching calls that ran. A blocked call never ran and is not counted. */
	fires: number;
	harmful: number;
	/** Partition of `harmful`: one harmful call counts under one reason. */
	harmKinds: HarmKinds;
	/** Partition of `harmKinds.error` by the recorded error kind. */
	errorKinds: {
		timeout: number;
		aborted: number;
		other: number;
	};
	partial: boolean;
}

export interface PromotionWarrant extends WarrantEvidence {
	criteria: number;
	pass: boolean;
}

/** A warrant recorded under criteria version 1, kept readable for the audit. */
export interface LegacyPromotionWarrant {
	criteria: number;
	fires: number;
	errors: number;
	errorKinds: {
		timeout: number;
		aborted: number;
		other: number;
	};
	truncated: number;
	partial: boolean;
	pass: boolean;
}

/** Either warrant shape, as the append-only registry may hold both. */
export type RecordedWarrant = PromotionWarrant | LegacyPromotionWarrant;

/** Whether a recorded warrant carries the current measured shape. */
export function isCurrentWarrant(warrant: RecordedWarrant): warrant is PromotionWarrant {
	return "harmful" in warrant;
}

/** Empty evidence: the shape a rule with no recorded history measures to. */
export function emptyEvidence(): WarrantEvidence {
	return {
		fires: 0,
		harmful: 0,
		harmKinds: { error: 0, truncated: 0, output: 0, duration: 0 },
		errorKinds: { timeout: 0, aborted: 0, other: 0 },
		partial: false,
	};
}

/** Judge measured evidence against every promotion criterion. */
export function evaluateWarrant(evidence: WarrantEvidence): { pass: boolean; reasons: string[] } {
	const reasons: string[] = [];
	if (evidence.fires < MIN_WARRANT_FIRES) {
		reasons.push(`fewer than ${MIN_WARRANT_FIRES} matching calls that ran (${evidence.fires})`);
	}
	if (evidence.harmful <= evidence.fires - evidence.harmful) {
		reasons.push(`harmful calls do not outnumber the rest (${evidence.harmful} of ${evidence.fires})`);
	}
	if (evidence.partial) reasons.push("the evidence scan is partial");
	return { pass: reasons.length === 0, reasons };
}

/** One line of measured facts for a refusal, a promotion, or a readiness report. */
export function describeEvidence(evidence: WarrantEvidence): string {
	const { harmKinds } = evidence;
	return [
		`${evidence.fires} matching calls that ran`,
		`${evidence.harmful} harmful`,
		`${harmKinds.error} failed`,
		`${harmKinds.truncated} truncated`,
		`${harmKinds.output} over the output bound`,
		`${harmKinds.duration} over the duration bound`,
		`scan ${evidence.partial ? "partial" : "complete"}`,
	].join(", ");
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
		`- at least ${MIN_WARRANT_FIRES} matching calls that ran`,
		"- harmful calls outnumber the calls that ran without harm",
		`- a call is harmful when it fails, when its result is truncated, when its output reaches ${HARMFUL_OUTPUT_BYTES} bytes, or when it runs for ${HARMFUL_DURATION_MS} milliseconds or more`,
		"- a blocked call is excluded from the tally",
		"- a partial evidence scan refuses",
	].join("\n");
}
