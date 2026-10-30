import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { DashboardRelations, relatedWork, relationSeeds, relationIdentity } from "./dashboard-relations.ts";
import { fixture, source, row, turn, theme, deferred, page as rosterPage, conversationFrame } from "./dashboard-test-fixture.mts";
import type { CollaborationPage } from "./collaboration.ts";

const ordinary = "11111111-1111-1111-1111-111111111111";
const storage = "22222222-2222-2222-2222-222222222222";
const peer = "33333333-3333-3333-3333-333333333333:2";
const other = "44444444-4444-4444-4444-444444444444";
function thread(id = `${storage}/abcdef`, members = [storage, peer]): CollaborationPage {
	return { thread: { id, title: "Review current work", purpose: "Read the useful result", authority: "Operator request", source: "Brief", restrictions: "No live changes", acceptance: "Open a participant", integrator: storage, creator: storage, revision: 1, sequence: 20, closed: false, createdAt: 1, updatedAt: 20,
		members: members.map((identity) => ({ identity, contribution: `Work by ${identity}`, joinedAt: 1 })) },
		events: Array.from({ length: 20 }, (_, i) => ({ threadId: id, sequence: i + 1, at: i + 1, sender: peer, origin: "model" as const, kind: "contribution", message: `Exchange message ${i + 1}`, source: "", replyTo: null, revision: 1, notify: [] })), nextBefore: null, pending: 0, coverage: { complete: true, bytes: 1000 } };
}
function discovery(pages: CollaborationPage[]) {
	return { items: pages.map(({ thread: t }) => ({ id: t.id, title: t.title, purpose: t.purpose, updatedAt: t.updatedAt, closed: false, members: t.members.length })), nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } };
}
const rows = () => [row(storage, { storageId: storage, creatingOwnerId: ordinary, name: "Builder" }), row(peer, { storageId: peer.split(":")[0], creatingOwnerId: other, name: "Peer" }), row(other, { storageId: other, name: "Unrelated" })];
const shown = (f: ReturnType<typeof fixture>) => stripVTControlCharacters(f.ui.render(f.tui.terminal.columns).join("\n"));

