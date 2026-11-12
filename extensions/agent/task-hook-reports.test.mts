import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type ConversationId, defineExtension, type EntryRecord, type Extension, GenerationTask, Harness, hook, MemoryStorage, type Report, type TaskId, type Tx, wrapSection } from "@earendil-works/pi-durable";
import { fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { TASK_HOOK_REPORT_FORMAT, TASK_HOOK_REPORT_KIND, TaskHookReports } from "./task-hook-reports.ts";

const task = { id: 3 as TaskId, conversationId: 1 as ConversationId, kind: "pi.generation" };

function taskReport(error: unknown): Report {
	return { kind: "extension_error", task, extension: "fixture", error };
}

/** The reports a host and its observers raise outside any task. */
function unscopedReports(): Report[] {
	return [
		{ kind: "extension_error", conversationId: 1 as ConversationId, extension: "agent", error: "composition" },
		{ kind: "extension_error", extension: "agent", error: new Error("observer, recovery or provider-notice diagnostic") },
		{ kind: "listener_error", error: "observer" },
		{ kind: "storage_failed", error: "storage" },
		{ kind: "task_error", task, error: "task" },
		{ kind: "host_error", callback: "env", task, error: "host" },
	];
}

type Row = { readonly conversationId: number; readonly kind: string; readonly data: Record<string, unknown>; readonly model?: unknown };

/** A stand-in storage owner that runs each commit's change against a recording `appendEntry`. */
function recordingHarness(rows: Row[], settle: (commitIndex: number) => Promise<void> = async () => {}): Harness {
	let commits = 0;
	const tx = { async appendEntry(conversationId: number, draft: Omit<Row, "conversationId">) { rows.push({ conversationId, ...draft }); } };
	return { async commit(change: (tx: Tx) => Promise<unknown>) {
		const index = commits++;
		await change(tx as unknown as Tx);
		await settle(index);
	} } as unknown as Harness;
}

function dataOf(entry: EntryRecord | Row | undefined): Record<string, unknown> {
	const data = entry?.data;
	assert.ok(data !== undefined && data !== null && typeof data === "object" && !Array.isArray(data));
	return data;
}

it("retains only the guarded, redacted main message of a task-scoped report", { timeout: 10000 }, async () => {
	const rows: Row[] = [];
	const sink = new TaskHookReports(undefined, () => 123);
	let forbidden = 0;
	const error = new Error("Bearer abcdefghijklmnopqrstuvwxyz012345\nsettings failed");
	Object.defineProperty(error, "stack", { get() { forbidden++; throw new Error("stack read"); } });
	Object.defineProperty(error, "cause", { get() { forbidden++; throw new Error("cause read"); } });
	Object.defineProperty(error, "toString", { value() { forbidden++; throw new Error("toString call"); } });
	sink.record(taskReport(error));
	const accessor = Object.defineProperty({}, "message", { get() { forbidden++; throw new Error("message getter"); } });
	sink.record(taskReport(accessor));
	const proxy = new Proxy({ message: "proxied text" }, { getOwnPropertyDescriptor() { forbidden++; throw new Error("proxy trap"); } });
	sink.record(taskReport(proxy));
	sink.record(taskReport("explicit string"));
	sink.record(taskReport(Object.create({ message: "inherited text" })));
	sink.record(taskReport('"'.repeat(3000)));
	sink.bind(recordingHarness(rows));
	await sink.flush();
	assert.equal(forbidden, 0);
	assert.equal(sink.dropped, 0);
	assert.equal(rows.length, 6);
	for (const row of rows) {
		assert.deepEqual(Object.keys(row).sort(), ["conversationId", "data", "kind"]);
		assert.equal(row.kind, TASK_HOOK_REPORT_KIND);
		assert.equal(row.conversationId, 1);
		assert.ok(Buffer.byteLength(JSON.stringify(row.data)) <= 4096);
	}
	assert.deepEqual(rows[0]?.data, { format: TASK_HOOK_REPORT_FORMAT, kind: "extension_error", taskId: 3, taskKind: "pi.generation", extension: "fixture", message: "[credential omitted]\\u000asettings failed", redacted: true, truncated: false, observedAt: 123, omittedReports: 0 });
	assert.doesNotMatch(JSON.stringify(rows), /abcdefghijklmnopqrstuvwxyz|stack read|cause read|proxied text|inherited text/);
	assert.deepEqual(rows.slice(1, 5).map((row) => row.data.message), ["[error message unavailable]", "[error message unavailable]", "explicit string", "[error message unavailable]"]);
	assert.equal(rows[5]?.data.message, "[error message omitted: entry byte bound]");
	assert.equal(rows[5]?.data.truncated, true);
	await sink.close();
});

it("ignores every report without a task, including one raised during its own write", { timeout: 10000 }, async () => {
	const rows: Row[] = [];
	const sink = new TaskHookReports();
	for (const unscoped of unscopedReports()) sink.record(unscoped);
	sink.bind(recordingHarness(rows, async () => { for (const unscoped of unscopedReports()) sink.record(unscoped); }));
	await sink.flush();
	assert.equal(rows.length, 0);
	sink.record(taskReport("scoped"));
	await sink.flush();
	assert.equal(rows.length, 1);
	assert.equal(sink.dropped, 0);
	await sink.close();
});

it("bounds the pending queue and states the omitted count on the next retained report", { timeout: 10000 }, async () => {
	const rows: Row[] = [];
	const sink = new TaskHookReports();
	for (let index = 0; index < 40; index++) sink.record(taskReport(`error ${index}`));
	assert.equal(sink.dropped, 8);
	sink.bind(recordingHarness(rows));
	await sink.flush();
	assert.deepEqual(rows.map((row) => row.data.message), Array.from({ length: 32 }, (_, index) => `error ${index}`));
	sink.record(taskReport("after the gap"));
	await sink.flush();
	assert.equal(rows[32]?.data.omittedReports, 8);
	sink.record(taskReport("next"));
	await sink.flush();
	assert.equal(rows[33]?.data.omittedReports, 0);
	assert.equal(sink.dropped, 8);
	await sink.close();
});

it("disables itself after a rejected write without a report loop", { timeout: 10000 }, async () => {
	const failures: unknown[] = [];
	let writes = 0;
	const rejection = new Error("write failed");
	const sink = new TaskHookReports((error) => {
		failures.push(error);
		// A host diagnostic is unscoped; a scoped report here finds the sink already disabled.
		sink.record({ kind: "extension_error", extension: "agent", error });
		sink.record(taskReport("raised by the diagnostic"));
		throw new Error("diagnostic failed");
	});
	for (let index = 0; index < 40; index++) sink.record(taskReport(`error ${index}`));
	sink.bind({ async commit() { writes++; throw rejection; } } as unknown as Harness);
	await sink.flush();
	sink.record(taskReport("later"));
	await sink.flush();
	assert.equal(writes, 1);
	assert.deepEqual(failures, [rejection]);
	assert.equal(sink.dropped, 42);
	await sink.close();
});

it("bounds its close while a write is pending and writes nothing afterwards", { timeout: 10000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const rows: Row[] = [];
	const failures: unknown[] = [];
	let rejectStalled: (error: Error) => void = () => {};
	const stalled = new Promise<void>((_resolve, reject) => { rejectStalled = reject; });
	const sink = new TaskHookReports((error) => { failures.push(error); });
	sink.bind(recordingHarness(rows, () => stalled));
	sink.record(taskReport("in flight"));
	sink.record(taskReport("pending one"));
	sink.record(taskReport("pending two"));
	let closed = false;
	const closing = sink.close().then(() => { closed = true; });
	assert.equal(sink.close(), sink.close());
	sink.record(taskReport("during close"));
	t.mock.timers.tick(249);
	await nextTurn();
	assert.equal(closed, false);
	t.mock.timers.tick(1);
	await closing;
	assert.equal(sink.dropped, 3);
	sink.record(taskReport("after close"));
	rejectStalled(new Error("storage closed under the write"));
	await sink.flush();
	assert.deepEqual(rows.map((row) => row.data.message), ["in flight"]);
	assert.deepEqual(failures, []);
	assert.equal(sink.dropped, 5);
});

it("drops reports that never reached a storage owner when it closes", { timeout: 10000 }, async () => {
	const rows: Row[] = [];
	const sink = new TaskHookReports();
	sink.record(taskReport("before any storage owner"));
	await sink.close();
	assert.equal(sink.dropped, 1);
	sink.bind(recordingHarness(rows));
	sink.record(taskReport("after close"));
	await sink.flush();
	assert.equal(rows.length, 0);
	assert.equal(sink.dropped, 2);
});

/** Run one generation of a real Harness whose report callback feeds the sink, as a host wires it. */
async function generationWith(t: TestContext, extension: Extension): Promise<{ readonly sink: TaskHookReports; readonly reports: Report[]; entries(): Promise<readonly EntryRecord[]> }> {
	const sink = new TaskHookReports();
	const reports: Report[] = [];
	const registry = fixtureRegistry();
	registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry, onReport: (report) => { reports.push(report); sink.record(report); } }, context);
	sink.bind(harness);
	t.after(async () => {
		await sink.close();
		await harness.close(context);
	});
	const root = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	const input = await root.submit({ type: "input", content: "work" }, context);
	assert.equal((await input.wait(context)).status, "done");
	await sink.flush();
	return { sink, reports, entries: async () => (await root.entries({}, 50, undefined, context)).items };
}

