import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
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
	assert.equal(conversation.render(80), conversation.render(80));
	conversation.invalidate();
	assert.ok(conversation.render(50).lines.every((line) => visibleWidth(line) <= 50));
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

it("keeps one blank line between conversation blocks", () => {
	const entries: AgentConversationEntry[] = [
		user("u", "The task"),
		assistant("a", [{ type: "text", text: "Working on it." }]),
		result("t", "missing-call", "example_tool", "kept output"),
	];
	const lines = new AgentConversation(entries, "/work", tui, false, false)
		.render(80)
		.lines.map(stripVTControlCharacters);
	assert.doesNotMatch(lines.join("\n"), /\n[ \t]*\n[ \t]*\n/);
	for (let index = 1; index < lines.length; index++) {
		assert.ok(!(lines[index]?.trim() === "" && lines[index - 1]?.trim() === ""), "two blank lines in a row");
	}
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
