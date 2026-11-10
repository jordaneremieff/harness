import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord/json";
import { initTheme, createCodemodeExtension, AssistantMessageComponent, ToolExecutionComponent, getMarkdownTheme, type ExtensionAPI, type ToolDefinition, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { MouseRegion, Text, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createDashboardToolDefinitions } from "./dashboard-tool-definitions.ts";
import { agentState, createDashboardState } from "./dashboard-state.ts";
import { AgentConversation, cleanDashboardText, firstTaskEntry, renderableEntries } from "./dashboard-conversation.ts";
import type { AgentConversationEntry, AgentConversationSnapshot, AgentConversationSummary } from "./dashboard-types.ts";
import type { Communication } from "./communication.ts";
import { dashboardClock } from "./dashboard-time.ts";
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
	details?: JsonValue,
): AgentConversationEntry => ({
	id,
	kind: "pi.tool-result",
	model: [{ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 3, ...(details === undefined ? {} : { details }) }],
});
const user = (id: string, content: string): AgentConversationEntry => ({
	id,
	kind: "pi.user",
	model: [{ role: "user", content, timestamp: 1 }],
});
const screen = (conversation: AgentConversation, width = 80) =>
	stripVTControlCharacters(conversation.render(width).lines.join("\n"));

it("passes native tool durations to terminal components without using transcript elapsed time", (t) => {
	const updates = t.mock.method(ToolExecutionComponent.prototype, "updateResult");
	const call = assistant("call-entry", [{ type: "toolCall", id: "call", name: "timed-tool", arguments: {} }], 10);
	const completed = result("result-entry", "call", "timed-tool", "done");
	const message = completed.model?.[0];
	assert.ok(message?.role === "toolResult");
	message.timestamp = 900_000;
	message.durationMs = 7;
	const renderer: ToolRenderers = { renderResult: (_result, _options, _theme, context) => new Text(context.durationMs === undefined ? "Untimed result" : `Native execution: ${context.durationMs} ms`) };
	const conversation = new AgentConversation([call, completed], "/work", tui, true, false, undefined, undefined, () => renderer);
	const passed = updates.mock.calls.at(-1)?.arguments[0] as { durationMs?: number };
	assert.equal(passed.durationMs, 7);
	assert.match(screen(conversation), /Native execution: 7 ms/u);
	message.durationMs = 0;
	conversation.update([call, { ...completed, model: [{ ...message }] }]);
	assert.match(screen(conversation), /Native execution: 0 ms/u);
	const { durationMs: _duration, ...untimed } = message;
	conversation.update([call, { ...completed, model: [untimed] }]);
	assert.equal(Object.hasOwn(updates.mock.calls.at(-1)?.arguments[0] ?? {}, "durationMs"), false);
	assert.match(screen(conversation), /Untimed result/u);
	assert.doesNotMatch(screen(conversation), /Native execution:/u);
});

