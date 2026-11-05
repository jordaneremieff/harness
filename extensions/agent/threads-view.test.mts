import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { CollaborationEvent, CollaborationPage, CollaborationSummary } from "./collaboration.ts";
import { fixture, row, source, theme, turn } from "./dashboard-test-fixture.mts";
import { readingGeometry } from "./dashboard-layout.ts";

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

function setup(collaborate: Collaborate, width = 140, height = 40, paint: typeof theme = theme) {
	const calls: Record<string, unknown>[] = [];
	const observed = source([row("one", { name: "Designer" }), row("two", { name: "Reviewer" })]);
	const f = fixture(width, height, observed, {
		collaborate: async (input) => {
			calls.push(input);
			return collaborate(input);
		},
	}, undefined, paint);
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
	assert.ok(lines.findIndex((line) => line.includes("Thread new")) < lines.findIndex((line) => line.includes("Thread old")), "open threads lead, newest first");
	assert.doesNotMatch(f.text(), /^\s*Open \d+\s*$/m, "no Open section header");
	assert.doesNotMatch(f.text(), /Thread done/, "closed threads start collapsed");
	assert.match(f.text(), /▸ Closed · 1/);
	assert.equal((lines.at(-1) ?? "").trimEnd(), "↑↓ select · enter open · / find · m members · d details · ctrl+o open posts · tab focus · esc back", "the footer shows each key before its command, with the way out last");
	const left = lines.map((line) => line.split("│")[0] ?? line);
	const newest = left.findIndex((line) => line.includes("Thread new"));
	assert.match(left[newest + 1] ?? "", /Purpose of new/, "two content lines");
	assert.equal((left[newest + 2] ?? "").trim(), "", "one blank row between items");
	f.click(3, lines.findIndex((line) => line.includes("▸ Closed · 1")));
	await settle();
	assert.match(f.text(), /▾ Closed · 1/);
	assert.ok(f.text().indexOf("Thread done") > f.text().indexOf("Thread old"), "closed threads follow the open ones");
	assert.match(f.text(), /3 threads/);
});

it("selecting a thread shows its exchange with names, replies and who a post woke", async () => {
	const f = setup(async (input) => {
		if (input.action === "list") return { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } };
		return page("t1", [event(1, { sender: "two", message: "Challenge the boundary" }), event(2, { sender: "one", replyTo: 1, notify: ["two"], origin: "operator", message: "Keep the restriction" })]);
	});
	await turn();
	f.ui.openNamedAction("threads");
	await settle();
	f.ui.handleInput("\u001b[B");
	await settle();
	const screen = f.text();
	const rows = screen.split("\n");
	assert.match(rows[1] ?? "", /Thread t1/);
	assert.doesNotMatch(rows[1] ?? "", /Members|Details/, "the header holds no command cluster");
	assert.match(rows[2] ?? "", /Open · 2 members · 2 events/);
	assert.match(rows[3] ?? "", /Purpose of t1/, "the purpose follows the counts");
	assert.equal(rows[4]?.split("│")[1]?.trim(), "", "one blank row under the header");
	assert.match(rows.at(-1) ?? "", /m members · d details · ctrl\+o open posts · tab focus · esc back/, "the header's commands now sit in the footer");
	assert.match(screen, /Reviewer/);
	assert.match(screen, /Challenge the boundary/);
	const replyLine = rows.find((line) => line.includes("↳ Reviewer"));
	assert.ok(replyLine, "a reply names the message it answers");
	assert.match(replyLine, /Designer\s+·\s+integrator\s+·\s+#2\s+·\s+↳ Reviewer #1\s+·\s+operator/, "the header carries the sender role, post number, reply target and origin");
	assert.match(screen, /notified Reviewer/);
	const first = rows.findIndex((line) => line.includes("Challenge the boundary"));
	const second = rows.findIndex((line) => line.includes("Keep the restriction"));
	const between = rows.slice(first, second).map((line) => line.split("│")[1]?.trim() ?? "");
	assert.ok(between.includes(""), "one blank row between posts");
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
	assert.match(f.text(), /↑ 2 earlier events · click or Home reads them/);
	assert.match(f.text(), /latest 1 of 3 events/, "a partial exchange count stays distinct");
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

it("the closed disclosure toggles by Enter and a direct selection reveals the group", async () => {
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("open", { updatedAt: 2_000 }), thread("done", { updatedAt: 1_000, closed: true })], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page(String(input.threadId), [event(1)]));
	await turn(); f.ui.openNamedAction("threads"); await settle();
	assert.doesNotMatch(f.text(), /Thread done/);
	assert.match(f.text(), /▸ Closed · 1/);
	f.ui.handleInput("\u001b[B");
	f.ui.handleInput("\r"); await settle();
	assert.match(f.text(), /▾ Closed · 1/);
	assert.match(f.text(), /Thread done/);
	f.ui.handleInput("\r"); await settle();
	assert.match(f.text(), /▸ Closed · 1/);
	assert.doesNotMatch(f.text(), /Thread done/);
	f.ui.handleInput("\u001b");
	assert.ok(f.state.threads);
	f.state.threads.selected = "done";
	f.ui.openNamedAction("threads"); await settle();
	assert.match(f.text(), /▾ Closed · 1/);
	assert.match(f.text(), /Thread done/);
});

