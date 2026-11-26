import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Workspace } from "./store.ts";

function fixture(t: TestContext) {
	const base = mkdtempSync(join(tmpdir(), "editor-store-"));
	const root = join(base, "project");
	const agentDir = join(base, "agent");
	mkdirSync(root);
	mkdirSync(agentDir);
	const stores: Workspace[] = [];
	t.after(() => {
		for (const store of stores) store.close();
		rmSync(base, { recursive: true, force: true });
	});
	const open = (folder = root) => {
		const store = new Workspace(folder, agentDir);
		stores.push(store);
		return store;
	};
	return { base, root, agentDir, open };
}

function call(store: Workspace, op: string, input = {}, author = "You") {
	return store.run({ op, ...input }, author);
}

function outputs(value: unknown) {
	assert.ok(Array.isArray(value));
	return value.map((row) => ({ ...row }));
}

test("human splices and guarded agent edits share a revision without implicit file writes", (t) => {
	const { root, open } = fixture(t);
	const file = join(root, "source.txt");
	writeFileSync(file, "start 👋 aaa\n");
	const pane = open();
	const agent = open();
	const initial = call(pane, "state");
	assert.deepEqual(initial.docs, []);
	const view = call(pane, "read", { doc: "source.txt" });
	const doc = view.doc;
	assert.equal(view.dirty, false);
	assert.equal(call(agent, "read", { doc }).rev, view.rev);
	const seq = call(pane, "state").seq;
	assert.deepEqual(call(agent, "state", { since: seq }), { seq, unchanged: true });
	assert.throws(() => call(pane, "patch", { doc, rev: view.rev, start: 7, end: 8, text: "" }), /UTF-16/);
	assert.throws(() => call(agent, "edit", { doc, rev: view.rev, find: "aa", replace: "b" }), /exactly once/);
	const { id } = call(pane, "note", { doc, rev: view.rev, start: 6, end: 8, text: "Greeting" });
	const edit = call(agent, "edit", { doc, rev: view.rev, find: "aaa", replace: "other" }, "Agent");
	assert.throws(() => call(pane, "patch", { doc, rev: view.rev, start: 6, end: 8, text: "🏡" }), /revision changed/);
	assert.throws(() => call(pane, "save", { doc, rev: view.rev }), /revision changed/);
	assert.throws(() => call(pane, "note", { doc, rev: view.rev, start: 0, end: 0, text: "Old" }), /revision changed/);
	const next = call(pane, "patch", { doc, rev: edit.rev, start: 6, end: 8, text: "🏡" });
	assert.equal(next.rev, 3);
	assert.equal(readFileSync(file, "utf8"), "start 👋 aaa\n");
	assert.deepEqual(call(agent, "read", { doc, ifRev: next.rev }), { doc, rev: next.rev, dirty: true, unchanged: true });
	assert.equal(call(agent, "read", { doc }).text, "start 🏡 other\n");
	call(agent, "reply", { id, text: "Replaced; the original anchor remains" }, "Agent");
	pane.close();
	agent.close();
	const reopened = open();
	const header = outputs(call(reopened, "state").threads)[0];
	assert.equal(header.rev, view.rev);
	assert.equal(header.messageCount, 2);
	assert.equal(header.messages, undefined);
	const thread = call(reopened, "thread", { id });
	assert.equal(thread.quote, "👋");
	assert.deepEqual(outputs(thread.messages), [
		{ author: "You", text: "Greeting" },
		{ author: "Agent", text: "Replaced; the original anchor remains" },
	]);
	assert.equal(call(reopened, "read", { doc }).text, "start 🏡 other\n");
	assert.equal(call(reopened, "save", { doc, rev: next.rev }).dirty, false);
	assert.equal(readFileSync(file, "utf8"), "start 🏡 other\n");
});

