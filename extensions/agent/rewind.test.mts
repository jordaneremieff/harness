import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { planRewind } from "./rewind.ts";

function user(id: string, text: string, parentId: string | null): SessionEntry {
	return {
		id,
		parentId,
		seq: Number(id.slice(1)),
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "message",
		message: { role: "user", content: text },
	} as unknown as SessionEntry;
}

function assistant(id: string, text: string, parentId: string | null): SessionEntry {
	return {
		id,
		parentId,
		seq: Number(id.slice(1)),
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
	} as unknown as SessionEntry;
}

const branch: SessionEntry[] = [
	user("e1", "start the migration", null),
	assistant("e2", "I will use a shared base class", "e1"),
	user("e3", "now wire the second adapter", "e2"),
	assistant("e4", "second adapter wired", "e3"),
	user("e5", "add the tests", "e4"),
];

describe("rewind plans", () => {
	it("drops the target entry with its descendants and restates the later instructions in order", () => {
		const plan = planRewind(branch, "e2", "compose the adapters instead of sharing a base class");
		assert.equal(plan.targetEntryId, "e2");
		assert.equal(plan.droppedCount, 4);
		assert.deepEqual(plan.retainedIntent, ["now wire the second adapter", "add the tests"]);
		assert.match(plan.targetSummary, /assistant message: I will use a shared base class/u);
		assert.match(plan.message, /compose the adapters instead of sharing a base class/u);
		assert.match(plan.message, /1\. now wire the second adapter/u);
		assert.match(plan.message, /2\. add the tests/u);
		assert.match(plan.message, /working tree holds its current state/u);
	});

	it("replaces a corrected instruction instead of restating it", () => {
		const plan = planRewind(branch, "e3", "wire the second adapter behind the existing port");
		assert.deepEqual(plan.retainedIntent, ["add the tests"]);
		assert.doesNotMatch(plan.message, /now wire the second adapter/u);
	});

	it("reports that nothing followed the rewind point", () => {
		const plan = planRewind(branch, "e5", "write property tests, not example tests");
		assert.deepEqual(plan.retainedIntent, []);
		assert.equal(plan.droppedCount, 1);
		assert.match(plan.message, /No later instruction followed the rewind point\./u);
	});

	it("retains actual image attachments with numbered text references", () => {
		const withParts: SessionEntry[] = [
			assistant("e1", "first attempt", null),
			{
				id: "e2",
				parentId: "e1",
				seq: 2,
				timestamp: "2026-01-01T00:00:00.000Z",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "match this layout" }, { type: "image", data: "x", mimeType: "image/png" }] },
			} as unknown as SessionEntry,
		];
		const plan = planRewind(withParts, "e1", "start from the existing layout module");
		assert.deepEqual(plan.retainedIntent, ["match this layout\n[Attached image 1]"]);
		assert.deepEqual(plan.images, [{ type: "image", data: "x", mimeType: "image/png" }]);
	});

	it("retains long instructions and distinguishes recorded extension context", () => {
		const text = "instruction ".repeat(600);
		const entries = [...branch, user("e6", text, "e5"), {
			id: "e7", parentId: "e6", timestamp: "2026-01-01T00:00:00.000Z", type: "custom_message",
			customType: "reference", content: "Inspect the current interface", display: true,
		} as SessionEntry];
		const plan = planRewind(entries, "e2", "Use composition");
		assert.equal(plan.retainedIntent[2], text);
		assert.match(plan.retainedIntent[3], /Recorded extension context \(reference\); not fresh operator authority:/u);
		assert.doesNotMatch(plan.message, /instruction truncated/u);
	});

	it("refuses an entry that is not on the branch and an empty correction", () => {
		assert.throws(() => planRewind(branch, "missing", "do it differently"), /not on this session's current branch/u);
		assert.throws(() => planRewind(branch, "e2", "   "), /requires the corrected decision/u);
	});
});
