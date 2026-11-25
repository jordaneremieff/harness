/**
 * Read-only Durable storage over a settled database file, opened in place.
 *
 * A database is settled while its write-ahead log and rollback journal hold no bytes: the main file is the complete
 * committed state. SQLite's `immutable=1` opens such a file without a lock and creates no `-wal` or `-shm` file. The
 * caller proves the settled state before the open and compares the file identity after every read, because an
 * immutable connection does not notice a writer that commits later.
 */
import { pathToFileURL } from "node:url";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

const SQLITE_READONLY = 8;

function refusedWrite(error: unknown): boolean {
	return (error as { errcode?: unknown }).errcode === SQLITE_READONLY;
}

/**
 * Durable's storage open seeds its schema ledger with `INSERT OR IGNORE` before it reads the stored version. On a
 * migrated database that statement changes nothing, and a read-only connection refuses it. The executor answers
 * that refusal as the no-op it is. Every other refused write, such as a pending schema migration, fails the open.
 */
function ledgerSeedTolerant(executor: SqliteExecutor): SqliteExecutor {
	return {
		exec: (sql) => executor.exec(sql),
		run: async (sql: string, ...params: SqliteValue[]) => {
			try {
				await executor.run(sql, ...params);
			} catch (error) {
				if (!refusedWrite(error) || !/^\s*INSERT OR IGNORE\b/iu.test(sql)) throw error;
			}
		},
		runCounted: (sql, ...params) => executor.runCounted(sql, ...params),
		get: (sql, ...params) => executor.get(sql, ...params),
		all: (sql, ...params) => executor.all(sql, ...params),
	};
}

/** Open the settled database at `path` in place. The open fails when the stored schema needs a migration. */
export async function openSettledStorage(path: string): Promise<Storage> {
	const database = await openNodeSqliteDatabase(`${pathToFileURL(path).href}?immutable=1`, { mode: "read-only" });
	const facade: SqliteDatabase = {
		...ledgerSeedTolerant(database),
		transaction: (callback) => database.transaction((transaction) => callback(ledgerSeedTolerant(transaction))),
		close: () => database.close(),
	};
	try {
		return await SqliteStorage.open(facade);
	} catch (error) {
		// The storage open closed the connection. A refused write here is a schema migration statement.
		if (refusedWrite(error)) throw new Error("The stored schema of this storage needs a migration", { cause: error });
		throw error;
	}
}
