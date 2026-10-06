import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { initTheme, createCodemodeExtension, AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, getMarkdownTheme, type ExtensionAPI, type ToolDefinition, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Text, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createDashboardToolDefinitions } from "./dashboard-tool-definitions.ts";
import { agentState, createDashboardState } from "./dashboard-state.ts";
import { AgentConversation, cleanDashboardText, firstTaskEntry, renderableEntries } from "./dashboard-conversation.ts";
import type { AgentConversationEntry, AgentConversationSnapshot, AgentConversationSummary } from "./dashboard-types.ts";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureRegistry, gateTool, hostOptions, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import { profileText } from "./profile-dialog.ts";
import type { AgentProfile } from "./profile-schema.ts";
import { deferred } from "./dashboard-test-fixture.mts";

initTheme("dark");
const tui = { requestRender() {} } as TUI;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (id: string, content: AssistantMessage["content"], timestamp = 2): AgentConversationEntry => ({
	id,
	kind: "pi.assistant",
	model: [
		{
			role: "assistant",
			content,
			api: "openai-responses",
			provider: "test",
			model: "test",
			timestamp,
			stopReason: "toolUse",
			usage,
		},
	],
});
const result = (
	id: string,
	toolCallId: string,
	toolName: string,
	text: string,
	isError = false,
): AgentConversationEntry => ({
	id,
	kind: "pi.tool-result",
	model: [{ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 3 }],
});
const user = (id: string, content: string): AgentConversationEntry => ({
	id,
	kind: "pi.user",
	model: [{ role: "user", content, timestamp: 1 }],
});
const screen = (conversation: AgentConversation, width = 80) =>
	stripVTControlCharacters(conversation.render(width).lines.join("\n"));

it("renders retry dependency facts before generic wait lines and removes them on the next native frame", () => {
	const reference = { sessionId: "producer:2", submissionId: 23, requestId: "exact-request" };
	const conversation = new AgentConversation([], "/work", tui, false, false);
	conversation.setAwaiting({ runId: 10, heldInputs: [12], results: [{ result: reference, status: "pending" }], queuedInputCount: 0, queueSnapshot: "committed InboxDoc", omitted: { heldInputs: 0, results: 0 }, omittedProducers: 0, likelyCycle: [], coverage: "one hop; remote graph incomplete", producers: [{ sessionId: reference.sessionId, observedAt: 1, source: "producer await-state", execution: { state: "provider-retry", runId: 20, results: [reference], model: { provider: "synthetic", modelId: "model" }, attempt: 18, maxAttempts: 21, nextRetryAt: 1791200000000, error: "429 Weekly/Monthly Limit Exhausted", errorTruncated: false } }] });
	const text = screen(conversation, 160);
	assert.match(text, /producer:2.*submission 23/u); assert.match(text, /provider retry/u); assert.match(text, /attempt 18\/21/u); assert.match(text, /Weekly\/Monthly Limit Exhausted/u);
	assert.ok(text.indexOf("provider retry") < text.indexOf("Awaiting"));
	conversation.setAwaiting(); assert.doesNotMatch(screen(conversation), /provider retry|Weekly\/Monthly/u);
});

it("renders native await references and release outcomes through display-only agent cards", () => {
	const reference = { sessionId: "full-canonical-peer-identity:2", submissionId: 23, requestId: "exact-request" };
	const reply = { decision: "released", results: [], unresolved: [reference], originalInputs: [12], queuedInputCount: 1, releaseReason: "dashboard release" };
	const completed = result("done", "await-call", "agent_await", JSON.stringify(reply));
	const message = completed.model?.[0]; assert.ok(message?.role === "toolResult"); message.details = { structuredContent: reply };
	const entries = [assistant("call", [{ type: "toolCall", id: "await-call", name: "agent_await", arguments: { results: [reference] } }]), completed];
	const text = screen(new AgentConversation(entries, "/work", tui, false, false), 120);
	assert.match(text, /agent_await/u); assert.match(text, /full-canonical-peer-identity:2/u); assert.match(text, /submission 23/u);
	assert.match(text, /Wait released.*1 unresolved/u); assert.match(text, /1 queued inputs/u); assert.match(text, /dashboard release/u);
	assert.doesNotMatch(text, /Await error|Responding/u);
	assert.ok(new AgentConversation(entries, "/work", tui, false, false).render(35).lines.every((line) => visibleWidth(line) <= 35));
});

