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

	it("delivers an operator note ahead of the artifact and makes it authoritative", () => {
		const message = buildPickupMessage("20260813T120000Z-work", "# Work\n\nWednesday state.\n", {
			note: "The API migration landed Thursday; re-verify the client assumptions.",
		});
		const amendment = message.indexOf("Operator amendment");
		const artifact = message.indexOf("BEGIN STASH ARTIFACT");
		assert.ok(amendment > -1 && artifact > -1 && amendment < artifact, "the amendment must precede the artifact");
		assert.match(message, /amendment wins/);
		assert.match(message, /The API migration landed Thursday/);
	});

	it("omits the amendment block without a note and treats blank notes as absent", () => {
		const plain = buildPickupMessage("safe-id", "# Work\n");
		assert.doesNotMatch(plain, /Operator amendment/);
		const blank = buildPickupMessage("safe-id", "# Work\n", { note: "   " });
		assert.doesNotMatch(blank, /Operator amendment/);
	});

	it("disowns a predecessor when pickup found the stash already active", () => {
		const message = buildPickupMessage("safe-id", "# Work\n", { activatedAt: "20260812T090000Z" });
		assert.match(message, /already active \(activated 20260812T090000Z\).*superseded/s);
		assert.match(message, /You are the current owner/);
		const fresh = buildPickupMessage("safe-id", "# Work\n");
		assert.doesNotMatch(fresh, /already active/);
	});

	it("sanitizes the note and bounds its length", () => {
		const hostile = buildPickupMessage("safe-id", "# Work\n", { note: "ok\x1b]0;pwn\x07" });
		assert.ok(!hostile.includes("\x1b"));
		assert.match(hostile, /\\x1b/);
		assert.throws(() => buildPickupMessage("safe-id", "# Work\n", { note: "x".repeat(20_001) }), /20000 characters/);
	});
});
