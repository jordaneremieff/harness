import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { defineExtension, Harness, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { stopTask } from "./testdata/stop-process/recovery.ts";
import { runtimeFixture } from "./durable-runtime-fixture.mts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CapturedStopTaskDoc, StoppedDoc } from "./conversation-stop.ts";
import { DurableHost, stopBeforeResume, stopLiveConversation } from "./durable-host.ts";
import { deferred, fixtureRegistry, fixtureRuntime, fixtureStorageId, hostOptions } from "./durable-host-fixture.mts";

const file = fileURLToPath(import.meta.url);
const context = BACKGROUND_CONTEXT;
type Route = "live" | "cold";
type Boundary = { foreground: TaskId[]; background: TaskId; firstMarked?: TaskId };

async function fixture(path: string, enter: (id: TaskId) => void | Promise<void>) {
	const task = stopTask(durable, enter);
	const registry = fixtureRegistry();
	registry.install(defineExtension({ name: "fixture.stop-recovery", tasks: [task] }));
	return { task, options: hostOptions(path, await fixtureRuntime("answer"), registry, dirname(path)) };
}

async function crashFixture(path: string, route: Route, storageId: string): Promise<never> {
	const started = new Set<TaskId>();
	const running = deferred();
	const { task, options } = await fixture(path, async (id) => {
		started.add(id);
		if (started.size === 2) running.resolve();
		await new Promise<never>(() => {});
	});
	const host = await DurableHost.open({ ...options, storageId, resume: route === "live" }, context);
	const root = host.root();
	const boundary: Boundary = await host.harness.commit(async (tx) => {
		const owner = { ownership: { kind: "conversation" } as const, conversationId: root.id };
		const foreground = [await tx.createTask(task, {}, owner)];
		if (route === "cold") foreground.push(await tx.createTask(task, {}, owner));
		const background = await tx.createTask(task, {}, { ...owner, background: true });
		return { foreground, background };
	}, context);

	const atBoundary = async (firstMarked?: TaskId): Promise<never> => {
		const stopped = await host.harness.snapshot(StoppedDoc, root.id, context);
		assert.equal(typeof stopped?.stoppedAt, "number");
		assert.ok(process.send);
		process.channel?.ref();
		process.send({ ...boundary, firstMarked });
		return new Promise<never>(() => {});
	};
	if (route === "live") {
		await running.promise;
		// The stop queues its commit before it calls abort. The snapshot waits for that commit.
		// This wrapper never passes through to the native task mark.
		root.abort = () => atBoundary();
		await stopLiveConversation(host.harness, storageId, root, false, Date.now, () => {}, context);
	} else {
		const nativeAbort = host.harness.abortTask.bind(host.harness);
		host.harness.abortTask = async (id, context) => {
			await nativeAbort(id, context);
			// Let the first mark commit, but prevent the loop from advancing to the next task.
			return atBoundary(id);
		};
		await stopBeforeResume(host.harness, storageId, storageId, false, context);
	}
	throw new Error("The fixture stop returned before the process was killed");
}

async function killAtBoundary(t: TestContext, path: string, route: Route, storageId: string): Promise<Boundary> {
	const root = dirname(path);
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	mkdirSync(home);
	mkdirSync(agentDir);
	const child = fork(file, ["crash-fixture", path, route, storageId], {
		cwd: root,
		env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_HARNESS_FILE: join(agentDir, "harness.json"), TMPDIR: root },
		execArgv: [],
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr = (stderr + String(chunk)).slice(-4_000);
	});
	const exited = once(child, "exit");
	try {
		const boundary = await Promise.race([
			once(child, "message", { signal: t.signal }).then(([message]) => message as Boundary),
			exited.then(([code, signal]) => {
				throw new Error(`Fixture exited before the stop boundary: ${code ?? signal}\n${stderr}`);
			}),
		]);
		assert.ok(child.kill("SIGKILL"), "the process was still alive at the stop boundary");
		assert.deepEqual(await exited, [null, "SIGKILL"]);
		return boundary;
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	}
}