it("renders retry dependency facts before generic wait lines and removes them on the next native frame", () => {
	const reference = { sessionId: "producer:2", submissionId: 23, requestId: "exact-request" };
	const conversation = new AgentConversation([], "/work", tui, false, false);
	conversation.setAwaiting({ runId: 10, heldInputs: [12], results: [{ result: reference, status: "pending" }], queuedInputCount: 0, queueSnapshot: "committed InboxDoc", omitted: { heldInputs: 0, results: 0 }, omittedProducers: 0, likelyCycle: [], coverage: "one hop; remote graph incomplete", producers: [{ sessionId: reference.sessionId, observedAt: 1, source: "producer await-state", execution: { state: "provider-retry", runId: 20, results: [reference], model: { provider: "synthetic", modelId: "model" }, attempt: 18, maxAttempts: 21, nextRetryAt: 1791200000000, error: "429 Weekly/Monthly Limit Exhausted", errorTruncated: false } }] });
	const text = screen(conversation, 160).replace(/\s+/gu, " ");
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

it("agent cards name their targets from the observed roster and repaint when those facts change", () => {
	const identity = "01a106df-0000-4000-8000-000000000001";
	let rows: AgentConversationSummary[] = [{ id: identity, storageId: identity, name: "Named target", cwd: "/work", modifiedAt: 0, owner: "here", state: "idle", cost: 0, partial: false, model: { provider: "provider", modelId: "model", thinkingLevel: "high" } }];
	const entries = [assistant("call", [{ type: "toolCall", id: "send-call", name: "agent_send", arguments: { sessionId: identity, message: "Task text" } }])];
	const conversation = new AgentConversation(entries, "/work", tui, false, false, undefined, undefined, undefined, () => rows);
	assert.match(screen(conversation, 120), /Named target/u);
	assert.match(screen(conversation, 120), /provider\/model/u);
	rows = [{ ...rows[0], name: "Renamed target", model: { provider: "provider", modelId: "other-model", thinkingLevel: "low" } }];
	conversation.refreshCards();
	assert.match(screen(conversation, 120), /Renamed target/u);
	assert.match(screen(conversation, 120), /provider\/other-model/u);
	assert.doesNotMatch(screen(conversation, 120), /Named target/u);
	assert.doesNotMatch(screen(new AgentConversation(entries, "/work", tui, false, false), 120), /Named target|provider\/model/u, "without observed rows the card shows only the retained identity");
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
	assert.match(text, /read · source\.ts → 1 line/u);
	assert.match(screen(new AgentConversation(entries, "/work", tui, true, false)), /nativeRead/);
	assert.match(text, /example_tool/);
	assert.match(text, /Generic result/);
	assert.match(text, /Retained result without its call/);
	assert.doesNotMatch(text, /Message unavailable|\{\}/);
	assert.deepEqual(conversation.render(80), conversation.render(80));
	conversation.invalidate();
	assert.ok(conversation.render(50).lines.every((line) => visibleWidth(line) <= 50));
});

it("generic tools show one summary line at every width and keep the full output on expansion", () => {
	for (const width of [30, 80, 120]) {
		const output = Array.from({ length: 13 }, (_, i) => `row ${i + 1} ${"界🙂".repeat(20)}`).join("\n");
		const entries = [
			assistant("call", [{ type: "toolCall", id: "unknown", name: "extension_tool", arguments: { query: "first line\nsecond line", count: 23 } }]),
			result("result", "unknown", "extension_tool", output),
			assistant("reply", [{ type: "text", text: "The agent answer leads." }]),
		];
		const collapsed = new AgentConversation(entries, "/work", tui, false, false).render(width).lines.map(stripVTControlCharacters);
		assert.ok(collapsed.every((line) => visibleWidth(line) <= width));
		const summaries = collapsed.filter((line) => line.includes("extension_tool"));
		assert.equal(summaries.length, 1);
		assert.ok(summaries[0].trimStart().startsWith("extension_tool"), "the name stays whole");
		assert.match(summaries[0], /→ row 1/u, "the outcome stays visible");
		assert.doesNotMatch(summaries[0], /row 2/u);
		if (width >= 120) assert.match(summaries[0], /first line second line → row 1/u);
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
	assert.match(text, /bash · echo step-1 → step-1/u);
	assert.match(text, /write · poem\.txt → Successfully wrote to poem\.txt/u);
	assert.doesNotMatch(text, /▸ Thinking|Plan the shell steps/u, "a tool call stands in for the hidden thinking");
	assert.doesNotMatch(text, /\{\}/);
	assert.match(screen(new AgentConversation(entries, "/work", tui, false, true)), /Plan the shell steps/);
	const only = assistant("only", [{ type: "thinking", thinking: "Thinking-only reasoning" }]);
	assert.match(screen(new AgentConversation([only], "/work", tui, false, false)), /▸ Thinking/u);
	assert.match(screen(new AgentConversation([only], "/work", tui, false, true)), /Thinking-only reasoning/u);
});

it("hides the thinking row for a message that also shows text, a tool call or a stop error", () => {
	const entries = [
		assistant("answer", [{ type: "thinking", thinking: "hidden text reasoning" }, { type: "text", text: "Visible answer" }]),
		assistant("call", [{ type: "thinking", thinking: "hidden tool reasoning" }, { type: "toolCall", id: "read", name: "read", arguments: { path: "a.ts" } }]),
	];
	const collapsed = screen(new AgentConversation(entries, "/work", tui, false, false));
	assert.doesNotMatch(collapsed, /▸ Thinking|hidden text reasoning|hidden tool reasoning/u);
	assert.match(collapsed, /Visible answer/u);
	assert.match(screen(new AgentConversation(entries, "/work", tui, false, true)), /hidden text reasoning|hidden tool reasoning/u);
	for (const stopReason of ["error", "aborted", "length"] as const) {
		const message = assistant("failed", [{ type: "thinking", thinking: "failed reasoning" }]).model?.[0] as AssistantMessage;
		message.stopReason = stopReason;
		message.errorMessage = "diagnostic sentinel";
		const stopped = screen(new AgentConversation([{ id: "failed", kind: "pi.assistant", model: [message] }], "/work", tui, false, false));
		assert.doesNotMatch(stopped, /▸ Thinking|failed reasoning/u, stopReason);
		assert.match(stopped, /diagnostic sentinel|truncated before completion/u, stopReason);
	}
	const only = assistant("only", [{ type: "thinking", thinking: "only reasoning" }]);
	assert.match(screen(new AgentConversation([only], "/work", tui, false, false)), /▸ Thinking/u);
	assert.match(screen(new AgentConversation([only], "/work", tui, false, true)), /only reasoning/u);
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

it("renders body text at the shared reading width with a two-column margin", () => {
	for (const [pane, expected] of [[159, 100], [89, 86], [80, 77], [60, 57]] as const) {
		const lines = new AgentConversation([user("u", "The task")], "/work", tui, false, false).render(pane - 1).lines.map(stripVTControlCharacters);
		const content = lines.filter((line) => line.trim().length > 0);
		assert.ok(content.length > 0);
		for (const line of content) {
			assert.equal(visibleWidth(line), expected + 2, `pane ${pane}`);
			assert.equal(line.slice(0, 2), "  ", `margin at pane ${pane}`);
		}
	}
});

it("reuses the cached summary on an unchanged second render", (t) => {
	const renders = t.mock.method(ToolExecutionComponent.prototype, "render");
	const entries = [assistant("call", [{ type: "toolCall", id: "cache", name: "example_tool", arguments: { query: "cached" } }]), result("result", "cache", "example_tool", "cached output")];
	const conversation = new AgentConversation(entries, "/work", tui, false, false);
	conversation.render(80);
	const count = renders.mock.callCount();
	assert.ok(count >= 1);
	conversation.render(80);
	assert.equal(renders.mock.callCount(), count, "the cached rows are sliced again, not re-rendered");
});

it("wraps a long assistant failure in full at the reading width", () => {
	const error = `429 Usage limit reached for 5 hour. The limit resets at 03:53. Your draft and history stay. ${"detail ".repeat(20)}`;
	const message = assistant("fail", [{ type: "text", text: "Partial answer" }]).model?.[0] as AssistantMessage;
	message.stopReason = "error"; message.errorMessage = error;
	const text = screen(new AgentConversation([{ id: "fail", kind: "pi.assistant", model: [message] }], "/work", tui, false, false), 120).replace(/\s+/gu, " ");
	assert.ok(text.includes("429 Usage limit reached for 5 hour."));
	assert.ok(text.includes("Your draft and history stay."));
	assert.equal(text.match(/429 Usage limit reached/gu)?.length, 1, "the failure appears once in the body");
});

it("separates blocks with one blank row and owns the reading margin", () => {
	const entries: AgentConversationEntry[] = [
		user("u", "The task"),
		assistant("a", [{ type: "text", text: "Working on it." }]),
		result("t", "missing-call", "example_tool", "kept output"),
	];
	const conversation = new AgentConversation(entries, "/work", tui, false, false);
	for (const width of [30, 80, 120]) {
		const text = conversation.render(width).lines.map(stripVTControlCharacters);
		for (const line of text) if (line.trim()) assert.equal(line.slice(0, 2), "  ", `margin at ${width}`);
		const task = text.findIndex((line) => line.includes("The task"));
		const working = text.findIndex((line) => line.includes("Working on it."));
		const kept = text.findIndex((line) => line.includes("kept output"));
		assert.ok(task >= 0 && working > task && kept > working);
		assert.equal(working - task, 2, "one content line and one gap");
		assert.equal(kept - working, 2, "one content line and one gap");
		assert.equal(text.slice(task + 1, working).filter((line) => line.trim()).length, 0);
		assert.equal(text.slice(working + 1, kept).filter((line) => line.trim()).length, 0);
	}
	const tool = new ToolExecutionComponent("example_tool", "missing-call", undefined, { showImages: false }, createDashboardToolDefinitions("/work")("example_tool", false), tui, "/work");
	tool.updateResult({ content: [{ type: "text", text: "kept output" }], isError: false });
	const rows = tool.render(80);
	assert.equal(rows[0], "", "Pi's own leading spacer stays at component level");
	assert.doesNotMatch(rows.join("\n"), /\x1b\[48;/u, "no tool background");
	const keptLine = conversation.render(80).lines.find((line) => stripVTControlCharacters(line).includes("kept output"));
	assert.ok(keptLine);
	assert.doesNotMatch(keptLine, /\x1b\[48;/u, "the summary carries no filled block");
});

it("consecutive one-line tool steps share a run and commentary keeps its gap", () => {
	const entries: AgentConversationEntry[] = [
		assistant("first", [{ type: "toolCall", id: "read-one", name: "read", arguments: { path: "a.ts" } }]),
		result("result-one", "read-one", "read", "line a"),
		assistant("second", [{ type: "toolCall", id: "read-two", name: "read", arguments: { path: "b.ts" } }]),
		result("result-two", "read-two", "read", "line b"),
		assistant("commentary", [{ type: "text", text: "Commentary line" }]),
	];
	const lines = new AgentConversation(entries, "/work", tui, false, false).renderWindow(100, 0, 20, true).lines.map(stripVTControlCharacters);
	const first = lines.findIndex((line) => line.includes("read · a.ts"));
	const second = lines.findIndex((line) => line.includes("read · b.ts"));
	const commentary = lines.findIndex((line) => line.includes("Commentary line"));
	assert.equal(second, first + 1, "one-line tool steps keep no blank row between them");
	assert.equal(commentary, second + 2, "commentary keeps one blank row");
});

it("non-agent tool lines use the wide pane while prose, notices and agent cards keep the reading column", () => {
	const entries: AgentConversationEntry[] = [
		user("task", "Short prose"),
		assistant("bash", [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: `echo ${"x".repeat(200)}` } }]),
		result("bash-result", "bash-call", "bash", "done"),
		assistant("send", [{ type: "toolCall", id: "send-call", name: "agent_send", arguments: { sessionId: "01a106df-0000-4000-8000-000000000001", message: "A message body" } }]),
		communicationEntry(reportValue()),
	];
	const lines = new AgentConversation(entries, "/work", tui, false, false).render(158).lines;
	const widths = (needle: string) => lines.filter((line) => stripVTControlCharacters(line).includes(needle)).map((line) => visibleWidth(line));
	assert.deepEqual(widths("Short prose"), [102], "prose keeps the 100-column reading width plus its margin");
	const tool = widths("bash · echo");
	assert.equal(tool.length, 1);
	assert.ok(tool[0] > 102, "the tool line passes the reading column");
	assert.ok(tool[0] <= 158);
	assert.ok(widths("A message body").every((width) => width <= 102), "agent cards keep the reading column");
	assert.ok(widths("Report from Peer name").every((width) => width <= 102), "notices keep the reading column");
});

it("recovers the first task from the session summary when the bounded transcript omits it", () => {
	const late: AgentConversationEntry[] = [assistant("late", [{ type: "text", text: "Late answer" }])];
	const synthetic = firstTaskEntry({ entries: late, partial: true }, { firstMessage: "Run the checks" });
	assert.ok(synthetic);
	const message = synthetic.model?.[0] as { content?: unknown } | undefined;
	assert.equal(message?.content, "First task · Run the checks");
	const long = firstTaskEntry({ entries: late, partial: true }, { firstMessage: `# Task: review the parser\n\nRead ${"x".repeat(400)}` });
	assert.equal((long?.model?.[0] as { content?: unknown } | undefined)?.content, "First task · Task: review the parser", "one line, without heading marks or the rest of the task");
	const wide = firstTaskEntry({ entries: late, partial: true }, { firstMessage: "y".repeat(300) });
	const wideText = String((wide?.model?.[0] as { content?: unknown } | undefined)?.content ?? "");
	assert.ok(wideText.endsWith("…") && Array.from(wideText).length === "First task · ".length + 160, "a long first line is bounded");
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
			assert.doesNotMatch(text, /Host request context|Task content|requester-sentinel|recipient-sentinel|mode:.*report|First task ·/);
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

function checkCodemodeCase(t: TestContext, width: number, expanded: boolean, isError: boolean, partial: boolean, args: { code: string }, details: unknown, definition: ToolDefinition): void {
	const call = assistant("call", [{ type: "toolCall", id: "outer", name: "codemode", arguments: args }]);
	const completed = result(partial ? "live:tool:outer" : "result", "outer", "codemode", "", isError);
	const message = completed.model?.[0]; assert.ok(message?.role === "toolResult");
	message.content = [{ type: "text", text: "Script failed\nWall time 1.0 seconds\nOutput:\n" }, { type: "text", text: Array.from({ length: 9 }, (_, i) => `output ${i}`).join("\n") }];
	message.details = details as typeof message.details;
	const native = new ToolExecutionComponent("codemode", "outer", args, { showImages: false }, { ...definition, renderShell: "self" }, tui, "/work");
	let conversation: AgentConversation | undefined;
	t.after(() => {
		try { native.updateResult(message, false); }
		finally { conversation?.dispose(); }
	});
	native.setArgsComplete(); native.markExecutionStarted(); native.setExpanded(expanded);
	native.updateResult(message, partial);
	conversation = new AgentConversation([call, completed], "/work", tui, expanded, false);
	const rendered = conversation.render(width).lines;
	const visible = stripVTControlCharacters(rendered.join("\n"));
	assert.doesNotMatch(rendered.join("\n"), /\x1b\[48;/u, "no outer tool block");
	if (expanded) {
		if (!partial) assert.match(visible, /output 8/u);
		const last = stripVTControlCharacters(native.render(width).join("\n")).split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
		assert.ok(last && visible.includes(last), "expanded output keeps the self-shell native rows");
	} else {
		assert.equal(rendered.filter((line) => line.trim().length > 0).length, 1);
		assert.match(visible, /→ Script failed/u, "the outcome stays visible");
		if (width >= 80) assert.match(visible, /codemode · console/u);
	}
	const settled = { ...completed, id: "result" };
	conversation.update([call, settled]);
}

for (const partial of [false, true]) it(`matches a real native codemode component with current details: partial=${partial}`, (t) => {
	const definitions: ToolDefinition[] = [];
	const standIn = { registerTool: ((definition: ToolDefinition) => { definitions.push(definition); }) as ExtensionAPI["registerTool"] };
	createCodemodeExtension()(standIn as ExtensionAPI);
	assert.equal(definitions.length, 1);
	assert.equal(definitions[0].name, "codemode");
	assert.equal(typeof definitions[0].renderCall, "function");
	assert.equal(typeof definitions[0].renderResult, "function");
	assert.ok([undefined, "default", "self"].includes(definitions[0].renderShell));
	const args = { code: Array.from({ length: 14 }, (_, i) => `console.log("code line ${i}");`).join("\n") };
	const details = { calls: Array.from({ length: 12 }, (_, i) => ({ name: i % 2 ? "models.classify" : "lookup", status: ["ok", "error", "cancelled", partial ? "running" : "cancelled"][i % 4], id: i + 1, args: "a".repeat(200), error: "failure", durationMs: i * 100 })), fullOutputPath: "output.txt" };
	for (const width of [30, 80, 120]) for (const expanded of [false, true]) for (const isError of [false, true]) checkCodemodeCase(t, width, expanded, isError, partial, args, details, definitions[0]);
	assert.equal(details.calls[0].args.length, 200);
});

it("exits after a deliberate assertion failure while a codemode card is live", () => {
	const root = mkdtempSync(join(tmpdir(), "codemode-card-exit-"));
	try {
		const script = join(root, "failing-card.mjs");
		writeFileSync(script, `
import assert from "node:assert/strict";
import { createCodemodeExtension, initTheme, ToolExecutionComponent } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
initTheme("dark");
const definitions = [];
createCodemodeExtension()({ registerTool: (definition) => definitions.push(definition) });
const message = { role: "toolResult", toolCallId: "outer", toolName: "codemode", isError: false,
  content: [{ type: "text", text: "Script failed" }],
  details: { calls: [{ name: "lookup", status: "running", id: 1, args: "a", durationMs: 0 }], fullOutputPath: "output.txt" } };
const card = new ToolExecutionComponent("codemode", "outer", { code: "console.log(1)" }, { showImages: false }, { ...definitions[0], renderShell: "self" }, { requestRender() {} }, "/work");
try {
  card.setArgsComplete();
  card.markExecutionStarted();
  card.updateResult(message, true);
  assert.fail("DELIBERATE_CARD_FAILURE");
} finally {
  card.updateResult(message, false);
}
`);
		const result = spawnSync(process.execPath, [script], {
			cwd: process.cwd(),
			encoding: "utf8",
			timeout: 20_000,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.signal, null);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /DELIBERATE_CARD_FAILURE/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("retains whole-card and pending-card choices through result arrival and changed arguments", () => {
	const state = agentState(createDashboardState(), "one").view;
	let call = assistant("call", [{ type: "toolCall", id: "outer", name: "example_tool", arguments: { topic: "first" } }]);
	const conversation = new AgentConversation([user("task", "The task"), call], "/work", tui, false, false, undefined, state);
	let document = conversation.render(80);
	assert.equal(conversation.handleMouse(click(80, document.lines.length, 1)), undefined, "the shared gap row belongs to no block");
	assert.ok(conversation.handleMouse(click(80, document.lines.length, 2)), "the card row toggles");
	assert.equal(state.toolExpanded.get("outer"), true);
	call = assistant("call", [{ type: "toolCall", id: "outer", name: "example_tool", arguments: { topic: "changed" } }]);
	conversation.update([call, result("result", "outer", "example_tool", Array.from({ length: 13 }, (_, i) => `row ${i}`).join("\n"))]);
	document = conversation.render(80);
	assert.match(stripVTControlCharacters(document.lines.join("\n")), /row 12/u);
	assert.match(stripVTControlCharacters(document.lines.join("\n")), /topic: changed/u);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, 2)), "the card row toggles back");
	assert.equal(state.toolExpanded.get("outer"), false);
	assert.doesNotMatch(screen(conversation), /row 12/u);
});

const noticeSender: Communication["sender"] = { identity: "7f7f7f7f-1111-4222-8333-444444444444", name: "Peer name" };
const reportBody = "line one\nline two\nline three\nline four\nline five";
const communicationEntry = (value: Communication): AgentConversationEntry => ({
	id: "9",
	kind: "pi.user",
	model: [{ role: "user", content: value.body.text, timestamp: 1 }],
	communication: {
		state: "ready",
		recordEntryId: "9",
		target: { mode: "input", storageId: value.sender.identity, conversationId: 1, entryId: "9", submissionId: 3, requestId: "source" },
		value,
	},
});
const reportValue = (sender: Communication["sender"] = noticeSender, text = reportBody): Communication => ({
	format: "agent.communication/1",
	kind: "report",
	sender,
	body: { text, complete: false, redacted: false },
	recordedAt: 1_700_000_000_000,
	metadata: { sourceId: "report:source", requestId: "request-source" },
});
const observedLookup = (facts: { nameFor?: (identity: string) => string | undefined; threadTitle?: (id: string) => string | undefined }) =>
	Object.assign(() => [] as readonly AgentConversationSummary[], facts);

it("a retained report collapses to one header row, two preview rows and a line count", () => {
	const shown = screen(new AgentConversation([communicationEntry(reportValue())], "/work", tui, false, false));
	const lines = shown.split("\n").map((line) => line.trimEnd());
	assert.equal(lines.length, 3);
	assert.ok(lines[0].startsWith(`  ▸ Report from Peer name · ${dashboardClock(1_700_000_000_000)}`), lines[0]);
	assert.equal(lines[1].trim(), "line one");
	assert.equal(lines[2].trim(), "line two +3 lines");
	assert.doesNotMatch(shown, /\[agent\]|Partial body|click or ctrl\+o|line five/u);
});

it("a preview skips blank rows, so a one-line first paragraph still shows two rows of text", () => {
	const shown = screen(new AgentConversation([communicationEntry(reportValue(noticeSender, "First line.\n\n- item one\n- item two\n- item three"))], "/work", tui, false, false));
	const lines = shown.split("\n").map((line) => line.trimEnd());
	assert.equal(lines.length, 3);
	assert.equal(lines[1].trim(), "First line.");
	assert.match(lines[2] ?? "", /item one \+2 lines$/u, "the count follows text, never a blank row");
});

it("clicks on the report header or its count row open the retained copy, notes and identity", () => {
	const conversation = new AgentConversation([communicationEntry(reportValue())], "/work", tui, false, false);
	let document = conversation.render(80);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, 0)), "the header row toggles");
	const opened = screen(conversation).replace(/\s+/gu, " ");
	assert.match(opened, /▾ Report from Peer name/u);
	assert.match(opened, /line five/u);
	assert.match(opened, /Retained copy; it may be shorter than the original\./u);
	assert.match(opened, /Sender identity: 7f7f7f7f-1111-4222-8333-444444444444 Recorded: 2023-11-14T22:13:20\.000Z/u);
	assert.match(opened, /requestId: request-source/u, "the open card keeps the retained request identifier");
	assert.doesNotMatch(opened, /\[agent\]|Partial body|click or ctrl\+o/u);
	document = conversation.render(80);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, 0)), "the header row closes it again");
	assert.doesNotMatch(screen(conversation), /line five/u);
	document = conversation.render(80);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, 2)), "the count row toggles");
	assert.match(screen(conversation), /line five/u);
});

