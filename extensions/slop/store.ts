import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import {
	type Entry,
	type EntryFields,
	entryLimit,
	fenced,
	firstSentence,
	formatRecord,
	isRecord,
	parseEntry,
	requireId,
} from "./catalog.ts";
import { testExamples } from "./detect.ts";
import { readRegular } from "./files.ts";

export const starterDir = fileURLToPath(new URL("./starter/", import.meta.url));
export type Identity = { session: string; model: string | null };
export type CatalogEntry = Entry & { disabled: boolean };
type Change = { time: string; session: string; reason?: string };
type CatalogState = { imported: Map<string, string>; disabled: Map<string, Change>; removed: Map<string, Change> };
const stateLimit = 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function entryFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
		.map((entry) => entry.name)
		.sort();
}

function loadEntryFile(dir: string, file: string, starter = false) {
	const id = requireId(file.slice(0, -3));
	const bytes = readRegular(join(dir, file), entryLimit);
	if (bytes) return { file, bytes, entry: parseEntry(utf8.decode(bytes), id, starter) };
}

function loadStarters(dir: string) {
	return entryFiles(dir).map((file) => {
		const item = loadEntryFile(dir, file, true);
		if (!item) throw new Error(`Starter file disappeared: ${file}.`);
		return { ...item, digest: createHash("sha256").update(item.bytes).digest("hex") };
	});
}

function stateMap<T>(value: unknown, valid: (value: unknown) => value is T, field: string) {
	if (!isRecord(value)) throw new Error(`Invalid slop catalog state: ${field} must be an object.`);
	const map = new Map<string, T>();
	for (const [id, item] of Object.entries(value)) {
		requireId(id);
		if (!valid(item)) throw new Error(`Invalid slop catalog state: ${field}.${id}.`);
		map.set(id, item);
	}
	return map;
}

function isChange(value: unknown): value is Change {
	return (
		isRecord(value) &&
		typeof value.time === "string" &&
		typeof value.session === "string" &&
		(value.reason === undefined || typeof value.reason === "string")
	);
}

function loadState(root: string): CatalogState {
	const bytes = readRegular(join(root, "catalog.json"), stateLimit);
	if (!bytes) return { imported: new Map(), disabled: new Map(), removed: new Map() };
	const state: unknown = JSON.parse(utf8.decode(bytes));
	if (!isRecord(state)) throw new Error("Slop catalog state must be an object.");
	return {
		imported: stateMap(
			state.imported,
			(v): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
			"imported",
		),
		disabled: stateMap(state.disabled, isChange, "disabled"),
		removed: stateMap(state.removed, isChange, "removed"),
	};
}

function atomicWrite(dir: string, file: string, content: string | Buffer, maxBytes: number) {
	if (Buffer.byteLength(content) > maxBytes) throw new Error(`${file}: exceeds ${maxBytes} bytes`);
	const temp = join(dir, `.${randomUUID()}.new`);
	try {
		writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
		renameSync(temp, join(dir, file));
	} finally {
		rmSync(temp, { force: true });
	}
}