it("uses native built-in tools, generic unknown tools and unmatched results without execution", () => {
	const entries: AgentConversationEntry[] = [
		assistant("a", [
			{ type: "toolCall", id: "read-one", name: "read", arguments: { path: "source.ts" } },
			{ type: "toolCall", id: "unknown-one", name: "example_tool", arguments: { query: "bounded query" } },
		]),
		result("t1", "read-one", "read", "const nativeRead = true;"),
		result("t2", "unknown-one", "example_tool", "Generic result"),
		result("t3", "unmatched", "absent_call", "Retained result without its call", true),
	];
	const conversation = new AgentConversation(entries, "/work", tui, false, false);
	const text = screen(conversation);
	assert.match(text, /source\.ts/);
	assert.doesNotMatch(text, /nativeRead/);
	assert.match(screen(new AgentConversation(entries, "/work", tui, true, false)), /nativeRead/);
	assert.match(text, /example_tool/);
	assert.match(text, /Generic result/);
	assert.match(text, /Retained result without its call/);
	assert.doesNotMatch(text, /Message unavailable|\{\}/);
	assert.deepEqual(conversation.render(80), conversation.render(80));
	conversation.invalidate();
	assert.ok(conversation.render(50).lines.every((line) => visibleWidth(line) <= 50));
});

it("standard tool previews keep ten logical lines and native named arguments", () => {
	for (const width of [30, 80, 120]) {
		const output = Array.from({ length: 13 }, (_, i) => `row ${i + 1} ${"界🙂".repeat(20)}`).join("\n");
		const entries = [
			assistant("call", [{ type: "toolCall", id: "unknown", name: "extension_tool", arguments: { query: "first line\nsecond line", count: 23 } }]),
			result("result", "unknown", "extension_tool", output),
			assistant("reply", [{ type: "text", text: "The agent answer leads." }]),
		];
		const collapsed = new AgentConversation(entries, "/work", tui, false, false).render(width).lines.map(stripVTControlCharacters);
		assert.ok(collapsed.every((line) => visibleWidth(line) <= width));
		assert.match(collapsed.join("\n"), /query=/u);
		assert.match(collapsed.join("\n"), /row 10/u);
		assert.match(collapsed.join("\n"), /expand/u);
		assert.doesNotMatch(collapsed.join("\n"), /row 11/u);
		const expanded = screen(new AgentConversation(entries, "/work", tui, true, false), width);
		assert.match(expanded, /count: 23/u);
		assert.match(expanded, /row 13/u);
		assert.doesNotMatch(expanded, /more lines/u);
	}
});

it("renders tool-call-only and thinking-only assistant entries and attaches their results", () => {
	const entries: AgentConversationEntry[] = [
		assistant("a", [
			{ type: "thinking", thinking: "Plan the shell steps" },
			{ type: "toolCall", id: "bash-one", name: "bash", arguments: { command: "echo step-1" } },
			{
				type: "toolCall",
				id: "write-one",
				name: "write",
				arguments: { path: "poem.txt", content: "line one\nline two\n" },
			},
		]),
		result("t1", "bash-one", "bash", "step-1\n"),
		result("t2", "write-one", "write", "Successfully wrote to poem.txt"),
	];
	assert.deepEqual(
		renderableEntries(entries).map((entry) => entry.id),
		["a", "t1", "t2"],
	);
	const text = screen(new AgentConversation(entries, "/work", tui, false, false));
	assert.match(text, /\$ echo step-1/);
	assert.match(text, /poem\.txt/);
	assert.match(text, /Thinking\.\.\./);
	assert.doesNotMatch(text, /\{\}/);
	assert.match(screen(new AgentConversation(entries, "/work", tui, false, true)), /Plan the shell steps/);
});

it("shows a retained result whose call is absent without an empty argument object", () => {
	const entries: AgentConversationEntry[] = [result("t", "missing", "example_tool", "Retained output sentinel")];
	assert.deepEqual(
		renderableEntries(entries).map((entry) => entry.id),
		["t"],
	);
	const text = screen(new AgentConversation(entries, "/work", tui, false, false));
	assert.match(text, /example_tool/);
	assert.match(text, /Retained output sentinel/);
	assert.doesNotMatch(text, /\{\}/);
});

