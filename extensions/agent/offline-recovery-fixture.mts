import type { ChildProcess } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, opendirSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHost, connectHost, HostEndpointUnavailableError, type HostConnection, type HostLaunchOptions } from "./host-client.ts";
import { hostPaths, type HostMetadata } from "./host-protocol.ts";
import { CLAIM_BYTES, validClaim } from "./claims.ts";
import { storageIdOf } from "./catalog.ts";

const fixtures = new Map<string, OfflineFixture>();
const RUNNERS = ["durable-runner.ts", "durable-schedule-fixture.mts", "queue-recovery-runner.mts", "delivery-wake-crash-fixture.mts"].map(name => fileURLToPath(new URL(name, import.meta.url)));
const FAILED_RELOAD_RUNNER = fileURLToPath(new URL("./failed-reload-fixture.mts", import.meta.url));
type Identity = { dev: number; ino: number; uid: number };
type Captured = Identity & { path: string; bytes: Buffer; value: Record<string, unknown>; metadata: HostMetadata; pid: number };
type Managed = { close(): void | Promise<void> };

function identity(path: string): Identity {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) throw new Error(`Offline fixture refuses a link: ${path}`);
	return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}
function equalIdentity(a: Identity, b: Identity): boolean { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid; }
function gone(pid: number): boolean {
	try { process.kill(pid, 0); return false; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
async function exited(pid: number): Promise<void> {
	const end = Date.now() + 10000;
	while (!gone(pid)) {
		if (Date.now() >= end) throw new Error(`Owned fixture writer ${pid} has not exited; root retained`);
		await new Promise<void>(done => setTimeout(done, 10));
	}
}
function readBounded(path: string, json = true): { bytes: Buffer; id: Identity; value: Record<string, unknown> } {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > CLAIM_BYTES) throw new Error(`Unbounded or nonregular fixture record: ${path}`);
		const buffer = Buffer.alloc(CLAIM_BYTES + 1);
		let count = 0;
		while (count < buffer.length) { const n = readSync(fd, buffer, count, buffer.length - count, count); if (!n) break; count += n; }
		if (count > CLAIM_BYTES) throw new Error(`Fixture record grew past its bound: ${path}`);
		const value: unknown = json ? JSON.parse(buffer.subarray(0, count).toString("utf8")) : {};
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid fixture record: ${path}`);
		return { bytes: buffer.subarray(0, count), id: { dev: stat.dev, ino: stat.ino, uid: stat.uid }, value: value as Record<string, unknown> };
	} finally { closeSync(fd); }
}
function absent(path: string): boolean {
	try { lstatSync(path); return false; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

export interface OfflineGeneration {
	acquire(metadata: HostMetadata, options?: HostLaunchOptions): Promise<HostConnection>;
	connect(metadata: HostMetadata, options?: HostLaunchOptions): Promise<HostConnection>;
	manager(value: Managed): void;
	controller(value: AbortController): AbortController;
	declare(metadata: HostMetadata): void;
	seed(action: () => Promise<void>): Promise<void>;
	raw(metadata: HostMetadata, start: (options: HostLaunchOptions) => ChildProcess, options: HostLaunchOptions): ChildProcess;
	checkpoint(metadata: HostMetadata): void;
}
export interface OfflineFixture {
	readonly root: string;
	readonly cleanupAllowed: boolean;
	allow(metadata: HostMetadata): void;
	ordinaryRecipient(identity: string): void;
	track(pid: number): void;
	generation(): OfflineGeneration;
	recover(): Promise<OfflineGeneration>;
	teardown(): Promise<void>;
}

/** Only fresh allocation creates this capability; an existing path cannot be adopted. */
export function allocateOfflineFixture(prefix: string, scratch = tmpdir()): OfflineFixture {
	const createdAt = Date.now();
	const root = realpathSync(mkdtempSync(join(scratch, prefix)));
	const rootIdentity = identity(root);
	if (!lstatSync(root).isDirectory() || (lstatSync(root).mode & 0o077) !== 0 || rootIdentity.uid !== process.getuid?.()) throw new Error("Offline fixture allocation is not private");
	const allowed = new Map<string, HostMetadata>();
	const recipients = new Set<string>();
	const captured = new Map<string, Captured>();
	const configuration = new Map<string, Buffer>();
	const catalogueRoots = new Set([join(root, "durable")]);
	const generations: Generation[] = [];
	let poison: unknown;
	let cleanupAllowed = false;
	let phase: "open" | "recovering" | "closing" | "closed" = "open";
	let started = false;
	let active: Generation | undefined;
	const markPoison = (error: unknown): void => { if (poison === undefined) poison = error ?? new Error("Fixture failure has no error value"); };
	function fail(error: unknown): never { markPoison(error); throw error; }
	function checkRoot(): void {
		if (poison !== undefined) throw new Error("Offline fixture proof is poisoned; root retained", { cause: poison });
		const stat = lstatSync(root);
		if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || !equalIdentity(identity(root), rootIdentity) || realpathSync(root) !== root) fail(new Error("Offline fixture root changed"));
	}
	function requireOpen(): void {
		checkRoot();
		if (phase !== "open") throw new Error(`Fixture lifecycle is ${phase}`);
	}
	function recipientKey(identity: string): string {
		if (identity.includes(":")) fail(new Error("Offline fixture conversation-qualified recipient is unsupported"));
		try { return storageIdOf(identity); } catch { return identity; }
	}
	function descendant(path: string): void {
		const absolute = resolve(path), suffix = relative(root, absolute);
		if (absolute !== path || suffix === ".." || suffix.startsWith("../") || suffix.startsWith("/")) fail(new Error(`Path is outside the allocated fixture: ${path}`));
		let current = root;
		for (const part of suffix.split("/")) { current = join(current, part); if (absent(current)) break; identity(current); }
	}
	function metadataCheck(metadata: HostMetadata): void {
		checkRoot();
		for (const path of [metadata.cwd, metadata.agentDir, metadata.storagePath]) descendant(path);
		const pinned = allowed.get(metadata.storageId);
		if (!pinned || ["storagePath", "cwd", "agentDir", "ownerId", "packageDir", "thinkingLevel", "trust"].some(key => pinned[key as keyof HostMetadata] !== metadata[key as keyof HostMetadata]) || JSON.stringify(pinned.model) !== JSON.stringify(metadata.model)) fail(new Error("Unregistered or changed fixture storage identity"));
	}
	function checkCatalogueRecord(path: string): void {
		const record = readBounded(path).value;
		const pinned = typeof record.storageId === "string" ? allowed.get(record.storageId) : undefined;
		if (!pinned || ["storagePath", "cwd", "agentDir", "ownerId", "packageDir", "thinkingLevel", "trust"].some(key => record[key] !== pinned[key as keyof HostMetadata]) || JSON.stringify(record.model) !== JSON.stringify(pinned.model)) fail(new Error("Unexpected fixture catalogue identity"));
	}
	function scan(): void {
		checkRoot();
		let visits = 0;
		function visitEntry(directory: string, name: string, depth: number): void {
			const path = join(directory, name), stat = lstatSync(path);
			if (stat.isSymbolicLink()) fail(new Error(`Offline fixture contains a link: ${path}`));
			if (stat.isDirectory()) visit(path, depth + 1);
			else if (name.endsWith(".lock") && !captured.has(path)) fail(new Error(`Uncaptured fixture claim: ${path}`));
			else if (catalogueRoots.has(directory) && name.endsWith(".json")) checkCatalogueRecord(path);
		}
		const visit = (directory: string, depth: number): void => {
			if (depth > 8) fail(new Error("Offline fixture scan depth exceeded"));
			const dir = opendirSync(directory);
			try {
				for (;;) {
					const entry = dir.readSync(); if (!entry) break;
					if (++visits > 4096) fail(new Error("Offline fixture scan bound exceeded"));
					visitEntry(directory, entry.name, depth);
				}
			} finally { dir.closeSync(); }
		};
		visit(root, 0);
	}
	function snapshot(metadata: HostMetadata, expectedPid?: number): Captured {
		metadataCheck(metadata);
		const paths = hostPaths(metadata); descendant(paths.claim);
		const read = readBounded(paths.claim), value = read.value;
		const pid = value.pid;
		if (!validClaim(value, paths.identity) || typeof pid !== "number" || pid <= 1 || pid === process.pid || expectedPid !== undefined && pid !== expectedPid || typeof value.token !== "string" || !value.token || value.host !== hostname() || typeof value.createdAt !== "string" || (Date.parse(value.createdAt) < createdAt || Date.parse(value.createdAt) > Date.now()) || read.id.uid !== rootIdentity.uid) fail(new Error("Fixture claim identity/lifetime is not owned"));
		return { ...read.id, path: paths.claim, bytes: read.bytes, value, metadata, pid };
	}
	function capture(metadata: HostMetadata, pid?: number): void {
		const next = snapshot(metadata, pid), previous = captured.get(next.path);
		if (previous && (!equalIdentity(previous, next) || !previous.bytes.equals(next.bytes))) fail(new Error("Fixture claim changed before recovery"));
		captured.set(next.path, next);
	}
	function admitSessionsRoot(options: HostLaunchOptions): string {
		const sessionsRoot = options.env?.PI_AGENT_SESSIONS_DIR ?? root;
		descendant(sessionsRoot);
		const catalogueRoot = join(sessionsRoot, "durable");
		if (started && !catalogueRoots.has(catalogueRoot)) fail(new Error("Fixture namespace changed after launch"));
		catalogueRoots.add(catalogueRoot);
		return sessionsRoot;
	}
	function validateFailedReloadOptions(options: HostLaunchOptions): void {
		if (options.env?.DURABLE_TEST_MODE !== "answer" || options.runnerArgs?.length) fail(new Error("Failed reload fixture requires answer mode without runner arguments"));
	}
	function validateQueueSource(options: HostLaunchOptions): void {
		if (options.runnerArgs?.length !== 2 || options.runnerArgs[0] !== `${dirname(fileURLToPath(import.meta.url))}/`) fail(new Error("Queue fixture source is not the fixed repository source"));
	}
	function validateRunner(metadata: HostMetadata, options: HostLaunchOptions): string {
		const runner = options.runner ?? RUNNERS[0];
		if (!RUNNERS.includes(runner) && runner !== FAILED_RELOAD_RUNNER) fail(new Error("Offline fixture runner is not a closed fixture mode"));
		if (runner === FAILED_RELOAD_RUNNER) validateFailedReloadOptions(options);
		if (runner === RUNNERS[2]) validateQueueSource(options);
		const mode = options.env?.DURABLE_TEST_MODE;
		if (runner === RUNNERS[0] && mode !== "request" && mode !== "effect" && mode !== "answer") fail(new Error("Offline fixture mode permits unknown launchers"));
		if (options.env?.DURABLE_TEST_HTTP || options.env?.DURABLE_TEST_RETRY || allowed.has(recipientKey(metadata.ownerId ?? ""))) fail(new Error("Offline fixture has a native recipient or unsupported provider mode"));
		return runner;
	}
	function pinIndependentExtension(metadata: HostMetadata): void {
		const path = join(metadata.agentDir, "independent.ts"), bytes = readBounded(path, false).bytes;
		const before = configuration.get(path);
		if (before && !before.equals(bytes)) fail(new Error("Independent fixture extension changed"));
		configuration.set(path, bytes);
	}
	function validateExtensions(metadata: HostMetadata, settings: Record<string, unknown>, bytes: Buffer, timerRunner: boolean): void {
		const extensions = settings.extensions;
		const agentContribution = fileURLToPath(new URL("./index.ts", import.meta.url));
		const preparedTimerSettings = [{ enabled: false }, { enabled: true, maxRetries: 1, baseDelayMs: 0, maxAgentDelayMs: 0 }].map((retry) => Buffer.from(JSON.stringify({ cacheWarming: "off", retry, extensions: [agentContribution] })));
		if (timerRunner && !preparedTimerSettings.some((prepared) => bytes.equals(prepared))) fail(new Error("Timer runner requires its exact prepared configuration"));
		const permitted = timerRunner ? [agentContribution] : [fileURLToPath(new URL("./testdata/durable-runtime/index.ts", import.meta.url)), join(metadata.agentDir, "independent.ts")];
		if (extensions !== undefined && (!Array.isArray(extensions) || extensions.some(path => !permitted.includes(path)))) fail(new Error("Offline fixture settings expose untracked launchers"));
		if (Array.isArray(extensions) && extensions.includes(join(metadata.agentDir, "independent.ts"))) pinIndependentExtension(metadata);
	}
	function validateSettings(metadata: HostMetadata, runner: string): void {
		const settingsPath = join(metadata.agentDir, "settings.json");
		const timerRunner = runner === RUNNERS[1];
		if (timerRunner && absent(settingsPath)) fail(new Error("Timer runner requires prepared final settings"));
		if (!absent(settingsPath)) {
			const read = readBounded(settingsPath);
			const previous = configuration.get(settingsPath);
			if (previous && !previous.equals(read.bytes)) fail(new Error("Fixture launcher settings changed"));
			configuration.set(settingsPath, read.bytes);
			validateExtensions(metadata, read.value, read.bytes, timerRunner);
		}
	}
	function validateOptions(metadata: HostMetadata, options: HostLaunchOptions): HostLaunchOptions {
		metadataCheck(metadata);
		const sessionsRoot = admitSessionsRoot(options);
		const runner = validateRunner(metadata, options);
		validateSettings(metadata, runner);
		scan();
		return { ...options, runner, retryAttempts: 0, env: { ...options.env, PI_AGENT_DIR: metadata.agentDir, PI_CODING_AGENT_DIR: metadata.agentDir, PI_AGENT_SESSIONS_DIR: sessionsRoot, PI_HARNESS_FILE: join(metadata.agentDir, "harness.json") } };
	}
	function prepareAcquisition(metadata: HostMetadata, options: HostLaunchOptions): { launch: HostLaunchOptions; before: Captured | undefined } {
		const launch = validateOptions(metadata, options);
		const claimPath = hostPaths(metadata).claim;
		const before = captured.get(claimPath);
		if (before && absent(claimPath)) {
			if (!gone(before.pid)) fail(new Error("A claim disappeared before its owned writer exited"));
			captured.delete(claimPath);
		}
		return { launch, before };
	}
	function isExpectedAttachAbsence(metadata: HostMetadata, connect: boolean, before: Captured | undefined, error: unknown): boolean {
		if (!connect || !(error instanceof HostEndpointUnavailableError)) return false;
		metadataCheck(metadata);
		const claimPath = hostPaths(metadata).claim;
		descendant(claimPath);
		if (absent(claimPath)) return before === undefined || gone(before.pid);
		if (!before) return false;
		const current = snapshot(metadata);
		return equalIdentity(before, current) && before.bytes.equals(current.bytes) && gone(before.pid);
	}
	class Generation implements OfflineGeneration {
		private sealed = false;
		owns(pid: number): boolean { return this.writers.has(pid); }
		private tail: Promise<unknown> = Promise.resolve();
		private readonly work = new Set<Promise<unknown>>();
		private readonly clients = new Set<HostConnection>();
		private readonly writers = new Set<number>();
		private readonly children = new Map<ChildProcess, Promise<void>>();
		private readonly managers = new Set<Managed>();
		private readonly controllers = new Set<AbortController>();
		private enter(metadata: HostMetadata, options: HostLaunchOptions, connect: boolean): Promise<HostConnection> {
			if (this.sealed || phase !== "open") return Promise.reject(new Error("Fixture launch generation is closed"));
			let entered = false, expectedRefusal = false;
			const job = this.tail.then(async () => {
				if (this.sealed || phase !== "open") throw new Error("Fixture launch generation is closed");
				entered = true;
				const { launch, before } = prepareAcquisition(metadata, options);
				started = true;
				let client: HostConnection;
				try { client = await (connect ? connectHost : acquireHost)(metadata, launch); }
				catch (error) {
					if (isExpectedAttachAbsence(metadata, connect, before, error)) { expectedRefusal = true; throw error; }
					return fail(error);
				}
				this.clients.add(client); this.writers.add(client.pid);
				capture(metadata, client.pid);
				return client;
			}).catch(error => { if (entered && !expectedRefusal) markPoison(error); throw error; });
			this.work.add(job); this.tail = job.catch(() => undefined);
			void job.then(() => this.work.delete(job), () => this.work.delete(job));
			return job;
		}
		readonly acquire = (metadata: HostMetadata, options: HostLaunchOptions = {}): Promise<HostConnection> => this.enter(metadata, options, false);
		readonly connect = (metadata: HostMetadata, options: HostLaunchOptions = {}): Promise<HostConnection> => this.enter(metadata, options, true);
		manager(value: Managed): void { requireOpen(); if (this.sealed) throw new Error("Manager registered after seal"); this.managers.add(value); }
		controller(value: AbortController): AbortController { requireOpen(); if (this.sealed) throw new Error("Controller registered after seal"); this.controllers.add(value); return value; }
		declare(metadata: HostMetadata): void { if (this.sealed) throw new Error("Fixture launch generation is closed"); fixture.allow(metadata); }
		seed(action: () => Promise<void>): Promise<void> {
			if (this.sealed || phase !== "open" || this.work.size || this.writers.size) return Promise.reject(new Error("Seed requires an unused open generation"));
			let entered = false;
			const job = Promise.resolve().then(() => { if (this.sealed || phase !== "open") throw new Error("Fixture launch generation is closed"); entered = true; started = true; scan(); return action(); }).catch(error => { if (entered) markPoison(error); throw error; });
			this.work.add(job); this.tail = job.catch(() => undefined);
			void job.then(() => this.work.delete(job), () => this.work.delete(job));
			return job;
		}
		raw(metadata: HostMetadata, start: (options: HostLaunchOptions) => ChildProcess, options: HostLaunchOptions): ChildProcess {
			if (this.sealed || phase !== "open") throw new Error("Fixture launch generation is closed");
			if (this.work.size || this.writers.size) throw new Error("Raw launch requires an empty open generation");
			const launch = validateOptions(metadata, options);
			let child: ChildProcess;
			started = true;
			try { child = start(launch); } catch (error) { return fail(error); }
			const completion = new Promise<void>((done, reject) => {
				child.once("exit", () => { if (captured.get(hostPaths(metadata).claim)?.pid !== child.pid) markPoison(new Error("Raw child exited without a captured claim")); done(); });
				child.once("error", error => { markPoison(error); reject(error); });
			});
			void completion.catch(() => undefined);
			this.children.set(child, completion);
			if (!child.pid) fail(new Error("Raw fixture child has no PID"));
			this.writers.add(child.pid);
			return child;
		}
		checkpoint(metadata: HostMetadata): void {
			if (this.sealed || phase !== "open") throw new Error("Checkpoint after seal");
			const claim = snapshot(metadata);
			if (!this.writers.has(claim.pid)) fail(new Error("Raw claim is not its registered child"));
			capture(metadata, claim.pid); scan();
		}
		seal(): void {
			if (this.sealed) return;
			this.sealed = true;
			for (const controller of this.controllers) controller.abort();
			for (const manager of this.managers) {
				const closing = Promise.resolve().then(() => manager.close()).catch(fail);
				this.work.add(closing);
				void closing.then(() => this.work.delete(closing), () => this.work.delete(closing));
			}
		}
		private async closeClients(teardown: boolean): Promise<void> {
			if (teardown) for (const client of this.clients) if (!client.closed) await client.request("close", undefined, { signal: AbortSignal.timeout(10000) }).catch(() => undefined);
			for (const client of this.clients) await client.close();
		}
		private verifyRawChildrenExited(): void {
			for (const child of this.children.keys()) if (child.exitCode === null && child.signalCode === null) fail(new Error("Raw fixture child exit is unproved; root retained"));
		}
		async join(teardown: boolean): Promise<void> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try { await Promise.race([Promise.all([...this.children.values(), Promise.allSettled([...this.work])]), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Fixture acquisitions did not join; root retained")), 10000); })]); }
			finally { clearTimeout(timer); }
			checkRoot();
			await this.closeClients(teardown);
			this.verifyRawChildrenExited();
			for (const pid of this.writers) await exited(pid);
		}
	}
	function verifyConfiguration(): void {
		for (const [path, bytes] of configuration) if (!readBounded(path, false).bytes.equals(bytes)) fail(new Error("Fixture launcher configuration changed before recovery"));
	}
	function verifyCapturedClaims(): void {
		for (const capturedClaim of captured.values()) {
			if (absent(capturedClaim.path)) continue;
			const current = snapshot(capturedClaim.metadata);
			if (!equalIdentity(current, capturedClaim) || !current.bytes.equals(capturedClaim.bytes) || !gone(capturedClaim.pid)) fail(new Error("Captured claim changed or writer still exists; root retained"));
		}
	}
	async function quiesce(teardown: boolean): Promise<void> {
		for (const generation of generations) generation.seal();
		for (const generation of generations) await generation.join(teardown);
		scan();
		verifyConfiguration();
		verifyCapturedClaims();
	}
	function validateStorageDeclaration(metadata: HostMetadata): void {
		let nativeId: string;
		try { nativeId = storageIdOf(metadata.storageId); } catch (error) { fail(error); }
		if (nativeId !== metadata.storageId) fail(new Error("Fixture storage identity must be a canonical native root"));
		for (const path of [metadata.cwd, metadata.agentDir, metadata.storagePath]) descendant(path);
		if (recipients.has(nativeId)) fail(new Error("An ordinary recipient became a native target"));
	}
	function removeCapturedClaims(): void {
		for (const claim of captured.values()) if (!absent(claim.path)) {
			const current = snapshot(claim.metadata);
			if (!equalIdentity(current, claim) || !current.bytes.equals(claim.bytes)) fail(new Error("Claim changed before unlink"));
			unlinkSync(claim.path);
			if (!absent(claim.path)) fail(new Error("Claim absence not established"));
		}
	}
	const fixture: OfflineFixture = Object.freeze({
		root,
		get cleanupAllowed() { return phase === "closed" && cleanupAllowed && poison === undefined; },
		allow(metadata: HostMetadata) {
			requireOpen();
			validateStorageDeclaration(metadata);
			if (allowed.has(metadata.storageId)) metadataCheck(metadata);
			else { if (started || allowed.size >= 2) fail(new Error("Fixture catalogue identities are fixed before launch")); allowed.set(metadata.storageId, structuredClone(metadata)); }
			if (metadata.ownerId) fixture.ordinaryRecipient(metadata.ownerId);
		},
		ordinaryRecipient(identity: string) { requireOpen(); const key = recipientKey(identity); if (allowed.has(key)) fail(new Error("Offline fixture native recipient is unsupported")); recipients.add(key); },
		track(pid: number) { checkRoot(); if (!generations.some(generation => generation.owns(pid))) fail(new Error("Tracked PID has no offline launch ownership")); },
		generation() {
			requireOpen();
			if (active) throw new Error("Fixture has a launch generation; only recovery creates its successor");
			const generation = new Generation(); generations.push(generation); active = generation; return generation;
		},
		async recover() {
			requireOpen();
			phase = "recovering";
			try {
				await quiesce(false);
				removeCapturedClaims();
				captured.clear();
				const successor = new Generation(); generations.push(successor); active = successor;
				phase = "open";
				return successor;
			} catch (error) { phase = "closed"; return fail(error); }
		},
		async teardown() {
			if (phase !== "open" && !(phase === "closed" && cleanupAllowed && poison === undefined)) { checkRoot(); throw new Error(`Fixture lifecycle is ${phase}`); }
			phase = "closing";
			try { await quiesce(true); cleanupAllowed = true; phase = "closed"; }
			catch (error) { phase = "closed"; return fail(error); }
		},
	});
	fixtures.set(root, fixture);
	return fixture;
}

/** Teardown uses the allocation capability, never a reconstructed path receipt. */
export function offlineFixtureFor(root: string): OfflineFixture | undefined { return fixtures.get(resolve(root)); }
