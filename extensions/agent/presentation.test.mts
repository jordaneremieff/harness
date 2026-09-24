import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import registerAgentExtension from "./index.ts";
import { displayPreview, displayText, renderPeerMessage, renderSendCall, renderSendResult } from "./presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, getBgAnsi: () => "", bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 100) => component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");

describe("received peer presentation", () => {
	it("keeps source and failed operation visible without changing retained content", () => {
		const id = "01a00000-0000-7000-8000-000000000001";
		const content = `${"long evidence\n".repeat(500)}EXACT_END\x1b[2J\u202e`;
		const message = { customType: "agent.peer", content, display: true, timestamp: 1, role: "custom" as const, details: { kind: "operation", status: "failed", sessionId: id, operationId: "operation-id" } };
		const before = structuredClone(message);
		for (const width of [20, 40, 100, 140]) {
			const collapsed = renderPeerMessage(message, { expanded: false, outputPad: 1 }, theme);
			assert.ok(collapsed);
			const lines = collapsed.render(width);
			assert.ok(lines.length <= (width === 20 ? 12 : 7), `${width}: ${lines.length}`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(screen(collapsed, width), /failed/);
			assert.ok(screen(collapsed, width).replace(/\s/g, "").includes(id));
			assert.doesNotMatch(screen(collapsed, width), /EXACT_END|\x1b|\u202e/);
		}
		const expanded = renderPeerMessage(message, { expanded: true, outputPad: 1 }, theme);
		assert.ok(expanded);
		assert.match(screen(expanded), /EXACT_END/);
		assert.match(screen(expanded), /operation-id/);
		assert.match(screen(expanded), /agent_inspect/);
		assert.doesNotMatch(screen(expanded), /\x1b|\u202e/);
		assert.deepEqual(message, before);
	});

	it("retains the card background after preview truncation resets", () => {
		const background = "\x1b[48;2;25;28;32m";
		const colored = { ...theme, fg: (_color: string, text: string) => `\x1b[37m${text}\x1b[39m`, bg: (_color: string, text: string) => `${background}${text}\x1b[49m`, getBgAnsi: () => background } as unknown as Theme;
		const card = renderPeerMessage({ role: "custom", timestamp: 1, customType: "agent.peer", content: "literal evidence ".repeat(100), display: true, details: { kind: "message", fromSessionId: "source" } }, { expanded: false, outputPad: 1 }, colored);
		assert.ok(card);
		for (const width of [20, 40, 100]) {
			const row = card.render(width).find((line) => stripVTControlCharacters(line).includes("↳"));
			assert.ok(row);
			assert.ok(row.includes(background));
			assert.doesNotMatch(row, /\x1b\[0m(?!\x1b\[48;2;25;28;32m)/);
		}
	});

	it("distinguishes messages, detached aggregates, and missing metadata without prose inference", () => {
		const base = { role: "custom" as const, timestamp: 1, customType: "agent.peer", content: "completed successfully", display: true };
		const direct = renderPeerMessage({ ...base, details: { kind: "message", fromSessionId: "sender", replyTo: "reply-id" } }, { expanded: false, outputPad: 1 }, theme);
		assert.ok(direct);
		assert.match(screen(direct), /Agent peer message/);
		assert.doesNotMatch(screen(direct), /Peer operation/);
		const aggregate = renderPeerMessage({ ...base, details: { kind: "runs", outcomes: [{ runId: "run-a", sessionId: "session-a", status: "finished" }, { runId: "run-b", sessionId: "session-b", status: "failed" }] } }, { expanded: false, outputPad: 1 }, theme);
		assert.ok(aggregate);
		assert.match(screen(aggregate), /unsuccessful: 1/);
		assert.match(screen(aggregate), /expand for run\/session IDs/);
		const malformed = renderPeerMessage({ ...base, details: { kind: {}, fromSessionId: { toString: 1 } } }, { expanded: false, outputPad: 1 }, theme);
		assert.ok(malformed);
		assert.match(screen(malformed), /kind unavailable/);
		assert.match(screen(malformed), /source unavailable/);
	});
});

describe("agent_send presentation", () => {
	it("registers native call and result renderers without changing execution", () => {
		const tools: ToolDefinition[] = [];
		const renderers = new Map();
		registerAgentExtension({ on() {}, registerCommand() {}, registerMessageRenderer: (name: string, renderer: unknown) => renderers.set(name, renderer), registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
		assert.equal(renderers.get("agent.peer"), renderPeerMessage);
		const tool = tools.find((item) => item.name === "agent_send");
		assert.equal(tool?.renderCall, renderSendCall);
		assert.equal(tool?.renderResult, renderSendResult);
		assert.equal(typeof tool?.execute, "function");
	});

	it("keeps collapsed content short and expands literal multiline submitted text with reply metadata", () => {
		const args = { sessionId: "target-session", message: "First line\n\n**literal Markdown** and `code`\nLast line", replyTo: "message-reference" };
		const before = structuredClone(args);
		const collapsed = renderSendCall(args, theme, { expanded: false, argsComplete: true });
		assert.match(screen(collapsed), /target-session/);
		assert.match(screen(collapsed), /First line \*\*literal Markdown\*\*/);
		assert.match(screen(collapsed), /Full message is in the tool-call arguments/);
		const expanded = renderSendCall(args, theme, { expanded: true, argsComplete: true, lastComponent: collapsed });
		assert.equal(expanded, collapsed);
		assert.ok(screen(expanded).includes(args.message));
		assert.match(screen(expanded), /Reply to: message-reference/);
		assert.deepEqual(args, before);
		const recollapsed = renderSendCall(args, theme, { expanded: false, argsComplete: true, lastComponent: expanded });
		assert.doesNotMatch(screen(recollapsed), /Submitted message/);
	});

	it("distinguishes complete whitespace-only messages from pending arguments", () => {
		const args = { sessionId: "target", message: " \n  " };
		assert.match(screen(renderSendCall(args, theme, { expanded: false, argsComplete: true })), /empty or whitespace-only message/);
		assert.match(screen(renderSendCall(args, theme, { expanded: false, argsComplete: false })), /message pending/);
		assert.equal(args.message, " \n  ");
	});

	it("uses descriptive fallback text without an application expansion binding", () => {
		const previous = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const text = screen(renderSendCall({ sessionId: "target", message: "content" }, theme, { expanded: false, argsComplete: true }));
			assert.match(text, /Full message is in the tool-call arguments/);
			assert.doesNotMatch(text, /Tool expansion|to expand message/);
		} finally { setKeybindings(previous); }
	});

	it("handles partial args, changed args, resize, controls, and Unicode without terminal execution", () => {
		const partial = renderSendCall({}, theme, { expanded: true, argsComplete: false });
		assert.match(screen(partial), /target pending/);
		assert.match(screen(partial), /Message so far/);
		const input = "日本語 😀\t\r\x1b]52;c;clipboard\x07\x1b[31mRED\x1b[0m\u202e";
		const full = renderSendCall({ sessionId: "changed", message: input }, theme, { expanded: true, argsComplete: true, lastComponent: partial });
		assert.match(screen(full), /changed/);
		assert.doesNotMatch(screen(full), /[\x1b\x07\r\t\u202e]/u);
		assert.ok(screen(full).includes(displayText(input)));
		for (const width of [10, 40, 100]) assert.ok(full.render(width).every((line) => visibleWidth(line) <= width));
		full.invalidate();
		assert.ok(screen(full).includes("日本語 😀"));
	});

	it("bounds long display without modifying or silently truncating the message", () => {
		const args = { sessionId: "target", message: `${"long line\n".repeat(5000)}EXACT_END` };
		const original = args.message;
		const collapsed = screen(renderSendCall(args, theme, { expanded: false, argsComplete: true }));
		assert.ok(collapsed.length < 500);
		const expanded = screen(renderSendCall(args, theme, { expanded: true, argsComplete: true }));
		assert.match(expanded, /Display limit: 18009 more UTF-16 code units/);
		assert.match(expanded, /native tool-call arguments/);
		assert.equal(args.message, original);
		assert.ok(expanded.length < 34000);
	});

	it("does not split Unicode surrogate pairs at display bounds", () => {
		assert.equal(displayPreview("a😀b", 2), "a…");
		const message = `${"a".repeat(31_999)}😀END`;
		const expanded = screen(renderSendCall({ sessionId: "target", message }, theme, { expanded: true, argsComplete: true }));
		assert.doesNotMatch(expanded, /[\uD800-\uDFFF]/u);
		assert.match(expanded, /Display limit: 5 more UTF-16 code units/);
	});

	it("shows receipts, partial results, and errors without claiming delivery", () => {
		const result = { content: [{ type: "text" as const, text: "admitted\nmetadata" }], details: undefined };
		const success = renderSendResult(result, { expanded: false, isPartial: false }, theme, { isError: false });
		assert.match(screen(success), /not proof of delivery or action/);
		const partial = renderSendResult(result, { expanded: true, isPartial: true }, theme, { isError: false, lastComponent: success });
		assert.equal(partial, success);
		assert.match(screen(partial), /Admission pending/);
		assert.match(screen(partial), /admitted\nmetadata/);
		const error = renderSendResult({ content: [{ type: "text", text: "refused\x1b[2J" }], details: undefined }, { expanded: true, isPartial: false }, theme, { isError: true, lastComponent: partial });
		assert.match(screen(error), /Send error/);
		assert.doesNotMatch(screen(error), /Admission receipt|\x1b/);
		assert.ok(error instanceof Text);
	});
});
