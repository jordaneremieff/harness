import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { allocateOfflineFixture, offlineFixtureFor } from "./offline-recovery-fixture.mts";
import { hostPaths, type HostMetadata } from "./host-protocol.ts";
import { bindOfflineContext, trackHost, type FixtureContext } from "./durable-runtime-fixture.mts";
import { prepareScheduleSettings, requireScheduleSettings } from "./durable-schedule-fixture.mts";

function held() {
	let release: () => void = () => {};
	const promise = new Promise<void>(done => { release = done; });
	return { promise, release };
}

function metadata(root: string): HostMetadata {
	return { storageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", storagePath: join(root, "storage.sqlite"), cwd: root, agentDir: join(root, "agent"), packageDir: root, model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off", ownerId: "ordinary-owner" };
}

const failedReloadRunner = fileURLToPath(new URL("./failed-reload-fixture.mts", import.meta.url));

for (const runner of [undefined, failedReloadRunner]) it(`keeps an absent attach non-poisoning for ${runner === undefined ? "the default runner" : "the fixed failed-reload runner"}`, async () => {
	const fixture = allocateOfflineFixture("offline-proof-"), target = metadata(fixture.root);
	fixture.allow(target);
	try {
		await assert.rejects(fixture.generation().connect(target, { runner, runnerArgs: [], env: { DURABLE_TEST_MODE: "answer" } }), new RegExp(`No verified native host endpoint for ${target.storageId}`, "u"));
		fixture.ordinaryRecipient("after-expected-absence");
		await fixture.teardown();
		assert.equal(fixture.cleanupAllowed, true);
	} finally { if (fixture.cleanupAllowed) rmSync(fixture.root, { recursive: true }); }
});

for (const invalid of ["path", "mode", "missing-mode", "arguments"] as const) it(`rejects fixed failed-reload ${invalid} before attachment`, async () => {
	const fixture = allocateOfflineFixture("offline-proof-"), target = metadata(fixture.root);
	fixture.allow(target);
	const options = {
		runner: invalid === "path" ? join(fixture.root, "failed-reload-fixture.mts") : failedReloadRunner,
		env: invalid === "missing-mode" ? {} : { DURABLE_TEST_MODE: invalid === "mode" ? "effect" : "answer" },
		...(invalid === "arguments" ? { runnerArgs: ["extra"] } : {}),
	};
	await assert.rejects(fixture.generation().connect(target, options), /closed fixture mode|Failed reload fixture requires/u);
	assert.throws(() => fixture.ordinaryRecipient("after-rejection"), /poisoned/u);
	await assert.rejects(fixture.teardown(), /poisoned/u);
	assert.equal(fixture.cleanupAllowed, false);
});

function alterCapturedClaim(condition: string, path: string, before: Buffer): void {
	if (["ended", "ended-live", "invalid-end", "changed-token-ended"].includes(condition)) {
		const record = JSON.parse(before.toString()) as Record<string, unknown>;
		writeFileSync(path, JSON.stringify({ ...record, ...(condition === "changed-token-ended" ? { token: "replacement" } : {}), endedAt: condition === "invalid-end" ? "invalid" : record.createdAt }));
	}
	if (condition === "changed-bytes") writeFileSync(path, `${before.toString()} `);
	if (condition === "changed-file") { writeFileSync(`${path}.replacement`, before, { flag: "wx", mode: 0o600 }); renameSync(`${path}.replacement`, path); }
	if (condition === "corrupt") writeFileSync(path, "not JSON");
	if (condition === "missing-live") unlinkSync(path);
}

