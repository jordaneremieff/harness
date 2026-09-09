// Inert clipboard_copy fixture for prompt evaluations.
//
// This extension never touches an operating system clipboard, a real archive,
// or any live state. It registers one tool, clipboard_copy, with the public
// content/label interface of the clipboard extension. The outcome of a copy is
// controlled by the string clipboard-outcome extension flag, which the
// evaluation plan hashes into its approval digest: success (default),
// archive-warning, or failure. Result wording mirrors the public outcome
// shapes a real clipboard copy reports so models react to the same surface.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type MockClipboardOutcome = "success" | "archive-warning" | "failure";

export const MOCK_CLIPBOARD_OUTCOME_FLAG = "clipboard-outcome";
export const ARCHIVE_WARNING_TEXT = "Warning: archive write failed: disk full";
export const FAILURE_TEXT = "pbcopy failed: synthetic write error";

export function readMockClipboardOutcome(value: unknown): MockClipboardOutcome {
	return value === "archive-warning" || value === "failure" ? value : "success";
}

function countCharacters(content: string): number {
	let count = 0;
	for (const _char of content) count++;
	return count;
}

/** Public wording of a controlled clipboard outcome, mirroring the clipboard extension result shapes. */
export function clipboardResultText(outcome: MockClipboardOutcome, content: string, label: string | undefined): string {
	const lines = content.split("\n").length;
	const chars = countCharacters(content);
	const labelPart = label ? ` | ${label}` : "";
	const firstLine = content.split("\n")[0] ?? "";
	const preview = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
	const base = `Copied to clipboard${labelPart} (${lines} lines, ${chars} chars)\nPreview: ${preview}`;
	if (outcome === "archive-warning") return `${base}\n${ARCHIVE_WARNING_TEXT}`;
	return base;
}

const CopyParams = Type.Object({
	content: Type.String({ description: "Content to copy to the clipboard", maxLength: 8 * 1024 * 1024 }),
	label: Type.Optional(Type.String({ description: "Brief label for what was copied", maxLength: 200 })),
});

export default function (pi: ExtensionAPI) {
	pi.registerFlag(MOCK_CLIPBOARD_OUTCOME_FLAG, {
		description: "Controlled clipboard outcome: success, archive-warning, or failure",
		type: "string",
		default: "success",
	});
	pi.registerTool<typeof CopyParams, Record<string, unknown>>({
		name: "clipboard_copy",
		label: "Clipboard copy",
		description:
			"Copy content to the clipboard; the copy is archived with its label. Report the outcome the tool returns.",
		promptSnippet: "Copy content to the clipboard",
		parameters: CopyParams,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("clipboard_copy cancelled");
			const outcome = readMockClipboardOutcome(pi.getFlag(MOCK_CLIPBOARD_OUTCOME_FLAG));
			if (outcome === "failure") throw new Error(FAILURE_TEXT);
			const text = clipboardResultText(outcome, params.content, params.label);
			return {
				content: [{ type: "text" as const, text }],
				details: { outcome, lines: text.split("\n").length },
			};
		},
	});
}
