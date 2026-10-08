import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { FakeHost, frame, snapshot, STORAGE } from "./fake-host.mts";

export const SNAPSHOT_TEXT_BYTES = 15 * 1024 * 1024;
export const LIVE_TEXT_BYTES = 1024 * 1024 - 4096;
export const BURST_FRAMES = 32;
export interface PerformanceFixtureInfo {
	endpoint: { serverId: string; socketPath: string };
	snapshotJsonBytes: number; snapshotTextBytes: number;
	liveJsonBytes: number; liveTextBytes: number; burstFrames: number;
}
export type FixtureCommand = { id: number; kind: "burst"; firstRevision: number }
	| { id: number; kind: "check" } | { id: number; kind: "close" };
export type FixtureError = { code: string | null; message: string };
export type FixtureMessage = { kind: "ready"; info: PerformanceFixtureInfo }
	| { kind: "done"; id: number; published?: number; errors?: FixtureError[] }
	| { kind: "failed"; id?: number; error: string };

function fixtureErrors(errors: Error[]): FixtureError[] {
	return errors.map(error => {
		const code = (error as NodeJS.ErrnoException).code;
		return { message: error.message, code: typeof code === "string" ? code : null };
	});
}
async function dispatch(command: FixtureCommand, host: FakeHost, port: MessagePort, live: ReturnType<typeof frame>): Promise<void> {
	if (command.kind === "close" || command.kind === "check") {
		if (command.kind === "close") await host.close();
		port.postMessage({ kind: "done", id: command.id, errors: fixtureErrors(host.errors) } satisfies FixtureMessage);
		if (command.kind === "close") port.close(); return;
	}
	if (!Number.isSafeInteger(command.firstRevision) || command.firstRevision < 2) throw new Error("Invalid fixture revision");
	for (let i = 0; i < BURST_FRAMES; i++) await host.publish({ ...live, revision: command.firstRevision + i });
	port.postMessage({ kind: "done", id: command.id, published: BURST_FRAMES } satisfies FixtureMessage);
}
async function run(): Promise<void> {
	const port = parentPort;
	if (!port) throw new Error("Performance fixture requires a worker");
	const largeSnapshot = snapshot();
	largeSnapshot.entries = [{ id: "1", kind: "assistant", model: [{ role: "assistant",
		content: [{ type: "text", text: "x".repeat(SNAPSHOT_TEXT_BYTES) }], timestamp: 0 }] }];
	largeSnapshot.coverage = { complete: true, entries: 1, bytes: SNAPSHOT_TEXT_BYTES,
		hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: true };
	const live = frame(2, STORAGE);
	live.live = [{ id: "live:generation", kind: "assistant", model: [{ role: "assistant",
		content: [{ type: "text", text: "y".repeat(LIVE_TEXT_BYTES) }], timestamp: 0 }] }];
	const init = workerData as { endpoint?: { serverId: string; socketPath: string } } | undefined;
	const host = await FakeHost.start({ endpoint: init?.endpoint,
		handler: call => call.member === "snapshot" ? largeSnapshot : undefined });
	const info: PerformanceFixtureInfo = { endpoint: host.endpoint, snapshotJsonBytes: Buffer.byteLength(JSON.stringify(largeSnapshot)),
		snapshotTextBytes: SNAPSHOT_TEXT_BYTES, liveJsonBytes: Buffer.byteLength(JSON.stringify(live)),
		liveTextBytes: LIVE_TEXT_BYTES, burstFrames: BURST_FRAMES };
	let queue: Promise<void> = Promise.resolve();
	port.on("message", (command: FixtureCommand) => {
		queue = queue.then(() => dispatch(command, host, port, live)).catch((error: unknown) => {
			port.postMessage({ kind: "failed", id: command.id, error: error instanceof Error ? error.message : "Fixture command failed" } satisfies FixtureMessage);
		});
	});
	port.postMessage({ kind: "ready", info } satisfies FixtureMessage);
}
if (parentPort) void run().catch((error: unknown) => {
	parentPort?.postMessage({ kind: "failed", error: error instanceof Error ? error.message : "Fixture startup failed" } satisfies FixtureMessage);
	parentPort?.close();
});
