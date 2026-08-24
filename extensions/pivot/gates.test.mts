import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activePath,
	findForkPoint,
	hasUserMessageAfter,
	PIVOT_CUSTOM_TYPE,
	shouldArm,
	type SessionEntryLike,
} from "./gates.ts";

function message(id: string, parentId: string | null, role = "user"): SessionEntryLike {
	return { id, parentId, type: "message", message: { role } };
}

function custom(id: string, parentId: string | null, customType: string, data: unknown): SessionEntryLike {
	return { id, parentId, type: "custom", customType, data };
}

function other(id: string, parentId: string | null, type: string): SessionEntryLike {
	return { id, parentId, type };
}

const COPIED: SessionEntryLike[] = [
	message("u1", null),
	message("a1", "u1", "assistant"),
	message("u2", "a1"),
	message("a2", "u2", "assistant"),
];

const arm = (input: Parameters<typeof shouldArm>[0]) => shouldArm(input);

describe("pivot arming gates", () => {
	it("never arms without a parent header", () => {
		assert.deepEqual(arm({ hasParent: false, entries: COPIED, leafId: "a2", sessionId: "s1" }), {
			arm: false,
			record: false,
			forkPointLeafId: null,
		});
	});

	it("never arms a lineage-only session with no copied transcript", () => {
		// /new with a parentSession header writes no message entries.
		const entries = [other("x1", null, "session_info")];
		assert.deepEqual(arm({ hasParent: true, entries, leafId: "x1", sessionId: "s1" }), {
			arm: false,
			record: false,
			forkPointLeafId: null,
		});
	});

	it("arms and records the fork point on first start of a fresh fork", () => {
		const result = arm({ hasParent: true, entries: COPIED, leafId: "a2", sessionId: "s1" });
		assert.deepEqual(result, { arm: true, record: true, forkPointLeafId: "a2" });
	});

	it("does not re-record when an entry for this session id already exists", () => {
		const entries = [...COPIED, custom("p1", "a2", PIVOT_CUSTOM_TYPE, { sessionId: "s1", forkPointLeafId: "a2" })];
		const result = arm({ hasParent: true, entries, leafId: "a2", sessionId: "s1" });
		assert.equal(result.record, false);
		assert.equal(result.arm, true);
	});

	it("blocks arming after a user message beyond the fork point", () => {
		const entries = [
			...COPIED,
			custom("p1", "a2", PIVOT_CUSTOM_TYPE, { sessionId: "s1", forkPointLeafId: "a2" }),
			message("m1", "p1"),
		];
		const result = arm({ hasParent: true, entries, leafId: "m1", sessionId: "s1" });
		assert.equal(result.arm, false);
	});

	it("ignores a copied leaf that is itself a user message (interrupted parent redo)", () => {
		// Parent ended with an unanswered user message u3; the fork copies it
		// as its leaf and records it as the fork point. It must not block.
		const entries = [message("u1", null), message("a1", "u1", "assistant"), message("u3", "a1")];
		const result = arm({ hasParent: true, entries, leafId: "u3", sessionId: "s1" });
		assert.deepEqual(result, { arm: true, record: true, forkPointLeafId: "u3" });
		const withEntry = [...entries, custom("p1", "u3", PIVOT_CUSTOM_TYPE, { sessionId: "s1", forkPointLeafId: "u3" })];
		assert.equal(arm({ hasParent: true, entries: withEntry, leafId: "u3", sessionId: "s1" }).arm, true);
	});

	it("counts only message entries beyond the fork point", () => {
		const entries = [
			...COPIED,
			custom("p1", "a2", PIVOT_CUSTOM_TYPE, { sessionId: "s1", forkPointLeafId: "a2" }),
			other("t1", "p1", "thinking_level_change"),
			other("m1", "t1", "model_change"),
			other("i1", "m1", "session_info"),
			custom("c1", "i1", "other-type", {}),
		];
		const result = arm({ hasParent: true, entries, leafId: "c1", sessionId: "s1" });
		assert.equal(result.arm, true);
	});

	it("scopes fork-point lookup to the current session id (fork of a fork)", () => {
		// The parent's pivot entry is copied verbatim into this fork; it must
		// not be adopted as this session's fork point.
		const entries = [
			...COPIED,
			custom("pp1", "a2", PIVOT_CUSTOM_TYPE, { sessionId: "parent-session", forkPointLeafId: "a1" }),
		];
		assert.equal(findForkPoint(entries, "child-session"), undefined);
		const result = arm({ hasParent: true, entries, leafId: "a2", sessionId: "child-session" });
		assert.deepEqual(result, { arm: true, record: true, forkPointLeafId: "a2" });
	});

	it("does not block when the recorded fork point is outside the active path", () => {
		// /tree moved the leaf onto a branch that diverges before the fork
		// point; the copied transcript still precedes the new message.
		const entries = [
			...COPIED,
			custom("p1", "a2", PIVOT_CUSTOM_TYPE, { sessionId: "s1", forkPointLeafId: "a2" }),
			message("b1", "a1"),
		];
		const result = arm({ hasParent: true, entries, leafId: "b1", sessionId: "s1" });
		assert.equal(result.arm, true);
	});

	it("computes the active path root-first from the leaf", () => {
		const path = activePath(COPIED, "a2");
		assert.deepEqual(
			path.map((entry) => entry.id),
			["u1", "a1", "u2", "a2"],
		);
		assert.deepEqual(activePath(COPIED, null), []);
		assert.deepEqual(activePath(COPIED, "missing"), []);
	});

	it("detects user messages strictly after the fork point only", () => {
		assert.equal(hasUserMessageAfter(COPIED, "a2", "a2"), false);
		const extended = [...COPIED, message("m1", "a2")];
		assert.equal(hasUserMessageAfter(extended, "m1", "a2"), true);
		// The fork point itself is a user message; nothing strictly after it.
		assert.equal(hasUserMessageAfter(COPIED, "u2", "u2"), false);
	});
});
