import assert from "node:assert/strict";
import { it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { EffortPrompt } from "./effort-awareness.ts";
import { NativeEffortNotes } from "./effort-notes-native.ts";
import { effortRowKey, type EffortPromptRow } from "./effort-update.ts";

const conversation = 1 as ConversationId;
const row = (id: string, purpose = "work"): EffortPromptRow => ({
	key: effortRowKey("Related effort", id),
	label: "Related effort",
	value: { id, purposeClaim: purpose },
});
const prompt = (...rows: EffortPromptRow[]): EffortPrompt => ({
	text: ["Header.", ...rows.map((item) => `${item.label}: ${JSON.stringify(item.value)}`), "Pointer."].join("\n"),
	rows,
});
const user = (text: string, timestamp: number): Message => ({ role: "user", content: text, timestamp });
const notes = (messages: readonly Message[] | undefined) =>
	(messages ?? []).flatMap((message, index) =>
		message.role === "user" &&
		Array.isArray(message.content) &&
		message.content.some((part) => part.type === "text" && part.text.startsWith("<agent-efforts-update>"))
			? [index]
			: [],
	);

function host(limit?: number) {
	const native = new NativeEffortNotes(limit);
	let current = prompt(row("a"));
	let reads = 0;
	const section = (run: string, shown: Record<string, string> = {}, id = conversation) =>
		native.section(
			{ conversationId: id, shown, run },
			async () => {
				reads++;
				return current;
			},
			"unavailable",
		);
	return {
		native,
		section,
		set: (next: EffortPrompt) => {
			current = next;
		},
		reads: () => reads,
	};
}

it("reads once per run, keeps the section and anchors the change after the run's last message", async () => {
	const fixture = host();
	const baseline = await fixture.section("run-1");
	assert.equal(baseline, prompt(row("a")).text);
	assert.equal(await fixture.section("run-1"), baseline, "a later round of the same run keeps the section");
	assert.equal(fixture.reads(), 1, "a later round reads nothing");
	const first = [user("start", 1)];
	assert.equal(fixture.native.request(conversation, first), undefined, "no change, no note");
	fixture.set(prompt(row("a"), row("b")));
	const second = [...first, { role: "assistant", content: [], timestamp: 2 } as unknown as Message, user("next", 3)];
	assert.equal(await fixture.section("run-2"), baseline);
	const withNote = fixture.native.request(conversation, second);
	assert.deepEqual(notes(withNote), [3], "the note follows the message that started the run");
	const third = [...second, { role: "assistant", content: [], timestamp: 4 } as unknown as Message];
	const later = fixture.native.request(conversation, third);
	assert.deepEqual(notes(later), [3], "later requests keep the note in place");
	assert.equal(JSON.stringify(later?.slice(0, withNote?.length)), JSON.stringify(withNote));
	assert.equal(await fixture.section("run-3"), baseline);
	assert.deepEqual(notes(fixture.native.request(conversation, third)), [3], "an unchanged run adds no note");
});

it("reports again a change whose note left the context", async () => {
	const fixture = host();
	await fixture.section("run-1");
	fixture.native.request(conversation, [user("start", 1)]);
	fixture.set(prompt(row("a"), row("b")));
	await fixture.section("run-2");
	assert.deepEqual(notes(fixture.native.request(conversation, [user("start", 1), user("next", 2)])), [2]);
	// A compaction summarized the message the note followed.
	const compacted = [user("summary", 5), user("again", 6)];
	assert.equal(fixture.native.request(conversation, compacted), undefined, "the note left with its anchor");
	await fixture.section("run-3");
	const restated = fixture.native.request(conversation, compacted);
	assert.deepEqual(notes(restated), [2]);
	assert.match(JSON.stringify(restated), /\\"id\\":\\"b\\"/u, "the change is reported again");
});

it("replaces the section after the update budget and restores a shown section after eviction", async () => {
	const fixture = host(1);
	const baseline = await fixture.section("run-1");
	const messages: Message[] = [user("start", 1)];
	let run = 1;
	let replaced: string | undefined;
	for (let index = 0; index < 40 && replaced === undefined; index++) {
		fixture.set(prompt(row("a", `purpose ${index} ${"x".repeat(900)}`)));
		const text = await fixture.section(`run-${++run}`);
		if (text !== baseline) replaced = text;
		messages.push(user(`input ${index}`, 10 + index));
		fixture.native.request(conversation, messages);
	}
	assert.ok(replaced, "accumulated updates past the budget replace the section");
	const shown = { "agent-efforts": `<agent-efforts>\n${replaced}\n</agent-efforts>` };
	await fixture.section("other-run", {}, 2 as ConversationId);
	const reads = fixture.reads();
	assert.equal(await fixture.section(`run-${++run}`, shown), replaced, "an evicted conversation keeps the shown text");
	assert.equal(fixture.reads(), reads + 1);
});
