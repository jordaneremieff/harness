import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SOURCES = ["hn", "arxiv", "openalex", "stackexchange", "pubmed"] as const;
export type Source = (typeof SOURCES)[number];
export type Sort = "relevance" | "date" | "top";

const SORTS: Record<Source, readonly Sort[]> = {
	hn: ["relevance", "date", "top"],
	arxiv: ["relevance", "date"],
	openalex: ["relevance", "date", "top"],
	stackexchange: ["relevance", "date", "top"],
	pubmed: ["relevance", "date"],
};

const MAX_LIMIT = 50;
const TITLE_CHARS = 200;
const COMMENT_CHARS = 300;
const ANSWER_CHARS = 1500;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "pi-scout-skill/1 (public research query)";

export interface Options {
	source: Source;
	query: string;
	since?: Date;
	limit: number;
	sort: Sort;
	kind: "story" | "comment";
	site: string;
	question?: number;
}

export interface Item {
	date: string;
	title: string;
	signal: string;
	links: string[];
	detail?: string;
}

export interface Result {
	total?: number;
	items: Item[];
	note?: string;
}

export type Fetcher = (url: string) => Promise<string>;

export class UsageError extends Error {}

export const help = `Query public research APIs that a page reader cannot use (JSON and XML), with date windows.

Usage: node query.mts <source> --query <text> [options]

Sources:
  hn             Hacker News stories or comments (Algolia search API)
  arxiv          arXiv preprints (arXiv API); field prefixes such as ti: au: abs: cat: pass through
  openalex       Scholarly works with citation counts (OpenAlex API)
  stackexchange  Stack Overflow or another Stack Exchange site (Stack Exchange API)
  pubmed         PubMed citations (NCBI E-utilities), with a plain-text abstract link

Options:
  --query, -q <text>   Search text (required)
  --since <window>     Only items on or after this point: 30d, 12w, 6m, 2y, or YYYY-MM-DD
  --sort <order>       relevance (default), date (newest first), or top
                       (top: hn stories by points among the most relevant matches,
                       openalex by citations, stackexchange by votes)
  --limit <n>          Items to show, 1-${MAX_LIMIT} (default 10)
  --kind <kind>        hn only: story (default) or comment
  --site <name>        stackexchange only: site name (default stackoverflow)
  --question <id>      stackexchange only: list the answers to this question instead
                       of searching, best voted first, with their text (no --query needed)
  --help               Show this help

Output: one numbered entry per item with its date, its signal (points, votes,
citations or category), its title, and its links. "No matches." means the query
completed and found nothing in the window. Errors go to stderr: exit 1 for a
network or HTTP failure, exit 2 for a usage error.`;

export function parseSince(value: string, now: Date): Date {
	const relative = /^(\d+)([dwmy])$/.exec(value);
	if (relative) {
		const days = Number(relative[1]) * { d: 1, w: 7, m: 30, y: 365 }[relative[2] as "d" | "w" | "m" | "y"];
		return new Date(now.getTime() - days * 86_400_000);
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const date = new Date(`${value}T00:00:00Z`);
		if (!Number.isNaN(date.getTime())) return date;
	}
	throw new UsageError(`--since must look like 30d, 12w, 6m, 2y or YYYY-MM-DD, not "${value}"`);
}

function sortOption(source: Source, value: string): Sort {
	if (!(SORTS[source] as readonly string[]).includes(value)) {
		throw new UsageError(`--sort for ${source} must be one of: ${SORTS[source].join(", ")}`);
	}
	return value as Sort;
}

function limitOption(value: string): number {
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new UsageError(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
	}
	return limit;
}

function applyOption(options: Options, flag: string, value: string, now: Date): void {
	switch (flag) {
		case "--query":
		case "-q":
			options.query = value.trim();
			return;
		case "--since":
			options.since = parseSince(value, now);
			return;
		case "--sort":
			options.sort = sortOption(options.source, value);
			return;
		case "--limit":
			options.limit = limitOption(value);
			return;
		case "--kind":
			if (options.source !== "hn" || (value !== "story" && value !== "comment")) {
				throw new UsageError("--kind applies to hn only: story or comment");
			}
			options.kind = value;
			return;
		case "--site":
			if (options.source !== "stackexchange" || !/^[a-z0-9.]+$/.test(value)) {
				throw new UsageError("--site applies to stackexchange only, as a site name such as serverfault");
			}
			options.site = value;
			return;
		case "--question":
			if (options.source !== "stackexchange" || !/^[1-9]\d*$/.test(value)) {
				throw new UsageError("--question applies to stackexchange only, as a numeric question id");
			}
			options.question = Number(value);
			return;
		default:
			throw new UsageError(`unknown option ${flag}`);
	}
}