it("ordinary caller joins ownership and exact admissions, not shared cwd or unknown ownership", () => {
	const values = [...rows(), row("grandchild", { storageId: "grandchild", creatingOwnerId: storage }), row("target", { storageId: "target", creatingOwnerId: other }), row("unknown", { creatingOwnerId: undefined })];
	const seeds = relationSeeds(values, ordinary, ["target"]);
	assert.deepEqual([...seeds].sort(), [ordinary, storage, "grandchild", "target"].sort());
	const related = relatedWork(seeds, [thread(), thread("unrelated-thread", [peer, other])]);
	assert.equal(related.identities.has(peer), true);
	assert.equal(related.identities.has(other), false);
	assert.deepEqual(related.threads.map((item) => item.id), [`${storage}/abcdef`]);
});
for (const caller of [storage, `${storage}:1`, `${storage}:2`]) it(`native caller ${caller} excludes independent conversations in its storage`, () => {
	const values = [...rows(), row(`${storage}:2`, { storageId: storage, creatingOwnerId: ordinary }), row(`${storage}:20`, { storageId: storage, creatingOwnerId: ordinary })];
	const seeds = relationSeeds(values, caller);
	assert.deepEqual([...seeds], [relationIdentity(caller)]);
	assert.equal(relationIdentity(`${storage}:1`), storage);
	assert.notEqual(relationIdentity(`${storage}:2`), storage);
	assert.equal(relationSeeds(values, ordinary).has(`${storage}:2`), false);
});
it("exact nonroot ownership and fork ancestry connect work without joining an independent sibling", () => {
	const values = [...rows(), row(`${storage}:2`, { storageId: storage }), row(`${storage}:3`, { storageId: storage }), row(`${storage}:4`, { storageId: storage })];
	const lineage: NonNullable<Parameters<typeof relationSeeds>[3]> = [
		{ identity: `${storage}:2`, conversationId: 2 as ConversationId, owner: `${storage}:1`, busy: false },
		{ identity: `${storage}:3`, conversationId: 3 as ConversationId, forkSource: { conversationId: 2 as ConversationId, at: 1 as EntryId }, busy: false },
		{ identity: `${storage}:4`, conversationId: 4 as ConversationId, owner: other, busy: false },
	];
	const seeds = relationSeeds(values, `${storage}:1`, [], lineage);
	assert.equal(seeds.has(`${storage}:2`), true);
	assert.equal(seeds.has(`${storage}:3`), true);
	assert.equal(seeds.has(`${storage}:4`), false);
	const childSeeds = relationSeeds(values, `${storage}:2`, [], lineage);
	assert.equal(childSeeds.has(storage), true);
	assert.equal(childSeeds.has(`${storage}:3`), true);
	assert.equal(childSeeds.has(`${storage}:4`), false);
});
it("creation traversal stops after its bound and cycles do not add unrelated rows", () => {
	const values = Array.from({ length: 12 }, (_, i) => row(`child${i}`, { storageId: `child${i}`, creatingOwnerId: i ? `child${i - 1}` : ordinary }));
	values.push(row("loopA", { creatingOwnerId: "loopB" }), row("loopB", { creatingOwnerId: "loopA" }));
	const seeds = relationSeeds(values, ordinary);
	assert.equal(seeds.has("child7"), true);
	assert.equal(seeds.has("child8"), false);
	assert.equal(seeds.has("loopA"), false);
});
for (const kind of ["owner", "fork"] as const) it(`native ${kind} ancestry reports its depth boundary as partial`, async () => {
	const values = [row(storage, { storageId: storage }), ...Array.from({ length: 10 }, (_, i) => row(`${storage}:${i + 2}`, { storageId: storage }))];
	const index = new DashboardRelations(async () => discovery([]), () => {}, async (id) => {
		const number = Number(id.split(":")[1]);
		return { conversation: { identity: id, conversationId: number, busy: false,
			...(kind === "owner" ? { owner: number === 2 ? storage : `${storage}:${number - 1}` } : { forkSource: { conversationId: number - 1, at: 1 } }) } };
	});
	index.set(values, storage);
	await index.refresh();
	assert.equal(index.view().identities.has(`${storage}:9`), true);
	assert.equal(index.view().identities.has(`${storage}:10`), false);
	assert.equal(index.view().partial, true);
	index.dispose();
});
it("membership reads are bounded, cached and refreshed only from public pages", async () => {
	const pages = Array.from({ length: 24 }, (_, i) => thread(`thread-${i}`));
	const calls: Record<string, unknown>[] = [];
	const index = new DashboardRelations(async (input) => {
		calls.push(input);
		return input.action === "list" ? discovery(pages) : pages.find((page) => page.thread.id === input.threadId);
	}, () => {});
	index.set(rows(), ordinary);
	await index.refresh();
	assert.equal(calls.filter((input) => input.action === "read").length, 20);
	assert.equal(calls.every((input) => input.action !== "read" || input.limit === 1), true);
	assert.equal(index.view().partial, true);
	assert.equal(index.view().identities.has(peer), true);
	await index.refresh();
	assert.equal(calls.filter((input) => input.action === "read").length, 20);
	index.dispose();
});
it("catalogue invalidation refreshes membership when summary timestamps and counts repeat", async () => {
	let current = thread();
	let reads = 0;
	const index = new DashboardRelations(async (input) => {
		if (input.action === "list") return discovery([current]);
		reads++;
		return structuredClone(current);
	}, () => {});
	index.set(rows(), ordinary);
	await index.refresh();
	assert.equal(index.view().identities.has(peer), true);
	current = thread(`${storage}/abcdef`, [storage, other]);
	await index.refresh();
	assert.equal(reads, 1);
	index.invalidate();
	await index.refresh();
	assert.equal(reads, 2);
	assert.equal(index.view().identities.has(peer), false);
	assert.equal(index.view().identities.has(other), true);
	index.dispose();
});
it("failed membership reads do not invent relations or retain removed membership", async () => {
	let failed = false;
	const index = new DashboardRelations(async (input) => {
		if (failed) throw new Error("Unavailable");
		return input.action === "list" ? discovery([thread()]) : thread();
	}, () => {});
	index.set(rows(), ordinary);
	await index.refresh();
	assert.equal(index.view().identities.has(peer), true);
	failed = true;
	await index.refresh();
	assert.equal(index.view().identities.has(peer), false);
	assert.equal(index.view().partial, true);
	index.dispose();
});
it("dispose fences a late relation read and never requests another paint", async () => {
	const wait = deferred<unknown>();
	let paints = 0;
	const index = new DashboardRelations(() => wait.promise, () => paints++);
	index.set(rows(), ordinary);
	const pending = index.refresh();
	index.dispose();
	const before = paints;
	wait.resolve(discovery([thread()]));
	await pending;
	assert.equal(paints, before);
});
for (const [width, height] of [[80, 24], [140, 45]]) it(`Related, All, thread, participant and back work at ${width} columns`, async () => {
	const current = thread();
	const f = fixture(width, height, source(rows()), { collaborate: async (input) => input.action === "list" ? discovery([current]) : current }, undefined, theme, ordinary);
	try {
		await turn();
		assert.match(shown(f), /Agents > Related/);
		assert.equal(f.state.selected === other, false);
		assert.doesNotMatch(shown(f), /Unrelated/);
		f.ui.handleInput("v");
		assert.match(shown(f), /Agents > All/);
		assert.match(shown(f), /Unrelated/);
		f.ui.handleInput("v");
		f.ui.handleInput("t"); await turn();
		assert.match(shown(f), /Related threads/);
		f.ui.handleInput("\r"); await turn();
		assert.match(shown(f), /Purpose: Read the useful result/);
		f.ui.handleInput("e");
		assert.match(shown(f), /Exchange message 20/);
		f.ui.handleInput("m");
		f.ui.handleInput("\x1b[B");
		f.ui.handleInput("\r"); await turn();
		assert.equal(f.ui.navigation.screen, "console");
		assert.equal(f.state.selected, peer);
		f.ui.handleInput("\x1b");
		assert.match(shown(f), /Participants/);
		f.ui.handleInput("\x1b");
		assert.match(shown(f), /Exchange message 20/);
		f.ui.handleInput("\x1b");
		assert.match(shown(f), /Related threads/);
		f.ui.handleInput("\x1b");
		assert.equal(f.ui.navigation.screen, "roster");
	} finally { f.ui.dispose(); }
});
it("alias participants retain canonical selection through roster refresh and live recovery", { timeout: 5000 }, async () => {
	const current = thread(`${storage}/abcdef`, [`${storage}:1`, peer]);
	let currentRows = rows();
	const observed = source(currentRows);
	let rosterChanged = () => {};
	let frameChanged = () => {};
	let availability: "unavailable" | "live" = "unavailable";
	let live: ReturnType<typeof conversationFrame> | undefined;
	const selected: Array<string | undefined> = [];
	const snapshots: string[] = [];
	const refreshed = deferred<string>();
	observed.list = async () => rosterPage(currentRows);
	observed.subscribeRoster = (listener) => { rosterChanged = listener; return () => {}; };
	observed.subscribe = (listener) => { frameChanged = listener; return () => {}; };
	observed.select = (id) => { selected.push(id); };
	observed.refresh = (id) => { refreshed.resolve(id); };
	observed.availability = () => ({ state: availability, at: new Date(0).toISOString() });
	observed.frame = (id) => id === storage ? live : undefined;
	const snapshot = observed.snapshot;
	observed.snapshot = async (id) => { snapshots.push(id); return snapshot(id); };
	const f = fixture(100, 30, observed, { collaborate: async (input) => input.action === "list" ? discovery([current]) : current }, undefined, theme, ordinary);
	try {
		await turn();
		f.ui.handleInput("t"); await turn();
		f.ui.handleInput("\r"); await turn();
		f.ui.handleInput("m");
		f.ui.handleInput("\r"); await turn();
		assert.equal(f.state.selected, storage);
		assert.equal(f.ui.navigation.target, storage);
		assert.equal(selected.at(-1), storage);
		const reads = snapshots.length;
		currentRows = currentRows.map((item) => item.id === storage ? { ...item, modifiedAt: 1, state: "idle" as const, name: "Refreshed root" } : item);
		rosterChanged();
		assert.equal(await refreshed.promise, storage);
		await turn();
		assert.equal(snapshots.length > reads, true);
		assert.equal(snapshots.at(-1), storage);
		assert.equal(shown(f).includes("Refreshed root"), true);
		const initial = conversationFrame();
		live = conversationFrame({ storageId: storage, status: { ...initial.status, identity: storage, name: "Live root", busy: false },
			entries: [{ id: "2", kind: "pi.user", model: [{ role: "user", content: "Recovered live conversation", timestamp: 1 }] }] });
		availability = "live";
		frameChanged();
		assert.equal(f.state.selected, storage);
		assert.equal(f.ui.navigation.target, storage);
		assert.equal(shown(f).includes("Recovered live conversation"), true);
		assert.equal(shown(f).includes("Conversation unavailable"), false);
	} finally { f.ui.dispose(); }
});
it("unknown participants retain their exact read error", async () => {
	const missing = "55555555-5555-5555-5555-555555555555:1";
	const current = thread(`${storage}/abcdef`, [missing, storage]);
	const observed = source(rows());
	const snapshot = observed.snapshot;
	observed.snapshot = async (id) => {
		if (id === missing) throw new Error("Participant storage is unreadable");
		return snapshot(id);
	};
	const f = fixture(100, 30, observed, { collaborate: async (input) => input.action === "list" ? discovery([current]) : current }, undefined, theme, ordinary);
	try {
		await turn();
		f.ui.handleInput("t"); await turn();
		f.ui.handleInput("\r"); await turn();
		f.ui.handleInput("m");
		f.ui.handleInput("\r"); await turn();
		assert.equal(f.state.selected, missing);
		assert.equal(f.ui.navigation.target, missing);
		assert.equal(shown(f).includes("Participant storage is unreadable"), true);
	} finally { f.ui.dispose(); }
});
it("empty and failed relation evidence keep All and Threads reachable", async () => {
	const f = fixture(80, 24, source([row(other, { storageId: other, creatingOwnerId: undefined })]), { collaborate: async () => { throw new Error("Unreadable"); } }, undefined, theme, ordinary);
	try {
		await turn();
		assert.match(shown(f), /No related agents/);
		assert.match(shown(f), /v all/);
		f.ui.handleInput("v");
		assert.equal(f.state.selected, other);
		f.ui.handleInput("t"); await turn();
		assert.match(shown(f), /Threads unavailable/);
		f.ui.handleInput("\x1b");
		assert.equal(f.ui.navigation.screen, "roster");
	} finally { f.ui.dispose(); }
});
