import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentConversation, cleanDashboardText } from "./dashboard-conversation.ts";

initTheme("dark");
const tui = { requestRender() {} } as TUI;
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant", content, api: "openai-responses", provider: "test", model: "test", timestamp: 2, stopReason: "toolUse",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const screen = (conversation: AgentConversation, width = 80) => stripVTControlCharacters(conversation.render(width).lines.join("\n"));

it("uses native built-in tools, generic unknown tools and unmatched results without execution", () => {
	const session = SessionManager.inMemory("/work");
	session.appendMessage(assistant([
		{ type: "toolCall", id: "read-one", name: "read", arguments: { path: "source.ts" } },
		{ type: "toolCall", id: "unknown-one", name: "example_tool", arguments: { query: "bounded query" } },
	]));
	session.appendMessage({ role: "toolResult", toolCallId: "read-one", toolName: "read", content: [{ type: "text", text: "const nativeRead = true;" }], isError: false, timestamp: 3 });
	session.appendMessage({ role: "toolResult", toolCallId: "unknown-one", toolName: "example_tool", content: [{ type: "text", text: "Generic result" }], isError: false, timestamp: 4 });
	session.appendMessage({ role: "toolResult", toolCallId: "unmatched", toolName: "absent_call", content: [{ type: "text", text: "Retained result without its call" }], isError: true, timestamp: 5 });
	session.appendMessage({ role: "bashExecution", command: "printf never-executed", output: "Retained shell output", exitCode: 0, cancelled: false, truncated: false, timestamp: 6 });
	const conversation = new AgentConversation(session.getBranch(), "/work", tui, false, false);
	const text = screen(conversation);
	assert.match(text, /source\.ts/);
	assert.doesNotMatch(text, /nativeRead/);
	assert.match(screen(new AgentConversation(session.getBranch(), "/work", tui, true, false)), /nativeRead/);
	assert.match(text, /example_tool/);
	assert.match(text, /Generic result/);
	assert.match(text, /Retained result without its call/);
	assert.match(text, /Retained shell output/);
	assert.doesNotMatch(text, /Message unavailable/);
	assert.equal(conversation.render(80), conversation.render(80));
	conversation.invalidate();
	assert.ok(conversation.render(50).lines.every((line) => visibleWidth(line) <= 50));
});

it("uses native summaries and custom messages and expands retained details", () => {
	const session = SessionManager.inMemory("/work");
	const first = session.appendMessage({ role: "user", content: "The original task", timestamp: 1 });
	session.appendCustomMessageEntry("visible", "Visible custom message", true);
	session.appendCustomMessageEntry("hidden", "Hidden custom message", false);
	session.appendCompaction("Compaction detail sentinel", first, 1000);
	const branch: SessionEntry = { type: "branch_summary", id: "branch", parentId: session.getLeafId(), timestamp: new Date(5).toISOString(), fromId: first, summary: "Branch detail sentinel" };
	const entries = [...session.getBranch(), branch];
	const collapsed = new AgentConversation(entries, "/work", tui, false, false);
	const expanded = new AgentConversation(entries, "/work", tui, true, false);
	assert.match(screen(collapsed), /Visible custom message/);
	assert.doesNotMatch(screen(expanded), /Hidden custom message/);
	assert.match(screen(expanded), /Compaction detail sentinel/);
	assert.match(screen(expanded), /Branch detail sentinel/);
	assert.ok(expanded.render(80).lines.length > collapsed.render(80).lines.length);
});

it("omits payloads and signatures, bounds display text and honors thinking visibility", () => {
	const session = SessionManager.inMemory("/work");
	session.appendMessage({ role: "user", content: [{ type: "image", data: "IMAGE_PAYLOAD_SENTINEL", mimeType: "image/png" }], timestamp: 1 });
	session.appendMessage(assistant([
		{ type: "thinking", thinking: "Visible reasoning sentinel", thinkingSignature: "SIGNATURE_SENTINEL" },
		{ type: "thinking", thinking: "REDACTED_SENTINEL", redacted: true },
		{ type: "text", text: `Safe\x1b[2J\u202e text\n${"x".repeat(65540)}`, textSignature: "TEXT_SIGNATURE_SENTINEL" },
	]));
	const entries = session.getBranch();
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