it("a report disclosure lives in the reading state and a global change clears it", () => {
	const entry = communicationEntry(reportValue());
	const reading = agentState(createDashboardState(), "one").view;
	const kept = new AgentConversation([entry], "/work", tui, false, false, undefined, reading);
	const document = kept.render(80);
	assert.ok(kept.handleMouse(click(80, document.lines.length, 0)));
	assert.match(screen(kept), /line five/u);
	assert.match(screen(new AgentConversation([entry], "/work", tui, false, false, undefined, reading)), /line five/u, "a rebuilt transcript over the same reading state keeps the choice");
	kept.setExpanded(true);
	kept.setExpanded(false);
	assert.doesNotMatch(screen(kept), /line five/u, "a global change owns the card again");
	assert.doesNotMatch(screen(new AgentConversation([entry], "/work", tui, false, false, undefined, reading)), /line five/u, "the global change cleared the kept choice");
});

it("a notice names its thread, post number and copy notes when opened", () => {
	const value: Communication = {
		format: "agent.communication/1",
		kind: "notice",
		sender: noticeSender,
		body: { text: reportBody, complete: false, redacted: false },
		recordedAt: 1_700_000_000_000,
		metadata: { threadId: "storage/thread-1", event: 25, passive: true },
	};
	const lookup = observedLookup({ threadTitle: (id) => (id === "storage/thread-1" ? "Density round" : undefined) });
	assert.match(screen(new AgentConversation([communicationEntry(value)], "/work", tui, false, false, undefined, undefined, undefined, lookup)), /▸ Peer name in Density round · #25 · /u);
	const opened = screen(new AgentConversation([communicationEntry(value)], "/work", tui, true, false)).replace(/\s+/gu, " ");
	assert.match(opened, /Notice copy; the full post #25 is in Threads\./u);
	assert.match(opened, /threadId: storage\/thread-1 event: 25/u);
	assert.match(opened, /Recorded: 2023-11-14T22:13:20\.000Z/u);
});

it("an open result card lists every retained reference and the full request identifiers", () => {
	const sender = "7f7f7f7f-1111-4222-8333-444444444444";
	const longRequest = `request-${"x".repeat(600)}-END`;
	const references = Array.from({ length: 16 }, (_, index) => ({ submissionId: index + 1, requestId: index === 15 ? longRequest : `req-${index + 1}`, entryId: String(index + 10), answerEntryId: String(index + 100) }));
	const value: Communication = { format: "agent.communication/1", kind: "result", sender: { identity: sender, name: "Peer" }, body: { text: "Result body", complete: true, redacted: false }, recordedAt: 1_700_000_000_000, metadata: { status: "done", references, omittedReferences: 2 } };
	const conversation = new AgentConversation([communicationEntry(value)], "/work", tui, true, false);
	const text = stripVTControlCharacters(conversation.render(200).lines.join("\n"));
	assert.match(text, /▾ Result from Peer · /u);
	assert.match(text, /references: 16 retained \u00b7 2 omitted at retention/u);
	for (let index = 1; index <= 16; index++) assert.match(text, new RegExp(`reference ${index}: submission ${index} \\u00b7 request `, "u"));
	assert.match(text, /reference 15: submission 15 \u00b7 request req-15 \u00b7 entry 24 \u00b7 answer entry 114/u);
	assert.ok(conversation.render(200).lines.map((line) => stripVTControlCharacters(line).trim()).join("").includes(longRequest), "a long valid identifier stays complete across its wrapped rows");
	assert.doesNotMatch(text, /\u2026/u, "no retained field is shortened in the open card");
});

it("names an unnamed sender by its kind and short identity until the lookup knows it", () => {
	const agentSender: Communication["sender"] = { identity: "7f7f7f7f-1111-4222-8333-444444444444", kind: "agent" };
	const entry = communicationEntry(reportValue(agentSender));
	assert.match(screen(new AgentConversation([entry], "/work", tui, false, false)), /Report from Agent 7f7f7f7f · /u);
	assert.match(screen(new AgentConversation([entry], "/work", tui, true, false)), /Sender identity: 7f7f7f7f-1111-4222-8333-444444444444 \(agent\)/u);
	const session = communicationEntry(reportValue({ identity: "7f7f7f7f-1111-4222-8333-444444444444", kind: "session" }));
	assert.match(screen(new AgentConversation([session], "/work", tui, false, false)), /Report from Session 7f7f7f7f · /u);
	const lookup = observedLookup({ nameFor: (identity) => (identity === agentSender.identity ? "Lookup name" : undefined) });
	assert.match(screen(new AgentConversation([entry], "/work", tui, false, false, undefined, undefined, undefined, lookup)), /Report from Lookup name · /u);
});

it("an agent_collaborate card uses the observed thread title and its receipt number", () => {
	const entries = [
		assistant("call", [{ type: "toolCall", id: "collab", name: "agent_collaborate", arguments: { action: "post", threadId: "storage/thread-1", message: "Body of the post" } }]),
		result("done", "collab", "agent_collaborate", "posted", false, { threadId: "storage/thread-1", sequence: 25 }),
	];
	const lookup = observedLookup({ threadTitle: (id) => (id === "storage/thread-1" ? "Density round" : undefined) });
	const named = screen(new AgentConversation(entries, "/work", tui, false, false, undefined, undefined, undefined, lookup), 120);
	assert.match(named, /agent_collaborate · post · Density round/u);
	assert.match(named, /Posted · #25/u);
	assert.doesNotMatch(named, /thread storage/u);
	const unnamed = screen(new AgentConversation(entries, "/work", tui, false, false), 120);
	assert.match(unnamed, /agent_collaborate · post · thread storage\/thread-1/u);
	assert.match(unnamed, /Posted · #25/u);
});

it("native thinking clicks retain choices only on the actual assistant instance", () => {
	const content: AssistantMessage["content"] = [{ type: "thinking", thinking: "" }, { type: "thinking", thinking: "first" }, { type: "thinking", thinking: "adjacent" }, { type: "text", text: " " }, { type: "thinking", thinking: "" }, { type: "text", text: " " }, { type: "thinking", thinking: "second" }];
	const message = assistant("runs", content).model?.[0] as AssistantMessage;
	const native = new AssistantMessageComponent(message, true, getMarkdownTheme(), "Thinking...");
	assert.ok(native.render(80).length);
	const state = agentState(createDashboardState(), "one").view;
	const entries = [{ id: "runs", kind: "pi.assistant", model: [message, message] }];
	const conversation = new AgentConversation(entries, "/work", tui, false, false, undefined, state);
	const document = conversation.render(80);
	const labels = document.lines.flatMap((line, index) => stripVTControlCharacters(line).includes("▸ Thinking") ? [index] : []);
	assert.equal(labels.length, 4);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, labels[3])));
	assert.equal(screen(conversation).match(/▸ Thinking/gu)?.length, 3);
	assert.match(screen(conversation), /second/u);
	const rebuilt = new AgentConversation(entries, "/work", tui, false, false, undefined, state);
	assert.equal(screen(rebuilt).match(/▸ Thinking/gu)?.length, 4);
	conversation.update([{ ...entries[0], data: { revision: 2 } }]);
	assert.equal(screen(conversation).match(/▸ Thinking/gu)?.length, 3);
});

it("dashboard codemode cards fall back to standard presentation when capture fails", () => {
	const root = mkdtempSync(join(tmpdir(), "dashboard-capture-"));
	try {
		const entries = [assistant("call", [{ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "return 42;" } }]), result("result", "outer", "codemode", Array.from({ length: 13 }, (_, i) => `row ${i + 1}`).join("\n"))];
		const code = 'import assert from "node:assert/strict"; import { mock } from "node:test"; import * as pi from "@earendil-works/pi-coding-agent"; import { stripVTControlCharacters } from "node:util";' +
			'pi.initTheme("dark"); mock.module("@earendil-works/pi-coding-agent", { namedExports: { ...pi, createCodemodeExtension: () => () => {} } });' +
			'const { AgentConversation } = await import(' + JSON.stringify(new URL("./dashboard-conversation.ts", import.meta.url).href) + ');' +
			'const view = new AgentConversation(' + JSON.stringify(entries) + ', "/work", { requestRender() {} }, false, false); const text = stripVTControlCharacters(view.render(80).lines.join("\\n")); assert.match(text, /codemode · return 42; → row 1/); assert.doesNotMatch(text, /row 2/); assert.equal(text.split("\\n").filter((line) => line.includes("codemode")).length, 1);';
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


it("custom child clicks leave card choices untouched and a plain card click records one choice", (t) => {
	let childClicks = 0;
	const renderer: ToolRenderers = { renderCall: () => new MouseRegion(new Text("child action"), () => { childClicks++; return { handled: true }; }) };
	const state = agentState(createDashboardState(), "one").view;
	const call = assistant("call", [{ type: "toolCall", id: "custom", name: "custom", arguments: {} }]);
	const conversation = new AgentConversation([call, result("done", "custom", "custom", "result action")], "/work", tui, true, false, undefined, state, () => renderer);
	let document = conversation.render(80);
	const setters = t.mock.method(ToolExecutionComponent.prototype, "setExpanded");
	const y = document.lines.findIndex((line) => line.includes("child action"));
	assert.ok(conversation.handleMouse(click(80, document.lines.length, y)));
	assert.equal(childClicks, 1);
	assert.equal(setters.mock.callCount(), 0);
	assert.equal(state.toolExpanded.size, 0);
	document = conversation.render(80);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, document.lines.findIndex((line) => line.includes("result action")))));
	assert.equal(state.toolExpanded.get("custom"), false);
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
	const conversation = new AgentConversation(entries(1), "/work", tui, true, false, undefined, undefined, () => renderer);
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
	const conversation = new AgentConversation([call], "/work", tui, true, false, undefined, undefined, () => renderer);
	const before = conversation.render(80).lines.length;
	text = "after\nsecond\nthird"; invalidate?.();
	assert.match(screen(conversation), /after\s+second\s+third/);
	assert.equal(conversation.render(80).lines.length, before + 2);
	conversation.update([]);
	invalidate?.();
	assert.deepEqual(conversation.render(80).lines, []);
});