it("Find is a field reached by /, keeps letters as text and clears before it leaves the list", async () => {
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("open"), thread("done", { title: "Finished review", closed: true })], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page(String(input.threadId), [event(1)]));
	await turn(); f.ui.openNamedAction("threads"); await settle();
	const footer = () => f.text().split("\n").at(-1) ?? "";
	// Letters over the list are not a search: they run only the keys the footer shows.
	for (const char of "review") f.ui.handleInput(char);
	await settle();
	assert.match(f.text(), /Thread open/);
	assert.doesNotMatch(f.text(), /Finished rev/);
	f.ui.handleInput("/");
	await settle();
	assert.match(footer(), /↑↓ select · enter done · esc list/, "a focused field shows only the keys it takes");
	for (const char of "review") f.ui.handleInput(char);
	await settle();
	assert.match(f.text(), /Finished rev/);
	assert.doesNotMatch(f.text(), /▸ Closed/);
	assert.match(footer(), /esc clear/, "Escape clears the filter before it leaves");
	f.ui.handleInput("\u001b"); await settle();
	assert.doesNotMatch(f.text(), /Finished rev/);
	assert.match(f.text(), /▸ Closed · 1/);
	assert.match(footer(), /esc list/);
	f.ui.handleInput("\u001b"); await settle();
	assert.match(footer(), /\/ find · m members/);
});

it("create and revise events render one muted line without frame JSON", async () => {
	const colored = Object.assign(Object.create(theme), {
		fg: (color: string, text: string) => `\u2039${color}\u203a${text}`,
		bg: (color: string, text: string) => `\u2039bg:${color}\u203a${text}`,
		bold: (text: string) => `\u2039b\u203a${text}`,
	}) as typeof theme;
	const frame = JSON.stringify({ title: "Thread t1", purpose: "Purposes must not print" });
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page("t1", [event(1, { kind: "create", message: frame }), event(2, { kind: "revise", message: frame }), event(3, { message: "Keep the restriction" })]), 140, 40, colored);
	await turn(); f.ui.openNamedAction("threads"); await settle();
	f.ui.handleInput("\u001b[B"); await settle();
	const raw = f.ui.render(140).join("\n");
	const screen = stripVTControlCharacters(raw);
	assert.match(screen, /Designer created the thread/);
	assert.match(screen, /Designer revised the frame/);
	assert.doesNotMatch(screen, /\{"title"|Purposes must not print/);
	assert.equal(screen.split("\n").filter((line) => line.includes("created the thread")).length, 1);
	assert.match(raw, /\u2039muted\u203a[^\u2039]*created the thread/);
	assert.match(raw, /\u2039muted\u203a[^\u2039]*Purpose of t1/, "thread purpose stays muted");
	assert.doesNotMatch(raw, /\u2039dim\u203a[^\u2039]*(created the thread|revised the frame|Purpose of t1)/, "events and purpose stay muted, not dim");
});

