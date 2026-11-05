import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { CollaborationEvent, CollaborationPage, CollaborationSummary } from "./collaboration.ts";
import { fixture, row, source, turn } from "./dashboard-test-fixture.mts";

const thread = (id: string, patch: Partial<CollaborationSummary> = {}): CollaborationSummary => ({ id, title: `Thread ${id}`, purpose: `Purpose of ${id}`, updatedAt: 1_000, closed: false, members: 2, ...patch });

function event(sequence: number, patch: Partial<CollaborationEvent> = {}): CollaborationEvent {
	return { threadId: "t1", sequence, at: sequence * 1000, sender: "one", origin: "model", kind: "contribution", message: `Message ${sequence}`, source: "", replyTo: null, revision: 1, notify: [], ...patch };
}

function page(id: string, events: CollaborationEvent[], patch: Partial<CollaborationPage["thread"]> = {}, nextBefore: number | null = null): CollaborationPage {
	return {
		thread: {
			id,
			title: `Thread ${id}`,
			purpose: `Purpose of ${id}`,
			authority: "Operator direction",
			source: "Brief",
			restrictions: "None",
			acceptance: "Works",
			integrator: "one",
			creator: "one",
			revision: 1,
			sequence: events.at(-1)?.sequence ?? 0,
			closed: false,
			createdAt: 1,
			updatedAt: 2,
			members: [
				{ identity: "one", contribution: "Design", joinedAt: 1 },
				{ identity: "two", contribution: "Review", joinedAt: 1 },
			],
			...patch,
		},
		events,
		nextBefore,
		pending: 0,
		coverage: { complete: true, bytes: 100 },
	};
}

type Collaborate = (input: Record<string, unknown>) => Promise<unknown>;

function setup(collaborate: Collaborate, width = 140, height = 40) {
	const calls: Record<string, unknown>[] = [];
	const observed = source([row("one", { name: "Designer" }), row("two", { name: "Reviewer" })]);
	const f = fixture(width, height, observed, {
		collaborate: async (input) => {
			calls.push(input);
			return collaborate(input);
		},
	});
	const text = () => stripVTControlCharacters(f.ui.render(width).join("\n"));
	const click = (x: number, y: number) => f.ui.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
	return { ...f, calls, text, click, width, height };
}

const settle = async () => {
	for (let step = 0; step < 6; step++) await turn();
};

it("Threads reads every discovery page itself and lists open threads first, newest first", async () => {
	const pages: Record<string, { items: CollaborationSummary[]; nextCursor: string | null }> = {
		start: { items: [thread("old", { updatedAt: 1_000 })], nextCursor: "b" },
		b: { items: [], nextCursor: "c" },
		c: { items: [thread("new", { updatedAt: 3_000 }), thread("done", { updatedAt: 5_000, closed: true })], nextCursor: null },
	};
	const f = setup(async (input) => {
		if (input.action === "list") {
			const current = pages[(input.cursor as string | undefined) ?? "start"];
			return { ...current, coverage: { complete: current?.nextCursor === null, visited: 8, omitted: 0 } };
		}
		return page(String(input.threadId), [event(1)]);
	});
	await turn();
	f.ui.openNamedAction("threads");
	await settle();
	const lines = f.text().split("\n");
	assert.equal(f.calls.filter((call) => call.action === "list").length, 3, "no Load more: the view follows every cursor");
	const order = ["Thread new", "Thread old", "Thread done"].map((title) => lines.findIndex((line) => line.includes(title)));
	assert.ok(order.every((index) => index > 0), lines.join("\n"));
	assert.ok(order[0] < order[1] && order[1] < order[2], "open threads lead, newest first; closed threads follow");
	assert.match(f.text(), /Open 2/);
	assert.match(f.text(), /Closed 1/);
	assert.match(f.text(), /3 threads/);
});

it("selecting a thread shows its exchange with names, replies and who a post woke", async () => {
	const f = setup(async (input) => {
		if (input.action === "list") return { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } };
		return page("t1", [event(1, { sender: "two", message: "Challenge the boundary" }), event(2, { sender: "one", replyTo: 1, notify: ["two"], message: "Keep the restriction" })]);
	});
	await turn();
	f.ui.openNamedAction("threads");
	await settle();
	f.ui.handleInput("\u001b[B");
	await settle();
	const screen = f.text();
	assert.match(screen, /Thread t1 · Open · 2 members/);
	assert.match(screen, /Reviewer/);
	assert.match(screen, /Challenge the boundary/);
	assert.match(screen, /Designer ↳ Reviewer/, "a reply names the message it answers");
	assert.match(screen, /notified Reviewer/);
	assert.ok(f.calls.some((call) => call.action === "read" && call.threadId === "t1"));
});

