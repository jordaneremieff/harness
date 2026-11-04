import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { NavigationFrame } from "../../operator-ui/index.ts";
import { actionView, deliveryText, scheduleDeadline, type ActionResult, type AgentFormHost } from "./agent-forms.ts";
import { agentState, createDashboardState } from "./dashboard-state.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import type { AwaitFact } from "./await-facts.ts";
import type { AgentProfile } from "./profile-schema.ts";
import type { TimerListRow } from "./durable-timers.ts";
import { formsHost, row, source, theme, turn, type FormCall } from "./dashboard-test-fixture.mts";

const ENTER = "\r";
const DOWN = "\u001b[B";
const TAB = "\t";
const ESCAPE = "\u001b";

/** One agent form mounted in a frame, as the work view's inspector mounts it. */
function mount(name: string, host: AgentFormHost) {
	let closes = 0;
	const frame = new NavigationFrame({
		theme,
		target: { id: host.row.id, label: "Target" },
		destinations: () => [{ key: name, label: name, open: (view) => actionView(name, host, view) }],
		rows: () => 30,
		requestRender: () => {},
		close: () => {
			closes++;
		},
	});
	return { frame, closes: () => closes };
}

interface Setup {
	readonly target?: AgentConversationSummary;
	readonly patch?: Partial<AgentFormHost>;
	readonly answer?: (call: FormCall) => Promise<ActionResult>;
}

function setup(options: Setup = {}) {
	const target = options.target ?? row("storage:1", { name: "Parser review", state: "idle" });
	const state = createDashboardState();
	const calls: FormCall[] = [];
	const outcomes: Array<{ name: string; result: ActionResult }> = [];
	const host = formsHost(target, state, source([target]), calls, { outcome: (result, name) => outcomes.push({ name, result }), ...options.patch }, options.answer);
	return { target, state, calls, outcomes, host };
}

const text = (frame: NavigationFrame, width = 100) => frame.render(width).map(stripVTControlCharacters).join("\n");

async function until(frame: NavigationFrame, pattern: RegExp, width = 100): Promise<string> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const shown = text(frame, width);
		if (pattern.test(shown)) return shown;
		await turn();
	}
	throw new Error(`the form never showed ${pattern}\n${text(frame)}`);
}

function act(frame: NavigationFrame, label: string): void {
	const action = frame.viewActions.find((candidate) => candidate.label === label);
	assert.ok(action, `no action ${label}: ${frame.viewActions.map((candidate) => candidate.label).join(", ")}`);
	assert.equal(action.disabled, undefined, `${label} is unavailable: ${action.disabled}`);
	action.run();
}

function type(frame: NavigationFrame, value: string): void {
	for (const character of value) frame.handleInput(character);
}

it("configure sends only the changed fields on Apply and refuses an unchanged form before any request", async () => {
	const s = setup();
	const { frame, closes } = mount("configure", s.host);
	await until(frame, /Configure Parser review/);
	act(frame, "Apply");
	await until(frame, /Nothing changed; edit a field or Cancel\./);
	assert.deepEqual(s.calls, []);
	type(frame, " v2");
	frame.handleInput(ENTER);
	type(frame, "other");
	act(frame, "Apply");
	await until(frame, /./);
	for (let attempt = 0; attempt < 20 && !closes(); attempt++) await turn();
	assert.deepEqual(s.calls, [{ name: "configure", args: [JSON.stringify({ name: "Parser review v2", model: "test/other" })], target: "storage:1" }]);
	assert.deepEqual(s.outcomes, [{ name: "configure", result: "configure done" }]);
	assert.equal(closes(), 1, "success closes the form");
});

it("a refused Apply keeps every staged field and Apply sends the same patch again", async () => {
	let answers = 0;
	const s = setup({ answer: async (call) => (++answers === 1 ? Promise.reject(new Error("Stop current work first")) : `${call.name} done`) });
	const { frame, closes } = mount("configure", s.host);
	await until(frame, /Configure Parser review/);
	type(frame, " v2");
	act(frame, "Apply");
	const refused = await until(frame, /Stop current work first/);
	assert.match(refused, /Parser review v2/, "the staged name stays");
	act(frame, "Apply");
	for (let attempt = 0; attempt < 20 && !closes(); attempt++) await turn();
	assert.equal(s.calls.length, 2);
	assert.deepEqual(s.calls[1], s.calls[0], "the retry carries the same exact patch");
});

