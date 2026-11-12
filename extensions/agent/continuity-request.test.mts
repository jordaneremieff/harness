import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { GenerationTask, Harness, MemoryStorage, createRegistry, defineExtension, hook, section, type Conversation, type EntryId, type GenerationHooks, type HarnessOptions, type ToolRegistration } from "@earendil-works/pi-durable";
import { answerMessage, completed, gateTool, toolCallMessage } from "./durable-host-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { ContinuityMirror } from "./continuity-mirror.ts";
import { recordContinuityDelivered, recordContinuityFact } from "./continuity-native.ts";
import { continuityRequestHooks, type ContinuityMismatch, type ContinuitySource } from "./continuity-request.ts";
import { resetConversation } from "./durable-reset.ts";

const OWNER = "owner-storage";
const HEADER = /^Host-held continuity facts from the Agent extension for context head entry (\d+)\./u;
type Reply = AssistantMessage | ((request: string) => AssistantMessage);
type Options = {
	readonly replies?: Reply[];
	readonly settings?: HarnessOptions["settings"];
	readonly tools?: ToolRegistration[];
	readonly before?: Partial<GenerationHooks>;
	readonly after?: Partial<GenerationHooks>;
	readonly source?: (mirror: ContinuityMirror) => ContinuitySource;
};