it("preserves adjacent native component rows without synthetic separators", () => {
	const entries: AgentConversationEntry[] = [
		user("u", "The task"),
		assistant("a", [{ type: "text", text: "Working on it." }]),
		result("t", "missing-call", "example_tool", "kept output"),
	];
	const native = new Container();
	native.addChild(new UserMessageComponent("The task", getMarkdownTheme()));
	native.addChild(new AssistantMessageComponent(entries[1].model?.[0] as AssistantMessage, true, getMarkdownTheme(), "Thinking..."));
	const tool = new ToolExecutionComponent("example_tool", "missing-call", undefined, { showImages: false }, createDashboardToolDefinitions("/work")("example_tool", false), tui, "/work");
	tool.updateResult({ content: [{ type: "text", text: "kept output" }], isError: false });
	native.addChild(tool);
	for (const width of [30, 80, 120]) assert.deepEqual(new AgentConversation(entries, "/work", tui, false, false).render(width).lines, native.render(width));
	const rows = tool.render(80);
	assert.equal(rows[0], "");
	assert.equal(visibleWidth(rows[1]), 80);
	assert.equal(stripVTControlCharacters(rows[1]).trim(), "");
	assert.notEqual(rows[1], stripVTControlCharacters(rows[1]), "background padding stays colored");
	const bottom = rows.at(-1); assert.ok(bottom);
	assert.equal(visibleWidth(bottom), 80);
});

it("recovers the first task from the session summary when the bounded transcript omits it", () => {
	const late: AgentConversationEntry[] = [assistant("late", [{ type: "text", text: "Late answer" }])];
	const synthetic = firstTaskEntry({ entries: late, partial: true }, { firstMessage: "Run the checks" });
	assert.ok(synthetic);
	const message = synthetic.model?.[0] as { content?: unknown } | undefined;
	assert.equal(message?.content, "Historical first input:\nRun the checks");
	assert.equal(firstTaskEntry({ entries: late, partial: true }, undefined), undefined);
	assert.equal(firstTaskEntry({ entries: late, partial: false }, { firstMessage: "Run the checks" }), undefined);
	assert.equal(
		firstTaskEntry({ entries: [user("u", "Run the checks")], partial: true }, { firstMessage: "Run the checks" }),
		undefined,
	);
});

const naturalTask = "What changed since yesterday?";
const taskInputs: Array<{ name: string; content: UserMessage["content"]; text: string; image?: boolean }> = [
	{ name: "text", content: naturalTask, text: naturalTask },
	{ name: "leading whitespace", content: ` \n${naturalTask}`, text: naturalTask },
	{ name: "image before text", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "text", text: naturalTask }], text: naturalTask, image: true },
];
for (const input of taskInputs) {
	it(`matches historical ${input.name} against task text rather than display placeholders`, () => {
		const entries: AgentConversationEntry[] = [{ id: "task", kind: "pi.user", model: [{ role: "user", content: input.content, timestamp: 1 }] }];
		assert.equal(firstTaskEntry({ entries, partial: true }, { firstMessage: input.text }), undefined);
		assert.equal(firstTaskEntry({ entries, partial: true }, { firstMessage: input.text.slice(0, 12) }), undefined);
	});
	it(`native ${input.name} admission displays the task without host routes or a duplicate historical input`, { timeout: 10000 }, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "dashboard-request-"));
		const released = deferred();
		const started = deferred();
		let host: DurableHost | undefined;
		t.after(async () => { released.resolve(); await host?.close(); rmSync(root, { recursive: true, force: true }); });
		host = await DurableHost.open(hostOptions(join(root, "agent.sqlite"),
			await scriptedRuntime([toolCallMessage("gate"), answerMessage()]),
			fixtureRegistry([gateTool(released.promise, started.resolve)]), root));
		const route = { requestId: "display-request", requester: "requester-sentinel", replyTo: "recipient-sentinel", origin: "operator" };
		await host.request("task-submit", { sessionId: host.storageId, message: input.content, ...route });
		await started.promise;
		const snapshot = await host.request("snapshot", { sessionId: host.storageId }) as AgentConversationSnapshot;
		const rows = await host.request("dashboard", {}) as AgentConversationSummary[];
		const row = rows.find((value) => value.id === host?.storageId);
		assert.ok(row?.firstMessage);
		assert.equal(row.firstMessage.trim(), input.text);
		assert.equal(firstTaskEntry({ ...snapshot, partial: true }, row), undefined);
		const users = snapshot.entries.filter((entry) => entry.kind === "pi.user");
		assert.equal(users.length, 1);
		for (const width of [40, 80, 120]) {
			const lines = new AgentConversation(users, root, tui, false, false).render(width).lines;
			const text = stripVTControlCharacters(lines.join("\n"));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(text, /What changed since yesterday\?/);
			assert.doesNotMatch(text, /Host request context|Task content|requester-sentinel|recipient-sentinel|mode:.*report|Historical first input/);
			assert.equal(text.match(/What changed since yesterday\?/g)?.length, 1);
			if (input.image) assert.match(text, /\[Image\]/);
		}
		const profile = await host.request("profile-read", { sessionId: host.storageId }) as AgentProfile;
		assert.deepEqual(profile.requests, [{ ...route, status: "placed" }]);
		assert.ok(profileText(profile).includes("Requester: requester-sentinel\n  Reply recipient: recipient-sentinel"));
	});
}

