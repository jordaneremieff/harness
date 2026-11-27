import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type { Participant } from "./participants.ts";
import { Workspace } from "./store.ts";
import { signature } from "./store-files.ts";

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
	assert.deepEqual(call(agent, "read", { doc, ifRev: next.rev }), {
		doc,
		rev: next.rev,
		dirty: true,
		author: "You",
		unchanged: true,
	});
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
		author: "You",
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

test("a pane replacement updates the destination revision and keeps the original file and draft", (t) => {
	const { root, open } = fixture(t);
	const store = open();
	const original = join(root, "original.txt");
	const path = "destination.txt";
	const file = join(root, path);
	writeFileSync(original, "\uFEFFsource\r\n");
	writeFileSync(file, "destination\n", { mode: 0o640 });
	const destination = call(store, "read", { doc: path });
	const note = call(store, "note", { doc: path, rev: destination.rev, start: 0, end: 11, text: "Old destination" });
	const source = call(store, "read", { doc: "original.txt" });
	const edited = store.run(
		{ op: "patch", doc: source.doc, rev: source.rev, start: 0, end: 6, text: "replacement" },
		"Agent",
	);
	const replace = signature(statSync(file, { bigint: true }));
	const input = { op: "save", doc: source.doc, rev: edited.rev, path, replace };
	assert.throws(() => store.run(input, "Agent"), /requires approval/);
	const saved = store.run(input, "You", true);
	assert.equal(saved.rev, Number(destination.rev) + 1);
	const replaced = call(open(), "read", { doc: path, ifRev: destination.rev });
	assert.equal(replaced.text, "replacement\n");
	assert.equal(replaced.author, "Agent");
	assert.equal(call(store, "thread", note).rev, destination.rev);
	assert.equal(readFileSync(file, "utf8"), "\uFEFFreplacement\r\n");
	assert.equal(statSync(file).mode & 0o777, 0o640);
	assert.equal(readFileSync(original, "utf8"), "\uFEFFsource\r\n");
	assert.equal(call(store, "read", { doc: source.doc }).dirty, true);
});