it("join contributions stay in Members and the exchange keeps one muted event line", async () => {
	const f = setup(async (input) => {
		if (input.action === "list") return { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } };
		const p = page("t1", [event(1, { kind: "join", sender: "two", message: "JOIN_BODY" })]);
		p.thread.members[1].contribution = "MEMBER_CONTRIBUTION";
		return p;
	});
	await turn(); f.ui.openNamedAction("threads"); await settle();
	f.ui.handleInput("\u001b[B"); await settle();
	assert.match(f.text(), /Reviewer joined/);
	assert.doesNotMatch(f.text(), /JOIN_BODY|MEMBER_CONTRIBUTION/, "join text is not another exchange body");
	f.ui.handleInput("m"); await settle();
	assert.match(f.text(), /MEMBER_CONTRIBUTION/, "Members keeps the contribution");
	assert.match(f.text().split("\n").at(-1) ?? "", /space wake on post · m exchange · esc exchange/, "the panel footer names the way back");
});

it("the exchange keeps a readable text width and stays inside 80 and 60 columns", async () => {
	const long = "word ".repeat(80).trim();
	for (const [width, height] of [[200, 56], [120, 40]]) {
		const f = setup(async (input) => input.action === "list"
			? { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
			: page("t1", [event(1, { message: long })]), width, height);
		try {
			await turn(); f.ui.openNamedAction("threads"); await settle();
			f.ui.handleInput("\u001b[B"); await settle();
			const lines = f.ui.render(width).map((line) => stripVTControlCharacters(line));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const divider = lines[1].indexOf("│");
			const body = lines.filter((line) => line.includes("word"));
			assert.ok(body.length > 1, "the post wraps");
			assert.ok(body.every((line) => visibleWidth(line.slice(divider + 1).trim()) <= 100), "shared reading width");
			if (width === 200) {
				const sender = lines.find((line) => line.includes("Designer") && line.includes("ago"));
				assert.ok(sender, "a post header is visible");
				const paneDivider = sender.indexOf("│");
				const paneWidth = width - paneDivider - 1;
				const expected = readingGeometry(paneWidth).margin + readingGeometry(paneWidth).textWidth;
				assert.equal(visibleWidth(sender.slice(paneDivider + 1).trimEnd()), expected, "time is right-aligned at margin plus text width");
			}
		} finally { f.ui.dispose(); }
	}
	for (const [width, height] of [[80, 24], [60, 20]]) {
		const f = setup(async (input) => input.action === "list"
			? { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
			: page("t1", [event(1, { message: long })]), width, height);
		try {
			await turn(); f.ui.openNamedAction("threads"); await settle();
			const list = f.ui.render(width).map((line) => stripVTControlCharacters(line));
			assert.ok(list.every((line) => visibleWidth(line) <= width));
			f.ui.handleInput("\r"); await settle();
			const thread = f.ui.render(width).map((line) => stripVTControlCharacters(line));
			assert.ok(thread.every((line) => visibleWidth(line) <= width));
			assert.ok(thread.length <= height);
			assert.match(thread.join("\n"), /Post to Thread t1/);
		} finally { f.ui.dispose(); }
	}
});

it("unknown long identities read as Session <8 hex> in senders and notifications", async () => {
	const unknown = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page("t1", [event(1, { sender: unknown, notify: [unknown], message: "Boundary note" })]));
	await turn(); f.ui.openNamedAction("threads"); await settle();
	f.ui.handleInput("\u001b[B"); await settle();
	const screen = f.text();
	assert.match(screen, /Session aaaaaaaa/);
	assert.match(screen, /notified Session aaaaaaaa/);
	assert.doesNotMatch(screen, /aaaaaaaa-bbbb/);
	assert.doesNotMatch(screen, /\.\.\./);
});

it("long thread rows clip with one ellipsis, not three dots", async () => {
	const title = "A very long thread title for clipping ".repeat(8).trim();
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("t1", { title })], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page("t1", [event(1)]));
	await turn(); f.ui.openNamedAction("threads"); await settle();
	const left = f.text().split("\n").map((line) => line.split("│")[0] ?? line);
	const at = left.findIndex((line) => line.includes("A very long"));
	assert.ok(at >= 0);
	const block = `${left[at]} ${left[at + 1]}`;
	assert.match(block, /…/, "the wrapped title shortens with one ellipsis");
	assert.doesNotMatch(block, /\.\.\./);
});

