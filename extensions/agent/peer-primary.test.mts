import assert from "node:assert/strict";
import { it } from "node:test";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPrimaryObserver } from "./peer-primary.ts";

const CALL_TS = 1_700_000_000_000;

function assistant(content: AssistantMessage["content"], timestamp = CALL_TS, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		content,
		stopReason,
		timestamp,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function user(text: string, timestamp = CALL_TS - 1): Message {
	return { role: "user", content: text, timestamp };
}

function toolResult(toolCallId: string, toolName: string, text: string, timestamp = CALL_TS + 1): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp };
}

function send(observer: ReturnType<typeof createPrimaryObserver>, type: string, data: Record<string, unknown> = {}): void {
	observer.observe({ type, ...data });
}

interface Fake {
	ctx: ExtensionContext;
	editor(): string;
	sent: Array<{ text: string; options?: unknown }>;
}

function fake(idle = true, model: { provider: string; id: string } = { provider: "test", id: "test-model" }): Fake {
	const sessionManager = SessionManager.inMemory("/work");
	let editor = "";
	const sent: Array<{ text: string; options?: unknown }> = [];
	const pi = { sendUserMessage: (text: string, options?: unknown) => { sent.push({ text, options }); } } as unknown as ExtensionAPI;
	const ctx = {
		sessionManager,
		cwd: "/work",
		model,
		isIdle: () => idle,
		ui: {
			getEditorText: () => editor,
			setEditorText: (text: string) => { editor = text; },
		},
	} as unknown as ExtensionContext;
	return { ctx, editor: () => editor, sent, sessionManager, pi } as Fake & { sessionManager: SessionManager; pi: ExtensionAPI };
}

function textOf(entry: { model?: readonly Message[] }): string {
	return (entry.model ?? []).map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join(" ")).join(" | ");
}

it("projects user, assistant with tool calls, tool results, and custom notices", () => {
	const fakeWorld = fake() as Fake & { sessionManager: SessionManager; pi: ExtensionAPI };
	const sm = fakeWorld.sessionManager;
	sm.appendMessage(user("TASK: read a.txt"));
	const call: ToolCall = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } };
	sm.appendMessage(assistant([{ type: "text", text: "I will read it." }, call]));
	sm.appendMessage(toolResult("c1", "read", "file contents"));
	sm.appendCustomMessageEntry("agent.peer", "Agent done", true);
	const observer = createPrimaryObserver();
	observer.attach(fakeWorld.ctx, fakeWorld.pi);
	const snapshot = observer.snapshot();
	const kinds = snapshot.entries.map((entry) => entry.kind);
	assert.deepEqual(kinds, ["pi.user", "pi.assistant", "pi.tool-result", "pi.custom_message"]);
	assert.equal(snapshot.entries.filter((entry) => textOf(entry).includes("TASK: read a.txt")).length, 1);
	assert.equal(snapshot.entries.filter((entry) => textOf(entry).includes("Agent done")).length, 1);
	assert.equal(snapshot.entries.filter((entry) => textOf(entry).includes("file contents")).length, 1);
	assert.deepEqual(snapshot.live, []);
});

it("reconciles a streaming partial with its committed entry exactly once", () => {
	const fakeWorld = fake() as Fake & { sessionManager: SessionManager; pi: ExtensionAPI };
	const sm = fakeWorld.sessionManager;
	const observer = createPrimaryObserver();
	observer.attach(fakeWorld.ctx, fakeWorld.pi);
	const start = assistant([{ type: "text", text: "part" }], CALL_TS, "stop");
	send(observer, "message_start", { message: start });
	send(observer, "message_update", { message: assistant([{ type: "text", text: "partial answer" }], CALL_TS, "stop") });
	let snapshot = observer.snapshot();
	assert.equal(snapshot.entries.length, 0);
	assert.equal(snapshot.live.filter((entry) => textOf(entry).includes("partial answer")).length, 1);
	const liveRevision = snapshot.liveRevision;

	const final = assistant([{ type: "text", text: "committed answer" }], CALL_TS, "stop");
	sm.appendMessage(final);
	send(observer, "message_end", { message: final });
	send(observer, "turn_end");
	snapshot = observer.snapshot();
	assert.notEqual(snapshot.liveRevision, liveRevision);
	assert.equal(snapshot.live.length, 0, "live material drops after the committed entry exists");
	const committed = snapshot.entries.filter((entry) => textOf(entry).includes("committed answer"));
	assert.equal(committed.length, 1, "the committed assistant entry appears once");
	assert.equal(textOf(committed[0]).includes("partial answer"), false);
});

it("pairs a running tool with its committed call and drops the live copy after commit", () => {
	const fakeWorld = fake() as Fake & { sessionManager: SessionManager; pi: ExtensionAPI };
	const sm = fakeWorld.sessionManager;
	const call: ToolCall = { type: "toolCall", id: "c2", name: "bash", arguments: { command: "echo hi" } };
	sm.appendMessage(assistant([{ type: "text", text: "Running." }, call]));
	const observer = createPrimaryObserver();
	observer.attach(fakeWorld.ctx, fakeWorld.pi);
	send(observer, "tool_execution_start", { toolCallId: "c2", toolName: "bash", args: { command: "echo hi" } });
	let snapshot = observer.snapshot();
	assert.equal(snapshot.entries.filter((entry) => textOf(entry).includes("Running.")).length, 0, "the call's assistant block moves to the live tail while its result runs");
	assert.equal(snapshot.live.filter((entry) => textOf(entry).includes("Running.")).length, 1);
	assert.equal(snapshot.live.filter((entry) => entry.kind === "pi.tool-result").length, 1);

	send(observer, "tool_execution_update", { toolCallId: "c2", toolName: "bash", args: { command: "echo hi" }, partialResult: { content: [{ type: "text", text: "running output" }] } });
	snapshot = observer.snapshot();
	assert.equal(snapshot.live.filter((entry) => textOf(entry).includes("running output")).length, 1);

	send(observer, "tool_execution_end", { toolCallId: "c2", toolName: "bash", result: { content: [{ type: "text", text: "final output" }] }, isError: false });
	snapshot = observer.snapshot();
	assert.equal(snapshot.live.filter((entry) => textOf(entry).includes("final output")).length, 1);

	sm.appendMessage(toolResult("c2", "bash", "retained output"));
	send(observer, "message_end", { message: toolResult("c2", "bash", "retained output") });
	snapshot = observer.snapshot();
	assert.equal(snapshot.live.length, 0);
	assert.equal(snapshot.entries.filter((entry) => textOf(entry).includes("Running.")).length, 1);
	assert.equal(snapshot.entries.filter((entry) => textOf(entry).includes("retained output")).length, 1);
});

