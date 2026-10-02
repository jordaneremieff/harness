/**
 * Synthetic durable host runtime for transport tests.
 *
 * Imported by tests for its state helpers and metadata builder. Run as the
 * child process, it takes the claim through runHost, announces readiness, and
 * serves fixture methods until it retires or is killed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HostError, HOST_MAX_FRAME_BYTES, parseHostMetadata, type HostMetadata } from "./host-protocol.ts";
import { runHost, type HostRuntime } from "./host-process.ts";

export interface FixtureState {
	starts?: number;
	closed?: number;
	effects?: number;
	release?: boolean;
	waitsStarted?: number;
	waitCompleted?: number;
	waitsCancelled?: number;
	hangsStarted?: number;
	hangsSignaled?: boolean;
	submitted?: Record<string, number>;
	nextSubmission?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readFixtureState(path: string): FixtureState {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(value) ? (value as FixtureState) : {};
	} catch {
		return {};
	}
}

export function writeFixtureState(path: string, patch: FixtureState): FixtureState {
	const next = { ...readFixtureState(path), ...patch };
	writeFileSync(path, JSON.stringify(next));
	return next;
}

/** Stable metadata for one fixture host under a test root. */
export function fixtureMetadata(root: string, storageId = "fixture-storage"): HostMetadata {
	return {
		storageId,
		cwd: root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		storagePath: join(root, "storage.sqlite"),
		model: { provider: "fixture", modelId: "fixture-model" },
		thinkingLevel: "off",
		ownerId: "fixture-owner",
	};
}

/** Poll a test condition without a fixed sleep. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() >= deadline) throw new Error("fixture condition was not reached before its deadline");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function createFixtureRuntime(statePath: string): HostRuntime {
	const waiters: Array<(value: unknown) => void> = [];
	let busy = false;
	const poll = setInterval(() => {
		const state = readFixtureState(statePath);
		if (state.release !== true || waiters.length === 0) return;
		const released = waiters.splice(0);
		for (const resolve of released) resolve({ released: true });
		writeFixtureState(statePath, { waitCompleted: (readFixtureState(statePath).waitCompleted ?? 0) + released.length });
	}, 10);
	poll.unref();
	const startWait = (signal?: AbortSignal): Promise<unknown> => {
		writeFixtureState(statePath, { waitsStarted: (readFixtureState(statePath).waitsStarted ?? 0) + 1 });
		return new Promise((resolve, reject) => {
			const waiter = (value: unknown) => resolve(value);
			waiters.push(waiter);
			signal?.addEventListener("abort", () => {
				const index = waiters.indexOf(waiter);
				if (index >= 0) waiters.splice(index, 1);
				writeFixtureState(statePath, { waitsCancelled: (readFixtureState(statePath).waitsCancelled ?? 0) + 1 });
				reject(signal.reason instanceof Error ? signal.reason : new Error("fixture wait cancelled"));
			}, { once: true });
		});
	};
	return {
		request: async (method, params, requestId, signal) => {
			switch (method) {
				case "echo":
					return params;
				case "submit": {
					const state = readFixtureState(statePath);
					const submitted = state.submitted ?? {};
					let submissionId = submitted[requestId];
					if (submissionId === undefined) {
						submissionId = (state.nextSubmission ?? 100) + 1;
						submitted[requestId] = submissionId;
						writeFixtureState(statePath, { submitted, nextSubmission: submissionId });
					}
					return { submissionId, requestId, params };
				}
				case "wait":
				case "receipts":
					return startWait(signal);
				case "effect": {
					const state = readFixtureState(statePath);
					writeFixtureState(statePath, { effects: (state.effects ?? 0) + 1 });
					return { effect: true };
				}
				case "hang":
					writeFixtureState(statePath, { hangsStarted: (readFixtureState(statePath).hangsStarted ?? 0) + 1, ...(signal === undefined ? {} : { hangsSignaled: true }) });
					return new Promise(() => {});
				case "huge":
					return "x".repeat(HOST_MAX_FRAME_BYTES + 16);
				case "busy":
					busy = true;
					return { busy: true };
				case "release-busy":
					busy = false;
					return { busy: false };
				case "inspect":
					return readFixtureState(statePath);
				case "snapshot":
					return readFixtureState(statePath);
				default:
					throw new HostError(`unknown fixture method ${method}`, "invalid");
			}
		},
		close: async () => {
			clearInterval(poll);
			writeFixtureState(statePath, { closed: (readFixtureState(statePath).closed ?? 0) + 1 });
		},
		isIdle: () => !busy,
	};
}

async function main(): Promise<void> {
	const metadataJson = process.argv[2];
	if (!metadataJson) throw new Error("fixture requires metadata JSON as its only argument");
	const metadata = parseHostMetadata(JSON.parse(metadataJson));
	const statePath = join(dirname(metadata.storagePath), "state.json");
	writeFixtureState(statePath, { starts: (readFixtureState(statePath).starts ?? 0) + 1 });
	const host = await runHost(() => createFixtureRuntime(statePath), { metadata });
	await host.done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	});
}