it("a thread read failure uses error colour in the header", async () => {
	const colored = Object.assign(Object.create(theme), {
		fg: (color: string, text: string) => `\u2039${color}\u203a${text}`,
		bg: (color: string, text: string) => `\u2039bg:${color}\u203a${text}`,
		bold: (text: string) => `\u2039b\u203a${text}`,
	}) as typeof theme;
	const f = setup(async (input) => {
		if (input.action === "list") return { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } };
		throw new Error("source unreadable");
	}, 140, 40, colored);
	await turn(); f.ui.openNamedAction("threads"); await settle();
	f.ui.handleInput("\u001b[B"); await settle();
	const raw = f.ui.render(140).join("\n");
	assert.match(raw, /\u2039error\u203a[^\u2039]*The thread could not be read/);
	assert.doesNotMatch(raw, /\u2039warning\u203a[^\u2039]*The thread could not be read/);
});

it("a close event keeps its state line and shows why the thread ended", async () => {
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("t1", { closed: true })], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page("t1", [event(1), event(2, { kind: "close", message: "Superseded by the new thread" })], { closed: true }));
	await turn(); f.ui.openNamedAction("threads"); await settle();
	const screen = f.text();
	assert.match(screen, /closed the thread ·/);
	assert.match(screen, /Superseded by the new thread/);
	assert.equal(screen.split("\n").filter((line) => line.includes("Superseded")).length, 1);
});

it("post bodies render Markdown, so inline code shows without its backticks", async () => {
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page("t1", [event(1, { message: "Run `npm test` before the push" })]));
	await turn(); f.ui.openNamedAction("threads"); await settle();
	f.ui.handleInput("\u001b[B"); await settle();
	const screen = f.text();
	assert.match(screen, /Run npm test before the push/);
	assert.doesNotMatch(screen, /`/, "Markdown inline code loses its backticks");
});

it("the thread header counts loaded events and ends a long purpose with a Details pointer", async () => {
	const purpose = `${"Wrap this purpose across several rows ".repeat(12)}TAIL_MARKER.`;
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("t1", { purpose })], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page("t1", [event(4), event(5)], { purpose }, 4));
	await turn(); f.ui.openNamedAction("threads"); await settle();
	f.ui.handleInput("\u001b[B"); await settle();
	const rows = f.text().split("\n");
	assert.match(rows[2] ?? "", /Open · 2 members · latest 2 of 5 events/);
	const header = rows.slice(1, 6).map((line) => line.split("│")[1] ?? "");
	assert.ok(header.some((line) => line.includes("… more in Details")), "the purpose points to Details");
	assert.doesNotMatch(header.join("\n"), /TAIL_MARKER/);
	f.ui.handleInput("d");
	await settle();
	assert.match(f.text(), /TAIL_MARKER/, "Details keeps the complete purpose");
});

it("a long post previews, keeps the window top while it grows, and names the post a window continues", async () => {
	const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}`).join("\n\n");
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page("t1", [event(1, { message: paragraphs })]), 140, 20);
	try {
		await turn(); f.ui.openNamedAction("threads"); await settle();
		f.ui.handleInput("\u001b[B"); await settle();
		const pane = () => f.ui.render(140).map((line) => stripVTControlCharacters(line).split("│")[1] ?? "");
		const preview = pane();
		const screen = preview.join("\n");
		assert.match(screen, /▸ \d+ more lines/);
		assert.doesNotMatch(screen, /Paragraph 30/, "the preview stops before the end");
		assert.match(screen, /↑ Designer · #1, continued/, "a window inside a post names it");
		const control = preview.findIndex((line) => line.includes("more lines"));
		f.click(40, control);
		const grown = pane();
		assert.equal(grown[4], preview[4], "the window keeps its first row while the post grows");
		assert.match(grown.join("\n"), /↓ \d+ lines? below · End shows the latest/);
		const below = grown.findIndex((line) => line.includes("lines below"));
		f.click(40, below);
		const bottom = pane().join("\n");
		assert.doesNotMatch(bottom, /lines below/);
		assert.match(bottom, /Paragraph 30/);
		assert.match(bottom, /▴ Show less/);
		f.ui.handleInput("\t");
		f.ui.handleInput("\u001b[A"); await settle();
		assert.match(pane().join("\n"), /↓ \d+ lines? below · End shows the latest/);
		f.ui.handleInput("\u000f"); await settle();
		f.ui.handleInput("\u000f"); await settle();
		assert.match(pane().join("\n"), /▸ \d+ more lines/, "Ctrl+O closes every long post");
		assert.doesNotMatch(pane().join("\n"), /▴ Show less/);
	} finally { f.ui.dispose(); }
});

