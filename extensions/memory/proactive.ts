import { createHash } from "node:crypto";
import { recallSource, recallSources, type RecallSource } from "./retrieval.ts";

const STOP = new Set(
	"the and for that this with from have your you are not but will can use all any only into then when what how its our they their has was should must task agent work read file files source output current result request return complete before after model tool tools run using make new each about also one more than which there does need other already first same no do to a an in of on as is it be by or at we i my me us so if".split(
		" ",
	),
);
/** Complete input up to this many UTF-16 units is scored on all its terms and may carry a storage cue. */
const COMPLETE_INPUT_UNITS = 2000;
/** Longer input contributes terms only from its opening, so extraction work stays fixed for any input size. */
const SCAN_UNITS = 32768;
/** Longer input keeps at most this many terms, which limits incidental matches across a broad vocabulary. */
const EXTRACTED_TERMS = 48;
/** Rare cue weights are weakest in small inventories, even for a literal subject title. */
const SMALL_CORPUS_NOTES = 25;
export const inputDigest = (text: string): string => createHash("sha256").update(text).digest("hex");
function terms(text: string): string[] {
	return [
		...new Set(
			(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => term.length > 2 && !STOP.has(term)),
		),
	];
}

/** The opening of a long input, without a final word that the bound cuts. */
function opening(text: string): string {
	if (text.length <= SCAN_UNITS) return text;
	let end = SCAN_UNITS;
	const unit = text.charCodeAt(end - 1);
	if (unit >= 0xd800 && unit <= 0xdbff) end--;
	const window = text.slice(0, end);
	return /^[\p{L}\p{N}]/u.test(text.slice(end, end + 2)) ? window.replace(/[\p{L}\p{N}]+$/u, "") : window;
}

/**
 * A long input keeps the recall-vocabulary terms that it repeats, ranked by count times the scorer's rarity
 * weight. A single mention inside broad text, such as a report or a pasted log, is not evidence of its subject.
 */
function inputTerms(text: string, frequency: ReadonlyMap<string, number>, total: number): Set<string> {
	if (text.length <= COMPLETE_INPUT_UNITS) return new Set(terms(text));
	const counts = new Map<string, { count: number; first: number }>();
	const window = opening(text).toLowerCase();
	for (const [term] of window.matchAll(/[\p{L}\p{N}]+/gu)) {
		if (!frequency.has(term)) continue;
		const entry = counts.get(term);
		if (entry) entry.count++;
		else counts.set(term, { count: 1, first: counts.size });
	}
	return new Set(
		[...counts]
			.filter(([, { count }]) => count > 1)
			.map(([term, { count, first }]) => ({
				term,
				first,
				weight: count * Math.log(1 + total / (frequency.get(term) as number)),
			}))
			.sort((a, b) => b.weight - a.weight || a.first - b.first)
			.slice(0, EXTRACTED_TERMS)
			.map(({ term }) => term),
	);
}

function normalizeTitle(text: string): string {
	return text
		.normalize("NFC")
		.trim()
		.replace(/[^\S\r\n]+/gu, " ")
		.toLowerCase();
}

