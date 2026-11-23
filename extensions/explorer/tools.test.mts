import assert from "node:assert/strict";
import { test } from "node:test";
import { showGuidance } from "./tools.ts";

test("interactive coordinator shows code while workers report locations", () => {
	for (const pane of ["float", "split"] as const) {
		const guidance = showGuidance(pane);
		assert.match(guidance, /work for another agent or run without an interactive conversation/u);
		assert.match(guidance, /In the interactive session with the operator/u);
		assert.match(guidance, /report the file paths and line ranges/u);
	}
});
