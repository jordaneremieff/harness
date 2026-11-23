import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { plain, scripts } from "../../test/load.mts";
const { reader } = scripts(
	["app/core/exact.ts", "app/ui/logic.ts", "app/ui/ask-state.ts", "app/ui/review-comments.ts"],
	{ reader: {} },
);
const row: ReaderReviewComment = {
	commentId: "thread:1",
	threadId: "thread",
	ordinal: 1,
	kind: "annotation",
	text: "Revise this.",
	commentState: "open",
	version: 1,
};
test("a restored closed comment does not mark a later lookalike when reopened", () => {
	const sessions = reader.createAskSessions();
	const source = "# Scope\nStatus ready today.\n\nEnd.",
		start = source.indexOf("ready"),
		end = start + 5;
	const view = (text: string): ReaderPassageView => ({
		blocks: [
			{ key: "heading", type: "heading1", start: 0, end: 7 },
			{ key: "body", type: "paragraph", start: 8, end: text.length },
		],
	});
	const owner = sessions.show("doc", source, "digest"),
		originalView = view(source);
	sessions.render(originalView);
	const passageAnchor = reader.uiLogic.capturePassage(source, { start, end }, originalView),
		original = { ...row, start, end, quote: "ready", sourceAnchor: "ready", passageAnchor, anchorDigest: "digest" };
	// The first row read from storage is already closed. No previous open card seeded a mark.
	assert.equal(reader.reviewMarkRange(sessions, owner, { ...original, commentState: "closed", version: 2 }), undefined);
	const erased = source.replace("ready", "gone");
	sessions.change([{ start, end, expected: "ready", text: "gone" }], erased);
	sessions.render(view(erased));
	const appended = "\n\nStatus ready today.",
		revised = erased + appended;
	sessions.change([{ start: erased.length, end: erased.length, expected: "", text: appended }], revised);
	sessions.render(view(revised));
	assert.deepEqual(plain(reader.uiLogic.reanchorPassage(revised, passageAnchor, view(revised))), {
		start: revised.indexOf("ready"),
		end: revised.indexOf("ready") + 5,
	});
	assert.equal(reader.reviewMarkRange(sessions, owner, { ...original, commentState: "open", version: 3 }), undefined);
});
function fixture() {
	let key: string | null = "A";
	const calls: {
		type: string;
		fields: Record<string, unknown>;
		resolve: (v: unknown) => void;
		reject: (reason: Error) => void;
	}[] = [];
	const host = {
		request: (type: string, fields: Record<string, unknown>) =>
			new Promise((resolve, reject) => calls.push({ type, fields, resolve, reject })),
	} as ReaderCoreHost;
	const warnings: string[] = [];
	const state = reader.createReviewCollection(
		host,
		() => key,
		() => {},
		(text) => warnings.push(text),
	);
	return {
		state,
		calls,
		warnings,
		show: (next: string | null) => {
			key = next;
			return state.refresh();
		},
	};
}
test("a late review sheet cannot replace the latest result, even after a round trip to the same document", async () => {
	const { state, calls, show } = fixture();
	const old = state.refresh(),
		away = show("B"),
		back = show("A"),
		latest = state.refresh();
	calls[3].resolve({ available: true, comments: [row] });
	await latest;
	calls[2].resolve({ available: true, comments: [] });
	calls[1].resolve({ available: true, comments: [] });
	calls[0].resolve({ available: false });
	await Promise.all([old, away, back]);
	assert.equal(state.rows.get(row.commentId), row);
	assert.equal(state.privateOnly, false);
	const lost = state.refresh();
	await show(null);
	assert.equal(state.rows.size, 0);
	assert.equal(state.privateOnly, true);
	calls[4].resolve({ available: true, comments: [row] });
	await lost;
	assert.equal(state.rows.size, 0);
});
test("a version refusal reloads the saved status without dispatching a prompt or guessing the next version", async () => {
	const { state, calls, warnings } = fixture();
	const load = state.refresh();
	calls[0].resolve({ available: true, comments: [row] });
	await load;
	const set = state.set(row, "closed");
	assert.equal(calls[1].type, "command");
	assert.deepEqual(JSON.parse(JSON.stringify(calls[1].fields)), {
		name: "setReviewComment",
		args: { documentKey: "A", commentId: "thread:1", commentState: "closed", expectedVersion: 1 },
	});
	calls[1].resolve({ status: "stale", message: "Changed in another pane." });
	await setImmediate();
	assert.equal(calls[2].type, "query");
	assert.equal(state.rows.get(row.commentId)?.commentState, "open");
	const updated = { ...row, commentState: "closed", version: 2 };
	calls[2].resolve({ available: true, comments: [updated] });
	await set;
	assert.equal(state.rows.get(row.commentId), updated);
	assert.equal(warnings[0], "Changed in another pane.");
	await state.set(row, "open");
	assert.equal(calls.length, 3);
});
test("a failed refresh keeps confirmed rows, blocks writes, and never offers private status until the host confirms it", async () => {
	const { state, calls } = fixture();
	const load = state.refresh();
	calls[0].resolve({ available: true, comments: [row] });
	await load;
	const fail = state.refresh();
	calls[1].reject(new Error("transport"));
	await fail;
	assert.equal(state.rows.get(row.commentId), row);
	assert.equal(state.privateOnly, false);
	assert.equal(state.readFailed, true);
	await state.set(row, "closed");
	assert.equal(calls.length, 2);
	const retry = state.refresh();
	calls[2].resolve({ available: false, comments: [] });
	await retry;
	assert.equal(state.privateOnly, true);
	assert.equal(state.rows.size, 0);
	assert.equal(state.readFailed, false);
});