for (const width of [40, 80, 120]) {
	it(`retains routing-looking user text verbatim at width ${width}`, () => {
		const text = 'Host request context: {"requester":"quoted-person"}\nTask content:\nKeep this literal example.';
		const entries = [user("quoted", text)];
		const shown = screen(new AgentConversation(entries, "/work", tui, false, false), width);
		assert.equal(shown.replace(/\s/gu, ""), text.replace(/\s/gu, ""));
		assert.equal(firstTaskEntry({ entries, partial: true }, { firstMessage: text }), undefined);
		assert.ok(firstTaskEntry({ entries, partial: true }, { firstMessage: "Keep this literal example." }), "text inside a user-authored example is not a host-decoded task");
	});
}

it("renders native compaction summaries and context resets with their retained text", () => {
	const entries: AgentConversationEntry[] = [
		user("u", "The original task"),
		{
			id: "c",
			kind: "pi.compaction",
			model: [{ role: "user", content: [{ type: "text", text: "Compaction detail sentinel" }], timestamp: 4 }],
			data: { reason: "manual" },
			head: "u",
		},
		{ id: "r", kind: "pi.reset", head: "r" },
		user("h", "Handoff text sentinel"),
	];
	const text = screen(new AgentConversation(entries, "/work", tui, false, false));
	assert.match(text, /\[compaction\]/);
	assert.match(text, /Compaction detail sentinel/);
	assert.match(text, /── New context ──/);
	assert.match(text, /Handoff text sentinel/);
	assert.match(text, /The original task/);
});

it("keeps empty native kinds out of the load limit and renders unknown kinds generically", () => {
	const entries: AgentConversationEntry[] = [
		{ id: "s", kind: "pi.system", model: [{ role: "system", content: "", timestamp: 1 }] },
		{ id: "x", kind: "example.label", data: { state: "ready" } },
		user("u", "Visible question"),
	];
	assert.deepEqual(
		renderableEntries(entries).map((entry) => entry.id),
		["u"],
	);
	const text = screen(new AgentConversation(entries, "/work", tui, false, false));
	assert.match(text, /Visible question/);
	assert.doesNotMatch(text, /example\.label/);
});

it("omits payloads and signatures, bounds display text and honors thinking visibility", () => {
	const entries: AgentConversationEntry[] = [
		{
			id: "u",
			kind: "pi.user",
			model: [
				{
					role: "user",
					content: [{ type: "image", data: "IMAGE_PAYLOAD_SENTINEL", mimeType: "image/png" }],
					timestamp: 1,
				},
			],
		},
		assistant("a", [
			{ type: "thinking", thinking: "Visible reasoning sentinel", thinkingSignature: "SIGNATURE_SENTINEL" },
			{ type: "thinking", thinking: "REDACTED_SENTINEL", redacted: true },
			{ type: "text", text: `Safe\x1b[2J\u202e text\n${"x".repeat(65540)}`, textSignature: "TEXT_SIGNATURE_SENTINEL" },
		]),
	];
	const collapsed = screen(new AgentConversation(entries, "/work", tui, false, false));
	const expanded = screen(new AgentConversation(entries, "/work", tui, false, true));
	assert.match(expanded, /\[Image\]/);
	assert.match(expanded, /\[Redacted thinking\]/);
	assert.match(expanded, /Display limited to 65,536 characters/);
	assert.match(expanded, /Visible reasoning sentinel/);
	assert.doesNotMatch(collapsed, /Visible reasoning sentinel/);
	assert.doesNotMatch(expanded, /IMAGE_PAYLOAD_SENTINEL|SIGNATURE_SENTINEL|REDACTED_SENTINEL/);
	assert.equal(cleanDashboardText("text\x1b[2J\r\u202e\nnext\tcell"), "text\nnext\tcell");
});

it("a committed result replaces its partial on the existing committed call", () => {
	const call = assistant("1", [{ type: "toolCall", id: "call", name: "read", arguments: { path: "file.txt" } }]);
	const partial = result("live:tool:call", "call", "read", "partial output");
	const conversation = new AgentConversation([call, partial], "/work", tui, true, false);
	assert.match(screen(conversation), /partial output/);
	conversation.update([call, result("2", "call", "read", "final output")]);
	const text = screen(conversation);
	assert.match(text, /final output/);
	assert.doesNotMatch(text, /partial output/);
	assert.equal(text.match(/file\.txt/g)?.length, 1);
	conversation.update([call, result("2", "call", "read", "final output")]);
	assert.equal(screen(conversation), text);
});

const click = (width: number, height: number, y: number): TuiMouseEvent => ({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width, height, shift: false, alt: false, ctrl: false, clickCount: 1 });