export function parseArgs(argv: readonly string[], now: Date): Options {
	const [source, ...rest] = argv;
	if (!source || !(SOURCES as readonly string[]).includes(source)) {
		throw new UsageError(`first argument must be one of: ${SOURCES.join(", ")}`);
	}
	const options: Options = {
		source: source as Source,
		query: "",
		limit: 10,
		sort: "relevance",
		kind: "story",
		site: "stackoverflow",
	};
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i];
		const value = rest[i + 1];
		if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
		applyOption(options, flag, value, now);
	}
	if (!options.query && options.question === undefined) throw new UsageError("--query is required");
	if (options.source === "hn" && options.kind === "comment" && options.sort === "top") {
		throw new UsageError("--sort top applies to hn stories, not comments");
	}
	return options;
}

function day(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function clip(text: string, chars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
		if (code[0] === "#") {
			const point = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
			return Number.isFinite(point) ? String.fromCodePoint(point) : match;
		}
		return ENTITIES[code.toLowerCase()] ?? match;
	});
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<p>/gi, " ").replace(/<[^>]+>/g, ""));
}

function at(value: unknown, ...path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function str(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return "";
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function count(value: unknown, noun: string): string {
	const n = typeof value === "number" ? value : 0;
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Converts PubMed dates such as "2026 Oct 8", "2026 Oct" or "2026/10/08 23:31" to YYYY-MM-DD. */
export function pubmedDay(value: string): string {
	const slashed = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(value);
	if (slashed) return `${slashed[1]}-${slashed[2]}-${slashed[3]}`;
	const spoken = /^(\d{4})(?: ([A-Za-z]{3}))?(?: (\d{1,2}))?/.exec(value);
	if (!spoken) return "";
	const month = spoken[2] ? MONTHS.indexOf(spoken[2].toLowerCase()) + 1 : 1;
	return `${spoken[1]}-${String(Math.max(month, 1)).padStart(2, "0")}-${String(spoken[3] ?? "1").padStart(2, "0")}`;
}

function arxivQuery(query: string): string {
	if (/\b(ti|au|abs|co|jr|cat|rn|id|all):/.test(query)) return query;
	const terms = query.match(/"[^"]+"|\S+/g) ?? [];
	return terms.map((term) => `all:${term}`).join(" AND ");
}

function arxivStamp(date: Date): string {
	return date.toISOString().slice(0, 16).replace(/[-T:]/g, "");
}

async function hn(options: Options, fetcher: Fetcher): Promise<Result> {
	const endpoint = options.sort === "date" ? "search_by_date" : "search";
	const pool = options.sort === "top" ? Math.min(100, options.limit * 5) : options.limit;
	const params = new URLSearchParams({ query: options.query, tags: options.kind, hitsPerPage: String(pool) });
	if (options.since) params.set("numericFilters", `created_at_i>=${Math.floor(options.since.getTime() / 1000)}`);
	const body: unknown = JSON.parse(await fetcher(`https://hn.algolia.com/api/v1/${endpoint}?${params}`));
	const points = (hit: unknown) => {
		const value = at(hit, "points");
		return typeof value === "number" ? value : 0;
	};
	const hits = list(at(body, "hits"));
	const ranked =
		options.sort === "top" ? [...hits].sort((a, b) => points(b) - points(a)).slice(0, options.limit) : hits;
	const items = ranked.map((hit): Item => {
		const discussion = `https://news.ycombinator.com/item?id=${str(at(hit, "objectID"))}`;
		const date = str(at(hit, "created_at")).slice(0, 10);
		if (options.kind === "comment") {
			const story = str(at(hit, "story_title"));
			return {
				date,
				title: clip(stripTags(str(at(hit, "comment_text"))), COMMENT_CHARS),
				signal: `comment by ${str(at(hit, "author")) || "unknown"}`,
				links: [discussion],
				detail: story ? `on: ${clip(decodeEntities(story), TITLE_CHARS)}` : undefined,
			};
		}
		const url = str(at(hit, "url"));
		return {
			date,
			title: clip(decodeEntities(str(at(hit, "title"))), TITLE_CHARS),
			signal: `${count(at(hit, "points"), "point")}, ${count(at(hit, "num_comments"), "comment")}`,
			links: url ? [url, discussion] : [discussion],
		};
	});
	const total = at(body, "nbHits");
	return { total: typeof total === "number" ? total : undefined, items };
}

async function arxiv(options: Options, fetcher: Fetcher, now: Date): Promise<Result> {
	let search = arxivQuery(options.query);
	if (options.since) search += ` AND submittedDate:[${arxivStamp(options.since)} TO ${arxivStamp(now)}]`;
	const params = new URLSearchParams({
		search_query: search,
		start: "0",
		max_results: String(options.limit),
		sortBy: options.sort === "date" ? "submittedDate" : "relevance",
		sortOrder: "descending",
	});
	const xml = await fetcher(`https://export.arxiv.org/api/query?${params}`);
	const total = /<opensearch:totalResults[^>]*>(\d+)</.exec(xml)?.[1];
	const items: Item[] = [];
	for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
		const tag = (name: string) =>
			decodeEntities(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry)?.[1] ?? "");
		const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((match) =>
			decodeEntities(match[1].trim()),
		);
		const category = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(entry)?.[1] ?? "unknown category";
		items.push({
			date: tag("published").slice(0, 10),
			title: clip(tag("title"), TITLE_CHARS),
			signal: category,
			links: [
				tag("id")
					.trim()
					.replace(/^http:/, "https:"),
			],
			detail: authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ") || undefined,
		});
	}
	return { total: total === undefined ? undefined : Number(total), items };
}

async function openalex(options: Options, fetcher: Fetcher): Promise<Result> {
	const params = new URLSearchParams({
		search: options.query,
		"per-page": String(options.limit),
		select: "id,doi,display_name,publication_date,cited_by_count,primary_location,type",
	});
	if (options.sort === "date") params.set("sort", "publication_date:desc");
	if (options.sort === "top") params.set("sort", "cited_by_count:desc");
	if (options.since) params.set("filter", `from_publication_date:${day(options.since)}`);
	const body: unknown = JSON.parse(await fetcher(`https://api.openalex.org/works?${params}`));
	const items = list(at(body, "results")).map((work): Item => {
		const link = str(at(work, "doi")) || str(at(work, "primary_location", "landing_page_url")) || str(at(work, "id"));
		const venue = [str(at(work, "primary_location", "source", "display_name")), str(at(work, "type"))]
			.filter(Boolean)
			.join(", ");
		return {
			date: str(at(work, "publication_date")),
			title: clip(str(at(work, "display_name")), TITLE_CHARS),
			signal: count(at(work, "cited_by_count"), "citation"),
			links: [link],
			detail: venue || undefined,
		};
	});
	const total = at(body, "meta", "count");
	return { total: typeof total === "number" ? total : undefined, items };
}

async function stackexchangeGet(path: string, params: URLSearchParams, fetcher: Fetcher): Promise<unknown> {
	const body: unknown = JSON.parse(await fetcher(`https://api.stackexchange.com/2.3/${path}?${params}`));
	if (at(body, "error_id") !== undefined) {
		throw new Error(`Stack Exchange error ${str(at(body, "error_id"))}: ${str(at(body, "error_message"))}`);
	}
	return body;
}

function quotaNote(body: unknown): string | undefined {
	const quota = at(body, "quota_remaining");
	return typeof quota === "number" ? `${quota} requests left in today's anonymous quota` : undefined;
}

function answerLink(site: string, id: string): string {
	const host = ["stackoverflow", "serverfault", "superuser", "askubuntu"].includes(site)
		? `${site}.com`
		: `${site}.stackexchange.com`;
	return `https://${host}/a/${id}`;
}

async function answers(options: Options, question: number, fetcher: Fetcher): Promise<Result> {
	const params = new URLSearchParams({
		site: options.site,
		pagesize: String(options.limit),
		order: "desc",
		sort: options.sort === "date" ? "creation" : "votes",
		filter: "withbody",
	});
	if (options.since) params.set("fromdate", String(Math.floor(options.since.getTime() / 1000)));
	const body = await stackexchangeGet(`questions/${question}/answers`, params, fetcher);
	const items = list(at(body, "items")).map((answer): Item => {
		const created = at(answer, "creation_date");
		return {
			date: typeof created === "number" ? day(new Date(created * 1000)) : "",
			title: clip(stripTags(str(at(answer, "body"))), ANSWER_CHARS),
			signal: `${count(at(answer, "score"), "vote")}${at(answer, "is_accepted") === true ? ", accepted" : ""}`,
			links: [answerLink(options.site, str(at(answer, "answer_id")))],
		};
	});
	return { items, note: quotaNote(body) };
}

async function stackexchange(options: Options, fetcher: Fetcher): Promise<Result> {
	if (options.question !== undefined) return answers(options, options.question, fetcher);
	const params = new URLSearchParams({
		q: options.query,
		site: options.site,
		pagesize: String(options.limit),
		order: "desc",
		sort: { relevance: "relevance", date: "creation", top: "votes" }[options.sort],
	});
	if (options.since) params.set("fromdate", String(Math.floor(options.since.getTime() / 1000)));
	const body = await stackexchangeGet("search/advanced", params, fetcher);
	const items = list(at(body, "items")).map((question): Item => {
		const created = at(question, "creation_date");
		const tags = list(at(question, "tags")).map(str).filter(Boolean);
		return {
			date: typeof created === "number" ? day(new Date(created * 1000)) : "",
			title: clip(decodeEntities(str(at(question, "title"))), TITLE_CHARS),
			signal: `${count(at(question, "score"), "vote")}, ${count(at(question, "answer_count"), "answer")}${at(question, "accepted_answer_id") ? ", accepted answer" : ""}`,
			links: [str(at(question, "link"))],
			detail: tags.length > 0 ? tags.join(", ") : undefined,
		};
	});
	return { items, note: quotaNote(body) };
}

async function pubmed(options: Options, fetcher: Fetcher, now: Date): Promise<Result> {
	const search = new URLSearchParams({
		db: "pubmed",
		term: options.query,
		retmax: String(options.limit),
		retmode: "json",
		sort: options.sort === "date" ? "pub_date" : "relevance",
	});
	if (options.since) {
		search.set("datetype", "pdat");
		search.set("mindate", day(options.since).replaceAll("-", "/"));
		search.set("maxdate", day(now).replaceAll("-", "/"));
	}
	const found: unknown = JSON.parse(
		await fetcher(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${search}`),
	);
	const ids = list(at(found, "esearchresult", "idlist"))
		.map(str)
		.filter(Boolean);
	const reported = str(at(found, "esearchresult", "count"));
	const total = reported ? Number(reported) : undefined;
	if (ids.length === 0) return { total, items: [] };
	const summary: unknown = JSON.parse(
		await fetcher(
			`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${new URLSearchParams({ db: "pubmed", id: ids.join(","), retmode: "json" })}`,
		),
	);
	const items = ids.flatMap((id): Item[] => {
		const record = at(summary, "result", id);
		if (record === undefined) return [];
		const listed = list(at(record, "history")).find((entry) => str(at(entry, "pubstatus")) === "pubmed");
		const date =
			pubmedDay(str(at(listed, "date"))) ||
			pubmedDay(str(at(record, "epubdate"))) ||
			pubmedDay(str(at(record, "sortpubdate")));
		const authors = list(at(record, "authors"));
		const first = str(at(authors[0], "name"));
		return [
			{
				date,
				title: clip(decodeEntities(str(at(record, "title"))), TITLE_CHARS),
				signal: str(at(record, "source")) || "unknown journal",
				links: [
					`https://pubmed.ncbi.nlm.nih.gov/${id}/`,
					`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${id}&rettype=abstract&retmode=text`,
				],
				detail: first ? `${first}${authors.length > 1 ? " et al." : ""}` : undefined,
			},
		];
	});
	return {
		total,
		items,
		note: "Dates are when each record appeared in PubMed. The second link of each item is a plain-text abstract that a page reader can open.",
	};
}

