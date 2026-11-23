import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
const reader = {} as ReaderCoreAPI;
runInNewContext(stripTypeScriptTypes(readFileSync(new URL("./review-comments.ts", import.meta.url), "utf8")), {
	reader,
});
const row: ReaderReviewComment = {
	commentId: "thread:1",
	threadId: "thread",
	ordinal: 1,
	kind: "annotation",
	text: "Revise this.",
	commentState: "open",
	version: 1,
};
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
