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
	projection.update({ ...activity, interaction: false });
	assert.equal(output.at(-1)?.state, "working");
	assert.doesNotMatch(JSON.stringify(output), /private-target/);
	projection.dispose();
});