it("global toggles clear every native choice without replacing components", (t) => {
	const state = agentState(createDashboardState(), "one").view;
	const entries = [
		assistant("first", [{ type: "thinking", thinking: "first reason" }]),
		assistant("first-tool", [{ type: "toolCall", id: "one", name: "custom", arguments: {} }]),
		assistant("second", [{ type: "thinking", thinking: "second reason" }]),
		assistant("second-tool", [{ type: "toolCall", id: "two", name: "custom", arguments: {} }]),
	];
	const updates = t.mock.method(AssistantMessageComponent.prototype, "updateContent");
	const conversation = new AgentConversation(entries, "/work", tui, false, false, undefined, state);
	const instances = new Set(updates.mock.calls.map((call) => call.this));
	let document = conversation.render(80);
	assert.ok(conversation.handleMouse(click(80, document.lines.length, document.lines.findIndex((line) => line.includes("▸ Thinking")))));
	assert.match(screen(conversation), /first reason/);
	const hidden = t.mock.method(AssistantMessageComponent.prototype, "setHideThinkingBlock");
	conversation.setShowThinking(false);
	assert.equal(hidden.mock.callCount(), 4, "the global change reaches every retained assistant");
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
	assert.deepEqual(new Set(updates.mock.calls.map((call) => call.this)), instances, "no assistant instance is replaced");
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
	assert.ok(conversation.handleMouse(click(80, document.lines.length, 0)));
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
	const conversation = new AgentConversation([done], "/work", tui, true, false, undefined, undefined, () => renderer);
	const instance = updates.mock.calls.at(-1)?.this;
	conversation.update([assistant("call", [{ type: "toolCall", id: "published", name: "custom", arguments: { topic: "known" } }]), done]);
	assert.equal(args.mock.calls.at(-1)?.this, instance);
	assert.match(screen(conversation), /published card/);
});

