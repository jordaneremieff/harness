import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Invitation, Participant } from "./participants.ts";
import { paneConfig, startPaneService } from "./pane-service.ts";
import { EditorRoom } from "./room.ts";
import { signature } from "./store-files.ts";

test("a native pane hands a folder thread to one participant, which edits its shared draft and publishes a linked tab", async (t) => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "editor-room-")));
	const root = join(base, "project"),
		other = join(base, "other"),
		state = join(base, "pi");
	await Promise.all([mkdir(root), mkdir(other), mkdir(state, { mode: 0o700 })]);
	await writeFile(join(root, "sample.ts"), "export const count = 1;\n");
	const messages: Invitation[] = [];
	let api: URL | undefined;
	let token: string;
	let service: Awaited<ReturnType<typeof startPaneService>> | undefined;
	async function pane(body: Record<string, unknown>) {
		assert.ok(api);
		return fetch(api, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}
	const a: Participant = { id: "ordinary:a", label: "Writer", kind: "ordinary" };
	const b: Participant = { id: "durable:b:2", label: "Reviewer", kind: "durable" };
	const author = new EditorRoom(
		state,
		root,
		a,
		async () => {
			throw Error("Wrong recipient");
		},
		async () => async (folder, path) => {
			assert.equal(folder, root);
			assert.equal((await stat(path)).mode & 0o777, 0o600);
			const ticket = JSON.parse(await readFile(path, "utf8"));
			assert.equal(ticket.file, "sample.ts");
			assert.equal(ticket.root, root);
			assert.equal(ticket.settings, join(state, "editor", "settings.json"));
			assert.equal(ticket.layout, join(dirname(path), "layout.json"));
			await assert.rejects(stat(ticket.settings), { code: "ENOENT" });
			await assert.rejects(stat(ticket.layout), { code: "ENOENT" });
			assert.equal(ticket.version, 2);
			assert.equal(ticket.node, process.execPath);
			assert.match(ticket.program, /pane-program\.ts$/u);
			assert.equal("token" in ticket, false);
			assert.deepEqual(ticket.participant, a);
			await rm(path);
			service = await startPaneService(paneConfig({ ...ticket, appPid: process.pid }));
			api = new URL(`http://127.0.0.1:${service.port}/api`);
			token = service.token;
			assert.equal((await pane({ op: "loaded" })).status, 200);
			assert.equal((await pane({ op: "visibility", visible: true })).status, 200);
			return { blockId: "native-test" };
		},
	);
	const reader = new EditorRoom(state, other, b, async (req) => {
		messages.push(req);
	});
	t.after(async () => {
		await Promise.all([author.close(), reader.close()]);
		await service?.close();
		await rm(base, { recursive: true, force: true });
	});
	assert.equal(await author.command("sample.ts"), `Opened Editor for ${root}.`);
	assert.ok(api);
	assert.equal((await fetch(api, { method: "POST" })).status, 403);
	assert.deepEqual((await (await pane({ op: "members" })).json()).members, [a]);
	assert.deepEqual(await author.tool({ op: "files" }), { files: ["sample.ts"], limited: false });
	for (const op of ["rename", "remove", "mkdir", "copy"]) {
		await assert.rejects(author.tool({ op }), /Unknown editor action/);
	}
	assert.equal((await pane({ op: "mkdir", path: "src" })).status, 200);
	assert.equal((await stat(join(root, "src"))).isDirectory(), true);
	await reader.tool({ op: "join", root });
	assert.deepEqual(
		new Set((await (await pane({ op: "members" })).json()).members.map((m: Participant) => m.id)),
		new Set([a.id, b.id]),
	);
	const file = await (await pane({ op: "read", doc: "sample.ts" })).json();
	const changed = await (
		await pane({ op: "patch", doc: file.doc, rev: file.rev, start: 21, end: 22, text: "2" })
	).json();
	assert.equal(changed.rev, file.rev + 1);
	const found = await (await pane({ op: "search", kind: "text", query: "count = 2" })).json();
	assert.equal(found.hits[0].draft, true);
	const note = await (await pane({ op: "note", target: { kind: "folder", key: "" }, text: "Map this folder" })).json();
	assert.equal((await pane({ op: "send", id: note.id, to: b.id, message: "Map this folder" })).status, 200);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].thread, note.id);
	assert.deepEqual(messages[0].target, { kind: "folder", key: "" });
	const read = await reader.tool({ op: "read", doc: file.doc, root });
	assert.match(String(read.text), /= 2;/);
	await reader.tool({ op: "edit", doc: file.doc, rev: read.rev, find: "2;", replace: "3;", root });
	assert.equal((await pane({ op: "save", doc: file.doc, rev: changed.rev })).status, 409);
	assert.match(await readFile(join(root, file.doc), "utf8"), /= 1;/);
	const map = await reader.tool({
		op: "compose",
		root,
		title: "Code map",
		blocks: [{ kind: "location", text: "Count", doc: file.doc, line: 1 }],
	});
	await reader.tool({ op: "reply", root, id: note.id, text: "See the Code map tab." });
	const shared = await (await pane({ op: "state" })).json();
	assert.equal(shared.views[0].id, map.id);
	const final = await (await pane({ op: "read", doc: file.doc })).json();
	assert.match(final.text, /= 3;/);
	assert.equal((await pane({ op: "save", doc: file.doc, rev: final.rev })).status, 200);
	assert.match(await readFile(join(root, file.doc), "utf8"), /= 3;/);
	await reader.close();
	assert.deepEqual((await (await pane({ op: "members" })).json()).members, [a]);
});

