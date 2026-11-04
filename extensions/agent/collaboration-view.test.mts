import assert from "node:assert/strict";
import { dashboardTime } from "./dashboard-time.ts";
import { it } from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { fixture, source, row, turn, deferred } from "./dashboard-test-fixture.mts";
import type { CollaborationPage, CollaborationList } from "./collaboration.ts";

const threadId = "storage/thread";
function list(): CollaborationList {
	return {
		items: [
			{
				id: threadId,
				title: "Boundary review",
				purpose: "Choose a usable contract",
				updatedAt: 1,
				closed: false,
				members: 2,
			},
		],
		nextCursor: null,
		coverage: { complete: true, visited: 1, omitted: 0 },
	};
}
function page(): CollaborationPage {
	return {
		thread: {
			id: threadId,
			title: "Boundary review",
			purpose: "Choose a usable contract",
			authority: "Operator directs the work",
			source: "Source brief",
			restrictions: "No live store writes",
			acceptance: "Exercise the selected contract",
			integrator: "one",
			creator: "one",
			revision: 2,
			sequence: 3,
			closed: false,
			createdAt: 1,
			updatedAt: 3,
			members: [
				{ identity: "one", contribution: "Design", joinedAt: 1 },
				{ identity: "two", contribution: "Challenge", joinedAt: 2 },
			],
		},
		events: [
			{
				threadId,
				sequence: 2,
				at: 2,
				sender: "two",
				origin: "model",
				kind: "contribution",
				message: "Challenge the proposed boundary",
				source: "",
				replyTo: null,
				revision: 2,
				notify: [],
			},
			{
				threadId,
				sequence: 3,
				at: 3,
				sender: "one",
				origin: "model",
				kind: "carried-authority",
				message: "Preserve the operator restriction",
				source: "Source brief",
				replyTo: 2,
				revision: 2,
				notify: ["two"],
			},
		],
		nextBefore: 2,
		pending: 1,
		coverage: { complete: true, bytes: 1000 },
	};
}
function setup(width = 100, height = 30, override?: (input: Record<string, unknown>) => Promise<unknown>) {
	const calls: Record<string, unknown>[] = [];
	let notify = () => {};
	let unsubscribed = 0;
	const observed = source([row("one", { name: "Designer" }), row("two", { name: "Reviewer" })]);
	observed.subscribeRoster = (listener) => {
		notify = listener;
		return () => {
			unsubscribed++;
		};
	};
	const f = fixture(width, height, observed, {
		collaborate: async (input) => {
			calls.push(input);
			return override
				? override(input)
				: input.action === "list"
					? list()
					: input.action === "read"
						? page()
						: { threadId, sequence: 4, deduped: false };
		},
	});
	return { ...f, calls, notify: () => notify(), unsubscribed: () => unsubscribed };
}
async function open(f: ReturnType<typeof setup>) {
	await turn();
	f.ui.handleInput("t");
	await turn();
	f.ui.handleInput("\r");
	await turn();
}
const text = (f: ReturnType<typeof setup>, width = 100) => stripVTControlCharacters(f.ui.render(width).join("\n"));
for (const [width, height] of [
	[80, 24],
	[140, 45],
]) {
	it(`multiline thread titles keep headings and captions on one row at ${width}`, async () => {
		const current = page();
		current.thread.title = "First\nSecond";
		const event = current.events[0];
		assert.ok(event);
		event.message = "Body first\nBody second";
		const f = setup(width, height, async (input) => (input.action === "list" ? list() : current));
		const render = () => {
			const lines = f.ui.render(width).map(stripVTControlCharacters);
			assert.equal(lines.length, height);
			assert.ok(lines.every((line) => !/[\r\n]/.test(line) && visibleWidth(line) <= width));
			assert.match(lines[0] ?? "", /Threads > First Second/);
			assert.match(lines.at(-1) ?? "", /Back \(Esc\)/);
			return lines;
		};
		try {
			await open(f);
			const initial = render();
			const first = initial.findIndex((line) => line.trim() === "First");
			assert.ok(first > 0);
			assert.equal(initial[first + 1]?.trim(), "Second");
			const body = initial.findIndex((line) => line.trim() === "Body first");
			assert.ok(body > first, "the exchange follows the compact head");
			assert.equal(initial[body + 1]?.trim(), "Body second");
			f.ui.handleInput("p");
			f.ui.handleInput("\x1b[200~Draft first\nDraft second\x1b[201~");
			const composed = render();
			assert.ok(composed.some((line) => line.startsWith("╭─ Post to First Second")));
			assert.ok(composed.some((line) => /^│Draft first/.test(line)));
			assert.ok(composed.some((line) => /^│Draft second/.test(line)));
			assert.equal(f.state.threads?.drafts.get(threadId)?.text, "Draft first\nDraft second");
		} finally {
			f.ui.dispose();
		}
	});
	it(`Threads opens on the exchange with a compact head and keeps the frame behind Context within ${width} columns`, async () => {
		const f = setup(width, height);
		try {
			await open(f);
			const shown = text(f, width);
			assert.match(shown, /Open · 2 peers · updated \d+d ago · Frame revision 2/);
			assert.match(shown, /Purpose: Choose a usable contract/);
			assert.doesNotMatch(shown, /Carried authority|Restrictions:|Acceptance:|Member declarations/, "frame detail waits behind Context");
			assert.match(shown, /Reviewer \[two\]/);
			assert.ok(shown.indexOf("#2") < shown.indexOf("#3"));
			assert.match(shown, /Source: Source brief/);
			assert.match(shown, /Preserve the operator restriction/, "the latest message is visible on opening");
			assert.match(shown, /Notification intents pending: 1/);
			assert.equal(f.ui.render(width).length, height);
			assert.match(f.ui.render(width)[0] ?? "", /^╭─ Agents > Threads/);
			assert.match(f.ui.render(width)[0] ?? "", /Frame 2 ╮$/);
			assert.match(text(f, width), /Lines \d+–\d+ of \d+ loaded/);
			assert.match(f.ui.render(width).at(-1) ?? "", /Reply · Post · Post and notify · Peers · Context.*More \(x\) · Back \(Esc\)/);
			assert.ok(f.ui.render(width).every((line) => visibleWidth(line) <= width));
			f.ui.handleInput("c");
			const context = text(f, width);
			assert.match(f.ui.render(width)[0] ?? "", /Boundary review > Context/);
			assert.match(context, /Carried authority \(claim\): Operator directs the work/);
			assert.match(context, /Authority source: Source brief/);
			assert.match(context, /Restrictions: No live store writes/);
			assert.match(context, /Acceptance: Exercise the selected contract/);
			assert.match(context, /Integrator: Designer/);
			assert.match(context, /Member declarations, not agreement/);
			assert.match(context, /Designer \[one\]: Design/);
			assert.match(context, /attributed claims, not proof of authority/);
			assert.doesNotMatch(context, /Challenge the proposed boundary/);
			f.ui.handleInput("\x1b");
			assert.match(text(f, width), /Challenge the proposed boundary/);
			assert.doesNotMatch(f.ui.render(width)[0] ?? "", /Context/);
		} finally {
			f.ui.dispose();
		}
	});
}
it("Threads shows absolute local dates without seconds or a suffix", async () => {
	for (const [width, height] of [
		[80, 24],
		[140, 45],
	]) {
		const current = page();
		const [first, second] = current.events;
		assert.ok(first && second);
		first.at = new Date(2026, 9, 3, 0, 4, 19, 951).getTime();
		second.at = new Date(2026, 9, 4, 13, 24, 19, 951).getTime();
		const f = setup(width, height, async (input) => (input.action === "list" ? list() : current));
		try {
			await open(f);
			f.ui.handleInput("i");
			const shown = text(f, width);
			assert.match(shown, /Time: Oct 3, 2026, 12:04 AM/);
			assert.match(shown, /Time: Oct 4, 2026, 1:24 PM · Reply to #2/);
			assert.doesNotMatch(shown, /Time: \d{4}-\d{2}-\d{2}T/);
			assert.doesNotMatch(shown, /:19|\.951Z/);
			assert.ok(f.ui.render(width).every((line) => visibleWidth(line) <= width));
		} finally {
			f.ui.dispose();
		}
	}
});
it("i toggles relative and absolute times without a read and retains the choice across reopen", async () => {
	const f = setup();
	try {
		await open(f);
		assert.match(text(f), /Time: \d+d ago/);
		const menu = () => { f.ui.handleInput("x"); const shown = text(f); f.ui.handleInput("\x1b"); return shown; };
		assert.match(menu(), /Date and time/);
		const reads = f.calls.length;
		f.ui.handleInput("i");
		assert.ok(text(f).includes(dashboardTime(2, true)));
		assert.doesNotMatch(text(f), /\(local\)|\.003Z/);
		assert.match(menu(), /Relative time/);
		f.ui.handleInput("i");
		assert.match(text(f), /Time: \d+d ago/);
		assert.doesNotMatch(text(f), /Time: \d{4}-\d{2}-\d{2}T/);
		assert.equal(f.calls.length, reads);
		f.ui.handleInput("p");
		f.ui.handleInput("i");
		assert.equal(f.state.threads?.drafts.get(threadId)?.text, "i");
		assert.equal(f.state.exactTime, false);
		f.ui.handleInput("\x1b");
		f.ui.handleInput("i");
		f.ui.dispose();
		const reopened = fixture(
			100,
			30,
			source(),
			{ collaborate: async (input) => (input.action === "list" ? list() : page()) },
			f.state,
		);
		try {
			await turn();
			reopened.ui.handleInput("t");
			await turn();
			reopened.ui.handleInput("\r");
			await turn();
			const shown = stripVTControlCharacters(reopened.ui.render(100).join("\n"));
			assert.ok(shown.includes(dashboardTime(2, true)));
			assert.equal(f.state.exactTime, true);
		} finally {
			reopened.ui.dispose();
		}
		const fresh = setup();
		try {
			await open(fresh);
			assert.match(text(fresh), /Time: \d+d ago/);
			assert.equal(fresh.state.exactTime, false);
		} finally {
			fresh.ui.dispose();
		}
	} finally {
		f.ui.dispose();
	}
});
function cellEvent(f: ReturnType<typeof setup>, needle: string): TuiMouseEvent {
	const lines = f.ui.render(100).map(stripVTControlCharacters);
	const y = lines.findIndex((line) => line.includes(needle));
	assert.ok(y >= 0, needle);
	const x = lines[y]?.indexOf(needle) ?? 0;
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 100,
		height: 36,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}
it("thread discovery refresh rejects clicks on the previous list before repaint", async () => {
	let current = list();
	const f = setup(100, 36, async () => structuredClone(current));
	try {
		await turn();
		f.ui.handleInput("t");
		await turn();
		const oldClick = cellEvent(f, "Boundary review");
		const first = current.items[0];
		assert.ok(first);
		current = { ...current, items: [{ ...first, id: "storage/replacement", title: "Replacement thread" }] };
		f.notify();
		await turn();
		const calls = f.calls.length;
		assert.equal(f.ui.handleMouse(oldClick), undefined);
		assert.equal(f.calls.length, calls);
		assert.equal(f.state.threads?.selected, undefined);
		assert.match(text(f), /Replacement thread/);
	} finally {
		f.ui.dispose();
	}
});
it("member refresh rejects stale notify hits until the new recipient rows render", async () => {
	let current = page();
	const f = setup(100, 36, async (input) => structuredClone(input.action === "list" ? list() : current));
	try {
		await open(f);
		f.ui.handleInput("n");
		const oldClick = cellEvent(f, "[ ] Reviewer");
		current = { ...current, thread: { ...current.thread, members: current.thread.members.toReversed() } };
		f.notify();
		await turn();
		assert.equal(f.ui.handleMouse(oldClick), undefined);
		assert.deepEqual(f.state.threads?.drafts.get(threadId)?.notify, []);
		f.ui.handleMouse(cellEvent(f, "[ ] Reviewer"));
		assert.deepEqual(f.state.threads?.drafts.get(threadId)?.notify, ["two"]);
	} finally {
		f.ui.dispose();
	}
});
it("mouse follows thread rows, timestamps, notify choices and hints without consuming selection drags", async () => {
	const current = page();
	assert.ok(current.events[0]);
	current.events[0].message = "Time: forged message label";
	const f = setup(100, 36, async (input) => (input.action === "list" ? list() : current));
	const mouse = (needle: string, patch: Partial<TuiMouseEvent> = {}) => {
		const lines = f.ui.render(100).map(stripVTControlCharacters);
		const y = lines.findIndex((line) => line.includes(needle));
		assert.ok(y >= 0, needle);
		const x = lines[y]?.indexOf(needle) ?? 0;
		return f.ui.handleMouse({
			type: "click",
			button: "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width: 100,
			height: 36,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
			...patch,
		});
	};
	try {
		await turn();
		f.ui.handleInput("t");
		await turn();
		mouse("Boundary review");
		await turn();
		assert.match(text(f), /Time: \d+d ago/);
		const before = f.calls.length;
		mouse("Time: forged message label");
		assert.equal(f.state.exactTime, false);
		const stamp = "Time: ";
		mouse(stamp, { type: "press" });
		mouse(stamp, { type: "drag" });
		mouse(stamp, { type: "release" });
		assert.equal(f.state.exactTime, false);
		mouse(stamp);
		assert.equal(f.state.exactTime, true);
		assert.equal(f.calls.length, before);
		mouse("More (x)");
		mouse("Relative time");
		mouse("Choose (Enter)");
		assert.equal(f.state.exactTime, false);
		mouse("Post and notify");
		mouse("[ ] Reviewer");
		assert.deepEqual(f.state.threads?.drafts.get(threadId)?.notify, ["two"]);
		mouse("Write");
		f.ui.handleInput("draft");
		assert.equal(f.state.threads?.drafts.get(threadId)?.text, "draft");
		mouse("Back (Esc)");
		assert.equal(f.state.threads?.drafts.get(threadId)?.text, "draft");
		mouse("Time: ", { type: "wheel", wheelDelta: -5 });
		assert.match(text(f), /Purpose: Choose a usable contract/);
	} finally {
		f.ui.dispose();
	}
});
it("p posts silently and n explicitly selects peers, without an agent message submission", async () => {
	const f = setup();
	try {
		await open(f);
		f.ui.handleInput("p");
		f.ui.handleInput("Silent operator note");
		f.ui.handleInput("\r");
		await turn();
		const post = f.calls.find((input) => input.action === "post");
		assert.equal(typeof post?.requestId, "string");
		assert.deepEqual(
			{ ...post, requestId: undefined },
			{
				requestId: undefined,
				action: "post",
				threadId,
				message: "Silent operator note",
				notify: [],
				origin: "operator",
			},
		);
		f.ui.handleInput("n");
		f.ui.handleInput("\x1b[B");
		f.ui.handleInput(" ");
		f.ui.handleInput("\t");
		f.ui.handleInput("Please challenge this");
		f.ui.handleInput("\r");
		await turn();
		assert.deepEqual(f.calls.filter((input) => input.action === "post")[1]?.notify, ["two"]);
		assert.match(text(f), /Post 4 retained/);
		assert.equal(f.state.threads?.drafts.get(threadId)?.text, "");
	} finally {
		f.ui.dispose();
	}
});
it("Threads preserves the agent draft, thread draft and selection across return and reopen", async () => {
	const f = setup();
	try {
		await turn();
		f.ui.handleInput("\t");
		f.ui.handleInput("Agent draft");
		f.ui.handleInput("\x1b");
		const selected = f.state.selected;
		await open(f);
		f.ui.handleInput("p");
		f.ui.handleInput("Thread draft");
		f.ui.handleInput("\x1b");
		f.ui.handleInput("\x1b");
		f.ui.handleInput("\x1b");
		assert.equal(f.state.selected, selected);
		assert.equal(f.ui.navigation.screen, "roster");
		f.ui.handleInput("\t");
		assert.match(text(f), /Agent draft/);
		f.ui.handleInput("\x1b");
		await open(f);
		f.ui.handleInput("p");
		assert.match(text(f), /Thread draft/);
		f.ui.dispose();
		const reopened = fixture(
			100,
			30,
			source(),
			{ collaborate: async (input) => (input.action === "list" ? list() : page()) },
			f.state,
		);
		try {
			await turn();
			reopened.ui.handleInput("t");
			await turn();
			reopened.ui.handleInput("\r");
			await turn();
			reopened.ui.handleInput("p");
			assert.match(stripVTControlCharacters(reopened.ui.render(100).join("\n")), /Thread draft/);
		} finally {
			reopened.ui.dispose();
		}
	} finally {
		f.ui.dispose();
	}
});
it("published omitted storage rows and continued discovery stay reachable", async () => {
	const f = setup(100, 30, async (input) => {
		if (input.sessionId) return list();
		return {
			items: [],
			sources: [{ sessionId: "remote", omitted: 12, unavailable: false }],
			nextCursor: "next",
			coverage: { complete: false, visited: 1, omitted: 12, unavailable: 0 },
		};
	});
	try {
		await turn();
		f.ui.handleInput("t");
		await turn();
		assert.match(text(f), /12 threads omitted/);
		assert.match(text(f), /Partial/);
		f.ui.handleInput("\x1b[B");
		f.ui.handleInput("\r");
		await turn();
		assert.ok(f.calls.some((input) => input.cursor === "next"));
		f.ui.handleInput("\x1b[A");
		f.ui.handleInput("\r");
		await turn();
		assert.ok(f.calls.some((input) => input.sessionId === "remote"));
		assert.match(text(f), /Boundary review/);
		f.ui.handleInput("\x1b");
		await turn();
		assert.match(text(f), /Catalog discovery/);
	} finally {
		f.ui.dispose();
	}
});
it("roster notifications refresh the selected read, retain earlier range and release callbacks on close", async () => {
	const f = setup();
	try {
		await open(f);
		const before = f.calls.length;
		f.notify();
		await turn();
		assert.ok(f.calls.slice(before).some((input) => input.action === "read" && input.threadId === threadId));
		f.ui.handleInput("b");
		await turn();
		assert.equal(f.calls.at(-1)?.before, 2);
		f.notify();
		await turn();
		assert.ok(f.calls.some((input) => input.before === 2));
		f.ui.handleInput("r");
		await turn();
		assert.equal(f.calls.at(-1)?.before, undefined);
		f.ui.dispose();
		const count = f.calls.length;
		f.notify();
		await turn();
		assert.equal(f.calls.length, count);
		assert.equal(f.unsubscribed(), 1);
	} finally {
		f.ui.dispose();
	}
});
it("a stale discovery cannot overwrite a scoped list and invalid schemas show a refusal", async () => {
	const gate = deferred<unknown>();
	const f = setup(100, 30, async (input) => (input.sessionId ? list() : gate.promise));
	try {
		await turn();
		f.ui.handleInput("t");
		f.ui.handleInput("s");
		gate.resolve({ bad: true });
		await turn();
		await turn();
		assert.match(text(f), /Boundary review/);
		assert.ok(f.calls.some((input) => input.sessionId === f.state.selected));
	} finally {
		gate.resolve(list());
		f.ui.dispose();
	}
	const invalid = setup(100, 30, async () => ({ bad: true }));
	try {
		await turn();
		invalid.ui.handleInput("t");
		await turn();
		assert.match(text(invalid), /invalid thread list/);
	} finally {
		invalid.ui.dispose();
	}
});
it("failed posts retain text and late receipts do not erase a newer draft", async () => {
	const gate = deferred<unknown>();
	const f = setup(100, 30, async (input) =>
		input.action === "list" ? list() : input.action === "read" ? page() : gate.promise,
	);
	try {
		await open(f);
		f.ui.handleInput("p");
		f.ui.handleInput("First note");
		f.ui.handleInput("\r");
		f.ui.handleInput("\x03");
		f.ui.handleInput("New note");
		gate.resolve({ threadId, sequence: 4, deduped: false });
		await turn();
		assert.equal(f.state.threads?.drafts.get(threadId)?.text, "New note");
	} finally {
		gate.resolve({ threadId, sequence: 4, deduped: false });
		f.ui.dispose();
	}
	const failed = setup(100, 30, async (input) => {
		if (input.action === "post") throw new Error("Writer unavailable");
		return input.action === "list" ? list() : page();
	});
	try {
		await open(failed);
		failed.ui.handleInput("p");
		failed.ui.handleInput("Retain this");
		failed.ui.handleInput("\r");
		await turn();
		assert.match(text(failed), /Post failed/);
		assert.equal(failed.state.threads?.drafts.get(threadId)?.text, "Retain this");
	} finally {
		failed.ui.dispose();
	}
});
it("closed threads refuse composition and event text cannot emit terminal commands", async () => {
	const p = page();
	p.thread.closed = true;
	assert.ok(p.events[0]);
	p.events[0].message = "Safe\x1b[2Jtail";
	const f = setup(100, 30, async (input) => (input.action === "list" ? list() : p));
	try {
		await open(f);
		f.ui.handleInput("p");
		f.ui.handleInput("n");
		f.ui.handleInput("e");
		assert.doesNotMatch(f.ui.render(100).join("\n"), /\x1b\[2J/);
		assert.match(text(f), /Safetail/);
		assert.equal(f.calls.filter((input) => input.action === "post").length, 0);
	} finally {
		f.ui.dispose();
	}
});

it("uncertain retries reuse one request ID but a new retained post receives a new ID", async () => {
	let refused = true;
	const f = setup(100, 30, async (input) => {
		if (input.action === "list") return list();
		if (input.action === "read") return page();
		if (refused) {
			refused = false;
			throw new Error("Admission response lost");
		}
		return { threadId, sequence: 4, deduped: false };
	});
	try {
		await open(f);
		f.ui.handleInput("p");
		f.ui.handleInput("Same note");
		f.ui.handleInput("\r");
		await turn();
		f.ui.handleInput("\r");
		await turn();
		f.ui.handleInput("p");
		f.ui.handleInput("Same note");
		f.ui.handleInput("\r");
		await turn();
		const posts = f.calls.filter((input) => input.action === "post");
		assert.equal(posts.length, 3);
		assert.equal(posts[0]?.requestId, posts[1]?.requestId);
		assert.notEqual(posts[1]?.requestId, posts[2]?.requestId);
	} finally {
		f.ui.dispose();
	}
});
it("a receipt after close refreshes the reopened draft without an old source callback", async () => {
	const gate = deferred<unknown>();
	const f = setup(100, 30, async (input) =>
		input.action === "list" ? list() : input.action === "read" ? page() : gate.promise,
	);
	await open(f);
	f.ui.handleInput("p");
	f.ui.handleInput("Pending note");
	f.ui.handleInput("\r");
	f.ui.dispose();
	const reopened = fixture(
		100,
		30,
		source(),
		{ collaborate: async (input) => (input.action === "list" ? list() : page()) },
		f.state,
	);
	try {
		await turn();
		reopened.ui.handleInput("t");
		await turn();
		reopened.ui.handleInput("\r");
		await turn();
		reopened.ui.handleInput("p");
		const before = reopened.counts().renders;
		gate.resolve({ threadId, sequence: 4, deduped: false });
		await turn();
		assert.ok(reopened.counts().renders > before);
		assert.equal(f.state.threads?.drafts.get(threadId)?.text, "");
		assert.doesNotMatch(stripVTControlCharacters(reopened.ui.render(100).join("\n")), /Pending note/);
	} finally {
		gate.resolve({ threadId, sequence: 4, deduped: false });
		reopened.ui.dispose();
	}
});

for (const field of ["pending", "sequence"]) {
	it(`negative ${field} refuses the current thread page rather than rendering it`, async () => {
		const invalid = page();
		if (field === "pending") invalid.pending = -1;
		else {
			assert.ok(invalid.events[0]);
			invalid.events[0].sequence = -1;
		}
		const f = setup(100, 30, async (input) => (input.action === "list" ? list() : invalid));
		try {
			await open(f);
			assert.match(text(f), /invalid thread page/);
		} finally {
			f.ui.dispose();
		}
	});
}

it("automatic thread refresh follows the exchange tail but preserves a deliberate earlier read", async () => {
	let current = page();
	const f = setup(100, 30, async (input) => (input.action === "list" ? list() : current));
	try {
		await open(f);
		f.ui.render(100);
		assert.ok(current.events[0]);
		const incoming = {
			...current.events[0],
			sequence: 4,
			at: 4,
			message: `${Array.from({ length: 45 }, () => "New exchange detail").join("\n")}\nNEW_LIVE_TAIL`,
		};
		current = { ...current, events: [...current.events, incoming] };
		f.notify();
		await turn();
		assert.match(text(f), /NEW_LIVE_TAIL/);
		f.ui.handleInput("\x1b[H");
		current = {
			...current,
			events: [...current.events, { ...incoming, sequence: 5, at: 5, message: "LATER_LIVE_TAIL" }],
		};
		f.notify();
		await turn();
		assert.match(text(f), /Purpose: Choose a usable contract/);
		assert.doesNotMatch(text(f), /LATER_LIVE_TAIL/);
	} finally {
		f.ui.dispose();
	}
});

it("a revisited thread restores its reading position while a new thread opens on the latest events", async () => {
	const current = page();
	assert.ok(current.events[0]);
	current.events[0].message = `TOP_OF_EXCHANGE\n${Array.from({ length: 40 }, () => "Earlier detail").join("\n")}`;
	const f = setup(100, 30, async (input) => (input.action === "list" ? list() : current));
	try {
		await open(f);
		assert.match(text(f), /Preserve the operator restriction/);
		assert.doesNotMatch(text(f), /TOP_OF_EXCHANGE/);
		f.ui.handleInput("\x1b[H");
		assert.match(text(f), /TOP_OF_EXCHANGE/);
		f.ui.handleInput("\x1b");
		await turn();
		assert.match(f.ui.render(100)[0] ?? "", /Agents > Threads \u2500/);
		f.ui.handleInput("\r");
		await turn();
		assert.match(text(f), /TOP_OF_EXCHANGE/, "the position of the earlier read is restored");
		assert.doesNotMatch(text(f), /Preserve the operator restriction/);
		assert.equal(f.state.threads?.positions?.get(threadId)?.follow, false);
	} finally {
		f.ui.dispose();
	}
});

it("Reply chooses an event, composes with replyTo and clears the target after the retained post", async () => {
	const f = setup();
	try {
		await open(f);
		f.ui.handleInput("\r");
		assert.match(f.ui.render(100)[0] ?? "", /Boundary review > Reply/);
		const picker = text(f);
		assert.ok(picker.indexOf("#3 \u00b7 Designer") < picker.indexOf("#2 \u00b7 Reviewer"), "newest event first");
		assert.match(picker, /\u203a #3 \u00b7 Designer \u00b7 carried-authority/);
		f.ui.handleInput("\x1b[B");
		f.ui.handleInput("\r");
		assert.equal(f.state.threads?.drafts.get(threadId)?.replyTo, 2);
		assert.match(text(f), /Reply to #2 in Boundary review/);
		assert.match(text(f), /Reply to #2/);
		f.ui.handleInput("Answer");
		f.ui.handleInput("\r");
		await turn();
		const post = f.calls.find((input) => input.action === "post");
		assert.equal(post?.replyTo, 2);
		assert.equal(post?.message, "Answer");
		assert.equal(f.state.threads?.drafts.get(threadId)?.replyTo, undefined);
		f.ui.handleInput("p");
		assert.match(text(f), /Post to Boundary review/);
		assert.doesNotMatch(text(f), /Reply to #2 in/);
	} finally {
		f.ui.dispose();
	}
});

it("wheel over the thread list scrolls the list without moving the selection", async () => {
	const items = Array.from({ length: 20 }, (_, index) => ({ id: `storage/thread-${index}`, title: `Thread ${index}`, purpose: `Purpose ${index}`, updatedAt: 1, closed: false, members: 1 }));
	const f = setup(100, 24, async (input) => (input.action === "list" ? { ...list(), items } : page()));
	const wheel = (delta: number) => f.ui.handleMouse({ ...cellEvent(f, "Thread "), type: "wheel", wheelDelta: delta, width: 100, height: 24 });
	try {
		await turn();
		f.ui.handleInput("t");
		await turn();
		assert.match(text(f), /\u203a Open \u00b7 Thread 0 /);
		wheel(6);
		const scrolled = text(f);
		assert.doesNotMatch(scrolled, /Thread 0 /, "the selected row left the viewport");
		assert.match(scrolled, /Thread 1[0-9]/);
		assert.match(f.ui.render(100)[0] ?? "", /1\/20/, "selection unchanged");
		f.ui.handleInput("\x1b[B");
		assert.match(text(f), /\u203a Open \u00b7 Thread 1 /, "an explicit selection change reveals the selected row");
	} finally {
		f.ui.dispose();
	}
});

it("dashboard help distinguishes a silent post from passive notification delivery", async () => {
	const f = setup(120, 36);
	try {
		await turn();
		f.ui.handleInput("?");
		assert.match(text(f, 120), /p posts without a model wake\./);
		assert.match(text(f, 120), /i switches all times between relative age and local date and time\./);
		assert.doesNotMatch(text(f, 120), /p posts without notification\./);
	} finally {
		f.ui.dispose();
	}
});

it("member declarations replace on a fresh read without a revision time or agreement claim", async () => {
	let current = page();
	current.thread.members = [
		{ identity: "one", contribution: "Policy gate released. Source: #2", joinedAt: 1 },
		{ identity: "two", contribution: "Hold my gate for the dependency release. Source: #3", joinedAt: 2 },
	];
	const f = setup(100, 48, async (input) => input.action === "list" ? list() : structuredClone(current));
	try {
		await open(f);
		f.ui.handleInput("c");
		const initial = text(f);
		assert.match(initial, /Member declarations, not agreement/);
		assert.match(initial, /Designer \[one\]: Policy gate released/);
		assert.match(initial, /Reviewer \[two\]: Hold my gate/);
		assert.match(initial, /Authority source: Source brief/);
		assert.match(initial, /Membership dates do not date declaration changes/);
		assert.doesNotMatch(initial, /machine free|declaration updated|joinedAt/i);
		current = { ...current, thread: { ...current.thread, members: [{ ...current.thread.members[0], contribution: "Renewed hold. Source: #4" }, current.thread.members[1]] } };
		f.notify(); await turn();
		assert.match(text(f), /Renewed hold/);
		assert.doesNotMatch(text(f), /Policy gate released/);
		assert.equal(current.thread.members[0].joinedAt, 1);
		f.ui.handleInput("\x1b");
		assert.match(text(f), /Source: Source brief/);
		assert.match(text(f), /Earlier events available/);
		assert.ok(f.calls.every((input) => input.action === "read" || input.action === "list"));
	} finally { f.ui.dispose(); }
});
it("bounded member declarations stay truthful and width-safe in the thread frame", async () => {
	const current = page();
	current.thread.members = Array.from({ length: 17 }, (_, i) => ({ identity: `peer-${i}`, contribution: `Hold ${i}`, joinedAt: 1 }));
	const f = setup(80, 24, async (input) => input.action === "list" ? list() : current);
	try {
		await open(f);
		f.ui.handleInput("c");
		let shown = "";
		for (let i = 0; i < 12; i++) {
			const lines = f.ui.render(80);
			assert.equal(lines.length, 24); assert.ok(lines.every((line) => visibleWidth(line) <= 80));
			shown += lines.join("\n");
			f.ui.handleInput("\x1b[6~");
		}
		assert.match(shown, /1 member declarations omitted by display bound/);
		assert.doesNotMatch(shown, /peer-16|machine free|agreement reached/i);
	} finally { f.ui.dispose(); }
});
