import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { AgentCatalog } from "./catalog.ts";
import { acquireHost, waitForHostRelease } from "./host-client.ts";
import { hostPaths, type HostMetadata } from "./host-protocol.ts";
import {
	configuredAgentRoot,
	cpuMilliseconds,
	localProcesses,
	parseProcessLine,
	parseRunnerCommand,
	superviseHosts,
	type ProcessRow,
	type ProcessSource,
	type SupervisionOptions,
} from "./host-supervision.ts";
import { AgentManager } from "./manager.ts";
import { StatusToolOutputSchema, structuredObservation } from "./observation-schema.ts";
import { taskGraphRunnable } from "./durable-host.ts";
import { hostActivityPath, readHostActivity } from "./host-activity.ts";
import { runtimeFixture, trackHost, waitForProcessGone, waitForReceipt } from "./durable-runtime-fixture.mts";

const MINUTE = 60_000;
const uid = process.getuid?.() ?? -1;

interface FakeHost {
	readonly metadata: HostMetadata;
	readonly runner: string;
	readonly row: ProcessRow;
}

/** An isolated agent directory with one package copy, catalog record, storage file and writer claim per host. */
function home(t: { after(fn: () => void): void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "hs-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "durable-hosts"), { recursive: true });
	const packageRoot = (name: string) => {
		const directory = join(root, name);
		mkdirSync(join(directory, "extensions", "agent"), { recursive: true });
		writeFileSync(join(directory, "extensions", "agent", "durable-runner.ts"), "");
		return directory;
	};
	let nextPid = 40_000;
	const host = (
		options: { package?: string; agentDir?: string; recoveryDue?: boolean; startedMs?: number; claimPid?: number } = {},
	): FakeHost => {
		const storageId = crypto.randomUUID();
		const sessions = join(root, "sessions", "durable");
		mkdirSync(sessions, { recursive: true });
		const storagePath = join(sessions, `${storageId}.sqlite`);
		writeFileSync(storagePath, "");
		const metadata: HostMetadata = {
			storageId,
			cwd: root,
			agentDir: options.agentDir ?? agentDir,
			packageDir: root,
			storagePath,
			model: { provider: "fixture", modelId: "fixture" },
			thinkingLevel: "off",
		};
		writeFileSync(join(sessions, `${storageId}.json`), JSON.stringify({ recoveryDue: options.recoveryDue ?? false }));
		const runner = join(
			options.package ?? packageRoot(`pkg-${storageId.slice(0, 8)}`),
			"extensions",
			"agent",
			"durable-runner.ts",
		);
		const pid = nextPid++;
		const start = Math.floor((options.startedMs ?? Date.now() - 10 * MINUTE) / 1000);
		const claim = hostPaths(metadata).claim;
		mkdirSync(dirname(claim), { recursive: true });
		writeFileSync(
			claim,
			JSON.stringify({
				token: `writer-${pid}`,
				pid: options.claimPid ?? pid,
				host: hostname(),
				sessionId: storageId,
				cwd: root,
				createdAt: new Date(start * 1000 + 500).toISOString(),
			}),
		);
		chmodSync(claim, 0o600);
		const row: ProcessRow = {
			pid,
			ppid: 1,
			uid,
			cpuMs: 1_000,
			start,
			command: `/usr/bin/node ${runner} ${JSON.stringify(metadata)}`,
		};
		return { metadata, runner, row };
	};
	/** Age every storage write by `ms`. */
	const ageWrites = (fake: FakeHost, ms: number) => {
		const at = new Date(Date.now() - ms);
		utimesSync(fake.metadata.storagePath, at, at);
	};
	return { root, agentDir, packageRoot, host, ageWrites };
}

/** A process table whose hosts exit on SIGTERM unless told to ignore it. */
function table(rows: ProcessRow[], ignore: ReadonlySet<number> = new Set()) {
	const live = new Map(rows.map((row) => [row.pid, row]));
	const signals: Array<[number, NodeJS.Signals]> = [];
	const source: ProcessSource = {
		list: async () => [...live.values()],
		row: async (pid) => live.get(pid),
	};
	const kill = (pid: number, signal: NodeJS.Signals) => {
		signals.push([pid, signal]);
		if (signal === "SIGKILL" || !ignore.has(pid)) live.delete(pid);
	};
	return { source, kill, signals, live };
}

function options(
	agentDir: string,
	fake: ReturnType<typeof table>,
	extra: Partial<SupervisionOptions> = {},
): SupervisionOptions {
	return {
		agentDir,
		stuckMs: 60 * MINUTE,
		idleMs: 5 * MINUTE,
		processes: fake.source,
		kill: fake.kill,
		wait: async () => {},
		terminationGraceMs: 0,
		...extra,
	};
}

it("parses the process table, CPU times and runner commands", () => {
	assert.equal(cpuMilliseconds("0:01.50"), 1_500);
	assert.equal(cpuMilliseconds("1:02:03"), 3_723_000);
	assert.equal(cpuMilliseconds("2-00:00:01"), 172_801_000);
	const row = parseProcessLine('  123   1  501   0:00.21 Wed Nov 25 06:44:53 2026     /usr/bin/node x.ts {"a": 1}');
	assert.deepEqual(row, {
		pid: 123,
		ppid: 1,
		uid: 501,
		cpuMs: 210,
		start: Date.UTC(2026, 10, 25, 6, 44, 53) / 1000,
		command: '/usr/bin/node x.ts {"a": 1}',
	});
	const metadata = {
		storageId: "s",
		cwd: "/w",
		agentDir: "/a",
		packageDir: "/p",
		storagePath: "/a/durable/s.sqlite",
		model: { provider: "p", modelId: "m" },
		thinkingLevel: "off",
		name: "with spaces",
	};
	const command = `/usr/bin/node /r/extensions/agent/durable-runner.ts ${JSON.stringify(metadata)}`;
	assert.equal(parseRunnerCommand(command)?.runner, "/r/extensions/agent/durable-runner.ts");
	assert.equal(parseRunnerCommand(command)?.metadata.name, "with spaces");
	assert.equal(parseRunnerCommand(`${command} stop s true`), undefined, "a cold stop run is no host");
	assert.equal(parseRunnerCommand("/usr/bin/node other.ts"), undefined);
});

it("reads this machine's process table with start times and the calling process", async () => {
	const rows = await localProcesses.list();
	const self = rows.find((row) => row.pid === process.pid);
	assert.ok(self, "the table holds the test process");
	assert.equal(self.uid, uid);
	assert.ok(Math.abs(self.start * 1000 - (Date.now() - process.uptime() * 1000)) < 5_000);
	const again = await localProcesses.row(process.pid);
	assert.deepEqual({ ...again, cpuMs: 0 }, { ...self, cpuMs: 0 }, "one PID reads back the same process");
	assert.equal(await localProcesses.row(2 ** 30), undefined, "a PID that no process holds reads as none");
});

it("ends a host whose storage file, catalog record or code is gone, and keeps a young one", async (t) => {
	const h = home(t);
	const storage = h.host({ agentDir: join(h.root, "other-agent") });
	const record = h.host();
	const code = h.host();
	const young = h.host({ startedMs: Date.now() - 10_000 });
	rmSync(storage.metadata.storagePath);
	rmSync(join(dirname(record.metadata.storagePath), `${record.metadata.storageId}.json`));
	rmSync(code.runner);
	rmSync(young.metadata.storagePath);
	const fake = table([storage.row, record.row, code.row, young.row]);
	const run = await superviseHosts(options(h.agentDir, fake));
	assert.deepEqual(
		run.acts.map((act) => [act.pid, act.act, act.reason]),
		[
			[storage.row.pid, "ended", "its storage file was removed"],
			[record.row.pid, "ended", "its catalog record was removed"],
			[code.row.pid, "ended", "its code directory was removed"],
		],
	);
	assert.deepEqual(fake.signals, [
		[storage.row.pid, "SIGTERM"],
		[record.row.pid, "SIGTERM"],
		[code.row.pid, "SIGTERM"],
	]);
	assert.deepEqual(new Set(run.ended), new Set([storage, record, code].map((item) => item.metadata.storageId)));
	assert.equal(run.hosts, 4);
});

it("keeps a host whose code is gone while a child process of its work runs", async (t) => {
	const h = home(t);
	const code = h.host();
	rmSync(code.runner);
	const child: ProcessRow = {
		pid: 50_000,
		ppid: code.row.pid,
		uid,
		cpuMs: 0,
		start: code.row.start,
		command: "/bin/bash -c npm test",
	};
	const fake = table([code.row, child]);
	const reported = new Set<string>();
	const first = await superviseHosts(options(h.agentDir, fake, { reported }));
	assert.deepEqual(fake.signals, []);
	assert.deepEqual(
		first.acts.map((act) => act.act),
		["kept"],
	);
	const second = await superviseHosts(options(h.agentDir, fake, { reported }));
	assert.deepEqual(second.acts, [], "a kept host is reported once");
});

/** Two checks a stuck window apart, with a clock that keeps moving for the exit wait. */
async function twoChecks(agentDir: string, fake: ReturnType<typeof table>, extra: Partial<SupervisionOptions> = {}) {
	let offset = 0;
	const now = () => Date.now() + offset;
	const first = await superviseHosts(options(agentDir, fake, { now, ...extra }));
	offset = 61 * MINUTE;
	const second = await superviseHosts(options(agentDir, fake, { now, ...extra }));
	return { first, second };
}

it("ends a stuck host only after a whole still window with pending work", async (t) => {
	const h = home(t);
	const stuck = h.host({ recoveryDue: true, startedMs: Date.now() - 3 * 60 * MINUTE });
	const idle = h.host({ recoveryDue: false, startedMs: Date.now() - 3 * 60 * MINUTE });
	const busy = h.host({ recoveryDue: true, startedMs: Date.now() - 3 * 60 * MINUTE });
	for (const item of [stuck, idle, busy]) h.ageWrites(item, 2 * 60 * MINUTE);
	const fake = table([stuck.row, idle.row, busy.row]);
	let offset = 0;
	const now = () => Date.now() + offset;
	const first = await superviseHosts(
		options(h.agentDir, fake, { now, activeRoot: dirname(dirname(dirname(idle.runner))) }),
	);
	assert.deepEqual(first.acts, [], "the first sample starts the still window");
	offset = 61 * MINUTE;
	fake.live.set(busy.row.pid, { ...busy.row, cpuMs: busy.row.cpuMs + 120_000 });
	const second = await superviseHosts(
		options(h.agentDir, fake, { now, activeRoot: dirname(dirname(dirname(idle.runner))) }),
	);
	assert.deepEqual(
		second.acts.map((act) => [act.pid, act.act]),
		[[stuck.row.pid, "ended"]],
	);
	assert.match(
		second.acts[0].reason,
		/pending work but no storage write, CPU progress or working child process for 60 minutes/u,
	);
	assert.deepEqual(fake.signals, [[stuck.row.pid, "SIGTERM"]]);
});

it("keeps a still host with pending work when its storage was written, a tool child runs, or its claim names another PID", async (t) => {
	const h = home(t);
	const old = Date.now() - 3 * 60 * MINUTE;
	const written = h.host({ recoveryDue: true, startedMs: old });
	const working = h.host({ recoveryDue: true, startedMs: old });
	const served = h.host({ recoveryDue: true, startedMs: old });
	const foreign = h.host({ recoveryDue: true, startedMs: old, claimPid: 1 });
	for (const item of [working, served, foreign]) h.ageWrites(item, 2 * 60 * MINUTE);
	h.ageWrites(written, -61 * MINUTE);
	writeFileSync(
		join(h.agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["-y", "docs-mcp"] } } }),
	);
	const tool: ProcessRow = {
		pid: 50_001,
		ppid: working.row.pid,
		uid,
		cpuMs: 0,
		start: old / 1000,
		command: "/bin/bash -c sleep 9999",
	};
	const mcp: ProcessRow = {
		pid: 50_002,
		ppid: served.row.pid,
		uid,
		cpuMs: 0,
		start: old / 1000,
		command: "node /opt/bin/npx -y docs-mcp",
	};
	const guardian: ProcessRow = {
		pid: 50_003,
		ppid: served.row.pid,
		uid,
		cpuMs: 0,
		start: old / 1000,
		command: "/bin/sh -c \\012groups=''\\012for pid in $groups; do kill -KILL -- \"-$pid\" 2>/dev/null || :; done",
	};
	const fake = table([written.row, working.row, served.row, foreign.row, tool, mcp, guardian]);
	const { second } = await twoChecks(h.agentDir, fake);
	assert.deepEqual(
		second.acts.map((act) => [act.pid, act.act]),
		[
			[served.row.pid, "ended"],
			[foreign.row.pid, "kept"],
		],
		"only the host whose children are its MCP server and guardian ends",
	);
	assert.match(second.acts[1].reason, /writer claim does not name this process/u);
	assert.deepEqual(fake.signals, [[served.row.pid, "SIGTERM"]]);
});

