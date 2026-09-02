import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PROMOTION_CRITERIA_SOURCE,
	evaluateWarrant,
	formatPromotionCriteria,
	resolvePromotionMode,
	resolvePromotionModeValue,
	type WarrantEvidence,
} from "./promotion.ts";

const APPROVED_SOURCE =
	"Promote a rule only when the recorded history of its matching calls shows the pattern the rule blocks actually fails. The history must hold enough matching calls to rule out chance, and failures must outnumber successes among those calls. A rule whose matching calls mostly succeed must not promote. A promotion without recorded evidence must be refused. Record the measured evidence, the criteria version, and the judgment with every promotion.";

function evidence(overrides: Partial<WarrantEvidence> = {}): WarrantEvidence {
	return {
		fires: 5,
		errors: 3,
		errorKinds: { timeout: 0, aborted: 0, other: 3 },
		truncated: 0,
		partial: false,
		...overrides,
	};
}

describe("promotion warrant", () => {
	it("requires enough calls and a strict failure majority", () => {
		assert.match(evaluateWarrant(evidence({ fires: 10, errors: 1 })).reasons.join("; "), /do not outnumber/);
		assert.match(evaluateWarrant(evidence({ fires: 10, errors: 5 })).reasons.join("; "), /do not outnumber/);
		assert.deepEqual(evaluateWarrant(evidence({ fires: 5, errors: 3 })), { pass: true, reasons: [] });
		assert.match(evaluateWarrant(evidence({ fires: 4, errors: 4 })).reasons.join("; "), /fewer than 5/);
		const empty = evaluateWarrant(
			evidence({
				fires: 0,
				errors: 0,
				errorKinds: { timeout: 0, aborted: 0, other: 0 },
			}),
		);
		assert.equal(empty.pass, false);
		assert.match(empty.reasons.join("; "), /fewer than 5/);
	});

	it("refuses a partial scan even when the counts otherwise pass", () => {
		const result = evaluateWarrant(evidence({ partial: true }));
		assert.equal(result.pass, false);
		assert.match(result.reasons.join("; "), /scan is partial/);
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
		assert.match(formatted, /version: 1/);
		assert.match(formatted, /at least 5 matching calls/);
		assert.match(formatted, /failures outnumber successes/);
		assert.match(formatted, /partial evidence scan refuses/);
	});
});