test("clean disk changes become revisions and dirty disk conflicts preserve both versions", (t) => {
	const { root, open } = fixture(t);
	const doc = "source.txt";
	const file = join(root, doc);
	const original = "\ufeffone\r\ntwo\r\n";
	writeFileSync(file, original);
	chmodSync(file, 0o751);
	const store = open();
	const first = call(store, "read", { doc });
	assert.equal(first.text, "one\ntwo\n");
	writeFileSync(file, "\ufeffONE\r\ntwo\r\n");
	const changed = call(store, "read", { doc, ifRev: first.rev });
	assert.equal(changed.text, "ONE\ntwo\n");
	assert.notEqual(changed.rev, first.rev);
	const dirty = call(store, "patch", { doc, rev: changed.rev, start: 0, end: 3, text: "new\r\nfirst" });
	const saved = call(store, "save", { doc, rev: dirty.rev });
	assert.equal(saved.text, "new\nfirst\ntwo\n");
	assert.equal(readFileSync(file, "utf8"), "\ufeffnew\r\nfirst\r\ntwo\r\n");
	assert.equal(statSync(file).mode & 0o777, 0o751);
	const unsaved = call(store, "edit", { doc, rev: saved.rev, find: "two", replace: "end" });
	writeFileSync(file, "\ufeffnew\r\nfirst\r\nTWO\r\n");
	assert.deepEqual(call(store, "read", { doc, ifRev: unsaved.rev }), {
		doc,
		rev: unsaved.rev,
		dirty: true,
		diskChanged: true,
		unchanged: true,
	});
	assert.throws(() => call(open(), "save", { doc, rev: unsaved.rev }), /Disk contents changed/);
	assert.equal(readFileSync(file, "utf8"), "\ufeffnew\r\nfirst\r\nTWO\r\n");
	assert.equal(call(store, "read", { doc }).text, "new\nfirst\nend\n");
	const copy = call(store, "save", { doc, rev: unsaved.rev, path: "copy.txt" });
	assert.equal(copy.doc, "copy.txt");
	assert.equal(readFileSync(join(root, "copy.txt"), "utf8"), "\ufeffnew\r\nfirst\r\nend\r\n");
	assert.equal(call(store, "read", { doc }).dirty, true);
});

test("a discarded named draft does not reuse its revision when another writer recreates it", (t) => {
	const { root, open } = fixture(t);
	const store = open();
	const peer = open();
	const first = call(store, "new", { path: "unsaved.txt" });
	const doc = first.doc;
	const draft = call(peer, "patch", { doc, rev: first.rev, start: 0, end: 0, text: "first draft" });
	const discard = (rev: unknown) => store.run({ op: "revert", doc, rev }, "You", true);
	assert.throws(() => discard(first.rev), { code: "conflict" });
	assert.equal(call(peer, "read", { doc }).text, "first draft");
	assert.deepEqual(discard(draft.rev), { doc, discarded: true });
	assert.equal(existsSync(join(root, "unsaved.txt")), false);
	assert.throws(() => call(peer, "read", { doc }), { code: "not_found" });
	const second = call(peer, "new", { path: doc });
	assert.throws(() => discard(draft.rev), { code: "conflict" });
	assert.equal(call(peer, "read", { doc }).rev, second.rev);
	assert.throws(() => call(peer, "revert", { doc, rev: second.rev }), { code: "not_found" });
	writeFileSync(join(root, "unsaved.txt"), "now on disk\r");
	const loaded = discard(second.rev);
	assert.equal(loaded.text, "now on disk\n");
	assert.equal(loaded.dirty, false);
	assert.equal(loaded.eol, "\r");
});

test("a never-saved draft in a removed parent is discardable, but a symlink is not evidence of absence", (t) => {
	const { root, base, open } = fixture(t);
	const folder = join(root, "folder");
	mkdirSync(folder);
	const store = open();
	const { doc, rev } = call(store, "new", { path: "folder/new.txt" });
	rmSync(folder, { recursive: true });
	symlinkSync(base, folder);
	const discard = () => store.run({ op: "revert", doc, rev }, "You", true);
	assert.throws(discard, { code: "invalid" });
	assert.equal(call(store, "read", { doc }).rev, rev);
	unlinkSync(folder);
	assert.deepEqual(discard(), { doc, discarded: true });
	assert.deepEqual(call(store, "state").docs, []);
});

