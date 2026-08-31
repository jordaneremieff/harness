import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POLICY_MODES, resolvePolicyMode } from "./mode.ts";

describe("resolvePolicyMode", () => {
	it("observes when the variable is unset, empty, or blank", () => {
		assert.equal(resolvePolicyMode({}), "observe");
		assert.equal(resolvePolicyMode({ PI_POLICY_MODE: "" }), "observe");
		assert.equal(resolvePolicyMode({ PI_POLICY_MODE: "   " }), "observe");
	});

	it("accepts every declared mode, with surrounding space", () => {
		for (const mode of POLICY_MODES) {
			assert.equal(resolvePolicyMode({ PI_POLICY_MODE: mode }), mode);
			assert.equal(resolvePolicyMode({ PI_POLICY_MODE: ` ${mode} ` }), mode);
		}
	});

	it("refuses an unrecognized value and names the accepted set", () => {
		assert.throws(() => resolvePolicyMode({ PI_POLICY_MODE: "block" }), /observe, notice, annotate/);
		assert.throws(() => resolvePolicyMode({ PI_POLICY_MODE: "Observe" }), /received "Observe"/);
	});
});
