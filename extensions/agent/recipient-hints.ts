/**
 * Writer-owned recipient discovery, separate from the storage catalogue. A source storage with retained work for a
 * recipient storage keeps one hint file in that recipient's directory, so a recipient finds its sources by reading
 * its own directory and nothing else. A hint is a candidate, never the authority: the source's retained rows decide.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { storageIdOf } from "./catalog.ts";
import { publishCatalogChange } from "./catalog-events.ts";

const HINT_FORMAT = "agent.recipient-hint/1";
const SOURCES_FORMAT = "agent.recipient-hint-sources/1";
const HINT_BYTES = 1024;
/** One source's recipient list; it holds the recipients of retained rows, not the history of the source. */
const SOURCES_BYTES = 1024 * 1024;
/** Hint files read in one page of a recipient directory. */
export const RECIPIENT_HINT_PAGE = 256;
const DIRECTORY = ".recipient-hints";
const SOURCES_DIRECTORY = ".sources";
const UUID_FILE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/u;

/** Demand of one source for one recipient storage: unfinished execution, or only rows to deliver. */
export interface RecipientHint {
	readonly source: string;
	readonly execution: boolean;
}

export interface RecipientHintPage {
	readonly hints: readonly RecipientHint[];
	/** Hint files that did not validate. Each names its path; none grants a launch. */
	readonly invalid: readonly { readonly path: string; readonly error: string }[];
	/** The last file name of this page when more remain, for the next page's `after`. */
	readonly next?: string;
}

function exactStorage(identity: string, label: string): string {
	if (storageIdOf(identity) !== identity) throw new Error(`Recipient hint ${label} requires an exact storage identity`);
	return identity;
}

export function recipientHintsRoot(sessionsRoot: string): string {
	return join(sessionsRoot, DIRECTORY);
}

export function recipientHintPath(sessionsRoot: string, recipient: string, source: string): string {
	return join(
		recipientHintsRoot(sessionsRoot),
		exactStorage(recipient, "recipient"),
		`${exactStorage(source, "source")}.json`,
	);
}

function sourcesPath(sessionsRoot: string, source: string): string {
	return join(recipientHintsRoot(sessionsRoot), SOURCES_DIRECTORY, `${exactStorage(source, "source")}.json`);
}

/** Recipient storage of an exact delivery identity, or undefined for an identity that names no storage. */
export function recipientStorage(identity: string): string | undefined {
	try {
		return storageIdOf(identity);
	} catch {
		return undefined;
	}
}

function readBounded(path: string, maximum: number): string | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > maximum) throw new Error("Recipient hint is not a bounded regular file");
		const bytes = Buffer.alloc(maximum + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, length);
			if (count === 0) break;
			length += count;
		}
		if (length > maximum) throw new Error("Recipient hint exceeds its read bound");
		return bytes.toString("utf8", 0, length);
	} finally {
		closeSync(fd);
	}
}

function parseHint(text: string, source: string): RecipientHint {
	const value = JSON.parse(text) as { format?: unknown; source?: unknown; execution?: unknown } | null;
	if (!value || value.format !== HINT_FORMAT || value.source !== source || typeof value.execution !== "boolean")
		throw new Error("Recipient hint is invalid");
	return { source, execution: value.execution };
}

function hintText(hint: RecipientHint): string {
	return `${JSON.stringify({ format: HINT_FORMAT, source: hint.source, execution: hint.execution })}\n`;
}

/** A directory of this index is a real directory, never a link to somewhere else. */
function realDirectory(path: string): boolean {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat === undefined) return false;
	if (!stat.isDirectory()) throw new Error(`Recipient hint directory is not a directory: ${path}`);
	return true;
}

