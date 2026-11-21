import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import type { CollaborationPage } from "./collaboration-contract.ts";
import { deferred, fixture, row, source, turn } from "./dashboard-test-fixture.mts";
import type { AgentConversationPage } from "./dashboard-types.ts";

const ordinary = "11111111-1111-1111-1111-111111111111";
const storage = "22222222-2222-2222-2222-222222222222";
const peerStorage = "33333333-3333-3333-3333-333333333333";
const peer = `${peerStorage}:2`;
const other = "44444444-4444-4444-4444-444444444444";

/** Builder is this session's work; Peer and Unrelated are not until a thread joins Peer. */
const rows = () => [
	row(storage, { storageId: storage, creatingOwnerId: ordinary, name: "Builder" }),
	row(peer, { storageId: peerStorage, name: "Peer" }),
	row(other, { storageId: other, name: "Unrelated" }),
];

function discovery(pages: readonly CollaborationPage[]) {
	return {
		items: pages.map(({ thread }) => ({
			id: thread.id,
			title: thread.title,
			purpose: thread.purpose,
			updatedAt: thread.updatedAt,
			closed: thread.closed,
			members: thread.members.length,
		})),
		nextCursor: null,
		coverage: { complete: true, visited: 1, omitted: 0 },
	};
}

function sharedThread(member: string): CollaborationPage {
	const id = `${storage}/abcdef`;
	return {
		thread: {
			id,
			title: "Shared review",
			purpose: "Review the work",
			authority: "Operator request",
			source: "Brief",
			restrictions: "None",
			acceptance: "Read the exchange",
			integrator: storage,
			creator: storage,
			revision: 1,
			sequence: 1,
			closed: false,
			createdAt: 1,
			updatedAt: 2,
			members: [storage, member].map((identity) => ({ identity, contribution: "Work in the thread", joinedAt: 1 })),
		},
		events: [],
		nextBefore: null,
		pending: 0,
		coverage: { complete: true, bytes: 10 },
	};
}

type Fixture = ReturnType<typeof fixture>;
const visible = (f: Fixture) =>
	f.ui.render(f.tui.terminal.columns).map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));
const shown = (f: Fixture) => visible(f).join("\n");

/** The list column, excluding the selected conversation and footer actions. */
function facts(f: Fixture): string {
	const lines = visible(f);
	const width = f.tui.terminal.columns;
	if (width >= 100) {
		const divider = lines[1]?.indexOf("│") ?? -1;
		assert.ok(divider > 0);
		return lines
			.slice(1, -1)
			.map((line) => line.slice(0, divider).trimEnd())
			.join("\n");
	}
	return lines
		.slice(1, f.tui.terminal.rows >= 25 ? 9 : 6)
		.map((line) => line.trimEnd())
		.join("\n");
}

/** Click the visible label on the row it is drawn on. */
function click(f: Fixture, label: string, y?: number): void {
	const lines = visible(f);
	const index = y ?? lines.findIndex((line) => line.includes(label));
	assert.ok(index >= 0, `no ${label}`);
	const line = lines[index] ?? "";
	const x = line.indexOf(label);
	assert.ok(x >= 0, `${label} is drawn on row ${index}`);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: x + 1,
		y: index,
		screenX: x + 1,
		screenY: index,
		width: f.tui.terminal.columns,
		height: f.tui.terminal.rows,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	assert.ok(f.ui.handleMouse(event)?.handled, `${label} accepts the click`);
}

