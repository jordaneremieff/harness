import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { it } from "node:test";
import { CodemodeSandbox, type CodemodeRunOptions } from "@earendil-works/pi-codemode";
import { CodemodeWorkerQueue, QueuedCodemodeSandbox } from "./codemode-admission.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const runOptions = () => ({ startedAt: Date.now(), seed: 1, onCall: () => {} });
const admission = (deadline = Date.now() + 60_000, executionDeadline = Infinity) => ({ deadline: async () => deadline, admitted: async () => {}, now: Date.now, executionDeadline });
const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {});
parentPort.postMessage({type: "done", ok: true, value: '"ok"', writes: "[]"});`)}`);

for (const value of [undefined, "", "0", "-1", "1.5", "NaN", "Infinity", "invalid", "3"])
	it(`uses the process worker limit or the default for ${JSON.stringify(value)}`, async (t) => {
		const previous = process.env.PI_CODEMODE_MAX_WORKERS;
		t.after(() => { if (previous === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS; else process.env.PI_CODEMODE_MAX_WORKERS = previous; });
		if (value === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
		else process.env.PI_CODEMODE_MAX_WORKERS = value;
		const queue = new CodemodeWorkerQueue();
		const signal = new AbortController().signal;
		const deadline = Date.now() + 5000;
		const releases: (() => void)[] = [];
		for (let index = 0; index < (value === "3" ? 3 : 2); index++) releases.push(await queue.reserve(signal, deadline));
		let admitted = false;
		const pending = queue.reserve(signal, deadline).then((release) => { admitted = true; return release; });
		await nextTurn();
		assert.equal(admitted, false);
		const releaseFirst = releases.shift();
		assert.ok(releaseFirst);
		releaseFirst();
		(await pending)();
		for (const release of releases) release();
	});

it("reads changed process limits at admission without releasing live reservations", async (t) => {
	const previous = process.env.PI_CODEMODE_MAX_WORKERS;
	t.after(() => { if (previous === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS; else process.env.PI_CODEMODE_MAX_WORKERS = previous; });
	process.env.PI_CODEMODE_MAX_WORKERS = "1";
	const queue = new CodemodeWorkerQueue();
	const signal = new AbortController().signal;
	const deadline = Date.now() + 5000;
	const first = await queue.reserve(signal, deadline);
	const order: number[] = [];
	const second = queue.reserve(signal, deadline).then((release) => { order.push(2); return release; });
	process.env.PI_CODEMODE_MAX_WORKERS = "3";
	const third = await queue.reserve(signal, deadline);
	const releaseSecond = await second;
	assert.deepEqual(order, [2]);
	process.env.PI_CODEMODE_MAX_WORKERS = "1";
	let admitted = false;
	const fourth = queue.reserve(signal, deadline).then((release) => { admitted = true; return release; });
	first();
	releaseSecond();
	await nextTurn();
	assert.equal(admitted, false);
	third();
	(await fourth)();
});

it("admits worker reservations in FIFO order and removes cancelled waiters", async () => {
	const queue = new CodemodeWorkerQueue(1);
	const controller = new AbortController();
	const first = await queue.reserve(controller.signal, Date.now() + 5000);
	const cancelled = new AbortController();
	const second = queue.reserve(cancelled.signal, Date.now() + 5000);
	const failure = assert.rejects(second, /aborted/u);
	const order: number[] = [];
	const third = queue.reserve(controller.signal, Date.now() + 5000).then((release) => { order.push(3); return release; });
	const fourth = queue.reserve(controller.signal, Date.now() + 5000).then((release) => { order.push(4); return release; });
	cancelled.abort();
	await failure;
	first();
	const releaseThird = await third;
	assert.deepEqual(order, [3]);
	releaseThird();
	releaseThird();
	const releaseFourth = await fourth;
	assert.deepEqual(order, [3, 4]);
	releaseFourth();
});

it("bounds retained waiters and keeps FIFO order after a full-queue refusal", async () => {
	const queue = new CodemodeWorkerQueue(1, 2);
	const signal = new AbortController().signal;
	const deadline = Date.now() + 5000;
	const first = await queue.reserve(signal, deadline);
	const order: number[] = [];
	const second = queue.reserve(signal, deadline).then((release) => { order.push(2); return release; });
	const cancelled = new AbortController();
	const third = queue.reserve(cancelled.signal, deadline);
	const cancelledResult = assert.rejects(third, /aborted/u);
	await assert.rejects(queue.reserve(signal, deadline), /queue is full \(2 waiting calls\)/u);
	cancelled.abort();
	await cancelledResult;
	const replacement = queue.reserve(signal, deadline).then((release) => { order.push(4); return release; });
	first();
	const releaseSecond = await second;
	assert.deepEqual(order, [2]);
	releaseSecond();
	(await replacement)();
	assert.deepEqual(order, [2, 4]);
});

it("expires a persisted queue deadline without reserving capacity", async () => {
	const queue = new CodemodeWorkerQueue(1);
	const sandbox = new QueuedCodemodeSandbox(admission(Date.now() - 1), queue, { wasm: {}, workerUrl });
	const result = await sandbox.start("return 'never';", runOptions()).result;
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error.message, /timed out/u);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 1000);
	release();
	await sandbox.close();
});

it("debits the script deadline while queued and never launches an expired script", { timeout: 5000 }, async () => {
	const queue = new CodemodeWorkerQueue(1);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 5000);
	let launched = false;
	const sandbox = new QueuedCodemodeSandbox(admission(), queue, { wasm: {}, workerUrl, onWorkerStarted: () => { launched = true; } });
	const result = await sandbox.start("return 'never';", { ...runOptions(), timeoutMs: 20 }).result;
	assert.equal(result.ok, false);
	assert.equal(launched, false);
	release();
	await sandbox.close();
});

