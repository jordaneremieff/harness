import assert from "node:assert/strict";
import { it } from "node:test";
import { LaunchFailures, LaunchReplay } from "./launch-failures.ts";

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

it("states when a waiting storage may launch again", () => {
	const { failures, advance } = fixture();
	failures.failed("storage", "launch failed");
	advance(5000);
	failures.failed("storage", "launch failed");
	assert.equal(failures.waitsUntil("storage"), undefined, "a storage inside its limit does not wait");
	advance(5000);
	failures.failed("storage", "launch failed");
	assert.equal(failures.waitsUntil("storage"), 1_000_000 + 60_000, "the oldest failure leaves the window then");
});

it("keeps one replay timer for a burst of requests and moves it forward for an earlier time", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
	let replays = 0;
	const replay = new LaunchReplay(() => replays++);
	for (let index = 0; index < 200; index++) replay.arm(1_060_000);
	replay.arm(1_090_000);
	t.mock.timers.tick(59_999);
	assert.equal(replays, 0);
	t.mock.timers.tick(1);
	assert.equal(replays, 1, "200 requests for one time replay once");
	t.mock.timers.tick(60_000);
	assert.equal(replays, 1, "the later request was covered by the pending replay");
	replay.arm(1_200_000);
	replay.arm(1_150_000);
	t.mock.timers.tick(30_000);
	assert.equal(replays, 2, "an earlier time replaces the pending one");
	t.mock.timers.tick(60_000);
	assert.equal(replays, 2);
});

it("replays nothing after its close", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
	let replays = 0;
	const replay = new LaunchReplay(() => replays++);
	replay.arm(1_060_000);
	replay.close();
	replay.arm(1_060_000);
	t.mock.timers.tick(120_000);
	assert.equal(replays, 0);
});
