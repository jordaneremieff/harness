import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { publish, type PublishOutcome } from "./publish.ts";
import { parseShowArgs, showCommand } from "./show.ts";
import { displaySource, documentHeading, keyAction, READING_COLUMNS, ReadingColumn, watchDocument } from "./show-screen.ts";
import { MarkdownStore, type StoredDocument } from "./store.ts";

async function fixture(run: (store: MarkdownStore) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "markdown-show-"));
	try {
		await run(new MarkdownStore(join(root, "store")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
function published(outcome: PublishOutcome) {
	if (!outcome.ok) throw new Error(JSON.stringify(outcome));
	return outcome;
}

test("the show command runs this program with the store root and document, and parses back", () => {
	const command = showCommand("/private/store", "md-0123456789abcdef0123");
	assert.equal(command[0], process.execPath);
	assert.ok(isAbsolute(command[1] ?? "") && command[1]?.endsWith(join("extensions", "markdown", "show.ts")) && existsSync(command[1]));
	assert.deepEqual(parseShowArgs(command.slice(2)), { help: false, store: "/private/store", document: "md-0123456789abcdef0123" });
	assert.deepEqual(parseShowArgs(["md-0123"]), { help: false, document: "md-0123" });
	assert.deepEqual(parseShowArgs(["--help"]), { help: true });
	for (const [args, message] of [[[], /Name a document/], [["--store"], /requires a directory/], [["--wide", "md-1"], /Unknown option/], [["md-1", "md-2"], /Name one document/]] as const)
		assert.throws(() => parseShowArgs(args), message);
});

test("the program loads its screen under plain Node and refuses a terminal-less run", async () => {
	const [executable, ...args] = showCommand("/unused", "md-0123456789abcdef0123");
	const child = spawn(executable ?? process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
	assert.equal(code, 1);
	assert.equal(stderr.trim(), "The document view requires an interactive terminal.");
});

test("document text cannot send terminal controls", () => {
	assert.equal(displaySource("a\r\nb\tc\n"), "a\nb\tc\n");
	assert.equal(displaySource("title\u001b]0;owned\u0007 \u001b[31mred\u009b"), "title\u241b]0;owned\u2407 \u241b[31mred\ufffd");
	assert.equal(displaySource("bell\u0007 delete\u007f"), "bell\u2407 delete\ufffd");
});

test("the heading names the document, revision, kind, size and partial state", () => {
	const stored = {
		document: { id: "md-0123456789abcdef0123", kind: "response", revision: 3 },
		revision: { title: "Plan\u001b[2J", revision: 3, bytes: 2048, completeness: { state: "partial", reason: "length" } },
	} as unknown as StoredDocument;
	assert.deepEqual(documentHeading(stored), { title: "Plan [2J", detail: "md-01234567 · revision 3 · response snapshot · 2.0 KB · partial (length)" });
});

test("the reading column centres a bounded line length", () => {
	const widths: number[] = [];
	const column = new ReadingColumn({
		render: (width) => {
			widths.push(width);
			return ["text"];
		},
		invalidate: () => {},
	}, 10);
	assert.deepEqual(column.render(30), [`${" ".repeat(10)}text`]);
	assert.deepEqual(column.render(8), ["text"]);
	assert.deepEqual(widths, [10, 8]);
	assert.equal(READING_COLUMNS, 100);
});

test("keys map to view actions", () => {
	const actions = ["j", "k", "\u001b[B", "\u001b[A", " ", "b", "g", "G", "o", "r", "q", "\u001b", "\u0003", "x"].map(keyAction);
	assert.deepEqual(actions, ["down", "up", "down", "up", "page-down", "page-up", "start", "end", "open", "reload", "close", "close", "close", undefined]);
});

test("a new published revision reaches the document watcher", () =>
	fixture(async (store) => {
		const first = published(await publish({ title: "Followed", text: "one" }, { cwd: store.root, store }));
		const stored = await store.get(first.documentId);
		let notify!: () => void;
		const changed = new Promise<void>((resolve) => (notify = resolve));
		const watcher = watchDocument(store.root, stored, () => notify());
		assert.ok(watcher);
		try {
			published(await publish({ title: "Followed", text: "two", document: first.documentId, expectedRevision: 1 }, { cwd: store.root, store }));
			await changed;
			assert.equal((await store.get(first.documentId)).revision.revision, 2);
		} finally {
			watcher.close();
		}
	}));