it("closes queued runs without waiting for occupied workers", async () => {
	const queue = new CodemodeWorkerQueue(1);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 5000);
	const sandbox = new QueuedCodemodeSandbox(admission(), queue);
	const run = sandbox.start("return 'never';", runOptions());
	await sandbox.close();
	const result = await run.result;
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "aborted");
	release();
});

it("holds capacity after result settlement until actual worker exit", { timeout: 5000 }, async (t) => {
	const queue = new CodemodeWorkerQueue(1);
	const terminate = Worker.prototype.terminate;
	const stopped = deferred<Worker>();
	t.mock.method(Worker.prototype, "terminate", function(this: Worker) { stopped.resolve(this); return new Promise<number>(() => {}); });
	const sandbox = new QueuedCodemodeSandbox(admission(), queue, { wasm: {}, workerUrl });
	const result = await sandbox.start("return 'ok';", runOptions()).result;
	assert.equal(result.ok, true);
	const worker = await stopped.promise;
	let admitted = false;
	const pending = queue.reserve(new AbortController().signal, Date.now() + 5000).then((release) => { admitted = true; return release; });
	await nextTurn();
	assert.equal(admitted, false);
	await terminate.call(worker);
	(await pending)();
	await sandbox.close();
});

it("fences late wasm launch after cancellation and returns the unclaimed reservation", { timeout: 5000 }, async () => {
	const queue = new CodemodeWorkerQueue(1);
	const wasm = deferred<object>();
	const admitted = deferred<void>();
	let launched = false;
	const sandbox = new QueuedCodemodeSandbox({ deadline: async () => Date.now() + 5000, admitted: async () => { admitted.resolve(); }, now: Date.now, executionDeadline: Infinity }, queue, { wasm: wasm.promise, workerUrl, onWorkerStarted: () => { launched = true; } });
	const controller = new AbortController();
	const run = sandbox.start("return 'never';", { ...runOptions(), signal: controller.signal });
	await admitted.promise;
	await nextTurn();
	controller.abort();
	const result = await run.result;
	assert.equal(result.ok, false);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 1000);
	wasm.resolve({});
	await nextTurn();
	await nextTurn();
	assert.equal(launched, false);
	release();
	await sandbox.close();
});