it("judges a host that publishes its activity by that account: sleeping work stays, long runnable work ends", async (t) => {
	const h = home(t);
	const old = Date.now() - 3 * 60 * MINUTE;
	const sleeping = h.host({ recoveryDue: true, startedMs: old });
	const stuck = h.host({ recoveryDue: true, startedMs: old });
	const fresh = h.host({ recoveryDue: true, startedMs: old });
	const publish = (fake: FakeHost, runnable: boolean, since: number) => {
		mkdirSync(dirname(hostActivityPath(fake.metadata.storagePath)), { recursive: true });
		writeFileSync(
			hostActivityPath(fake.metadata.storagePath),
			JSON.stringify({
				format: "pi.agent.host-activity/1",
				pid: fake.row.pid,
				runnable,
				since: new Date(since).toISOString(),
			}),
		);
	};
	publish(sleeping, false, old);
	publish(stuck, true, old);
	publish(fresh, true, Date.now() + 30 * MINUTE);
	for (const item of [sleeping, stuck, fresh]) h.ageWrites(item, 2 * 60 * MINUTE);
	const fake = table([sleeping.row, stuck.row, fresh.row]);
	const { second } = await twoChecks(h.agentDir, fake);
	assert.deepEqual(
		second.acts.map((act) => [act.pid, act.act]),
		[[stuck.row.pid, "ended"]],
		"only the host whose runnable work stayed still for the whole window ends",
	);
});

