/**
 * Prefix stability of ordinary provider requests with the Agent and Stash extensions loaded.
 *
 * The session is a real Pi SDK session over an isolated agent home. The provider is synthetic
 * and records the message array of every request it receives, which is the array after every
 * `context` handler. The comparison covers the conversation messages, which are the messages
 * that the `context` handlers receive and return. No real provider, network, host process, or
 * operator store is used.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { conversation, messageText, noteHead, noteIndexes, ordinarySession } from "../extensions/agent/ordinary-continuity-fixture.mts";
import stash from "../extensions/stash/index.ts";

/**
 * Requires `later` to begin with exactly the conversation messages of `earlier`. A failure names
 * the first differing index and a bounded excerpt of both values.
 */
function assertPrefix(earlierRequest: readonly Message[], laterRequest: readonly Message[], label: string): void {
	const earlier = conversation(earlierRequest), later = conversation(laterRequest);
	assert.ok(later.length > earlier.length, `${label}: the later request has ${later.length} messages, the earlier one ${earlier.length}`);
	const index = earlier.findIndex((message, position) => !isDeepStrictEqual(message, later[position]));
	if (index < 0) return;
	const before = JSON.stringify(earlier[index]), after = JSON.stringify(later[index]);
	let offset = 0;
	while (offset < before.length && before[offset] === after[offset]) offset++;
	const from = Math.max(0, offset - 80);
	assert.fail(`${label}: message ${index} (${earlier[index].role}) differs at serialized offset ${offset}: ${before.slice(from, offset + 240)} became ${after.slice(from, offset + 240)}`);
}

it("keeps each ordinary request a prefix of the next one with Agent and Stash loaded, before and after a compaction", { timeout: 60000 }, async (t) => {
	const store = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
	t.after(() => rmSync(store, { recursive: true, force: true }));
	const stashExtension: ExtensionFactory = (pi) => { stash(pi); };
	const f = await ordinarySession(t, {
		// The session crosses its planning budget and the first continuity threshold of the capacity observer in one turn.
		budget: 100000, after: [stashExtension],
		env: { PI_STASH_DIR: join(store, "stash"), PI_STASH_CHECKPOINT_DIR: join(store, "checkpoints") },
	});
	const retainedNotices = () => f.sessionManager.getEntries().flatMap((entry) => entry.type === "custom_message" ? [entry.customType] : []);

	f.script.push({ tool: ["agent_send", { sessionId: f.target, message: "Open task" }], tokens: 1000 }, { tool: ["probe", {}], tokens: 111000 }, { text: "FIRST_DONE", tokens: 111500 });
	const first = (await f.prompt("First input")).map((request) => request.messages);
	assert.equal(first.length, 3);
	assertPrefix(first[0], first[1], "request 1 to 2");
	assertPrefix(first[1], first[2], "request 2 to 3");
	const [second] = (await f.prompt("Second input")).map((request) => request.messages);
	assertPrefix(first[2], second, "request 3 to 4");
	for (const request of [...first, second]) assert.deepEqual(noteIndexes(request), [], "no compaction summary means no note");
	assert.ok(retainedNotices().some((type) => type.startsWith("agent.")), "the Agent extension retained a notice");
	assert.ok(retainedNotices().some((type) => !type.startsWith("agent.")), "another loaded extension retained a notice");
	const retained = retainedNotices().length;

	f.state.summary = "PACKAGE_SUMMARY";
	await f.session.compact();
	f.script.push({ tool: ["probe", {}], tokens: 3000 }, { text: "THIRD_DONE", tokens: 3100 });
	const third = (await f.prompt("Third input")).map((request) => request.messages);
	assert.equal(third.length, 2);
	const [head] = f.heads();
	for (const request of third) {
		const [index] = noteIndexes(request);
		assert.equal(noteIndexes(request).length, 1);
		assert.ok(messageText(request[index - 1]).includes("PACKAGE_SUMMARY"), "the note follows the compaction summary directly");
		assert.equal(noteHead(request[index]), head);
		assert.ok(messageText(request[index]).includes(`"sessionId":"${f.target}","submissionId":1`), "the note lists the open request");
	}
	assert.deepEqual(noteIndexes(third[1]), noteIndexes(third[0]), "the note keeps its place in the two requests after the compaction");
	assertPrefix(third[0], third[1], "request 1 to 2 after the compaction");
	const [fourth] = (await f.prompt("Fourth input")).map((request) => request.messages);
	assertPrefix(third[1], fourth, "request 2 to 3 after the compaction");
	assert.deepEqual(noteIndexes(fourth), noteIndexes(third[0]));
	assert.ok(retainedNotices().length >= retained);
});