it("a post goes once with the operator origin; an unconfirmed post keeps the draft and reuses its request ID", async () => {
	let fail = true;
	const f = setup(async (input) => {
		if (input.action === "list") return { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } };
		if (input.action === "read") return page("t1", [event(1)]);
		if (fail) {
			fail = false;
			throw new Error("connection lost");
		}
		return { threadId: "t1", sequence: 2, deduped: false };
	});
	await turn();
	f.ui.openNamedAction("threads");
	await settle();
	f.ui.handleInput("\u001b[B");
	await settle();
	f.ui.handleInput("\r");
	for (const char of "Ship it") f.ui.handleInput(char);
	f.ui.handleInput("\r");
	await settle();
	const posts = () => f.calls.filter((call) => call.action === "post");
	assert.equal(posts().length, 1);
	assert.equal(posts()[0]?.origin, "operator");
	assert.equal(posts()[0]?.message, "Ship it");
	assert.match(f.text(), /not confirmed/);
	assert.equal(f.state.threads?.drafts.get("t1")?.text, "Ship it", "the draft stays after an unconfirmed post");
	f.ui.handleInput("\r");
	await settle();
	assert.equal(posts().length, 2);
	assert.equal(posts()[1]?.requestId, posts()[0]?.requestId, "the retry of the same content reuses the request ID");
	assert.equal(f.state.threads?.drafts.get("t1")?.text, "", "a retained post clears its draft");
	assert.match(f.text(), /Posted\./);
});

it("a closed thread takes no posts", async () => {
	const f = setup(async (input) => {
		if (input.action === "list") return { items: [thread("t1", { closed: true })], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } };
		if (input.action === "read") return page("t1", [event(1)], { closed: true });
		throw new Error("no post expected");
	});
	await turn();
	f.ui.openNamedAction("threads");
	await settle();
	f.ui.handleInput("\u001b[B");
	await settle();
	f.ui.handleInput("\r");
	for (const char of "late") f.ui.handleInput(char);
	f.ui.handleInput("\r");
	await settle();
	assert.match(f.text(), /This thread is closed; posting is off\./);
	assert.equal(f.calls.filter((call) => call.action === "post").length, 0);
});

it("earlier messages load above the newer ones without losing them", async () => {
	const f = setup(async (input) => {
		if (input.action === "list") return { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } };
		if (input.before === 3) return page("t1", [event(1, { message: "First words" }), event(2, { message: "Second words" })]);
		return page("t1", [event(3, { message: "Third words" })], {}, 3);
	}, 140, 40);
	await turn();
	f.ui.openNamedAction("threads");
	await settle();
	f.ui.handleInput("\u001b[B");
	await settle();
	assert.match(f.text(), /↑ Earlier messages/);
	f.ui.handleInput("\t");
	f.ui.handleInput("\u001b[H");
	await settle();
	const screen = f.text();
	assert.ok(screen.indexOf("First words") < screen.indexOf("Third words"), "earlier messages sit above newer ones");
	assert.match(screen, /Start of the thread/);
});

it("thread text cannot emit terminal control sequences", async () => {
	const f = setup(async (input) => {
		if (input.action === "list") return { items: [thread("t1", { title: "Safe\u001b]0;title\u0007 title" })], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } };
		return page("t1", [event(1, { message: "Clear\u001b[2Jscreen\u001b]52;c;Y2xpcA==\u0007" })]);
	});
	await turn();
	f.ui.openNamedAction("threads");
	await settle();
	f.ui.handleInput("\u001b[B");
	await settle();
	const raw = f.ui.render(140).join("\n");
	assert.doesNotMatch(raw, /\u001b\]/, "no operating system command reaches the terminal");
	assert.doesNotMatch(raw, /\u001b\[2J/, "no screen clear reaches the terminal");
	assert.match(stripVTControlCharacters(raw), /Clear\s*screen/);
});

it("the tabs switch between agents and threads with one click", async () => {
	const f = setup(async (input) => (input.action === "list" ? { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } } : page("t1", [event(1)])));
	await turn();
	f.ui.render(f.width);
	const heading = () => f.text().split("\n")[0] ?? "";
	assert.match(heading(), /Agents\s+Threads/);
	f.click(heading().indexOf("Threads") + 1, 0);
	await settle();
	assert.match(f.text(), /1 thread/);
	f.click(heading().indexOf("Agents") + 1, 0);
	await settle();
	assert.doesNotMatch(f.text(), /1 thread/);
	assert.match(f.text(), /Designer/);
});
