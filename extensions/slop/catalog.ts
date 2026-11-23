import { domains, idPattern, scopes } from "./vocabulary.ts";

export type Scope = (typeof scopes)[number];
export type Domain = (typeof domains)[number];
export type Example = { kind: string; verdict: "slop" | "better"; text: string };
export type Detector = {
	id: string;
	in: Scope[];
	phrases?: string[];
	pattern?: string;
	limit?: number;
	per?: number;
	allow?: string[];
	lexicon?: boolean;
	caseSensitive?: boolean;
	distinct?: boolean;
	paths?: string[];
};
export type EntryFields = {
	id: string;
	title: string;
	domain: Domain;
	applies: Scope[];
	prompt?: boolean;
	recognition: string;
	cost: string;
	repair: string;
	examples?: Example[];
	detectors?: Detector[];
};
export type Entry = Required<EntryFields> & {
	origin: "starter" | "recorded";
	raw: string;
	notes?: string;
	record?: { created?: string; updated?: string; items: string[] };
};

export const entryLimit = 128 * 1024;

const idRegex = new RegExp(idPattern);
export function requireId(value: string): string {
	if (typeof value !== "string" || !idRegex.test(value) || value.length > 128)
		throw new Error("Use a kebab-case entry id of at most 128 characters.");
	return value;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hasText = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const isScope = (v: unknown): v is Scope => scopes.some((scope) => scope === v);
const sectionNames = new Set(["Recognition", "Cost", "Repair", "Examples", "Detectors", "Notes", "Record"]);

export type Fence = { mark: string; size: number; info: string };
export function openingFence(line: string): Fence | undefined {
	const match = /^ {0,3}(`{3,}|~{3,})\s*(.*?)\s*$/.exec(line);
	if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
		return { mark: match[1][0], size: match[1].length, info: match[2] };
	}
}
export function closingFence(line: string, fence: Fence): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
	return !!match && match[1][0] === fence.mark && match[1].length >= fence.size;
}

type Reject = (message: string) => never;
const detectorFields = new Set([
	"id",
	"in",
	"phrases",
	"pattern",
	"limit",
	"per",
	"allow",
	"lexicon",
	"caseSensitive",
	"distinct",
	"paths",
]);

function validateLists(item: Record<string, unknown>, fail: Reject) {
	for (const field of ["phrases", "paths", "allow"]) {
		if (Object.hasOwn(item, field)) {
			const values = item[field];
			if (!Array.isArray(values) || !values.every(hasText) || (field !== "allow" && !values.length))
				fail(`${field} must be an array of nonempty strings`);
		}
	}
}

function hasModifiers(pattern: string) {
	const groups = /\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]|\(\?(?:[ims]+(?:-[ims]+)?|-[ims]+):/g;
	for (const group of pattern.matchAll(groups)) if (group[0].startsWith("(?")) return true;
	return false;
}

function quantifierAt(pattern: string, i: number): { size: number; unbounded: boolean } | undefined {
	const char = pattern[i];
	if (char === "*" || char === "+") return { size: 1, unbounded: true };
	if (char === "?") return { size: 1, unbounded: false };
	const braces = /^\{\d+(,(\d*))?\}/.exec(pattern.slice(i, i + 24));
	return braces ? { size: braces[0].length, unbounded: braces[2] === "" } : undefined;
}

function endOfClass(pattern: string, i: number): number {
	let j = i + 1;
	while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
	return j + 1;
}

function groupPrefix(pattern: string, i: number): { size: number; lookbehind: boolean } {
	if (pattern.startsWith("(?<=", i) || pattern.startsWith("(?<!", i)) return { size: 4, lookbehind: true };
	if (pattern.startsWith("(?<", i)) return { size: pattern.indexOf(">", i) + 1 - i, lookbehind: false };
	return { size: pattern.startsWith("(?", i) ? 3 : 1, lookbehind: false };
}

type Frame = { lookbehind: boolean; repeats: boolean };

/** Moves past one token that is not a quantifier; a closing parenthesis returns the group it closed. */
function scanToken(pattern: string, i: number, stack: Frame[]): { next: number; closed?: Frame } {
	const char = pattern[i];
	const top = stack[stack.length - 1];
	if (char === "\\") return { next: i + (/^\\[pPu]\{[^}]*\}/.exec(pattern.slice(i, i + 64))?.[0].length ?? 2) };
	if (char === "[") return { next: endOfClass(pattern, i) };
	if (char === "(") {
		const prefix = groupPrefix(pattern, i);
		stack.push({ lookbehind: prefix.lookbehind || top.lookbehind, repeats: false });
		return { next: i + prefix.size };
	}
	if (char !== ")" || stack.length === 1) return { next: i + 1 };
	const closed = stack.pop() ?? top;
	if (closed.repeats) stack[stack.length - 1].repeats = true;
	return { next: i + 1, closed };
}

/**
 * Detectors run inside the Pi process, where a regular expression cannot be interrupted. Two shapes make matching
 * time grow faster than the line: an unbounded repetition of a group whose body also repeats without bound, and an
 * unbounded repetition inside a lookbehind, which the engine retries backwards from every position.
 */
function riskyRepetition(pattern: string): string | undefined {
	const stack: Frame[] = [{ lookbehind: false, repeats: false }];
	let group: Frame | undefined;
	let i = 0;
	while (i < pattern.length) {
		const top = stack[stack.length - 1];
		const quantifier = quantifierAt(pattern, i);
		if (!quantifier) {
			const step = scanToken(pattern, i, stack);
			i = step.next;
			group = step.closed;
			continue;
		}
		if (quantifier.unbounded && top.lookbehind) return "an unbounded repetition inside a lookbehind";
		if (quantifier.unbounded && group?.repeats)
			return "an unbounded repetition of a group that already repeats without bound";
		if (quantifier.unbounded) top.repeats = true;
		i += quantifier.size + (pattern[i + quantifier.size] === "?" ? 1 : 0);
		group = undefined;
	}
}

function validateMatch(item: Record<string, unknown>, fail: Reject) {
	if (Object.hasOwn(item, "phrases") === Object.hasOwn(item, "pattern")) fail("set exactly one of phrases or pattern");
	if (Object.hasOwn(item, "pattern")) {
		if (!hasText(item.pattern)) fail("pattern must be a nonempty string");
		if (hasModifiers(item.pattern)) fail("Use caseSensitive instead of inline regular expression modifiers.");
		const risk = riskyRepetition(item.pattern);
		if (risk) fail(`pattern has ${risk}. Bound the repetition, for example {1,40}.`);
		try {
			new RegExp(item.pattern, item.caseSensitive === true ? "gu" : "giu");
		} catch (error) {
			fail(`invalid regular expression: ${String(error)}`);
		}
	}
}

function validateFlags(item: Record<string, unknown>, fail: Reject) {
	for (const field of ["lexicon", "caseSensitive", "distinct"])
		if (Object.hasOwn(item, field) && typeof item[field] !== "boolean") fail(`${field} must be boolean`);
}

function validateAllowance(item: Record<string, unknown>, fail: Reject) {
	for (const field of ["limit", "per"]) {
		const number = item[field];
		if (
			Object.hasOwn(item, field) &&
			(typeof number !== "number" || !Number.isSafeInteger(number) || number < (field === "per" ? 1 : 0))
		)
			fail(`${field} must be ${field === "per" ? "a positive" : "a nonnegative"} integer`);
	}
	if (Object.hasOwn(item, "per") && !Object.hasOwn(item, "limit")) fail("per requires limit");
}

function parseDetector(item: unknown, i: number, applies: Scope[], ids: Set<string>): Detector {
	const prefix = `Detector ${i + 1}${isRecord(item) && hasText(item.id) ? ` (${item.id})` : ""}`;
	const fail = (message: string): never => {
		throw new Error(`${prefix}: ${message}`);
	};
	if (!isRecord(item)) return fail("expected an object");
	for (const key of Object.keys(item)) if (!detectorFields.has(key)) fail(`unknown field ${key}`);
	if (!hasText(item.id) || /[\p{Cc}]/u.test(item.id) || ids.has(item.id))
		return fail("id must be a unique nonempty string");
	ids.add(item.id);
	if (!Array.isArray(item.in) || !item.in.length || !item.in.every((v) => isScope(v) && applies.includes(v)))
		fail("in must contain scopes from applies");
	validateLists(item, fail);
	validateFlags(item, fail);
	validateMatch(item, fail);
	validateAllowance(item, fail);
	return item as Detector;
}

export function parseDetectors(value: unknown, applies: Scope[]): Detector[] {
	if (!Array.isArray(value)) throw new Error("Detectors must be an array.");
	const ids = new Set<string>();
	return value.map((item, i) => parseDetector(item, i, applies, ids));
}

function readBlock(lines: string[], start: number): { info: string; text: string; next: number } {
	const fence = openingFence(lines[start] ?? "");
	if (!fence) throw new Error("Expected a fenced block.");
	let end = start + 1;
	while (end < lines.length && !closingFence(lines[end], fence)) end++;
	if (end === lines.length) throw new Error("Unclosed fenced block.");
	return { info: fence.info, text: lines.slice(start + 1, end).join("\n"), next: end + 1 };
}

function parseExamples(body: string): Example[] {
	const lines = body.split("\n");
	const examples: Example[] = [];
	let i = 0;
	while (i < lines.length) {
		if (!lines[i].trim()) {
			i++;
			continue;
		}
		const label = lines[i].trim();
		if (label !== "Slop:" && label !== "Better:")
			throw new Error(`Expected Slop: or Better: for example ${examples.length + 1}.`);
		i++;
		while (i < lines.length && !lines[i].trim()) i++;
		const block = readBlock(lines, i);
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_+-]*$/.test(block.info))
			throw new Error(`Invalid kind for example ${examples.length + 1}.`);
		examples.push({ kind: block.info, text: block.text, verdict: label === "Slop:" ? "slop" : "better" });
		i = block.next;
	}
	return examples;
}

function frontmatter(lines: string[]) {
	const boundary = lines.indexOf("---", 1);
	if (lines[0] !== "---" || boundary < 0) throw new Error("Expected frontmatter between --- lines.");
	const fields = new Map<string, unknown>();
	for (const line of lines.slice(1, boundary)) {
		if (!line.trim()) continue;
		const pair = /^([a-z]+):\s*(.*)$/.exec(line);
		if (!pair || !["id", "title", "domain", "applies", "prompt"].includes(pair[1]))
			throw new Error(`Unknown frontmatter line: ${line}`);
		if (fields.has(pair[1])) throw new Error(`Duplicate frontmatter key: ${pair[1]}`);
		const text = pair[2].trim();
		fields.set(pair[1], /^[[{"]/.test(text) ? JSON.parse(text) : text);
	}
	return { fields, boundary };
}

function parseFields(fields: Map<string, unknown>, id: string, starter: boolean) {
	if (fields.get("id") !== id) throw new Error("id must equal the file name.");
	const title = fields.get("title");
	if (!hasText(title) || title !== title.trim() || /[\p{Cc}]/u.test(title))
		throw new Error("Expected a nonempty title on one line.");
	const domain = domains.find((value) => value === fields.get("domain"));
	if (!domain) throw new Error("domain must be prose, code or ui.");
	const applies = fields.get("applies");
	if (!Array.isArray(applies) || !applies.length || !applies.every(isScope))
		throw new Error("applies must be a nonempty array of scopes.");
	const prompt = fields.get("prompt");
	if (prompt !== undefined && prompt !== "true" && prompt !== "false") throw new Error("prompt must be true or false.");
	if (starter && prompt === undefined) throw new Error("Starter entries must declare prompt.");
	return { title, domain, applies, prompt: prompt !== "false" };
}

function nextFence(line: string, fence: Fence | undefined): Fence | undefined {
	if (fence) return closingFence(line, fence) ? undefined : fence;
	return openingFence(line);
}

function parseSections(body: string[]) {
	const sections = new Map<string, string[]>();
	let section: string[] | undefined;
	let fence: Fence | undefined;
	for (const line of body) {
		const heading = !fence && /^## (.+)$/.exec(line);
		if (heading) {
			const name = heading[1].trim();
			if (!sectionNames.has(name)) throw new Error(`Unknown section ${name}.`);
			if (sections.has(name)) throw new Error(`Duplicate section ${name}.`);
			section = [];
			sections.set(name, section);
			continue;
		}
		fence = nextFence(line, fence);
		if (section) section.push(line);
		else if (line.trim()) throw new Error("Expected a section after the title.");
	}
	if (fence) throw new Error("Unclosed fenced block.");
	return new Map([...sections].map(([name, lines]) => [name, lines.join("\n").trim()]));
}

function detectorSection(section: string | undefined, applies: Scope[]): Detector[] {
	if (section === undefined) return [];
	const lines = section.split("\n");
	const block = readBlock(lines, 0);
	if (block.info !== "json" || block.next !== lines.length) throw new Error("Detectors must contain one json fence.");
	return parseDetectors(JSON.parse(block.text), applies);
}

const recordHeading = "### Save";

function parseRecord(body: string): NonNullable<Entry["record"]> {
	const groups: string[][] = [[]];
	let fence: Fence | undefined;
	for (const line of body.split("\n")) {
		if (!fence && line === recordHeading) groups.push([]);
		else groups[groups.length - 1].push(line);
		fence = nextFence(line, fence);
	}
	const [header, ...items] = groups.map((group) => group.join("\n").trim());
	const stamp = (key: string) => {
		const value = new RegExp(`^${key}: (.+)$`, "m").exec(header)?.[1];
		return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
	};
	return { created: stamp("Created"), updated: stamp("Updated"), items };
}

export function formatRecord(created: string, updated: string, items: string[]): string {
	return `\n## Record\n\nCreated: ${created}\nUpdated: ${updated}\n${items.map((item) => `\n${recordHeading}\n\n${item}\n`).join("")}`;
}

export function parseEntry(raw: string, id: string, starter = false): Entry {
	try {
		requireId(id);
		if (Buffer.byteLength(raw) > entryLimit) throw new Error("Entry exceeds 128 KiB.");
		const lines = raw.split(/\r?\n/);
		const { fields, boundary } = frontmatter(lines);
		const header = parseFields(fields, id, starter);
		const body = lines.slice(boundary + 1);
		while (body.length && !body[0].trim()) body.shift();
		if (body.shift() !== `# ${header.title}`) throw new Error("First heading must match title.");
		const sections = parseSections(body);
		if (starter && sections.has("Record")) throw new Error("Starter entries cannot contain a Record section.");
		const content = (name: string) => sections.get(name) ?? "";
		const required = (name: string) => {
			const text = content(name);
			if (!text) throw new Error(`Missing or empty ${name} section.`);
			return text;
		};
		const record = sections.has("Record") ? parseRecord(content("Record")) : undefined;
		return {
			id,
			...header,
			recognition: required("Recognition"),
			cost: required("Cost"),
			repair: required("Repair"),
			examples: sections.has("Examples") ? parseExamples(content("Examples")) : [],
			detectors: detectorSection(sections.get("Detectors"), header.applies),
			origin: record ? "recorded" : "starter",
			raw,
			notes: sections.get("Notes"),
			record,
		};
	} catch (error) {
		throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function firstSentence(text: string): string {
	const paragraph = text
		.split(/\n\s*\n/, 1)[0]
		.replace(/\s+/g, " ")
		.trim();
	return paragraph.match(/^.*?[.!?]["'’”)]*(?=\s|$)/u)?.[0] ?? paragraph;
}

export function fenced(info: string, text: string): string {
	let length = 3;
	for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
	const fence = "`".repeat(length);
	return `${fence}${info}\n${text}\n${fence}`;
}
