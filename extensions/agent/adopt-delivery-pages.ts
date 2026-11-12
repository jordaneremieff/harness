/**
 * One-time manual transition of delivery reference pages that an earlier release wrote in version 1 format.
 * Run by hand: `node extensions/agent/adopt-delivery-pages.ts [--apply] [--storage <id>] [--agent-dir <dir>]`.
 * Each storage is read, and with `--apply` adopted, only while this process holds that storage's native writer
 * lease, so it never opens a storage beside its host. The default dry run changes no delivery data and prints
 * counts only. Pi's SQLite storage cannot open read-only: its open always runs the idempotent schema check in a
 * write transaction, so the dry run opens storages read-write under the lease as a host does.
 */
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createRegistry, Harness, type Cursor, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AgentCatalog, type CatalogRecord } from "./catalog.ts";
import { adoptDeliveryPages } from "./delivery-store.ts";
import { hostPaths } from "./host-protocol.ts";
import { tryNativeWriterLease, type NativeWriterLease } from "./native-lease.ts";

export const STORAGE_STATES = ["version 2 only", "no pages", "version 1", "version 1 with active task", "writer busy", "unreadable"] as const;
export type StorageState = (typeof STORAGE_STATES)[number];
const PAGE_KIND = "agent.delivery-page";
const SETTLED: ReadonlySet<StorageState> = new Set(["version 2 only", "no pages"]);
const SESSION = { kind: "session" } as const;
const STORAGE_FILE = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.sqlite$/u;

type StorageReader = Pick<Storage, "scanDocuments" | "document" | "scanTasks">;

/** Page versions and live version 1 Reporter tasks of one storage; reads only. */
async function pageState(storage: StorageReader, context: Context): Promise<StorageState> {
	let version1 = 0, version2 = 0;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanDocuments({ scope: SESSION, at: "current", kind: PAGE_KIND }, 256, cursor, context);
		for (const record of page.items) {
			if ((await storage.document(record.id, "current", context))?.version === 1) version1 += 1;
			else version2 += 1;
		}
		cursor = page.next ?? undefined;
	} while (cursor !== undefined);
	if (version1 === 0) return version2 === 0 ? "no pages" : "version 2 only";
	cursor = undefined;
	do {
		const page = await storage.scanTasks({ kind: "agent.reporter" }, 256, cursor, context);
		if (page.items.some((task) => task.version === 1 && task.state.status !== "terminal")) return "version 1 with active task";
		cursor = page.next ?? undefined;
	} while (cursor !== undefined);
	return "version 1";
}

/** Classify one storage under its writer lease; with `apply`, adopt a version 1 storage in one commit. */
async function visitStorage(record: CatalogRecord, apply: boolean, context: Context): Promise<{ state: StorageState; adopted?: number }> {
	const claim = hostPaths(record).claim;
	mkdirSync(dirname(claim), { recursive: true, mode: 0o700 });
	const attempt = tryNativeWriterLease(claim);
	if (attempt.kind === "busy") return { state: "writer busy" };
	const lease: NativeWriterLease = attempt.lease;
	let storage: Storage | undefined;
	try {
		let state: StorageState;
		try {
			storage = await openNodeSqliteStorage(record.storagePath);
			state = await pageState(storage, context);
		} catch { return { state: "unreadable" }; }
		if (!apply || state !== "version 1") return { state };
		// The adoption starts no task and calls no model; Harness requires both options to open.
		const opened = storage;
		const harness = await Harness.open(opened, { models: () => { throw new Error("Delivery page adoption calls no model"); }, registry: createRegistry() }, context);
		storage = undefined;
		try { return { state, adopted: (await adoptDeliveryPages(harness, opened, context)).adopted }; }
		finally { await harness.close(context); }
	} finally {
		await storage?.close(context).catch(() => undefined);
		lease.release();
	}
}

function catalogRecords(sessionsRoot: string, only: string | undefined): CatalogRecord[] {
	const catalog = new AgentCatalog(sessionsRoot);
	const ids = only !== undefined ? [only] : readdirSync(catalog.root).flatMap((name) => STORAGE_FILE.exec(name)?.[1] ?? []).sort();
	return ids.map((id) => catalog.read(id));
}

export type AdoptionOptions = { apply: boolean; storage?: string; agentDir?: string; env?: Readonly<Record<string, string | undefined>>; write?: (line: string) => void; context?: Context };

/** The catalog root a host uses: `PI_AGENT_SESSIONS_DIR`, else `<agentDir>/agent-sessions`; an explicit directory wins. */
function sessionsRootOf(options: AdoptionOptions): string {
	const env = options.env ?? process.env;
	if (options.agentDir !== undefined) return resolve(options.agentDir, "agent-sessions");
	return resolve(env.PI_AGENT_SESSIONS_DIR ?? join(env.PI_AGENT_DIR ?? getAgentDir(), "agent-sessions"));
}

/** Counts by storage state; with `apply`, the storages and pages adopted. Prints no message content. */
export async function runAdoption(options: AdoptionOptions): Promise<Record<StorageState | "adopted storages" | "adopted pages", number>> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const sessionsRoot = sessionsRootOf(options);
	const counts = Object.fromEntries([...STORAGE_STATES, "adopted storages", "adopted pages"].map((key) => [key, 0])) as Record<StorageState | "adopted storages" | "adopted pages", number>;
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	for (const record of catalogRecords(sessionsRoot, options.storage)) {
		if (lstatSync(record.storagePath, { throwIfNoEntry: false }) === undefined) continue;
		const result = await visitStorage(record, options.apply, context);
		counts[result.state] += 1;
		if (result.adopted !== undefined) { counts["adopted storages"] += 1; counts["adopted pages"] += result.adopted; }
		else if (options.apply && !SETTLED.has(result.state)) write(`skipped ${record.storageId}: ${result.state}`);
	}
	write(`${options.apply ? "applied" : "dry run"} in ${sessionsRoot}`);
	for (const [state, count] of Object.entries(counts)) if (options.apply || !state.startsWith("adopted")) write(`${state}: ${count}`);
	return counts;
}

function parseArgs(args: readonly string[]): AdoptionOptions {
	const options: { apply: boolean; storage?: string; agentDir?: string } = { apply: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--apply") options.apply = true;
		else if ((arg === "--storage" || arg === "--agent-dir") && args[index + 1] !== undefined) {
			if (arg === "--storage") options.storage = args[++index];
			else options.agentDir = resolve(args[++index]);
		} else throw new Error("Usage: node extensions/agent/adopt-delivery-pages.ts [--apply] [--storage <id>] [--agent-dir <dir>]");
	}
	return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await Promise.resolve().then(() => runAdoption(parseArgs(process.argv.slice(2)))).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
