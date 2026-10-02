/**
 * Synthetic durable host runtime for transport tests.
 *
 * Imported by tests for its state helpers and metadata builder. Run as the
 * child process, it takes the claim through runHost, announces readiness, and
 * serves fixture methods until it retires or is killed.
 */
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HostError, parseHostMetadata, type HostMetadata } from "./host-protocol.ts";
import { runHost, type HostRuntime } from "./host-process.ts";
import type { HostConnection } from "./host-client.ts";

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

/** Stable per-root storage identity so separate test roots never share a socket path. */
function storageIdForRoot(root: string): string {
	const digest = createHash("sha256").update(root).digest("hex");
	const variant = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Stable metadata for one fixture host under a test root. */
export function fixtureMetadata(root: string, storageId = storageIdForRoot(root)): HostMetadata {
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

export interface EventLog<T> extends Array<T> {
	/** Resolve from recorded producer events, including events recorded before this call. */
	waitFor(predicate: (events: readonly T[]) => boolean, timeoutMs?: number): Promise<void>;
	waitForCount(count: number, timeoutMs?: number): Promise<void>;
}

/** An ordinary array whose push records a producer event and notifies pending consumers. */
export function eventLog<T>(): EventLog<T> {
	const events: T[] = [];
	const listeners = new Set<() => void>();
	const waitFor = (predicate: (events: readonly T[]) => boolean, timeoutMs = 5000): Promise<void> => {
		if (predicate(events)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const finish = (error?: Error): void => {
				clearTimeout(timer);
				listeners.delete(check);
				if (error) reject(error);
				else resolve();
			};
			const check = (): void => { if (predicate(events)) finish(); };
			const timer = setTimeout(() => finish(new Error("fixture producer event did not arrive")), timeoutMs);
			listeners.add(check);
		});
	};
	Object.defineProperties(events, {
		push: { value: (...values: T[]) => {
			const length = Array.prototype.push.apply(events, values);
			for (const listener of [...listeners]) listener();
			return length;
		} },
		waitFor: { value: waitFor },
		waitForCount: { value: (count: number, timeoutMs?: number) => waitFor((items) => items.length >= count, timeoutMs) },
	});
	return events as EventLog<T>;
}

/** Observe the actual exit of an owned child, not writer-claim release. */
export function waitForProcessExit(child: ChildProcess, timeoutMs = 10000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const finish = (error?: Error): void => {
			clearTimeout(timer);
			child.off("exit", onExit);
			child.off("error", onError);
			if (error) reject(error);
			else resolve();
		};
		const onExit = (): void => finish();
		const onError = (error: Error): void => finish(error);
		const timer = setTimeout(() => finish(new Error("fixture process did not exit")), timeoutMs);
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

/** Observe permanent connection closure from its public event. */
export function waitForConnectionClose(host: HostConnection, timeoutMs = 10000): Promise<void> {
	if (host.closed) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { unsubscribe(); reject(new Error("fixture connection did not close")); }, timeoutMs);
		const unsubscribe = host.onClose(() => { clearTimeout(timer); unsubscribe(); resolve(); });
		if (host.closed) { clearTimeout(timer); unsubscribe(); resolve(); }
	});
}

/** Recheck persistent fixture state only on real host change notifications. */
export async function waitForFixtureState(host: Pick<HostConnection, "subscribeChanges">, path: string, predicate: (state: FixtureState) => boolean, timeoutMs = 5000): Promise<void> {
	if (!host.subscribeChanges) throw new Error("fixture host has no change notifications");
	let unsubscribe: (() => void) | undefined;
	let settled = false;
	let finish: (error?: Error) => void = () => {};
	const completed = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error("fixture state event did not arrive")), timeoutMs);
		finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			if (error) reject(error);
			else resolve();
		};
	});
	void completed.catch(() => {});
	try {
		unsubscribe = await host.subscribeChanges(() => { if (predicate(readFixtureState(path))) finish(); });
		if (settled) unsubscribe();
		else if (predicate(readFixtureState(path))) finish();
	} catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
	await completed;
}

export function createFixtureRuntime(statePath: string): HostRuntime {
	const waiters: Array<(value: unknown) => void> = [];
	const changeListeners = new Set<() => void>();
	let busy = false;
	const publishState = (patch: FixtureState): void => {
		writeFixtureState(statePath, patch);
		for (const listener of [...changeListeners]) listener();
	};
	const releaseWaits = (): void => {
		const released = waiters.splice(0);
		publishState({ release: true, waitCompleted: (readFixtureState(statePath).waitCompleted ?? 0) + released.length });
		for (const resolve of released) resolve({ released: true });
	};
	const startWait = (signal?: AbortSignal): Promise<unknown> => {
		publishState({ waitsStarted: (readFixtureState(statePath).waitsStarted ?? 0) + 1 });
		if (readFixtureState(statePath).release === true) {
			publishState({ waitCompleted: (readFixtureState(statePath).waitCompleted ?? 0) + 1 });
			return Promise.resolve({ released: true });
		}
		return new Promise((resolve, reject) => {
			const waiter = (value: unknown) => resolve(value);
			waiters.push(waiter);
			signal?.addEventListener("abort", () => {
				const index = waiters.indexOf(waiter);
				if (index >= 0) waiters.splice(index, 1);
				publishState({ waitsCancelled: (readFixtureState(statePath).waitsCancelled ?? 0) + 1 });
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
				case "release-waits":
					releaseWaits();
					return { released: true };
				case "effect": {
					const state = readFixtureState(statePath);
					writeFixtureState(statePath, { effects: (state.effects ?? 0) + 1 });
					return { effect: true };
				}
				case "hang":
					publishState({ hangsStarted: (readFixtureState(statePath).hangsStarted ?? 0) + 1, ...(signal === undefined ? {} : { hangsSignaled: true }) });
					return new Promise(() => {});
				case "touch":
					for (const listener of [...changeListeners]) listener();
					return { touched: true };
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
			writeFixtureState(statePath, { closed: (readFixtureState(statePath).closed ?? 0) + 1 });
		},
		isIdle: () => !busy,
		onChange: (listener) => {
			changeListeners.add(listener);
			return () => {
				changeListeners.delete(listener);
			};
		},
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