it("retains a thrown generation hook of a real Harness as one model-less entry", { timeout: 20000 }, async (t) => {
	const run = await generationWith(t, defineExtension({ name: "hook-failure", hooks: [hook(GenerationTask, { beforeRequest() { throw new Error("invalid capacity threshold order"); } })] }));
	const scoped = run.reports.filter((report) => report.kind === "extension_error" && report.task !== undefined);
	assert.equal(scoped.length, 1);
	const entries = await run.entries();
	const retained = entries.filter((entry) => entry.kind === TASK_HOOK_REPORT_KIND);
	assert.equal(retained.length, 1);
	const entry = retained[0];
	assert.ok(entry !== undefined);
	assert.equal(entry.model, undefined);
	assert.equal(entry.byTaskId, undefined);
	assert.equal(entry.edits, undefined);
	const data = dataOf(entry);
	assert.equal(data.format, TASK_HOOK_REPORT_FORMAT);
	assert.equal(data.kind, "extension_error");
	assert.equal(data.extension, "hook-failure");
	assert.equal(data.taskKind, "pi.generation");
	assert.equal(data.message, "invalid capacity threshold order");
	assert.ok(typeof data.taskId === "number" && data.taskId >= 1);
	assert.ok(entries.some((candidate) => candidate.kind === "pi.assistant"), "the generation still answers");
	assert.equal(run.sink.dropped, 0);
});