test("scratch conversion preserves exact and tab anchors and only creates new paths", (t) => {
	const { root, open } = fixture(t);
	const store = open();
	const { doc, rev } = call(store, "new");
	assert.match(String(doc), /^scratch:/);
	assert.notEqual(call(store, "new").doc, doc);
	const next = call(store, "patch", { doc, rev, start: 0, end: 0, text: "scratch bytes\n" });
	const text = call(store, "note", { doc, rev: next.rev, start: 0, end: 7, text: "Quote" });
	const tab = call(store, "note", { target: { kind: "tab", key: doc }, text: "Scratch tab" });
	const folder = call(store, "note", { target: { kind: "folder", key: "" }, text: "Root folder" });
	const file = join(root, "existing.txt");
	writeFileSync(file, "no replace\n");
	assert.throws(() => call(store, "save", { doc, rev: next.rev, path: "existing.txt" }), /already exists/);
	assert.equal(readFileSync(file, "utf8"), "no replace\n");
	assert.equal(call(store, "read", { doc }).text, "scratch bytes\n");
	const first = call(store, "new", { path: "late.txt" });
	assert.equal(existsSync(join(root, "late.txt")), false);
	assert.throws(() => call(open(), "new", { path: "late.txt" }), /already exists/);
	writeFileSync(join(root, "late.txt"), "late external file");
	assert.throws(() => call(store, "save", { doc: first.doc, rev: first.rev }), /Disk contents changed/);
	assert.equal(readFileSync(join(root, "late.txt"), "utf8"), "late external file");
	const saved = call(store, "save", { doc, rev: next.rev, path: "recovered.txt" });
	assert.equal(saved.doc, "recovered.txt");
	assert.equal(readFileSync(join(root, "recovered.txt"), "utf8"), "scratch bytes\n");
	assert.throws(() => call(store, "read", { doc }), /Draft not found/);
	const other = open();
	assert.equal(call(other, "thread", text).doc, "recovered.txt");
	assert.equal(call(other, "thread", text).quote, "scratch");
	assert.deepEqual(call(other, "thread", tab).target, { kind: "tab", key: "recovered.txt" });
	const rootThread = call(other, "thread", folder);
	assert.deepEqual(rootThread, {
		...folder,
		doc: "",
		start: 0,
		end: 0,
		rev: 0,
		quote: "",
		target: { kind: "folder", key: "" },
		messages: rootThread.messages,
	});
	assert.ok(outputs(call(other, "state").threads).some((row) => row.id === folder.id && row.target.key === ""));
	assert.throws(
		() => call(other, "note", { target: { kind: "file", key: "../secret" }, text: "Outside" }),
		/folder-relative/,
	);
	assert.throws(() => call(other, "note", { target: { kind: "pane", key: "p" }, start: 0, text: "Both" }), /not both/);
});

test("canonical roots isolate private state and reject symlinks, internals and non-text", (t) => {
	const { base, root, agentDir, open } = fixture(t);
	const outside = join(base, "other");
	mkdirSync(outside);
	const otherFile = join(outside, "same.txt");
	writeFileSync(otherFile, "this is outside");
	writeFileSync(join(root, "same.txt"), "inside");
	writeFileSync(join(root, "binary"), Buffer.from([0xff, 0x00]));
	writeFileSync(join(root, "huge"), "a");
	truncateSync(join(root, "huge"), 2 * 1024 * 1024 + 1);
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "config"), "private");
	symlinkSync(otherFile, join(root, "link"));
	symlinkSync(outside, join(root, "parent"));
	symlinkSync(root, join(base, "root-alias"));
	const a = open();
	const b = open(outside);
	assert.equal(a.dir, open(join(base, "root-alias")).dir);
	assert.notEqual(a.dir, b.dir);
	assert.equal(statSync(a.dir).mode & 0o777, 0o700);
	assert.equal(statSync(join(a.dir, "workspace.db")).mode & 0o777, 0o600);
	assert.throws(() => new Workspace(base, agentDir), /separate/);
	const view = call(a, "read", { doc: "same.txt" });
	call(a, "patch", { doc: view.doc, rev: view.rev, start: 0, end: 0, text: "still " });
	assert.equal(call(b, "read", { doc: "same.txt" }).text, "this is outside");
	assert.throws(() => call(a, "read", { doc: "link" }), /symlink/);
	assert.throws(() => call(a, "new", { path: "parent/new.txt" }), /symlink/);
	assert.throws(() => call(a, "read", { doc: ".GIT/config" }), /version-control/);
	assert.throws(() => call(a, "read", { doc: "../other/same.txt" }), /folder-relative/);
	assert.throws(() => call(a, "read", { doc: "binary" }), /UTF-8/);
	assert.throws(() => call(a, "read", { doc: "huge" }), /2 MiB/);
	assert.throws(() => call(a, "save", { doc: view.doc, rev: 2, path: "parent/new.txt" }), /symlink/);
	assert.equal(existsSync(join(outside, "new.txt")), false);
});

