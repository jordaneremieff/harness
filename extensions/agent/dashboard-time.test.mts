import assert from "node:assert/strict";
import { it } from "node:test";
import { dashboardTime } from "./dashboard-time.ts";

it("relative ages use minutes, hours and days without a seconds counter", () => {
	const now = 2 * 86400000;
	for (const [age, expected] of [[-1, "just now"], [0, "just now"], [59999, "just now"], [15 * 60000, "15m ago"], [3 * 3600000, "3h ago"], [86400000, "1d ago"]] as const) {
		assert.equal(dashboardTime(now - age, false, now), expected);
	}
});
it("absolute times use only the local calendar date and minute", () => {
	const at = new Date(2026, 9, 4, 12, 1, 19, 123).getTime();
	assert.equal(dashboardTime(at, true), "Oct 4, 2026, 12:01 PM");
});