it("counts only pending or running tasks with a definition as runnable work", () => {
	const graph = (states: Array<{ status: string; blocked?: string }>) =>
		({
			tasks: Object.fromEntries(
				states.map((state, index) => [
					String(index),
					{ state: { status: state.status }, ...(state.blocked ? { blocked: state.blocked } : {}) },
				]),
			),
		}) as unknown as Parameters<typeof taskGraphRunnable>[0];
	assert.equal(taskGraphRunnable(graph([])), false);
	assert.equal(
		taskGraphRunnable(graph([{ status: "sleeping" }, { status: "waiting" }, { status: "completing" }])),
		false,
	);
	assert.equal(taskGraphRunnable(graph([{ status: "pending", blocked: "missing_task" }])), false);
	assert.equal(taskGraphRunnable(graph([{ status: "sleeping" }, { status: "running" }])), true);
});

it("sends no signal when the PID now holds another process", async (t) => {
	const h = home(t);
	const gone = h.host();
	rmSync(gone.metadata.storagePath);
	const fake = table([gone.row]);
	fake.source.row = async (pid) => (pid === gone.row.pid ? { ...gone.row, start: gone.row.start + 60 } : undefined);
	const run = await superviseHosts(options(h.agentDir, fake));
	assert.deepEqual(fake.signals, []);
	assert.deepEqual(run.acts, []);
});

