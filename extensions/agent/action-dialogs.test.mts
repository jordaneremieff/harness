import { createDashboardState } from "./dashboard-state.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { committedChoices, runActionDialog, scheduleDeadline, hideAround } from "./action-dialogs.ts";
import { row, source } from "./dashboard-test-fixture.mts";

function dialogScript(responses: Array<string | undefined>) {
	const calls: Array<{ kind: string; title: string; value?: string | string[] }> = [];
	const next = (kind: string, title: string, value?: string | string[]) => {
		calls.push({ kind, title, value });
		assert.ok(responses.length, `Unexpected dialog: ${title}`);
		const response = responses.shift();
		return response === "timer choice" && Array.isArray(value) ? value[0] : response;
	};
	const ctx = {
		ui: {
			editor: async (title: string, prefill?: string) => next("editor", title, prefill),
			input: async (title: string, placeholder?: string) => next("input", title, placeholder),
			select: async (title: string, choices: string[]) => next("select", title, choices),
		},
	} as unknown as ExtensionContext;
	return { calls, ctx, responses };
}

for (const name of ["reset", "compact"]) {
	it(`${name} returns from confirmation to the completed field before mutation`, async () => {
		const script = dialogScript(["handoff", "Cancel", "corrected", name === "reset" ? "Reset context" : "Compact"]);
		let mutations = 0;
		const result = await runActionDialog(
			name,
			row(),
			script.ctx,
			[
				{
					name,
					description: name,
					args: [],
					run: async (args) => {
						assert.equal(script.calls.length, 4);
						assert.deepEqual(args, [row().id, "corrected"]);
						mutations++;
						return "done";
					},
				},
			],
			source(),
			{ timers: async () => [], schedule: async () => ({ text: "bad" }) },
			createDashboardState(),
		);
		assert.equal(result, "done");
		assert.equal(mutations, 1);
		assert.equal(script.calls[2]?.value, "handoff");
		assert.equal(script.calls[0]?.title, script.calls[2]?.title);
		assert.deepEqual(script.calls[1]?.value, ["Cancel", name === "reset" ? "Reset context" : "Compact"]);
	});
}

const entryLabel = "You: task · 1";
const flows = [
	{ name: "reset", values: ["handoff"], confirmation: "Reset context", kinds: ["editor"] },
	{ name: "compact", values: ["instructions"], confirmation: "Compact", kinds: ["editor"] },
	{ name: "rewind", values: [entryLabel, "correction"], confirmation: "Rewind", kinds: ["select", "editor"] },
	{ name: "command", values: ["inspect", "arguments"], confirmation: "Run", kinds: ["input", "input"] },
	{
		name: "schedule",
		values: ["message", "+30m", "Steer"],
		confirmation: "Schedule",
		kinds: ["editor", "input", "select"],
	},
	{ name: "timers", values: ["timer choice"], confirmation: "Cancel scheduled message", kinds: ["select"] },
];
for (const flow of flows) {
	for (let cancel = 0; cancel <= flow.values.length; cancel++) {
		it(`${flow.name} cancellation at step ${cancel + 1} returns one step without mutation`, async () => {
			const responses: Array<string | undefined> = [...flow.values.slice(0, cancel), undefined];
			for (let step = cancel - 1; step >= 0; step--) responses.push(undefined);
			const script = dialogScript(responses);
			const snapshotSource = source();
			snapshotSource.snapshot = async () => ({
				entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: "task", timestamp: 0 }] }],
				partial: false,
				revision: "1",
				nextBefore: null,
			});
			let mutations = 0;
			const result = await runActionDialog(
				flow.name,
				row(),
				script.ctx,
				[
					{
						name: flow.name,
						description: flow.name,
						args: [],
						run: async () => {
							mutations++;
							return "bad";
						},
					},
				],
				snapshotSource,
				{
					timers: async () => [
						{
							timerId: 1,
							scheduleId: "schedule",
							conversationId: 1,
							identity: row().id,
							deadline: Date.parse("2026-10-03T10:30:00Z"),
							status: "pending",
							live: true,
							messagePreview: "message",
							mode: "followUp",
							origin: "operator",
							ownerId: "owner",
							requestId: "request",
							createdAt: 0,
							firedAt: null,
							overdueMs: null,
							submissionId: null,
							settledAt: null,
						},
					],
					schedule: async () => {
						mutations++;
						return { text: "bad" };
					},
				},
				createDashboardState(),
			);
			assert.equal(result, undefined);
			assert.equal(mutations, 0);
			assert.equal(script.responses.length, 0);
			assert.deepEqual(
				script.calls.map((call) => call.kind),
				[
					...flow.kinds.slice(0, cancel),
					cancel === flow.values.length ? "select" : flow.kinds[cancel],
					...flow.kinds.slice(0, cancel).reverse(),
				],
			);
			for (let step = 0; step < cancel; step++) {
				const revisited = script.calls[script.calls.length - 1 - step];
				assert.equal(revisited?.title.split("\n")[0], script.calls[step]?.title.split("\n")[0]);
				if (flow.kinds[step] === "editor") assert.equal(revisited?.value, flow.values[step]);
				if (flow.kinds[step] === "input")
					assert.match(String(revisited?.value), new RegExp(String(flow.values[step]).replace("+", "\\+")));
			}
		});
	}
}

