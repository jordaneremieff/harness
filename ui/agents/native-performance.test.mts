import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { projectEntry, projectFrame } from "../server/projection.mts";
import { deriveEndpoint } from "./catalog.mts";
import { HostLink } from "./client.mts";
import type { ConversationFrame, Snapshot } from "./contract.mts";
import type { FixtureCommand, FixtureError, FixtureMessage, PerformanceFixtureInfo } from "./native-performance-host.mts";

const STORAGE = "00000000-0000-4000-8000-000000000001";
const SAMPLES = 3;
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
type Done = Extract<FixtureMessage, { kind: "done" }>;
class FixtureWorker {
	readonly #worker: Worker;
	readonly #ready = deferred<PerformanceFixtureInfo>();
	readonly #exited = deferred<number>();
	readonly #pending = new Map<number, ReturnType<typeof deferred<Done>>>();
	#next = 0;
	#closed = false;
	#checked = false;
	constructor(endpoint?: { serverId: string; socketPath: string }) {
		this.#worker = new Worker(new URL("./native-performance-host.mts", import.meta.url), { workerData: { endpoint } });
		this.#worker.on("message", (message: FixtureMessage) => {
			if (message.kind === "ready") { this.#ready.resolve(message.info); return; }
			if (message.kind === "failed") { this.fail(new Error(message.error)); return; }
			this.#pending.get(message.id)?.resolve(message); this.#pending.delete(message.id);
		});
		this.#worker.on("error", error => this.fail(error));
		this.#worker.on("exit", code => {
			this.#closed = true; this.#exited.resolve(code);
			this.fail(new Error(`Fixture worker exited with ${code}`));
		});
	}
	private fail(error: Error): void {
		this.#ready.reject(error);
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
	ready(): Promise<PerformanceFixtureInfo> { return this.#ready.promise; }
	private command(command: Omit<Extract<FixtureCommand, { kind: "burst" }>, "id"> | { kind: "check" | "close" }): Promise<Done> {
		assert.equal(this.#closed, false, "Fixture is closed");
		const id = ++this.#next; const pending = deferred<Done>(); this.#pending.set(id, pending);
		this.#worker.postMessage({ ...command, id }); return pending.promise;
	}
	burst(firstRevision: number): Promise<Done> { return this.command({ kind: "burst", firstRevision }); }
	async check(): Promise<void> {
		const done = await this.command({ kind: "check" }); assert.deepEqual(done.errors, []); this.#checked = true;
	}
	async close(): Promise<FixtureError[]> {
		if (this.#closed) return [];
		try {
			const done = await this.command({ kind: "close" }); const errors = done.errors ?? [];
			// Client disposal disconnects immediately; a server write callback can then report EPIPE.
			if (this.#checked) for (const error of errors) assert.equal(error.code, "EPIPE");
			else assert.deepEqual(errors, []);
			assert.equal(await this.#exited.promise, 0); return errors;
		} finally { await this.#worker.terminate(); }
	}
}

/** Timer ticks measure responsiveness; they are not readiness polls or retry delays. */
class LoopSample {
	readonly #histogram = monitorEventLoopDelay({ resolution: 1 });
	readonly #timer: ReturnType<typeof setInterval>;
	#last = performance.now();
	#maxGap = 0;
	#ticks = 0;
	#nextTick?: () => void;
	constructor() {
		this.#histogram.enable();
		this.#timer = setInterval(() => {
			const now = performance.now(); this.#maxGap = Math.max(this.#maxGap, now - this.#last);
			this.#last = now; this.#ticks++;
			const next = this.#nextTick; this.#nextTick = undefined; next?.();
		}, 1);
	}
	async arm(): Promise<void> {
		await this.tick(); this.#maxGap = 0; this.#ticks = 0; this.#histogram.reset();
	}
	private tick(): Promise<void> { return new Promise(resolve => { this.#nextTick = resolve; }); }
	async stop(): Promise<{ maxGapMs: number; histogramMaxMs: number; ticks: number }> {
		await this.tick(); await this.tick(); clearInterval(this.#timer); this.#histogram.disable();
		return { maxGapMs: this.#maxGap, histogramMaxMs: this.#histogram.max / 1000000, ticks: this.#ticks };
	}
	dispose(): void { clearInterval(this.#timer); this.#histogram.disable(); }
}
type Span = { count: number; sumMs: number; maxMs: number };
class Measures {
	readonly #values = new Map<string, Span>();
	add(name: string, ms: number): void {
		const span = this.#values.get(name) ?? { count: 0, sumMs: 0, maxMs: 0 };
		span.count++; span.sumMs += ms; span.maxMs = Math.max(span.maxMs, ms); this.#values.set(name, span);
	}
	reset(): void { this.#values.clear(); }
	read(): Record<string, Span> { return Object.fromEntries([...this.#values].map(([name, span]) => [name, { ...span }])); }
}
type Sample = { elapsedMs: number; maxGapMs: number; histogramMaxMs: number; ticks: number; spans: Record<string, Span> };
async function measure(measures: Measures, action: () => Promise<void>): Promise<Sample> {
	measures.reset(); const loop = new LoopSample();
	try {
		await loop.arm(); const started = performance.now(); await action(); const elapsedMs = performance.now() - started;
		return { elapsedMs, ...await loop.stop(), spans: measures.read() };
	} finally { loop.dispose(); }
}
function nativeCoverage(value: Snapshot["coverage"]): Record<string, unknown> {
	return Object.fromEntries(["complete", "entries", "bytes", "hiddenExcluded", "entryLimitReached", "byteLimitReached"]
		.map(key => [key, value[key]]));
}
function distribution(values: number[]): { median: number; max: number } {
	const sorted = [...values].sort((a, b) => a - b); return { median: sorted[Math.floor(sorted.length / 2)], max: Math.max(...sorted) };
}
function summary(samples: Sample[]) {
	const spanNames = new Set(samples.flatMap(sample => Object.keys(sample.spans)));
	return {
		elapsedMs: distribution(samples.map(sample => sample.elapsedMs)),
		maxGapMs: distribution(samples.map(sample => sample.maxGapMs)),
		histogramMaxMs: distribution(samples.map(sample => sample.histogramMaxMs)),
		spans: Object.fromEntries([...spanNames].map(name => [name, {
			sumMs: distribution(samples.map(sample => sample.spans[name]?.sumMs ?? 0)),
			maxMs: distribution(samples.map(sample => sample.spans[name]?.maxMs ?? 0)),
			counts: samples.map(sample => sample.spans[name]?.count ?? 0),
		}])),
	};
}

// Numeric latency limits are diagnostic acceptance evidence, not machine-speed assertions.
test("worker Unix host measures large native decode and projection on the backend loop", { timeout: 60000 }, async t => {
	const fixture = new FixtureWorker(); let link: HostLink | undefined;
	t.after(async () => { try { await link?.close(); }
		finally { t.diagnostic(JSON.stringify({ phase: "baseline-cleanup", shutdownErrors: await fixture.close() })); } });
	const info = await fixture.ready();
	assert.ok(info.snapshotJsonBytes > 15 * 1024 * 1024 && info.snapshotJsonBytes < 16 * 1024 * 1024);
	assert.ok(info.liveJsonBytes < 1024 * 1024 && info.liveJsonBytes > 1000 * 1024);
	assert.equal(info.burstFrames, 32);
	const measures = new Measures();
	link = await HostLink.connect(info.endpoint, { onMeasure: (name, ms) => measures.add(name, ms) });
	const connected = link;
	const snapshots: Sample[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const sample = await measure(measures, async () => {
			const value = await connected.request("snapshot", { sessionId: STORAGE, maxBytes: 1048576 }, { identity: STORAGE }) as Snapshot;
			assert.equal(value.entries.length, 1); assert.equal(value.coverage.byteLimitReached, true);
			const start = performance.now(); const projected = projectEntry(value.entries[0]);
			measures.add("native.snapshot.project", performance.now() - start);
			assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 64 * 1024);
			assert.equal(projected.messages?.[0]?.coverage.truncated, true);
		});
		snapshots.push(sample); t.diagnostic(JSON.stringify({ phase: "snapshot", sample: i + 1, ...sample }));
	}
	const token = "native-performance";
	await connected.request("observe-open", { token, scope: "conversation", sessionId: STORAGE }, { identity: STORAGE, token });
	let received: number[] = []; let all: ReturnType<typeof deferred<void>> | undefined;
	const subscription = await connected.subscribeObservation(token, (value: ConversationFrame) => {
		const start = performance.now(); const projected = projectFrame(value);
		measures.add("native.live.project", performance.now() - start);
		assert.equal(projected.revision, value.revision); assert.equal(projected.live.length, 1);
		assert.equal(projected.live[0]?.messages?.[0]?.coverage.truncated, true);
		received.push(value.revision); if (received.length === info.burstFrames) all?.resolve(undefined);
	}, STORAGE, error => all?.reject(error));
	subscription.start();
	const bursts: Sample[] = [];
	try {
		for (let i = 0; i < SAMPLES; i++) {
			received = []; all = deferred<void>(); const firstRevision = 2 + i * info.burstFrames;
			const sample = await measure(measures, async () => {
				const [done] = await Promise.all([fixture.burst(firstRevision), all?.promise]);
				assert.equal(done.published, info.burstFrames);
				assert.deepEqual(received, Array.from({ length: info.burstFrames }, (_, n) => firstRevision + n));
			});
			bursts.push(sample); t.diagnostic(JSON.stringify({ phase: "live-burst", sample: i + 1, ...sample }));
		}
	} finally { await subscription.dispose(); await connected.request("observe-close", { token }, { token }); }
	t.diagnostic(JSON.stringify({ fixture: { snapshotJsonBytes: info.snapshotJsonBytes, snapshotTextBytes: info.snapshotTextBytes,
		liveJsonBytes: info.liveJsonBytes, liveTextBytes: info.liveTextBytes, burstFrames: info.burstFrames },
		sampleCount: SAMPLES, snapshot: summary(snapshots), liveBurst: summary(bursts),
		note: "Transport spans time the public onData callback; validation and projection have separate spans. Timer gaps include scheduler delay." }));
	await fixture.check();
});

async function retainedFixture() {
	// The caller removes this private directory; its short path satisfies the Unix socket bound.
	const directory = await mkdtemp("/tmp/ui-native-perf-");
	try {
		await mkdir(join(directory, "durable"), { mode: 0o700 });
		const record = { storageId: STORAGE, cwd: directory, agentDir: directory, packageDir: directory,
			storagePath: join(directory, "durable", `${STORAGE}.sqlite`),
			model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off", createdAt: "2026-01-01T00:00:00.000Z" };
		const endpoint = deriveEndpoint(record);
		await mkdir(dirname(endpoint.socketPath), { recursive: true, mode: 0o700 });
		await mkdir(dirname(endpoint.claimPath), { recursive: true, mode: 0o700 });
		await writeFile(join(directory, "durable", `${STORAGE}.json`), JSON.stringify(record), { mode: 0o600 });
		await writeFile(endpoint.claimPath, JSON.stringify({ sessionId: STORAGE, cwd: directory,
			host: hostname(), createdAt: "2026-01-01T00:00:00.000Z", pid: process.pid }), { mode: 0o600 });
		return { directory, endpoint };
	} catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

test("isolated agent facade measures bounded snapshot and live projection on the backend loop", { timeout: 60000 }, async t => {
	const { createAgentService } = await import("./index.mts");
	const stored = await retainedFixture();
	let fixture: FixtureWorker | undefined; let service: ReturnType<typeof createAgentService> | undefined;
	t.after(async () => {
		try { await service?.close(); }
		finally { try { t.diagnostic(JSON.stringify({ phase: "facade-cleanup", shutdownErrors: await fixture?.close() })); }
			finally { await rm(stored.directory, { recursive: true, force: true }); } }
	});
	fixture = new FixtureWorker(stored.endpoint); const activeFixture = fixture;
	const info = await fixture.ready(); const measures = new Measures();
	let received: number[] = []; let all: ReturnType<typeof deferred<void>> | undefined;
	let firstRevision = 0; let finalRevision = 0;
	service = createAgentService({ store: stored.directory, installationId: "native-performance",
		onFrame: (_workspace, _identity, _epoch, value) => {
			if (!all || value.revision < firstRevision) return;
			try {
				const start = performance.now(); const projected = projectFrame(value);
				measures.add("native.facade.live.project", performance.now() - start);
				assert.equal(projected.revision, value.revision); assert.equal(projected.live.length, 1);
				assert.deepEqual(nativeCoverage(value.coverage), { complete: true, entries: 0, bytes: 0, hiddenExcluded: 0,
					entryLimitReached: false, byteLimitReached: false });
				assert.equal(value.coverage.truncated, true); assert.equal(value.coverage.uiComplete, false);
				assert.equal(value.nextBefore, null); assert.equal(value.sourceNextBefore, null);
				assert.equal(projected.coverage.truncated, true);
				assert.ok(Buffer.byteLength(JSON.stringify(value)) < 256 * 1024, "Facade must not deliver an unbounded native frame");
				received.push(value.revision); if (value.revision === finalRevision) all.resolve(undefined);
			} catch (error) { all.reject(error); }
		} });
	const facade = service;
	await facade.refresh(); await facade.select("native-performance", STORAGE);
	const snapshots: Sample[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const sample = await measure(measures, async () => {
			const value = await facade.history(STORAGE, { maxBytes: 1048576 });
			assert.equal(value.entries.length, 1); assert.equal(value.entries[0].id, "1");
			assert.deepEqual(nativeCoverage(value.coverage), { complete: true, entries: 1, bytes: info.snapshotTextBytes,
				hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: true });
			assert.equal(value.coverage.truncated, true); assert.equal(value.coverage.uiComplete, false);
			assert.equal(value.nextBefore, null); assert.equal(value.sourceNextBefore, null);
			assert.ok(Buffer.byteLength(JSON.stringify(value)) < 256 * 1024, "Facade snapshot must be bounded before parent projection");
			const start = performance.now(); const projected = projectEntry(value.entries[0]);
			measures.add("native.facade.snapshot.project", performance.now() - start);
			assert.equal(projected.messages?.[0]?.coverage.truncated, true);
		});
		snapshots.push(sample); t.diagnostic(JSON.stringify({ phase: "facade-snapshot", sample: i + 1, ...sample }));
	}
	const bursts: Sample[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		received = []; all = deferred<void>(); firstRevision = 2 + i * info.burstFrames; finalRevision = firstRevision + info.burstFrames - 1;
		const sample = await measure(measures, async () => {
			const [done] = await Promise.all([activeFixture.burst(firstRevision), all?.promise]);
			assert.equal(done.published, info.burstFrames); assert.equal(received.at(-1), finalRevision);
			assert.ok(received.every((revision, n) => revision >= firstRevision && (n === 0 || received[n - 1] < revision)));
		});
		all = undefined; bursts.push(sample);
		t.diagnostic(JSON.stringify({ phase: "facade-live-burst", sample: i + 1, received: received.length, ...sample }));
	}
	t.diagnostic(JSON.stringify({ fixture: { snapshotJsonBytes: info.snapshotJsonBytes, liveJsonBytes: info.liveJsonBytes,
		burstFrames: info.burstFrames }, sampleCount: SAMPLES, facadeSnapshot: summary(snapshots), facadeLiveBurst: summary(bursts),
		note: "Facade spans cover parent downstream projection only. Native transport, validation, and initial projection stay in the service worker. Timer gaps include scheduler delay." }));
	await activeFixture.check();
});
