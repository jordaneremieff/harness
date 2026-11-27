import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { available, projectFiles, type Scan } from "./project-files.ts";
import { MATCH_WORKER, type MatchJob, type MatchResult, matchText } from "./project-match.ts";
import { EditorError, fileName, locate, MAX_FILE_BYTES, normalise, plainText } from "./store-files.ts";
import { diskProjectText, type ProjectText, type Workspace } from "./store.ts";

type Input = Record<string, unknown>;
const FILE_LIMIT = 4096;
const BYTE_LIMIT = 16 * 1024 * 1024;
const HIT_LIMIT = 150;
const CHANGE_LIMIT = 512;
const QUERY_LIMIT = 512;
const REGEX_TIME = 200;
const WORD = "[\\p{L}\\p{M}\\p{N}\\p{Pc}]";

function flag(input: Input, key: string, fallback: boolean): boolean {
	const value = input[key];
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new EditorError(`${key} must be true or false.`, "invalid");
	return value;
}

// A single component uses *, which never crosses /, and ? for one character.
function component(pattern: string, name: string): boolean {
	let i = 0,
		j = 0,
		star = -1,
		resume = 0;
	while (j < name.length) {
		if (pattern[i] === "*") {
			star = i++;
			resume = j;
		} else if (pattern[i] === "?" || pattern[i] === name[j]) {
			i++;
			j++;
		} else if (star !== -1) {
			i = star + 1;
			j = ++resume;
		} else return false;
	}
	while (pattern[i] === "*") i++;
	return i === pattern.length;
}

function glob(pattern: string): (path: string) => boolean {
	const value = pattern.replace(/^\.\//u, "");
	const folder = value.endsWith("/");
	const parts = (folder ? value.slice(0, -1) : value).split("/");
	if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\\"))) {
		throw new EditorError(`Invalid project path filter: ${pattern}`, "invalid");
	}
	if (!/[*?]/u.test(value))
		return (path) => (!folder && path === value) || path.startsWith(folder ? value : `${value}/`);
	if (parts.length === 1 && !folder) return (path) => component(parts[0], path.slice(path.lastIndexOf("/") + 1));
	return (path) => {
		const names = path.split("/");
		if (folder) names.pop();
		let positions = new Set([0]);
		for (const part of parts) {
			if (!positions.size) return false;
			if (part === "**") {
				const first = Math.min(...positions);
				positions = new Set(Array.from({ length: names.length - first + 1 }, (_n, index) => first + index));
			} else {
				positions = new Set(
					[...positions].filter((i) => i < names.length && component(part, names[i])).map((i) => i + 1),
				);
			}
		}
		return folder ? positions.size > 0 : positions.has(names.length);
	};
}

function pathPatterns(input: Input, key: string) {
	const value = input[key];
	if (value === undefined) return [];
	if (typeof value !== "string" || Buffer.byteLength(value) > 4096) {
		throw new EditorError(`${key} must be comma-separated folders or globs (up to 4096 bytes).`, "invalid");
	}
	plainText(value);
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function filters(input: Input) {
	const include: ReturnType<typeof glob>[] = [];
	const exclude = pathPatterns(input, "exclude").map(glob);
	for (const part of pathPatterns(input, "include")) {
		if (part.startsWith("-")) exclude.push(glob(part.slice(1)));
		else include.push(glob(part));
	}
	return (path: string) =>
		(!include.length || include.some((match) => match(path))) && !exclude.some((match) => match(path));
}

function options(input: Input) {
	const query = input.query;
	if (typeof query !== "string" || Buffer.byteLength(query) > QUERY_LIMIT) {
		throw new EditorError("Use a text query of at most 512 bytes.", "invalid");
	}
	plainText(query);
	const regex = flag(input, "regex", false);
	const caseSensitive = flag(input, "caseSensitive", true);
	const wholeWord = flag(input, "wholeWord", false);
	const context = input.contextLines ?? 0;
	if (typeof context !== "number" || !Number.isInteger(context) || context < 0 || context > 3) {
		throw new EditorError("contextLines must be an integer from 0 to 3.", "invalid");
	}
	const source = regex ? query : normalise(query).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	let pattern: RegExp;
	try {
		pattern = new RegExp(wholeWord ? `(?<!${WORD})(?:${source})(?!${WORD})` : source, caseSensitive ? "gmu" : "gimu");
	} catch (error) {
		throw new EditorError(error instanceof Error ? error.message : "Invalid regular expression.", "invalid");
	}
	return { query, regex, pattern, context, accepts: filters(input) };
}

class RegexLimitError extends EditorError {
	constructor() {
		super("The regular expression did not finish within the search time limit.", "limit");
	}
}

class Matcher {
	#worker?: Worker;
	readonly pattern: RegExp;
	readonly regex: boolean;
	readonly scan: Scan;

	constructor(opts: ReturnType<typeof options>, scan: Scan) {
		this.pattern = opts.pattern;
		this.regex = opts.regex;
		this.scan = scan;
	}

	async run(job: MatchJob): Promise<MatchResult> {
		this.scan.signal?.throwIfAborted();
		if (!this.regex) return matchText(this.pattern, job);
		this.#worker ??= new Worker(new URL("./project-match.ts", import.meta.url), {
			workerData: MATCH_WORKER,
			resourceLimits: { maxOldGenerationSizeMb: 64 },
		});
		const worker = this.#worker;
		const signal = this.scan.signal;
		return new Promise((resolve, reject) => {
			const clean = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				worker.off("message", received);
				worker.off("error", failed);
			};
			const received = (result: MatchResult) => {
				clean();
				resolve(result);
			};
			const failed = (error: Error) => {
				clean();
				reject(error);
			};
			const abort = () => failed(signal?.reason as Error);
			const timer = setTimeout(
				() => {
					failed(new RegexLimitError());
				},
				Math.min(REGEX_TIME, Math.max(1, this.scan.end - performance.now())),
			);
			signal?.addEventListener("abort", abort, { once: true });
			worker.once("message", received);
			worker.once("error", failed);
			worker.postMessage({ source: this.pattern.source, flags: this.pattern.flags, job });
		});
	}

	async find(text: string, maximum: number) {
		const result = await this.run({ text, maximum });
		if (!("spans" in result)) throw Error("Unexpected project search result.");
		return result;
	}

	async close(): Promise<void> {
		await this.#worker?.terminate();
	}
}

