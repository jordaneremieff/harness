import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import type { OwnerView } from "./panel-modules.ts";
import { fixture, page, row, source, turn } from "./dashboard-test-fixture.mts";

type Fixture = ReturnType<typeof fixture>;

const visible = (f: Fixture) =>
	f.ui.render(f.tui.terminal.columns).map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));
const shown = (f: Fixture) => visible(f).join("\n");
const footer = (f: Fixture) => (visible(f).at(-1) ?? "").trimEnd();

async function settle(turns = 8): Promise<void> {
	for (let index = 0; index < turns; index++) await turn();
}

function click(f: Fixture, x: number, y: number): void {
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: f.tui.terminal.columns,
		height: f.tui.terminal.rows,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	f.ui.handleMouse(event);
}

function point(f: Fixture, text: string): { x: number; y: number } {
	const lines = visible(f);
	const y = lines.findIndex((line) => line.includes(text));
	assert.ok(y >= 0, `no visible ${text}`);
	return { x: lines[y].indexOf(text), y };
}

const minutes = (count: number) => Date.now() - count * 60_000;
const job = (id: string, label: string, startedAt: number) => ({ source: "jobs", id, label, startedAt });

/** A working agent without running work, and a settled agent whose host runs one job. */
function agents(): AgentConversationSummary[] {
	return [
		row("reader", { name: "Reader", state: "working", modifiedAt: minutes(1) }),
		row("builder", {
			name: "Builder",
			state: "done",
			modifiedAt: minutes(5),
			activity: [job("j1", "npm test --workspace parser", minutes(2))],
		}),
	];
}

it("an agent's running work shows under it in the list and under its facts in the pane", async () => {
	const f = fixture(140, 40, source(agents()));
	try {
		await settle();
		const lines = visible(f);
		const name = lines.findIndex((line) => line.includes("✓ Builder"));
		assert.ok(name >= 0);
		assert.match(
			lines[name + 2] ?? "",
			/● npm test --workspace parser\s+2m/u,
			"the job is under the agent's model row",
		);
		f.ui.selectIdentity("builder");
		await settle();
		assert.match(shown(f), /│ ● npm test --workspace parser\s+started 2m ago/u, "the pane names when it started");
	} finally {
		f.ui.dispose();
	}
});

it("a third running item turns the agent's second work row into a count", async () => {
	const items = [
		job("a", "first command", minutes(30)),
		job("b", "second command", minutes(20)),
		job("c", "third command", minutes(10)),
	];
	const f = fixture(140, 40, source([row("one", { name: "Many", state: "idle", activity: items })]));
	try {
		await settle();
		const screen = shown(f);
		assert.match(screen, /● first command\s+30m/u);
		assert.match(screen, /\+2 more running/u);
		assert.doesNotMatch(screen.split("│")[0] ?? "", /third command/u);
	} finally {
		f.ui.dispose();
	}
});

it("the Jobs tab joins the top rule with its count; j lists only the agents that run jobs and Escape returns", async () => {
	const f = fixture(140, 40, source(agents()));
	try {
		await settle();
		assert.match(visible(f)[0] ?? "", /─ Agents ─ Jobs 1 ─/u, "the tab names the reporting extension's work");
		assert.match(footer(f), /j jobs/u, "the key row offers the tab while jobs run");
		assert.match(shown(f), /Reader/u);
		f.ui.handleInput("j");
		await settle();
		assert.doesNotMatch(shown(f), /Reader/u, "agents without running work leave the list");
		assert.match(shown(f), /│ Builder/u, "the first agent that runs a job is selected");
		assert.match(footer(f), /esc agents/u);
		assert.doesNotMatch(footer(f), /j jobs/u, "the open tab offers no key to itself");
		f.ui.handleInput("\x1b");
		await settle();
		assert.match(shown(f), /Reader/u, "Escape lists every agent again");
		assert.match(shown(f), /│ Builder/u, "and the selection stays");
		const tab = point(f, "Jobs 1");
		click(f, tab.x + 1, tab.y);
		await settle();
		assert.doesNotMatch(shown(f), /Reader/u, "a click on the tab opens it");
		const agents = point(f, "Agents");
		click(f, agents.x + 1, agents.y);
		await settle();
		assert.match(shown(f), /Reader/u, "a click on Agents lists every agent");
	} finally {
		f.ui.dispose();
	}
});

