import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { type Entry, type EntryFields, fenced, firstSentence, isRecord, parseEntry, requireId } from "./catalog.ts";
import { exampleFailures } from "./detect.ts";
import { readRegular } from "./files.ts";

export const shippedCatalog = fileURLToPath(new URL("./catalog/", import.meta.url));
export type Identity = { session: string; model: string | null; cwd: string };
export type CatalogEntry = Entry & { disabled: boolean };
type EntryState = { disabled: boolean; time: string; session: string; reason?: string };
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function findEntryFiles(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function loadEntryFile(dir: string, file: string, source: Entry["source"]): Entry | undefined {
	const id = requireId(file.slice(0, -3));
	const bytes = readRegular(join(dir, file), 128 * 1024);
	return bytes && parseEntry(utf8.decode(bytes), id, source);
}

export function loadEntries(dir: string, source: Entry["source"]): Entry[] {
	return findEntryFiles(dir).flatMap((file) => {
		const entry = loadEntryFile(dir, file, source);
		return entry ? [entry] : [];
	});
}

function loadState(root: string): Map<string, EntryState> {
	const bytes = readRegular(join(root, "state.json"), 1024 * 1024);
	if (!bytes) return new Map();
	const state: unknown = JSON.parse(utf8.decode(bytes));
	if (!isRecord(state)) throw new Error("Slop state must be an object.");
	const entries = new Map<string, EntryState>();
	for (const [id, record] of Object.entries(state)) {
		requireId(id);
		if (
			!isRecord(record) ||
			typeof record.disabled !== "boolean" ||
			typeof record.time !== "string" ||
			typeof record.session !== "string" ||
			(record.reason !== undefined && typeof record.reason !== "string")
		)
			throw new Error(`Invalid slop state for ${id}.`);
		entries.set(id, {
			disabled: record.disabled,
			time: record.time,
			session: record.session,
			...(record.reason === undefined ? {} : { reason: record.reason }),
		});
	}
	return entries;
}

export function readCatalog(root: string, shipped = shippedCatalog): CatalogEntry[] {
	const local = loadEntries(join(root, "entries"), "local");
	local.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.id.localeCompare(b.id));
	const overrides = new Set(local.map((entry) => entry.id));
	const entries = [...local, ...loadEntries(shipped, "shipped").filter((entry) => !overrides.has(entry.id))];
	const state = loadState(root);
	return entries.map((entry) => ({ ...entry, disabled: state.get(entry.id)?.disabled ?? false }));
}

export function readLexicon(path?: string): Set<string> {
	if (path === undefined) return new Set();
	const bytes = readRegular(path, 1024 * 1024);
	if (!bytes) throw new Error(`Slop lexicon does not exist: ${path}`);
	return new Set(
		utf8
			.decode(bytes)
			.replace(/^\ufeff/, "")
			.split(/\r?\n/)
			.map((term) => term.trim().toLowerCase())
			.filter(Boolean),
	);
}

function atomicWrite(dir: string, file: string, content: string, maxBytes: number) {
	if (Buffer.byteLength(content) > maxBytes) throw new Error(`${file}: exceeds ${maxBytes} bytes`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `.${randomUUID()}.new`);
	try {
		writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temp, join(dir, file));
	} finally {
		rmSync(temp, { force: true });
	}
}

function writeExclusive<T>(root: string, operation: () => T): T {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const release = lockfile.lockSync(root, { realpath: false, lockfilePath: join(root, ".write-lock"), stale: 10_000 });
	try {
		return operation();
	} finally {
		release();
	}
}