function writeState(root: string, { imported, disabled, removed }: CatalogState, writeEntries?: () => void) {
	const fields = {
		imported: Object.fromEntries(imported),
		disabled: Object.fromEntries(disabled),
		removed: Object.fromEntries(removed),
	};
	const content = `${JSON.stringify(fields, null, 2)}\n`;
	if (Buffer.byteLength(content) > stateLimit) throw new Error("catalog.json: exceeds 1 MiB.");
	writeEntries?.();
	atomicWrite(root, "catalog.json", content, stateLimit);
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

function hasCatalog(dir: string): boolean {
	const stat = statSync(dir, { throwIfNoEntry: false });
	if (!stat) return false;
	if (!stat.isDirectory()) throw new Error(`${dir}: not a catalog directory.`);
	return true;
}

function seedIfMissing(root: string, starter: string): string {
	const dir = join(root, "catalog");
	if (hasCatalog(dir)) return dir;
	const entries = loadStarters(starter);
	const temp = mkdtempSync(join(root, ".catalog-"));
	try {
		for (const { file, bytes } of entries) writeFileSync(join(temp, file), bytes, { mode: 0o600, flag: "wx" });
		// Publish the state first so a reader that sees the directory also sees its import digests.
		writeState(root, {
			imported: new Map(entries.map(({ entry, digest }) => [entry.id, digest])),
			disabled: new Map(),
			removed: new Map(),
		});
		renameSync(temp, dir);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	return dir;
}

function catalogDir(root: string, starter: string) {
	const dir = join(root, "catalog");
	if (!hasCatalog(dir)) {
		try {
			return writeExclusive(root, () => seedIfMissing(root, starter));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || !hasCatalog(dir)) throw error;
		}
	}
	return dir;
}

function orderEntries(a: Entry, b: Entry) {
	if (a.origin !== b.origin) return a.origin === "recorded" ? -1 : 1;
	return (b.record?.updated ?? "").localeCompare(a.record?.updated ?? "") || a.id.localeCompare(b.id);
}

export function readCatalog(root: string, starter = starterDir): CatalogEntry[] {
	const dir = catalogDir(root, starter);
	const state = loadState(root);
	return entryFiles(dir)
		.flatMap((file) => {
			const item = loadEntryFile(dir, file);
			return item ? [{ ...item.entry, disabled: state.disabled.has(item.entry.id) }] : [];
		})
		.sort(orderEntries);
}

type StarterStatus = "new" | "removed" | "current" | "updated" | "replaced";
function starterStatus(id: string, digest: string, present: boolean, state: CatalogState): StarterStatus {
	if (state.removed.has(id)) return "removed";
	if (!present) return "new";
	const imported = state.imported.get(id);
	if (!imported) return "replaced";
	return imported === digest ? "current" : "updated";
}

export function compareStarter(root: string, catalog: CatalogEntry[], starter = starterDir) {
	const state = loadState(root);
	const ids = new Set(catalog.map(({ id }) => id));
	return loadStarters(starter).map(({ entry, digest }) => ({
		entry,
		status: starterStatus(entry.id, digest, ids.has(entry.id), state),
	}));
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

export type SaveFields = Pick<EntryFields, "id"> &
	Partial<EntryFields> & { operator: string; excerpt?: string; note?: string };

function mergedExamples(previous: Entry["examples"], given: Entry["examples"]) {
	const examples = [...previous];
	const key = ({ kind, verdict, text }: Entry["examples"][number]) => JSON.stringify([kind, verdict, text]);
	const seen = new Set(previous.map(key));
	for (const example of given) {
		const item = { ...example, text: example.text.replaceAll("\r\n", "\n") };
		const signature = key(item);
		if (seen.has(signature)) continue;
		seen.add(signature);
		examples.push(item);
	}
	return examples;
}

function mergeEntry(fields: SaveFields, previous: Entry | undefined) {
	const {
		id,
		title,
		domain,
		applies,
		prompt = true,
		recognition,
		cost,
		repair,
		detectors = [],
	} = { ...previous, ...fields };
	if (!title || !domain || !applies || !recognition || !cost || !repair)
		throw new Error("A new entry requires title, domain, applies, recognition, cost, repair and operator.");
	if (typeof title !== "string" || !title.trim() || /[\p{Cc}]/u.test(title))
		throw new Error("Use a nonempty title on one line.");
	const examples = mergedExamples(previous?.examples ?? [], fields.examples ?? []);
	const examplesBody = examples
		.map((example) => {
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_+-]*$/.test(example.kind) || !["slop", "better"].includes(example.verdict))
				throw new Error("Invalid example kind or verdict.");
			return `${example.verdict === "slop" ? "Slop:" : "Better:"}\n\n${fenced(example.kind, example.text)}`;
		})
		.join("\n\n");
	const body = `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\ndomain: ${JSON.stringify(domain)}\napplies: ${JSON.stringify(applies)}\nprompt: ${prompt}\n---\n\n# ${title}\n\n## Recognition\n\n${recognition}\n\n## Cost\n\n${cost}\n\n## Repair\n\n${repair}\n${examplesBody ? `\n## Examples\n\n${examplesBody}\n` : ""}${detectors.length ? `\n## Detectors\n\n${fenced("json", JSON.stringify(detectors, null, 2))}\n` : ""}${previous?.notes === undefined ? "" : `\n## Notes\n\n${previous.notes}\n`}`;
	const entry = parseEntry(body, id);
	const normalize = (value: string) => value.replaceAll("\r\n", "\n").trim();
	if (
		entry.recognition !== normalize(recognition) ||
		entry.cost !== normalize(cost) ||
		entry.repair !== normalize(repair)
	)
		throw new Error("Entry sections must not contain other entry headings.");
	return entry;
}

function appendRecord(entry: Entry, previous: Entry | undefined, fields: SaveFields, identity: Identity) {
	const { operator, excerpt, note } = fields;
	const now = new Date().toISOString();
	const created = previous?.record?.created ?? now;
	const item = `Time: ${now}\nSession: ${JSON.stringify(identity.session)}\nModel: ${JSON.stringify(identity.model)}\n\nOperator:\n\n${fenced("text", operator)}${excerpt === undefined ? "" : `\n\nExcerpt:\n\n${fenced("text", excerpt)}`}${note === undefined ? "" : `\n\nNote:\n\n${fenced("text", note)}`}`;
	const latest = formatRecord(created, now, [item]);
	const budget = entryLimit - Buffer.byteLength(entry.raw + latest);
	if (budget < 0) throw new Error(`${entry.id}: entry and latest save exceed 128 KiB.`);
	const items = previous?.record?.items ?? [];
	let size = 0;
	let keep = items.length;
	const headerBytes = Buffer.byteLength(formatRecord(created, now, []));
	while (keep > 0) {
		const bytes = Buffer.byteLength(formatRecord(created, now, [items[keep - 1]])) - headerBytes;
		if (size + bytes > budget) break;
		size += bytes;
		keep--;
	}
	return parseEntry(entry.raw + formatRecord(created, now, [...items.slice(keep), item]), entry.id);
}

