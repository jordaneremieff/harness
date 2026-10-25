import { machineConfig } from "./settings-fixture.mts";
/**
 * Helpers for production durable-runtime tests.
 *
 * The fixture builds an isolated agent home whose settings load the on-disk
 * `testdata/durable-runtime` extension, the metadata the production runner
 * consumes, and a marker socket that is accepting before a host starts. The tests launch
 * the production `durable-runner.ts` through `acquireHost`; no fixture runner
 * and no real provider are used.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, opendirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { AgentCatalog, hostMetadata, type CatalogRecord } from "./catalog.ts";
import { readClaimFile } from "./claims.ts";
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
	env(mode: "request" | "effect" | "answer" | "spawn" | "tool-round" | "await-local" | "await-reference" | "retry" | "intent"): Record<string, string>;
	/** Resolve when the host publishes this marker name. The file is not the signal. */
	marker(name: string): Promise<void>;
}

/** The test-context subset the fixture needs: node:test runs `after` hooks in registration order and awaits each one. */
export interface FixtureContext {
	after(fn: () => void | Promise<void>): void;
	diagnostic?(message: string): void;
}

/** Build an isolated agent home for one durable runtime test. */
export function runtimeFixture(t: FixtureContext, options: { withAgentExtension?: boolean; transport?: "sse" | "auto"; retry?: boolean; packageDir?: string; httpEndpoint?: string; retryDelayMs?: number } = {}): RuntimeFixture {
	const root = mkdtempSync(join(tmpdir(), "durable-runtime-"));
	const createdAt = Date.now();
	// Registered first, so it runs first: every host that claimed a storage under this
	// agent home is stopped and has exited before the directories disappear. A host that
	// outlived the removal could otherwise relaunch a peer into a missing working directory.
	t.after(() => fixtureTeardown(root, join(root, "agent"), createdAt, t));
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
	signalHost(pid, "SIGKILL");
}

/** Send one signal to a host and never fail when it already exited. */
export function signalHost(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// The host already exited.
	}
}

/** True once the process no longer exists; a reaped child and a detached process both report ESRCH. */
export function processGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** Resolve true when the kernel no longer knows the process before the deadline; each poll is one `kill(pid, 0)` check. */
export async function waitForProcessGone(pid: number, deadlineMs = 5000, intervalMs = 25): Promise<boolean> {
	const started = Date.now();
	while (!processGone(pid)) {
		if (Date.now() - started > deadlineMs) return false;
		await new Promise((done) => setTimeout(done, intervalMs));
	}
	return true;
}

/** Pids the test registered through trackHost, keyed by its context: an explicit ownership handle the fixture stops first. */
const trackedPids = new WeakMap<FixtureContext, Set<number>>();

/** The pids registered through trackHost for one test context. */
export function trackedHosts(t: FixtureContext): number[] {
	return [...(trackedPids.get(t) ?? [])];
}

/**
 * Register one owned host. The fixture's first cleanup phase stops every tracked pid before
 * the root is removed, whether or not it has published a claim yet; the hook registered here is
 * the last-resort SIGKILL after that phase, and it waits for the exit it requested.
 */
export function trackHost(t: FixtureContext, pid: number): void {
	const set = trackedPids.get(t) ?? new Set<number>();
	set.add(pid);
	trackedPids.set(t, set);
	t.after(async () => {
		killHost(pid);
		if (!(await waitForProcessGone(pid))) throw new Error(`tracked host ${pid} did not exit after SIGKILL`);
	});
}

const CLAIM_SCAN_LIMIT = 64;
/**
 * A host told to close joins its in-flight deliveries before it exits, and one delivery can
 * hold a launch for the product launch bound of 30 s (host-client.ts DEFAULT_LAUNCH_TIMEOUT_MS)
 * before the launcher gives up and kills the child. The graceful exit wait covers that join.
 */
const GRACEFUL_EXIT_MS = 35_000;
/** Scan and stop passes: each pass stops the claims the previous pass's joined closes could have published. */
const STOP_PASS_LIMIT = 3;

/** Read at most `limit` entries of one directory through an open handle, and report whether more remained. */
function readEntriesBounded(path: string, limit: number): { names: string[]; complete: boolean } {
	if (!existsSync(path)) return { names: [], complete: true };
	const dir = opendirSync(path);
	try {
		const names: string[] = [];
		for (;;) {
			const entry = dir.readSync();
			if (entry === null) return { names, complete: true };
			if (names.length === limit) return { names, complete: false };
			names.push(entry.name);
		}
	} finally {
		dir.closeSync();
	}
}