it("fences late wasm launch after the host closes", { timeout: 5000 }, async () => {
	const queue = new CodemodeWorkerQueue(1);
	const wasm = deferred<object>();
	const admitted = deferred<void>();
	let launched = false;
	const sandbox = new QueuedCodemodeSandbox({ deadline: async () => Date.now() + 5000, admitted: async () => { admitted.resolve(); }, now: Date.now, executionDeadline: Infinity }, queue, { wasm: wasm.promise, workerUrl, onWorkerStarted: () => { launched = true; } });
	const run = sandbox.start("return 'never';", runOptions());
	await admitted.promise;
	await nextTurn();
	await sandbox.close();
	const result = await run.result;
	assert.equal(result.ok, false);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 1000);
	wasm.resolve({});
	await nextTurn();
	await nextTurn();
	assert.equal(launched, false);
	release();
});

it("fences late wasm launch after the persisted script clock expires", { timeout: 5000 }, async () => {
	const queue = new CodemodeWorkerQueue(1);
	const wasm = deferred<object>();
	const admitted = deferred<void>();
	let clock = 1000;
	let launched = false;
	const sandbox = new QueuedCodemodeSandbox({
		deadline: async () => Date.now() + 5000,
		admitted: async () => { admitted.resolve(); },
		now: () => clock,
		executionDeadline: Infinity,
	}, queue, { wasm: wasm.promise, workerUrl, onWorkerStarted: () => { launched = true; } });
	const run = sandbox.start("return 'never';", { ...runOptions(), startedAt: 1000, timeoutMs: 2000 });
	await admitted.promise;
	await nextTurn();
	clock = 3001;
	wasm.resolve({});
	const result = await run.result;
	assert.equal(result.ok, false);
	assert.equal(launched, false);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 1000);
	release();
	await sandbox.close();
});

it("propagates admission storage failures and releases reserved capacity", async () => {
	const queue = new CodemodeWorkerQueue(1);
	const sandbox = new QueuedCodemodeSandbox({ deadline: async () => Date.now() + 5000, admitted: async () => { throw new Error("storage failed"); }, now: Date.now, executionDeadline: Infinity }, queue);
	await assert.rejects(sandbox.start("return 'never';", runOptions()).result, /storage failed/u);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 1000);
	release();
	await sandbox.close();
});

it("releases capacity after worker construction and wasm failures", { timeout: 5000 }, async () => {
	const queue = new CodemodeWorkerQueue(1);
	for (const options of [{ wasm: {}, workerUrl: "invalid-worker-path" }, { wasm: Promise.reject(new Error("wasm unavailable")) }]) {
		const sandbox = new QueuedCodemodeSandbox(admission(), queue, options);
		const result = await sandbox.start("return 'never';", runOptions()).result;
		assert.equal(result.ok, false);
		const release = await queue.reserve(new AbortController().signal, Date.now() + 1000);
		release();
		await sandbox.close();
	}
});

it("reports a full waiter queue with its stable failure code and state", async () => {
	const failures: unknown[] = [];
	const sandbox = new QueuedCodemodeSandbox(admission(), new CodemodeWorkerQueue(1, 0), {}, (failure) => failures.push(failure));
	const result = await sandbox.start("return 'never';", runOptions()).result;
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "sandbox");
	assert.deepEqual(failures, [{ code: "CODEMODE_QUEUE_FULL", message: "The codemode worker queue is full (0 waiting calls).", active: 0, waiting: 0, limit: 1 }]);
	await sandbox.close();
});

it("reports an expired admission deadline with its stable failure code and state", async () => {
	const failures: unknown[] = [];
	const sandbox = new QueuedCodemodeSandbox(admission(Date.now() - 1), new CodemodeWorkerQueue(1), {}, (failure) => failures.push(failure));
	const result = await sandbox.start("return 'never';", runOptions()).result;
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "timeout");
	assert.deepEqual(failures, [{ code: "CODEMODE_ADMISSION_TIMEOUT", message: "The codemode worker wait timed out.", active: 0, waiting: 1, limit: 1 }]);
	await sandbox.close();
});