it("configure shows a model-list failure in place and never offers a typed model instead", async () => {
	const s = setup({ patch: { models: async () => Promise.reject(new Error("host offline")) } });
	const { frame } = mount("configure", s.host);
	const shown = await until(frame, /Could not read what this view needs: host offline/);
	assert.doesNotMatch(shown, /Apply/);
	assert.deepEqual(frame.viewActions.map((action) => action.label), []);
	assert.deepEqual(s.calls, []);
});

it("a current model the host does not list stays choosable and an unnamed agent is named by its first task", async () => {
	const target = row("storage:7", { name: undefined, firstMessage: "Check the parser edge cases", state: "idle", model: { provider: "old", modelId: "legacy", thinkingLevel: "high" } });
	const s = setup({ target });
	const { frame } = mount("configure", s.host);
	await until(frame, /Configure Check the parser edge cases/);
	frame.handleInput(ENTER);
	assert.match(text(frame), /old\/legacy {2}current · not listed by the host/);
	assert.match(text(frame), /Name +blank clears the name/, "the unfocused empty name explains itself");
});

it("fork starts from the latest committed entry unless a message is chosen", async () => {
	for (const choose of [false, true]) {
		const s = setup();
		const { frame, closes } = mount("fork", s.host);
		await until(frame, /Latest committed entry/);
		assert.match(text(frame), /You: Check the task · 1/);
		if (choose) frame.handleInput(DOWN);
		act(frame, "Fork");
		for (let attempt = 0; attempt < 20 && !closes(); attempt++) await turn();
		assert.deepEqual(s.calls, [{ name: "fork", args: choose ? ["1"] : [], target: "storage:1" }]);
	}
});

it("rewind needs a correction, sends it with the chosen entry, and refuses a conversation without committed messages", async () => {
	const s = setup();
	const { frame, closes } = mount("rewind", s.host);
	await until(frame, /Rewind Parser review before a mistaken message/);
	act(frame, "Rewind");
	await until(frame, /Write the correction first\./);
	assert.deepEqual(s.calls, []);
	frame.handleInput(TAB);
	type(frame, "Use the other parser");
	act(frame, "Rewind");
	for (let attempt = 0; attempt < 20 && !closes(); attempt++) await turn();
	assert.deepEqual(s.calls, [{ name: "rewind", args: ["1", "Use the other parser"], target: "storage:1" }]);
	const empty = setup({ patch: { source: { ...source(), snapshot: async () => ({ entries: [], partial: false, revision: "0", nextBefore: null }) } } });
	const refused = mount("rewind", empty.host);
	await until(refused.frame, /No committed message is available to rewind before\./);
});

it("compact and reset send their optional text, and Cancel sends nothing", async () => {
	const cancelled = setup();
	const first = mount("reset", cancelled.host);
	await until(first.frame, /Reset the context of Parser review/);
	act(first.frame, "Cancel");
	assert.equal(first.closes(), 1);
	assert.deepEqual(cancelled.calls, []);
	for (const [name, typed, args] of [["compact", "Keep the API notes", ["Keep the API notes"]], ["reset", "", []]] as const) {
		const s = setup();
		const { frame, closes } = mount(name, s.host);
		await until(frame, name === "compact" ? /Compaction summarises the context at the next native boundary\. Active work and queued input continue\./ : /History, files, settings and timers stay/, 200);
		type(frame, typed);
		act(frame, name === "compact" ? "Compact" : "Reset context");
		for (let attempt = 0; attempt < 20 && !closes(); attempt++) await turn();
		assert.deepEqual(s.calls, [{ name, args: [...args], target: "storage:1" }]);
	}
});

