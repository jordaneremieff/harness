import assert from "node:assert/strict";
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
	it(`Threads shows governing context, peers and chronological exchange within ${width} columns`, async () => {
		const f = setup(width, height);
		try {
			await open(f);
			assert.match(text(f, width), /Purpose: Choose a usable contract/);
			assert.match(text(f, width), /Carried authority \(claim\): Operator directs the work/);
			assert.match(text(f, width), /Restrictions: No live store writes/);
			assert.match(text(f, width), /Acceptance: Exercise the selected contract/);
			f.ui.handleInput("e");
			const shown = text(f, width);
			assert.match(shown, /Reviewer \[two\]/);
			assert.ok(shown.indexOf("#2") < shown.indexOf("#3"));
			assert.match(shown, /Source: Source brief/);
			assert.match(shown, /Notification intents pending: 1/);
			assert.equal(f.ui.render(width).length, height);
			assert.match(f.ui.render(width)[0] ?? "", /^╭─ Agents > Threads/);
			assert.match(f.ui.render(width)[0] ?? "", /Frame 2 ╮$/);
			assert.match(text(f, width), /Lines \d+–\d+ of \d+ loaded/);
			assert.match(f.ui.render(width).at(-1) ?? "", /p post.*Esc back/);
			assert.ok(f.ui.render(width).every((line) => visibleWidth(line) <= width));
		} finally {
			f.ui.dispose();
		}
	});
}
it("Threads shows local calendar dates and readable clock times without seconds or milliseconds", async () => {
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
			f.ui.handleInput("e");
			const shown = text(f, width);
			assert.match(shown, /Time: Oct 3, 2026, 12:04 AM \(local\)/);
			assert.match(shown, /Time: Oct 4, 2026, 1:24 PM \(local\) · Reply to #2/);
			assert.doesNotMatch(shown, /Time: \d{4}-\d{2}-\d{2}T/);
			assert.doesNotMatch(shown, /:19|\.951Z/);
			assert.ok(f.ui.render(width).every((line) => visibleWidth(line) <= width));
		} finally {
			f.ui.dispose();
		}
	}
});
it("i toggles exact UTC times without a read and retains the choice across dashboard reopen", async () => {
	const f = setup();
	try {
		await open(f);
		f.ui.handleInput("e");
		assert.match(text(f), /\(local\)/);
		assert.match(text(f), /i exact UTC/);
		const reads = f.calls.length;
		f.ui.handleInput("i");
		assert.match(text(f), /Time: 1970-01-01T00:00:00\.002Z/);
		assert.match(text(f), /Time: 1970-01-01T00:00:00\.003Z · Reply to #2/);
		assert.match(text(f), /i local time/);
		f.ui.handleInput("i");
		assert.match(text(f), /\(local\)/);
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
			reopened.ui.handleInput("e");
			const shown = stripVTControlCharacters(reopened.ui.render(100).join("\n"));
			assert.match(shown, /Time: 1970-01-01T00:00:00\.002Z/);
			assert.equal(f.state.exactTime, true);
		} finally {
			reopened.ui.dispose();
		}
		const fresh = setup();
		try {
			await open(fresh);
			fresh.ui.handleInput("e");
			assert.match(text(fresh), /\(local\)/);
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
		f.ui.handleInput("e");
		assert.match(text(f), /\(local\)/);
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
		mouse("i local time");
		assert.equal(f.state.exactTime, false);
		mouse("n notify");
		mouse("[ ] Reviewer");
		assert.deepEqual(f.state.threads?.drafts.get(threadId)?.notify, ["two"]);
		mouse("Tab write");
		f.ui.handleInput("draft");
		assert.equal(f.state.threads?.drafts.get(threadId)?.text, "draft");
		mouse("Esc back");
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

it("automatic thread refresh follows the exchange tail but preserves a deliberate frame read", async () => {
	let current = page();
	const f = setup(100, 30, async (input) => (input.action === "list" ? list() : current));
	try {
		await open(f);
		f.ui.handleInput("e");
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
		f.ui.handleInput("f");
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

it("dashboard help distinguishes a silent post from passive notification delivery", async () => {
	const f = setup(120, 36);
	try {
		await turn();
		f.ui.handleInput("?");
		assert.match(text(f, 120), /p posts without a model wake\./);
		assert.match(text(f, 120), /i switches roster and Threads times between local time and exact UTC timestamps\./);
		assert.doesNotMatch(text(f, 120), /p posts without notification\./);
	} finally {
		f.ui.dispose();
	}
});