it("the compact strip at 80x24 draws Find and Related/All above the grouped rows, and each click acts where it is drawn", async () => {
	const gate = deferred();
	let reading = true;
	const observed = source(rows());
	const f = fixture(
		80,
		24,
		observed,
		{
			collaborate: async (input) => {
				if (input.action !== "list") return undefined;
				if (reading) await gate.promise;
				return discovery([]);
			},
		},
		undefined,
		undefined,
		ordinary,
	);
	try {
		for (let attempt = 0; attempt < 6; attempt++) await turn();
		const pending = visible(f)[1] ?? "";
		for (const text of ["/ Find", " Related ", " All "]) assert.ok(pending.includes(text), `${text} is drawn at 80x24`);
		assert.equal(visibleWidth(pending), 80, "the row fills exactly the window");
		click(f, " All ", 1);
		assert.match(facts(f), /Working 3/u, "All shows every loaded agent");
		click(f, " Related ", 1);
		assert.match(facts(f), /Reading related work…/u);
		reading = false;
		gate.resolve();
		for (let attempt = 0; attempt < 8; attempt++) await turn();
		const settled = facts(f);
		assert.match(settled, /Working 1/u);
		assert.match(
			settled,
			/● Builder[^\n]*\n[^\n]*test\/model/,
			"the short strip fits an active agent's name and model",
		);
		assert.doesNotMatch(
			settled,
			/Responding|↓ 1 more/,
			"the strip omits the third row instead of hiding the only agent",
		);
		const complete = visible(f)[1] ?? "";
		for (const text of ["/ Find", " Related ", " All "])
			assert.ok(complete.includes(text), `${text} is drawn after the read`);
		assert.doesNotMatch(
			facts(f),
			/Load more|loaded|retained|with errors/u,
			"a complete list has no pagination or retired totals",
		);
		assert.doesNotMatch(shown(f), /Unrelated/u, "Related lists this session's work only");
		click(f, " All ", 1);
		assert.match(facts(f), /Working 3/u);
		assert.match(facts(f), /↓ 2 more/u, "the compact viewport states the rows below");
		click(f, " Related ", 1);
		assert.match(facts(f), /Working 1/u);
	} finally {
		gate.resolve();
		f.ui.dispose();
	}
});

it("compact list controls keep their clicks through a resize and Load more still reads the next page", async () => {
	const cursors: Array<string | undefined> = [];
	const observed = source(rows());
	const list = observed.list;
	observed.list = async (input): Promise<AgentConversationPage> => {
		cursors.push(input?.cursor);
		const result = await list(input);
		return { ...result, coverage: { ...result.coverage, complete: false, nextCursor: "more" } };
	};
	const f = fixture(
		80,
		24,
		observed,
		{ collaborate: async (input) => (input.action === "list" ? discovery([]) : undefined) },
		undefined,
		undefined,
		ordinary,
	);
	try {
		for (let attempt = 0; attempt < 8; attempt++) await turn();
		const strip = visible(f)[1] ?? "";
		for (const text of ["/ Find", " Related ", " All "])
			assert.ok(strip.includes(text), `${text} stays on the Find row`);
		assert.equal(visibleWidth(strip), 80, "the compact Find row fills the window");
		assert.match(facts(f), /Working 1[\s\S]*Load more/u);
		assert.equal(visible(f)[5]?.trim(), "Load more", "a complete viewport leaves only pagination on the last row");
		assert.doesNotMatch(strip, /Load more|loaded|retained|\$/u);
		click(f, " All ", 1);
		assert.match(facts(f), /Working 3[\s\S]*Load more/u);
		assert.match(visible(f)[5] ?? "", /^↓ 2 more +Load more\s*$/u, "position and pagination share the last row");
		f.resize(140, 30);
		assert.match(facts(f), /Working 3[\s\S]*Load more/u, "the wide list states the facts after a resize");
		click(f, " Related ");
		assert.match(facts(f), /Working 1/u, "a wide-list click works after the resize");
		f.resize(80, 24);
		assert.match(facts(f), /Working 1[\s\S]*Load more/u);
		click(f, " All ", 1);
		assert.match(facts(f), /Working 3[\s\S]*Load more/u, "the compact click works after resizing back");
		click(f, "Load more", 5);
		for (let attempt = 0; attempt < 6; attempt++) await turn();
		assert.deepEqual(cursors, [undefined, "more"], "Load more reads the next page once");
	} finally {
		f.ui.dispose();
	}
});