export type SaveFields = EntryFields & { operator: string; excerpt?: string; note?: string };
export function saveEntry(
	root: string,
	fields: SaveFields,
	identity: Identity,
	lexicon = new Set<string>(),
): CatalogEntry {
	const {
		id,
		title,
		domain,
		applies,
		prompt,
		recognition,
		cost,
		repair,
		examples,
		detectors,
		operator,
		excerpt,
		note,
	} = fields;
	requireId(id);
	if (typeof operator !== "string" || !operator.trim()) throw new Error("Save requires the operator's words.");
	if (typeof title !== "string" || !title.trim() || /[\p{Cc}]/u.test(title))
		throw new Error("Use a nonempty title on one line.");
	if (prompt !== undefined && typeof prompt !== "boolean") throw new Error("prompt must be boolean");
	const examplesBody = examples
		?.map((example) => {
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_+-]*$/.test(example.kind) || !["slop", "better"].includes(example.verdict))
				throw new Error("Invalid example kind or verdict.");
			return `${example.verdict === "slop" ? "Slop:" : "Better:"}\n\n${fenced(example.kind, example.text)}`;
		})
		.join("\n\n");
	const body = `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\ndomain: ${JSON.stringify(domain)}\napplies: ${JSON.stringify(applies)}\n${prompt === undefined ? "" : `prompt: ${prompt}\n`}---\n\n# ${title}\n\n## Recognition\n\n${recognition}\n\n## Cost\n\n${cost}\n\n## Repair\n\n${repair}\n${examplesBody ? `\n## Examples\n\n${examplesBody}\n` : ""}${detectors ? `\n## Detectors\n\n${fenced("json", JSON.stringify(detectors, null, 2))}\n` : ""}`;
	const entry = parseEntry(body, id, "local");
	const normalize = (value: string) => value.replaceAll("\r\n", "\n").trim();
	if (
		entry.recognition !== normalize(recognition) ||
		entry.cost !== normalize(cost) ||
		entry.repair !== normalize(repair)
	)
		throw new Error("Entry sections must not contain other entry headings.");
	const failures = exampleFailures(entry, lexicon);
	if (failures.length) throw new Error(failures.join("\n"));
	return writeExclusive(root, () => {
		const dir = join(root, "entries");
		const file = `${id}.md`;
		const previous = loadEntryFile(dir, file, "local");
		const now = new Date().toISOString();
		const record = `\n## Record\n\nCreated: ${previous?.created ?? now}\nUpdated: ${now}\nSession: ${JSON.stringify(identity.session)}\nModel: ${JSON.stringify(identity.model)}\nCwd: ${JSON.stringify(identity.cwd)}\n\nOperator:\n\n${fenced("text", operator)}\n${excerpt === undefined ? "" : `\nExcerpt:\n\n${fenced("text", excerpt)}\n`}${note === undefined ? "" : `\nNote:\n\n${fenced("text", note)}\n`}`;
		const ready = parseEntry(body + record, id, "local");
		const disabled = loadState(root).get(id)?.disabled ?? false;
		atomicWrite(dir, file, ready.raw, 128 * 1024);
		return { ...ready, disabled };
	});
}

export function setDisabled(
	root: string,
	id: string,
	disabled: boolean,
	identity: Identity,
	reason?: string,
	shipped = shippedCatalog,
): void {
	requireId(id);
	writeExclusive(root, () => {
		if (!readCatalog(root, shipped).some((entry) => entry.id === id)) throw new Error(`No slop entry named ${id}.`);
		const state = loadState(root);
		state.set(id, {
			disabled,
			time: new Date().toISOString(),
			session: identity.session,
			...(reason === undefined ? {} : { reason }),
		});
		atomicWrite(root, "state.json", `${JSON.stringify(Object.fromEntries(state), null, 2)}\n`, 1024 * 1024);
	});
}

export function saveFlag(root: string, reply: string, note: string, identity: Identity): string {
	const time = new Date().toISOString();
	const id = `${time.replace(/[:.]/g, "-")}-${randomUUID()}`;
	atomicWrite(
		join(root, "flags"),
		`${id}.json`,
		`${JSON.stringify({ id, time, reply, note, ...identity }, null, 2)}\n`,
		8 * 1024 * 1024,
	);
	return id;
}

export function promptSection(entries: CatalogEntry[]): string | undefined {
	const introduction = "Each line names a habit to avoid and its repair.";
	const lines: string[] = [];
	let size = introduction.length;
	for (const entry of entries) {
		if (!entry.prompt || entry.disabled) continue;
		const line = `${entry.title}: ${firstSentence(entry.repair)}`;
		if (size + line.length + 1 > 1500) continue;
		lines.push(line);
		size += line.length + 1;
	}
	return lines.length ? [introduction, ...lines].join("\n") : undefined;
}