/** A real Harness, context assembly and hook chain; only the provider stream is synthetic. */
async function fixture(t: TestContext, options: Options = {}) {
	const provider: string[] = [];
	const chain: Message[][] = [];
	const mismatches: ContinuityMismatch[] = [];
	const replies = [...options.replies ?? []];
	const runtime = await createTestRuntime();
	runtime.registerNativeProvider({
		id: testModel.provider, name: "Continuity request fixture", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: () => { throw new Error("Unexpected stream"); },
		streamSimple: (_model, input) => {
			const request = JSON.stringify(input);
			provider.push(request);
			const reply = replies.shift() ?? answerMessage("final answer");
			return completed(typeof reply === "function" ? reply(request) : reply);
		},
	});
	const registry = createRegistry();
	let mirror: ContinuityMirror | undefined;
	const source = (): ContinuitySource | undefined => mirror === undefined ? undefined : options.source?.(mirror) ?? mirror;
	registry.install(defineExtension({ name: "fixture-base", tools: options.tools ?? [], sections: [section("fixture-baseline", async () => "Fixture baseline section.")] }));
	if (options.before !== undefined) registry.install(defineExtension({ name: "fixture-before", hooks: [hook(GenerationTask, options.before)] }));
	registry.install(defineExtension({ name: "agent.continuity", hooks: [hook(GenerationTask, continuityRequestHooks(source, (found) => { mismatches.push(found); }))] }));
	if (options.after !== undefined) registry.install(defineExtension({ name: "fixture-after", hooks: [hook(GenerationTask, options.after)] }));
	registry.install(defineExtension({ name: "fixture-capture", hooks: [hook(GenerationTask, { beforeRequest(request) { chain.push(structuredClone([...request.messages])); return undefined; } })] }));
	const harness = await Harness.open(new MemoryStorage(), { models: runtime, registry, ...(options.settings === undefined ? {} : { settings: options.settings }) }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	mirror = new ContinuityMirror(harness, OWNER);
	const opened = mirror;
	t.after(() => opened.close());
	await opened.initialize(context);
	harness.resume();
	const ask = async (content: string): Promise<void> => {
		const submitted = await conversation.submit({ type: "input", content }, context);
		assert.equal((await submitted.wait(context)).status, "done");
	};
	const admit = (requestId: string, submissionId: number): Promise<void> =>
		harness.commit((tx) => recordContinuityFact(tx, conversation.id, { phase: "admitted", sessionId: "worker:2", requestId, replyTo: OWNER, submissionId }), context);
	return { harness, conversation, mirror: opened, provider, chain, mismatches, ask, admit };
}

async function latestHead(conversation: Conversation): Promise<EntryId> {
	const page = await conversation.entries({}, 64, undefined, context);
	const head = page.items.find((entry) => entry.head !== undefined);
	assert.ok(head, "the conversation has a context head");
	return head.id;
}
function text(message: Message | undefined): string {
	if (message === undefined) return "";
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}
function leadingSystems(messages: readonly Message[]): number { return messages[0]?.role === "system" ? 1 : 0; }
function noteIndexes(messages: readonly Message[]): number[] {
	return messages.flatMap((message, index) => message.role === "user" && HEADER.test(text(message)) ? [index] : []);
}
function noteHead(message: Message | undefined): number { return Number(HEADER.exec(text(message))?.[1]); }
function assertPrefix(earlier: readonly Message[], later: readonly Message[]): void {
	assert.ok(later.length > earlier.length);
	assert.deepEqual(later.slice(0, earlier.length), earlier);
}

it("adds no note before a context head exists", { timeout: 20000 }, async (t) => {
	const { chain, ask, admit, mismatches } = await fixture(t);
	await admit("a", 7);
	await ask("first");
	await ask("second");
	assert.equal(chain.length, 2);
	assert.deepEqual(chain.map(noteIndexes), [[], []]);
	assertPrefix(chain[0], chain[1]);
	assert.deepEqual(mismatches, []);
});

it("inserts the frozen note after a reset handoff on a first request that ends in a final answer", { timeout: 20000 }, async (t) => {
	const { harness, conversation, chain, provider, ask, admit, mismatches } = await fixture(t);
	await admit("a", 7);
	await conversation.reset("Handoff: continue the review.", context);
	const head = await latestHead(conversation);
	await ask("next input");
	const first = chain[0];
	const s = leadingSystems(first);
	assert.equal(s, 1, "the real context assembly leads with the baseline system message");
	assert.equal(text(first[s]), "Handoff: continue the review.");
	assert.deepEqual(noteIndexes(first), [s + 1]);
	assert.equal(noteHead(first[s + 1]), head);
	assert.match(text(first[s + 1]), /"sessionId":"worker:2","submissionId":7,"requestId":"a"/u);
	assert.equal(text(first[s + 2]), "next input");
	assert.equal(first.length, s + 3);
	assert.ok(provider[0].includes(`context head entry ${head}.`), "the provider request carries the note");

	// Facts committed after the head never change that head's bytes.
	await admit("b", 8);
	await harness.commit((tx) => recordContinuityDelivered(tx, conversation.id, [{ sessionId: "worker:2", requestId: "a", submissionId: 7 }]), context);
	await ask("later input");
	assertPrefix(first, chain[1]);
	assert.deepEqual(noteIndexes(chain[1]), [s + 1]);
	assert.doesNotMatch(text(chain[1][s + 1]), /"requestId":"b"/u);
	assert.deepEqual(mismatches, []);
});

it("places the note before the first input after a reset without a handoff, and gives each head its own note", { timeout: 20000 }, async (t) => {
	const { conversation, chain, ask, admit, mismatches } = await fixture(t);
	await admit("a", 7);
	await conversation.reset(undefined, context);
	const firstHead = await latestHead(conversation);
	await ask("after empty reset");
	const first = chain[0];
	const s = leadingSystems(first);
	assert.equal(s, 1);
	assert.deepEqual(noteIndexes(first), [s]);
	assert.equal(noteHead(first[s]), firstHead);
	assert.equal(text(first[s + 1]), "after empty reset");
	assert.equal(first.length, s + 2);
	await ask("same context");
	assertPrefix(first, chain[1]);

	const blank = await resetConversation(conversation, { requestId: "blank-reset", handoff: "   " }, context);
	assert.equal(blank.status, "placed");
	const secondHead = await latestHead(conversation);
	assert.ok(secondHead > firstHead);
	await ask("after blank reset");
	const third = chain[2];
	assert.deepEqual(noteIndexes(third), [leadingSystems(third)]);
	assert.equal(noteHead(third[leadingSystems(third)]), secondHead);
	assert.equal(text(third[leadingSystems(third) + 1]), "after blank reset");
	assert.deepEqual(mismatches, []);
});

it("distinguishes two reset heads with identical handoff text by entry identity", { timeout: 20000 }, async (t) => {
	const { conversation, chain, ask, admit, mismatches } = await fixture(t);
	await conversation.reset("Same handoff.", context);
	const firstHead = await latestHead(conversation);
	await ask("one");
	await admit("between", 9);
	await conversation.reset("Same handoff.", context);
	const secondHead = await latestHead(conversation);
	await ask("two");
	assert.notEqual(firstHead, secondHead);
	const [first, second] = chain;
	const s = leadingSystems(first);
	assert.equal(text(first[s]), text(second[s]));
	assert.equal(noteHead(first[s + 1]), firstHead);
	assert.equal(noteHead(second[s + 1]), secondHead);
	assert.doesNotMatch(text(first[s + 1]), /"requestId":"between"/u);
	assert.match(text(second[s + 1]), /"requestId":"between"/u);
	assert.deepEqual(mismatches, []);
});

it("inserts the note after a manual compaction summary on the first following request", { timeout: 20000 }, async (t) => {
	const { harness, conversation, chain, ask, admit, mismatches } = await fixture(t, { settings: { compaction: { keepRecentTokens: 1 } } });
	await ask("work before compaction");
	await admit("a", 7);
	const task = await conversation.compact("Keep the purpose.", context);
	const compacted = await harness.waitForTask(task, context);
	assert.equal(compacted.state.outcome.status, "completed");
	const head = await latestHead(conversation);
	await ask("after compaction");
	const first = chain.at(-1);
	assert.ok(first);
	const s = leadingSystems(first);
	assert.equal(s, 1);
	assert.equal(first[s].role, "user", "a compaction head is one user message");
	assert.deepEqual(noteIndexes(first), [s + 1]);
	assert.equal(noteHead(first[s + 1]), head);
	assert.match(text(first[s + 1]), /"requestId":"a"/u);
	await ask("same compacted context");
	assertPrefix(first, chain.at(-1) ?? []);
	assert.deepEqual(mismatches, []);
});

it("inserts the note on the request that follows a blocking threshold compaction", { timeout: 20000 }, async (t) => {
	const large: AssistantMessage = { ...answerMessage("large answer"), usage: { ...answerMessage().usage, input: 127000, totalTokens: 127500 } };
	const { conversation, chain, ask, admit, mismatches } = await fixture(t, { replies: [large], settings: { compaction: { enabled: true, keepRecentTokens: 1 } } });
	await ask("fill the context");
	await admit("a", 7);
	assert.deepEqual(noteIndexes(chain[0]), []);
	await ask("needs room");
	const head = await latestHead(conversation);
	const request = chain.at(-1);
	assert.ok(request);
	const s = leadingSystems(request);
	assert.deepEqual(noteIndexes(request), [s + 1]);
	assert.equal(noteHead(request[s + 1]), head);
	assert.match(text(request[s + 1]), /"requestId":"a"/u);
	assert.equal(chain.length, 2, "the generation prepares again after the summary, so one request follows the compaction");
	assert.deepEqual(mismatches, []);
});

it("inserts the note on the request that follows an overflow compaction", { timeout: 20000 }, async (t) => {
	const overflow: AssistantMessage = { ...answerMessage(""), content: [], stopReason: "error", errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" };
	const { conversation, chain, ask, admit, mismatches } = await fixture(t, { replies: [answerMessage("first answer"), overflow], settings: { compaction: { enabled: true, keepRecentTokens: 1 } } });
	await ask("work before overflow");
	await admit("a", 7);
	await ask("overflowing input");
	const head = await latestHead(conversation);
	const request = chain.at(-1);
	assert.ok(request);
	const s = leadingSystems(request);
	assert.deepEqual(noteIndexes(chain[1]), [], "the overflowing request preceded the head");
	assert.deepEqual(noteIndexes(request), [s + 1]);
	assert.equal(noteHead(request[s + 1]), head);
	assert.deepEqual(mismatches, []);
});

it("carries the new head's note on the first request after a reset queued during a run", { timeout: 20000 }, async (t) => {
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const began = new Promise<void>((resolve) => { started = resolve; });
	const { conversation, chain, ask, admit, mismatches } = await fixture(t, { replies: [toolCallMessage("gate")], tools: [gateTool(gate, started)] });
	await admit("a", 7);
	const submitted = await conversation.submit({ type: "input", content: "run a tool" }, context);
	await began;
	const queued = await resetConversation(conversation, { requestId: "busy-reset", handoff: "Handoff placed at the boundary." }, context);
	assert.equal(queued.status, "queued");
	release();
	// The boundary places the reset and ends the run; the interrupted input has no answer.
	const settled = await submitted.wait(context);
	assert.equal(settled.status, "unanswered");
	const head = await latestHead(conversation);
	assert.equal(chain.length, 1);
	assert.deepEqual(noteIndexes(chain[0]), []);
	await ask("after the busy reset");
	const request = chain.at(-1);
	assert.ok(request);
	const s = leadingSystems(request);
	assert.equal(text(request[s]), "Handoff placed at the boundary.");
	assert.deepEqual(noteIndexes(request), [s + 1]);
	assert.equal(noteHead(request[s + 1]), head);
	assert.match(text(request[s + 1]), /"requestId":"a"/u);
	assert.equal(text(request[s + 2]), "after the busy reset");
	assert.deepEqual(mismatches, []);
});

it("carries the note on the same run's next request after a compaction placed at a tool boundary", { timeout: 20000 }, async (t) => {
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const began = new Promise<void>((resolve) => { started = resolve; });
	const { harness, conversation, chain, admit, mismatches } = await fixture(t, { replies: [toolCallMessage("gate")], tools: [gateTool(gate, started)], settings: { compaction: { keepRecentTokens: 1 } } });
	await admit("a", 7);
	const submitted = await conversation.submit({ type: "input", content: "run a tool" }, context);
	await began;
	const task = await conversation.compact(undefined, context);
	assert.equal((await harness.waitForTask(task, context)).state.outcome.status, "completed");
	release();
	assert.equal((await submitted.wait(context)).status, "done");
	const head = await latestHead(conversation);
	assert.equal(chain.length, 2);
	assert.deepEqual(noteIndexes(chain[0]), []);
	const request = chain[1];
	const s = leadingSystems(request);
	assert.deepEqual(noteIndexes(request), [s + 1]);
	assert.equal(noteHead(request[s + 1]), head);
	assert.match(text(request[s + 1]), /"requestId":"a"/u);
	assert.deepEqual(mismatches, []);
});

it("keeps one final prefix when earlier and later hooks insert at the same anchor", { timeout: 20000 }, async (t) => {
	const insertAfterHead = (label: string): Partial<GenerationHooks> => ({
		beforeRequest(request) {
			const index = leadingSystems(request.messages) + 1;
			return { messages: [...request.messages.slice(0, index), { role: "user", content: label, timestamp: 0 }, ...request.messages.slice(index)] };
		},
	});
	const { conversation, chain, ask, mismatches } = await fixture(t, { before: insertAfterHead("earlier hook note"), after: insertAfterHead("later hook note") });
	await conversation.reset("Handoff.", context);
	await ask("one");
	await ask("two");
	const first = chain[0];
	const s = leadingSystems(first);
	assert.deepEqual(first.slice(s, s + 4).map(text).map((value) => HEADER.test(value) ? "continuity" : value), ["Handoff.", "later hook note", "continuity", "earlier hook note"]);
	assertPrefix(first, chain[1]);
	assert.deepEqual(mismatches, []);
});

it("inserts nothing and reports the mismatch when the head message differs from the request", { timeout: 20000 }, async (t) => {
	const { conversation, chain, ask, mismatches } = await fixture(t, {
		source: (mirror) => ({
			current(conversationId) {
				const frozen = mirror.current(conversationId);
				return frozen === undefined ? undefined : { ...frozen, head: { ...frozen.head, model: [{ role: "user", content: "another head message", timestamp: 0 }] } };
			},
		}),
	});
	await conversation.reset("Actual handoff.", context);
	const head = await latestHead(conversation);
	await ask("input");
	assert.deepEqual(noteIndexes(chain[0]), []);
	assert.deepEqual(mismatches, [{ conversationId: conversation.id, headId: head, mismatch: "head-message" }]);
});