for (const condition of ["unchanged", "ended", "ended-live", "invalid-end", "changed-token-ended", "changed-bytes", "changed-file", "corrupt", "missing-live"] as const) it(`requires an exited identical captured writer for attach refusal: ${condition}`, async (t) => {
	const fixture = allocateOfflineFixture("offline-proof-"), target = metadata(fixture.root);
	fixture.allow(target);
	const generation = fixture.generation(), paths = hostPaths(target);
	const pid = process.pid + 1000000;
	const child = Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });
	let live = true;
	const stop = () => { if (child.exitCode === null) { live = false; child.exitCode = 0; child.emit("exit", 0, null); } };
	const signal = t.mock.method(process, "kill", (actual: number, requested?: NodeJS.Signals | number) => {
		assert.equal(actual, pid);
		assert.equal(requested, 0, "the proof observes only the synthetic writer");
		if (live) return true;
		throw Object.assign(new Error("synthetic writer exited"), { code: "ESRCH" });
	});
	try {
		generation.raw(target, () => {
			mkdirSync(dirname(paths.claim), { recursive: true });
			writeFileSync(paths.claim, JSON.stringify({ token: "owned-fixture-writer", pid, host: hostname(), ...paths.identity, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
			return child as unknown as ChildProcess;
		}, { env: { DURABLE_TEST_MODE: "answer" } });
		generation.checkpoint(target);
		const before = readFileSync(paths.claim);
		if (condition !== "missing-live" && condition !== "ended-live") stop();
		alterCapturedClaim(condition, paths.claim, before);
		const retained = existsSync(paths.claim) ? readFileSync(paths.claim) : undefined;
		await assert.rejects(generation.connect(target, { env: { DURABLE_TEST_MODE: "answer" } }));
		if (condition === "unchanged" || condition === "ended") {
			fixture.ordinaryRecipient("after-expected-refusal");
			assert.deepEqual(readFileSync(paths.claim), retained);
			const successor = await fixture.recover();
			assert.notEqual(successor, generation);
			assert.equal(existsSync(paths.claim), false);
			await fixture.teardown();
			assert.equal(fixture.cleanupAllowed, true);
			rmSync(fixture.root, { recursive: true });
		} else {
			assert.throws(() => fixture.ordinaryRecipient("after-rejection"), /poisoned/u);
			stop();
			await assert.rejects(fixture.teardown(), /poisoned/u);
			assert.equal(fixture.cleanupAllowed, false);
			assert.equal(existsSync(fixture.root), true);
			assert.equal(existsSync(paths.claim), condition !== "missing-live");
			if (retained) assert.deepEqual(readFileSync(paths.claim), retained);
		}
	} finally { stop(); signal.mock.restore(); }
});

it("creates private allocation capabilities without adopting an existing path", async () => {
	const first = allocateOfflineFixture("offline-proof-"), second = allocateOfflineFixture("offline-proof-");
	try {
		assert.notEqual(first.root, second.root);
		assert.equal(lstatSync(first.root).isDirectory(), true);
		assert.equal(lstatSync(first.root).mode & 0o077, 0);
		assert.equal(offlineFixtureFor(first.root), first);
		assert.equal(offlineFixtureFor(join(first.root, "unallocated")), undefined);
	} finally {
		await first.teardown(); rmSync(first.root, { recursive: true });
		await second.teardown(); rmSync(second.root, { recursive: true });
	}
});

it("keeps old launch closures closed after a fresh generation exists", async () => {
	const fixture = allocateOfflineFixture("offline-proof-");
	const old = fixture.generation(), controller = old.controller(new AbortController());
	let closes = 0, launches = 0;
	const entered = held(), finish = held();
	let recovery: ReturnType<typeof fixture.recover> | undefined;
	old.manager({ async close() { entered.release(); await finish.promise; closes++; } });
	try {
		assert.throws(() => fixture.generation(), /only recovery/u);
		recovery = fixture.recover();
		await entered.promise;
		assert.throws(() => fixture.generation(), /lifecycle/u);
		assert.throws(() => fixture.allow(metadata(fixture.root)), /lifecycle/u);
		assert.throws(() => fixture.ordinaryRecipient("late-owner"), /lifecycle/u);
		await assert.rejects(fixture.recover(), /lifecycle/u);
		await assert.rejects(fixture.teardown(), /lifecycle/u);
		assert.equal(closes, 0, "the registered close producer remains held");
		finish.release();
		const fresh = await recovery;
		assert.notEqual(fresh, old);
		assert.equal(controller.signal.aborted, true);
		assert.equal(closes, 1);
		await assert.rejects(old.acquire(metadata(fixture.root)), /generation is closed/u);
		await assert.rejects(old.connect(metadata(fixture.root)), /generation is closed/u);
		assert.throws(() => old.declare(metadata(fixture.root)), /generation is closed/u);
		assert.throws(() => old.raw(metadata(fixture.root), () => { launches++; throw new Error("must not launch"); }, {}), /generation is closed/u);
		assert.equal(launches, 0);
		assert.throws(() => fixture.generation(), /only recovery/u);
	} finally { finish.release(); await recovery?.catch(() => undefined); await fixture.teardown(); rmSync(fixture.root, { recursive: true }); }
	assert.equal(closes, 1, "sealing remains idempotent through teardown");
});

it("retains an unexpected claim rather than authorise removal", async () => {
	const fixture = allocateOfflineFixture("offline-proof-");
	fixture.generation();
	const unexpected = join(fixture.root, "unregistered.lock");
	writeFileSync(unexpected, "unknown owner", { flag: "wx", mode: 0o600 });
	await assert.rejects(fixture.recover(), /Uncaptured fixture claim/u);
	await assert.rejects(fixture.teardown(), /poisoned/u);
	assert.equal(fixture.cleanupAllowed, false);
	assert.equal(existsSync(unexpected), true);
});

it("retains the root when an entered acquisition has unknown provenance", async () => {
	const fixture = allocateOfflineFixture("offline-proof-");
	const generation = fixture.generation();
	await assert.rejects(generation.acquire(metadata(fixture.root)), /Unregistered/u);
	await assert.rejects(fixture.recover(), /poisoned/u);
	await assert.rejects(fixture.teardown(), /poisoned/u);
	assert.equal(fixture.cleanupAllowed, false);
	assert.equal(existsSync(fixture.root), true);
});

it("closes the entire fixture synchronously while an entered seed remains held", async () => {
	const fixture = allocateOfflineFixture("offline-proof-");
	const generation = fixture.generation(), entered = held(), finish = held();
	const seed = generation.seed(async () => { entered.release(); await finish.promise; });
	await entered.promise;
	const closing = fixture.teardown();
	let complete = false;
	void closing.then(() => { complete = true; }, () => undefined);
	try {
		assert.throws(() => fixture.generation(), /lifecycle/u);
		assert.throws(() => fixture.allow(metadata(fixture.root)), /lifecycle/u);
		assert.throws(() => fixture.ordinaryRecipient("late-owner"), /lifecycle/u);
		await assert.rejects(fixture.recover(), /lifecycle/u);
		await assert.rejects(fixture.teardown(), /lifecycle/u);
		await assert.rejects(generation.acquire(metadata(fixture.root)), /generation is closed/u);
		assert.equal(complete, false, "the entered producer still owns its registered work");
		finish.release(); await seed; await closing;
		assert.equal(complete, true);
		assert.equal(fixture.cleanupAllowed, true);
		assert.throws(() => fixture.generation(), /lifecycle/u);
		assert.throws(() => fixture.allow(metadata(fixture.root)), /lifecycle/u);
		assert.throws(() => fixture.ordinaryRecipient("after-close"), /lifecycle/u);
		await assert.rejects(fixture.recover(), /lifecycle/u);
	} finally { finish.release(); await seed; await closing; rmSync(fixture.root, { recursive: true }); }
});

it("validates final timer settings without a child rewrite and preserves mismatches", async () => {
	const fixture = allocateOfflineFixture("offline-proof-"), agentDir = join(fixture.root, "agent");
	mkdirSync(agentDir);
	try {
		prepareScheduleSettings(agentDir);
		const path = join(agentDir, "settings.json"), before = readFileSync(path), stat = lstatSync(path);
		requireScheduleSettings(agentDir); requireScheduleSettings(agentDir);
		assert.deepEqual(readFileSync(path), before);
		assert.equal(lstatSync(path).ino, stat.ino);
		assert.equal(lstatSync(path).mtimeMs, stat.mtimeMs);
		const changed = `${before.toString()} `;
		writeFileSync(path, changed);
		assert.throws(() => requireScheduleSettings(agentDir), /settings differ/u);
		assert.equal(readFileSync(path, "utf8"), changed);
	} finally { await fixture.teardown(); rmSync(fixture.root, { recursive: true }); }
});

it("rejects the timer Agent contribution outside its fixed runner before launch", async () => {
	const fixture = allocateOfflineFixture("offline-proof-"), target = metadata(fixture.root);
	mkdirSync(target.agentDir); prepareScheduleSettings(target.agentDir);
	fixture.allow(target);
	await assert.rejects(fixture.generation().acquire(target, { env: { DURABLE_TEST_MODE: "answer" } }), /untracked launchers/u);
	await assert.rejects(fixture.teardown(), /poisoned/u);
	assert.equal(fixture.cleanupAllowed, false);
});

for (const order of ["native-first", "recipient-first"] as const) for (const qualified of [false, true]) it(`rejects ${qualified ? "qualified" : "plain"} native recipients in ${order} order`, async () => {
	const fixture = allocateOfflineFixture("offline-proof-");
	fixture.allow(metadata(fixture.root));
	const target = { ...metadata(fixture.root), storageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", storagePath: join(fixture.root, "other.sqlite") };
	const recipient = qualified ? `${target.storageId}:2` : target.storageId;
	if (order === "native-first") {
		fixture.allow(target);
		assert.throws(() => fixture.ordinaryRecipient(recipient), /recipient/u);
	} else if (qualified) assert.throws(() => fixture.ordinaryRecipient(recipient), /conversation-qualified/u);
	else { fixture.ordinaryRecipient(recipient); assert.throws(() => fixture.allow(target), /ordinary recipient/u); }
	await assert.rejects(fixture.teardown(), /poisoned/u);
	assert.equal(fixture.cleanupAllowed, false);
});

it("never runs a pre-existing PID fallback after an offline proof failure", async (t) => {
	const fixture = allocateOfflineFixture("offline-proof-"); fixture.generation();
	const hooks: Array<() => void | Promise<void>> = [];
	const context: FixtureContext = { after(fn) { hooks.push(fn); } };
	context.after(() => fixture.teardown());
	trackHost(context, 424242);
	const signal = t.mock.method(process, "kill", () => { throw Object.assign(new Error("No real bystander receives a signal"), { code: "ESRCH" }); });
	const errors: unknown[] = [];
	try {
		assert.throws(() => bindOfflineContext(context, fixture), /no offline launch ownership/u);
		for (const hook of hooks) { try { await hook(); } catch (error) { errors.push(error); } }
	}
	finally { signal.mock.restore(); }
	assert.equal(errors.length, 1, "the first proof failure does not prevent a later hook invocation");
	assert.equal(signal.mock.callCount(), 0);
	assert.equal(fixture.cleanupAllowed, false);
});

it("retains the default-context fallback independently of offline bindings", async (t) => {
	const hooks: Array<() => void | Promise<void>> = [];
	const context: FixtureContext = { after(fn) { hooks.push(fn); } };
	const signals: Array<number | NodeJS.Signals | undefined> = [];
	const mocked = t.mock.method(process, "kill", (_pid: number, signal?: NodeJS.Signals | number) => {
		signals.push(signal);
		if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		return true;
	});
	try { trackHost(context, 424242); assert.equal(hooks.length, 1); for (const hook of hooks) await hook(); }
	finally { mocked.mock.restore(); }
	assert.deepEqual(signals, ["SIGKILL", 0]);
});
