import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POLICY_MODES, resolvePolicyModeValue } from "./mode.ts";

describe("ordinary policy mode flag", () => {
	it("accepts every declared mode with surrounding space", () => {
		for (const mode of POLICY_MODES) {
			assert.equal(resolvePolicyModeValue(mode, "--policy-mode"), mode);
			assert.equal(resolvePolicyModeValue(` ${mode} `, "--policy-mode"), mode);
		}
	});
	it("rejects empty and unrecognized flags rather than using machine configuration", () => {
		for (const value of ["", "   ", "rewrite", "Observe"]) {
			assert.throws(() => resolvePolicyModeValue(value, "--policy-mode"), /--policy-mode must be one of/);
		}
	});
});