test("pane file receipts report the save encoding and discard draft-only documents", async (t) => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "editor-format-")));
	const root = join(base, "project");
	const state = join(base, "state");
	const doc = "line.txt";
	const file = join(root, doc);
	await Promise.all([mkdir(root), mkdir(state, { mode: 0o700 })]);
	await writeFile(file, "\uFEFFline\r\n");
	let endpoint: string;
	let token: string;
	let service: Awaited<ReturnType<typeof startPaneService>> | undefined;
	const request = (op: string, fields: Record<string, unknown> = {}) =>
		fetch(endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ op, ...fields }),
		});
	const pane = async (op: string, fields?: Record<string, unknown>) => {
		const response = await request(op, fields);
		const receipt = await response.json();
		assert.equal(response.status, 200, JSON.stringify(receipt));
		return receipt;
	};
	const room = new EditorRoom(
		state,
		root,
		{ id: "ordinary:a", kind: "ordinary", label: "Pi" },
		async () => {},
		async () => async (_root, path) => {
			const ticket = JSON.parse(await readFile(path, "utf8"));
			service = await startPaneService(paneConfig({ ...ticket, appPid: process.pid }));
			endpoint = `http://127.0.0.1:${service.port}/api`;
			token = service.token;
			await pane("loaded");
			await pane("visibility", { visible: true });
			return { blockId: "format-test" };
		},
	);
	t.after(async () => {
		await room.close();
		await service?.close();
		await rm(base, { recursive: true, force: true });
	});
	await room.command("");
	const read = await pane("read", { doc });
	assert.deepEqual(read, {
		doc,
		rev: 1,
		author: "Disk",
		dirty: false,
		title: doc,
		text: "line\n",
		eol: "\r\n",
		bom: true,
	});
	const patched = await pane("patch", { doc, rev: read.rev, start: 0, end: 1, text: "L" });
	const saved = await pane("save", { doc, rev: patched.rev });
	assert.equal(saved.eol, "\r\n");
	assert.equal(saved.bom, true);
	assert.equal(await readFile(file, "utf8"), "\uFEFFLine\r\n");
	await writeFile(file, "Line\r");
	assert.deepEqual(await pane("read", { doc, ifRev: saved.rev }), {
		doc,
		rev: saved.rev,
		dirty: false,
		author: "You",
		unchanged: true,
		eol: "\r",
		bom: false,
	});
	const dirty = await pane("patch", { doc, rev: saved.rev, start: 0, end: 1, text: "X" });
	await writeFile(file, "different\n");
	const dirtyRead = await pane("read", { doc, ifRev: dirty.rev });
	assert.equal(dirtyRead.eol, "\r");
	assert.equal(dirtyRead.bom, false);
	assert.equal(dirtyRead.diskChanged, true);
	const restored = await pane("revert", { doc, rev: dirty.rev });
	assert.deepEqual(restored, {
		doc,
		title: doc,
		rev: dirty.rev + 1,
		dirty: false,
		text: "different\n",
		eol: "\n",
		bom: false,
	});
	const cleanSave = await pane("save", { doc, rev: restored.rev });
	assert.deepEqual(cleanSave, restored);
	const destination = "destination.txt";
	const target = join(root, destination);
	await writeFile(target, "old contents\n");
	const replace = signature(await stat(target, { bigint: true }));
	const choice = { doc, rev: restored.rev, path: destination, replace };
	await assert.rejects(room.tool({ op: "save", ...choice }), /requires approval/);
	assert.equal((await pane("save", choice)).doc, destination);
	assert.equal(await readFile(target, "utf8"), "different\n");
	for (const result of [
		await room.tool({ op: "read", doc }),
		await room.tool({ op: "revert", doc, rev: restored.rev }),
	]) {
		assert.equal("eol" in result, false);
		assert.equal("bom" in result, false);
	}

	const named = await pane("new", { path: "named.txt" });
	assert.equal(named.eol, "\n");
	assert.equal(named.bom, false);
	assert.deepEqual(await pane("revert", { doc: named.doc, rev: named.rev }), { doc: named.doc, discarded: true });
	const scratch = await pane("new");
	assert.equal("eol" in scratch, false);
	assert.equal("bom" in scratch, false);
	const scratchEdit = await pane("patch", { doc: scratch.doc, rev: scratch.rev, start: 0, end: 0, text: "idea" });
	assert.deepEqual(await pane("read", { doc: scratch.doc, ifRev: scratchEdit.rev }), {
		doc: scratch.doc,
		rev: scratchEdit.rev,
		dirty: true,
		author: "You",
		unchanged: true,
	});
	const note = await pane("note", { doc: scratch.doc, rev: scratchEdit.rev, start: 0, end: 4, text: "Posted note" });
	assert.equal((await request("revert", { doc: scratch.doc, rev: scratch.rev })).status, 409);
	await assert.rejects(room.tool({ op: "revert", doc: scratch.doc, rev: scratchEdit.rev }), /no disk file/);
	assert.deepEqual(await pane("revert", { doc: scratch.doc, rev: scratchEdit.rev }), {
		doc: scratch.doc,
		discarded: true,
	});
	assert.equal((await (await request("read", { doc: scratch.doc })).json()).code, "not_found");
	const posted = await pane("thread", { id: note.id });
	assert.deepEqual(posted.target, { kind: "tab", key: scratch.doc });
	assert.equal(posted.quote, "idea");
});