it("Jobs shows reported work independently of the Agents filters and restores Find on return", async () => {
	const f = fixture(
		140,
		40,
		source([
			row("trace", {
				storageId: "trace",
				name: "Failure trace",
				state: "failed",
				error: "Connection lost",
				creatingOwnerId: "here",
			}),
			...agents(),
		]),
		undefined,
		undefined,
		undefined,
		"here",
	);
	try {
		await settle();
		assert.match(visible(f)[1] ?? "", /Related.*All/u);
		assert.doesNotMatch(shown(f), /Builder/u, "Builder is not in Related");
		f.ui.handleInput("/");
		f.ui.handleInput("Failure");
		f.ui.handleInput("\r");
		f.ui.handleInput("e");
		f.ui.handleInput("j");
		await settle();
		assert.match(shown(f), /Builder.*\n.*test\/model.*~\$0\.42/u);
		const lines = visible(f);
		assert.doesNotMatch(lines[1] ?? "", /Related|All|Failure/u);
		assert.doesNotMatch(lines[2] ?? "", /Recent \d/u);
		f.ui.handleInput("/");
		f.ui.handleInput("missing");
		f.ui.handleInput("\r");
		assert.match(shown(f), /No agent matches/u);
		f.ui.handleInput("\x1b");
		assert.match(shown(f), /Builder/u);
		f.ui.handleInput("\x1b");
		assert.match(visible(f)[1] ?? "", /Failure.*Related.*All/u);
		assert.match(shown(f), /Failure trace/u);
		assert.match(footer(f), /esc all agents/u, "the Agents error filter remains set");
		assert.doesNotMatch(shown(f), /Builder/u);
	} finally {
		f.ui.dispose();
	}
});

for (const [width, height, trigger] of [
	[80, 18, "key"],
	[140, 40, "click"],
] as const) {
	it(`the Jobs footer opens the selected agent's owner view by ${trigger} at ${width} columns`, async () => {
		const opened: string[] = [];
		const f = fixture(width, height, source(agents()), {
			panels: async (agent) => {
				opened.push(agent.id);
				return [
					{
						key: "stash",
						label: "Stashes",
						contribution: "stash",
						open: () => ({ title: "Stashes", render: () => [], handleInput: () => false }),
					},
					{
						key: "jobs",
						label: "Jobs",
						contribution: "jobs",
						open: () => ({ title: "Jobs", render: () => ["Job details"], handleInput: () => false }),
					},
				];
			},
		});
		try {
			await settle();
			f.ui.handleInput("l");
			f.ui.handleInput("\x1b");
			f.ui.handleInput("j");
			assert.match(shown(f), /Builder/u, "Jobs opens its list even when Agents hid it");
			const control = point(f, "j open jobs");
			if (trigger === "click") click(f, control.x, control.y);
			else f.ui.handleInput("j");
			await settle();
			assert.equal(f.ui.focus.inspector, "Jobs");
			assert.match(shown(f), /Job details/u);
			assert.deepEqual(opened, ["builder"]);
		} finally {
			f.ui.dispose();
		}
	});
}

it("the compact Jobs list shows a failed owner view read in the selected pane", async () => {
	const f = fixture(80, 18, source(agents()), { panels: async () => [] });
	try {
		await settle();
		f.ui.handleInput("j");
		assert.match(footer(f), /j open jobs/u);
		f.ui.handleInput("j");
		await settle();
		assert.match(shown(f), /host advertises no owner views/u);
		f.ui.handleInput("\x1b");
		assert.match(footer(f), /esc agents/u, "Escape returns to the Jobs list");
	} finally {
		f.ui.dispose();
	}
});

