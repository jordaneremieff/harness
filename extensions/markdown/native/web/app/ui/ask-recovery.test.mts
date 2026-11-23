import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { plain, scripts } from "../../test/load.mts";

const { reader } = scripts(["app/ui/ask-recovery.ts"], { reader: {} });
const draft = (overall: string): ReaderReviewDraft => ({ comments: [], overall });
const saved = (version: number, draft?: ReaderReviewDraft) => ({ available: true, version, draft });
const stored = (version: number) => ({ status: "stored", version });
type Owner = { documentKey: string; packet?: ReaderReviewDraft };
function fixture() {
	const owner: Owner = { documentKey: "first" },
		other: Owner = { documentKey: "second" };
	const calls: { type: string; fields?: Record<string, unknown>; reply: (value: unknown) => void }[] = [];
	const warnings = new Map<Owner, { label: string; run(): void }>();
	const recovery = reader.createAskRecovery<Owner>(
		{
			request: (type, fields) =>
				new Promise((resolve) => {
					calls.push({ type, fields, reply: resolve });
				}),
		},
		{
			snapshot: (o) => structuredClone(o.packet),
			apply(o, packet) {
				o.packet = packet;
			},
			warn(o, _text, action) {
				warnings.set(o, action);
			},
			clear(o) {
				warnings.delete(o);
			},
		},
	);
	async function reply(type: string, expected: Record<string, unknown>, answer: unknown) {
		await setImmediate();
		const call = calls.shift();
		assert.ok(call);
		assert.equal(call.type, type);
		assert.deepEqual(plain(call.fields), expected);
		call.reply(answer);
	}
	const query = (o: Owner, answer: unknown) =>
		reply("query", { kind: "reviewDraft", documentKey: o.documentKey }, answer);
	const write = (o: Owner, base: number, packet: ReaderReviewDraft | undefined, answer: unknown) =>
		reply(
			"command",
			{
				name: "setReviewDraft",
				args: { documentKey: o.documentKey, expectedVersion: base, ...(packet ? { draft: packet } : {}) },
			},
			answer,
		);
	const open = async (o: Owner, answer: unknown) => {
		const p = recovery.open(o);
		await query(o, answer);
		await p;
	};
	const edit = (o: Owner, packet: ReaderReviewDraft | undefined) => {
		o.packet = packet;
		recovery.changed(o);
	};
	const warning = (o: Owner) => {
		const w = warnings.get(o);
		assert.ok(w);
		return w;
	};
	const idle = async () => {
		await setImmediate();
		assert.deepEqual(calls, []);
	};
	return { owner, other, calls, recovery, warnings, warning, write, query, open, edit, idle };
}

test("a repeated show shares its read; active and parked material belong to the original owner even offscreen", async () => {
	const { owner, other, recovery, query, idle } = fixture();
	const a = recovery.open(owner),
		b = recovery.open(owner),
		c = recovery.open(other);
	const packet: ReaderReviewDraft = {
		comments: [{ text: "first", quote: "passage" }],
		overall: "intro",
		overallRevision: 3,
		parked: [{ text: "later", index: 0, authoredRevision: 2 }],
	};
	await query(owner, saved(4, packet));
	await query(other, saved(0));
	await Promise.all([a, b, c]);
	assert.deepEqual(owner.packet, packet);
	assert.equal(other.packet, undefined);
	await recovery.open(owner);
	await idle();
});

test("coalesced edits use the original owner's latest text even after navigation", async () => {
	const { owner, other, open, edit, write, idle, recovery } = fixture();
	await open(other, saved(0));
	await open(owner, saved(4));
	const first = draft("first");
	edit(owner, first);
	await setImmediate();
	edit(owner, draft("second"));
	const last = draft("last");
	edit(owner, last);
	await recovery.open(other);
	await write(owner, 4, first, stored(5));
	await write(owner, 5, last, stored(6));
	await idle();
});

test("one save runs at a time; a consume supersedes queued saves and leaves parked material", async () => {
	const { owner, recovery, open, edit, write, idle } = fixture();
	await open(owner, saved(0));
	const first = draft("first");
	edit(owner, first);
	await setImmediate();
	edit(owner, draft("second"));
	edit(owner, draft("third"));
	const remaining = { ...draft(""), parked: [{ text: "parked", index: 1 }] };
	let count = 0;
	const consume = recovery.prepare(
		owner,
		remaining,
		() => true,
		() => {
			count++;
			owner.packet = remaining;
		},
	);
	assert.equal(
		await recovery.prepare(
			owner,
			undefined,
			() => true,
			() => assert.fail(),
		),
		false,
	);
	await write(owner, 0, first, stored(1));
	await write(owner, 1, remaining, stored(2));
	assert.equal(await consume, true);
	assert.equal(count, 1);
	await idle();
	const fresh = draft("written while waiting for delivery");
	edit(owner, fresh);
	await write(owner, 2, fresh, stored(3));
	await idle();
});

