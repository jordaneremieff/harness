import { machineConfig } from "./settings-fixture.mts";
/**
 * Helpers for the durable-runtime production SIGKILL tests.
 *
 * The fixture builds an isolated agent home whose settings load the on-disk
 * `testdata/durable-runtime` extension, the metadata the production runner
 * consumes, and a marker socket that is accepting before a host starts. The tests launch
 * the production `durable-runner.ts` through `acquireHost`; no fixture runner
 * and no real provider are used.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { AgentCatalog, hostMetadata, type CatalogRecord } from "./catalog.ts";
import type { DeliveryReceipt } from "./durable-controls.ts";
import type { HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";

export interface RuntimeFixture {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	/** Directory for the fixture extension's effect and provider request evidence. */
	readonly testDir: string;
	/** Cross-cwd target for the spawn regression. */
	readonly childCwd: string;
	readonly storagePath: string;
	readonly ownerId: string;
	readonly metadata: HostMetadata;
	/** Unix socket that is accepting marker names before a host starts. */
	readonly notifyPath: string;
	/** Child environment for one fixture mode. */
	env(mode: "request" | "effect" | "answer" | "spawn" | "tool-round" | "await-local" | "await-reference" | "retry"): Record<string, string>;
	/** Resolve when the host publishes this marker name. The file is not the signal. */
	marker(name: string): Promise<void>;
}

/** Build an isolated agent home for one durable runtime test. */
export function runtimeFixture(t: { after(fn: () => void): void }, options: { withAgentExtension?: boolean; transport?: "sse" | "auto"; retry?: boolean; packageDir?: string; httpEndpoint?: string; retryDelayMs?: number } = {}): RuntimeFixture {
	const root = mkdtempSync(join(tmpdir(), "durable-runtime-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const testDir = join(root, "control");
	const childCwd = join(root, "child-work");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(testDir);
	mkdirSync(childCwd);
	const extensionPath = fileURLToPath(new URL("./testdata/durable-runtime/index.ts", import.meta.url));
	const extensions = [extensionPath];
	if (options.withAgentExtension === true) extensions.push(fileURLToPath(new URL("./index.ts", import.meta.url)));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions, transport: options.transport ?? "auto", cacheWarming: { mode: "off" }, retry: { enabled: options.retry === true, maxRetries: 20, baseDelayMs: options.retryDelayMs ?? 300000, maxAgentDelayMs: 300000 } }));
	if (options.httpEndpoint !== undefined) {
		const endpoint = new URL(options.httpEndpoint);
		if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") throw new Error("provider fixture requires an isolated loopback HTTP endpoint");
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
			"durable-runtime-http": {
				api: "openai-completions", baseUrl: endpoint.href, apiKey: "synthetic-runtime-fixture",
				models: [{ id: "fixture-http-model", name: "HTTP fixture model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			},
		} }));
	}
	const ownerId = "primary-owner";
	const record = new AgentCatalog(root).create({
		cwd,
		agentDir,
		packageDir: options.packageDir ?? getPackageDir(),
		model: options.httpEndpoint === undefined ? { provider: "durable-runtime-fixture", modelId: "fixture-model" } : { provider: "durable-runtime-http", modelId: "fixture-http-model" },
		thinkingLevel: "off",
		name: "Durable runtime kill fixture",
		trust: true,
		ownerId,
	}, "primary");
	const metadata = hostMetadata(record);
	writeFileSync(join(agentDir, "harness.json"), JSON.stringify(machineConfig({ presets: { standard: { model: `${metadata.model.provider}/${metadata.model.modelId}` } }, preferences: { defaultPreset: "standard" } })));
	const markers = markerFixture(t, testDir);
	return {
		root,
		cwd,
		agentDir,
		testDir,
		childCwd,
		storagePath: metadata.storagePath,
		ownerId,
		metadata,
		notifyPath: markers.notifyPath,
		env: (mode) => ({
			DURABLE_TEST_DIR: testDir,
			DURABLE_TEST_CHILD_CWD: childCwd,
			DURABLE_TEST_MODE: mode,
			...(options.retry === true ? { DURABLE_TEST_RETRY: "1" } : {}),
			DURABLE_TEST_NOTIFY: markers.notifyPath,
			...(options.httpEndpoint === undefined ? {} : { DURABLE_TEST_HTTP: "1" }),
			PI_AGENT_IDLE_MINUTES: "0.05",
		}),
		marker: markers.marker,
	};
}