it("sends SIGKILL to an ended host that outlives its shutdown deadline, and never to an idle host it hands over", async (t) => {
	const h = home(t);
	const current = h.packageRoot("current");
	const orphan = h.host();
	rmSync(orphan.metadata.storagePath);
	const idle = h.host({ startedMs: Date.now() - 60 * MINUTE });
	h.ageWrites(idle, 30 * MINUTE);
	const fake = table([orphan.row, idle.row], new Set([orphan.row.pid, idle.row.pid]));
	const run = await superviseHosts(options(h.agentDir, fake, { activeRoot: current }));
	assert.deepEqual(fake.signals, [
		[orphan.row.pid, "SIGTERM"],
		[orphan.row.pid, "SIGKILL"],
		[idle.row.pid, "SIGTERM"],
	]);
	assert.deepEqual(
		run.acts.map((act) => [act.pid, act.act]),
		[
			[orphan.row.pid, "killed"],
			[idle.row.pid, "kept"],
		],
	);
	assert.match(run.acts[1].reason, /did not exit after SIGTERM/u);
});

it("hands an idle host on other code over once per storage and code directory", async (t) => {
	const h = home(t);
	const current = h.packageRoot("current");
	const old = h.packageRoot("old");
	const idle = h.host({ package: old, startedMs: Date.now() - 60 * MINUTE });
	const onCurrent = h.host({ package: current, startedMs: Date.now() - 60 * MINUTE });
	const recent = h.host({ package: old, startedMs: Date.now() - 60 * MINUTE });
	const pending = h.host({ package: old, recoveryDue: true, startedMs: Date.now() - 60 * MINUTE });
	const elsewhere = h.host({
		package: old,
		agentDir: join(h.root, "other-agent"),
		startedMs: Date.now() - 60 * MINUTE,
	});
	for (const item of [idle, onCurrent, pending, elsewhere]) h.ageWrites(item, 30 * MINUTE);
	const fake = table([idle.row, onCurrent.row, recent.row, pending.row, elsewhere.row]);
	const run = await superviseHosts(options(h.agentDir, fake, { activeRoot: current }));
	assert.deepEqual(
		run.acts.map((act) => [act.pid, act.act, act.reason]),
		[[idle.row.pid, "handed-over", "it was idle on code other than the configured package"]],
	);
	assert.deepEqual(fake.signals, [[idle.row.pid, "SIGTERM"]]);
	// An older Pi process can start the same storage on its own code again; that host stays.
	const relaunched = { ...idle.row, pid: idle.row.pid + 1000 };
	const claim = hostPaths(idle.metadata).claim;
	const record = JSON.parse(readFileSync(claim, "utf8"));
	writeFileSync(claim, JSON.stringify({ ...record, pid: relaunched.pid }));
	const again = table([relaunched]);
	const second = await superviseHosts(options(h.agentDir, again, { activeRoot: current }));
	assert.deepEqual(again.signals, []);
	assert.deepEqual(second.acts, []);
});