it("passes settled native codemode rows unchanged and preserves final nested visibility", (t) => {
	const updates = t.mock.method(ToolExecutionComponent.prototype, "updateResult");
	const call = assistant("call", [{ type: "toolCall", id: "script", name: "codemode", arguments: { code: "await tools.lookup({});" } }]);
	const entry = result("done", "script", "codemode", "Script completed\nWall time 0.1 seconds\nOutput:\n");
	const message = entry.model?.[0]; assert.ok(message?.role === "toolResult");
	message.details = { calls: [
		{ id: 1, name: "lookup", args: "{}", status: "ok", durationMs: 4 },
		{ id: 2, name: "failed", args: "{}", status: "error", error: "rejected", durationMs: 2 },
		{ id: 3, name: "stopped", args: "{}", status: "cancelled" },
	] };
	const original = structuredClone(entry);
	for (const width of [40, 80, 120]) for (const expanded of [false, true]) {
		const conversation = new AgentConversation([call, entry], "/work", tui, expanded, false);
		assert.deepEqual(updates.mock.calls.at(-1)?.arguments, [message, false]);
		const text = screen(conversation, width);
		if (expanded) {
			assert.match(text, /✓ lookup.*4ms/u);
			assert.match(text, /✗ failed/u);
			assert.match(text, /⊘ stopped/u);
		} else {
			// A narrow line truncates the argument first, so the outcome stays visible.
			assert.match(text, width >= 80 ? /codemode · await tools\.lookup\(\{\}\); → Script/u : /codemode · await t.*… → Script completed/u);
			assert.doesNotMatch(text, /✓ lookup|✗ failed|⊘ stopped/u);
		}
		assert.doesNotMatch(text, /\$/u);
	}
	assert.deepEqual(entry, original);
});

it("terminal results for other tools retain running status details", (t) => {
	const updates = t.mock.method(ToolExecutionComponent.prototype, "updateResult");
	const entry = result("result", "custom", "custom", "Done");
	const message = entry.model?.[0]; assert.ok(message?.role === "toolResult");
	message.details = { calls: [{ id: "nested", name: "pending", args: "{}", status: "running" }] };
	new AgentConversation([entry], "/work", tui, false, false);
	assert.deepEqual(updates.mock.calls.at(-1)?.arguments, [message, false]);
});
