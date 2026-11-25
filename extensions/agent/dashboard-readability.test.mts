import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { dashboardGeometry } from "./dashboard-layout.ts";
import { activityOf, argumentSummary, rosterLines, sessionAppearance } from "./dashboard-roster.ts";
import { conversationFrame, deferred, fixture, page, row, source, theme, turn } from "./dashboard-test-fixture.mts";
import { AgentManager } from "./manager.ts";

/** Visible text: styling and the zero-width cursor markers removed, so columns match the screen. */
const visible = (lines: string[]) =>
	lines.map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));

it("activity summarizes string arguments without raw JSON, including published partial arguments", () => {
	assert.equal(argumentSummary('{"count":1,"path":"notes.md","text":"other"}'), "notes.md");
	assert.equal(argumentSummary('{"text":"first\\n second"'), "first second");
	assert.equal(argumentSummary('{"count":1,"enabled":true}'), "");
	assert.equal(argumentSummary("notes.md"), "notes.md");
	const agent = row("worker", { currentTool: { name: "any_tool", argument: '{"content":"review the notes"}' } });
	assert.equal(activityOf(agent), "any_tool review the notes");
	assert.doesNotMatch(activityOf(agent), /[{}]/);
});
it("working roster rows show identity, model, cost and current activity without the handle", () => {
	const agent = row("worker", {
		name: "Research",
		modifiedAt: 0,
		currentTool: { name: "read", argument: "notes.md" },
		profile: {
			identity: "worker",
			role: "Research",
			handle: "@research",
			revision: "1",
			hasExpertise: false,
			updatedAt: 0,
		},
	});
	const lines = rosterLines([agent], agent.id, 64, 12, 15 * 60000, theme);
	assert.match(lines[1] ?? "", /● Research/);
	assert.match(lines[2] ?? "", /test\/model \[high\].*~\$0\.42/);
	assert.match(lines[3] ?? "", /read notes\.md/);
	assert.doesNotMatch(lines.join("\n"), /@research · Research|15m ago/);
	assert.ok(dashboardGeometry(160, 45, 3).rosterWidth <= 60);
	const compact = rosterLines(
		[row("worker", { name: "Work", currentTool: { name: "read", argument: "file" } })],
		"worker",
		100,
		5,
		0,
		theme,
	).join("\n");
	assert.match(compact, /Work/);
	assert.match(compact, /test\/model \[high\]/);
	assert.match(compact, /read file/);
	assert.doesNotMatch(compact, /just now/);
});
it("selected status uses the same state labels as the roster", async () => {
	for (const state of Object.keys(sessionAppearance) as Array<keyof typeof sessionAppearance>) {
		const f = fixture(100, 30, source([row("one", { state })]));
		try {
			await turn();
			const lines = f.ui.render(100);
			assert.ok(lines[1]?.includes(`${sessionAppearance[state].glyph} ${sessionAppearance[state].label}`));
		} finally {
			f.ui.dispose();
		}
	}
});
for (const [width, skipped] of [
	[164, 18],
	[164, 0],
	[100, 18],
	[100, 0],
	[80, 18],
	[80, 0],
]) {
	it(`list coverage stays out of the target header at ${width} with ${skipped} unreadable`, async () => {
		const observed = source(Array.from({ length: 31 }, (_, index) => row(String(index))));
		const list = observed.list;
		observed.list = async (input) => {
			const result = await list(input);
			return {
				...result,
				coverage: { ...result.coverage, complete: false, skipped, nextCursor: skipped ? "more" : null },
			};
		};
		const f = fixture(width, 30, observed);
		const read = () => visible(f.ui.render(width));
		try {
			await turn();
			await turn();
			const lines = read();
			const wide = width >= 100;
			const paneX = wide ? (lines[1]?.indexOf("│") ?? 0) + 1 : 0;
			const headerY = wide ? 1 : 9;
			const header = lines.slice(headerY, headerY + 3).map((line) => line.slice(paneX));
			assert.doesNotMatch(header.join("\n"), /coverage|unreadable|omitted|incomplete/i);
			assert.match(header[0] ?? "", /^ 0 +● Working\s*$/u, "the name is left-aligned and the state is right-aligned");
			assert.match(header[1] ?? "", /test\/model.*~\$0\.42.*\/work/);
			assert.equal((header[2] ?? "").trim(), "", "one blank row follows the header");
			assert.doesNotMatch(header[0] ?? "", /work|ago|\$/u);
			const roster = wide ? lines.slice(1).map((line) => line.slice(0, paneX - 1)) : lines.slice(1, 9);
			assert.doesNotMatch(roster.join("\n"), /unreadable|omitted|incomplete/, "storage coverage stays in Details");
			if (skipped) assert.match(roster.join("\n"), /Load mo/);
			f.ui.handleInput("\r");
			assert.doesNotMatch(
				read()
					.slice(headerY, headerY + 2)
					.map((line) => line.slice(paneX))
					.join("\n"),
				/coverage|unreadable|incomplete/i,
			);
		} finally {
			f.ui.dispose();
		}
	});
}

