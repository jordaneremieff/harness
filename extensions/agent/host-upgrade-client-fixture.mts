import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { bindInstallationPackages } from "./installation-binding.ts";
import type { HostMetadata } from "./host-protocol.ts";
import { tryNativeWriterLease } from "./native-lease.ts";

interface Input { sourceRoot: string; syntheticRoot: string; metadata: HostMetadata }
interface Command { id: number; method: string; params?: unknown }
const input = JSON.parse(process.argv[2]) as Input;
const root = realpathSync(input.syntheticRoot);
for (const path of [input.metadata.agentDir, input.metadata.cwd, input.metadata.storagePath]) {
	const canonical = existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
	assert.ok(canonical.startsWith(`${root}${sep}`), "Every runtime path must remain below the synthetic root");
}
bindInstallationPackages(input.metadata.packageDir, pathToFileURL(`${input.sourceRoot}/extensions/agent/`));
const moduleUrl = (name: string) => pathToFileURL(join(input.sourceRoot, "extensions", "agent", name)).href;
const { connectHost, waitForHostRelease } = await import(moduleUrl("host-client.ts")) as typeof import("./host-client.ts");
const { parseHostReadyLine, hostPaths } = await import(moduleUrl("host-protocol.ts")) as typeof import("./host-protocol.ts");
const { eventLog, waitForProcessExit } = await import(moduleUrl("host-fixture.mts")) as typeof import("./host-fixture.mts");
const runner = spawn(process.execPath, [join(input.sourceRoot, "extensions", "agent", "durable-runner.ts"), JSON.stringify(input.metadata)], {
	cwd: input.metadata.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"],
});
const events = eventLog<{ ready?: NonNullable<ReturnType<typeof parseHostReadyLine>>; error?: string; exited?: boolean; code?: number | null; signal?: NodeJS.Signals | null }>();
let output = "";
let pendingLine = "";
runner.stdout.on("data", (chunk: Buffer) => {
	output = (output + chunk.toString()).slice(-65536);
	pendingLine += chunk.toString();
	assert.ok(pendingLine.length <= 65536, "Runner readiness must remain bounded");
	for (;;) {
		const newline = pendingLine.indexOf("\n");
		if (newline < 0) break;
		const line = pendingLine.slice(0, newline); pendingLine = pendingLine.slice(newline + 1);
		try { const ready = parseHostReadyLine(line); if (ready) events.push({ ready }); }
		catch (error) { events.push({ error: String(error) }); }
	}
});
runner.stderr.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65536); });
runner.on("error", (error) => events.push({ error: String(error) }));
runner.on("exit", (code, signal) => events.push({ exited: true, code, signal }));
let client: Awaited<ReturnType<typeof connectHost>> | undefined;

async function waitForReceipt(connection: NonNullable<typeof client>, raw: unknown) {
	assert.ok(connection.subscribeChanges);
	const params = raw as { ownerId: string; submissionId: number };
	assert.equal(typeof params.ownerId, "string");
	assert.ok(Number.isSafeInteger(params.submissionId));
	const changes = eventLog<void>();
	const signal = AbortSignal.timeout(30000);
	const deadline = performance.now() + 30000;
	const unsubscribe = await connection.subscribeChanges(() => changes.push(undefined), signal);
	try {
		for (;;) {
			signal.throwIfAborted();
			const next = changes.length + 1;
			const page = await connection.request("receipts", { ownerId: params.ownerId }, { signal }) as { receipts: { submissionId: number }[] };
			const receipt = page.receipts.find((row) => row.submissionId === params.submissionId);
			if (receipt) return receipt;
			await changes.waitForCount(next, Math.max(1, deadline - performance.now()));
		}
	} finally { unsubscribe(); }
}

async function drain(connection: NonNullable<typeof client>) {
	assert.ok(connection.subscribeChanges);
	const changes = eventLog<void>();
	const unsubscribe = await connection.subscribeChanges(() => changes.push(undefined));
	try {
		for (;;) {
			const next = changes.length + 1;
			const state = await connection.request("recovery-state") as { workPending: boolean; deliveriesPending: boolean; deliveriesActive: boolean };
			if (!state.workPending && !state.deliveriesPending && !state.deliveriesActive) return state;
			await changes.waitForCount(next, 30000);
		}
	} finally { unsubscribe(); }
}

async function stop() {
	await client?.close().catch(() => {});
	if (runner.exitCode === null && runner.signalCode === null) {
		runner.kill("SIGKILL");
		await waitForProcessExit(runner);
	}
}
process.once("disconnect", () => { void stop(); });
try {
	await events.waitFor((rows) => rows.some((row) => row.ready || row.error || row.exited), 30000);
	const ready = events.find((row) => row.ready)?.ready;
	assert.ok(ready, `Runner failed before readiness: ${output}`);
	client = await connectHost(input.metadata, { retryAttempts: 0 });
	assert.equal(client.pid, runner.pid);
	process.send?.({ kind: "ready", pid: runner.pid, contract: client.runtimeContract });
	let queue = Promise.resolve();
	process.on("message", (command: Command) => {
		queue = queue.then(async () => {
			try {
				assert.ok(client);
				let result: unknown;
				if (command.method === "wait-receipt") {
					result = await waitForReceipt(client, command.params);
				} else if (command.method === "drain") {
					result = await drain(client);
				} else if (command.method === "close-host") {
					const state = await client.request("recovery-state");
					assert.deepEqual(state, { workPending: false, deliveriesPending: false, deliveriesActive: false }, "Close requires drained work and deliveries");
					const closing = client.request("close");
					await waitForHostRelease(input.metadata, { after: closing });
					await closing.catch(() => {});
					await waitForProcessExit(runner);
					assert.equal(runner.exitCode, 0, output);
					assert.equal(runner.signalCode, null);
					const writer = tryNativeWriterLease(hostPaths(input.metadata).claim);
					assert.equal(writer.kind, "held", "The old writer released its lease before the new writer starts");
					if (writer.kind === "held") writer.lease.release();
					await client.close();
					result = { pid: runner.pid, exited: true, claimReleased: true };
				} else result = await client.request(command.method, command.params);
				process.send?.({ kind: "result", id: command.id, result });
			} catch (error) { process.send?.({ kind: "error", id: command.id, error: String(error), output }); }
		});
	});
} catch (error) {
	process.send?.({ kind: "failed", error: String(error), output });
	await stop();
	process.disconnect();
}