for (const [width, height] of [
	[140, 40],
	[80, 24],
] as const) {
	it(`a routine relation refresh keeps the section count and the geometry at ${width}`, async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
		let gate: Promise<unknown> | undefined;
		const observed = source(rows());
		let rosterChanged = () => {};
		observed.subscribeRoster = (listener) => {
			rosterChanged = listener;
			return () => {};
		};
		const f = fixture(
			width,
			height,
			observed,
			{
				collaborate: async (input) => {
					if (input.action !== "list") return undefined;
					if (gate) await gate;
					return discovery([]);
				},
			},
			undefined,
			undefined,
			ordinary,
		);
		try {
			for (let attempt = 0; attempt < 8; attempt++) await turn();
			const settledFacts = facts(f);
			const findRow = visible(f)[1] ?? "";
			assert.match(settledFacts, /Working 1/u);
			assert.match(findRow, /\/ Find/u);
			const selected = f.state.selected;
			for (let cycle = 0; cycle < 3; cycle++) {
				const pending = deferred();
				gate = pending.promise;
				rosterChanged();
				t.mock.timers.tick(250);
				for (let attempt = 0; attempt < 6; attempt++) await turn();
				assert.equal(facts(f), settledFacts, "a pending refresh keeps the retained facts");
				assert.equal(visible(f)[1], findRow, "the Find row keeps its geometry");
				assert.equal(f.state.selected, selected);
				assert.equal(f.ui.focus.region, "list");
				pending.resolve();
				gate = undefined;
				for (let attempt = 0; attempt < 8; attempt++) await turn();
				assert.equal(facts(f), settledFacts);
				assert.equal(visible(f)[1], findRow);
			}
		} finally {
			f.ui.dispose();
		}
	});

	it(`section counts, a failed relation read and its recovery still show at ${width}`, async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
		let gate: Promise<unknown> | undefined;
		let joined = false;
		let failing = false;
		const observed = source(rows());
		let rosterChanged = () => {};
		observed.subscribeRoster = (listener) => {
			rosterChanged = listener;
			return () => {};
		};
		const f = fixture(
			width,
			height,
			observed,
			{
				collaborate: async (input) => {
					const pages = joined ? [sharedThread(peer)] : [];
					if (input.action === "read") return pages[0];
					if (gate) await gate;
					if (failing) throw new Error("Threads are unreadable");
					return discovery(pages);
				},
			},
			undefined,
			undefined,
			ordinary,
		);
		const refresh = async (change: () => void) => {
			change();
			rosterChanged();
			t.mock.timers.tick(250);
			for (let attempt = 0; attempt < 8; attempt++) await turn();
		};
		try {
			for (let attempt = 0; attempt < 8; attempt++) await turn();
			assert.match(facts(f), /Working 1/u);
			await refresh(() => {
				joined = true;
			});
			assert.match(facts(f), /Working 2/u, "a new relation publishes when it is ready");
			await refresh(() => {
				failing = true;
			});
			assert.match(facts(f), /Related work: read failed/u, "a failed read is stated, not hidden");
			await refresh(() => {
				failing = false;
			});
			assert.match(facts(f), /Working 2/u, "recovery publishes the current facts again");
			assert.doesNotMatch(facts(f), /failed/u);
		} finally {
			f.ui.dispose();
		}
	});
}

it("a narrow footer keeps the relation failure rather than clipping it for Load more", async () => {
	const observed = source(rows());
	const list = observed.list;
	observed.list = async (input): Promise<AgentConversationPage> => {
		const result = await list(input);
		return { ...result, coverage: { ...result.coverage, complete: false, nextCursor: "more" } };
	};
	const f = fixture(
		100,
		40,
		observed,
		{
			collaborate: async (input) => {
				if (input.action === "list") throw new Error("Threads are unreadable");
				return undefined;
			},
		},
		undefined,
		undefined,
		ordinary,
	);
	try {
		for (let attempt = 0; attempt < 8; attempt++) await turn();
		const line = facts(f);
		assert.match(line, /Working 1/u);
		assert.match(line, /Related work: read failed/u, "the failure stays whole");
		assert.doesNotMatch(line, /Load more/u, "the secondary control gives its space to the facts");
	} finally {
		f.ui.dispose();
	}
});