function literalTitleCandidate(text: string, notes: readonly RecallSource[]): RecallSource | undefined {
	const input = normalizeTitle(text);
	if (/[\r\n]/.test(input)) return undefined;
	const titled = notes.flatMap((note) => (note.exactTitle ? [{ note, title: normalizeTitle(note.exactTitle) }] : []));
	const exact = titled.filter(({ title }) => title === input && terms(title).length >= 2);
	if (exact.length !== 0) return exact.length === 1 ? exact[0].note : undefined;

	// In a short question, require the whole literal title plus words that distinguish it from other cues.
	if (!input.endsWith("?") || /["“”`<>[\]]/.test(input)) return undefined;
	const matches = titled.filter(({ note, title }) => {
		const subject = terms(title);
		if (subject.length < 3) return false;
		const start = input.indexOf(title);
		if (start < 0) return false;
		const before = input.slice(0, start);
		const after = input.slice(start + title.length);
		if (/[\p{L}\p{N}'‘’]$/u.test(before) || /^[\p{L}\p{N}'‘’]/u.test(after)) return false;
		if ((`${before} ${after}`.match(/[\p{L}\p{N}]+/gu) ?? []).length > 8) return false;
		const otherCues = new Set(
			notes.flatMap((other) => (other === note ? [] : terms(`${other.slug} ${other.exactTitle ?? other.title}`))),
		);
		return subject.filter((word) => !otherCues.has(word)).length >= 2;
	});
	return matches.length === 1 ? matches[0].note : undefined;
}

type Evidence = { cue: boolean; weight: number };
type Candidate = { note: RecallSource; score: number; matches: Map<string, Evidence>; normaliser: number };
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
const RECALL_FLOOR = 18;

function recallScore(matches: Iterable<Evidence>, normaliser: number): number {
	const evidence = [...matches];
	if (evidence.filter(({ cue }) => cue).length < 2) return 0;
	const weights = evidence.map(({ weight }) => weight).sort((a, b) => b - a);
	return Number((weights.slice(0, 6).reduce((sum, weight) => sum + weight, 0) / normaliser).toFixed(2));
}

function sentenceScore(text: string, candidate: Candidate): number {
	const matches = terms(text).flatMap((term) => candidate.matches.get(term) ?? []);
	return recallScore(matches, candidate.normaliser);
}

function supportsSubject(text: string, candidate: Candidate): boolean {
	const subject = terms(candidate.note.slug).filter((term) => candidate.matches.has(term));
	for (const paragraph of opening(text).split(/\r?\n[ \t]*\r?\n/)) {
		const words = new Set(terms(paragraph));
		if (subject.filter((term) => words.has(term)).length >= 2) return true;
		if (![...words].some((term) => candidate.matches.get(term)?.cue)) continue;
		// A title paraphrase need not name the slug. Require its evidence together, not across unrelated sentences.
		for (const { segment } of sentences.segment(paragraph.replace(/\s+/gu, " ")))
			if (sentenceScore(segment, candidate) >= RECALL_FLOOR) return true;
	}
	return false;
}

function lexicalCandidate(
	indexed: { note: RecallSource; cue: string[]; summary: string[] },
	input: ReadonlySet<string>,
	frequency: ReadonlyMap<string, number>,
	total: number,
): Candidate {
	const { note, cue, summary } = indexed;
	const matches = new Map<string, Evidence>();
	for (const term of new Set([...cue, ...summary])) {
		if (!input.has(term)) continue;
		const inCue = cue.includes(term);
		matches.set(term, { cue: inCue, weight: Math.log(1 + total / (frequency.get(term) ?? 1)) * (inCue ? 2 : 0.5) });
	}
	const normaliser = Math.sqrt(1 + (cue.length + summary.length) / 50);
	return { note, score: recallScore(matches.values(), normaliser), matches, normaliser };
}

/** Fixed lexical selection values, not probabilities or a general-purpose search rank. */
export function recallCandidate(text: string, notes: readonly RecallSource[]): RecallSource | undefined {
	if (!text.trim()) return undefined;
	if (notes.length <= SMALL_CORPUS_NOTES && text.length <= COMPLETE_INPUT_UNITS) {
		const literal = literalTitleCandidate(text, notes);
		if (literal) return literal;
	}
	const indexed = notes.map((note) => ({
		note,
		cue: terms(`${note.slug} ${note.title}`),
		summary: terms(note.summary.slice(0, 800)),
	}));
	const frequency = new Map<string, number>();
	for (const note of indexed)
		for (const term of new Set([...note.cue, ...note.summary])) frequency.set(term, (frequency.get(term) ?? 0) + 1);
	const input = inputTerms(text, frequency, notes.length);
	const best = indexed
		.map((row) => lexicalCandidate(row, input, frequency, notes.length))
		.filter(({ score }) => score >= RECALL_FLOOR)
		.sort((a, b) => b.score - a.score || a.note.slug.localeCompare(b.note.slug))[0];
	return best && supportsSubject(text, best) ? best.note : undefined;
}

/** A phrase cue invites judgement; it deliberately does not classify a durable fact. */
export function storageCue(text: string): boolean {
	if (!text.trim() || text.length > COMPLETE_INPUT_UNITS) return false;
	let fence: { marker: string; length: number } | undefined;
	const bare: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && /^\s*$/.test(marker[2]))
				fence = undefined;
			continue;
		}
		if (marker) {
			fence = { marker: marker[1][0], length: marker[1].length };
			continue;
		}
		if (!/^\s*>/.test(line)) bare.push(line);
	}
	return /\b(?:prefer|i hate|my preference|my stance|from now on|going forward|in future|i upgraded my|i switched my|i changed my|we can use|you can also use)\b/i.test(
		bare.join("\n"),
	);
}