/** Accept explicit marker frames before the caller starts a child process. */
export function markerFixture(t: { after(fn: () => void): void }, testDir: string): {
	readonly notifyPath: string;
	marker(name: string): Promise<void>;
	/** Hold the publisher's acknowledgment until the returned release function runs. */
	hold(name: string): () => void;
} {
	const socketDir = mkdtempSync(join(tmpdir(), "pi-n-"));
	const notifyPath = join(socketDir, "m.sock");
	if (Buffer.byteLength(notifyPath) > 103) {
		rmSync(socketDir, { recursive: true, force: true });
		throw new Error("fixture marker socket path exceeds the Unix path limit");
	}
	const seen = new Set<string>();
	const waiters = new Map<string, Set<(error?: Error) => void>>();
	const sockets = new Set<Socket>();
	const held = new Map<string, Set<Socket>>();
	let failure: Error | undefined;
	const fail = (error: Error): void => {
		failure = error;
		for (const pending of waiters.values()) for (const settle of pending) settle(error);
	};
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const name = buffer.slice(0, newline);
			seen.add(name);
			const pending = waiters.get(name);
			if (pending) for (const settle of pending) settle();
			const gate = held.get(name);
			if (gate) gate.add(socket);
			else socket.end();
		});
		socket.on("error", fail);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("error", fail);
	t.after(() => {
		fail(new Error("fixture marker server closed"));
		for (const socket of sockets) socket.destroy();
		server.close();
		rmSync(socketDir, { recursive: true, force: true });
	});
	// A Unix listen binds synchronously; only the listening event is deferred.
	server.listen({ path: notifyPath, exclusive: true });
	if (!server.listening) throw new Error("fixture marker socket did not bind");
	chmodSync(notifyPath, 0o600);
	return {
		notifyPath,
		hold: (name) => {
			const gate = new Set<Socket>();
			held.set(name, gate);
			return () => {
				held.delete(name);
				for (const socket of gate) socket.end();
				gate.clear();
			};
		},
		marker: (name) => {
			if (failure) return Promise.reject(failure);
			if (seen.has(name)) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const pending = waiters.get(name) ?? new Set();
				const settle = (error?: Error): void => {
					clearTimeout(timer);
					pending.delete(settle);
					if (pending.size === 0) waiters.delete(name);
					if (error) reject(error);
					else resolve();
				};
				// This deadline only bounds a missing publisher. Files never resolve the wait.
				const timer = setTimeout(() => settle(new Error(
					`timed out waiting for fixture marker ${name}; file exists=${existsSync(join(testDir, name))}`,
				)), 30000);
				pending.add(settle);
				waiters.set(name, pending);
			});
		},
	};
}

/** The storage record the cross-cwd spawn created, excluding the owner record. */
export async function childCatalogRecord(f: RuntimeFixture): Promise<CatalogRecord> {
	const page = await new AgentCatalog(dirname(dirname(f.storagePath))).page({ limit: 20 });
	const record = page.records.find((item) => item.storageId !== f.metadata.storageId);
	if (!record) throw new Error("no child storage record was created");
	return record;
}

/** Kill one host process and never fail when it already exited. */
export function killHost(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// The host already exited.
	}
}

/** Kill every tracked host when the test ends, even on failure. */
export function trackHost(t: { after(fn: () => void): void }, pid: number): void {
	t.after(() => killHost(pid));
}

/** Wait for the delivery receipt of one submission; the host waits on commits, not polling. */
export async function waitForReceipt(host: HostConnection, ownerId: string, submissionId: string | number, timeoutMs = 60000): Promise<DeliveryReceipt> {
	const response = await host.request("receipts", { ownerId, wait: true }, { signal: AbortSignal.timeout(timeoutMs) }) as { receipts: DeliveryReceipt[] };
	const receipt = response.receipts.find((item) => String(item.submissionId) === String(submissionId));
	if (!receipt) throw new Error(`no delivery receipt for submission ${submissionId}`);
	return receipt;
}