test("an edit while a consume is outstanding cancels dispatch and saves the actual batch against the tombstone", async () => {
	const { owner, recovery, open, edit, write, idle } = fixture();
	await open(owner, saved(4, draft("old")));
	const p = recovery.prepare(
		owner,
		undefined,
		() => true,
		() => assert.fail(),
	);
	await setImmediate();
	const changed = draft("changed");
	edit(owner, changed);
	await write(owner, 4, undefined, stored(5));
	assert.equal(await p, false);
	await write(owner, 5, changed, stored(6));
	await idle();
});

test("navigation away and back invalidates a consume even when its captured selection still matches", async () => {
	const { owner, other, recovery, open, write, idle } = fixture();
	const initial = draft("mine");
	await open(other, saved(0));
	await open(owner, saved(3, initial));
	const p = recovery.prepare(
		owner,
		undefined,
		() => true,
		() => assert.fail(),
	);
	await setImmediate();
	await recovery.open(other);
	await recovery.open(owner);
	await write(owner, 3, undefined, stored(4));
	assert.equal(await p, false);
	await write(owner, 4, initial, stored(5));
	await idle();
});

test("a stale owner cannot send or save until the user explicitly adopts the latest saved batch", async () => {
	const { owner, recovery, open, edit, write, warning, warnings, query, idle } = fixture();
	await open(owner, saved(1, draft("shared")));
	const local = draft("changed here");
	edit(owner, local);
	await write(owner, 1, local, { status: "stale", version: 3 });
	await idle();
	assert.equal(
		await recovery.prepare(
			owner,
			undefined,
			() => true,
			() => assert.fail(),
		),
		false,
	);
	assert.deepEqual(owner.packet, local);
	const replace = warning(owner);
	assert.match(replace.label, /Replace local/);
	replace.run();
	edit(owner, draft("edited during read"));
	await query(owner, saved(4));
	await idle();
	assert.equal(owner.packet?.overall, "edited during read");
	replace.run();
	await idle();
	warning(owner).run();
	await query(owner, saved(5));
	await idle();
	assert.equal(owner.packet, undefined);
	assert.equal(warnings.size, 0);
	const fresh = draft("new batch");
	edit(owner, fresh);
	await write(owner, 5, fresh, stored(6));
	await idle();
});

test("an unconfirmed consume never dispatches; version drift requires explicit adoption, even for an empty saved batch", async () => {
	const { owner, recovery, open, write, warning, query, idle } = fixture();
	const text = draft("local");
	await open(owner, saved(1, text));
	const p = recovery.prepare(
		owner,
		undefined,
		() => true,
		() => assert.fail(),
	);
	await write(owner, 1, undefined, null);
	assert.equal(await p, false);
	assert.match(warning(owner).label, /Check saved/);
	warning(owner).run();
	await query(owner, saved(2));
	await idle();
	assert.deepEqual(owner.packet, text);
	assert.match(warning(owner).label, /Replace local/);
});

test("local-only behaviour requires explicit scope unavailability, not a failed read", async () => {
	const { owner, recovery, open, edit, warning, query, idle } = fixture();
	await open(owner, null);
	const local = draft("local");
	edit(owner, local);
	let count = 0;
	const send = () =>
		recovery.prepare(
			owner,
			undefined,
			() => true,
			() => {
				count++;
				owner.packet = undefined;
			},
		);
	assert.equal(await send(), false);
	await idle();
	warning(owner).run();
	await query(owner, { available: false, version: 0 });
	await idle();
	assert.deepEqual(owner.packet, local);
	assert.equal(await send(), true);
	assert.equal(count, 1);
	await idle();
});

test("close waits for a consume and its compensating save without initiating another action", async () => {
	const { owner, recovery, open, write, edit, idle } = fixture();
	assert.equal(await recovery.flush(), true);
	await open(owner, saved(1, draft("previous")));
	const consume = recovery.prepare(
		owner,
		undefined,
		() => true,
		() => assert.fail(),
	);
	let closed = false;
	const flush = recovery.flush().then((ok) => {
		closed = true;
		return ok;
	});
	await setImmediate();
	assert.equal(closed, false);
	const revised = draft("revised");
	edit(owner, revised);
	await write(owner, 1, undefined, stored(2));
	assert.equal(await consume, false);
	await setImmediate();
	assert.equal(closed, false);
	await write(owner, 2, revised, stored(3));
	assert.equal(await flush, true);
	await idle();
});

test("close reports unresolved writes in a hidden owner and never retries them", async () => {
	for (const result of [null, { status: "error" }, { status: "stale", version: 5 }]) {
		const { owner, other, recovery, open, write, edit, idle } = fixture();
		await open(other, saved(0));
		await open(owner, saved(2));
		const changed = draft("changed");
		edit(owner, changed);
		await recovery.open(other);
		const flush = recovery.flush();
		await write(owner, 2, changed, result);
		assert.equal(await flush, false);
		assert.equal(await recovery.flush(), false);
		await idle();
	}
});

test("a late first read cannot overwrite text composed since the pane opened", async () => {
	const { owner, recovery, query, edit, warning, idle } = fixture();
	const pending = recovery.open(owner);
	edit(owner, draft("just typed"));
	await query(owner, saved(8, draft("on disk")));
	await pending;
	assert.equal(owner.packet?.overall, "just typed");
	assert.match(warning(owner).label, /Replace local/);
	await idle();
});
