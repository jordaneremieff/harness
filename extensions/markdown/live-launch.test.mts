import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LaunchLedger } from "./launch-ledger.ts";
import { liveArguments, withLiveShow } from "./live-launch.ts";
import { LiveBridge } from "./live-bridge.ts";
import { PANE_PROTOCOL, type LiveConfig } from "./live-protocol.ts";
import { materializeAndReveal, openScratchpad, selectStored, type RevealRuntime } from "./reveal.ts";
import { MarkdownStore } from "./store.ts";

const documentId = `md-${"a".repeat(20)}`;
const config: LiveConfig = {
	version: 1,
	live: PANE_PROTOCOL,
	conversation: "test",
	hostPid: process.pid,
	endpoint: "http://127.0.0.1:12345",
	token: "ab".repeat(32),
};
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "markdown-live-launch-"));
	const app = join(root, "Reader.app");
	const store = new MarkdownStore(join(root, "store"));
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries({
		PI_MARKDOWN_APP: app,
		PI_MARKDOWN_DIR: store.root,
		PI_CODING_AGENT_DIR: root,
	})) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	t.after(async () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	const resources = join(app, "Contents", "Resources");
	await mkdir(resources, { recursive: true });
	const build = async (live?: number, paneProtocol?: number) =>
		writeFile(
			join(resources, "build.json"),
			JSON.stringify({ contract: 1, pane: 1, paneOpenRequest: 1, editorOpen: 1, live, paneProtocol }),
		);
	await build(undefined, PANE_PROTOCOL);
	return { root, app, store, build };
}
async function bridge(t: TestContext) {
	const bridge = new LiveBridge({ submit: async () => ({ status: "requested" }) });
	t.after(() => bridge.close());
	const live = await bridge.start();
	return { bridge, live };
}
function launchPath(argv: string[]): string {
	assert.equal(argv.at(-2), "--live");
	const path = argv.at(-1);
	assert.ok(path);
	return path;
}
async function consume(argv: string[], live: LiveConfig) {
	const path = launchPath(argv);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const file = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(file, { ...JSON.parse(JSON.stringify(live)), launchId: file.launchId });
	assert.match(file.launchId, /^[a-f0-9-]{36}$/u);
	await rm(path);
	return file.launchId as string;
}
async function post(live: LiveConfig, path: string, body: object) {
	const response = await fetch(live.endpoint + path, {
		method: "POST",
		headers: { authorization: `Bearer ${live.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(3000),
	});
	await response.body?.cancel();
	return response.status;
}
test("a serialised launch route creates a private offer, reports reader startup, and binds its first pane", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t);
	const { bridge: host, live } = await bridge(t);
	const route = async () => JSON.parse(JSON.stringify(live)) as LiveConfig;
	const show = await withLiveShow({ show: ["reader"], documentId, revision: 2 }, f.app, route);
	assert.ok(show.show && show.launchId);
	assert.ok(!JSON.stringify(show).includes(live.token));
	assert.equal(show.launchId, await consume(show.show, live));
	const offer = {
		launchId: show.launchId,
		origin: "agent",
		documentId,
		revision: 2,
		status: "offered",
		expiresAt: show.expiresAt,
	};
	assert.deepEqual(host.pendingLaunches(), [offer]);
	assert.deepEqual(host.list(), []);
	const start = { launchId: show.launchId, pid: process.pid };
	assert.equal(await post(live, "/starting", start), 200);
	assert.equal(await post(live, "/starting", start), 200, "retry the same startup after a lost reply");
	const [pending] = host.pendingLaunches();
	assert.deepEqual(pending, { ...offer, status: "launching", pid: process.pid, expiresAt: pending.expiresAt });
	assert.ok(pending.expiresAt < (show.expiresAt ?? 0));
	const next = await withLiveShow({ show: ["reader"], showUnavailable: "" }, f.app, route);
	assert.equal(next.show, undefined);
	assert.match(next.showUnavailable ?? "", /pending launches/u);
	const binding = {
		workspace: randomUUID(),
		document: randomUUID(),
		live: PANE_PROTOCOL,
		serial: 1,
		...start,
		view: {
			kind: "published",
			title: "Test",
			mode: "reading",
			dirty: false,
			conflict: false,
			storeId: "a".repeat(32),
			documentId,
			revision: 2,
			digest: `sha256:${"a".repeat(64)}`,
			follows: false,
		},
	};
	assert.equal(
		await post(live, "/connect", {
			...binding,
			view: { kind: "loading", title: "Opening", mode: "reading", dirty: false, conflict: false },
		}),
		422,
	);
	assert.equal(await post(live, "/connect", { ...binding, view: { ...binding.view, follows: true } }), 422);
	assert.deepEqual(host.list(), []);
	assert.equal(await post(live, "/connect", binding), 200);
	assert.equal(await post(live, "/connect", binding), 200, "replay a lost acknowledgement on the same workspace");
	assert.deepEqual(host.pendingLaunches(), []);
	assert.equal(host.list()[0]?.origin, "agent");
	assert.notEqual(await post(live, "/connect", { ...binding, workspace: randomUUID() }), 200);

	const follow = await withLiveShow({ show: ["reader"], documentId }, f.app, route, undefined, true);
	assert.ok(follow.show);
	const fresh = { ...binding, workspace: randomUUID(), launchId: await consume(follow.show, live) };
	assert.equal(await post(live, "/starting", fresh), 200);
	assert.equal(await post(live, "/connect", fresh), 422, "an unpinned published start follows latest");
	assert.equal(await post(live, "/connect", { ...fresh, view: { ...fresh.view, revision: 3, follows: true } }), 200);
});
test("a reader reports a bounded boot failure without ever binding a view", { timeout: 10000 }, async (t) => {
	const f = await fixture(t);
	const { bridge: host, live } = await bridge(t);
	const show = await withLiveShow({ show: ["reader"], documentId }, f.app, async () => live);
	assert.ok(show.show && show.launchId);
	const start = { launchId: await consume(show.show, live), pid: process.pid };
	const failure = { ...start, message: `Document load failed.\n${"x".repeat(600)}` };
	assert.notEqual(await post(live, "/launch-failed", failure), 200, "claim startup before reporting failure");
	assert.equal(await post(live, "/starting", start), 200);
	assert.equal(await post(live, "/cancel", start), 200);
	assert.equal(host.pendingLaunches().length, 1, "a late caller cancellation cannot cancel accepted startup");
	assert.equal(await post(live, "/launch-failed", failure), 200);
	assert.equal(await post(live, "/launch-failed", failure), 200);
	assert.deepEqual(host.pendingLaunches(), []);
	assert.deepEqual(host.list(), []);
	const [record] = host.failedLaunches();
	assert.equal(record.launchId, show.launchId);
	assert.equal(record.reason, "boot-failed");
	assert.match(record.message, /^Document load failed\./u);
	assert.equal(record.message.length, 400);
	assert.doesNotMatch(record.message, /\n/u);
	assert.notEqual(await post(live, "/starting", start), 200);
});
test("a bridge owns launch files after their caller loses its local lifetime symbol", { timeout: 10000 }, async (t) => {
	const f = await fixture(t);
	const { bridge: first, live } = await bridge(t);
	const { bridge: second, live: other } = await bridge(t);
	const detached = JSON.parse(JSON.stringify(live)) as LiveConfig;
	const a = await liveArguments(["reader"], detached);
	const b = await liveArguments(["reader"], other);
	const cancelled = await liveArguments(["reader"], detached);
	assert.deepEqual(
		first.pendingLaunches().map((p) => p.origin),
		["operator", "operator"],
	);
	await cancelled.remove();
	await cancelled.remove();
	assert.equal(first.pendingLaunches().length, 1);
	const unrelated = join(f.root, "markdown-live", `${randomUUID()}.json`);
	await writeFile(unrelated, "untouched");
	first.close();
	await assert.rejects(stat(launchPath(a.argv)), { code: "ENOENT" });
	assert.ok((await stat(launchPath(b.argv))).isFile());
	await assert.rejects(liveArguments(["reader"], detached));
	second.close();
	assert.equal(await readFile(unrelated, "utf8"), "untouched");
	assert.equal((await readdir(join(f.root, "markdown-live"))).length, 1);
});
test("reload revokes unused offers and preserves consumed handoffs without a stale pid or timer", async (t) => {
	await fixture(t);
	const ledger = new LaunchLedger();
	t.after(() => ledger.close());
	const a = { origin: "agent", launchId: randomUUID() };
	const b = { origin: "operator", launchId: randomUUID() };
	const c = { origin: "operator", launchId: randomUUID() };
	const aPath = ledger.reserve(a, config).path;
	const bPath = ledger.reserve(b, config).path;
	const cPath = ledger.reserve(c, config).path;
	await rm(bPath);
	await rm(cPath);
	ledger.starting({ ...c, pid: process.pid });
	const handoff = JSON.parse(JSON.stringify(ledger.suspend()));
	assert.deepEqual(ledger.pendingLaunches(), []);
	await assert.rejects(stat(aPath), { code: "ENOENT" });
	const restored = new LaunchLedger();
	t.after(() => restored.close());
	restored.resume(handoff, ledger.failedLaunches());
	assert.equal(restored.failedLaunches()[0]?.reason, "reload-revoked");
	assert.throws(() => restored.consume(a.launchId, process.pid));
	restored.starting({ ...b, pid: process.pid });
	assert.equal(restored.started(b.launchId, process.pid).origin, "operator");
	restored.consume(b.launchId, process.pid);
	assert.throws(() => restored.consume(c.launchId, 1));
	assert.equal(restored.started(c.launchId, process.pid).origin, "operator");
	restored.consume(c.launchId, process.pid);
	assert.throws(() => restored.consume(c.launchId, process.pid));
});
test("a 151-second precreation delay leaves the argv usable and startup gets its own nonrenewable deadline", async (t) => {
	await fixture(t);
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const ledger = new LaunchLedger();
	t.after(() => ledger.close());
	const start = { launchId: randomUUID(), pid: process.pid };
	const offer = ledger.reserve({ ...start, origin: "agent" }, config);
	assert.equal(offer.expiresAt, Date.now() + 300_000);
	t.mock.timers.tick(151_000);
	assert.ok((await stat(offer.path)).isFile());
	await rm(offer.path);
	const accepted = ledger.starting(start);
	assert.equal(accepted.expiresAt, Date.now() + 120_000);
	t.mock.timers.tick(119_000);
	assert.deepEqual(ledger.starting(start), accepted);
	t.mock.timers.tick(1001);
	assert.deepEqual(ledger.pendingLaunches(), []);
	assert.equal(ledger.failedLaunches()[0]?.reason, "startup-expired");
	assert.throws(() => ledger.consume(start.launchId, start.pid));
});
test("a reservation expires without a list call and cleanup preserves a replacement at its path", async (t) => {
	await fixture(t);
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const ledger = new LaunchLedger(100);
	t.after(() => ledger.close());
	const a = { launchId: randomUUID(), origin: "agent" };
	const path = ledger.reserve(a, config).path;
	assert.throws(() => ledger.reserve({ ...a, launchId: randomUUID() }, config), /pending/u);
	t.mock.timers.tick(101);
	await assert.rejects(stat(path), { code: "ENOENT" });
	assert.equal(ledger.failedLaunches()[0]?.reason, "offer-expired");
	assert.throws(() => ledger.starting({ ...a, pid: process.pid }));
	assert.throws(() => ledger.consume(a.launchId, process.pid));
	const b = { ...a, launchId: randomUUID() };
	const otherPath = ledger.reserve(b, config).path;
	await rm(otherPath);
	await writeFile(otherPath, "replacement");
	ledger.cancel(b);
	assert.equal(await readFile(otherPath, "utf8"), "replacement");
});
test("a live show requires the current app marker and an exact route", async (t) => {
	const f = await fixture(t);
	const outcome = { ok: true, show: ["reader"], showUnavailable: "" };
	for (const [live, protocol] of [
		[1, undefined],
		[2, undefined],
		[2, 3],
		[3, undefined],
	] as const) {
		await f.build(live, protocol);
		let calls = 0;
		const result = await withLiveShow(outcome, f.app, async () => {
			calls++;
			return config;
		});
		assert.equal(calls, 0);
		assert.equal(result.show, undefined);
		assert.equal(result.ok, true);
		assert.match(result.showUnavailable, /build.mts/u);
	}
	await f.build(undefined, PANE_PROTOCOL);
	const closed = await withLiveShow(outcome, f.app, async () => {
		throw Error("Closed");
	});
	assert.equal(closed.show, undefined);
	assert.match(closed.showUnavailable, /exact invoking conversation/u);
	assert.equal((await withLiveShow(outcome, f.app)).show, undefined);
});
test("pane and editor openers reserve operator launches only with the current reader", async (t) => {
	const f = await fixture(t);
	const { bridge: host, live } = await bridge(t);
	const record = await f.store.create({
		title: "Exact",
		source: "captured",
		contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() },
	});
	const saved = await selectStored(f.store.root, record.document.id);
	let dispatches = 0;
	const runtime: RevealRuntime = {
		platform: "darwin",
		acceptanceMs: 5,
		run: async (_exe, args, options) => {
			if (args[1] === "capture") return { stdout: "null" };
			const payload = JSON.parse(options.input ?? "null");
			const id = await consume(payload.argv, live);
			assert.equal(host.pendingLaunches().find((p) => p.launchId === id)?.origin, "operator");
			dispatches++;
			return {
				stdout: JSON.stringify({ version: 1, outcome: "created", detail: "Created.", receipt: { opaque: "pane" } }),
			};
		},
	};
	const options = { gui: true, runtime, live };
	assert.equal(
		(await materializeAndReveal(async () => saved, new AbortController().signal, options)).state,
		"not-confirmed",
	);
	await openScratchpad(new AbortController().signal, options);
	assert.equal(dispatches, 2);
	await f.build(2);
	assert.equal(
		(await materializeAndReveal(async () => saved, new AbortController().signal, options)).state,
		"reveal-failed",
	);
	await assert.rejects(openScratchpad(new AbortController().signal, options), /cannot connect/u);
	assert.equal(dispatches, 2);
});