export async function query(options: Options, fetcher: Fetcher, now: Date): Promise<Result> {
	switch (options.source) {
		case "hn":
			return hn(options, fetcher);
		case "arxiv":
			return arxiv(options, fetcher, now);
		case "openalex":
			return openalex(options, fetcher);
		case "stackexchange":
			return stackexchange(options, fetcher);
		case "pubmed":
			return pubmed(options, fetcher, now);
	}
}

export function format(options: Options, result: Result): string {
	const answersMode = options.question !== undefined;
	const order = {
		relevance: answersMode ? "most votes first" : "most relevant first",
		date: "newest first",
		top: { hn: "most points first", openalex: "most cited first" }[options.source as string] ?? "most votes first",
	}[options.sort];
	const header = [options.source, answersMode ? `answers to question ${options.question}` : `query: ${options.query}`];
	if (options.source === "hn") header.push(options.kind === "story" ? "stories" : "comments");
	if (options.source === "stackexchange") header.push(`site: ${options.site}`);
	if (options.since) header.push(`since ${day(options.since)}`);
	if (result.total !== undefined) header.push(`${result.total} matches`);
	header.push(order, `showing ${result.items.length}`);
	const lines = [header.join(" | ")];
	if (result.note) lines.push(result.note);
	if (result.items.length === 0) lines.push("No matches.");
	result.items.forEach((item, index) => {
		lines.push(`${index + 1}. ${item.date || "undated"} | ${item.signal} | ${item.title}`);
		if (item.detail) lines.push(`   ${item.detail}`);
		for (const link of item.links) lines.push(`   ${link}`);
	});
	return lines.join("\n");
}

export async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!response.ok) {
		const retry = response.headers.get("retry-after");
		throw new Error(
			`HTTP ${response.status} from ${new URL(url).host}${retry ? `; retry after ${retry} seconds` : ""}`,
		);
	}
	return response.text();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv.includes("--help")) {
		console.log(help);
	} else {
		const now = new Date();
		try {
			const options = parseArgs(argv, now);
			console.log(format(options, await query(options, fetchText, now)));
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = error instanceof UsageError ? 2 : 1;
		}
	}
}
