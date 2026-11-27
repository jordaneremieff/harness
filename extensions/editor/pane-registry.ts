import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Payload } from "./local.ts";
import type { FileReport, RequestState, ShowEvent } from "./pane-events.ts";
import { isParticipant, type Participant } from "./participants.ts";

export const paneIdPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
export type PaneControl =
	| { op: "attach"; participant: Participant; doc?: string; line?: number }
	| { op: "show"; event: ShowEvent }
	| { op: "file"; event: FileReport }
	| { op: "workspace" }
	| { op: "members" }
	| { op: "request"; thread: string; state: RequestState; by: Participant; at: number };

export type PaneRecord = {
	id: string;
	port: number;
	token: string;
	appPid: number;
	servicePid: number;
	loaded: boolean;
	visible: boolean;
	currentSession: Participant | null;
};

async function directory(workspace: string, create = false): Promise<string> {
	const path = join(workspace, "panes");
	if (create)
		await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
	const info = await lstat(path);
	if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
		throw Error("The Editor pane directory must be private.");
	}
	return path;
}

export async function registerPane(workspace: string, id: string) {
	if (!paneIdPattern.test(id)) throw Error("Invalid Editor pane ID.");
	const dir = await directory(workspace, true);
	const path = join(dir, `${id}.json`);
	let writes = Promise.resolve();
	return {
		previous: () => paneRecord(dir, id, false),
		publish(record: PaneRecord) {
			const content = JSON.stringify(record);
			const pending = writes.then(async () => {
				const temporary = `${path}.${randomUUID()}.new`;
				try {
					await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
					await rename(temporary, path);
				} finally {
					await rm(temporary, { force: true });
				}
			});
			writes = pending.catch(() => {});
			return pending;
		},
		async close() {
			await writes;
			await rm(path, { force: true });
		},
	};
}

function alive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function paneRecord(dir: string, id: string, checkService = true): Promise<PaneRecord | undefined> {
	const path = join(dir, `${id}.json`);
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await handle.stat();
			if (
				!stat.isFile() ||
				stat.nlink !== 1 ||
				stat.size > 4096 ||
				stat.uid !== process.getuid?.() ||
				(stat.mode & 0o077) !== 0
			)
				return;
			const value: PaneRecord = JSON.parse(await handle.readFile("utf8"));
			if (
				value?.id === id &&
				Number.isSafeInteger(value.port) &&
				value.port > 0 &&
				value.port < 65536 &&
				/^[\da-f]{64}$/.test(value.token) &&
				typeof value.loaded === "boolean" &&
				typeof value.visible === "boolean" &&
				(value.currentSession === null || isParticipant(value.currentSession)) &&
				alive(value.appPid) &&
				(!checkService || alive(value.servicePid))
			)
				return value;
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

export async function readPane(workspace: string, id: string) {
	if (!paneIdPattern.test(id)) return undefined;
	try {
		return paneRecord(await directory(workspace), id);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

async function panes(workspace: string): Promise<PaneRecord[]> {
	const dir = await directory(workspace).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	if (!dir) return [];
	const ids: string[] = [];
	for await (const entry of await opendir(dir)) {
		const id = entry.name.slice(0, -5);
		if (!entry.isFile() || !entry.name.endsWith(".json") || !paneIdPattern.test(id)) continue;
		ids.push(id);
		if (ids.length === 256) break;
	}
	return (await Promise.all(ids.map((id) => paneRecord(dir, id)))).filter((record) => record !== undefined);
}

async function control(record: PaneRecord, input: PaneControl, signal?: AbortSignal): Promise<boolean> {
	const timeout = AbortSignal.timeout(1200);
	try {
		const response = await fetch(`http://127.0.0.1:${record.port}/control`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${record.token}` },
			body: JSON.stringify(input),
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const result = (await response.json()) as Payload;
		return response.ok && result.id === record.id && result.accepted === true;
	} catch {
		return false;
	}
}

export async function notifyPanes(workspace: string, input: PaneControl, except?: string): Promise<number> {
	const results = await Promise.all(
		(await panes(workspace)).filter((record) => record.id !== except).map((record) => control(record, input)),
	);
	return results.filter(Boolean).length;
}

export async function attachVisiblePane(
	workspace: string,
	participant: Participant,
	doc: string | undefined,
	signal: AbortSignal,
): Promise<boolean> {
	for (const record of await panes(workspace)) {
		signal.throwIfAborted();
		if (record.visible && (await control(record, { op: "attach", participant, doc }, signal))) return true;
	}
	return false;
}