it("matches a real native codemode component with current retained and partial details", () => {
	const definitions: ToolDefinition[] = [];
	const standIn = { registerTool: ((definition: ToolDefinition) => { definitions.push(definition); }) as ExtensionAPI["registerTool"] };
	createCodemodeExtension()(standIn as ExtensionAPI);
	assert.equal(definitions.length, 1);
	assert.equal(definitions[0].name, "codemode");
	assert.equal(typeof definitions[0].renderCall, "function");
	assert.equal(typeof definitions[0].renderResult, "function");
	assert.ok([undefined, "default", "self"].includes(definitions[0].renderShell));
	const args = { code: Array.from({ length: 14 }, (_, i) => `console.log("code line ${i}");`).join("\n") };
	const details = { calls: Array.from({ length: 12 }, (_, i) => ({ name: i % 2 ? "models.classify" : "lookup", status: ["ok", "error", "cancelled", "running"][i % 4], id: `nested-${i}`, args: "a".repeat(200), error: "failure", cost: i === 0 ? 0 : 0.02, durationMs: i * 100 })), fullOutputPath: "output.txt" };
	for (const width of [30, 80, 120]) for (const expanded of [false, true]) for (const partial of [false, true]) for (const isError of [false, true]) {
		const call = assistant("call", [{ type: "toolCall", id: "outer", name: "codemode", arguments: args }]);
		const completed = result(partial ? "live:tool:outer" : "result", "outer", "codemode", "", isError);
		const message = completed.model?.[0]; assert.ok(message?.role === "toolResult");
		message.content = [{ type: "text", text: "Script failed\nWall time 1.0 seconds\nOutput:\n" }, { type: "text", text: Array.from({ length: 9 }, (_, i) => `output ${i}`).join("\n") }];
		message.details = details;
		const native = new ToolExecutionComponent("codemode", "outer", args, { showImages: false }, definitions[0], tui, "/work");
		native.setArgsComplete(); native.markExecutionStarted(); native.setExpanded(expanded);
		native.updateResult(message, partial);
		const rendered = new AgentConversation([call, completed], "/work", tui, expanded, false).render(width).lines;
		assert.deepEqual(rendered, native.render(width));
		const after = assistant("after", [{ type: "text", text: "Adjacent answer" }]);
		const adjacent = new Container();
		adjacent.addChild(new UserMessageComponent("Adjacent question", getMarkdownTheme()));
		adjacent.addChild(native);
		adjacent.addChild(new AssistantMessageComponent(after.model?.[0] as AssistantMessage, true, getMarkdownTheme(), "Thinking..."));
		assert.deepEqual(new AgentConversation([user("before", "Adjacent question"), call, completed, after], "/work", tui, expanded, false).render(width).lines, adjacent.render(width));
		assert.match(stripVTControlCharacters(rendered.join("\n")), /lookup/u);
		assert.equal(details.calls[0].args.length, 200);
	}
});

it("retains whole-card and pending-card choices through result arrival and changed arguments", () => {
	const state = agentState(createDashboardState(), "one").view;
	let call = assistant("call", [{ type: "toolCall", id: "outer", name: "example_tool", arguments: { topic: "first" } }]);
	const conversation = new AgentConversation([call], "/work", tui, false, false, undefined, state);
	let document = conversation.render(80);
	assert.equal(conversation.handleMouse(click(80, document.lines.length, 0)), undefined, "outer spacer stays outside the card");
	assert.ok(conversation.handleMouse(click(80, document.lines.length, 1)));
	assert.equal(state.toolExpanded.get("outer"), true);
	call = assistant("call", [{ type: "toolCall", id: "outer", name: "example_tool", arguments: { topic: "changed" } }]);
	conversation.update([call, result("result", "outer", "example_tool", Array.from({ length: 13 }, (_, i) => `row ${i}`).join("\n"))]);
	document = conversation.render(80);
	assert.match(stripVTControlCharacters(document.lines.join("\n")), /row 12/u);
	assert.match(stripVTControlCharacters(document.lines.join("\n")), /topic: changed/u);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, 1)));
	assert.equal(state.toolExpanded.get("outer"), false);
	assert.doesNotMatch(screen(conversation), /row 12/u);
});

