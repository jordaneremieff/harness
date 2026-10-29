import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { CompactionEntry, GenerationTask, hook, Harness, LiveDoc, MemoryStorage, type Conversation, type ConversationId, type HookApi, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import { answerMessage, completed, fixtureRegistry, fixtureRuntime, gateTool, toolCallMessage } from "./durable-host-fixture.mts";
import { inputEntry } from "./input-entry.ts";
import { cleanupRequestContexts, recordRequestContext, RequestContextDoc, REQUEST_NOTE_BYTES, REQUEST_NOTE_LIMIT, requestContextHooks, requestContextSection, type RequestContext } from "./request-context.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { RequestRouteState } from "./request-route-state.ts";

const user = (content: string, timestamp = 1): Message => ({ role: "user", content, timestamp });
const route = (requestId: string): RequestContext => ({ requestId, requester: "requester", replyTo: `recipient-${requestId}`, origin: "model" });
const text = (message: Message) => "content" in message ? typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") : "";
const notes = (messages: readonly Message[]) => messages.filter((message) => text(message).startsWith("<agent-request-route "));

async function fixture(t: TestContext, state = new RequestRouteState()) {
	const models = await fixtureRuntime("answer");
	const harness = await Harness.open(new MemoryStorage(), { models, registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	const hook = requestContextHooks(harness, state).beforeRequest;
	assert.ok(hook);
	let nextTask = 100;
	function api(conversationId: ConversationId = conversation.id): HookApi {
		const memos = new Map<string, unknown>();
		return { conversationId, taskId: nextTask++ as TaskId, models,
			async memo(name: string, ...args: unknown[]) {
				if (args.length === 2 && !memos.has(name)) memos.set(name, args[0]);
				return memos.get(name);
			},
		} as HookApi;
	}
	async function add(request: RequestContext | undefined, messages: Message[], target: Conversation = conversation) {
		return harness.commit(async (tx) => {
			if (request) await recordRequestContext(tx, target.id, request);
			const entry = await tx.appendEntry(target.id, { kind: "pi.user", ...inputEntry("model", "requester"), model: messages });
			return (await tx.createSubmission({ conversationId: target.id, requestId: request?.requestId ?? `unknown-${entry.id}`, type: "input", status: "placed", entry: entry.id })).id;
		}, context);
	}
	async function run(ids: SubmissionId[], target: Conversation = conversation) {
		await harness.commit(async (tx) => { (await tx.doc(LiveDoc, target.id)).run = { taskId: 123 as TaskId, inputs: ids }; }, context);
	}
	async function render(messages: readonly Message[], task = api(), selected = hook) {
		assert.ok(selected);
		return (await selected({ messages }, task, context))?.messages ?? messages;
	}
	return { harness, conversation, hook, api, add, run, render };
}

it("preserves exact prefixes across a tool round, a new run and request settlement", async (t) => {
	const f = await fixture(t);
	const first = user("First task");
	const a = await f.add(route("a"), [first]);
	await f.run([a]);
	const one = await f.render([first]);
	assert.equal(notes(one).length, 1);
	const tool: Message = { role: "toolResult", toolCallId: "call", toolName: "tool", content: [{ type: "text", text: "Result" }], isError: false, timestamp: 2 };
	const two = await f.render([first, tool]);
	assert.ok(JSON.stringify(two.slice(0, one.length)) === JSON.stringify(one), "the first request is an exact prefix");
	await f.harness.commit((tx) => tx.settleSubmission(a, { status: "unanswered", reason: "aborted" }), context);
	await f.harness.commit((tx) => cleanupRequestContexts(tx, f.conversation.id), context);
	const second = user("Second task", 3);
	const b = await f.add(route("b"), [second]);
	await f.run([b]);
	const three = await f.render([first, tool, second]);
	assert.ok(JSON.stringify(three.slice(0, two.length)) === JSON.stringify(two), "the tool round remains an exact prefix");
	assert.equal(notes(three).length, 2);
	await f.harness.commit((tx) => tx.settleSubmission(b, { status: "unanswered", reason: "aborted" }), context);
	await f.run([]);
	assert.deepEqual(await f.render([first, tool, second]), three);
});

it("places one note after the native user of a multi-message input, not the last user", async (t) => {
	const f = await fixture(t);
	const lead = user("Task preface");
	const task = user("Task body", 2);
	const a = await f.add(route("a"), [lead, task]);
	const unowned = user("Input without route", 3);
	const b = await f.add(undefined, [unowned]);
	await f.run([a, b]);
	const result = await f.render([lead, task, unowned]);
	assert.deepEqual(result.slice(0, 2), [lead, task]);
	assert.match(text(result[2]), /"requestId":"a"/u);
	assert.deepEqual(result[3], unowned);
	assert.equal(notes(result).length, 1);
});

it("keeps notes stable when another hook inserts user messages before native inputs", async (t) => {
	const f = await fixture(t);
	const first = user("First task");
	const a = await f.add(route("a"), [first]);
	await f.run([a]);
	const inserted = user("Independent hook notice", 8);
	const one = await f.render([inserted, first]);
	const second = user("Second task", 2);
	const b = await f.add(route("b"), [second]);
	await f.run([b]);
	const two = await f.render([inserted, first, user("Another notice", 9), second]);
	assert.ok(JSON.stringify(two.slice(0, one.length)) === JSON.stringify(one), "the first request is an exact prefix");
	assert.deepEqual(notes(two)[0], notes(one)[0]);
	assert.equal(notes(two).length, 2);
});

it("distinguishes identical inputs by native order and includes timestamps in digests", async (t) => {
	const f = await fixture(t);
	const same = user("Same task");
	const a = await f.add(route("a"), [same]);
	const b = await f.add(route("b"), [same]);
	const different = user("Same task", 2);
	const c = await f.add(route("c"), [different]);
	await f.run([b, c, a]);
	const result = await f.render([same, same, different]);
	assert.deepEqual(notes(result).map((note) => JSON.parse(text(note).split("\n")[1]).requestId), ["a", "b", "c"]);
});

it("resolves the same task memo by native entry after overflow compaction removes an identical input", async (t) => {
	const f = await fixture(t);
	const same = user("Identical task");
	const a = await f.add(route("a"), [same]);
	const b = await f.add(route("b"), [same]);
	await f.run([a, b]);
	const task = f.api();
	const before = await f.render([same, same], task);
	assert.equal(notes(before).length, 2);
	const saved = await task.memo("agent:request-routes", context);
	assert.ok(Array.isArray(saved) && saved[0] && typeof saved[0] === "object");
	assert.equal(Object.keys(saved[0]).sort().join(","), "digest,entryId,text");
	await f.harness.commit(async (tx) => {
		const submission = await tx.submissionByRequest(f.conversation.id, "b");
		assert.ok(submission?.entry);
		await tx.appendEntry(CompactionEntry, f.conversation.id, { head: submission.entry, data: { reason: "overflow" }, model: [user("Summary", 2)] });
	}, context);
	await f.harness.commit((tx) => tx.settleSubmission(a, { status: "unanswered", reason: "aborted" }), context);
	await f.run([b]);
	const compacted = await f.render((await f.conversation.context(context)).messages, task);
	assert.deepEqual(notes(compacted), [notes(before)[1]], "the surviving input retains its own frozen note");
	const c = await f.add(route("c"), [same]);
	await f.run([b, c]);
	const after = await f.render((await f.conversation.context(context)).messages);
	assert.deepEqual(notes(after).map((note) => JSON.parse(text(note).split("\n")[1]).requestId), ["b", "c"]);
});

it("does not read the native context view for unique input digests", async (t) => {
	const f = await fixture(t);
	const first = user("Unique input");
	const a = await f.add(route("a"), [first]);
	await f.run([a]);
	const read = t.mock.method(f.harness, "conversation", async () => { throw new Error("Unexpected context view read"); });
	const task = f.api();
	assert.equal(notes(await f.render([first], task)).length, 1);
	assert.equal(notes(await f.render([first], task)).length, 1);
	assert.equal(read.mock.callCount(), 0);
});

it("returns no change after an internal harness read fails", async (t) => {
	const f = await fixture(t);
	const first = user("Task");
	const a = await f.add(route("a"), [first]);
	await f.run([a]);
	t.mock.method(f.harness, "commit", async () => { throw new Error("Read unavailable"); });
	assert.ok(f.hook);
	assert.equal(await f.hook({ messages: [first] }, f.api(), context), undefined);
});

it("propagates abort errors instead of returning no change", async (t) => {
	const f = await fixture(t);
	const failure = new Error("Aborted read");
	t.mock.method(f.harness, "commit", async () => { throw failure; });
	const controller = new AbortController();
	controller.abort();
	const selected = f.hook;
	assert.ok(selected);
	await assert.rejects(async () => selected({ messages: [user("Task")] }, f.api(), withAbortSignal(controller.signal, context)), (error) => error === failure);
});

it("freezes task notes for retries even after route settlement", async (t) => {
	const f = await fixture(t);
	const first = user("First task");
	const a = await f.add(route("a"), [first]);
	await f.run([a]);
	const task = f.api();
	const one = await f.render([first], task);
	await f.harness.commit((tx) => tx.settleSubmission(a, { status: "unanswered", reason: "aborted" }), context);
	await f.run([]);
	const freshHook = requestContextHooks(f.harness).beforeRequest;
	assert.ok(freshHook);
	assert.deepEqual(await f.render([first], task, freshHook), one);
});

it("drops absent notes on compaction and reconstructs only active routes after restart", async (t) => {
	const f = await fixture(t);
	const first = user("First task");
	const second = user("Second task", 2);
	const a = await f.add(route("a"), [first]);
	const b = await f.add(route("b"), [second]);
	await f.run([a, b]);
	const before = await f.render([first, second]);
	await f.harness.commit((tx) => tx.settleSubmission(a, { status: "unanswered", reason: "aborted" }), context);
	await f.run([b]);
	const restarted = requestContextHooks(f.harness).beforeRequest;
	assert.ok(restarted);
	const after = await f.render([first, second], f.api(), restarted);
	assert.equal(notes(after).length, 1);
	assert.match(text(notes(after)[0]), /"requestId":"b"/u);
	const compacted = await f.render([user("Summary", 3), second]);
	assert.equal(notes(compacted).length, 1);
	assert.deepEqual(notes(compacted)[0], notes(before)[1]);
	assert.equal(notes(await f.render([user("Summary only", 4)])).length, 0);
	await f.run([]);
	assert.equal(notes(await f.render([first])).length, 0, "an absent note does not resurrect after compaction");
});

for (const bound of ["count", "bytes"] as const) it(`bounds retained note ${bound} by dropping oldest settled notes without stopping generation`, async (t) => {
	const state = new RequestRouteState();
	const f = await fixture(t, state);
	const first = user("Retained task");
	const a = await f.add(route("a"), [first]);
	const ids = await f.harness.commit(async (tx) => {
		const routes = await tx.doc(RequestContextDoc, f.conversation.id);
		const submissions: SubmissionId[] = [a];
		for (let index = 0; index < REQUEST_NOTE_LIMIT - 1; index++) {
			const suffix = String(index);
			const request = bound === "count" ? route(`new-${index}`) : { requestId: "界".repeat(1024 - suffix.length) + suffix, requester: "界".repeat(256), replyTo: "界".repeat(256), origin: "model" as const };
			routes.requests.push(request);
			const entry = await tx.appendEntry(f.conversation.id, { kind: "pi.user", ...inputEntry("model", "requester"), model: [user(`Task ${index}`, index + 2)] });
			submissions.push((await tx.createSubmission({ conversationId: f.conversation.id, requestId: request.requestId, type: "input", status: "placed", entry: entry.id })).id);
		}
		return submissions;
	}, context);
	await f.run(ids);
	const initial = notes(await f.render((await f.conversation.context(context)).messages));
	assert.equal(initial.length, REQUEST_NOTE_LIMIT, "active notes always survive");
	await f.harness.commit((tx) => {
		for (const id of ids.slice(1)) tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
	}, context);
	const current = await f.add(route("current"), [user("Current task", REQUEST_NOTE_LIMIT + 2)]);
	await f.run([a, current]);
	const after = notes(await f.render((await f.conversation.context(context)).messages));
	const routeIds = after.map((note) => JSON.parse(text(note).split("\n")[1]).requestId as string);
	assert.ok(routeIds.includes("a"), "the oldest active input survives");
	assert.ok(routeIds.includes("current"), "the new active input survives");
	const oldestSettled = JSON.parse(text(initial[1]).split("\n")[1]).requestId as string;
	const newestSettled = JSON.parse(text(initial.at(-1) as Message).split("\n")[1]).requestId as string;
	assert.ok(!routeIds.includes(oldestSettled), "the oldest settled input leaves first");
	assert.ok(routeIds.includes(newestSettled), "newer settled inputs remain");
	assert.ok(after.length <= REQUEST_NOTE_LIMIT);
	assert.ok(Buffer.byteLength(JSON.stringify(state.get(f.conversation.id))) <= REQUEST_NOTE_BYTES);
});

it("evicts the least recently used conversation and reconstructs its active route", async (t) => {
	const state = new RequestRouteState(600);
	const f = await fixture(t, state);
	const second = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	const third = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	const firstInput = user("First");
	const secondInput = user("Second");
	const thirdInput = user("Third");
	const a = await f.add(route("a"), [firstInput]);
	const b = await f.add(route("b"), [secondInput], second);
	const c = await f.add(route("c"), [thirdInput], third);
	await f.run([a]);
	await f.run([b], second);
	await f.run([c], third);
	await f.render([firstInput]);
	await f.render([secondInput], f.api(second.id));
	await f.render([firstInput]);
	await f.render([thirdInput], f.api(third.id));
	assert.equal(state.get(second.id), undefined, "the least recently used conversation leaves the host cache");
	assert.equal(state.get(f.conversation.id)?.length, 1);
	assert.equal(state.get(third.id)?.length, 1);
	const recovered = notes(await f.render([secondInput], f.api(second.id)));
	assert.equal(recovered.length, 1);
	assert.equal(JSON.parse(text(recovered[0]).split("\n")[1]).requestId, "b");
});

it("the route hook adds no per-request bytes across tool rounds and settled runs", { timeout: 10000 }, async (t) => {
	const runtime = await createTestRuntime();
	const requests: Message[][] = [];
	runtime.registerNativeProvider({
		id: testModel.provider, name: "Route prefix fixture", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: () => { throw new Error("Unexpected stream"); },
		streamSimple: (_model, input) => {
			requests.push(structuredClone([...input.messages]));
			return completed(requests.length === 1 ? toolCallMessage("gate") : answerMessage("Done"));
		},
	});
	const registry = fixtureRegistry([gateTool(Promise.resolve())]);
	let harness!: Harness;
	registry.install({ name: "independent-input-notice", hooks: [hook(GenerationTask, {
		beforeRequest(request) {
			const messages = request.messages.flatMap((message) => message.role === "user" ? [user("Independent notice", message.timestamp), message] : [message]);
			return { messages };
		},
	})] });
	registry.install({ name: "route-notes", sections: [requestContextSection(() => harness)], hooks: [hook(GenerationTask, requestContextHooks(() => harness))] });
	harness = await Harness.open(new MemoryStorage(), { models: runtime, registry }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	for (const id of ["a", "b"]) {
		await harness.commit((tx) => recordRequestContext(tx, conversation.id, route(id)), context);
		const submission = await conversation.submit({ type: "input", requestId: id, content: `Task ${id}` }, context);
		await submission.wait(context);
	}
	assert.equal(requests.length, 3);
	assert.ok(JSON.stringify(requests[1].slice(0, requests[0].length)) === JSON.stringify(requests[0]), "the first provider request is an exact prefix");
	assert.ok(JSON.stringify(requests[2].slice(0, requests[1].length)) === JSON.stringify(requests[1]), "the settled run remains an exact prefix");
	assert.equal(notes(requests[0]).length, 1);
	assert.equal(notes(requests[2]).length, 2);
	for (const request of requests) {
		for (let index = 0; index < request.length; index++) {
			if (text(request[index]).startsWith("<agent-request-route ")) assert.match(text(request[index - 1]), /^Task [ab]$/u);
		}
	}
});
