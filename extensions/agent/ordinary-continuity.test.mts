import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { ORDINARY_CONTINUITY_ENTRY, type ContinuityFact } from "./continuity-facts.ts";
import { HostError } from "./host-protocol.ts";
import { OrdinaryContinuity, PLANNING_BUDGET_NOTICE, deliveredResults, recordAdmission, type DeliveredResult } from "./ordinary-continuity.ts";

const WORKER = "11111111-2222-4333-8444-555555555555";
const target = (requestId: string, extra: Record<string, unknown> = {}) => ({ ownerId: "owner", sessionId: WORKER, requestId, ...extra });
const noteText = (messages: readonly AgentMessage[]): string[] => messages.flatMap((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("Host-held continuity facts") ? [message.content] : []);

function fixture(budget: number | undefined = undefined) {
	const session = SessionManager.inMemory("/tmp");
	const diagnostics: Array<string | undefined> = [];
	let now = Date.UTC(2030, 0, 1);
	const continuity = new OrdinaryContinuity({
		append: (fact) => { session.appendCustomEntry(ORDINARY_CONTINUITY_ENTRY, fact); },
		budget: () => budget,
		diagnose: (_sessionId, text) => { diagnostics.push(text); },
		now: () => now++,
	});
	const id = session.getSessionId();
	continuity.start(id, session.getEntries());
	const facts = (): ContinuityFact[] => session.getEntries().flatMap((entry) => entry.type === "custom" && entry.customType === ORDINARY_CONTINUITY_ENTRY ? [entry.data as ContinuityFact] : []);
	const compact = (summary: string): string => {
		const kept = session.appendMessage({ role: "user", content: "kept input", timestamp: 1 });
		return session.appendCompaction(summary, kept, 100);
	};
	const reads = { count: 0 };
	// The handler's own reads of the retained entries are counted; Pi's internal reads are not.
	const observed = { getSessionId: () => id, buildContextEntries: () => session.buildContextEntries(), getEntries: () => { reads.count++; return session.getEntries(); } } as unknown as ExtensionContext["sessionManager"];
	const request = (): AgentMessage[] => {
		const messages = session.buildSessionContext().messages;
		return continuity.context({ type: "context", messages }, { sessionManager: observed })?.messages ?? messages;
	};
	return { session, id, continuity, diagnostics, facts, compact, request, reads, record: (fact: ContinuityFact) => continuity.record(id, fact) };
}

it("records the request before the host call and the admission after its reply", async () => {
	const recorded: ContinuityFact[] = [];
	const reply = await recordAdmission((fact) => recorded.push(fact), target("send-1"), async () => {
		assert.deepEqual(recorded, [{ phase: "requested", sessionId: WORKER, requestId: "send-1", replyTo: "owner" }]);
		return { submissionId: 7, extra: true };
	});
	assert.deepEqual(reply, { submissionId: 7, extra: true });
	assert.deepEqual(recorded[1], { phase: "admitted", sessionId: WORKER, requestId: "send-1", replyTo: "owner", submissionId: 7 });
	assert.equal(recorded.length, 2);
});

it("records a refusal only for the invalid code and keeps every other failure requested", async () => {
	const failures: Array<[string, unknown, string[]]> = [
		["invalid", new HostError("refused before admission", "invalid"), ["requested", "refused"]],
		["unavailable", new HostError("host unavailable", "unavailable"), ["requested"]],
		["claim", new HostError("claim held", "claim"), ["requested"]],
		["internal", new HostError("host failed", "internal"), ["requested"]],
		["transport", new Error("socket closed"), ["requested"]],
	];
	for (const [name, failure, phases] of failures) {
		const recorded: ContinuityFact[] = [];
		await assert.rejects(recordAdmission((fact) => recorded.push(fact), target(`send-${name}`), async () => { throw failure; }), (error) => error === failure);
		assert.deepEqual(recorded.map((fact) => fact.phase), phases, name);
	}
	const unconfirmed: ContinuityFact[] = [];
	await recordAdmission((fact) => unconfirmed.push(fact), target("send-no-receipt"), async () => ({ submissionId: 0 }));
	assert.deepEqual(unconfirmed.map((fact) => fact.phase), ["requested"], "a reply without a submission confirms nothing");
});

it("records the canonical producer and the exact reply recipient, and nothing without a recorder", async () => {
	const recorded: ContinuityFact[] = [];
	await recordAdmission((fact) => recorded.push(fact), target("send-root", { sessionId: `${WORKER}:1`, replyTo: `${WORKER}:3` }), async () => ({ submissionId: 2 }));
	assert.deepEqual(recorded[0], { phase: "requested", sessionId: WORKER, requestId: "send-root", replyTo: `${WORKER}:3` });
	assert.equal(await recordAdmission(undefined, target("send-plain"), async () => "reply"), "reply");
});

it("validates a fact before the append and writes only a phase that changes its request", () => {
	const f = fixture();
	assert.throws(() => f.record({ phase: "admitted", sessionId: WORKER, requestId: "a", replyTo: f.id }), /requires a submission/u);
	assert.throws(() => f.record({ phase: "requested", sessionId: "bad identity", requestId: "a", replyTo: f.id }), /Invalid continuity/u);
	assert.deepEqual(f.facts(), []);
	const requested: ContinuityFact = { phase: "requested", sessionId: WORKER, requestId: "a", replyTo: f.id };
	f.record(requested); f.record(requested);
	f.record({ ...requested, phase: "admitted", submissionId: 4 });
	f.record(requested);
	f.record({ ...requested, phase: "refused" });
	assert.deepEqual(f.facts().map((fact) => fact.phase), ["requested", "admitted"], "a repeated request and a refusal after admission write nothing");
	assert.throws(() => f.record({ ...requested, replyTo: `${WORKER}:9` }), /Conflicting continuity admission/u);
	assert.throws(() => f.record({ ...requested, phase: "admitted", submissionId: 5 }), /Conflicting continuity admission/u);
	assert.equal(f.facts().length, 2);
});

it("restores the request view when the append fails", () => {
	const session = SessionManager.inMemory("/tmp");
	let fail = true;
	const written: ContinuityFact[] = [];
	const continuity = new OrdinaryContinuity({ append: (fact) => { if (fail) throw new Error("append failed"); written.push(fact); }, budget: () => undefined, diagnose() {} });
	const requested: ContinuityFact = { phase: "requested", sessionId: WORKER, requestId: "a", replyTo: "owner" };
	assert.throws(() => continuity.record(session.getSessionId(), requested), /append failed/u);
	fail = false;
	continuity.record(session.getSessionId(), requested);
	assert.deepEqual(written, [requested]);
});

it("closes every delivered tuple once, also after a reload, and leaves foreign tuples open", () => {
	const f = fixture();
	const results: DeliveredResult[] = [];
	for (let index = 1; index <= 20; index++) {
		const route = { sessionId: `${WORKER}:${index + 1}`, requestId: `request-${index}`, replyTo: f.id };
		f.record({ phase: "requested", ...route });
		f.record({ phase: "admitted", ...route, submissionId: index });
		results.push({ sessionId: route.sessionId, requestId: route.requestId, submissionId: index });
	}
	f.record({ phase: "requested", sessionId: WORKER, requestId: "other-submission", replyTo: f.id });
	f.record({ phase: "admitted", sessionId: WORKER, requestId: "other-submission", replyTo: f.id, submissionId: 3 });
	const carried = deliveredResults({ answer: "body", deliveredResults: [...results, { sessionId: WORKER, requestId: "never-requested", submissionId: 1 }, { sessionId: WORKER, requestId: "other-submission", submissionId: 99 }] });
	assert.equal(carried.length, 22);
	f.continuity.delivered(f.id, carried);
	const delivered = () => f.facts().filter((fact) => fact.phase === "delivered");
	assert.equal(delivered().length, 20, "a receipt group larger than the display bound closes every tuple");
	assert.ok(delivered().every((fact) => fact.replyTo === f.id));
	f.continuity.delivered(f.id, carried);
	assert.equal(delivered().length, 20, "a replay writes nothing");
	f.continuity.start(f.id, f.session.getEntries());
	f.continuity.delivered(f.id, carried);
	assert.equal(delivered().length, 20, "a replay after a reload writes nothing");
	f.compact("Summary after results");
	const [note] = noteText(f.request());
	assert.match(note, /with no delivered result here: \n\{"sessionId":"11111111-2222-4333-8444-555555555555","submissionId":3,"requestId":"other-submission"\}\nAdmission unconfirmed: none/u);
});

it("accepts a delivery without the carrier and refuses an invalid carrier as a whole", () => {
	assert.deepEqual(deliveredResults({ answer: "body" }), []);
	assert.deepEqual(deliveredResults(undefined), []);
	assert.throws(() => deliveredResults({ deliveredResults: [{ sessionId: WORKER, requestId: "a", submissionId: 1 }, { sessionId: WORKER, requestId: "b" }] }), /requires a submission/u);
	assert.throws(() => deliveredResults({ deliveredResults: "none" }), /Invalid delivered continuity references/u);
});

it("inserts no note without a compaction head and one frozen note directly after the summary", () => {
	const f = fixture();
	f.record({ phase: "requested", sessionId: WORKER, requestId: "open", replyTo: f.id });
	f.session.appendMessage({ role: "user", content: "first input", timestamp: 1 });
	assert.deepEqual(noteText(f.request()), []);
	const headId = f.compact("Summary one");
	f.record({ phase: "admitted", sessionId: WORKER, requestId: "open", replyTo: f.id, submissionId: 2 });
	const first = f.request();
	const summary = first.findIndex((message) => message.role === "compactionSummary");
	assert.equal(noteText([first[summary + 1]]).length, 1, "the note follows the summary directly");
	assert.match(noteText(first)[0], new RegExp(`for context head entry ${headId}\\.`, "u"));
	assert.match(noteText(first)[0], /Admission unconfirmed: \n\{"sessionId":"11111111-2222-4333-8444-555555555555","requestId":"open"\}/u, "a fact after the head stays out of its note");
	f.session.appendMessage({ role: "user", content: "later input", timestamp: 2 });
	const second = f.request();
	assert.deepEqual(second.slice(0, first.length), first, "the earlier request is an exact prefix");
	assert.equal(f.reads.count, 1, "the retained entries are read once for one head");
	f.continuity.start(f.id, f.session.getEntries());
	assert.deepEqual(noteText(f.request()), noteText(first), "a reload produces the same bytes");
	assert.equal(f.reads.count, 2);
});

it("identifies two heads with identical summaries by their entry IDs", () => {
	const f = fixture();
	const first = f.compact("Identical summary");
	const before = noteText(f.request())[0];
	f.record({ phase: "requested", sessionId: WORKER, requestId: "between", replyTo: f.id });
	const second = f.compact("Identical summary");
	const after = noteText(f.request())[0];
	assert.notEqual(first, second);
	assert.match(before, new RegExp(`head entry ${first}\\.`, "u")); assert.match(before, /Admission unconfirmed: none/u);
	assert.match(after, new RegExp(`head entry ${second}\\.`, "u")); assert.match(after, /"requestId":"between"/u);
});

it("reports a request that disagrees with the head and inserts no note", () => {
	const f = fixture();
	const headId = f.compact("Stored summary");
	const messages = f.session.buildSessionContext().messages.map((message) => message.role === "compactionSummary" ? { ...message, summary: "Another summary" } : message);
	assert.equal(f.continuity.context({ type: "context", messages }, { sessionManager: f.session }), undefined);
	assert.deepEqual(f.diagnostics, [`The continuity note for context head ${headId} was not inserted: head-message`]);
	assert.equal(f.continuity.context({ type: "context", messages: messages.filter((message) => message.role !== "compactionSummary") }, { sessionManager: f.session }), undefined);
	assert.match(f.diagnostics[1] ?? "", /missing-summary$/u);
	assert.equal(noteText(f.request()).length, 1);
	assert.equal(f.diagnostics[2], undefined, "a consistent request clears the report");
	assert.equal(f.diagnostics.length, 3);
});

it("reports an invalid retained fact once for its head and inserts no note", () => {
	const f = fixture();
	f.session.appendCustomEntry(ORDINARY_CONTINUITY_ENTRY, { phase: "admitted", sessionId: WORKER, requestId: "a", replyTo: f.id });
	f.continuity.start(f.id, f.session.getEntries());
	f.compact("Summary");
	assert.deepEqual(noteText(f.request()), []);
	assert.deepEqual(noteText(f.request()), []);
	assert.equal(f.diagnostics.length, 1);
	assert.match(f.diagnostics[0] ?? "", /is unavailable: Continuity admission requires a submission/u);
});

function turns(budget: number | undefined, contextWindow = 1_000_000) {
	const f = fixture(budget);
	let tokens: number | null = null;
	const ctx = { sessionManager: f.session, model: { provider: "acme", id: "model-x" }, getContextUsage: () => ({ tokens, contextWindow, percent: null }) } as unknown as ExtensionContext;
	const turn = (value: number | null, entries: SessionBoundaryDraft[] = [], compacting = false) => { tokens = value; return f.continuity.turnEnd({ entries }, ctx, compacting); };
	return { ...f, turn };
}

it("retains one own-budget notice at the first crossing of a context episode", () => {
	const f = turns(300_000);
	assert.equal(f.turn(310_000), undefined, "a first sample above the budget is no crossing");
	assert.equal(f.turn(200_000), undefined);
	const kept: SessionBoundaryDraft = { type: "custom", customType: "other.entry", data: {} };
	assert.deepEqual(f.turn(300_000, [kept]), { entries: [kept, {
		type: "custom_message", customType: PLANNING_BUDGET_NOTICE, display: true,
		content: "Context use reached 300000 tokens at 2030-01-01T00:00:00.000Z, at or above the planning budget of 300000 for acme/model-x. The budget is a planning preference, not a limit.",
	}] });
	assert.equal(f.turn(200_000), undefined);
	assert.equal(f.turn(400_000), undefined, "one episode has one notice");
	f.compact("Summary");
	assert.equal(f.turn(null), undefined, "unknown usage is no sample");
	assert.equal(f.turn(350_000), undefined, "the first sample of a new episode is no crossing");
	assert.equal(f.turn(100_000), undefined);
	assert.match(JSON.stringify(f.turn(320_000)), /Context use reached 320000 tokens/u);
});

it("retains no own-budget notice without a budget, at the window, or on a compacting boundary", () => {
	const none = turns(undefined);
	assert.equal(none.turn(100), undefined); assert.equal(none.turn(900_000), undefined);
	const atWindow = turns(1_000_000);
	assert.equal(atWindow.turn(100), undefined); assert.equal(atWindow.turn(1_000_000), undefined);
	const compacting = turns(300_000);
	assert.equal(compacting.turn(100_000), undefined);
	assert.equal(compacting.turn(310_000, [{ type: "compaction", summary: "Sibling summary", firstKeptEntryId: "kept" }]), undefined);
	assert.equal(compacting.turn(320_000, [], true), undefined);
	assert.match(JSON.stringify(compacting.turn(330_000)), /Context use reached 330000 tokens/u, "a boundary that compacts takes no sample");
});