it("run command lists the host's commands, accepts a typed name when the host lists none, and refuses an empty list", async () => {
	const listed = setup();
	const one = mount("command", listed.host);
	await until(one.frame, /Run a native command on Parser review/);
	assert.match(text(one.frame), /plan {2}Plan the work/);
	act(one.frame, "Run");
	for (let attempt = 0; attempt < 20 && !one.closes(); attempt++) await turn();
	assert.deepEqual(listed.calls, [{ name: "command", args: ["plan", ""], target: "storage:1" }]);
	const typed = setup({ patch: { commands: async () => undefined } });
	const two = mount("command", typed.host);
	await until(two.frame, /command name/);
	act(two.frame, "Run");
	await until(two.frame, /Choose or type a command\./);
	type(two.frame, "reload");
	act(two.frame, "Run");
	for (let attempt = 0; attempt < 20 && !two.closes(); attempt++) await turn();
	assert.deepEqual(typed.calls, [{ name: "command", args: ["reload", ""], target: "storage:1" }]);
	const none = setup({ patch: { commands: async () => [] } });
	await until(mount("command", none.host).frame, /This agent's host lists no native commands\./);
});

it("schedule shows the exact instant, keeps its draft across close and refusal, and clears it after success", async (t) => {
	const now = Date.parse("2026-10-03T10:00:00Z");
	t.mock.method(Date, "now", () => now);
	let answers = 0;
	const s = setup({ answer: async (call) => (call.name === "schedule" && ++answers === 1 ? Promise.reject(new Error("host stopped")) : `${call.name} done`) });
	const first = mount("schedule", s.host);
	await until(first.frame, /Schedule a message to Parser review/);
	type(first.frame, "Check later");
	first.frame.handleInput(TAB);
	type(first.frame, "25:00");
	assert.match(text(first.frame), /Delivers +Use HH:MM local or \+30m/);
	for (let index = 0; index < 5; index++) first.frame.handleInput("\u007f");
	type(first.frame, "+30m");
	assert.match(text(first.frame), /Delivers .*2026-10-03T10:30:00\.000Z/);
	first.frame.handleInput(ESCAPE);
	assert.equal(first.closes(), 1);
	assert.deepEqual(agentState(s.state, "storage:1").schedule, { message: "Check later", time: "+30m", mode: "followUp" });
	const second = mount("schedule", s.host);
	await until(second.frame, /Check later/);
	act(second.frame, "Schedule");
	await until(second.frame, /host stopped/);
	assert.ok(agentState(s.state, "storage:1").schedule, "a refusal keeps the draft");
	act(second.frame, "Schedule");
	for (let attempt = 0; attempt < 20 && !second.closes(); attempt++) await turn();
	assert.deepEqual(s.calls.at(-1), { name: "schedule", args: ["Check later", "2026-10-03T10:30:00.000Z", "followUp"], target: "storage:1" });
	assert.equal(agentState(s.state, "storage:1").schedule, undefined);
});

it("scheduled messages cancel only the chosen message and an empty list says so", async () => {
	const timer = { timerId: 7, deadline: Date.parse("2026-10-03T10:30:00Z"), status: "pending", messagePreview: "Check later" } as TimerListRow;
	const s = setup({ patch: { timers: async () => [timer, { ...timer, timerId: 8, messagePreview: "Second" }] } });
	const { frame, closes } = mount("timers", s.host);
	await until(frame, /Scheduled messages for Parser review/);
	frame.handleInput(DOWN);
	act(frame, "Cancel scheduled message");
	for (let attempt = 0; attempt < 20 && !closes(); attempt++) await turn();
	assert.deepEqual(s.calls, [{ name: "timer-cancel", args: ["8"], target: "storage:1" }]);
	await until(mount("timers", setup().host).frame, /No scheduled messages for Parser review\./);
});

const profile: AgentProfile = {
	identity: "storage:1", handle: "@history", name: "History expert", role: "Study decisions", expertise: "Sourced fact",
	revision: "a".repeat(64), updatedAt: 1, updatedBy: "editor", creator: "founder", model: { provider: "test", modelId: "model" }, thinkingLevel: "high", cwd: "/work", live: false, requests: [],
};

it("a profile draft survives a revision conflict and close until the current revision is chosen", async () => {
	let current = profile;
	const updates: Record<string, unknown>[] = [];
	const s = setup({
		patch: {
			profile: async (method, input) => {
				if (method === "profile-read") return current;
				updates.push(input);
				if (updates.length === 1) {
					current = { ...profile, role: "Concurrent role", revision: "b".repeat(64) };
					return { outcome: "conflict", deduped: false, profile: current };
				}
				return { outcome: "applied", deduped: false, profile: { ...current, role: String(input.role), revision: "c".repeat(64) } };
			},
		},
	});
	const first = mount("profile", s.host);
	await until(first.frame, /Profile: @history/);
	act(first.frame, "Edit role or expertise");
	type(first.frame, " now");
	act(first.frame, "Save");
	await until(first.frame, /The profile changed to revision b+\. Draft kept; read the current profile\./, 220);
	first.frame.handleInput(ESCAPE);
	first.frame.handleInput(ESCAPE);
	assert.equal(first.closes(), 1);
	const second = mount("profile", s.host);
	const reopened = await until(second.frame, /Draft role \(not saved\): Study decisions now/);
	assert.match(reopened, /Conflict: draft retained/);
	act(second.frame, "Read current profile");
	await until(second.frame, /Role: Concurrent role/);
	act(second.frame, "Use current revision for the draft");
	act(second.frame, "Continue editing");
	act(second.frame, "Save");
	await until(second.frame, /Profile: @history/);
	assert.equal(updates.length, 2, "Save never retries a conflict on its own");
	assert.equal(updates[0]?.expectedRevision, profile.revision);
	assert.equal(updates[1]?.expectedRevision, "b".repeat(64));
	assert.equal(updates[1]?.role, "Study decisions now");
	assert.equal(s.host.profileDrafts.size, 0, "a saved draft leaves");
});

it("details read the host status for the captured target", async () => {
	const s = setup({ patch: { status: async () => ({ identity: "storage:1", state: "idle" }) } });
	const shown = await until(mount("status", s.host).frame, /"state": "idle"/);
	assert.match(shown, /Identity: storage:1/);
	assert.match(shown, /Directory: \/work/);
});

it("stop, release, reconnect and release await act only on their labelled action", async () => {
	const awaiting = { runId: 4 } as AwaitFact;
	for (const [name, label, args] of [["abort", "Stop current work", []], ["release", "Stop and release host", []], ["attach", "Reconnect", []], ["await-release", "Release await", ["4"]]] as const) {
		const cancelled = setup({ target: row("storage:1", { name: "Parser review", awaiting }) });
		const first = mount(name, cancelled.host);
		act(first.frame, "Cancel");
		assert.deepEqual(cancelled.calls, [], `${name} Cancel sends nothing`);
		const s = setup({ target: row("storage:1", { name: "Parser review", awaiting }) });
		const { frame, closes } = mount(name, s.host);
		act(frame, label);
		for (let attempt = 0; attempt < 20 && !closes(); attempt++) await turn();
		assert.deepEqual(s.calls, [{ name, args: [...args], target: "storage:1" }]);
	}
});

it("deadlines name an exact instant and refuse invalid or past clocks", () => {
	const now = Date.parse("2026-10-03T10:00:00Z");
	assert.equal(scheduleDeadline("+30m", now), "2026-10-03T10:30:00.000Z");
	assert.equal(scheduleDeadline("+2h", now), "2026-10-03T12:00:00.000Z");
	assert.throws(() => scheduleDeadline("24:90", now), /HH:MM/);
	assert.throws(() => scheduleDeadline("+0m", now), /future/);
	assert.equal(deliveryText("", now), "Type HH:MM local or +30m");
	assert.equal(deliveryText("soon", now), "Use HH:MM local or +30m");
	assert.match(deliveryText("+30m", now), /2026-10-03T10:30:00\.000Z$/);
});

it("ambiguous and nonexistent local deadlines require a relative time", (t) => {
	const original = process.env.TZ;
	process.env.TZ = "America/New_York";
	t.after(() => {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	});
	assert.throws(() => scheduleDeadline("01:30", Date.parse("2026-11-01T04:00:00Z")), /two offsets/);
	assert.throws(() => scheduleDeadline("02:30", Date.parse("2026-03-08T05:00:00Z")), /does not exist/);
	assert.equal(scheduleDeadline("+90m", Date.parse("2026-11-01T04:00:00Z")), "2026-11-01T05:30:00.000Z");
	assert.equal(scheduleDeadline("09:15", Date.parse("2026-11-02T15:00:00Z")), "2026-11-03T14:15:00.000Z", "a past clock today means tomorrow");
});
