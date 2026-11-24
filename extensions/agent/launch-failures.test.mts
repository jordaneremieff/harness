import assert from "node:assert/strict";
import { it } from "node:test";
import { LaunchFailures } from "./launch-failures.ts";

function fixture(storages = 8) {
	let now = 1_000_000;
	const failures = new LaunchFailures({ limit: 3, windowMs: 60_000, storages, now: () => now });
	return { failures, advance: (ms: number) => (now += ms) };
}
const WAIT =
	"Recovery waits after 3 failed launches in 60 seconds; agent_attach or a primary registration tries at once. Last error: launch failed";

it("allows the limit of failed launches in one window and reports the error and the wait once each", () => {
	const { failures, advance } = fixture();
	assert.equal(failures.capped("storage"), false);
	assert.equal(failures.failed("storage", "launch failed"), "launch failed");
	advance(1000);
	assert.equal(failures.failed("storage", "launch failed"), undefined, "the same error is reported once");
	assert.equal(failures.capped("storage"), false, "a transient failure keeps its retries");
	advance(1000);
	assert.equal(failures.failed("storage", "launch failed"), WAIT);
	assert.equal(failures.capped("storage"), true);
	assert.equal(failures.failed("storage", "launch failed"), undefined, "an explicit launch that fails adds no report");
	assert.equal(failures.capped("other"), false, "each storage has its own window");
});

it("allows the next automatic launch when the oldest failure leaves the window, and reports a new window again", () => {
	const { failures, advance } = fixture();
	for (let index = 0; index < 3; index++) {
		failures.failed("storage", "launch failed");
		advance(10_000);
	}
	assert.equal(failures.capped("storage"), true);
	advance(29_999);
	assert.equal(failures.capped("storage"), true);
	advance(1);
	assert.equal(failures.capped("storage"), false, "the first failure is 60 seconds old");
	advance(60_000);
	assert.equal(failures.failed("storage", "launch failed"), "launch failed", "a new window reports its first failure");
});

it("forgets a cleared storage and keeps at most its bound of storages", () => {
	const { failures } = fixture(2);
	for (let index = 0; index < 3; index++) failures.failed("first", "launch failed");
	failures.clear("first");
	assert.equal(failures.capped("first"), false);
	for (const storage of ["a", "b", "c"]) for (let index = 0; index < 3; index++) failures.failed(storage, "x");
	assert.deepEqual(
		["a", "b", "c"].map((storage) => failures.capped(storage)),
		[false, true, true],
		"the storage that failed longest ago leaves first",
	);
});