it("native thinking clicks retain choices only on the actual assistant instance", () => {
	const content: AssistantMessage["content"] = [{ type: "thinking", thinking: "" }, { type: "thinking", thinking: "first" }, { type: "thinking", thinking: "adjacent" }, { type: "text", text: "intervening text" }, { type: "thinking", thinking: "" }, { type: "text", text: "more text" }, { type: "thinking", thinking: "second" }];
	for (const stopReason of ["length", "error", "aborted"] as const) {
		const message = assistant("runs", content).model?.[0] as AssistantMessage;
		message.stopReason = stopReason; message.errorMessage = "diagnostic text";
		const native = new AssistantMessageComponent(message, true, getMarkdownTheme(), "Thinking...");
		assert.ok(native.render(80).length);
		const state = agentState(createDashboardState(), "one").view;
		const entries = [{ id: "runs", kind: "pi.assistant", model: [message, message] }];
		const conversation = new AgentConversation(entries, "/work", tui, false, false, undefined, state);
		const document = conversation.render(80);
		const labels = document.lines.flatMap((line, index) => stripVTControlCharacters(line).includes("Thinking...") ? [index] : []);
		assert.equal(labels.length, 4);
		assert.ok(conversation.handleMouse(click(80, document.lines.length, labels[3])));
		assert.equal(screen(conversation).match(/Thinking\.\.\./gu)?.length, 3);
		assert.match(screen(conversation), /second/u);
		const rebuilt = new AgentConversation(entries, "/work", tui, false, false, undefined, state);
		assert.equal(screen(rebuilt).match(/Thinking\.\.\./gu)?.length, 4);
		conversation.update([{ ...entries[0], data: { revision: 2 } }]);
		assert.equal(screen(conversation).match(/Thinking\.\.\./gu)?.length, 3);
	}
});

it("dashboard codemode cards fall back to standard presentation when capture fails", () => {
	const root = mkdtempSync(join(tmpdir(), "dashboard-capture-"));
	try {
		const entries = [assistant("call", [{ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "return 42;" } }]), result("result", "outer", "codemode", Array.from({ length: 13 }, (_, i) => `row ${i + 1}`).join("\n"))];
		const code = 'import assert from "node:assert/strict"; import { mock } from "node:test"; import * as pi from "@earendil-works/pi-coding-agent"; import { stripVTControlCharacters } from "node:util";' +
			'pi.initTheme("dark"); mock.module("@earendil-works/pi-coding-agent", { namedExports: { ...pi, createCodemodeExtension: () => () => {} } });' +
			'const { AgentConversation } = await import(' + JSON.stringify(new URL("./dashboard-conversation.ts", import.meta.url).href) + ');' +
			'const view = new AgentConversation(' + JSON.stringify(entries) + ', "/work", { requestRender() {} }, false, false); const text = stripVTControlCharacters(view.render(80).lines.join("\\n")); assert.match(text, /codemode code=/); assert.match(text, /row 10/); assert.doesNotMatch(text, /row 11/); assert.match(text, /expand/);';
		const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 30000, env: { ...process.env, PI_AGENT_DIR: join(root, "agent"), PI_AGENT_SESSIONS_DIR: join(root, "sessions") } });
		assert.equal(child.status, 0, child.stderr || String(child.error));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("native renderer render requests clear transcript string and height caches", (t) => {
	const original = ToolExecutionComponent.prototype.render;
	let native: ToolExecutionComponent | undefined;
	t.mock.method(ToolExecutionComponent.prototype, "render", function(this: ToolExecutionComponent, width: number) { native = this; return original.call(this, width); });
	const entries = [assistant("call", [{ type: "toolCall", id: "outer", name: "example_tool", arguments: {} }]), result("result", "outer", "example_tool", Array.from({ length: 13 }, (_, i) => `row ${i}`).join("\n"))];
	const conversation = new AgentConversation(entries, "/work", tui, false, false);
	const before = conversation.render(80).lines;
	assert.doesNotMatch(stripVTControlCharacters(before.join("\n")), /row 12/u);
	assert.ok(native);
	native.setExpanded(true); native.markExecutionStarted();
	assert.match(stripVTControlCharacters(conversation.render(80).lines.join("\n")), /row 12/u);
	assert.ok(conversation.renderWindow(80, 0, 40, false).height > before.length);
});


it("custom child clicks leave card choices untouched and native toggles call the setter once", (t) => {
	let childClicks = 0;
	const renderer: ToolRenderers = { renderCall: () => new MouseRegion(new Text("child action"), () => { childClicks++; return { handled: true }; }) };
	const state = agentState(createDashboardState(), "one").view;
	const call = assistant("call", [{ type: "toolCall", id: "custom", name: "custom", arguments: {} }]);
	const conversation = new AgentConversation([call, result("done", "custom", "custom", "result action")], "/work", tui, false, false, undefined, state, () => renderer);
	let document = conversation.render(80);
	const setters = t.mock.method(ToolExecutionComponent.prototype, "setExpanded");
	const y = document.lines.findIndex((line) => line.includes("child action"));
	assert.ok(conversation.handleMouse(click(80, document.lines.length, y)));
	assert.equal(childClicks, 1);
	assert.equal(setters.mock.callCount(), 0);
	assert.equal(state.toolExpanded.size, 0);
	document = conversation.render(80);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, document.lines.findIndex((line) => line.includes("result action")))));
	assert.equal(setters.mock.callCount(), 1);
	assert.equal(state.toolExpanded.get("custom"), true);
});

