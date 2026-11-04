import assert from "node:assert/strict";
import { it } from "node:test";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import { TerminalProgramStatus, type TerminalActivity } from "./terminal-status.ts";

it("terminal activity deduplicates live facts and clears on target change, loss and disposal", () => {
	const output: ProgramStatus[] = [];
	const projection = new TerminalProgramStatus((status) => output.push(status));
	let activity: TerminalActivity = { target: "a", revision: 1, live: true, busy: true, interaction: false };
	projection.update(activity); projection.update(activity);
	assert.deepEqual(output.map((item) => item.state), ["clear", "working"]);
	activity = { ...activity, busy: false }; projection.update(activity);
	assert.equal(output.at(-1)?.state, "idle");
	activity = { ...activity, target: "b", revision: 2, busy: true }; projection.update(activity);
	assert.deepEqual(output.slice(-2).map((item) => item.state), ["clear", "working"]);
	projection.update({ ...activity, live: false });
	assert.equal(output.at(-1)?.state, "clear");
	projection.update(activity); projection.dispose(); projection.dispose(); projection.update(activity);
	assert.deepEqual(output.slice(-2).map((item) => item.state), ["working", "clear"]);
	assert.equal(output.some((item) => item.state === "done" || item.state === "error"), false);
});

it("only a terminal-local question reports blocked, with no target or content disclosure", () => {
	const output: ProgramStatus[] = [];
	const projection = new TerminalProgramStatus((status) => output.push(status));
	const activity: TerminalActivity = { target: "private-target", revision: 1, live: true, busy: true, interaction: true };
	projection.update(activity);
	assert.deepEqual(output.at(-1), { state: "blocked", app: "pi-agent", kind: "question", message: "Answer the terminal dialog" });
	projection.update({ ...activity, interaction: true, dialog: "Choose a browser\x1b[2J" });
	assert.deepEqual(output.at(-1), { state: "blocked", app: "pi-agent", kind: "question", message: "Answer: Choose a browser [2J" });
	projection.update({ ...activity, interaction: false });
	assert.deepEqual(output.at(-1), { state: "working", app: "pi-agent" }, "without an observed name the status carries no message");
	assert.doesNotMatch(JSON.stringify(output), /private-target/);
	projection.dispose();
});

it("the window title names the attached conversation and its folder, and clears on loss, detach and disposal", () => {
	const output: ProgramStatus[] = [];
	const titles: string[] = [];
	const projection = new TerminalProgramStatus((status) => output.push(status), (title) => titles.push(title));
	const activity: TerminalActivity = { target: "a", revision: 1, live: true, busy: false, interaction: false, name: "Parser\nreview\x07", cwd: "/work/projects/harness" };
	projection.update(activity); projection.update(activity);
	assert.deepEqual(titles, ["Parser review · harness"], "one title per change, control characters removed");
	assert.deepEqual(output.at(-1), { state: "idle", app: "pi-agent", message: "Parser review" });
	projection.update({ ...activity, busy: true });
	assert.deepEqual(output.at(-1), { state: "working", app: "pi-agent", message: "Parser review" });
	projection.update({ ...activity, live: false });
	assert.equal(titles.at(-1), "");
	assert.equal(output.at(-1)?.state, "clear");
	projection.update({ ...activity, name: "Renamed" });
	assert.equal(titles.at(-1), "Renamed · harness");
	projection.update({ target: undefined, revision: 2, live: false, interaction: false });
	assert.equal(titles.at(-1), "");
	projection.update({ ...activity, revision: 3 });
	assert.equal(titles.at(-1), "Parser review · harness");
	projection.dispose();
	assert.equal(titles.at(-1), "");
	assert.equal(output.at(-1)?.state, "clear");
});