test("the command reuses the best live pane without opening another split", async (t) => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "editor-hidden-")));
	const root = join(base, "project"),
		state = join(base, "state");
	await Promise.all([mkdir(root), mkdir(state, { mode: 0o700 })]);
	const file = "file.txt";
	await writeFile(join(root, file), "This file opens in the attached pane.\n");
	const services: Awaited<ReturnType<typeof startPaneService>>[] = [];
	const opener = { id: "ordinary:opener", kind: "ordinary", label: "Opener" } as const;
	const actor = { id: "ordinary:next", kind: "ordinary", label: "Next" } as const;
	const room = new EditorRoom(
		state,
		root,
		actor,
		async () => {},
		async () => {
			throw Error("Do not prepare another split while a pane is live.");
		},
	);
	t.after(async () => {
		await room.close();
		await Promise.all(services.map((service) => service.close()));
		await rm(base, { recursive: true, force: true });
	});
	let now = Date.now();
	t.mock.method(Date, "now", () => ++now);

	async function pane() {
		const service = await startPaneService(
			paneConfig({ root, agentDir: state, paneId: randomUUID(), appPid: process.pid, participant: opener }),
		);
		services.push(service);
		async function call(input: Record<string, unknown>) {
			const response = await fetch(`http://127.0.0.1:${service.port}/api`, {
				method: "POST",
				headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json" },
				body: JSON.stringify(input),
				signal: AbortSignal.timeout(2000),
			});
			assert.equal(response.status, 200);
			return response.json();
		}
		await call({ op: "loaded" });
		return call;
	}

	const older = await pane();
	await assert.rejects(room.command(file), /open but did not answer/);
	await older({ op: "events", since: 0 });
	const newer = await pane();
	const { cursor } = await newer({ op: "events", since: 0 });
	assert.equal(await room.command(file), `Connected to Editor for ${root} in another tab.`);
	const result = await newer({ op: "events", since: cursor });
	assert.ok(result.events.some((event: Record<string, unknown>) => event.type === "attach" && event.doc === file));
	assert.equal((await older({ op: "state" })).currentSession, null);

	await newer({ op: "visibility", visible: true });
	await older({ op: "visibility", visible: true });
	await older({ op: "visibility", visible: false });
	const visible = await newer({ op: "events", since: 0 });
	assert.equal(await room.command(file), `Connected to Editor for ${root}.`);
	assert.ok(
		(await newer({ op: "events", since: visible.cursor })).events.some(
			(event: Record<string, unknown>) => event.type === "attach",
		),
	);

	await newer({ op: "visibility", visible: false });
	const latestVisible = await older({ op: "events", since: 0 });
	assert.equal(await room.command(file), `Connected to Editor for ${root} in another tab.`);
	assert.ok(
		(await older({ op: "events", since: latestVisible.cursor })).events.some(
			(event: Record<string, unknown>) => event.type === "attach",
		),
	);
});