it("on the Jobs tab, an agent whose work ended stays selected and listed, without its work row", async () => {
	let rows = agents();
	let changed: (() => void) | undefined;
	const observed = {
		...source(rows),
		list: async () => page(rows),
		subscribeRoster: (listener: () => void) => {
			changed = listener;
			return () => {};
		},
	};
	const f = fixture(140, 40, observed);
	try {
		await settle();
		f.ui.handleInput("j");
		await settle();
		assert.match(shown(f), /● npm test --workspace parser/u);
		rows = rows.map((item) => (item.id === "builder" ? { ...item, activity: undefined } : item));
		changed?.();
		await new Promise((resolve) => setTimeout(resolve, 300));
		await settle();
		const screen = shown(f);
		assert.doesNotMatch(screen, /npm test --workspace parser/u, "the ended work leaves the list and the pane");
		assert.match(screen, /✓ Builder/u, "the selected agent stays listed");
		assert.match(visible(f)[0] ?? "", /─ Jobs ─/u, "the open tab stays, without a count");
		f.ui.handleInput("\x1b");
		await settle();
		assert.doesNotMatch(visible(f)[0] ?? "", /Jobs/u, "once left, the tab goes");
		assert.match(shown(f), /Reader/u);
	} finally {
		f.ui.dispose();
	}
});

it("without running work there is no Jobs tab and no key for it", async () => {
	const f = fixture(140, 40, source([row("one", { name: "Quiet", state: "idle" })]));
	try {
		await settle();
		assert.doesNotMatch(visible(f)[0] ?? "", /Jobs/u);
		assert.doesNotMatch(footer(f), /jobs/u);
		f.ui.handleInput("j");
		await settle();
		assert.match(shown(f), /Quiet/u, "j does nothing");
	} finally {
		f.ui.dispose();
	}
});

it("a click on running work in the pane opens the owner view of the extension that reports it", async () => {
	const view = (contribution: string, label: string): OwnerView => ({
		key: contribution,
		contribution,
		label,
		open: () => ({ title: label, render: (width) => [`${label} body`.padEnd(width)], handleInput: () => true }),
	});
	const f = fixture(140, 40, source(agents()), {
		panels: async () => [view("stash", "Stashes"), view("jobs", "Jobs")],
	});
	try {
		await settle();
		f.ui.selectIdentity("builder");
		await settle();
		const line = point(f, "started 2m ago");
		click(f, line.x, line.y);
		await settle();
		assert.equal(f.ui.focus.inspector, "Jobs", "the jobs view opens alone, without the list of views");
		assert.match(shown(f), /Jobs body/u);
		assert.deepEqual(f.calls, []);
	} finally {
		f.ui.dispose();
	}
});

it("More keeps to the actions that apply; Agent controls lists the rest", async () => {
	const f = fixture(140, 44, source([row("one", { name: "Idle one", state: "idle" })]), { panels: async () => [] });
	try {
		await settle();
		visible(f);
		f.ui.handleInput("x");
		let menu = shown(f);
		for (const entry of ["Configure", "Owner views", "Agent controls", "Fork, rewind, compact"])
			assert.match(menu, new RegExp(entry, "u"), entry);
		for (const entry of ["Fork  ", "Rewind", "Details", "Run command", "Work  ", "Tasks"])
			assert.doesNotMatch(menu, new RegExp(`\\s{2,}${entry}`, "u"), `${entry} stays under Agent controls`);
		f.ui.handleInput("\x1b");
		f.ui.handleInput("a");
		await settle();
		assert.equal(f.ui.focus.inspector, "Agent controls");
		menu = shown(f);
		for (const entry of [
			"Work",
			"Tasks",
			"Fork",
			"Rewind",
			"Compact",
			"Reset context",
			"Details",
			"Stop and release host",
		])
			assert.match(menu, new RegExp(entry, "u"), entry);
		assert.deepEqual(f.calls, [], "listing the controls sends nothing");
	} finally {
		f.ui.dispose();
	}
	const working = fixture(140, 44, source([row("one", { name: "Busy one", state: "working" })]));
	try {
		await settle();
		visible(working);
		working.ui.handleInput("x");
		const menu = shown(working);
		assert.doesNotMatch(menu, /Configure/u, "a working agent offers no Configure it would refuse");
		assert.match(menu, /Send as follow-up/u);
	} finally {
		working.ui.dispose();
	}
});

it("Work and Tasks stand on More while they apply", async () => {
	const f = fixture(
		140,
		44,
		source([row("one", { name: "Owes", state: "idle", openWorkCount: 1, attention: "task-blocked" })]),
	);
	try {
		await settle();
		visible(f);
		f.ui.handleInput("x");
		const menu = shown(f);
		assert.match(menu, /w\s+Work/u);
		assert.match(menu, /k\s+Tasks/u);
	} finally {
		f.ui.dispose();
	}
});
