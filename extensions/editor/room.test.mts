import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EditorRoom } from "./room.ts";
import type { Invitation, Participant } from "./participants.ts";

test("a browser hands a folder thread to one participant, which edits its shared draft and publishes a linked tab", async (t) => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "editor-room-")));
	const root = join(base, "project"),
		other = join(base, "other"),
		state = join(base, "pi");
	await Promise.all([mkdir(root), mkdir(other), mkdir(state, { mode: 0o700 })]);
	await writeFile(join(root, "sample.ts"), "export const count = 1;\n");
	const messages: Invitation[] = [];
	let opened: URL | undefined;
	const a: Participant = { id: "ordinary:a", label: "Writer", kind: "ordinary" };
	const b: Participant = { id: "durable:b:2", label: "Reviewer", kind: "durable" };
	const author = new EditorRoom(
		state,
		root,
		a,
		async () => {
			throw Error("Wrong recipient");
		},
		async (url) => {
			opened = new URL(url);
		},
	);
	const reader = new EditorRoom(state, other, b, async (req) => {
		messages.push(req);
	});
	t.after(async () => {
		await Promise.all([author.close(), reader.close()]);
		await rm(base, { recursive: true, force: true });
	});
	await author.command("sample.ts");
	assert.ok(opened);
	const url = opened as URL;
	const api = new URL("/api", url.origin);
	const fragment = new URLSearchParams(url.hash.slice(1));
	assert.equal(fragment.get("file"), "sample.ts");
	async function web(body: Record<string, unknown>) {
		return fetch(api, {
			method: "POST",
			headers: { Authorization: `Bearer ${fragment.get("k")}`, "Content-Type": "application/json", Origin: url.origin },
			body: JSON.stringify(body),
		});
	}
	assert.equal((await fetch(api, { method: "POST" })).status, 403);
	assert.deepEqual((await (await web({ op: "members" })).json()).members, [a]);
	await reader.tool({ op: "join", root });
	assert.deepEqual(
		new Set((await (await web({ op: "members" })).json()).members.map((m: Participant) => m.id)),
		new Set([a.id, b.id]),
	);
	const file = await (await web({ op: "read", doc: "sample.ts" })).json();
	const changed = await (
		await web({ op: "patch", doc: file.doc, rev: file.rev, start: 21, end: 22, text: "2" })
	).json();
	assert.equal(changed.rev, file.rev + 1);
	const note = await (await web({ op: "note", target: { kind: "folder", key: "" }, text: "Map this folder" })).json();
	assert.equal((await web({ op: "send", id: note.id, to: b.id, message: "Map this folder" })).status, 200);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].thread, note.id);
	assert.deepEqual(messages[0].target, { kind: "folder", key: "" });
	const read = await reader.tool({ op: "read", doc: file.doc, root });
	assert.match(String(read.text), /= 2;/);
	await reader.tool({ op: "edit", doc: file.doc, rev: read.rev, find: "2;", replace: "3;", root });
	assert.equal((await web({ op: "save", doc: file.doc, rev: changed.rev })).status, 409);
	assert.match(await readFile(join(root, file.doc), "utf8"), /= 1;/);
	const map = await reader.tool({
		op: "compose",
		root,
		title: "Code map",
		blocks: [{ kind: "location", text: "Count", doc: file.doc, line: 1 }],
	});
	await reader.tool({ op: "reply", root, id: note.id, text: "See the Code map tab." });
	const shared = await (await web({ op: "state" })).json();
	assert.equal(shared.views[0].id, map.id);
	const final = await (await web({ op: "read", doc: file.doc })).json();
	assert.match(final.text, /= 3;/);
	assert.equal((await web({ op: "save", doc: file.doc, rev: final.rev })).status, 200);
	assert.match(await readFile(join(root, file.doc), "utf8"), /= 3;/);
	await reader.close();
	assert.deepEqual((await (await web({ op: "members" })).json()).members, [a]);
});

test("an agent builds an untitled draft and pages it without splitting a character", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "editor-page-"));
	const root = join(base, "project");
	await Promise.all([mkdir(root), mkdir(join(base, "state"), { mode: 0o700 })]);
	const room = new EditorRoom(
		join(base, "state"),
		root,
		{ id: "ordinary:b", label: "Writer", kind: "ordinary" },
		async () => {},
	);
	t.after(async () => {
		await room.close();
		await rm(base, { recursive: true, force: true });
	});
	const scratch = await room.tool({ op: "new" });
	const doc = scratch.doc;
	const patch = await room.tool({ op: "patch", doc, rev: scratch.rev, start: 0, end: 0, text: "a🌿b" });
	const first = await room.tool({ op: "read", doc, limit: 2 });
	assert.equal(first.text, "a");
	await assert.rejects(room.tool({ op: "read", doc, offset: first.nextOffset }), /needs the revision/);
	const next = await room.tool({ op: "read", doc, rev: first.rev, offset: first.nextOffset, limit: 1 });
	assert.equal(next.text, "🌿");
	const note = await room.tool({ op: "note", doc, rev: patch.rev, start: 1, end: 3, text: "This character." });
	const state = await room.tool({ op: "state", limit: 1 });
	const continuation = { op: "state", offset: state.nextOffset, seq: state.seq };
	assert.equal(state.nextOffset, 1);
	const tail = await room.tool(continuation);
	assert.deepEqual(
		(tail.threads as { id: string }[]).map((row) => row.id),
		[note.id],
	);
	assert.equal(tail.nextOffset, null);
	await room.tool({ op: "edit", doc, rev: patch.rev, find: "a", replace: "A" });
	await assert.rejects(room.tool(continuation), /workspace changed/);
	await assert.rejects(room.tool({ op: "read", doc, rev: first.rev, offset: next.nextOffset }), /changed/);
});