/** Read one page of a recipient's own directory: one listing and one bounded read per source file. */
export function readRecipientHints(
	sessionsRoot: string,
	recipient: string,
	options: { readonly after?: string; readonly limit?: number } = {},
): RecipientHintPage {
	const directory = join(recipientHintsRoot(sessionsRoot), exactStorage(recipient, "recipient"));
	if (!realDirectory(recipientHintsRoot(sessionsRoot)) || !realDirectory(directory)) return { hints: [], invalid: [] };
	const limit = Math.max(1, Math.min(options.limit ?? RECIPIENT_HINT_PAGE, RECIPIENT_HINT_PAGE));
	const names = readdirSync(directory)
		.filter((name) => UUID_FILE.test(name) && (options.after === undefined || name > options.after))
		.sort();
	const hints: RecipientHint[] = [];
	const invalid: { path: string; error: string }[] = [];
	for (const name of names.slice(0, limit)) {
		const path = join(directory, name);
		try {
			const text = readBounded(path, HINT_BYTES);
			if (text !== undefined) hints.push(parseHint(text, name.slice(0, -".json".length)));
		} catch (error) {
			invalid.push({ path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { hints, invalid, ...(names.length > limit ? { next: names[limit - 1] } : {}) };
}

/** One exact-path read; undefined when the source holds no hint for the recipient. */
export function readRecipientHint(sessionsRoot: string, recipient: string, source: string): RecipientHint | undefined {
	const text = readBounded(recipientHintPath(sessionsRoot, recipient, source), HINT_BYTES);
	return text === undefined ? undefined : parseHint(text, source);
}

function ensureDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	realDirectory(path);
}

function syncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Write, sync and rename one file, then sync its directory: a crash leaves the old or the new content. */
function writeDurably(path: string, text: string): void {
	const directory = dirname(path);
	ensureDirectory(directory);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const fd = openSync(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			const bytes = Buffer.from(text);
			let offset = 0;
			while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch (cleanup) {
			if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT")
				throw new AggregateError([error, cleanup], "Recipient hint publication and cleanup failed");
		}
		throw error;
	}
	syncDirectory(directory);
}

function removeDurably(path: string): boolean {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	syncDirectory(dirname(path));
	return true;
}

function readSources(sessionsRoot: string, source: string): Set<string> {
	const text = readBounded(sourcesPath(sessionsRoot, source), SOURCES_BYTES);
	if (text === undefined) return new Set();
	const value = JSON.parse(text) as { format?: unknown; recipients?: unknown } | null;
	if (!value || value.format !== SOURCES_FORMAT || !Array.isArray(value.recipients))
		throw new Error("Recipient hint source list is invalid");
	const recipients = new Set<string>();
	for (const recipient of value.recipients) {
		if (typeof recipient !== "string") throw new Error("Recipient hint source list is invalid");
		recipients.add(exactStorage(recipient, "recipient"));
	}
	return recipients;
}

function writeSources(sessionsRoot: string, source: string, recipients: ReadonlySet<string>): void {
	const path = sourcesPath(sessionsRoot, source);
	if (recipients.size === 0) {
		removeDurably(path);
		return;
	}
	const text = `${JSON.stringify({ format: SOURCES_FORMAT, recipients: [...recipients].sort() })}\n`;
	if (Buffer.byteLength(text) > SOURCES_BYTES)
		throw new Error("Recipient hint source list exceeds its bound; the source keeps its earlier hints");
	writeDurably(path, text);
}

/**
 * The hints of one source storage. Only the storage's exclusive writer holds an instance, so the files it read
 * once stay as it wrote them. The source list names every recipient with a hint file before that file exists,
 * so a later writer finds and withdraws each stale hint without listing other directories.
 */
export class RecipientHintWriter {
	private readonly sessionsRoot: string;
	private readonly source: string;
	private published: Map<string, boolean> | undefined;
	private listed: Set<string> | undefined;

	constructor(sessionsRoot: string, source: string) {
		this.sessionsRoot = sessionsRoot;
		this.source = exactStorage(source, "source");
	}

	private current(): { published: Map<string, boolean>; listed: Set<string> } {
		if (this.published !== undefined && this.listed !== undefined)
			return { published: this.published, listed: this.listed };
		const listed = readSources(this.sessionsRoot, this.source);
		const published = new Map<string, boolean>();
		for (const recipient of listed) {
			try {
				const hint = readRecipientHint(this.sessionsRoot, recipient, this.source);
				if (hint !== undefined) published.set(recipient, hint.execution);
			} catch {
				/* An invalid file is rewritten by the next publication that names its recipient, or removed. */
			}
		}
		this.listed = listed;
		this.published = published;
		return { published, listed };
	}

	private list(recipients: Iterable<string>): void {
		const { listed } = this.current();
		const next = new Set(listed);
		for (const recipient of recipients) next.add(recipient);
		if (next.size === listed.size) return;
		writeSources(this.sessionsRoot, this.source, next);
		this.listed = next;
	}

	private write(recipient: string, execution: boolean): boolean {
		const { published } = this.current();
		if (published.get(recipient) === execution) return false;
		writeDurably(
			recipientHintPath(this.sessionsRoot, recipient, this.source),
			hintText({ source: this.source, execution }),
		);
		published.set(recipient, execution);
		return true;
	}

	/** Add demand before the work that creates it commits; an earlier execution hint is never lowered here. */
	stage(recipients: ReadonlyMap<string, boolean>): readonly string[] {
		const wanted = [...recipients].filter(([recipient]) => recipient !== this.source);
		if (wanted.length === 0) return [];
		this.list(wanted.map(([recipient]) => recipient));
		const { published } = this.current();
		const changed = wanted
			.filter(([recipient, execution]) => this.write(recipient, execution || published.get(recipient) === true))
			.map(([recipient]) => recipient);
		if (changed.length > 0) publishCatalogChange(join(this.sessionsRoot, "durable"), this.source);
		return changed;
	}

	/** Replace the source's hints with its complete current demand. */
	publish(demand: ReadonlyMap<string, boolean>): readonly string[] {
		const wanted = new Map([...demand].filter(([recipient]) => recipient !== this.source));
		this.list(wanted.keys());
		const changed: string[] = [];
		for (const [recipient, execution] of wanted) if (this.write(recipient, execution)) changed.push(recipient);
		const { published, listed } = this.current();
		for (const recipient of [...listed]) {
			if (wanted.has(recipient)) continue;
			if (removeDurably(recipientHintPath(this.sessionsRoot, recipient, this.source))) changed.push(recipient);
			published.delete(recipient);
		}
		if (listed.size !== wanted.size || [...listed].some((recipient) => !wanted.has(recipient))) {
			writeSources(this.sessionsRoot, this.source, new Set(wanted.keys()));
			this.listed = new Set(wanted.keys());
		}
		if (changed.length > 0) publishCatalogChange(join(this.sessionsRoot, "durable"), this.source);
		return changed;
	}

	/** Remove one recipient's hint without the source list: the writer found no retained row for that recipient. */
	withdraw(recipient: string): boolean {
		const exact = exactStorage(recipient, "recipient");
		const removed = removeDurably(recipientHintPath(this.sessionsRoot, exact, this.source));
		this.published?.delete(exact);
		if (removed) publishCatalogChange(join(this.sessionsRoot, "durable"), this.source);
		return removed;
	}
}