test("a pane replacement keeps dirty or changed destinations and moves scratch anchors only on success", (t) => {
	const { root, open } = fixture(t);
	const store = open();
	const path = "target.txt";
	const file = join(root, path);
	writeFileSync(file, "original\n");
	const { doc, rev } = call(store, "new");
	const draft = call(store, "patch", { doc, rev, start: 0, end: 0, text: "scratch\n" });
	const note = call(store, "note", { doc, rev: draft.rev, start: 0, end: 7, text: "Scratch text" });
	const tab = call(store, "note", { target: { kind: "tab", key: doc }, text: "Scratch tab" });
	const replace = signature(statSync(file, { bigint: true }));
	const input = { op: "save", doc, rev: draft.rev, path, replace };
	writeFileSync(file, "external writer\n");
	assert.throws(() => store.run(input, "You", true), /destination changed/);
	assert.equal(readFileSync(file, "utf8"), "external writer\n");
	const destination = call(store, "read", { doc: path });
	const dirty = call(store, "patch", { doc: path, rev: destination.rev, start: 0, end: 0, text: "draft " });
	const fresh = { ...input, replace: signature(statSync(file, { bigint: true })) };
	assert.throws(() => store.run(fresh, "You", true), /destination has unsaved changes/);
	assert.equal(call(store, "read", { doc: path }).text, "draft external writer\n");
	assert.equal(call(store, "read", { doc }).text, "scratch\n");
	call(store, "revert", { doc: path, rev: dirty.rev });
	const saved = store.run(fresh, "You", true);
	assert.equal(readFileSync(file, "utf8"), "scratch\n");
	assert.throws(() => call(store, "read", { doc }), /Draft not found/);
	assert.equal(call(store, "thread", note).doc, path);
	assert.equal(call(store, "thread", note).rev, saved.rev);
	assert.deepEqual(call(store, "thread", tab).target, { kind: "tab", key: path });
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

test("producer refresh reconciles only known clean drafts and preserves the author of each revision", (t) => {
	const { root, open } = fixture(t);
	const writer = open();
	const peer = open();
	const doc = "file.txt";
	const path = join(root, doc);
	writeFileSync(path, "one");
	const initial = writer.sequence();
	writer.refreshDisk(doc);
	assert.equal(peer.sequence(), initial);
	assert.deepEqual(call(peer, "state").docs, []);
	const disk = call(peer, "read", { doc });
	assert.equal(disk.author, "Disk");
	const replaced = writer.replaceProjectText(writer.projectText(doc), "two", "Agent");
	assert.equal(outputs(call(peer, "state").docs)[0].author, "Agent");
	call(peer, "save", { doc, rev: replaced.rev });
	writer.refreshDisk(doc);
	assert.equal(call(peer, "read", { doc, ifRev: replaced.rev }).author, "Agent");
	writeFileSync(path, "three");
	const before = peer.sequence();
	writer.refreshDisk(doc);
	assert.equal(peer.sequence(), before + 1);
	assert.equal(outputs(call(peer, "state").docs)[0].author, "Disk");
	const refreshed = call(peer, "read", { doc });
	assert.equal(refreshed.text, "three");
	const unsaved = call(peer, "edit", { doc, rev: refreshed.rev, find: "three", replace: "draft" }, "Agent");
	writeFileSync(path, "other");
	const beforeConflict = peer.sequence();
	writer.refreshDisk(doc);
	assert.equal(peer.sequence(), beforeConflict);
	const conflict = call(writer, "read", { doc, ifRev: unsaved.rev });
	assert.equal(conflict.diskChanged, true);
	assert.equal(conflict.author, "Agent");
	call(peer, "revert", { doc, rev: unsaved.rev });
	assert.equal(call(writer, "read", { doc }).author, "Disk");
});

const recipient: Participant = { id: "recipient", label: "Agent", kind: "ordinary" };
const sameLabel: Participant = { id: "other", label: "Agent", kind: "durable" };

function ask(store: Workspace): string {
	return call(store, "note", { target: { kind: "folder", key: "" }, text: "Question" }).id as string;
}

function messages(store: Workspace, id: string) {
	return outputs(call(store, "thread", { id }).messages).map((row) => row.text);
}

function requestHeader(store: Workspace, id: string) {
	return outputs(call(store, "state").threads).find((row) => row.id === id);
}

test("only a reply from the selected participant for the active request suppresses its automatic answer", (t) => {
	const { open } = fixture(t);
	const store = open();
	const peer = open();
	const id = ask(store);
	const reply = (text: string, participant: Participant, requestId?: string) =>
		peer.run({ op: "reply", id, text }, participant.label, false, {
			participant,
			request: requestId ? { thread: id, id: requestId } : undefined,
		});
	assert.equal(store.setRequest(id, "first", "queued", recipient), true);
	assert.equal(requestHeader(peer, id).requestState, "queued");
	assert.deepEqual(requestHeader(peer, id).requestBy, recipient);
	assert.equal(peer.setRequest(id, "first", "working", sameLabel), false);
	assert.equal(peer.setRequest(id, "first", "working", recipient), true);
	assert.equal(peer.setRequest(id, "first", "working", recipient), false);
	assert.equal(store.recordRequestFile(id, "first", "first-file"), true);
	assert.equal(store.setRequest(id, "next", "queued", recipient), true);
	assert.equal(requestHeader(peer, id).changedFiles, undefined);
	assert.equal(store.finishRequest(id, "first", recipient, "Old answer"), false);
	assert.equal(store.recordRequestFile(id, "first", "late-file"), false);
	reply("Old explicit reply", recipient, "first");
	reply("Someone else with the same label", sameLabel, "next");
	assert.equal(peer.finishRequest(id, "next", sameLabel, "Not the recipient"), false);
	assert.equal(peer.finishRequest(id, "next", recipient, "Automatic answer"), true);
	assert.equal(peer.finishRequest(id, "next", recipient, "Duplicate answer"), false);
	assert.deepEqual(messages(store, id), [
		"Question",
		"Old explicit reply",
		"Someone else with the same label",
		"Automatic answer",
	]);
	assert.equal(store.setRequest(id, "explicit", "queued", recipient), true);
	reply("Explicit answer", recipient, "explicit");
	assert.equal(peer.recordRequestFile(id, "explicit", "latest-file"), true);
	assert.equal(peer.finishRequest(id, "explicit", recipient, undefined, true), true);
	assert.equal(store.requestStatus(id, "explicit")?.state, "answered");
	assert.equal(store.recordRequestFile(id, "explicit", "too-late"), false);
	const reopened = open();
	assert.equal(requestHeader(reopened, id).requestState, "answered");
	assert.deepEqual(requestHeader(reopened, id).changedFiles, ["latest-file"]);
	assert.equal(typeof requestHeader(reopened, id).requestAt, "number");
	assert.equal(messages(reopened, id).at(-1), "Explicit answer");
});

test("automatic answers and changed file lists stay bounded without losing the newest files", (t) => {
	const { open } = fixture(t);
	const store = open();
	const id = ask(store);
	assert.equal(store.setRequest(id, "request", "queued", recipient), true);
	for (let i = 0; i < 52; i++) store.recordRequestFile(id, "request", `folder/file-${i}.txt`);
	assert.equal(store.recordRequestFile(id, "request", "folder/file-6.txt"), true);
	const before = store.sequence();
	assert.equal(store.recordRequestFile(id, "request", "folder/file-6.txt"), false);
	assert.equal(store.sequence(), before);
	assert.throws(() => store.recordRequestFile(id, "request", "../outside"), { code: "invalid" });
	const paths = requestHeader(store, id).changedFiles;
	assert.equal(paths.length, 50);
	assert.equal(paths[0], "folder/file-6.txt");
	assert.equal(paths[1], "folder/file-51.txt");
	assert.equal(paths.at(-1), "folder/file-2.txt");
	const veryLong = Array(16).fill("🌲".repeat(50)).join("/");
	for (let i = 0; i < 3; i++) store.recordRequestFile(id, "request", `${i}/${veryLong}`);
	const largePaths = requestHeader(store, id).changedFiles;
	assert.ok(Buffer.byteLength(JSON.stringify(largePaths)) <= 8192);
	assert.deepEqual(largePaths.slice(0, 2), [`2/${veryLong}`, `1/${veryLong}`]);
	assert.equal(store.finishRequest(id, "request", recipient, "🌲".repeat(2048)), true);
	const answer = messages(store, id).at(-1) as string;
	assert.doesNotMatch(answer, /[\ud800-\udfff]/u);
	assert.ok(Buffer.byteLength(answer) <= 4096);
	assert.match(answer, /\[Answer truncated in Editor\.\]$/);
});

test("text anchors retain their original line range and bounded context across revisions", (t) => {
	const { open } = fixture(t);
	const store = open();
	const { doc, rev } = call(store, "new");
	const long = "🌲".repeat(7000);
	const text = `before\n${long}\nstart\nend\n${long}\nafter`;
	const draft = call(store, "patch", { doc, rev, start: 0, end: 0, text });
	const start = text.indexOf("start");
	const end = text.indexOf("end\n") + 4;
	const { id } = call(store, "note", { doc, rev: draft.rev, start, end, text: "Question" });
	call(store, "patch", { doc, rev: draft.rev, start, end, text: "moved" });
	const anchor = call(open(), "thread", { id });
	assert.equal(anchor.lineStart, 3);
	assert.equal(anchor.lineEnd, 4);
	assert.equal(anchor.quote, "start\nend\n");
	const context = anchor.context as string;
	assert.doesNotMatch(context, /[\ud800-\udfff]/u);
	assert.ok(context.length <= 12288);
	assert.match(context, /🌲\nstart\nend\n🌲/u);
});

test("collaboration tables extend an existing workspace without rewriting its drafts or threads", (t) => {
	const { root, agentDir, open } = fixture(t);
	const dir = Workspace.directory(realpathSync.native(root), realpathSync.native(agentDir));
	assert.equal(existsSync(join(agentDir, "editor")), false);
	const store = open();
	assert.equal(store.dir, dir);
	const clean = "disk.txt";
	writeFileSync(join(root, clean), "disk text");
	call(store, "read", { doc: clean });
	const { doc, rev } = call(store, "new", {}, "Agent");
	const draft = call(store, "patch", { doc, rev, start: 0, end: 0, text: "draft text" }, "Agent");
	const note = call(store, "note", { doc, rev: draft.rev, start: 0, end: 5, text: "Original note" });
	const seq = store.sequence();
	store.close();
	const db = new DatabaseSync(join(dir, "workspace.db"));
	try {
		db.exec("DROP TABLE draft_authors; DROP TABLE thread_requests; DROP TABLE thread_anchors;");
		assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
	} finally {
		db.close();
	}
	const reopened = open();
	assert.equal(reopened.sequence(), seq);
	assert.equal(call(reopened, "read", { doc: clean }).author, "Disk");
	const unsaved = call(reopened, "read", { doc });
	assert.equal(unsaved.author, "You");
	assert.equal(unsaved.text, "draft text");
	const thread = call(reopened, "thread", note);
	assert.equal(thread.quote, "draft");
	assert.equal(thread.lineStart, undefined);
	assert.deepEqual(messages(reopened, note.id as string), ["Original note"]);
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
