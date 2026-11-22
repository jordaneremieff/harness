import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anchorMismatch } from "./anchor.ts";
import { editMemory, MemoryWriteError, sourceDigest, writeMemory } from "./store.ts";

const HEADER = '---\ntitle: "Editor choice"\nstatus: "active"\n---\n';
const BODY = [
	"",
	"# Editor choice",
	"",
	"## Summary",
	"",
	"Use editor A with plugins enabled.",
	"Keep the local files.",
	"They stay on this machine.",
	"Don\u2019t sync them \u2014 ever.",
	"",
].join("\n");
const NOTE = HEADER + BODY;
const mismatch = (oldText: string) => anchorMismatch(NOTE, HEADER.length, oldText, 2);

test("an anchor in the frontmatter or across its end names the body as the only editable part", () => {
	assert.equal(
		mismatch('status: "active"'),
		"edits[2].oldText is in the frontmatter, which memory_edit does not change; its generated fields update themselves. Anchor the edit on text in the body.",
	);
	assert.equal(
		mismatch('status: "active"\n---\n\n# Editor choice'),
		"edits[2].oldText starts in the frontmatter and ends in the body; memory_edit changes only the body. Anchor the edit on body text alone.",
	);
});

test("an anchor that differs only in whitespace or quote and dash forms quotes the exact body text to copy", () => {
	assert.equal(
		mismatch("Keep the local files. They stay on this machine."),
		'edits[2].oldText matches the body only when whitespace and quote or dash forms are ignored. The body has this text at line 11; copy it exactly: "Keep the local files.\\nThey stay on this machine."',
	);
	assert.equal(
		mismatch("Don't sync them - ever."),
		'edits[2].oldText matches the body only when whitespace and quote or dash forms are ignored. The body has this text at line 13; copy it exactly: "Don\u2019t sync them \u2014 ever."',
	);
	assert.match(mismatch("  Use   editor A  "), /line 10; copy it exactly: "Use editor A"$/u);
	assert.match(mismatch("zq"), /neither its start nor its end occurs there/u, "a short anchor locates nothing useful");
	const repeated = `${HEADER}\nSame line.\nSame  line.\n`;
	assert.match(anchorMismatch(repeated, HEADER.length, "Same\tline.", 0), /matches more than one place/u);
});

test("an anchor that stops matching shows where, with the body's text and the anchor's text at that point", () => {
	assert.equal(
		mismatch("Use editor A with plugin support."),
		'edits[2].oldText matches the body for its first 24 characters, up to line 10, and then differs. There the body continues "s enabled.\\nKeep the local files.\\nThey stay on this machine.\\nDon\u2019t sync them \u2014 ev", while oldText continues " support.". Copy the anchor exactly from the body.',
	);
	assert.equal(
		mismatch("Always use editor A with plugins enabled."),
		'edits[2].oldText matches the body for its last 33 characters, from line 10, but not before them. There the body has "\\n# Editor choice\\n\\n## Summary\\n\\nU", while oldText has "Always u". Copy the anchor exactly from the body.',
	);
	assert.equal(
		mismatch("Nothing like this appears anywhere."),
		"edits[2].oldText does not match the body, and neither its start nor its end occurs there. Read the note again and copy the anchor exactly from its body.",
	);
});

test("memory_edit refuses a mismatched anchor with the exact text, and the retry with that text succeeds", (t) => {
	const root = mkdtempSync(join(tmpdir(), "memory-anchor-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeMemory(root, {
		slug: "editor-choice",
		title: "Editor choice",
		tags: ["editor"],
		summary: "Use editor A.",
		details: "Keep the local files.\nThey stay on this machine.",
		sources: "Operator statement.",
		verified: true,
	});
	const path = join(root, "editor-choice.md");
	const source = readFileSync(path, "utf8");
	const input = { slug: "editor-choice", expectedDigest: sourceDigest(source), verified: false };
	let refusal: MemoryWriteError | undefined;
	try {
		editMemory(root, { ...input, edits: [{ oldText: "Keep the local files. They stay", newText: "Move them." }] });
	} catch (error) {
		assert.ok(error instanceof MemoryWriteError);
		refusal = error;
	}
	assert.ok(refusal, "the mismatched anchor refuses");
	assert.deepEqual(refusal.receipt.written, []);
	const quoted = /copy it exactly: ("(?:[^"\\]|\\.)*")$/u.exec(refusal.receipt.error ?? "");
	assert.ok(quoted, refusal.receipt.error);
	const exact = JSON.parse(quoted[1]) as string;
	assert.equal(exact, "Keep the local files.\nThey stay");
	const result = editMemory(root, { ...input, edits: [{ oldText: exact, newText: "Move them." }] });
	assert.equal(result.ok, true);
	assert.match(readFileSync(path, "utf8"), /Move them\. on this machine\./u);
});