/** The writer-claim files under one agent home. `complete` is false when a directory held more entries than the scan reads. */
function claimFilesUnder(agentDir: string): { files: string[]; complete: boolean } {
	const hosts = readEntriesBounded(join(agentDir, "durable-hosts"), CLAIM_SCAN_LIMIT);
	const files: string[] = [];
	let complete = hosts.complete;
	for (const key of hosts.names) {
		const claimsDir = join(agentDir, "durable-hosts", key, ".claims");
		const claims = readEntriesBounded(claimsDir, CLAIM_SCAN_LIMIT);
		complete &&= claims.complete;
		for (const name of claims.names) if (name.endsWith(".lock")) files.push(join(claimsDir, name));
	}
	return { files, complete };
}

type ClaimVerdict = { kind: "owned"; pid: number } | { kind: "excluded" } | { kind: "unresolved"; reason: string };

/**
 * Classify one claim. Owned: this host, a pid other than 1 or the test process, a working
 * directory under the fixture root, a creation time within the fixture's lifetime, and a
 * process that still exists. Excluded: provably another host's, outside the root, older than
 * the fixture, or already gone. Unresolved: a claim that cannot be read or parsed as a claim
 * record; its owner is unknown and it receives no signal.
 */
function classifyOwnedClaim(path: string, rootPrefix: string, createdAt: number): ClaimVerdict {
	let claim: Record<string, unknown>;
	try { claim = readClaimFile(path).claim as Record<string, unknown>; } catch (error) { return { kind: "unresolved", reason: error instanceof Error ? error.message : String(error) }; }
	if (claim === null || typeof claim !== "object" || typeof claim.host !== "string" || typeof claim.cwd !== "string" || typeof claim.createdAt !== "string" || !Number.isSafeInteger(claim.pid)) return { kind: "unresolved", reason: "not a claim record" };
	const pid = Number(claim.pid);
	const created = Date.parse(claim.createdAt);
	if (!Number.isFinite(created)) return { kind: "unresolved", reason: "claim createdAt is not a timestamp" };
	if (claim.host !== hostname() || !resolve(claim.cwd).startsWith(rootPrefix) || created < createdAt - 1000) return { kind: "excluded" };
	if (pid <= 1 || pid === process.pid) return { kind: "excluded" };
	return processGone(pid) ? { kind: "excluded" } : { kind: "owned", pid };
}

export interface OwnedClaimScan {
	readonly claims: { pid: number; claim: string }[];
	/** Claim files whose owner could not be established; each entry is `path: reason`. */
	readonly unresolved: string[];
	/** False when a directory held more entries than the bounded scan reads. */
	readonly complete: boolean;
}

/** Live writer claims under one agent home: the hosts this fixture owns, including relaunched peers and children. */
export function ownedHostClaims(root: string, agentDir: string, createdAt: number): OwnedClaimScan {
	const rootPrefix = `${resolve(root)}/`;
	const scan = claimFilesUnder(agentDir);
	const claims: { pid: number; claim: string }[] = [];
	const unresolved: string[] = [];
	for (const claim of scan.files) {
		const verdict = classifyOwnedClaim(claim, rootPrefix, createdAt);
		if (verdict.kind === "owned") claims.push({ pid: verdict.pid, claim });
		else if (verdict.kind === "unresolved") unresolved.push(`${claim}: ${verdict.reason}`);
	}
	return { claims, unresolved, complete: scan.complete };
}

export interface StopOwnedHostsResult {
	/** One line for the test diagnostic. */
	readonly summary: string;
	readonly stopped: number[];
	/** Pids still known to the kernel after the exit deadline. */
	readonly lingering: number[];
	/** Claims whose owner could not be established; nothing was signalled for them. */
	readonly unresolved: string[];
	/** False when a scan hit its bound or the last pass still found newly published claims. */
	readonly complete: boolean;
}

/**
 * Stop every host that holds a live claim under the fixture's agent home and wait for each
 * exit. The default signal is SIGTERM: a ready host closes its runtime, which joins the
 * delivery pass in flight, and that pass holds any launch it started until the child is ready
 * or the launch failed (durable-runtime.ts closeHost, durable-delivery.ts close). Each later
 * pass stops the claims those joined closes published. A claim still appearing after the last
 * pass, a scan at its bound, or an unresolved claim leaves the result incomplete. The scan
 * covers claims and tracked pids only; a process that holds neither is outside it.
 */
