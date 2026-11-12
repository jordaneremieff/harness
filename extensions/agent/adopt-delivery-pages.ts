/**
 * One-time manual transition of delivery reference pages that an earlier release wrote in version 1 format.
 * Run by hand: `node extensions/agent/adopt-delivery-pages.ts [--apply] [--storage <id>] [--agent-dir <dir>]`.
 * Each storage is classified, and with `--apply` adopted, only while this process holds that storage's native writer
 * lease, so it never reads or writes beside a running host. Classification uses a read-only SQLite connection and
 * writes nothing to the storage file or its WAL: Pi's own storage open runs a schema transaction and applies pending
 * schema migrations, so only `--apply` uses it, and only for a current-schema `version 1` storage. The adoption commits
 * through a plain Session over that storage, not a Harness: a Harness open recovers retained tasks (a `running` task
 * returns to `pending` with one more restart) and schedules their reconciliation, which page adoption must not do.
 */
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createSession } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AgentCatalog, type CatalogRecord } from "./catalog.ts";
import { adoptDeliveryPages } from "./delivery-store.ts";
import { hostPaths } from "./host-protocol.ts";
import { tryNativeWriterLease, type NativeWriterLease } from "./native-lease.ts";

export const STORAGE_STATES = ["version 2 only", "no pages", "version 1", "version 1 with active task", "older storage schema", "writer busy", "unreadable"] as const;
export type StorageState = (typeof STORAGE_STATES)[number];
const SETTLED: ReadonlySet<StorageState> = new Set(["version 2 only", "no pages"]);
const STORAGE_FILE = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.sqlite$/u;
/**
 * The SQLite schema version whose table layout the queries below read (Durable 1.5.2 opens schema 2). Another
 * installed schema version makes every storage `unreadable` until these queries are checked against it.
 */
const LAYOUT_SCHEMA_VERSION = 2;

type Classification = { state: StorageState; schema?: number };

/**
 * Without a WAL file the main file is complete, and `immutable=1` opens it without creating `-wal` or `-shm`. A
 * retained WAL can hold committed pages, so a plain read-only connection reads it; it never writes the WAL.
 */
function readOnlyLocation(path: string): string {
	return lstatSync(`${path}-wal`, { throwIfNoEntry: false }) === undefined ? `${pathToFileURL(path).href}?immutable=1` : path;
}

type ReadExecutor = Pick<Awaited<ReturnType<typeof openNodeSqliteDatabase>>, "get" | "all">;

/** The state that the SQLite schema version alone decides, if any. */
function schemaState(schema: number | undefined): StorageState | undefined {
	if (typeof schema !== "number") return "unreadable";
	if (schema < CURRENT_SQLITE_SCHEMA_VERSION) return "older storage schema";
	return schema === CURRENT_SQLITE_SCHEMA_VERSION && schema === LAYOUT_SCHEMA_VERSION ? undefined : "unreadable";
}

