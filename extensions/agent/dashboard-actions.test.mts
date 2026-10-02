import assert from "node:assert/strict";
import { it } from "node:test";
import { dashboardActions } from "./dashboard-actions.ts";
import { row } from "./dashboard-test-fixture.mts";
it("actions contain only ordered selected-agent controls with reasons", () => {
	const choices = dashboardActions(row());
	assert.deepEqual(
		choices.map((choice) => choice.label),
		[
			"Stop current work",
			"Configure",
			"Tasks",
			"Fork",
			"Rewind",
			"Reset context",
			"Schedule message",
			"Scheduled messages",
			"Compact",
			"Reconnect",
			"Run agent command",
			"Details",
		],
	);
	assert.equal(choices[1].disabled, "Stop current work first");
	assert.ok(choices.every((choice) => choice.description));
	assert.equal(dashboardActions(row("one", { state: "idle" }))[0].disabled, "No current work");
	assert.equal(dashboardActions(row("one", { state: "unavailable" }))[9].disabled, undefined);
});