it("live usage sits under the target header and receipts stay on the message field", async () => {
	const usage = {
		input: 100,
		output: 20,
		cacheRead: 30,
		cacheWrite: 10,
		totalTokens: 160,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const initial = conversationFrame();
	const frame = conversationFrame({
		entries: [
			{
				id: "1",
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						api: "openai-responses",
						provider: "test",
						model: "model",
						content: [],
						timestamp: 0,
						stopReason: "stop",
						usage,
					},
				],
			},
		],
		status: { ...initial.status, usage: { models: { "test/model": usage }, tools: {} } },
	});
	const observed = source([row("one")]);
	observed.frame = () => frame;
	observed.availability = () => ({ state: "live", at: frame.observedAt });
	const f = fixture(160, 45, observed, {
		modelInfo: () => ({ name: "Example model", reasoning: true, contextWindow: 1000 }),
		sessionFigures: async () => "agents: 1/1 · ~$0.42",
	});
	try {
		await turn();
		await turn();
		const state = f.state.agents.get("one");
		assert.ok(state);
		state.receipt = "Message admitted";
		f.ui.handleInput("\r");
		const lines = visible(f.ui.render(160));
		assert.match(lines[0] ?? "", /agents: 1\/1 · ~\$0\.42/, "session figures sit in the heading");
		assert.doesNotMatch(lines[0] ?? "", /Close/u, "the heading holds no commands");
		assert.match((lines.at(-1) ?? "").trimEnd(), /esc done$/u, "the way out is the last footer control");
		const paneX = (lines[1]?.indexOf("│") ?? 0) + 1;
		const pane = lines.slice(1).map((line) => line.slice(paneX));
		assert.doesNotMatch(
			pane.slice(0, 3).join("\n"),
			/LIVE|RETAINED|Earlier messages available|Roster|Message admitted/,
		);
		assert.match(pane[0] ?? "", /^ one +● Working\s*$/u);
		assert.match(pane[1] ?? "", /test\/model \[high\].*16%.*160\/1\.0k.*~\$0\.42.*21% hit.*\/work/);
		assert.equal(pane[2]?.trim(), "");
		const caption = lines.find((line) => line.includes("╭─ To one"));
		assert.match(caption ?? "", /╭─ To one/);
		assert.doesNotMatch(caption ?? "", /Correction at next step|New message/);
		assert.doesNotMatch(caption ?? "", /%|\$|model|high|ctx/);
		assert.ok(
			lines.some((line) => line.includes("╰─ Message admitted")),
			"the receipt is on the message field's bottom border",
		);
	} finally {
		f.ui.dispose();
	}
});
it("dashboard reconciliation and roster events reuse the scanned page for session figures", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const root = mkdtempSync(join(tmpdir(), "dashboard-page-reuse-"));
	const manager = new AgentManager({ root, agentDir: join(root, "agent"), packageDir: join(root, "package") });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const record = manager.catalog.create({
		cwd: root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		model: { provider: "test", modelId: "model" },
		thinkingLevel: "high",
		ownerId: "primary",
	});
	const published = page([row(record.storageId, { storageId: record.storageId })]);
	// Session figures read ownership from the manager's observed inventory, so observe the record once before the page is stubbed.
	await manager.dashboardPage();
	let reads = 0;
	t.mock.method(manager, "dashboardPage", async () => {
		reads++;
		return published;
	});
	const observed = source(published.rows);
	observed.list = (input) => manager.dashboardPage(input);
	let changed = () => {};
	observed.subscribeRoster = (listener) => {
		changed = listener;
		return () => {};
	};
	const f = fixture(100, 30, observed, { sessionFigures: (roster) => manager.sessionFigures("primary", roster) });
	try {
		await turn();
		assert.equal(reads, 1);
		assert.match(f.ui.render(100)[0], /agents: 1\/1 · ~\$0.42/i);
		changed();
		t.mock.timers.tick(250);
		await turn();
		assert.equal(reads, 2, "the roster event performs one page read");
		t.mock.timers.tick(1750);
		await turn();
		assert.equal(reads, 3, "periodic reconciliation performs one page read");
	} finally {
		f.ui.dispose();
	}
});
it("a late session total read does not recreate the selection after close", async () => {
	const gate = deferred<string>();
	const f = fixture(100, 30, source(), { sessionFigures: () => gate.promise });
	await turn();
	f.ui.dispose();
	gate.resolve("agents: 1/1 · ~$0.42");
	await turn();
	assert.equal(f.state.selected, undefined);
	assert.equal(f.state.agents.size, 0);
});
it("failed list refresh keeps rows, suppresses transient errors and clears a persistent notice after success", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	let fail = false;
	let changed = () => {};
	const observed = source([row("good")]);
	observed.subscribeRoster = (listener) => {
		changed = listener;
		return () => {};
	};
	observed.list = async () => {
		if (fail) throw new Error("refresh failure");
		return page([row("good")]);
	};
	const f = fixture(100, 30, observed);
	const refresh = async () => {
		changed();
		t.mock.timers.tick(250);
		await turn();
	};
	try {
		await turn();
		fail = true;
		await refresh();
		assert.match(f.ui.render(100).join("\n"), /good/);
		assert.doesNotMatch(f.ui.render(100).join("\n"), /refresh failure/);
		await refresh();
		await refresh();
		const lines = visible(f.ui.render(100));
		const paneX = (lines[1]?.indexOf("│") ?? 0) + 1;
		assert.match(lines.map((line) => line.slice(0, paneX - 1)).join("\n"), /List kept; refresh failed/);
		assert.doesNotMatch(
			lines
				.slice(1, 5)
				.map((line) => line.slice(paneX))
				.join("\n"),
			/refresh failed|refresh failure/,
		);
		fail = false;
		await refresh();
		assert.doesNotMatch(f.ui.render(100).join("\n"), /refresh failed|refresh failure/);
	} finally {
		f.ui.dispose();
	}
});