async function classifySnapshot(tx: ReadExecutor): Promise<Classification> {
	const schema = (await tx.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1"))?.version;
	const decided = schemaState(schema);
	if (decided !== undefined) return { state: decided, ...(schema === undefined ? {} : { schema }) };
	const pages = await tx.all<{ version: number; count: number }>(`SELECT r.version AS version, count(*) AS count FROM documents d
		JOIN document_revisions r ON r.document_id = d.id AND r.seq = (SELECT max(seq) FROM document_revisions WHERE document_id = d.id)
		WHERE d.kind = ? AND d.scope_kind = 'session' AND d.retired_at IS NULL GROUP BY r.version`, JSON.stringify("agent.delivery-page"));
	if (!pages.some((row) => row.version === 1)) return { state: pages.length === 0 ? "no pages" : "version 2 only", schema };
	const active = await tx.get<{ count: number }>("SELECT count(*) AS count FROM tasks WHERE kind = ? AND status <> 'terminal' AND json_extract(record, '$.version') = 1", JSON.stringify("agent.reporter"));
	return { state: (active?.count ?? 0) > 0 ? "version 1 with active task" : "version 1", schema };
}

/** Page versions and live version 1 Reporter tasks from one read snapshot; never writes. */
export async function classifyStorage(path: string): Promise<Classification> {
	let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
	try {
		database = await openNodeSqliteDatabase(readOnlyLocation(path), { mode: "read-only" });
		return await database.transaction(classifySnapshot);
	} catch { return { state: "unreadable" }; }
	finally { await database?.close().catch(() => undefined); }
}

/**
 * Classify one storage under its writer lease; with `apply`, adopt a current-schema version 1 storage in one commit.
 * A refused adoption names the storage and its file.
 */
async function visitStorage(record: CatalogRecord, apply: boolean, context: Context): Promise<Classification & { adopted?: number }> {
	const claim = hostPaths(record).claim;
	mkdirSync(dirname(claim), { recursive: true, mode: 0o700 });
	const attempt = tryNativeWriterLease(claim);
	if (attempt.kind === "busy") return { state: "writer busy" };
	const lease: NativeWriterLease = attempt.lease;
	try {
		const classified = await classifyStorage(record.storagePath);
		if (!apply || classified.state !== "version 1") return classified;
		const storage = await openNodeSqliteStorage(record.storagePath);
		const session = createSession(storage);
		try { return { ...classified, adopted: (await adoptDeliveryPages(session, storage, context)).adopted }; }
		catch (error) { throw new Error(`Storage ${record.storageId} (${record.storagePath}) refused adoption: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
		finally { await session.close(context); }
	} finally { lease.release(); }
}

function catalogRecords(catalog: AgentCatalog, only: string | undefined): CatalogRecord[] {
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

type Counts = Record<StorageState | "adopted storages" | "adopted pages", number>;
function tally(counts: Counts, schemas: Map<number, number>, result: Classification & { adopted?: number }): void {
	counts[result.state] += 1;
	if (result.schema !== undefined) schemas.set(result.schema, (schemas.get(result.schema) ?? 0) + 1);
	if (result.adopted !== undefined) { counts["adopted storages"] += 1; counts["adopted pages"] += result.adopted; }
}

/** The line naming one storage's targets, if the run adopts, would adopt or skips it, or `named` selects it. */
function storageLine(record: CatalogRecord, result: Classification & { adopted?: number } | undefined, apply: boolean, named: boolean): string | undefined {
	const target = `storage ${record.storagePath}; agent directory ${record.agentDir}`;
	if (result === undefined) return named ? `storage ${record.storageId}: no storage file; ${target}` : undefined;
	if (result.adopted !== undefined) return `adopted ${record.storageId}: ${result.adopted} pages; ${target}`;
	const settled = SETTLED.has(result.state);
	if (apply && !settled) return `skipped ${record.storageId}: ${result.state}; ${target}`;
	return named || !settled ? `storage ${record.storageId}: ${result.state}; ${target}` : undefined;
}

/**
 * Counts by storage state; with `apply`, the storages and pages adopted. Prints the catalogue once, then one line with
 * the storage file and agent directory of each storage that it adopts, would adopt, skips or was named. Prints no
 * message content.
 */
export async function runAdoption(options: AdoptionOptions): Promise<Record<StorageState | "adopted storages" | "adopted pages", number>> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const catalog = new AgentCatalog(sessionsRootOf(options));
	const counts = Object.fromEntries([...STORAGE_STATES, "adopted storages", "adopted pages"].map((key) => [key, 0])) as Record<StorageState | "adopted storages" | "adopted pages", number>;
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const schemas = new Map<number, number>();
	write(`${options.apply ? "apply to" : "dry run of"} catalogue ${catalog.root}`);
	for (const record of catalogRecords(catalog, options.storage)) {
		const present = lstatSync(record.storagePath, { throwIfNoEntry: false }) !== undefined;
		const result = present ? await visitStorage(record, options.apply, context) : undefined;
		if (result !== undefined) tally(counts, schemas, result);
		const line = storageLine(record, result, options.apply, options.storage !== undefined);
		if (line !== undefined) write(line);
	}
	for (const [state, count] of Object.entries(counts)) if (options.apply || !state.startsWith("adopted")) write(`${state}: ${count}`);
	for (const [schema, count] of [...schemas].sort(([a], [b]) => a - b)) write(`storage schema ${schema}: ${count}`);
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
