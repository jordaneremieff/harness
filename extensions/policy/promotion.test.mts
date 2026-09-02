import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HARMFUL_DURATION_MS,
	HARMFUL_OUTPUT_BYTES,
	PROMOTION_CRITERIA_SOURCE,
	PROMOTION_CRITERIA_VERSION,
	describeEvidence,
	emptyEvidence,
	evaluateWarrant,
	formatPromotionCriteria,
	isCurrentWarrant,
	resolvePromotionMode,
	resolvePromotionModeValue,
	type WarrantEvidence,
} from "./promotion.ts";

const APPROVED_SOURCE =
	"Promote a rule only when the recorded history of its matching calls shows that the pattern the rule blocks actually costs. A matching call is harmful when it fails, when its result is truncated, when its output reaches 16 KiB, or when it runs for 10 seconds or more. A call that the policy blocked never ran, so it is not evidence and does not count. The history must hold at least five matching calls that ran, and the harmful calls must outnumber the calls that ran without harm. A rule whose matching calls are mostly cheap and successful must not promote. A promotion without recorded evidence must be refused. The mechanism applies these criteria without a decision in the loop and promotes every rule that passes. It records the measured evidence, the criteria version, and the judgment with every promotion. Lowering a promoted rule stays with the operator.";

function evidence(overrides: Partial<WarrantEvidence> = {}): WarrantEvidence {
	return {
		fires: 5,
		harmful: 3,
		harmKinds: { error: 3, truncated: 0, output: 0, duration: 0 },
		errorKinds: { timeout: 0, aborted: 0, other: 3 },
		partial: false,
		...overrides,
	};
}

describe("promotion warrant", () => {
	it("requires enough calls that ran and a strict harmful majority", () => {
		assert.match(evaluateWarrant(evidence({ fires: 10, harmful: 1 })).reasons.join("; "), /do not outnumber/);
		assert.match(evaluateWarrant(evidence({ fires: 10, harmful: 5 })).reasons.join("; "), /do not outnumber/);
		assert.deepEqual(evaluateWarrant(evidence({ fires: 10, harmful: 6 })), { pass: true, reasons: [] });
		assert.deepEqual(evaluateWarrant(evidence({ fires: 5, harmful: 3 })), { pass: true, reasons: [] });
		assert.match(evaluateWarrant(evidence({ fires: 4, harmful: 4 })).reasons.join("; "), /fewer than 5/);
		const empty = evaluateWarrant(emptyEvidence());
		assert.equal(empty.pass, false);
		assert.match(empty.reasons.join("; "), /fewer than 5 matching calls that ran \(0\)/);
	});

	it("refuses a partial scan even when the counts otherwise pass", () => {
		const result = evaluateWarrant(evidence({ partial: true }));
		assert.equal(result.pass, false);
		assert.match(result.reasons.join("; "), /scan is partial/);
	});

	it("passes on cost alone, with no failure among the matching calls", () => {
		const costly = evidence({
			harmful: 4,
			harmKinds: { error: 0, truncated: 1, output: 2, duration: 1 },
			errorKinds: { timeout: 0, aborted: 0, other: 0 },
		});
		assert.deepEqual(evaluateWarrant(costly), { pass: true, reasons: [] });
		assert.match(describeEvidence(costly), /5 matching calls that ran, 4 harmful, 0 failed, 1 truncated/);
		assert.match(describeEvidence(costly), /2 over the output bound, 1 over the duration bound, scan complete/);
	});

	it("separates the current warrant shape from the version-1 shape", () => {
		assert.equal(isCurrentWarrant({ criteria: PROMOTION_CRITERIA_VERSION, ...evidence(), pass: true }), true);
		assert.equal(
			isCurrentWarrant({
				criteria: 1,
				fires: 5,
				errors: 3,
				errorKinds: { timeout: 0, aborted: 0, other: 3 },
				truncated: 0,
				partial: false,
				pass: true,
			}),
			false,
		);
	});
});

describe("promotion mode", () => {
	it("resolves explicit values and rejects empty or invalid sources", () => {
		assert.equal(resolvePromotionModeValue("agent", "flag"), "agent");
		assert.equal(resolvePromotionModeValue(" operator ", "flag"), "operator");
		assert.throws(() => resolvePromotionModeValue("", "flag"), /flag.*agent, operator.*received ""/);
		assert.throws(() => resolvePromotionModeValue("auto", "setting"), /setting.*agent, operator.*received "auto"/);
	});

	it("defaults from an unset or empty environment and validates set values", () => {
		assert.equal(resolvePromotionMode({}), "agent");
		assert.equal(resolvePromotionMode({ PI_POLICY_PROMOTION_MODE: "" }), "agent");
		assert.equal(resolvePromotionMode({ PI_POLICY_PROMOTION_MODE: "   " }), "agent");
		assert.equal(resolvePromotionMode({ PI_POLICY_PROMOTION_MODE: "operator" }), "operator");
		assert.throws(
			() => resolvePromotionMode({ PI_POLICY_PROMOTION_MODE: "auto" }),
			/PI_POLICY_PROMOTION_MODE.*agent, operator/,
		);
	});
});

describe("promotion criteria text", () => {
	it("keeps the approved source wording exact and reports every implemented threshold", () => {
		assert.equal(PROMOTION_CRITERIA_SOURCE, APPROVED_SOURCE);
		const formatted = formatPromotionCriteria();
		assert.ok(formatted.includes(PROMOTION_CRITERIA_SOURCE));
		assert.match(formatted, /version: 2/);
		assert.match(formatted, /at least 5 matching calls that ran/);
		assert.match(formatted, /harmful calls outnumber the calls that ran without harm/);
		assert.match(formatted, new RegExp(`output reaches ${HARMFUL_OUTPUT_BYTES} bytes`));
		assert.match(formatted, new RegExp(`runs for ${HARMFUL_DURATION_MS} milliseconds or more`));
		assert.match(formatted, /blocked call is excluded from the tally/);
		assert.match(formatted, /partial evidence scan refuses/);
	});

	it("states the same numbers the approved wording states", () => {
		assert.equal(HARMFUL_OUTPUT_BYTES, 16 * 1024);
		assert.equal(HARMFUL_DURATION_MS, 10 * 1000);
		assert.ok(PROMOTION_CRITERIA_SOURCE.includes("16 KiB"));
		assert.ok(PROMOTION_CRITERIA_SOURCE.includes("10 seconds"));
	});
});
