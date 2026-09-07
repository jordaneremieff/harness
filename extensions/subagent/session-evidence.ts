import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
	CURRENT_SESSION_VERSION,
	type ExtensionContext,
	parseSessionEntries,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

export type EntryReader = Pick<ExtensionContext["sessionManager"], "getSessionId" | "getLeafId" | "getEntry">;
export const SESSION_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const SESSION_ENTRY_LIMIT = 512;

export interface EntrySnapshot {
	entries: SessionEntry[];
	bytes: number;
	notices: string[];
}

/** Follow only the selected ancestry. Neither a tree scan nor context compaction applies. */
export function selectedEntries(manager: EntryReader, limit = SESSION_ENTRY_LIMIT): EntrySnapshot {
	const entries: SessionEntry[] = [];
	const notices: string[] = [];
	const seen = new Set<string>();
	let id = manager.getLeafId();
	while (id && entries.length < limit) {
		if (seen.has(id)) {
			notices.push("Session ancestry contains a cycle; the repeated ancestry was omitted.");
			break;
		}
		seen.add(id);
		const entry = manager.getEntry(id);
		if (!entry || entry.id !== id) {
			notices.push("Session ancestry is incomplete; an entry is unavailable.");
			break;
		}
		entries.push(entry);
		id = entry.parentId;
	}
	if (id && entries.length === limit)
		notices.push(`Session ancestry reached the ${limit}-entry limit; older entries were omitted.`);
	return { entries: entries.reverse(), bytes: 0, notices };
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Contain malformed current input without a replacement session-format parser. */
function validateEntries(entries: unknown[], physicalLines: number, expectedId: string): void {
	if (entries.length !== physicalLines) throw new Error("malformed session input; the public parser omitted a line");
	const header = entries[0];
	if (
		!object(header) ||
		header.type !== "session" ||
		header.version !== CURRENT_SESSION_VERSION ||
		header.id !== expectedId ||
		typeof header.timestamp !== "string" ||
		!Number.isFinite(Date.parse(header.timestamp)) ||
		typeof header.cwd !== "string"
	) {
		throw new Error("session header, identity, or current format version does not match");
	}
	const seen = new Set<string>();
	for (const entry of entries.slice(1)) {
		if (
			!object(entry) ||
			typeof entry.id !== "string" ||
			!entry.id ||
			seen.has(entry.id) ||
			typeof entry.timestamp !== "string" ||
			!Number.isFinite(Date.parse(entry.timestamp)) ||
			(entry.parentId !== null && (typeof entry.parentId !== "string" || !seen.has(entry.parentId)))
		) {
			throw new Error("malformed session entry identity, timestamp, or ancestry");
		}
		seen.add(entry.id);
		switch (entry.type) {
			case "message":
				if (
					!object(entry.message) ||
					typeof entry.message.role !== "string" ||
					(["user", "assistant", "toolResult", "custom"].includes(entry.message.role) &&
						typeof entry.message.content !== "string" &&
						!Array.isArray(entry.message.content))
				) {
					throw new Error("malformed session message");
				}
				break;
			case "custom_message":
				if (
					typeof entry.customType !== "string" ||
					(typeof entry.content !== "string" && !Array.isArray(entry.content))
				)
					throw new Error("malformed custom message");
				break;
			case "custom":
				if (typeof entry.customType !== "string") throw new Error("malformed custom entry");
				break;
			case "model_change":
			case "thinking_level_change":
			case "compaction":
			case "branch_summary":
			case "label":
			case "session_info":
				break;
			default:
				throw new Error("unknown current session entry type");
		}
	}
}

/** Read one known regular file through a fixed descriptor, never a repair-capable session open. */
export function readSelectedSession(
	path: string,
	expectedId: string,
	maxBytes = SESSION_SNAPSHOT_BYTES,
): EntrySnapshot {
	const byteLimit = Number.isFinite(maxBytes)
		? Math.max(0, Math.min(maxBytes, SESSION_SNAPSHOT_BYTES))
		: SESSION_SNAPSHOT_BYTES;
	let fd: number | undefined;
	let bytes = 0;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
		const before = fstatSync(fd);
		if (!before.isFile()) throw new Error("the selected path is not a regular file");
		if (before.size > byteLimit) throw new Error(`the selected file exceeds the ${byteLimit}-byte history limit`);
		if (before.size === 0) throw new Error("the selected file is empty");
		const buffer = Buffer.alloc(before.size);
		while (bytes < buffer.length) {
			const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
			if (count === 0) throw new Error("the selected file was truncated during the read");
			bytes += count;
		}
		const after = fstatSync(fd);
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
			throw new Error("the selected file changed during the read; request history again");
		const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		if (!content.endsWith("\n")) throw new Error("the selected file ends with a truncated line");
		const parsed = parseSessionEntries(content);
		validateEntries(parsed, content.split("\n").filter((line) => line.trim()).length, expectedId);
		const header = parsed[0];
		if (header.type !== "session") throw new Error("the selected file has no session header");
		const manager = SessionManager.inMemory(header.cwd, undefined, parsed);
		return { ...selectedEntries(manager, 4096), bytes };
	} catch (error) {
		return {
			entries: [],
			bytes,
			notices: [`History unavailable: ${error instanceof Error ? error.message : String(error)}.`],
		};
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