function clip(text: string, start: number, end: number, limit: number): string {
	if (start > 0 && /[\udc00-\udfff]/u.test(text.charAt(start))) start--;
	const finish = Math.min(end, start + limit);
	return text.slice(start, finish).replace(/[\ud800-\udbff]$/u, "");
}

function afterLines(text: string, end: number, context: number): string[] {
	const after: string[] = [];
	if (end < 0) return after;
	for (let at = end + 1; at <= text.length && after.length < context; ) {
		const next = text.indexOf("\n", at);
		after.push(clip(text, at, next < 0 ? text.length : next, 240));
		if (next < 0) break;
		at = next + 1;
	}
	return after;
}

type Hit = {
	path: string;
	draft: boolean;
	line: number;
	column: number;
	length: number;
	text: string;
	preview: string;
	before: string[];
	after: string[];
};

function* hitLines(
	snapshot: ProjectText,
	spans: { offset: number; length: number }[],
	context: number,
): Generator<Hit> {
	const { doc, text, draft } = snapshot;
	let start = 0,
		end = text.indexOf("\n"),
		line = 1;
	const before: string[] = [];
	for (const { offset, length } of spans) {
		while (end !== -1 && offset > end) {
			if (context) {
				before.push(clip(text, start, end, 240));
				if (before.length > context) before.shift();
			}
			start = end + 1;
			end = text.indexOf("\n", start);
			line++;
		}
		const lineEnd = end < 0 ? text.length : end;
		yield {
			path: doc,
			draft,
			line,
			column: offset - start,
			length,
			text: clip(text, start, lineEnd, 1024),
			preview: clip(text, Math.max(start, offset - 40), lineEnd, 220),
			before: [...before],
			after: afterLines(text, end, context),
		};
	}
}

function requestedPaths(input: Input): string[] | undefined {
	if (input.paths === undefined) return;
	if (
		!Array.isArray(input.paths) ||
		input.paths.length > FILE_LIMIT ||
		input.paths.some((p) => typeof p !== "string")
	) {
		throw new EditorError("paths must be an array of up to 4096 project-relative file paths.", "invalid");
	}
	return input.paths.map(fileName);
}

async function* candidates(root: string, scan: Scan, store?: Workspace, paths?: string[]) {
	if (paths) {
		yield* new Set(paths);
		return;
	}
	const drafts = store?.projectDrafts(FILE_LIMIT + 1) ?? [];
	scan.limited ||= drafts.length > FILE_LIMIT;
	const first = new Set(drafts.slice(0, FILE_LIMIT));
	yield* first;
	for (const path of await projectFiles(root, scan, false)) if (!first.has(path)) yield path;
}

type Skipped = { path: string; code: string; reason: string };

function fileError(path: string, error: unknown): Skipped {
	if (error instanceof EditorError) return { path, code: error.code, reason: error.message };
	if ((error as NodeJS.ErrnoException).code === "ENOENT")
		return { path, code: "not_found", reason: "The file no longer exists." };
	if (error instanceof Error && "code" in error)
		return { path, code: "invalid", reason: "The project file is not accessible." };
	throw error;
}

