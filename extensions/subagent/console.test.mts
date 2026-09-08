import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	cleanConsoleText,
	renderMarkdownText,
	renderTranscript,
	restoreTranscriptAnchor,
	stripTerminalSequences,
	transcriptAnchor,
	type ConsoleMessage,
} from "./console.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;
const plain = (lines: string[]) => stripTerminalSequences(lines.join("\n"));
const messages: ConsoleMessage[] = [
	{ id: "question", role: "user", content: "Check the parser.\n\nKeep the source intact." },
	{
		id: "reply",
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Recorded reasoning that remains available." },
			{
				type: "text",
				text: '## Parser check\n\nThe **boundary** accepts these inputs:\n\n1. A string.\n2. An empty string.\n\n```ts\nparse("");\n```',
			},
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/parser.ts", offset: 17, limit: 250 } },
		],
	},
	{
		role: "toolResult",
		toolCallId: "read-1",
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: Array.from({ length: 200 }, (_, index) => `source line ${index}`).join("\n") }],
	},
	{ id: "conclusion", role: "assistant", content: [{ type: "text", text: "The parser checks passed." }] },
];

describe("readable transcripts", () => {
	it("keeps the compact view short and exposes all retained content through explicit expansion", () => {
		const compact = renderTranscript(messages, { width: 120, theme });
		const expanded = renderTranscript(messages, { width: 120, theme, expandedTools: true, showThinking: true });
		assert.ok(compact.lines.length < 35);
		assert.ok(expanded.lines.length > 220);
		assert.match(plain(compact.lines), /198 more lines · ctrl\+o expands input and output/);
		assert.match(plain(compact.lines), /Reasoning · collapsed · ctrl\+t expands/);
		assert.doesNotMatch(plain(compact.lines), /Recorded reasoning|source line 199/);
		for (const text of ["Recorded reasoning", "source line 199", '"offset": 17', '"limit": 250'])
			assert.ok(plain(expanded.lines).includes(text));
		assert.match(plain(compact.lines), /User[\s\S]*Assistant[\s\S]*read[\s\S]*The parser checks passed/);
		assert.doesNotMatch(plain(compact.lines), /\*\*boundary\*\*/);
		assert.match(plain(compact.lines), /parse\(""\);/);
	});
	it("keeps errors and live partial output visible when tools are folded", () => {
		for (const status of ["running", "error"] as const) {
			const input: ConsoleMessage[] = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tool", name: "bash", arguments: { command: "make check" } }],
				},
				{
					role: "toolResult",
					toolCallId: "tool",
					toolName: "bash",
					status,
					isError: status === "error",
					content: [{ type: "text", text: "observable partial or error" }],
				},
			];
			const output = plain(renderTranscript(input, { width: 90, theme }).lines);
			assert.match(output, new RegExp(`bash.*${status}`));
			assert.match(output, /observable partial or error/);
		}
		const output = plain(
			renderTranscript(
				[
					{
						role: "assistant",
						stopReason: "aborted",
						content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }],
					},
				],
				{ width: 90, theme },
			).lines,
		);
		assert.match(output, /read · aborted/);
		assert.doesNotMatch(output, /running/);
	});
	it("keeps source identity anchors across wrapping and expansion", () => {
		const original = renderTranscript(messages, { width: 120, theme });
		const section = original.sections.find((item) => item.id === "conclusion:0")!;
		const anchor = transcriptAnchor(original, section.start);
		const expanded = renderTranscript(messages, { width: 40, theme, expandedTools: true, showThinking: true });
		const position = restoreTranscriptAnchor(expanded, anchor);
		assert.equal(position, expanded.sections.find((item) => item.id === "conclusion:0")?.start);
		assert.equal(restoreTranscriptAnchor(expanded, { id: "missing", fraction: 0 }), null);
		assert.equal(transcriptAnchor({ lines: [], sections: [] }, 0), null);
	});
	it("bounds all widths and preserves source data", () => {
		const before = structuredClone(messages);
		for (const width of [0, 1, 2, 3, 12, 40, 80, 120, 260]) {
			for (const expandedTools of [false, true]) {
				const result = renderTranscript(messages, { width, theme, expandedTools, showThinking: expandedTools });
				for (const line of result.lines) assert.equal(visibleWidth(line), width);
				assert.ok(!result.sections.some((item) => item.end <= item.start));
			}
		}
		assert.deepEqual(messages, before);
	});
	it("keeps prose readable at a wide terminal without stretching it to the edge", () => {
		const result = renderTranscript(
			[{ role: "assistant", content: [{ type: "text", text: "readable words ".repeat(80) }] }],
			{ width: 260, theme },
		);
		for (const line of result.lines) assert.ok(visibleWidth(stripTerminalSequences(line).trimEnd()) <= 101);
	});
	it("removes source escape sequences and direction controls before native Markdown", () => {
		const poison = "safe\x1b]0;poison\x07\x1b[2J\u202ehidden\u2066tail\x00";
		assert.equal(cleanConsoleText(poison), "safehiddentail");
		const output = plain(renderMarkdownText(poison, 40, theme));
		assert.match(output, /safehiddentail/);
		assert.doesNotMatch(output, /poison|[\x00\u202e\u2066]/);
	});
	it("takes expansion key hints from the caller", () => {
		const output = plain(
			renderTranscript(messages, { width: 120, theme, toolHint: "alt+o", thinkingHint: "alt+t" }).lines,
		);
		assert.match(output, /alt\+o expands/);
		assert.match(output, /alt\+t expands/);
		assert.doesNotMatch(output, /ctrl\+o|ctrl\+t/);
	});
});
