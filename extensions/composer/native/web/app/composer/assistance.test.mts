import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

interface Recall { entries: string[]; index: number | null; text: string; base: string; selectionStart: number; selectionEnd: number }
interface Assistance {
	completionTrigger(text: string, cursor: number): boolean;
	completionEdit(text: string, next: string, cursor: number): { start: number; end: number; text: string; cursor: number } | null;
	historyStep(context: Recall, direction: number): { index: number | null; text: string } | null;
	imagePaths(text: string): { path: string; start: number; end: number }[];
	syntaxParts(text: string): { text: string; kind?: string }[];
}
const scope = {} as { composerAssistance: Assistance };
runInNewContext(stripTypeScriptTypes(readFileSync(new URL("./assistance.ts", import.meta.url), "utf8")), scope);
const { completionTrigger, completionEdit, historyStep, imagePaths, syntaxParts } = scope.composerAssistance;

test("slash parameters and standalone file mentions ask Pi for completions", () => {
	assert.equal(completionTrigger("/reload arg", 11), true);
	assert.equal(completionTrigger("two @src", 8), true);
	assert.equal(completionTrigger("a@b", 3), false);
	assert.equal(completionTrigger("hello /re", 9), false);
});

test("a completion replaces complete surrogate pairs and preserves surrounding text", () => {
	const before = "@🌲/keep", after = "@🌳/keep";
	const next = completionEdit(before, after, 3);
	assert.equal(next?.start, 1);
	assert.equal(next?.end, 3);
	assert.equal(next?.text, "🌳");
	assert.equal(next?.cursor, 3);
	assert.equal(completionEdit(before, after, 2), null);
});

test("history honours line boundaries and restores the empty draft", () => {
	const base = { entries: ["old", "new\nentry"], index: null, text: "", base: "", selectionStart: 0, selectionEnd: 0 };
	assert.equal(historyStep(base, -1)?.text, "new\nentry");
	const recalled = { ...base, index: 1, text: "new\nentry" };
	assert.equal(historyStep(recalled, 1), null);
	assert.equal(historyStep(recalled, -1)?.text, "old");
	assert.equal(historyStep({ ...recalled, selectionStart: 9, selectionEnd: 9 }, 1)?.text, "");
	assert.equal(historyStep({ ...recalled, text: "modified" }, -1), null);
});

test("image ranges refer to the path text, including spaces and shell quotes", () => {
	const text = "A draft\n/folder/one photo.png\n!/bin/tool '/folder/two'\\''s.gif'\nhttps://example.invalid/file.png";
	const paths = imagePaths(text);
	assert.equal(paths.length, 2);
	assert.equal(paths[0].path, "/folder/one photo.png");
	assert.equal(paths[1].path, "/folder/two's.gif");
	assert.equal(text.slice(paths[1].start, paths[1].end), "'/folder/two'\\''s.gif'");
});

test("colour spans preserve every character", () => {
	const text = "/review @notes\n/tmp/photo.png\n";
	const parts = syntaxParts(text);
	assert.equal(parts.map(({ text: part }) => part).join(""), text);
	assert.equal(parts.filter(({ kind }) => kind).map(({ kind }) => kind).join(","), "command,mention,path");
});