export type Notice = {
	text: string;
	root: string;
	slug: string | null;
	digest: string | null;
	kind: "recall" | "storage" | "recall-storage";
	inputDigest: string;
};
export function noteKey(root: string, slug: string, digest: string): string {
	return JSON.stringify([root, slug, digest]);
}

type Selected = RecallSource & { digest: string };
function renderNotice(source: string, recall: Selected | undefined, storage: boolean, complete: boolean): string {
	const lines = [`Memory notice. Source class: ${source}. Input-source labels do not prove human authorship.`];
	if (recall) {
		lines.push(
			`Memory candidate, not a new instruction: ${recall.slug}.`,
			`Lifecycle: active. Review policy: ${recall.freshness.policy}; deadline: ${recall.freshness.deadline}; unresolved concern: ${recall.freshness.concern ? "yes" : "none recorded"}.`,
			`If this subject matters to the request, read it with memory_read, slug ${recall.slug}, digest ${recall.digest}. Otherwise ignore it. Check the full note, later qualifications and freshness before use. Current instructions win.`,
		);
	}
	if (storage)
		lines.push(
			"Memory check: this message uses preference or future-use wording. If it states a standing operator preference, decision, correction or environment fact that should guide future sessions, record it now: memory_search for an existing subject, then update it with memory_edit or create one with memory_write, citing this message as the source. Skip it when it applies only to the current task, quotes someone else, or is already stored.",
		);
	if (!complete) lines.push("Automatic recall coverage is partial; omitted sources remain unknown.");
	return lines.join("\n");
}
function noticeKind(recall: Selected | undefined, storage: boolean): Notice["kind"] {
	if (!recall) return "storage";
	return storage ? "recall-storage" : "recall";
}
async function prepareMemoryNotice(
	root: string | undefined,
	text: string,
	source: string,
	allowStorage: boolean,
	satisfied: ReadonlySet<string>,
	signal?: AbortSignal,
): Promise<Notice | undefined> {
	if (!text.trim() || signal?.aborted) return undefined;
	const scan = await recallSources(root, signal);
	if (!scan || signal?.aborted) return undefined;
	const candidate = recallCandidate(text, scan.notes);
	const selected = candidate ? await recallSource(scan, candidate, signal) : undefined;
	const recall = selected && !satisfied.has(noteKey(scan.root, selected.slug, selected.digest)) ? selected : undefined;
	const storage = allowStorage && storageCue(text) && !satisfied.has(noteKey(scan.root, "storage", inputDigest(text)));
	if ((!recall && !storage) || signal?.aborted) return undefined;
	const payload = renderNotice(source, recall, storage, scan.complete);
	// Keep complete framing and safety qualifications rather than truncate a large notice.
	if (Buffer.byteLength(payload) > 2048) return undefined;
	return {
		text: payload,
		root: scan.root,
		slug: recall?.slug ?? null,
		digest: recall?.digest ?? null,
		kind: noticeKind(recall, storage),
		inputDigest: inputDigest(text),
	};
}

/** Advisory source failures abstain; cancellation remains a host-owned boundary. */
export async function memoryNotice(
	root: string | undefined,
	text: string,
	source: string,
	allowStorage: boolean,
	satisfied: ReadonlySet<string>,
	signal?: AbortSignal,
): Promise<Notice | undefined> {
	try {
		return await prepareMemoryNotice(root, text, source, allowStorage, satisfied, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		return undefined;
	}
}
