import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { createTransportServer } from "../../transport/index.ts";
import { acquireHost, connectHost } from "./host-client.ts";
import * as hostClient from "./host-client.ts";
import { fixtureMetadata } from "./host-fixture.mts";
import { HostError, hostPaths, HOST_READY_PREFIX } from "./host-protocol.ts";
import { runHost } from "./host-process.ts";
import { tryNativeWriterLease } from "./native-lease.ts";
import { runtimeFixture, trackHost } from "./durable-runtime-fixture.mts";

function assertReleased(metadata: Parameters<typeof hostPaths>[0]): void {
	assert.equal(existsSync(hostPaths(metadata).claim), true);
	const attempt = tryNativeWriterLease(hostPaths(metadata).claim);
	assert.equal(attempt.kind, "held");
	if (attempt.kind === "held") attempt.lease.release();
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function root(t: { after(fn: () => void): void }): string {
	const path = mkdtempSync(join(tmpdir(), "host-lifecycle-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

it("rejects a local protocol validation error without recovering the host", { timeout: 15000 }, async (t) => {
	const metadata = fixtureMetadata(root(t));
	let requests = 0;
	const host = await runHost(
		() => ({
			request: async () => ({ requests: ++requests }),
			isIdle: () => true,
			close: async () => {},
		}),
		{ metadata, idleMs: 0, announceReady: () => {} },
	);
	try {
		const client = await connectHost(metadata, { retryAttempts: 0 });
		try {
			await assert.rejects(client.request("list", { limit: 5, cursor: undefined }), (error: unknown) => {
				assert.ok(error instanceof HostError);
				assert.equal(error.code, "invalid");
				assert.match(error.message, /strict JSON value/u);
				return true;
			});
			assert.equal(client.closed, false, "a local encoding error leaves the transport healthy");
			assert.equal(requests, 0, "invalid parameters never reached the server");
			assert.deepEqual(await client.request("list", { limit: 5 }), { requests: 1 });
		} finally {
			await client.close();
		}
	} finally {
		await host.close();
	}
});

async function rejectingVersionHost(
	t: { after(fn: () => void | Promise<void>): void },
	path: string,
	malformed = false,
) {
	const metadata = fixtureMetadata(path);
	const paths = hostPaths(metadata);
	const writerId = randomUUID();
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	mkdirSync(dirname(paths.claim), { recursive: true, mode: 0o700 });
	writeFileSync(
		paths.claim,
		JSON.stringify({
			token: randomUUID(),
			pid: process.pid,
			host: hostname(),
			sessionId: metadata.storageId,
			cwd: path,
			createdAt: new Date().toISOString(),
		}),
	);
	const released = deferred();
	const peers = new Set<string>();
	const server = createTransportServer({
		serverId: paths.serverId,
		path: paths.socket,
		request: async (_request, peerId) => {
			peers.add(peerId);
			if (malformed)
				return {
					format: "pi.agent.host-hello/1",
					writerId,
					contract: { format: "pi.agent.contract/1", release: "invalid" },
				};
			throw new Error("durable host is closed");
		},
		release: (peerId) => {
			peers.delete(peerId);
			released.resolve();
		},
	});
	await server.start();
	t.after(() => server.close());
	return { metadata, released: released.promise, count: () => peers.size };
}

it("disposes a client when its runtime contract request fails", { timeout: 15000 }, async (t) => {
	const fixture = await rejectingVersionHost(t, root(t));
	await assert.rejects(connectHost(fixture.metadata), /durable host is closed/u);
	await fixture.released;
	assert.equal(fixture.count(), 0);
});

it("does not launch after an application error from a live writer", { timeout: 15000 }, async (t) => {
	const path = root(t);
	const fixture = await rejectingVersionHost(t, path);
	const marker = join(path, "launched");
	await assert.rejects(
		acquireHost(fixture.metadata, {
			runner: "--eval",
			runnerArgs: [`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched'); process.exitCode = 1;`],
		}),
		/durable host is closed/u,
	);
	assert.equal(existsSync(marker), false, "a live writer's application failure grants no launch authority");
	await fixture.released;
	assert.equal(fixture.count(), 0);
});

it("preserves a malformed contract error without waiting for a live writer to die", { timeout: 15000 }, async (t) => {
	const fixture = await rejectingVersionHost(t, root(t), true);
	await assert.rejects(acquireHost(fixture.metadata), /runtime contract is missing or malformed/u);
	await fixture.released;
	assert.equal(fixture.count(), 0);
});

it("attaches every concurrent launcher of one storage to the single host that wins its lease", {
	timeout: 60000,
}, async (t) => {
	const fixture = runtimeFixture(t);
	const hostClient = new URL("./host-client.ts", import.meta.url).href;
	const script = `const { acquireHost } = await import(${JSON.stringify(hostClient)});
try {
	const connection = await acquireHost(JSON.parse(process.env.LAUNCH_METADATA), { retryAttempts: 0 });
	console.log(JSON.stringify({ pid: connection.pid }));
	await connection.close();
} catch (error) {
	console.log(JSON.stringify({ error: String(error) }));
}
process.exit(0);`;
	const launchers = Array.from({ length: 4 }, () =>
		spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
			cwd: fixture.cwd,
			env: {
				...process.env,
				...fixture.env("answer"),
				PI_AGENT_SESSIONS_DIR: fixture.root,
				LAUNCH_METADATA: JSON.stringify(fixture.metadata),
			},
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	const outcomes = await Promise.all(
		launchers.map(async (child) => {
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			await once(child, "exit");
			return JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as { pid?: number; error?: string };
		}),
	);
	assert.deepEqual(
		outcomes.filter((outcome) => outcome.error !== undefined),
		[],
		"no launcher fails while the winner of the lease starts",
	);
	assert.equal(new Set(outcomes.map((outcome) => outcome.pid)).size, 1, "one host serves the storage");
});

it("attaches every caller that met a retiring host to the one host that replaces it", { timeout: 60000 }, async (t) => {
	const fixture = runtimeFixture(t);
	let finishClose: () => void = () => {};
	const closeStep = new Promise<void>((resolve) => {
		finishClose = resolve;
	});
	const retiring = await runHost(() => ({ request: async () => ({}), close: () => closeStep, isIdle: () => true }), {
		metadata: fixture.metadata,
		idleMs: 0,
		announceReady: () => {},
	});
	t.after(() => {
		finishClose();
		return retiring.close().catch(() => {});
	});
	const hostClient = new URL("./host-client.ts", import.meta.url).href;
	const script = `const { acquireHost } = await import(${JSON.stringify(hostClient)});
process.send?.("ready");
await new Promise((resolve) => process.once("message", resolve));
try {
	const connection = await acquireHost(JSON.parse(process.env.LAUNCH_METADATA), { retryAttempts: 0 });
	console.log(JSON.stringify({ pid: connection.pid }));
	await connection.close();
} catch (error) {
	console.log(JSON.stringify({ error: String(error) }));
}
process.exit(0);`;
	const callers = Array.from({ length: 3 }, () =>
		spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
			cwd: fixture.cwd,
			env: {
				...process.env,
				...fixture.env("answer"),
				PI_AGENT_SESSIONS_DIR: fixture.root,
				LAUNCH_METADATA: JSON.stringify(fixture.metadata),
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		}),
	);
	const outputs = callers.map((child) => {
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		return async () => {
			await once(child, "exit");
			return JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as { pid?: number; error?: string };
		};
	});
	await Promise.all(callers.map((child) => once(child, "message")));
	const closed = retiring.close();
	for (const child of callers) child.send("go");
	// The callers reach the retiring host within this window; its close step then ends.
	setTimeout(finishClose, 1000);
	await closed;
	const outcomes = await Promise.all(outputs.map((outcome) => outcome()));
	assert.deepEqual(
		outcomes.filter((outcome) => outcome.error !== undefined),
		[],
		"no caller fails while the replacement host starts",
	);
	assert.equal(new Set(outcomes.map((outcome) => outcome.pid)).size, 1, "one host replaces the retiring host");
	assert.notEqual(outcomes[0].pid, process.pid);
});

it("reports a bootstrap that ends without readiness and exits with failure", { timeout: 30000 }, async (t) => {
	const fixture = runtimeFixture(t);
	const unsettled = join(fixture.root, "unsettled-extension.ts");
	writeFileSync(unsettled, "export default async function () {\n\tawait new Promise(() => {});\n}\n");
	const settingsPath = join(fixture.metadata.agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { extensions: string[] };
	writeFileSync(settingsPath, JSON.stringify({ ...settings, extensions: [...settings.extensions, unsettled] }));
	const child = spawn(
		process.execPath,
		[fileURLToPath(new URL("./durable-runner.ts", import.meta.url)), JSON.stringify(fixture.metadata)],
		{
			cwd: fixture.cwd,
			env: { ...process.env, ...fixture.env("answer"), PI_AGENT_SESSIONS_DIR: fixture.root },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const exited = once(child, "exit");
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString()}`.slice(-8192);
	});
	const [code] = await exited;
	assert.equal(stdout.includes(HOST_READY_PREFIX), false);
	assert.equal(code, 1);
	assert.match(stderr, /bootstrap ended without readiness/u);
});

it("a wire close exits the durable process and releases its writer claim", { timeout: 15000 }, async (t) => {
	let stop = async () => {};
	t.after(() => stop());
	const fixture = runtimeFixture(t);
	const child = spawn(
		process.execPath,
		[fileURLToPath(new URL("./durable-runner.ts", import.meta.url)), JSON.stringify(fixture.metadata)],
		{
			cwd: fixture.cwd,
			env: { ...process.env, ...fixture.env("answer"), PI_AGENT_SESSIONS_DIR: fixture.root },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const exited = once(child, "exit");
	stop = async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	};
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString()}`.slice(-8192);
	});
	await new Promise<void>((resolve, reject) => {
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output = `${output}${chunk.toString()}`.slice(-8192);
			if (output.includes(HOST_READY_PREFIX)) resolve();
		});
		child.once("error", reject);
		child.once("exit", () => reject(new Error(`host exited before readiness: ${stderr}`)));
	});
	const client = await connectHost(fixture.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	await client.request("close").catch(() => undefined);
	const [code, signal] = await exited;
	assert.equal(code, 0, stderr);
	assert.equal(signal, null);
	assertReleased(fixture.metadata);
});

it("a lost claim pathname makes the durable runner exit with failure on shutdown", { timeout: 15000 }, async (t) => {
	let connection: Awaited<ReturnType<typeof acquireHost>> | undefined;
	t.after(() => connection?.close());
	const fixture = runtimeFixture(t);
	connection = await acquireHost(fixture.metadata, {
		env: { ...fixture.env("answer"), PI_AGENT_SESSIONS_DIR: fixture.root },
		retryAttempts: 0,
	});
	trackHost(t, connection.pid);
	const exited = connection.ownedExit;
	assert.ok(exited, "the real runner has an owned child-exit event");
	const paths = hostPaths(fixture.metadata);
	unlinkSync(paths.claim);
	process.kill(connection.pid, "SIGTERM");
	assert.deepEqual(await exited, { code: 1, signal: null, failed: true });
	assert.equal(existsSync(paths.claim), false, "shutdown never recreates the missing claim pathname");
	assert.equal(existsSync(paths.socket), false, "shutdown removes its own published endpoint");
});

for (const ownedExit of [false, true])
	it(`preserves the busy writer claim with ${ownedExit ? "an explicit" : "no"} process exit owner`, async (t) => {
		const metadata = fixtureMetadata(root(t));
		let exits = 0;
		const exit = (status: number): never => {
			assert.equal(status, 0, "an intentional busy close is not crash evidence");
			exits++;
			assert.equal(existsSync(hostPaths(metadata).claim), true);
			throw new Error("fixture process exit");
		};
		const host = await runHost(
			() => ({ request: async () => ({}), isIdle: () => false, close: async () => "process-exit" as const }),
			{
				metadata,
				idleMs: 0,
				announceReady: () => {},
				...(ownedExit ? { exit } : {}),
			},
		);
		await assert.rejects(host.close(), ownedExit ? /fixture process exit/u : /dedicated process owner/u);
		assert.equal(exits, ownedExit ? 1 : 0);
		assert.equal(existsSync(hostPaths(metadata).claim), true, "a callback or refusal is not proof of writer death");
	});

it("disconnects only after runtime shutdown and writer release", { timeout: 15000 }, async (t) => {
	const metadata = fixtureMetadata(root(t));
	const closing = deferred();
	const release = deferred();
	let dispatched = 0;
	const host = await runHost(
		() => ({
			request: async () => {
				dispatched++;
				return {};
			},
			isIdle: () => true,
			close: async () => {
				closing.resolve();
				await release.promise;
			},
		}),
		{ metadata, idleMs: 0, announceReady: () => {} },
	);
	t.after(async () => {
		release.resolve();
		await host.close();
	});
	const client = await connectHost(metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	const closed = client.request("close").catch(() => undefined);
	await closing.promise;
	assert.equal(client.closed, false, "disconnect must not precede runtime cleanup");
	assert.equal(existsSync(hostPaths(metadata).claim), true);
	await assert.rejects(client.request("submit", { message: "too late" }), /shutting down/u);
	assert.equal(dispatched, 0);
	release.resolve();
	await closed;
	assertReleased(metadata);
	await host.done;
});

it("waits for writer release through close completion", { timeout: 15000 }, async (t) => {
	const metadata = fixtureMetadata(root(t));
	const host = await runHost(() => ({ request: async () => ({}), isIdle: () => true, close: async () => {} }), {
		metadata,
		idleMs: 0,
		announceReady: () => {},
	});
	t.after(() => host.close());
	let settled = false;
	const released = hostClient.waitForHostRelease(metadata, { after: host.done }).then(() => {
		settled = true;
	});
	const client = await connectHost(metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	await client.request("status");
	assert.equal(settled, false, "an existing live writer is not released");
	await host.close();
	await released;
	assertReleased(metadata);
});

it("wire close and local close share one complete shutdown", { timeout: 15000 }, async (t) => {
	const metadata = fixtureMetadata(root(t));
	const closing = deferred();
	let closes = 0;
	let dispatched = 0;
	const host = await runHost(
		() => ({
			request: async () => {
				dispatched++;
				return {};
			},
			isIdle: () => true,
			close: async () => {
				closes++;
				closing.resolve();
			},
		}),
		{ metadata, idleMs: 0, announceReady: () => {} },
	);
	t.after(() => host.close());
	const client = await connectHost(metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	await client.request("close").catch(() => undefined);
	assert.equal(dispatched, 0, "process close must not dispatch into the storage runtime");
	await closing.promise;
	await Promise.all([host.done, host.close(), host.close()]);
	assert.equal(closes, 1);
	assertReleased(metadata);
});

it("shuts down on spontaneous runtime failure without a client request", { timeout: 5000 }, async (t) => {
	const metadata = fixtureMetadata(root(t));
	let activity = () => {};
	let failed = false;
	let closes = 0;
	let unsubscribed = false;
	const host = await runHost(
		() => ({
			request: async () => {
				assert.fail("failure supervision needs no request");
			},
			isIdle: () => true,
			get shutdownRequired() {
				return failed;
			},
			onActivity: (listener) => {
				activity = listener;
				return () => {
					unsubscribed = true;
				};
			},
			close: async () => {
				closes++;
			},
		}),
		{ metadata, idleMs: 0, announceReady: () => {} },
	);
	t.after(() => host.close());
	assert.equal(existsSync(hostPaths(metadata).claim), true);
	failed = true;
	activity();
	await host.done;
	assert.equal(closes, 1);
	assert.equal(unsubscribed, true);
	assertReleased(metadata);
	assert.equal(existsSync(hostPaths(metadata).socket), false);
});
