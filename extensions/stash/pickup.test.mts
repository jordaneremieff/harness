import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPickupMessage } from "./pickup.ts";

describe("buildPickupMessage", () => {
	it("injects the selected artifact itself as a self-contained pickup request", () => {
		const message = buildPickupMessage("20260724T120000Z-work", "# Work\n\nContinue from here.\n");
		assert.match(message, /Resume the stashed effort/);
		assert.match(message, /Stash: 20260724T120000Z-work/);
		assert.match(message, /stash_complete.*20260724T120000Z-work/);
		assert.match(message, /# Work\n\nContinue from here\./);
		assert.doesNotMatch(message, /stash_read|look up|fetch the stash/i);
	});

	it("surfaces a project mismatch without changing the current workspace", () => {
		const artifact = '---\nproject: "/recorded/project"\n---\n# Work\n';
		const message = buildPickupMessage("safe-id", artifact, { currentCwd: "/current/project" });
		assert.match(message, /Current workspace \(unchanged\): \/current\/project/);
		assert.match(message, /Recorded stash project: \/recorded\/project/);
		assert.match(message, /differs .* Verify the intended context/);
	});

	it("neutralizes terminal controls before the message reaches the transcript", () => {
		const message = buildPickupMessage("safe-id", "hello\x1b]0;owned\x07");
		assert.match(message, /\\x1b/);
		assert.ok(!message.includes("\x1b"));
	});
});