it("acts on nothing when the process table cannot be read", async (t) => {
	const h = home(t);
	const fake = table([]);
	fake.source.list = async () => {
		throw new Error("ps failed");
	};
	const run = await superviseHosts(options(h.agentDir, fake));
	assert.match(run.skipped ?? "", /process table could not be read: ps failed/u);
	assert.deepEqual(fake.signals, []);
});

it("reads the configured agent package root from Pi settings", (t) => {
	const h = home(t);
	const current = h.packageRoot("current");
	writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({ packages: ["../current", "npm:other"] }));
	assert.equal(configuredAgentRoot(h.agentDir), current);
	writeFileSync(
		join(h.agentDir, "settings.json"),
		JSON.stringify({ packages: ["../current", { source: "../second" }] }),
	);
	h.packageRoot("second");
	assert.equal(configuredAgentRoot(h.agentDir), undefined, "two agent packages name no single current one");
});

it("reports the manager's host check in the status overview", async (t) => {
	const h = home(t);
	const orphan = h.host();
	rmSync(orphan.metadata.storagePath);
	const fake = table([orphan.row]);
	const manager = new AgentManager({
		root: join(h.root, "sessions-root"),
		agentDir: h.agentDir,
		packageDir: getPackageDir(),
		superviseHosts: { processes: fake.source, kill: fake.kill, wait: async () => {}, terminationGraceMs: 0 },
	});
	t.after(() => manager.close());
	await manager.checkHosts();
	const status = (await manager.status()) as { hostSupervision?: { hosts: number; acts: Array<{ act: string }> } };
	assert.equal(status.hostSupervision?.hosts, 1);
	assert.deepEqual(
		status.hostSupervision?.acts.map((act) => act.act),
		["ended"],
	);
	structuredObservation(StatusToolOutputSchema, status);
});

