import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The model a main session last recorded, with the thinking level it last recorded. */
export interface SessionModel {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: string;
}

/** Bytes read from the end of a session file, where its newest model facts are. */
const TAIL_BYTES = 256 * 1024;
/** Bytes read from the start of a long file, for facts recorded only when the session began. */
const HEAD_BYTES = 64 * 1024;

/**
 * The session file of one main session: Pi names each file `<time>_<session id>.jsonl` inside one
 * directory per working directory. One directory listing per working directory; absent is undefined.
 */
export async function findSessionFile(sessionsRoot: string, id: string): Promise<string | undefined> {
	if (!/^[A-Za-z0-9-]{8,128}$/u.test(id)) return undefined;
	const suffix = `_${id}.jsonl`;
	let directories: string[];
	try {
		directories = (await readdir(sessionsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
	} catch {
		return undefined;
	}
	for (const directory of directories) {
		let names: string[];
		try {
			names = await readdir(join(sessionsRoot, directory));
		} catch {
			continue;
		}
		const name = names.find((candidate) => candidate.endsWith(suffix));
		if (name) return join(sessionsRoot, directory, name);
	}
	return undefined;
}

/** Model facts from one parsed session line, in the order Pi wrote them. */
function lineFacts(line: string): { model?: { provider: string; modelId: string }; thinkingLevel?: string } {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return {};
	}
	if (!entry || typeof entry !== "object") return {};
	const record = entry as Record<string, unknown>;
	if (record.type === "model_change" && typeof record.provider === "string" && typeof record.modelId === "string") return { model: { provider: record.provider, modelId: record.modelId } };
	if (record.type === "thinking_level_change" && typeof record.thinkingLevel === "string") return { thinkingLevel: record.thinkingLevel };
	const message = record.type === "message" ? record.message : undefined;
	if (message && typeof message === "object") {
		const value = message as Record<string, unknown>;
		if (value.role === "assistant" && typeof value.provider === "string" && typeof value.model === "string") return { model: { provider: value.provider, modelId: value.model } };
	}
	return {};
}

async function readRange(path: string, start: number, length: number): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

/**
 * The newest model and thinking level a session file records. A long file is read at its start and
 * its end only: the end holds the newest assistant messages and changes, the start the facts that the
 * session recorded when it began. Unreadable or unparsable content yields undefined.
 */
export async function readSessionModel(path: string): Promise<SessionModel | undefined> {
	let size: number;
	try {
		const handle = await open(path, "r");
		try {
			size = (await handle.stat()).size;
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
	const long = size > TAIL_BYTES + HEAD_BYTES;
	let text: string;
	try {
		text = long ? `${await readRange(path, 0, HEAD_BYTES)}\n${(await readRange(path, size - TAIL_BYTES, TAIL_BYTES)).split("\n").slice(1).join("\n")}` : await readRange(path, 0, size);
	} catch {
		return undefined;
	}
	let model: { provider: string; modelId: string } | undefined;
	let thinkingLevel: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.includes("model") && !line.includes("thinking")) continue;
		const facts = lineFacts(line);
		if (facts.model) model = facts.model;
		if (facts.thinkingLevel) thinkingLevel = facts.thinkingLevel;
	}
	return model ? { ...model, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) } : undefined;
}