it("the footer describes each focus and its way out keeps the outcome Escape has", async () => {
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page("t1", [event(1)]));
	try {
		await turn(); f.ui.openNamedAction("threads"); await settle();
		const footer = () => (f.text().split("\n").at(-1) ?? "").trimEnd();
		assert.equal(footer(), "↑↓ select · enter open · / find · m members · d details · ctrl+o open posts · tab focus · esc back");
		f.ui.handleInput("\t"); await settle();
		assert.equal(footer(), "↑↓ scroll · pgup/pgdn page · home earlier · end latest · enter write · m members · d details · ctrl+o open posts · tab focus · esc list");
		f.ui.handleInput("m"); await settle();
		assert.equal(footer(), "↑↓ choose · enter open conversation · space wake on post · m exchange · esc exchange");
		f.ui.handleInput("\u001b"); await settle();
		assert.match(footer(), /^↑↓ scroll · pgup\/pgdn page · home earlier · end latest · enter write · m members/, "the panel's way out returns to the exchange");
		f.ui.handleInput("d"); await settle();
		assert.equal(footer(), "↑↓ scroll · pgup/pgdn page · d exchange · esc exchange");
		f.ui.handleInput("\u001b"); await settle();
		f.ui.handleInput("\u001b"); await settle();
		assert.match(footer(), /^↑↓ select · enter open · \/ find · m members/, "a further Escape returns to the list");
		f.ui.handleInput("\t"); f.ui.handleInput("\t"); await settle();
		assert.equal(footer(), "enter post · shift+enter/ctrl+j newline · tab focus · esc list");
		f.ui.handleInput("\u001b"); await settle();
		assert.match(footer(), /\/ find · m members/, "Escape leaves the message field for the list");
		f.ui.handleInput("\u001b"); await settle();
		assert.equal(f.ui.focus.surface, "work", "the last Escape leaves Threads, as its back label says");
	} finally { f.ui.dispose(); }
});

it("a click on a footer control runs the same command as its key on the same thread", async () => {
	const run = async (mode: "key" | "click") => {
		const f = setup(async (input) => input.action === "list"
			? { items: [thread("t1")], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
			: page("t1", [event(1, { sender: "two" })]));
		try {
			await turn(); f.ui.openNamedAction("threads"); await settle();
			if (mode === "key") f.ui.handleInput("m");
			else f.click(f.ui.render(f.width).at(-1)?.indexOf("m members") ?? -1, f.height - 1);
			await settle();
			assert.equal(f.state.threads?.selected, "t1", "the control acts on the selected thread");
			return f.text();
		} finally { f.ui.dispose(); }
	};
	assert.equal(await run("click"), await run("key"), "the click and the key show the same Members panel");
});

it("each key token of a footer control clicks that key alone", async () => {
	// Reads keep each summary's own timestamp, so the order stays stable while the clicks run.
	const updated: Record<string, number> = { one: 3_000, two: 2_000 };
	const f = setup(async (input) => input.action === "list"
		? { items: [thread("one", { updatedAt: 3_000 }), thread("two", { updatedAt: 2_000 })], nextCursor: null, coverage: { complete: true, visited: 1, omitted: 0 } }
		: page(String(input.threadId), [event(1)], { updatedAt: updated[String(input.threadId)] ?? 1 }));
	try {
		await turn(); f.ui.openNamedAction("threads"); await settle();
		const footer = () => stripVTControlCharacters(f.ui.render(f.width).at(-1) ?? "");
		assert.match(footer(), /^↑↓ select/);
		assert.equal(f.state.threads?.selected, "one");
		f.click(footer().indexOf("↓"), f.height - 1); await settle();
		assert.equal(f.state.threads?.selected, "two", "a click on the down arrow selects the next thread");
		f.click(footer().indexOf("↑"), f.height - 1); await settle();
		assert.equal(f.state.threads?.selected, "one", "a click on the up arrow selects the previous thread");
	} finally { f.ui.dispose(); }
});