it("retains a failed section render, which the scheduler also reports with its task", { timeout: 20000 }, async (t) => {
	const run = await generationWith(t, defineExtension({ name: "section-failure", sections: [{ key: "broken", render() { throw new Error("section render failed"); } }] }));
	const retained = (await run.entries()).filter((entry) => entry.kind === TASK_HOOK_REPORT_KIND);
	assert.ok(retained.length >= 1);
	const data = dataOf(retained[0]);
	assert.equal(data.extension, "section-failure");
	assert.equal(data.message, "section render failed");
	assert.equal(retained[0]?.model, undefined);
});

it("writes nothing for a composition failure of a real Harness, or for a report after close", { timeout: 20000 }, async (t) => {
	const run = await generationWith(t, defineExtension({ name: "wrap-failure", sections: [{ key: "plain", render: () => "text" }], wraps: [wrapSection("plain", () => { throw new Error("wrapper failed"); })] }));
	const composition = run.reports.filter((report) => report.kind === "extension_error" && report.task === undefined && report.conversationId !== undefined);
	assert.ok(composition.length >= 1, "the Harness reported the composition failure without a task");
	assert.equal(run.reports.filter((report) => report.kind === "extension_error" && report.task !== undefined).length, 0);
	await run.sink.close();
	run.sink.record(taskReport("after close"));
	await run.sink.flush();
	assert.equal((await run.entries()).filter((entry) => entry.kind === TASK_HOOK_REPORT_KIND).length, 0);
	assert.equal(run.sink.dropped, 1);
});