it("custom renderers receive sanitized initial and updated display data on the same native card", (t) => {
	const received: unknown[] = [];
	const renderer: ToolRenderers = {
		renderCall(args) { received.push(args); return new Text("custom call"); },
		renderResult(value) { received.push(value); return new Text("custom result"); },
	};
	const argsUpdates = t.mock.method(ToolExecutionComponent.prototype, "updateArgs");
	const resultUpdates = t.mock.method(ToolExecutionComponent.prototype, "updateResult");
	const entries = (revision: number): AgentConversationEntry[] => {
		const unsafe = { text: `safe${revision}\x1b[2J\u202e`, signature: "SIGNATURE_SECRET", image: { type: "image", data: "IMAGE_SECRET" }, thought: { type: "thinking", thinking: "THINKING_SECRET", redacted: true } };
		const call = assistant("call", [{ type: "toolCall", id: "custom", name: "custom", arguments: unsafe }]);
		const done = result("done", "custom", "custom", `output${revision}\x1b[2J`);
		const message = done.model?.[0]; assert.ok(message?.role === "toolResult"); message.details = unsafe;
		return [call, done];
	};
	const conversation = new AgentConversation(entries(1), "/work", tui, false, false, undefined, undefined, () => renderer);
	conversation.render(80);
	const native = resultUpdates.mock.calls.at(-1)?.this;
	assert.match(JSON.stringify(received), /safe1/);
	assert.doesNotMatch(JSON.stringify(received), /SIGNATURE_SECRET|IMAGE_SECRET|THINKING_SECRET|signature|\\u001b|\u202e/);
	received.length = 0;
	conversation.update(entries(2)); conversation.render(80);
	assert.equal(argsUpdates.mock.calls.at(-1)?.this, native);
	assert.equal(resultUpdates.mock.calls.at(-1)?.this, native);
	assert.match(JSON.stringify(received), /safe2/);
	assert.doesNotMatch(JSON.stringify(received), /SIGNATURE_SECRET|IMAGE_SECRET|THINKING_SECRET|signature|\\u001b|\u202e/);
});

it("renderer invalidation refreshes lines and heights and remains safe after eviction", () => {
	let invalidate: (() => void) | undefined;
	let text = "before";
	const renderer: ToolRenderers = { renderCall(_args, _theme, context) { invalidate = context.invalidate; return new Text(text, 0, 0); } };
	const call = assistant("call", [{ type: "toolCall", id: "custom", name: "custom", arguments: {} }]);
	const conversation = new AgentConversation([call], "/work", tui, false, false, undefined, undefined, () => renderer);
	const before = conversation.render(80).lines.length;
	text = "after\nsecond\nthird"; invalidate?.();
	assert.match(screen(conversation), /after\s+second\s+third/);
	assert.equal(conversation.render(80).lines.length, before + 2);
	conversation.update([]);
	invalidate?.();
	assert.deepEqual(conversation.render(80).lines, []);
});

it("old codemode details use native result fallback without reconstructing missing fields", () => {
	const call = assistant("call", [{ type: "toolCall", id: "old", name: "codemode", arguments: { code: 'text("hello")' } }]);
	const done = result("done", "old", "codemode", "Script completed\nWall time 0.1 seconds\nOutput:\n\nhello");
	const message = done.model?.[0]; assert.ok(message?.role === "toolResult");
	message.details = { calls: [{ name: "read", status: "ok", durationMs: 1 }] };
	const text = screen(new AgentConversation([call, done], "/work", tui, false, false), 50);
	assert.match(text, /codemode/); assert.match(text, /text\("hello"\)/);
	assert.match(text, /Script completed/); assert.match(text, /Wall time 0.1 seconds/); assert.match(text, /Output:/); assert.match(text, /hello/);
	assert.doesNotMatch(text, /unavailable|TypeError|read/);
});