async function assertStoredBoundary(reader: Harness, route: Route, { foreground, background, firstMarked }: Boundary) {
	assert.equal(foreground.length, route === "live" ? 1 : 2);
	if (route === "cold") assert.ok(firstMarked !== undefined && foreground.includes(firstMarked));
	else assert.equal(firstMarked, undefined);
	assert.equal(typeof (await reader.snapshot(StoppedDoc, ROOT_CONVERSATION_ID, context))?.stoppedAt, "number");
	for (const id of [...foreground, background]) {
		const task = await reader.getTask(id, context);
		assert.ok(task, `task ${id} was retained`);
		assert.equal(task.state.status, route === "live" ? "running" : "pending");
		assert.equal(task.abortRequested, id === firstMarked, `native mark of task ${id} at the crash`);
		const intent = await reader.snapshot(CapturedStopTaskDoc, id, context);
		assert.equal(intent?.captured === true, id !== background, `stop intent of task ${id} at the crash`);
	}
}

async function assertRecovery(t: TestContext, route: Route): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "agent-stop-recovery-"));
	const serving = route === "cold" ? runtimeFixture(t) : undefined;
	const path = serving?.storagePath ?? join(dir, "run.sqlite");
	try {
		const boundary = await killAtBoundary(t, path, route, serving?.metadata.storageId ?? fixtureStorageId);
		const { foreground, background } = boundary;

		const executed: TaskId[] = [];
		const { options } = await fixture(path, (id) => {
			executed.push(id);
		});
		// Copy the database and WAL after the only writer exits. Storage initialisation
		// can write to the copy; the original remains untouched until recovery.
		const snapshot = join(dir, "at-crash.sqlite");
		copyFileSync(path, snapshot);
		copyFileSync(`${path}-wal`, `${snapshot}-wal`);
		const storage = await openNodeSqliteStorage(snapshot);
		const reader = await Harness.open(
			storage,
			{ models: options.models, registry: options.registry, readOnly: true },
			context,
		);
		try {
			await assertStoredBoundary(reader, route, boundary);
		} finally {
			await reader.close(context);
		}

		if (serving) {
			const settingsPath = join(serving.agentDir, "settings.json");
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			settings.extensions.push(fileURLToPath(new URL("./testdata/stop-process/recovery.ts", import.meta.url)));
			writeFileSync(settingsPath, JSON.stringify(settings));
			const runtime = await createDurableRuntime(serving.metadata);
			try {
				const answer = (await runtime.request(
					"command",
					{ name: "stop-outcomes", args: JSON.stringify([...foreground, background]) },
					"outcomes",
					t.signal,
				)) as { text: string };
				const { setupError, outcomes, executed } = JSON.parse(answer.text);
				assert.match(setupError, /stop recovery setup/u);
				assert.deepEqual(outcomes, ["aborted", "aborted", "completed"]);
				assert.deepEqual(executed, [background]);
			} finally {
				await runtime.close();
			}
			return;
		}
		// A cold writer that opens the crash copy to stop a different conversation must finish the earlier marks too.
		const cold = await Harness.open(
			await openNodeSqliteStorage(snapshot),
			{ models: options.models, registry: options.registry },
			context,
		);
		try {
			const other = await cold.createConversation({ ownership: { kind: "ownerless" } }, context);
			const stopped = await stopBeforeResume(cold, fixtureStorageId, `${fixtureStorageId}:${other.id}`, false, context);
			assert.equal(stopped.settled, true);
			assert.equal((await cold.getTask(foreground[0], context))?.abortRequested, true);
			assert.equal((await cold.getTask(background, context))?.abortRequested, false);
			assert.equal((await cold.inspect(context)).scheduling, "paused");
			assert.deepEqual(executed, []);
		} finally {
			await cold.close(context);
		}
		const host = await DurableHost.open(options, context);
		try {
			const waitContext = withAbortSignal(t.signal, context);
			const tasks = await Promise.all(
				[...foreground, background].map((id) => host.harness.waitForTask(id, waitContext)),
			);
			assert.deepEqual(
				tasks.map(({ id, state }) => [id, state.outcome.status]),
				[...foreground.map((id) => [id, "aborted"]), [background, "completed"]],
			);
			assert.deepEqual(executed, [background], "no captured foreground task re-entered its work phase");
		} finally {
			await host.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (process.argv[2] === "crash-fixture") {
	const [path, route, storageId] = process.argv.slice(3);
	assert.ok(path && storageId && (route === "live" || route === "cold"));
	await crashFixture(path, route, storageId);
} else {
	it("recovers an interrupted live stop before any native task mark", { timeout: 10_000 }, (t) =>
		assertRecovery(t, "live"),
	);
	it("installs the serving task definitions before completing a partially marked cold stop", { timeout: 30_000 }, (t) =>
		assertRecovery(t, "cold"),
	);
}
