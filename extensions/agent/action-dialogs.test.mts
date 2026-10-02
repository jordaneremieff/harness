import { createDashboardState } from "./dashboard-state.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { committedChoices, runActionDialog, scheduleDeadline, hideAround } from "./action-dialogs.ts";
import { row, source } from "./dashboard-test-fixture.mts";
it("stop, reset, rewind, and compact use a target-bound Cancel-first picker", async () => {
	for (const name of ["abort", "reset", "compact", "rewind"]) {
		let calls = 0;
		const titles: string[] = [];
		const ctx = {
			ui: {
				editor: async () => "handoff",
				select: async (title: string, choices: string[]) => {
					titles.push(title);
					if (title === "Choose a committed message") return choices[0];
					assert.equal(choices[0], "Cancel");
					return undefined;
				},
			},
		} as unknown as ExtensionContext;
		await runActionDialog(
			name,
			row(),
			ctx,
			[
				{
					name,
					description: name,
					args: [],
					run: async () => {
						calls++;
						return "bad";
					},
				},
			],
			source(),
			{ timers: async () => [], schedule: async () => ({ text: "bad" }) },
			createDashboardState(),
		);
		assert.equal(calls, 0);
		assert.ok(titles.some((title) => title.includes("storage:1")));
	}
});
it("entry choices exclude live IDs and include role and text", () => {
	assert.deepEqual(
		committedChoices([
			{ id: "live:generation", kind: "pi.assistant" },
			{ id: "7", kind: "pi.user", model: [{ role: "user", content: "task", timestamp: 0 }] },
		]),
		[{ id: "7", label: "You: task · 7" }],
	);
});
it("deadlines produce an exact ISO instant and reject invalid clocks", () => {
	const now = Date.parse("2026-10-03T10:00:00Z");
	assert.equal(scheduleDeadline("+30m", now), "2026-10-03T10:30:00.000Z");
	assert.throws(() => scheduleDeadline("24:90", now), /HH:MM/);
	assert.throws(() => scheduleDeadline("+0m", now), /future/);
});
it("native dialog visibility restores on failure", async () => {
	const states: boolean[] = [];
	await assert.rejects(
		hideAround({ hide: () => states.push(true), show: () => states.push(false) }, async () => {
			throw new Error("refused");
		}),
		/refused/,
	);
	assert.deepEqual(states, [true, false]);
});

it("ambiguous and nonexistent local deadlines require relative time", (t) => {
	const original = process.env.TZ;
	process.env.TZ = "America/New_York";
	t.after(() => {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	});
	assert.throws(() => scheduleDeadline("01:30", Date.parse("2026-11-01T04:00:00Z")), /two offsets/);
	assert.throws(() => scheduleDeadline("02:30", Date.parse("2026-03-08T05:00:00Z")), /does not exist/);
	assert.equal(scheduleDeadline("+90m", Date.parse("2026-11-01T04:00:00Z")), "2026-11-01T05:30:00.000Z");
});

it("schedule fields survive Cancel and host refusal and clear only on confirmation", async (t) => {
	t.mock.method(Date, "now", () => Date.parse("2026-10-03T10:00:00Z"));
	const state = createDashboardState();
	const target = row();
	const prefills: Array<string | undefined> = [];
	const inputs = ["+30m", "", ""];
	const selections = ["Steer", "Cancel", "Steer", "Schedule", "Steer", "Schedule"];
	const modes: string[][] = [];
	const requests: unknown[] = [];
	const ctx = {
		ui: {
			editor: async (_title: string, prefill?: string) => {
				prefills.push(prefill);
				return "Check later";
			},
			input: async () => inputs.shift(),
			select: async (title: string, choices: string[]) => {
				if (title === "Busy disposition") modes.push(choices);
				return selections.shift();
			},
		},
	} as unknown as ExtensionContext;
	const extras = {
		timers: async () => [],
		schedule: async (input: unknown) => {
			requests.push(input);
			if (requests.length === 1) throw new Error("refused");
			return { text: "Scheduled" };
		},
	};
	const run = () => runActionDialog("schedule", target, ctx, [], source(), extras, state);
	assert.equal(await run(), undefined);
	assert.equal(requests.length, 0);
	const saved = structuredClone(state.agents.get(target.id)?.schedule);
	assert.deepEqual(saved, {
		message: "Check later",
		time: "+30m",
		deadline: "2026-10-03T10:30:00.000Z",
		mode: "steer",
	});
	await assert.rejects(run(), /refused/);
	assert.deepEqual(state.agents.get(target.id)?.schedule, saved);
	assert.deepEqual(await run(), { text: "Scheduled" });
	assert.equal(state.agents.get(target.id)?.schedule, undefined);
	assert.deepEqual(prefills, ["", "Check later", "Check later"]);
	assert.deepEqual(modes, [
		["Follow-up", "Steer"],
		["Steer", "Follow-up"],
		["Steer", "Follow-up"],
	]);
	assert.deepEqual(requests, [
		{ sessionId: target.id, message: "Check later", deliverAt: "2026-10-03T10:30:00.000Z", mode: "steer" },
		{ sessionId: target.id, message: "Check later", deliverAt: "2026-10-03T10:30:00.000Z", mode: "steer" },
	]);
});
