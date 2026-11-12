import assert from "node:assert/strict";
import { it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { startDurableDelivery, type DurableDelivery } from "./durable-delivery.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureRuntime, hostOptions } from "./durable-host-fixture.mts";
import { HostError } from "./host-protocol.ts";
import { conversation, messageText, noteHead, noteIndexes, ordinarySession } from "./ordinary-continuity-fixture.mts";
import { PLANNING_BUDGET_NOTICE } from "./ordinary-continuity.ts";

/** The note is directly after the summary message of its head, once. */
function assertNoteAfterSummary(messages: readonly Message[], summary: string, headId: string): string {
	const index = messages.findIndex((message) => message.role === "user" && messageText(message).includes(summary));
	assert.ok(index >= 0, `the request carries the summary ${summary}`);
	assert.deepEqual(noteIndexes(messages), [index + 1], "one note directly after the summary");
	assert.equal(noteHead(messages[index + 1]), headId);
	return messageText(messages[index + 1]);
}

it("carries a real session's open requests in the first request after a self-compaction, and closes them from delivered tuples", { timeout: 60000 }, async (t) => {
	let refusal: Error | undefined;
	let source: DurableHost | undefined, delivery: DurableDelivery | undefined;
	t.after(async () => { await delivery?.close(); await source?.close(); });
	const f = await ordinarySession(t, {
		host: (method, params) => {
			if (method !== "task-submit") return {};
			if (refusal !== undefined) throw refusal;
			assert.ok(source);
			return source.request(method, params);
		},
	});
	const metadata = f.manager.catalog.read(f.target);
	source = await DurableHost.open({ ...hostOptions(metadata.storagePath, await fixtureRuntime("answer"), fixtureRegistry(), metadata.cwd), storageId: f.target });
	const self = f.sessionManager.getSessionId();
	f.script.push(
		{ tool: ["agent_send", { sessionId: f.target, message: "Admitted task" }] },
		{ tool: () => { refusal = new HostError("Unknown conversation", "invalid"); return ["agent_steer", { sessionId: f.target, message: "Refused steer" }]; } },
		{ tool: () => { refusal = new HostError("Host observation deadline reached", "unavailable"); return ["agent_send", { sessionId: f.target, message: "Unconfirmed task" }]; } },
		{ tool: () => { refusal = undefined; return ["agent_compact", { sessionId: self, summary: "SELF_SUMMARY" }]; } },
		{ text: "FINAL_AFTER_COMPACTION" },
	);
	const run = await f.prompt("Send the work, then compact");
	assert.equal(run.length, 5);
	assert.deepEqual(f.facts().map((fact) => fact.phase), ["requested", "admitted", "requested", "refused", "requested"]);
	const [, admitted, , refused, unconfirmed] = f.facts();
	assert.equal(admitted.phase, "admitted");
	const submissionId = admitted.submissionId; assert.ok(submissionId);
	assert.ok(f.facts().every((fact) => fact.sessionId === f.target && fact.replyTo === self));
	for (const earlier of run.slice(0, 4)) assert.deepEqual(noteIndexes(earlier.messages), [], "no compaction summary means no note");
	const [selfHead] = f.heads();
	const first = assertNoteAfterSummary(run[4].messages, "SELF_SUMMARY", selfHead);
	assert.ok(first.includes(JSON.stringify({ sessionId: f.target, submissionId, requestId: admitted.requestId })));
	assert.ok(first.includes(`Admission unconfirmed: \n${JSON.stringify({ sessionId: f.target, requestId: unconfirmed.requestId })}\nScheduled inputs: none`));
	assert.equal(first.includes(refused.requestId), false, "a refused request is not listed");
	assert.ok(f.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant" && JSON.stringify(entry.message.content).includes("FINAL_AFTER_COMPACTION")), "the first request after the compaction ended in a final answer");

	const [next] = await f.prompt("Continue");
	const before = conversation(run[4].messages), after = conversation(next.messages);
	assert.deepEqual(after.slice(0, before.length), before, "the request after the compaction is an exact prefix of the next one");
	assert.deepEqual(noteIndexes(next.messages), noteIndexes(run[4].messages));

	await source.wait(submissionId as SubmissionId);
	let resolveIdle!: () => void;
	const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
	delivery = startDurableDelivery({ host: source, metadata, catalog: f.manager.catalog, sessionsRoot: f.sessionsRoot,
		signal: new AbortController().signal, onIdle: resolveIdle });
	await idle;
	await f.session.waitForIdle();
	await delivery.close(); delivery = undefined;
	const retained = f.sessionManager.getEntries().find((entry) => entry.type === "custom_message" &&
		entry.details !== null && typeof entry.details === "object" && "deliveredResults" in entry.details);
	assert.ok(retained?.type === "custom_message" && typeof retained.content === "string");
	const carrier = retained.details as Record<string, unknown>;
	assert.deepEqual(carrier.deliveredResults, [{ sessionId: f.target, submissionId, requestId: admitted.requestId }]);
	assert.equal(typeof carrier.sourceId, "string");
	const sourceId = String(carrier.sourceId), resultBody = retained.content;
	assert.equal(await f.deliver(sourceId, resultBody, carrier), true, "the session file retains the real receipt body");
	const delivered = () => f.facts().filter((fact) => fact.phase === "delivered");
	assert.deepEqual(delivered(), [{ phase: "delivered", sessionId: f.target, requestId: admitted.requestId, replyTo: self, submissionId }]);
	await assert.rejects(f.deliver("receipt:invalid", "INVALID_CARRIER", { deliveredResults: [{ sessionId: f.target, requestId: unconfirmed.requestId }] }), /requires a submission/u);
	assert.equal(f.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && JSON.stringify(entry.content).includes("INVALID_CARRIER")), false, "an invalid carrier refuses the body");

	f.state.summary = "MANUAL_SUMMARY";
	await f.session.compact();
	const [manual] = await f.prompt("After the manual compaction");
	const second = assertNoteAfterSummary(manual.messages, "MANUAL_SUMMARY", f.heads()[1]);
	assert.match(second, /with no delivered result here: none\nAdmission unconfirmed: \n/u, "the delivered request left the note; the unconfirmed one stays");
	assert.ok(second.includes(unconfirmed.requestId));

	await f.restart();
	assert.equal(await f.deliver(sourceId, resultBody, carrier), true, "a replayed delivery finds its retained body");
	assert.equal(delivered().length, 1, "the replay writes no further fact");
	const [reloaded] = await f.prompt("After the reload");
	assert.equal(assertNoteAfterSummary(reloaded.messages, "MANUAL_SUMMARY", f.heads()[1]), second, "a reload produces the same bytes");
	const earlier = conversation(manual.messages);
	assert.deepEqual(conversation(reloaded.messages).slice(0, earlier.length), earlier);
});

/** A sibling hook that puts its own note directly after the compaction summary. */
const siblingNote = (label: string): ExtensionFactory => (pi) => {
	pi.on("context", (event) => {
		const index = event.messages.findIndex((message) => message.role === "compactionSummary");
		if (index < 0) return undefined;
		return { messages: [...event.messages.slice(0, index + 1), { role: "user", content: label, timestamp: 0 }, ...event.messages.slice(index + 1)] };
	});
};

it("keeps one stable request prefix through the whole context chain after automatic and sibling compactions with identical summaries", { timeout: 60000 }, async (t) => {
	const boundary = { compact: false };
	const siblingCompaction: ExtensionFactory = (pi) => {
		pi.on("turn_end", (event) => {
			if (!boundary.compact) return undefined;
			boundary.compact = false;
			return { entries: [...event.entries, { type: "compaction", summary: "IDENTICAL_SUMMARY", firstKeptEntryId: event.messageEntryId }] };
		});
	};
	const f = await ordinarySession(t, { autoCompaction: true, before: [siblingNote("EARLIER_HOOK_NOTE")], after: [siblingNote("LATER_HOOK_NOTE"), siblingCompaction] });
	f.state.summary = "IDENTICAL_SUMMARY";
	await f.prompt("First input");
	f.script.push({ text: "ABOVE_THE_THRESHOLD", tokens: 120000 });
	await f.prompt("Second input");
	assert.equal(f.heads().length, 1, "the threshold compaction ran between turns");

	f.script.push({ tool: ["probe", {}] }, { text: "AFTER_PROBE" });
	const run = await f.prompt("Third input");
	assert.equal(run.length, 2);
	const [first, second] = run.map((request) => request.messages);
	const note = assertNoteAfterSummary(first.filter((message) => messageText(message) !== "LATER_HOOK_NOTE"), "IDENTICAL_SUMMARY", f.heads()[0]);
	const [index] = noteIndexes(first);
	assert.deepEqual([messageText(first[index - 1]), messageText(first[index + 1])], ["LATER_HOOK_NOTE", "EARLIER_HOOK_NOTE"], "a later hook's note precedes the continuity note and an earlier hook's note follows it");
	assert.deepEqual(second.slice(0, first.length), first, "request n after all hooks is an exact prefix of request n+1");

	boundary.compact = true;
	await f.prompt("Fourth input");
	assert.equal(f.heads().length, 2, "a sibling boundary handler compacted");
	f.script.push({ tool: ["probe", {}] }, { text: "AFTER_SECOND_PROBE" });
	const later = (await f.prompt("Fifth input")).map((request) => request.messages);
	const repeated = assertNoteAfterSummary(later[0].filter((message) => messageText(message) !== "LATER_HOOK_NOTE"), "IDENTICAL_SUMMARY", f.heads()[1]);
	assert.notEqual(f.heads()[0], f.heads()[1]);
	assert.equal(repeated, note.replace(f.heads()[0], f.heads()[1]), "an identical summary gets the note of its own head");
	assert.deepEqual(later[1].slice(0, later[0].length), later[0]);
	assert.deepEqual(noteIndexes(later[1]), noteIndexes(later[0]), "the note keeps its place in the two requests after a compaction");
});

it("retains one own-budget notice per context episode in a real session", { timeout: 60000 }, async (t) => {
	const f = await ordinarySession(t, { budget: 60000 });
	const notices = () => f.sessionManager.getEntries().flatMap((entry) => entry.type === "custom_message" && entry.customType === PLANNING_BUDGET_NOTICE ? [String(entry.content)] : []);
	f.script.push({ text: "BELOW", tokens: 1000 }); await f.prompt("First input");
	assert.deepEqual(notices(), []);
	f.script.push({ text: "CROSSING", tokens: 70000 }); await f.prompt("Second input");
	assert.equal(notices().length, 1);
	assert.match(notices()[0], /^Context use reached 70000 tokens at \d{4}-\d{2}-\d{2}T[\d:.]+Z, at or above the planning budget of 60000 for agent-test\/model\. The budget is a planning preference, not a limit\.$/u);
	f.script.push({ tool: ["probe", {}], tokens: 80000 }, { text: "STILL_ABOVE", tokens: 90000 });
	const run = (await f.prompt("Third input")).map((request) => conversation(request.messages));
	assert.equal(notices().length, 1, "one episode has one notice");
	const at = run[0].findIndex((message) => messageText(message).includes("Context use reached 70000 tokens"));
	assert.ok(at >= 0, "the notice is retained conversation content");
	assert.deepEqual(run[1].slice(0, run[0].length), run[0], "the retained notice keeps the request prefix stable");
	f.state.summary = "BUDGET_SUMMARY";
	await f.session.compact();
	f.script.push({ text: "BELOW_AGAIN", tokens: 30000 }); await f.prompt("Fourth input");
	assert.equal(notices().length, 1);
	f.script.push({ text: "SECOND_CROSSING", tokens: 65000 }); await f.prompt("Fifth input");
	assert.equal(notices().length, 2, "a new episode after a compaction can cross again");
	assert.match(notices()[1], /^Context use reached 65000 tokens/u);
	await f.session.compact();
	f.script.push({ text: "BELOW_ONCE_MORE", tokens: 30000 }); await f.prompt("Sixth input");
	const heads = f.heads().length;
	f.script.push({ tool: () => ["agent_compact", { sessionId: f.sessionManager.getSessionId(), summary: "SELF_SUMMARY_AT_THE_CROSSING" }], tokens: 65000 }, { text: "AFTER_SELF_COMPACTION", tokens: 100 });
	await f.prompt("Seventh input");
	assert.equal(f.heads().length, heads + 1);
	assert.equal(notices().length, 2, "a boundary that compacts the session retains no notice");
});
