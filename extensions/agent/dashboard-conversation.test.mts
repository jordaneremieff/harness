import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentConversation, cleanDashboardText, renderableEntries } from "./dashboard-conversation.ts";
import type { AgentConversationEntry } from "./dashboard-types.ts";

initTheme("dark");
const tui = { requestRender() {} } as TUI;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id: string, content: AssistantMessage["content"], timestamp = 2): AgentConversationEntry => ({
	id, kind: "pi.assistant",
	model: [{ role: "assistant", content, api: "openai-responses", provider: "test", model: "test", timestamp, stopReason: "toolUse", usage }],
});
const result = (id: string, toolCallId: string, toolName: string, text: string, isError = false): AgentConversationEntry => ({
	id, kind: "pi.tool-result",
	model: [{ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 3 }],
});
const user = (id: string, content: string): AgentConversationEntry => ({ id, kind: "pi.user", model: [{ role: "user", content, timestamp: 1 }] });
const screen = (conversation: AgentConversation, width = 80) => stripVTControlCharacters(conversation.render(width).lines.join("\n"));

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
	assert.doesNotMatch(text, /Message unavailable/);
	assert.equal(conversation.render(80), conversation.render(80));
	conversation.invalidate();
	assert.ok(conversation.render(50).lines.every((line) => visibleWidth(line) <= 50));
});

it("renders native compaction summaries and context resets with their retained text", () => {
	const entries: AgentConversationEntry[] = [
		user("u", "The original task"),
		{ id: "c", kind: "pi.compaction", model: [{ role: "user", content: [{ type: "text", text: "Compaction detail sentinel" }], timestamp: 4 }], data: { reason: "manual" }, head: "u" },
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
	assert.deepEqual(renderableEntries(entries).map((entry) => entry.id), ["u"]);
	const text = screen(new AgentConversation(entries, "/work", tui, false, false));
	assert.match(text, /Visible question/);
	assert.doesNotMatch(text, /example\.label/);
});

it("omits payloads and signatures, bounds display text and honors thinking visibility", () => {
	const entries: AgentConversationEntry[] = [
		{ id: "u", kind: "pi.user", model: [{ role: "user", content: [{ type: "image", data: "IMAGE_PAYLOAD_SENTINEL", mimeType: "image/png" }], timestamp: 1 }] },
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