export async function stopOwnedHosts(root: string, agentDir: string, createdAt: number, options: { kill?: (pid: number) => void; signal?: NodeJS.Signals; deadlineMs?: number; tracked?: number[] } = {}): Promise<StopOwnedHostsResult> {
	const stop = options.kill ?? ((pid: number) => signalHost(pid, options.signal ?? "SIGTERM"));
	const deadlineMs = options.deadlineMs ?? GRACEFUL_EXIT_MS;
	const tracked = (options.tracked ?? []).filter((pid) => pid > 1 && pid !== process.pid && !processGone(pid));
	const stopped: number[] = [];
	const lingering: number[] = [];
	const unresolved = new Set<string>();
	let complete = true;
	const started = Date.now();
	for (let pass = 0; pass <= STOP_PASS_LIMIT; pass += 1) {
		const scan = ownedHostClaims(root, agentDir, createdAt);
		complete &&= scan.complete;
		for (const entry of scan.unresolved) unresolved.add(entry);
		// Tracked pids join the first pass: a test-owned runner is stopped even before it publishes a claim.
		const known = pass === 0 ? [...new Set([...tracked, ...scan.claims.map(({ pid }) => pid)])] : scan.claims.map(({ pid }) => pid);
		const live = known.filter((pid) => !stopped.includes(pid) && !lingering.includes(pid));
		if (!live.length) break;
		if (pass === STOP_PASS_LIMIT) { complete = false; break; }
		await stopAndWait(live, stop, deadlineMs, stopped, lingering);
	}
	return {
		summary: `${stopped.length} owned host(s) stopped [${stopped.join(", ")}] (${tracked.length} tracked) in ${Date.now() - started} ms; lingering [${lingering.join(", ")}]; unresolved ${unresolved.size}; scan ${complete ? "complete" : "incomplete"}`,
		stopped, lingering, unresolved: [...unresolved], complete,
	};
}

/** Signal every pid in one loop, then wait for each exit and sort it into stopped or lingering. */
async function stopAndWait(pids: number[], stop: (pid: number) => void, deadlineMs: number, stopped: number[], lingering: number[]): Promise<void> {
	for (const pid of pids) stop(pid);
	for (const pid of pids) (await waitForProcessGone(pid, deadlineMs) ? stopped : lingering).push(pid);
}

/**
 * The fixture's first `after` hook. The root is removed only after every tracked or claimed
 * host this cleanup observes is known to be gone; a lingering host, an unresolved claim or an
 * incomplete scan keeps the root in place and fails the test. A process with neither a tracked
 * pid nor a claim under this agent home is outside what the cleanup observes.
 */
export async function fixtureTeardown(root: string, agentDir: string, createdAt: number, t: FixtureContext, stop: typeof stopOwnedHosts = stopOwnedHosts): Promise<void> {
	const stopped = await stop(root, agentDir, createdAt, { tracked: trackedHosts(t) });
	t.diagnostic?.(`fixture teardown ${root}: ${stopped.summary}`);
	if (stopped.unresolved.length) throw new Error(`fixture claim ownership unresolved, root retained: ${root}; ${stopped.unresolved.join("; ")}`);
	if (!stopped.complete) throw new Error(`fixture claim scan exceeded its bound or launches outran the stop passes under ${agentDir}; host ownership is unknown, root retained: ${root}`);
	if (stopped.lingering.length) throw new Error(`fixture hosts did not exit before teardown: ${stopped.lingering.join(", ")}; root retained: ${root}`);
	rmSync(root, { recursive: true, force: true });
}

/** Wait for the delivery receipt of one submission; the host waits on commits, not polling. */
export async function waitForReceipt(host: HostConnection, ownerId: string, submissionId: string | number, timeoutMs = 60000): Promise<DeliveryReceipt> {
	const response = await host.request("receipts", { ownerId, wait: true }, { signal: AbortSignal.timeout(timeoutMs) }) as { receipts: DeliveryReceipt[] };
	const receipt = response.receipts.find((item) => String(item.submissionId) === String(submissionId));
	if (!receipt) throw new Error(`no delivery receipt for submission ${submissionId}`);
	return receipt;
}