it("global toggles reset every native instance without replacing components", (t) => {
	const state = agentState(createDashboardState(), "one").view;
	const entries = [assistant("first", [{ type: "thinking", thinking: "first reason" }, { type: "toolCall", id: "one", name: "custom", arguments: {} }]), assistant("second", [{ type: "thinking", thinking: "second reason" }, { type: "toolCall", id: "two", name: "custom", arguments: {} }])];
	const updates = t.mock.method(AssistantMessageComponent.prototype, "updateContent");
	const conversation = new AgentConversation(entries, "/work", tui, false, false, undefined, state);
	const instances = new Set(updates.mock.calls.map((call) => call.this));
	let document = conversation.render(80);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, document.lines.findIndex((line) => line.includes("Thinking...")))));
	assert.match(screen(conversation), /first reason/);
	const hidden = t.mock.method(AssistantMessageComponent.prototype, "setHideThinkingBlock");
	conversation.setShowThinking(false);
	assert.equal(hidden.mock.callCount(), 2);
	assert.deepEqual(new Set(hidden.mock.calls.map((call) => call.this)), instances);
	assert.doesNotMatch(screen(conversation), /first reason|second reason/);
	conversation.setShowThinking(true);
	assert.match(screen(conversation), /first reason/); assert.match(screen(conversation), /second reason/);
	document = conversation.render(80);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, document.lines.findIndex((line) => line.includes("custom")))));
	assert.equal(state.toolExpanded.size, 1);
	const expanded = t.mock.method(ToolExecutionComponent.prototype, "setExpanded");
	conversation.setExpanded(false);
	assert.equal(expanded.mock.callCount(), 2);
	assert.equal(state.toolExpanded.size, 0);
	assert.deepEqual(new Set(updates.mock.calls.map((call) => call.this)), instances);
});


it("result removal and call eviction keep a retained card instance without stale output", (t) => {
	const updates = t.mock.method(ToolExecutionComponent.prototype, "updateResult");
	const call = assistant("call", [{ type: "toolCall", id: "retained", name: "custom", arguments: { topic: "known" } }]);
	const done = result("done", "retained", "custom", "visible result");
	const conversation = new AgentConversation([call, done], "/work", tui, false, false);
	const instance = updates.mock.calls.at(-1)?.this;
	assert.match(screen(conversation), /visible result/);
	conversation.update([call]);
	assert.equal(updates.mock.calls.at(-1)?.this, instance);
	assert.doesNotMatch(screen(conversation), /visible result/);
	conversation.update([done]);
	assert.equal(updates.mock.calls.at(-1)?.this, instance);
	assert.match(screen(conversation), /visible result/);
});


it("a result-first builtin acquires native presentation when its call arrives", (t) => {
	const renders = t.mock.method(ToolExecutionComponent.prototype, "render");
	const state = agentState(createDashboardState(), "one").view;
	const done = result("done", "read-call", "read", "source line 3\nsource line 4");
	const conversation = new AgentConversation([done], "/work", tui, false, false, undefined, state);
	let document = conversation.render(80);
	const unmatched = renders.mock.calls.at(-1)?.this;
	assert.ok(conversation.handleMouse(click(80, document.lines.length, 2)));
	assert.equal(state.toolExpanded.get("read-call"), true);
	const call = assistant("call", [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "source.ts", offset: 3, limit: 2 } }]);
	conversation.update([call, done]);
	document = conversation.render(80);
	const matched = renders.mock.calls.at(-1)?.this;
	assert.notEqual(matched, unmatched, "Pi has no public renderer-definition setter");
	assert.deepEqual(document.lines, new AgentConversation([call, done], "/work", tui, true, false).render(80).lines);
	assert.match(stripVTControlCharacters(document.lines.join("\n")), /source\.ts:3-4/);
	assert.equal(state.toolExpanded.get("read-call"), true);
	const args = t.mock.method(ToolExecutionComponent.prototype, "updateArgs");
	conversation.update([assistant("call", [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "source.ts", offset: 4, limit: 1 } }]), result("done", "read-call", "read", "updated final output")]);
	assert.equal(args.mock.calls.at(-1)?.this, matched);
	assert.match(screen(conversation), /updated final output/);
	assert.equal(state.toolExpanded.get("read-call"), true);
});


it("a result-first custom card keeps its instance when the call adds no renderer capability", (t) => {
	const updates = t.mock.method(ToolExecutionComponent.prototype, "updateResult");
	const args = t.mock.method(ToolExecutionComponent.prototype, "updateArgs");
	const renderer: ToolRenderers = { renderCall: () => new Text("published card") };
	const done = result("done", "published", "custom", "output");
	const conversation = new AgentConversation([done], "/work", tui, false, false, undefined, undefined, () => renderer);
	const instance = updates.mock.calls.at(-1)?.this;
	conversation.update([assistant("call", [{ type: "toolCall", id: "published", name: "custom", arguments: { topic: "known" } }]), done]);
	assert.equal(args.mock.calls.at(-1)?.this, instance);
	assert.match(screen(conversation), /published card/);
});