test("state exposes short, Unicode-safe headers and the full thread retains accepted replies", (t) => {
	const { open } = fixture(t);
	const store = open();
	const { doc, rev } = call(store, "new");
	const text = `${"x".repeat(239)}🌳${"w".repeat(120)}`;
	const next = call(store, "patch", { doc, rev, start: 0, end: 0, text });
	const { id } = call(store, "note", { doc, rev: next.rev, start: 0, end: text.length, text });
	const header = outputs(call(store, "state").threads)[0];
	assert.equal(header.quote, "x".repeat(239));
	assert.equal(header.quoteShortened, true);
	assert.equal(header.preview, header.quote);
	assert.equal(header.previewShortened, true);
	const fullMessage = "p".repeat(4096);
	for (let i = 0; i < 7; i++) call(store, "reply", { id, text: fullMessage });
	assert.throws(() => call(store, "reply", { id, text: fullMessage }), /Thread limit/);
	const full = call(open(), "thread", { id });
	assert.equal(full.quote, text);
	assert.deepEqual(
		outputs(full.messages).map((row) => row.text),
		[text, ...Array<string>(7).fill(fullMessage)],
	);
});

test("view writes and their workspace sequence change commit together", (t) => {
	const { open } = fixture(t);
	const producer = open();
	const consumer = open();
	const initial = call(consumer, "state").seq;
	const blocks = [{ kind: "text", text: "Plain text summary" }];
	const view = call(producer, "compose", { title: "Notes", blocks }, "Agent");
	const snapshot = call(consumer, "state", { since: initial });
	assert.deepEqual(outputs(snapshot.views), [view]);
	assert.deepEqual(call(consumer, "view", { id: view.id }), { ...view, author: "Agent", blocks });
	const next = call(consumer, "compose", { id: view.id, rev: view.rev, title: "Updated", blocks });
	const updated = call(producer, "state", { since: snapshot.seq });
	assert.deepEqual(outputs(updated.views), [next]);
	assert.throws(
		() => call(producer, "compose", { id: view.id, rev: view.rev, title: "Stale", blocks }),
		/revision changed/,
	);
	assert.deepEqual(call(consumer, "state", { since: updated.seq }), { seq: updated.seq, unchanged: true });
});

test("simultaneous database opens and writes have one winner", { timeout: 15000 }, async (t) => {
	const { root, agentDir, open } = fixture(t);
	const url = new URL("./store.ts", import.meta.url).href;
	const script = `
		const [url, root, agentDir] = process.argv.slice(1);
		const { Workspace } = await import(url);
		process.once('message', () => {
			const store = new Workspace(root, agentDir);
			process.once('message', ({ doc, rev, text }) => {
				try {
					process.send(store.run({ op: 'patch', doc, rev, start: 0, end: 0, text }, text));
				} catch (error) {
					process.send({ code: error.code });
				} finally { store.close(); process.disconnect(); }
			});
			process.send('open');
		});
		process.send('loaded');
	`;
	const children = Array.from({ length: 2 }, () =>
		spawn(process.execPath, ["--input-type=module", "-e", script, url, root, agentDir], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		}),
	);
	const exits = children.map((child) => once(child, "exit"));
	t.after(async () => {
		for (const child of children) child.kill();
		await Promise.allSettled(exits);
	});
	const receive = (i: number) =>
		Promise.race([
			once(children[i], "message").then(([value]) => value),
			exits[i].then(([code]) => {
				throw new Error(`Store test process exited before its receipt: ${code}`);
			}),
		]);
	assert.deepEqual(await Promise.all(children.map((_, i) => receive(i))), ["loaded", "loaded"]);
	const ready = children.map((_, i) => receive(i));
	for (const child of children) child.send("open");
	assert.deepEqual(await Promise.all(ready), ["open", "open"]);
	const store = open();
	const { doc, rev } = call(store, "new");
	const results = children.map((child, i) => {
		const result = receive(i);
		child.send({ doc, rev, text: `writer ${i}` });
		return result;
	});
	const receipts = await Promise.all(results);
	assert.equal(receipts.filter((receipt) => receipt.rev === 2).length, 1);
	assert.equal(receipts.filter((receipt) => receipt.code === "conflict").length, 1);
	assert.match(String(call(store, "read", { doc }).text), /^writer [01]$/);
	assert.deepEqual(await Promise.all(exits), [
		[0, null],
		[0, null],
	]);
});