it("ends a real host whose catalog record was removed", { timeout: 60_000 }, async (t) => {
	const f = runtimeFixture(t);
	const client = await acquireHost(f.metadata, { env: { ...f.env("answer"), PI_AGENT_IDLE_MINUTES: "60" } });
	trackHost(t, client.pid);
	t.after(() => client.close());
	rmSync(new AgentCatalog(f.root).path(f.metadata.storageId));
	const run = await superviseHosts({
		agentDir: f.agentDir,
		stuckMs: 0,
		idleMs: 0,
		minimumAgeMs: 0,
		scope: (row) => row.pid === client.pid,
	});
	assert.deepEqual(
		run.acts.map((act) => [act.pid, act.act, act.reason]),
		[[client.pid, "ended", "its catalog record was removed"]],
	);
	assert.ok(await waitForProcessGone(client.pid, 1_000));
});

it("keeps a real still host whose tool runs a child process", { timeout: 60_000 }, async (t) => {
	const f = runtimeFixture(t);
	const client = await acquireHost(f.metadata, { env: { ...f.env("effect"), DURABLE_TEST_EFFECT_CHILD: "1" } });
	trackHost(t, client.pid);
	t.after(() => client.close());
	await client.request("submit", {
		message: "run the effect",
		requestId: "child",
		ownerId: f.ownerId,
		origin: "operator",
	});
	await f.marker("effect");
	const child = Number(readFileSync(join(f.testDir, "effect-child.pid"), "utf8"));
	t.after(() => process.kill(child, "SIGKILL"));
	let offset = 0;
	const check = () =>
		superviseHosts({
			agentDir: f.agentDir,
			stuckMs: 1_000,
			idleMs: 0,
			now: () => Date.now() + offset,
			scope: (row) => row.pid === client.pid,
		});
	await check();
	offset = 10 * MINUTE;
	const run = await check();
	assert.deepEqual(run.acts, []);
	assert.equal(client.closed, false, "the host with a working child stays");
});

it("ends a real stuck host, and the next host resumes its retained work", { timeout: 120_000 }, async (t) => {
	const f = runtimeFixture(t, { crashRetry: true });
	const first = await acquireHost(f.metadata, { env: f.env("request") });
	trackHost(t, first.pid);
	const submitted = (await first.request("submit", {
		message: "complete the request",
		requestId: "stuck-request",
		ownerId: f.ownerId,
		origin: "operator",
	})) as { submissionId: number };
	await f.marker("requested");
	assert.equal(readHostActivity(f.storagePath, first.pid)?.runnable, true, "the host says its request can run");
	let offset = 0;
	const check = () =>
		superviseHosts({
			agentDir: f.agentDir,
			stuckMs: 1_000,
			idleMs: 0,
			now: () => Date.now() + offset,
			scope: (row) => row.pid === first.pid,
		});
	await check();
	offset = 10 * MINUTE;
	const run = await check();
	assert.deepEqual(
		run.acts.map((act) => [act.pid, act.act]),
		[[first.pid, "ended"]],
	);
	assert.deepEqual(run.ended, [f.metadata.storageId]);
	await first.close();
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10_000) });
	const second = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	t.after(() => second.close());
	const receipt = await waitForReceipt(second, f.ownerId, submitted.submissionId);
	assert.equal(receipt.status, "done");
});

it("hands a real idle host on other code over through its own graceful shutdown", { timeout: 60_000 }, async (t) => {
	const f = runtimeFixture(t);
	const client = await acquireHost(f.metadata, { env: { ...f.env("answer"), PI_AGENT_IDLE_MINUTES: "60" } });
	trackHost(t, client.pid);
	t.after(() => client.close());
	const current = join(f.root, "current");
	mkdirSync(join(current, "extensions", "agent"), { recursive: true });
	writeFileSync(join(current, "extensions", "agent", "durable-runner.ts"), "");
	const run = await superviseHosts({
		agentDir: f.agentDir,
		stuckMs: 0,
		idleMs: 1_000,
		activeRoot: current,
		now: () => Date.now() + 10 * MINUTE,
		scope: (row) => row.pid === client.pid,
	});
	assert.deepEqual(
		run.acts.map((act) => [act.pid, act.act]),
		[[client.pid, "handed-over"]],
	);
	assert.ok(await waitForProcessGone(client.pid, 1_000));
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10_000) });
	assert.equal(
		new AgentCatalog(f.root).read(f.metadata.storageId).recoveryDue,
		false,
		"a clean shutdown leaves no work due",
	);
});