test("a split that never starts its app loses its launch ticket", async (t) => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "editor-unopened-")));
	const root = join(base, "root"),
		state = join(base, "state");
	await Promise.all([mkdir(root), mkdir(state, { mode: 0o700 })]);
	let request: string | undefined;
	const room = new EditorRoom(
		state,
		root,
		{ id: "ordinary:a", kind: "ordinary", label: "Pi" },
		async () => {},
		async () => async (_root, path) => {
			request = path;
			throw Error("Unconfirmed split");
		},
	);
	t.after(async () => {
		await room.close();
		await rm(base, { recursive: true, force: true });
	});
	await assert.rejects(room.command(""), /Unconfirmed split/);
	assert.ok(request);
	await assert.rejects(stat(request), { code: "ENOENT" });
});

test("the command reports and removes a private startup failure from the app", async (t) => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "editor-startup-")));
	const root = join(base, "project"),
		state = join(base, "agent");
	await Promise.all([mkdir(root), mkdir(state, { mode: 0o700 })]);
	let failure: string | undefined;
	const room = new EditorRoom(
		state,
		root,
		{ id: "ordinary:a", label: "Pi", kind: "ordinary" },
		async () => {},
		async () => async (_root, path) => {
			failure = `${path}.failure`;
			await writeFile(failure, "The Editor service exited with status 2.\n", { flag: "wx", mode: 0o600 });
			return { blockId: "failed-app" };
		},
	);
	t.after(async () => {
		await room.close();
		await rm(base, { recursive: true, force: true });
	});
	await assert.rejects(room.command(""), /Editor service exited with status 2/);
	assert.ok(failure);
	await assert.rejects(stat(failure), { code: "ENOENT" });
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