it("sends plain text with the chosen busy behavior and keeps it until commit", () => {
	const fakeWorld = fake(true) as Fake & { sessionManager: SessionManager; pi: ExtensionAPI };
	const observer = createPrimaryObserver();
	observer.attach(fakeWorld.ctx, fakeWorld.pi);
	observer.sendPlain("idle text", "auto");
	assert.deepEqual(fakeWorld.sent, [{ text: "idle text", options: undefined }]);
	assert.equal(observer.snapshot().live.filter((entry) => textOf(entry).includes("idle text")).length, 1);

	fakeWorld.sessionManager.appendMessage(user("idle text"));
	send(observer, "message_end", { message: user("idle text") });
	assert.equal(observer.snapshot().live.length, 0, "the optimistic input clears when the committed user message matches");
});

it("uses follow-up by default when the primary is busy and honors an explicit steer", () => {
	const fakeWorld = fake(false) as Fake & { sessionManager: SessionManager; pi: ExtensionAPI };
	const observer = createPrimaryObserver();
	observer.attach(fakeWorld.ctx, fakeWorld.pi);
	observer.sendPlain("busy auto", "auto");
	observer.sendPlain("busy steer", "steer");
	observer.sendPlain("busy follow", "followUp");
	assert.deepEqual(fakeWorld.sent, [
		{ text: "busy auto", options: { deliverAs: "followUp" } },
		{ text: "busy steer", options: { deliverAs: "steer" } },
		{ text: "busy follow", options: { deliverAs: "followUp" } },
	]);
});

it("derives primary cost from assistant usage and state from run events", () => {
	const fakeWorld = fake() as Fake & { sessionManager: SessionManager; pi: ExtensionAPI };
	const observer = createPrimaryObserver();
	observer.attach(fakeWorld.ctx, fakeWorld.pi);
	let snapshot = observer.snapshot();
	assert.equal(snapshot.descriptor.state, "idle");
	assert.equal(snapshot.descriptor.cost, 0);

	send(observer, "agent_start");
	assert.equal(observer.snapshot().descriptor.state, "working");

	const priced = assistant([{ type: "text", text: "priced answer" }], CALL_TS + 5);
	priced.usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 } };
	fakeWorld.sessionManager.appendMessage(priced);
	send(observer, "message_end", { message: priced });
	snapshot = observer.snapshot();
	assert.equal(snapshot.descriptor.cost, 0.25);
	assert.equal(snapshot.descriptor.partialCost, undefined);

	send(observer, "agent_end");
	assert.equal(observer.snapshot().descriptor.state, "idle");
});

it("skips a custom message stored with display:false like native Pi", () => {
	const fakeWorld = fake() as Fake & { sessionManager: SessionManager; pi: ExtensionAPI };
	fakeWorld.sessionManager.appendCustomMessageEntry("policy.contract", "hidden contract body", false);
	fakeWorld.sessionManager.appendCustomMessageEntry("agent.peer", "visible notice body", true);
	const observer = createPrimaryObserver();
	observer.attach(fakeWorld.ctx, fakeWorld.pi);
	const snapshot = observer.snapshot();
	assert.equal(snapshot.entries.some((entry) => textOf(entry).includes("hidden contract body")), false);
	assert.equal(snapshot.entries.filter((entry) => textOf(entry).includes("visible notice body")).length, 1);
});

it("re-reads the session after a quiet append that emits no extension event", () => {
	const fakeWorld = fake() as Fake & { sessionManager: SessionManager; pi: ExtensionAPI };
	const observer = createPrimaryObserver();
	observer.attach(fakeWorld.ctx, fakeWorld.pi);
	assert.equal(observer.snapshot().entries.length, 0);
	fakeWorld.sessionManager.appendCustomMessageEntry("agent.peer", "quiet notice", true);
	assert.equal(observer.snapshot().entries.length, 0, "the cached projection stays until the observer re-reads");
	observer.refresh();
	const snapshot = observer.snapshot();
	assert.equal(snapshot.entries.filter((entry) => textOf(entry).includes("quiet notice")).length, 1);
});

it("hands a draft to the native editor and returns the replaced draft", () => {
	const fakeWorld = fake() as Fake & { sessionManager: SessionManager; pi: ExtensionAPI };
	const observer = createPrimaryObserver();
	observer.attach(fakeWorld.ctx, fakeWorld.pi);
	assert.equal(observer.handoffToNative("keep this"), "");
	assert.equal(observer.nativeDraft(), "keep this");
	// Seed a native draft before the replacement.
	fakeWorld.ctx.ui.setEditorText("native draft");
	assert.equal(observer.handoffToNative("/model"), "native draft");
	assert.equal(observer.nativeDraft(), "/model");
});
