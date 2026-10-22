import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { measure } from "./meter.ts";
import { kindForPath } from "./scripts/extract.mts";
import { renderText } from "./scripts/report.mts";

export const MAX_TOOL_CHARS = 200000;
const MAX_FILE_BYTES = MAX_TOOL_CHARS * 4;
export const parameters = Type.Object({
	text: Type.Optional(
		Type.String({ maxLength: MAX_TOOL_CHARS, description: "Final text. Supply exactly one of text or path." }),
	),
	path: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 4096,
			description: "Saved UTF-8 file, relative to the current directory or absolute.",
		}),
	),
	kind: Type.Union([Type.Literal("prose"), Type.Literal("commit"), Type.Literal("diff")]),
});
export type DraftInput = { text?: string; path?: string; kind: "prose" | "commit" | "diff" };
export const promptSnippet = "Check final human-facing text for slop tells; report findings without rewriting.";
export const promptGuidelines = [
	"Run draft once on the final version of text a person will read, after facts, evidence and position are settled: chat replies longer than three sentences, status reports, questions to other people, saved documents, tickets, commit messages and pull request descriptions.",
	"Do not run draft on notes, intermediate drafts or work in progress. After a repair, run it once more. A clean result does not show that the text is good.",
];
export const description =
	"Find slop tells in final prose, commit messages or unified diffs. Supply text or a saved file path and its kind. Return hard and scored findings with line numbers, score, band and calibration. Never rewrite text.";

async function readSaved(path: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		if (!(await file.stat()).isFile()) throw new Error("The path is not a regular file.");
		const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			signal?.throwIfAborted();
			const read = await file.read(bytes, length, bytes.length - length, null);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		if (length > MAX_FILE_BYTES) throw new Error("The file exceeds the input limit.");
		if (bytes.subarray(0, length).includes(0)) throw new Error("The file contains binary data.");
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
	} finally {
		await file.close();
	}
}

export async function checkDraft(input: DraftInput, cwd: string, signal?: AbortSignal) {
	signal?.throwIfAborted();
	if ((input.text === undefined) === (input.path === undefined)) throw new Error("Supply exactly one of text or path.");
	if (!["prose", "commit", "diff"].includes(input.kind)) throw new Error("Unknown text kind.");
	const path = input.path === undefined ? undefined : resolve(cwd, input.path);
	const text = path === undefined ? (input.text ?? "") : await readSaved(path, signal);
	if (text.length > MAX_TOOL_CHARS) throw new Error("The text exceeds the input limit.");
	signal?.throwIfAborted();
	const kind = input.kind === "prose" ? (path === undefined ? "md" : (kindForPath(path) ?? "text")) : input.kind;
	const report = measure(text, kind, path);
	return { report, text: renderText(report, { verbose: false, quiet: false, color: false }) };
}