export function saveEntry(
	root: string,
	fields: SaveFields,
	identity: Identity,
	lexicon?: string,
	starter = starterDir,
) {
	const id = requireId(fields.id);
	if (typeof fields.operator !== "string" || !fields.operator.trim())
		throw new Error("Save requires the operator's words.");
	return writeExclusive(root, () => {
		const file = `${id}.md`;
		const catalog = join(root, "catalog");
		const seeded = hasCatalog(catalog);
		const previous = loadEntryFile(seeded ? catalog : starter, file, !seeded)?.entry;
		const entry = mergeEntry(fields, previous);
		const { failures, unmatched } = testExamples(
			entry,
			readLexicon(entry.detectors.some((d) => d.lexicon) ? lexicon : undefined),
		);
		if (failures.length) throw new Error(failures.join("\n"));
		const ready = appendRecord(entry, previous, fields, identity);
		const dir = seedIfMissing(root, starter);
		const state = loadState(root);
		const restored = state.removed.delete(id);
		const droppedDigest = !previous && state.imported.delete(id);
		const write = () => atomicWrite(dir, file, ready.raw, entryLimit);
		if (restored || droppedDigest) writeState(root, state, write);
		else write();
		return { entry: { ...ready, disabled: state.disabled.has(id) }, unmatched };
	});
}

function change(identity: Identity, reason?: string): Change {
	return { time: new Date().toISOString(), session: identity.session, ...(reason === undefined ? {} : { reason }) };
}

function changeEntry(
	root: string,
	id: string,
	starter: string,
	update: (dir: string, state: CatalogState) => (() => void) | undefined,
) {
	requireId(id);
	writeExclusive(root, () => {
		const dir = seedIfMissing(root, starter);
		if (!loadEntryFile(dir, `${id}.md`)) throw new Error(`No slop entry named ${id}.`);
		const state = loadState(root);
		writeState(root, state, update(dir, state));
	});
}

export function setDisabled(
	root: string,
	id: string,
	disabled: boolean,
	identity: Identity,
	reason?: string,
	starter = starterDir,
): void {
	changeEntry(root, id, starter, (_dir, state) => {
		if (disabled) state.disabled.set(id, change(identity, reason));
		else state.disabled.delete(id);
		return undefined;
	});
}

export function removeEntry(root: string, id: string, identity: Identity, reason?: string, starter = starterDir): void {
	changeEntry(root, id, starter, (dir, state) => {
		if (state.imported.has(id) || entryFiles(starter).includes(`${id}.md`))
			state.removed.set(id, change(identity, reason));
		state.imported.delete(id);
		state.disabled.delete(id);
		return () => unlinkSync(join(dir, `${id}.md`));
	});
}

export function importEntries(root: string, ids?: string[], starter = starterDir): string[] {
	const entries = loadStarters(starter);
	const byId = new Map(entries.map((item) => [item.entry.id, item]));
	const explicit =
		ids &&
		[...new Set(ids)].map((id) => {
			const item = byId.get(id);
			if (!item) throw new Error(`No starter entry named ${id}.`);
			return item;
		});
	return writeExclusive(root, () => {
		const dir = seedIfMissing(root, starter);
		const state = loadState(root);
		const files = new Set(entryFiles(dir));
		const selected =
			explicit ??
			entries.filter(({ file, entry, digest }) => starterStatus(entry.id, digest, files.has(file), state) === "new");
		for (const { entry, digest } of selected) {
			state.imported.set(entry.id, digest);
			state.removed.delete(entry.id);
		}
		if (selected.length)
			writeState(root, state, () => {
				for (const { file, bytes } of selected) atomicWrite(dir, file, bytes, entryLimit);
			});
		return selected.map(({ entry }) => entry.id);
	});
}

export function promptCues(entries: CatalogEntry[]): Map<string, string> {
	const cues = new Map<string, string>();
	let size = promptIntroduction.length;
	for (const entry of [...entries].sort(orderEntries)) {
		if (!entry.prompt || entry.disabled) continue;
		const line = `${entry.title}: ${firstSentence(entry.repair)}`;
		if (size + line.length + 1 > 1500) continue;
		cues.set(entry.id, line);
		size += line.length + 1;
	}
	return cues;
}

const promptIntroduction = "Each line names a habit to avoid and its repair.";
export function promptSection(entries: CatalogEntry[]): string | undefined {
	const cues = promptCues(entries);
	return cues.size ? [promptIntroduction, ...cues.values()].join("\n") : undefined;
}
