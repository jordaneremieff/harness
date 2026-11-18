import { proseBlocks } from "./prose-source.ts";

export type BriefMessage = { role: "user" | "assistant" | "toolResult"; text: string };
export type WritingBrief = { title?: string; reader: string; requests?: string[]; skipped?: number; opening: string; terms?: string[]; checks: string[]; limited?: boolean };

export const BRIEF_SCAN_BYTES = 2 * 1024 * 1024;
const DEFAULT_READER = "The person who asked reads this document on its own, often after time away. They did not see your tool calls, files or other agents' reports, and they do not know names that the work created.";
const OPENING = "Start with the answer, result or decision. Explain what it means for the reader. If they need to act, tell them what to do. Give only the detail they need to trust or use the result.";
const INJECTED = /^(?:[<#]|Read[ \t]+(?:["'`])?(?:\.{1,2}\/|~\/|\/|[\p{L}\w-]+\/)|\/skill:)/iu;
const TOKEN = /(?:~\/|\/)[^\s`"'<>]+|[\p{L}\d_][\p{L}\d_./'’:-]*/gu;
const CODE = /[/_]|[a-z][A-Z]|[.-]\p{L}/u;
const SHAPE = /^\p{L}[\p{L}\d]*(?:[/_.-][\p{L}\d]+)*$/u;
const QUOTED_PHRASE = /^\p{L}[\p{L}\d-]*(?: +\p{L}[\p{L}\d-]*){1,3}$/u;
const IDENTIFIER = /^(?:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|(?=[a-f\d]*\d)[a-f\d]{7,64})$/iu;
const OPAQUE = /[a-z\d+=]{32,}/iu;
const KEYWORDS = new Set("abstract array async await boolean break case catch class const continue debugger default defer delete double else enum export extends false final finally float function guard implements import instanceof interface internal lambda match module namespace never null number object override package private protected public raise record return self static string struct super switch throw throws trait true tuple type typeof undefined union unsafe using void while yield".split(" "));
const units = (value: string, max: number) => [...value.slice(0, max * 2)].slice(0, max).join("");
const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
function candidate(term: string, quoted = false): boolean {
	return term.length > 3 && term.length <= 72 && !KEYWORDS.has(term.toLowerCase()) && !IDENTIFIER.test(term) && !OPAQUE.test(term)
		&& ((SHAPE.test(term) && CODE.test(term)) || (quoted && QUOTED_PHRASE.test(term)));
}
function* plainTerms(prose: string): Iterable<string> {
	for (const match of prose.matchAll(TOKEN)) {
		const value = match[0];
		const end = match.index + value.length;
		if (prose[match.index - 1] === '"' && /^"\s*:/u.test(prose.slice(end, end + 16))) continue;
		const term = value.replace(/[.'’:-]+$/u, "");
		if (candidate(term)) yield term;
	}
}
function* terms(text: string): Iterable<string> {
	for (const block of proseBlocks(text)) {
		for (const { text: prose } of block.lines) yield* plainTerms(prose);
		for (const item of block.codeSpans) {
			const term = item.text.replace(/^`+|`+$/gu, "").trim();
			if (candidate(term, true)) yield term;
		}
	}
}
function inRequest(term: string, request: string): boolean {
	let start = 0;
	while (start <= request.length) {
		const at = request.indexOf(term, start);
		if (at < 0) return false;
		const letter = /[\p{L}\p{N}_]/u;
		if (!letter.test(request[at - 1] ?? "") && !letter.test(request[at + term.length] ?? "")) return true;
		start = at + term.length;
	}
	return false;
}
function utf8Suffix(text: string, limit: number): { text: string; clipped: boolean } {
	if (text.length <= limit && Buffer.byteLength(text) <= limit) return { text, clipped: false };
	const bytes = Buffer.from(text.slice(-limit));
	let start = Math.max(0, bytes.length - limit);
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return { text: bytes.toString("utf8", start), clipped: true };
}

/** Consumes the current branch in newest-first order. Transcript text is evidence, not authority. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The newest typed request ends term collection but not request collection.
export function buildBrief(options: { title?: string; reader?: string; messages?: Iterable<BriefMessage>; lexicon?: ReadonlySet<string>; checks: string[] }): WritingBrief {
	const result: WritingBrief = { ...(options.title === undefined ? {} : { title: options.title }), reader: options.reader?.trim() || DEFAULT_READER, opening: OPENING, checks: options.checks };
	if (!options.messages) return result;
	const requests: string[] = [], vocabulary: string[] = [];
	let skipped = 0, scanned = 0, limited = false;
	const counts = new Map<string, { display: string; count: number }>();
	for (const { role, text } of options.messages) {
		if (role === "user") {
			const request = text.trim();
			if (!request || (request.length > 3000 && [...request.slice(0, 6002)].length > 3000) || INJECTED.test(request)) { skipped++; continue; }
			requests.push(units(request, 600));
			vocabulary.push(request.toLowerCase());
			if (requests.length === 3) break;
			continue;
		}
		if (requests.length || role !== "assistant") continue;
		if (scanned >= BRIEF_SCAN_BYTES) { limited ||= text.length > 0; continue; }
		const sample = utf8Suffix(text, BRIEF_SCAN_BYTES - scanned);
		limited ||= sample.clipped;
		scanned += Buffer.byteLength(sample.text);
		for (const display of terms(sample.text)) {
			const key = display.toLowerCase();
			if (options.lexicon?.has(key)) continue;
			const current = counts.get(key) ?? { display, count: 0 };
			current.count++;
			counts.set(key, current);
		}
	}
	const ranked = [...counts].sort(([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0));
	const names: string[] = [];
	for (const [key, item] of ranked) {
		if (!vocabulary.some((request) => inRequest(key, request))) names.push(item.display);
		if (names.length === 15) break;
	}
	return { ...result, requests: requests.reverse(), skipped, terms: names, ...(limited ? { limited } : {}) };
}

export function formatBrief(brief: WritingBrief): string {
	const lines = [brief.title ? `Writing brief for ${JSON.stringify(clean(brief.title))}` : "Writing brief", "", brief.reader, ""];
	if (brief.requests === undefined) lines.push("I could not read the conversation for recent requests or names.");
	else if (!brief.requests.length) lines.push("I found no typed request in the part of the conversation I read.");
	else {
		const skipped = brief.skipped ?? 0;
		lines.push(`These are the latest requests in this conversation, oldest first.${skipped ? ` I left out ${skipped} blank or pasted ${skipped === 1 ? "message" : "messages"}.` : ""}`);
		for (const request of brief.requests) lines.push(`- ${JSON.stringify(clean(request))}`);
	}
	lines.push("", brief.opening);
	if (brief.terms?.length) lines.push("", `The reader does not use these names from your work: ${brief.terms.map((term) => JSON.stringify(term)).join(", ")}. Explain each one you keep in plain words, or leave it out.`);
	if (brief.limited) lines.push("I reached the limit for reading earlier replies.");
	return [...lines, "", ...brief.checks].join("\n");
}
