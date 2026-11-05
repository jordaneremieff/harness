import assert from "node:assert/strict";
import { it } from "node:test";
import { SESSION_NAME_CODE_POINTS, SESSION_NAME_WORDS, sessionNameFromInput } from "./session-name.ts";

it("uses the leading line and removes markdown block markers", () => {
	assert.equal(sessionNameFromInput("Fix the parser.\nMore detail follows."), "Fix the parser");
	assert.equal(sessionNameFromInput("## Plan the work"), "Plan the work");
	assert.equal(sessionNameFromInput("- **Fix the parser.**"), "Fix the parser");
	assert.equal(sessionNameFromInput("> quoted task"), "quoted task");
	assert.equal(sessionNameFromInput("1. step one"), "step one");
	assert.equal(sessionNameFromInput("   \n  Review\n the\tparser "), "Review");
});

it("uses the first sentence of the leading line", () => {
	assert.equal(sessionNameFromInput("Draft release notes for the parser. Reply only OK."), "Draft release notes for the parser");
	assert.equal(sessionNameFromInput("Why does the upload retry fail? Check the logs"), "Why does the upload retry fail");
	assert.equal(sessionNameFromInput("Bump version to 1.2.3 for release"), "Bump version to 1.2.3 for release");
});

it("drops fenced blocks, inline code and URLs", () => {
	assert.equal(sessionNameFromInput("```ts\nconst value = 1;\n```\nExplain the parser"), "Explain the parser");
	assert.equal(sessionNameFromInput("~~~\nsecret\n~~~"), undefined);
	assert.equal(sessionNameFromInput("Fix the `parse()` crash"), "Fix the crash");
	assert.equal(sessionNameFromInput("https://example.com/very/long/path"), undefined);
	assert.equal(sessionNameFromInput("Review https://example.com/x for the parser"), "Review for the parser");
});

it("removes control and format characters", () => {
	assert.equal(sessionNameFromInput("Fix\u200Bthe\u202Eparser"), "Fix the parser");
	assert.equal(sessionNameFromInput("Fix\u0007 the parser"), "Fix the parser");
	assert.equal(sessionNameFromInput("\u200B\u202E"), undefined);
});

it("uses slash arguments and refuses command text without usable arguments", () => {
	assert.equal(sessionNameFromInput("/skill:demo repair the parser"), "repair the parser");
	assert.equal(sessionNameFromInput("/template\nWrite release notes"), "Write release notes");
	assert.equal(sessionNameFromInput("/x"), undefined);
	assert.equal(sessionNameFromInput("/x --flag"), undefined);
});

it("rejects text without enough letters or digits", () => {
	assert.equal(sessionNameFromInput(""), undefined);
	assert.equal(sessionNameFromInput("   "), undefined);
	assert.equal(sessionNameFromInput("!!!"), undefined);
	assert.equal(sessionNameFromInput("😀 😀 😀"), undefined);
	assert.equal(sessionNameFromInput("ab"), undefined);
	assert.equal(sessionNameFromInput("2026"), "2026");
});

it("caps the name by code points and words", () => {
	const words = sessionNameFromInput("abcdefghij klmnopqrst uvwxyzabcd efghijklmn opqrstuvwx yzabcdefgh");
	assert.ok(words);
	assert.ok(Array.from(words).length <= SESSION_NAME_CODE_POINTS);
	assert.equal(words, "abcdefghij klmnopqrst uvwxyzabcd efghijklmn");
	const many = sessionNameFromInput("one two three four five six seven eight nine ten");
	assert.equal(many, "one two three four five six seven eight");
	assert.equal(many?.split(" ").length, SESSION_NAME_WORDS);
});

it("does not break a surrogate pair at the word boundary", () => {
	const emoji = "😀".repeat(60);
	const name = sessionNameFromInput(`Task ${emoji}`);
	assert.equal(name, "Task");
	assert.doesNotMatch(name ?? "", /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
	assert.equal(sessionNameFromInput("a".repeat(SESSION_NAME_CODE_POINTS + 1)), undefined);
});