it("reports a cancelled waiter immediately with its stable failure code and state", { timeout: 5000 }, async () => {
	const queue = new CodemodeWorkerQueue(1);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 5000);
	const failures: unknown[] = [];
	const sandbox = new QueuedCodemodeSandbox(admission(), queue, {}, (failure) => failures.push(failure));
	const controller = new AbortController();
	const run = sandbox.start("return 'never';", { ...runOptions(), signal: controller.signal });
	await nextTurn();
	controller.abort();
	const result = await run.result;
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "aborted");
	assert.deepEqual(failures, [{ code: "CODEMODE_CANCELLED", message: "The codemode worker wait was aborted.", active: 1, waiting: 1, limit: 1 }]);
	release();
	await sandbox.close();
});

it("reports no admission failure for a successful run or a storage failure", { timeout: 5000 }, async () => {
	const failures: unknown[] = [];
	const queue = new CodemodeWorkerQueue(1);
	const sandbox = new QueuedCodemodeSandbox(admission(), queue, { wasm: {}, workerUrl }, (failure) => failures.push(failure));
	assert.equal((await sandbox.start("return 'ok';", runOptions()).result).ok, true);
	await sandbox.close();
	const failing = new QueuedCodemodeSandbox({ deadline: async () => Date.now() + 5000, admitted: async () => { throw new Error("storage failed"); }, now: Date.now, executionDeadline: Infinity }, queue, {}, (failure) => failures.push(failure));
	await assert.rejects(failing.start("return 'never';", runOptions()).result, /storage failed/u);
	await failing.close();
	assert.deepEqual(failures, []);
});

it("refuses execution at start with a refusal found before the sandbox was requested", { timeout: 5000 }, async () => {
	const failures: unknown[] = [];
	let launched = false;
	const sandbox = new QueuedCodemodeSandbox({ ...admission(), refusal: { code: "CODEMODE_ADMISSION_TIMEOUT", message: "The codemode script timed out before worker admission." } }, new CodemodeWorkerQueue(1), { wasm: {}, workerUrl, onWorkerStarted: () => { launched = true; } }, (failure) => failures.push(failure));
	assert.deepEqual(failures, [], "constructing the sandbox reports nothing");
	const result = await sandbox.start("return 'never';", runOptions()).result;
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "timeout");
	assert.equal(launched, false);
	assert.deepEqual(failures, [{ code: "CODEMODE_ADMISSION_TIMEOUT", message: "The codemode script timed out before worker admission.", active: 0, waiting: 0, limit: 1 }]);
	await sandbox.close();
});

it("caps the worker timeout by the original execution deadline", { timeout: 5000 }, async (t) => {
	const queue = new CodemodeWorkerQueue(1);
	const timeouts: (number | undefined)[] = [];
	const sandbox = new QueuedCodemodeSandbox({
		deadline: async () => Date.now() + 5000,
		admitted: async () => {},
		now: () => 2000,
		executionDeadline: 3000,
	}, queue, { wasm: {}, workerUrl });
	const nativeStart = CodemodeSandbox.prototype.start;
	t.mock.method(CodemodeSandbox.prototype, "start", function(this: CodemodeSandbox, code: string, options: CodemodeRunOptions) { timeouts.push(options.timeoutMs); return nativeStart.call(this, code, options); });
	assert.equal((await sandbox.start("return 'ok';", { ...runOptions(), startedAt: 2000, timeoutMs: 2000 }).result).ok, true);
	assert.equal(timeouts.length, 1);
	assert.ok(timeouts[0] !== undefined && timeouts[0] > 0 && timeouts[0] <= 1000, `worker timeout ${String(timeouts[0])}`);
	await sandbox.close();
});

it("refuses worker launch once the original execution deadline passes", { timeout: 5000 }, async () => {
	let launched = false;
	const sandbox = new QueuedCodemodeSandbox({
		deadline: async () => Date.now() + 5000,
		admitted: async () => {},
		now: () => 3001,
		executionDeadline: 3000,
	}, new CodemodeWorkerQueue(1), { wasm: {}, workerUrl, onWorkerStarted: () => { launched = true; } });
	const result = await sandbox.start("return 'never';", { ...runOptions(), startedAt: 3001, timeoutMs: 2000 }).result;
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "timeout");
	assert.equal(launched, false);
	await sandbox.close();
});
