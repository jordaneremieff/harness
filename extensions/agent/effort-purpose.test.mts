import assert from "node:assert/strict";
import { it } from "node:test";
import { EFFORT_PURPOSE_ENTRY, purposeExcerpt, retainedPurpose } from "./effort-purpose.ts";

it("keeps only bounded plain input text, without interpreting kickoff formats", () => {
	assert.equal(purposeExcerpt("  Review\n the\tparser "), "Review the parser");
	assert.equal(Array.from(purposeExcerpt("😀".repeat(300))).length, 256);
	assert.equal(purposeExcerpt("/some-command shared work"), "/some-command shared work");
});

it("restores only its own attributed interactive input record", () => {
	const projection = { type: "custom", customType: EFFORT_PURPOSE_ENTRY, data: { source: "interactive", text: "Review the parser" } };
	assert.deepEqual(retainedPurpose([
		{ type: "message", message: { role: "user", content: "Unattributed input" } },
		{ ...projection, customType: "other" },
		{ ...projection, data: { source: "extension", text: "Generated text" } },
		projection,
	]), { text: "Review the parser", complete: true });
	assert.deepEqual(retainedPurpose([...Array.from({ length: 256 }, () => null), projection]), { complete: false });
	assert.deepEqual(retainedPurpose([]), { complete: true });
});
