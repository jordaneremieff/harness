import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_LIMIT, CheckStreak, callsNoTool, isJobRead, refusedCheck, runningNextStep } from "./next-step.ts";

test("a streak counts checks per job until other work ends it", () => {
	const streak = new CheckStreak();
	assert.equal(streak.empty, true);
	assert.deepEqual([streak.check("a"), streak.check("b"), streak.check("a"), streak.check("a")], [1, 1, 2, 3]);
	streak.forget("a");
	assert.equal(streak.check("a"), 1, "a settled job's checks no longer count");
	assert.equal(streak.check("b"), 2);
	streak.end();
	assert.equal(streak.empty, true);
	assert.equal(streak.check("b"), 1);
});

test("only status, logs and list calls of jobs are reads, and only a reply that calls no tool is an answer", () => {
	for (const action of ["status", "logs", "list"]) assert.equal(isJobRead("jobs", { action, id: "1" }), true, action);
	assert.equal(isJobRead("jobs", { action: "cancel", id: "1" }), false, "cancellation is work");
	assert.equal(isJobRead("bash", { action: "status" }), false);
	assert.equal(isJobRead("jobs", undefined), false);

	const read = { type: "toolCall", id: "1", name: "jobs", arguments: { action: "status", id: "1" } };
	assert.equal(callsNoTool([{ type: "thinking", thinking: "" }, read]), false);
	assert.equal(callsNoTool([read, { type: "toolCall", id: "2", name: "read", arguments: { path: "a" } }]), false);
	assert.equal(callsNoTool([{ type: "text", text: "Done." }]), true);
	assert.equal(callsNoTool("Done."), true);
});

test("the texts name the check in a row, the refused limit, the next step of each route and a job that never exits", () => {
	assert.equal(CHECK_LIMIT, 3);
	assert.equal(
		runningNextStep("7", 2, "turn"),
		"This is check 2 of job 7 in a row while it runs, and check 3 in a row is refused. If you are waiting for it to finish, stop checking: its completion message arrives only after your turn ends. Continue other ready work; if none is ready, call jobs_yield now, and the completion starts your next turn.",
	);
	assert.equal(
		refusedCheck("7", 4, "run"),
		"Refused: this would be check 4 of job 7 in a row while it runs, and checks in a row only hold the run open as a timed wait. This call returns nothing. Its completion arrives as a new input only after this run ends. Continue other ready work; if none is ready, end this run now, and the completion starts the next run. A job that never exits, such as a server, sends no completion: to wait for a condition such as its readiness, start a finite job that exits once the condition holds.",
	);
});