function projectText(root: string, path: string, store?: Workspace): ProjectText | Skipped {
	try {
		return store ? store.projectText(path) : diskProjectText(locate(root, path));
	} catch (error) {
		return fileError(path, error);
	}
}

async function* contents(
	root: string,
	scan: Scan,
	accepts: (path: string) => boolean,
	store?: Workspace,
	paths?: string[],
) {
	const seen = new Set<string>();
	let bytes = 0,
		visited = 0,
		tried = 0;
	for await (const path of candidates(root, scan, store, paths)) {
		if (!available(scan)) return;
		// Let socket cancellation and other draft requests run during local file scans.
		if (++visited % 16 === 0) await setImmediate(undefined, { signal: scan.signal });
		if (!accepts(path)) continue;
		if (++tried > FILE_LIMIT) {
			scan.limited = true;
			return;
		}
		const snapshot = projectText(root, path, store);
		if ("code" in snapshot) {
			yield snapshot;
			continue;
		}
		if (seen.has(snapshot.doc)) continue;
		seen.add(snapshot.doc);
		bytes += Buffer.byteLength(snapshot.text);
		if (bytes > BYTE_LIMIT) {
			scan.limited = true;
			return;
		}
		yield snapshot;
	}
}

export async function projectSearch(root: string, input: Input, signal?: AbortSignal, store?: Workspace) {
	const opts = options(input);
	const hits: Hit[] = [];
	const scan: Scan = { end: performance.now() + 1200, signal, limited: false };
	if (!opts.query) return { hits, limited: false };
	const matcher = new Matcher(opts, scan);
	try {
		for await (const item of contents(root, scan, opts.accepts, store)) {
			if ("code" in item) {
				if (item.code === "limit" || item.code === "conflict") scan.limited = true;
				continue;
			}
			const result = await matcher.find(item.text, HIT_LIMIT - hits.length);
			hits.push(...hitLines(item, result.spans, opts.context));
			if (result.more) {
				scan.limited = true;
				break;
			}
		}
	} catch (error) {
		if (!(error instanceof RegexLimitError)) throw error;
		scan.limited = true;
	} finally {
		await matcher.close();
	}
	return { hits, limited: scan.limited };
}

async function planReplacement(matcher: Matcher, item: ProjectText, replacement: string) {
	const result = await matcher.run({
		text: item.text,
		maximum: 200_000,
		replacement,
		expand: matcher.regex,
		maxSize: MAX_FILE_BYTES,
	});
	if (!("count" in result)) throw Error("Unexpected project replace result.");
	if (result.text === undefined)
		throw new EditorError("The replacement exceeds the file size or match count limit.", "limit");
	if (result.count && result.text !== item.text) return { text: result.text, count: result.count };
}

export async function projectReplace(
	store: Workspace,
	input: Input,
	signal?: AbortSignal,
	reportBytes = Infinity,
	author = "You",
) {
	const opts = options(input);
	const paths = requestedPaths(input);
	if (!opts.query || typeof input.replacement !== "string" || Buffer.byteLength(input.replacement) > 65536) {
		throw new EditorError("Replace needs a non-empty query and replacement text of at most 65536 bytes.", "invalid");
	}
	plainText(input.replacement);
	const replacement = normalise(input.replacement);
	const changed: { doc: string; rev: number; count: number }[] = [];
	const skipped: Skipped[] = [];
	const scan: Scan = { end: performance.now() + 3000, signal, limited: false };
	const matcher = new Matcher(opts, scan);
	const reserve = (size: number) => {
		if (size > reportBytes) {
			scan.limited = true;
			return false;
		}
		reportBytes -= size;
		return true;
	};
	const skip = (failure: Skipped) => {
		if (!reserve(Buffer.byteLength(JSON.stringify(failure)) + 1)) return false;
		skipped.push(failure);
		return true;
	};
	const apply = async (item: ProjectText) => {
		try {
			const next = await planReplacement(matcher, item, replacement);
			if (!next) return true;
			signal?.throwIfAborted();
			const size = Buffer.byteLength(JSON.stringify(item.doc)) + 80;
			if (!reserve(size)) return false;
			changed.push({ ...store.replaceProjectText(item, next.text, author), count: next.count });
			return true;
		} catch (error) {
			signal?.throwIfAborted();
			const noted = skip(fileError(item.doc, error));
			if (!(error instanceof RegexLimitError)) return noted;
			scan.limited = true;
			return false;
		}
	};
	try {
		for await (const item of contents(store.root, scan, opts.accepts, store, paths)) {
			if (changed.length >= CHANGE_LIMIT || skipped.length >= CHANGE_LIMIT) {
				scan.limited = true;
				break;
			}
			if (!("code" in item ? skip(item) : await apply(item))) break;
		}
		return { changed, skipped, limited: scan.limited };
	} finally {
		await matcher.close();
	}
}
