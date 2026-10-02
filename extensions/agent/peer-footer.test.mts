import assert from "node:assert/strict";
import { it } from "node:test";
import type { PeerDescriptor } from "./peer-contract.ts";
import { footerText, formatCost, modelText, stateText } from "./peer-footer.ts";

const agent: PeerDescriptor = { id: "agent:a", kind: "agent", name: "reader", cwd: "/work", model: "test/model", thinkingLevel: "high", state: "working", cost: 0.5 };

it("keeps unknown cost unknown and marks a partial reading as a lower bound", () => {
	assert.equal(formatCost(undefined), "$?");
	assert.equal(formatCost(Number.NaN), "$?");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(1.234), "$1.23");
	assert.equal(formatCost(1.234, true), "≥$1.23");
});

it("states model, cost, and state for one peer", () => {
	assert.equal(modelText(agent), "test/model high");
	assert.equal(modelText({ ...agent, model: undefined, thinkingLevel: undefined }), "model unknown");
	assert.equal(stateText("working"), "● working");
	const line = footerText(agent, { mode: "steer", notice: "queued" });
	assert.equal(line, "test/model high · $0.50 · ● working · mode steer · queued");
	const primary = footerText({ ...agent, kind: "primary", state: "primary", cost: undefined, partialCost: undefined }, { mode: "auto" });
	assert.equal(primary, "test/model high · $? · ● live · mode auto");
});
