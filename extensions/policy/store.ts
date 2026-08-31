/** Append-only, private filesystem persistence for policy records. */

import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PolicyRecord } from "./record.ts";

const MAX_RECORD_BYTES = 256 * 1024;

/** Store directory: `PI_POLICY_DIR`, else `<agentDir>/policy`. */
export function resolvePolicyDir(env: NodeJS.ProcessEnv = process.env, agentDir?: string): string {
	if (env.PI_POLICY_DIR) return env.PI_POLICY_DIR;
	return join(agentDir ?? join(homedir(), ".pi", "agent"), "policy");
}

const pad = (value: number) => String(value).padStart(2, "0");

/** YYYY-MM-DD in the local timezone. */
export function localDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const info = await lstat(dir);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error(`policy store is not a regular directory: ${dir}`);
	}
	await chmod(dir, 0o700);
}

/**
 * Append one record to the day's file.
 * The error is returned rather than thrown: a store failure must never reach
 * the tool call that produced the record.
 */
export async function appendRecord(dir: string, record: PolicyRecord): Promise<string | null> {
	try {
		const serialized = `${JSON.stringify(record)}\n`;
		if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
			throw new Error(`policy record exceeds ${MAX_RECORD_BYTES} bytes`);
		}
		await ensurePrivateDirectory(dir);
		const path = join(dir, `${localDate(new Date(record.at))}.jsonl`);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600);
		try {
			await handle.chmod(0o600);
			await handle.appendFile(serialized, "utf8");
		} finally {
			await handle.close();
		}
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