it("rewind retains correction across entry reselection and admits only the confirmed target", async () => {
	const script = dialogScript([
		"You: Check the task · 1",
		"correction",
		"Cancel",
		undefined,
		"You: Check the task · 1",
		"revised correction",
		"Rewind",
	]);
	let mutations = 0;
	const result = await runActionDialog(
		"rewind",
		row(),
		script.ctx,
		[
			{
				name: "rewind",
				description: "Rewind",
				args: [],
				run: async (args) => {
					assert.equal(script.calls.length, 7);
					assert.deepEqual(args, [row().id, "1", "revised correction"]);
					mutations++;
					return "rewound";
				},
			},
		],
		source(),
		{ timers: async () => [], schedule: async () => ({ text: "bad" }) },
		createDashboardState(),
	);
	assert.equal(result, "rewound");
	assert.equal(mutations, 1);
	assert.equal(script.calls[3]?.value, "correction");
	assert.equal(script.calls[5]?.value, "correction");
});
it("rewind restores the chosen earlier page after cancellation from correction", async () => {
	const script = dialogScript(["Earlier messages", "You: older · 0", undefined, undefined]);
	const observed = source();
	const snapshot = await observed.snapshot(row().id);
	const earlier = await observed.earlier(row().id, 1);
	observed.snapshot = async () => ({ ...snapshot, nextBefore: 1 });
	observed.earlier = async () => ({
		...earlier,
		entries: [{ id: "0", kind: "pi.user", model: [{ role: "user", content: "older", timestamp: 0 }] }],
	});
	await runActionDialog(
		"rewind",
		row(),
		script.ctx,
		[],
		observed,
		{ timers: async () => [], schedule: async () => ({ text: "bad" }) },
		createDashboardState(),
	);
	assert.deepEqual(script.calls[3]?.value, ["You: older · 0"]);
});
it("command blank inputs retain completed arguments after confirmation cancellation", async () => {
	const script = dialogScript(["inspect", "arguments", "Cancel", undefined, "", "", "Run"]);
	const result = await runActionDialog(
		"command",
		row(),
		script.ctx,
		[
			{
				name: "command",
				description: "Command",
				args: [],
				run: async (args) => {
					assert.equal(script.calls.length, 7);
					assert.deepEqual(args, [row().id, "inspect", "arguments"]);
					return "done";
				},
			},
		],
		source(),
		{ timers: async () => [], schedule: async () => ({ text: "bad" }) },
		createDashboardState(),
	);
	assert.equal(result, "done");
	assert.equal(script.calls[3]?.value, "Saved: arguments (blank keeps it)");
	assert.equal(script.calls[4]?.value, "Saved: inspect (blank keeps it)");
	assert.match(String(script.calls[3]?.title), /Saved: arguments/);
	assert.match(String(script.calls[4]?.title), /Saved: inspect/);
});
it("stop uses a target-bound Cancel-first picker and does not mutate on Escape", async () => {
	const script = dialogScript([undefined]);
	let mutations = 0;
	await runActionDialog(
		"abort",
		row(),
		script.ctx,
		[
			{
				name: "abort",
				description: "Stop",
				args: [],
				run: async () => {
					mutations++;
					return "bad";
				},
			},
		],
		source(),
		{ timers: async () => [], schedule: async () => ({ text: "bad" }) },
		createDashboardState(),
	);
	assert.equal(mutations, 0);
	assert.match(String(script.calls[0]?.title), /storage:1/);
	assert.deepEqual(script.calls[0]?.value, ["Cancel", "Stop current work"]);
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
it("schedule retains exact deadline through back, Cancel and refusal, then clears after success", async (t) => {
	t.mock.method(Date, "now", () => Date.parse("2026-10-03T10:00:00Z"));
	const state = createDashboardState();
	const target = row();
	const first = dialogScript(["Check later", "+30m", "Steer", "Cancel", undefined, undefined, undefined]);
	let requests = 0;
	const extras = {
		timers: async () => [],
		schedule: async () => {
			requests++;
			throw new Error("refused");
		},
	};
	assert.equal(await runActionDialog("schedule", target, first.ctx, [], source(), extras, state), undefined);
	assert.equal(requests, 0);
	assert.match(String(first.calls[5]?.title), /Saved: \+30m/);
	const saved = structuredClone(state.agents.get(target.id)?.schedule);
	assert.deepEqual(saved, {
		message: "Check later",
		time: "+30m",
		deadline: "2026-10-03T10:30:00.000Z",
		mode: "steer",
	});
	const retry = dialogScript(["Check later", "", "Steer", "Schedule"]);
	await assert.rejects(runActionDialog("schedule", target, retry.ctx, [], source(), extras, state), /refused/);
	assert.deepEqual(state.agents.get(target.id)?.schedule, saved);
	const success = dialogScript(["Check later", "", "Steer", "Cancel", "Follow-up", "Schedule"]);
	const result = await runActionDialog(
		"schedule",
		target,
		success.ctx,
		[],
		source(),
		{
			...extras,
			schedule: async (input) => {
				assert.deepEqual(input, {
					sessionId: target.id,
					message: "Check later",
					deliverAt: saved?.deadline,
					mode: "followUp",
				});
				return { text: "Scheduled" };
			},
		},
		state,
	);
	assert.deepEqual(result, { text: "Scheduled" });
	assert.equal(state.agents.get(target.id)?.schedule, undefined);
});
