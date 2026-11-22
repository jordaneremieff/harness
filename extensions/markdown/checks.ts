import { effectiveRules, RULE_IDS, type CheckOverrides, type Rule } from "./check-rules.ts";
import { proseBlocks } from "./prose-source.ts";

export type CheckExample = { line: number; text: string };
/** `unlisted` counts the flagged passages beyond the listed examples. */
export type Finding = { rule: Rule; count: number; limit: number; examples: CheckExample[]; unlisted?: number };
/** A finding lists at most this many flagged passages, so that one revision can address all of them. */
export const MAX_EXAMPLES = 40;
const established = new Set(
	"all-in-one anti-pattern as-is back-end best-effort bottom-left bottom-right bottom-up by-product case-insensitive case-sensitive cherry-pick cherry-picked client-side coarse-grained command-line compile-time dead-letter double-click drag-and-drop dry-run end-user fast-forward fine-grained fire-and-forget first-class first-party first-person force-push front-end full-text full-time full-width half-closed half-open hand-written hard-coded high-level how-to in-depth in-flight in-house in-memory in-person in-place in-process in-progress kebab-case key-value left-click left-hand long-lived long-running long-standing long-term low-level lower-case must-have nice-to-have no-op off-screen on-device on-disk on-screen open-ended open-source part-time person-centred plain-text rate-limit rate-limited read-write real-time rich-text right-click right-hand round-trip run-time self-contained server-side short-lived short-term single-line snake-case so-called spot-check state-of-the-art third-party top-down top-left top-level top-right up-to-date upper-case well-known".split(
		" ",
	),
);
const countedCompound =
	/^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)-/u;
// A bound prefix forms one word with the next, such as non-empty or re-read. Free words such as self and over do not.
const prefixes = new Set("auto inter intra mid mis multi non per post pre pseudo quasi re semi sub".split(" "));
const suffixes = new Set(["like", "only", "specific", "wide"]);
// A common verb with a particle forms an ordinary phrasal noun or adjective, such as check-in, carve-out or trade-off.
const particles = new Set("around away back down in off on out over through up".split(" "));
const phrasalVerbs = new Set(
	"add back bail break bring build built burn buy call carry carve cash catch check clean clear click clip close come count cross cut dial dig drill drive drop dry fade fall fan fill fix fold follow freeze get give go hand hang held hold hook kick knock lay lead let lock log look made make mark mix opt pass pay phase pick pin play plug point pop print pull push put read roll round run scale scroll see sell send set shake shut sign sit slow sort spill spin split stand start step stop sum swap switch take tear throw tie time top track trade try tune turn walk warm wash wind wipe work wrap write zoom".split(
		" ",
	),
);
function phrasalVerb(word: string): boolean {
	return [
		word,
		word.replace(/s$/u, ""),
		word.replace(/(?:ed|ing)$/u, ""),
		word.replace(/(?:d|ing)$/u, ""),
		word.replace(/ing$/u, "e"),
		word.replace(/(\p{L})\1(?:ed|ing)$/u, "$1"),
	].some((stem) => phrasalVerbs.has(stem));
}
// A repeated word joined by a short word forms a set phrase, such as end-to-end. A for-phrase such as
// word-for-word claims exactness like the stock phrase byte-for-byte, so it counts.
const phraseCompound = /^(?:(\p{L}+)-(?:after|and|by|in|on|or|over|to)-\1|out-of-\p{L}+)$/u;
// A token with a path root, extension, underscore or similar mark, or with a digit inside a word or after a
// separator, is an identifier such as a model, package or rule name: model-4-mini, php-fpm:8.2, k8s.
const identifierToken = /\p{L}\d|\d\p{L}|[-.:_]\d|\d[-.:_]|[_@\\=#]|[.:][\p{L}\p{N}]|^(?:~|\.{1,2})?\//u;
const tokenMarks = /^[([{"'‘“*_~]+|\[\^[^\]]*\]|[)\]}"'’”*_~.,;:!?]+$/gu;
const codeCompound = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)+/gu;
/** Hyphenated identifiers, prefixed words and set phrases are not compounds coined for the occasion. */
function ordinaryCompound(term: string): boolean {
	const key = term.toLowerCase();
	if (established.has(key) || established.has(key.replace(/s$/u, ""))) return true;
	if (countedCompound.test(key) || phraseCompound.test(key)) return true;
	const parts = key.split("-");
	const [first, last] = [parts[0], parts[parts.length - 1]];
	// A single letter at either end marks a name such as x-request-id, e-mail or command-k; a final -y is a suffix.
	if (first.length === 1 || (last.length === 1 && last !== "y")) return true;
	if (parts.length !== 2) return false;
	return prefixes.has(first) || suffixes.has(last) || (particles.has(last.replace(/s$/u, "")) && phrasalVerb(first));
}
const units = new Set(
	"% ms µs us ns s sec secs min mins m h hr hrs d w wk y yr b kb mb gb tb kib mib gib tib byte bytes k px pt em rem dpi hz khz mhz ghz fps rps qps ops tok tokens x × utc gmt aedt aest acdt acst awst pst pdt est edt cst cdt mst mdt cet cest bst ist jst am pm jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december".split(
		" ",
	),
);
const unit = (word: string) => units.has(word) || units.has(word.replace(/\/s$/u, ""));
const operator = /^(?:[<>]=?|={1,3}|!=|≈|~|±|≤|≥|[-+−–×x/*])$/u;
const hash = /^(?=[a-f\d]*[a-f])[a-f\d]{7,40}$/iu;
const version = /^v?\d+(?:\.\d+){1,3}(?:-[\da-z.]+)?(?:\+[\da-z.]+)?$/iu;
const instant = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/u;
const duration = /^(?:\d+(?:\.\d+)?(?:ms|µs|us|ns|[smhdw]))+$/u;
const quantity = /^[-+−~≈<>=±≤≥$€£¥]*\d[\d.,:/_]*(?:[-+−–]\d[\d.,:/_]*)?%?([\p{L}µ/]*)$/u;
function dataToken(token: string): boolean {
	const value = token.replace(/^[([{"']+|[)\]}"',.;:]+$/gu, "");
	if (!value || operator.test(value) || unit(value.toLowerCase())) return true;
	if (hash.test(value)) return false;
	if (version.test(value) || instant.test(value) || duration.test(value)) return true;
	const suffix = quantity.exec(value)?.[1];
	return suffix !== undefined && (!suffix || unit(suffix.toLowerCase()));
}
/** A span that holds only a number, date, time, version or quantity is data, not a name. */
function dataSpan(code: string): boolean {
	const body = code.replace(/^`+|`+$/gu, "").trim();
	return /\d/u.test(body) && body.split(/\s+/u).every(dataToken);
}
const rangeMonth =
	"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|present)";
const rangeLeft = new RegExp(`(?:\\d|\\b${rangeMonth}\\.?) *$`, "iu");
const rangeRight = new RegExp(`^ *(?:\\d|${rangeMonth}(?![-\\p{L}\\p{N}_]))`, "iu");
// Range ends in code can carry a short unit or zone after the number, such as 09:25:00Z or 5ms.
const rangeLeftCode = new RegExp(`(?:\\d[\\p{L}%]{0,3}|\\b${rangeMonth}\\.?) *$`, "iu");
const rangeRightCode = new RegExp(`^ *(?:v?\\d|${rangeMonth}(?![-\\p{L}\\p{N}_]))`, "iu");
const compound = /(?<![\p{L}\p{N}_-])\p{L}+(?:-\p{L}+)+(?![\p{L}\p{N}_-])/gu;
const dashes = /[—–]|(?<=[\p{L}\p{N}])[\t ]+-[\t ]+(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])--(?=[\p{L}\p{N}])/gu;
const id =
	/(?<![\p{L}\p{N}_/])(?:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|(?:~\/|\/)[\p{L}\p{N}_.-][\p{L}\p{N}_.@%~+/-]*|(?=[a-f\d]{0,39}\d)(?=[a-f\d]{0,39}[a-f])[a-f\d]{7,40})(?![\p{L}\p{N}_/])/giu;
const pathOrUrl = /(?<![a-z\d+.-])(?:[a-z][a-z\d+.-]{0,31}:\/\/|www\.)[^\s<>]+/giu;
const label =
	/^(?:\*{1,2}[^*:\n]{1,80}(?::\*{1,2}|\*{1,2}:)|\*{1,2}[^*\n]{1,60}\.\*{1,2}(?=[ \t]+\S)|[\p{L}\p{N}][\p{L}\p{N}'’/-]*(?:[ \t]+[\p{L}\p{N}][\p{L}\p{N}'’/-]*){0,3}:)(?=\s|$)/u;
const codeLabel = /^\s*(?:[-+*]|\d{1,9}[.)])?\s*(`+)([^`\n]{1,80})\1[ \t]*:(?=\s|$)/u;
const workVerbs =
	"checked|ran|re-ran|verified|read|searched|inspected|confirmed|tested|reviewed|looked|compared|traced|scanned|measured|probed|opened|loaded|grepped|audited";
const work = new RegExp(`^(?:I|we)\\s+(?:${workVerbs})\\b`, "iu");
// A bare “read” is also an instruction, unlike the other verb forms.
const bareWork = new RegExp(`^(?:${workVerbs.replace("|read|", "|")})\\b`, "iu");
// A fraction reads as a check result when both numbers match, such as 9/9, or when a check word stands beside
// it, such as 129/130 pass. Other ratios, such as 90/402 failed calls, are measurements.
const checkAfter = "(?:pass(?:ed|es|ing)?|green|ok|skipped|tests?|checks?|suites?|probes?)";
const checkBefore = "(?:tests?|checks?|suites?|probes?|lint|typecheck)";
const fraction = String.raw`(?<![\d/.])\b(?:(\d+)\/\1|\d+\/\d+(?=\b(?![\d/]|\.\d)[^.!?;\n]{0,24}\b${checkAfter}\b)|(?<=\b${checkBefore}\b[^.!?;\n]{0,24})\d+\/\d+)\b(?![\d/]|\.\d)`;
const record = new RegExp(
	String.raw`${fraction}|\b(?:\d+\s+tests?|0\s+failures|(?:lint|typecheck)\s+clean|all\s+green|(?:[\p{L}\p{N}_'-]+\s+){0,3}(?:tests?|checks?|builds?|suites?|probes?|lint|typecheck)\s+pass(?:ed)?)\b`,
	"iu",
);
const openingRecord = new RegExp(`^(?:${record.source})`, "iu");
const signpost =
	/^(?:(?:this|in this)\s+(?:document|report|note|page)|(?:here|below)\s+(?:is|are)|the\s+following)\b/iu;
const negation =
	/(?:\bnot\s+(?:just\s+)?[^.!?;,:]{1,100},\s+but\s+\S|\bisn['’]t\s+[^.!?;,:]{1,100},\s+it['’]s\s+\S|\bis\s+not\s+[^.!?;,:]{1,100};\s+it\s+is\s+\S|^rather\s+than\s+[^.!?;,:]{1,100},\s+\S)/iu;
const words = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const sentence = /\S(?:[^.!?]|[.!?](?![\s\p{Pe}\p{Pf}"']|$))*(?:[.!?]+[\p{Pe}\p{Pf}"']*)?/gu;
const leadingMarks = /^[*_~]+/u;

const repair: Record<Rule, string> = {
	dashes:
		"Join the clauses with ordinary words or split them into sentences. Do not swap the dash for other punctuation.",
	escapedBreaks: "The text contains a literal \\n, \\r or \\t sequence. Send real line breaks or tabs.",
	phrases: "Remove the stock phrase and state the point directly.",
	labelLines: "Write the point as a sentence instead of announcing it with a label.",
	coinages:
		"Name each thing in ordinary words. A term made up for the document stays made up when you remove its hyphen or put it in backticks. Put an exact name that exists outside the document, such as a command, package, header or file, in backticks. Inline code has its own limit, so leave out the names the reader does not need.",
	identifiers:
		"Leave out the paths, hashes and identifiers that the reader does not need. Put each one that the reader needs in backticks and say what it is. Inline code has its own limit.",
	codeSpans:
		"Keep inline code only for text the reader must type or match, and say what it is. Leave out the names the reader does not need, and write ordinary words without backticks.",
	processNarration:
		"Say what you found and why it matters. Include a check only if the reader needs it to trust or act on the result.",
	opening: "Start with the answer, the result or the decision.",
	negations: "Say what the thing is.",
};
function excerpt(text: string): string {
	return [...text.slice(0, 240).replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, 120).join("");
}
function phrasePattern(phrases: string[]): RegExp | undefined {
	const alternatives = [...phrases]
		.sort((a, b) => b.length - a.length)
		.map((term) => term.replace(/[.*+?^$(){}|[\]\\]/gu, "\\$&"));
	return alternatives.length
		? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, "giu")
		: undefined;
}

type LineStart = { offset: number; line: number; prose: string; shown: string };
/**
 * Maps an offset in the block text to its line and column. The prose and shown views keep source columns,
 * and the block text collapses their whitespace.
 */
function sourceAt(starts: LineStart[], index: number): { at: number; column: number } {
	let at = 0;
	while (at + 1 < starts.length && starts[at + 1].offset <= index) at++;
	const { offset, prose } = starts[at];
	let column = prose.length - prose.trimStart().length;
	for (let step = offset; step < index && column < prose.length; step++)
		if (/\s/u.test(prose[column])) while (column < prose.length && /\s/u.test(prose[column])) column++;
		else column++;
	return { at, column };
}
const flat = (value: string) => value.replace(/\s+/gu, " ");
const unquote = (value: string) => value.replace(/`+/gu, "");
function* markedLineUnits(text: string, line: number) {
	let marked = false;
	for (const match of text.matchAll(sentence)) {
		const body = match[0].trim().replace(leadingMarks, "");
		const process: boolean =
			work.test(body) || (!marked && (record.test(body) || (match.index === 0 && bareWork.test(body))));
		marked ||= process;
		if (/[\p{L}\p{N}]/u.test(body)) yield { body, line, process };
	}
}
function* tableUnits(text: string, starts: LineStart[], processLines: Set<number>) {
	for (const [index, start] of starts.entries()) {
		const body = text
			.slice(start.offset, starts[index + 1]?.offset)
			.trim()
			.replace(leadingMarks, "");
		yield { body, line: start.line, process: processLines.has(start.line) };
	}
}
function* proseUnits(text: string, starts: LineStart[], processLines: Set<number>) {
	let index = 0;
	while (index < starts.length) {
		const start = starts[index];
		if (processLines.has(start.line)) {
			const body = text
				.slice(start.offset, starts[index + 1]?.offset)
				.trim()
				.replace(leadingMarks, "");
			yield* markedLineUnits(body, start.line);
			index++;
			continue;
		}
		let end = index + 1;
		while (end < starts.length && !processLines.has(starts[end].line)) end++;
		for (const match of text.slice(start.offset, starts[end]?.offset).trimEnd().matchAll(sentence)) {
			const body = match[0].trim().replace(leadingMarks, "");
			if (!/[\p{L}\p{N}]/u.test(body)) continue;
			while (index + 1 < end && starts[index + 1].offset <= start.offset + match.index) index++;
			yield { body, line: starts[index].line, process: work.test(body) };
		}
		index = end;
	}
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Visit source once while collecting evidence with shared line offsets and denominators.
export function checkWriting(source: string, config: CheckOverrides = {}, lexicon?: ReadonlySet<string>): Finding[] {
	const rules = effectiveRules(config);
	const flags = new Map<Rule, Finding>();
	function add(rule: Rule, line: number, text: string) {
		if (!rules[rule].enabled) return;
		let finding = flags.get(rule);
		if (!finding) {
			finding = { rule, count: 0, limit: rules[rule].limit, examples: [] };
			flags.set(rule, finding);
		}
		finding.count++;
		if (finding.examples.length < MAX_EXAMPLES) finding.examples.push({ line, text: excerpt(text) });
	}
	const phrases = rules.phrases.enabled ? phrasePattern(rules.phrases.phrases) : undefined;
	const extraAllowed = new Set(rules.coinages.allow.map((term) => term.trim().toLowerCase()));
	const coins = new Map<string, { line: number; text: string }>();
	// Terms that the document also uses as names: in code lines, inside longer code spans or in marked tokens.
	// A span that holds only the term is no evidence, so backticks around one mention do not clear a coined term.
	const names = new Set<string>();
	const collectNames = (code: string, whole: boolean) => {
		const body = code.replace(/^`+|`+$/gu, "").trim();
		for (const match of body.matchAll(codeCompound))
			if (whole || match[0].length < body.length) names.add(match[0].toLowerCase());
	};
	let totalWords = 0,
		totalSentences = 0,
		firstParagraph = true;
	for (const block of proseBlocks(source, rules.coinages.enabled ? (line) => collectNames(line, true) : undefined)) {
		const processLines = new Set<number>();
		const running = block.kind === "paragraph" || block.kind === "list";
		for (const code of block.codeSpans) {
			if (rules.coinages.enabled) collectNames(code.text, false);
			if (running && !dataSpan(code.text)) add("codeSpans", code.line, code.text);
		}
		let text = "";
		const starts: LineStart[] = [];
		for (const { line, text: prose, raw, shown } of block.lines) {
			if (running) {
				const plainLabel = label.exec(prose.trimStart());
				const inlineLabel = codeLabel.exec(raw);
				if (plainLabel) {
					const lead = prose.length - prose.trimStart().length;
					add("labelLines", line, flat(shown.slice(lead, lead + plainLabel[0].length)).trim());
				} else if (
					inlineLabel &&
					block.codeSpans.some((code) => code.line === line && inlineLabel[0].includes(code.text))
				)
					add("labelLines", line, inlineLabel[0].trim());
			}
			const clean = prose.trim().replace(/\s+/gu, " ");
			if (!clean) continue;
			if (rules.escapedBreaks.enabled)
				for (const match of clean.matchAll(/\\[nrt]/gu))
					add("escapedBreaks", line, clean.slice(Math.max(0, match.index - 24), match.index + 26));
			if (rules.identifiers.enabled)
				for (const match of clean.replace(pathOrUrl, " ").matchAll(id)) add("identifiers", line, match[0]);
			if (rules.coinages.enabled) {
				const plain = clean.replace(pathOrUrl, " ");
				for (const match of plain.matchAll(compound)) {
					const key = match[0].toLowerCase();
					const from = plain.lastIndexOf(" ", match.index) + 1;
					const to = plain.indexOf(" ", match.index);
					const token = plain.slice(from, to < 0 ? undefined : to).replace(tokenMarks, "");
					if (identifierToken.test(token)) names.add(key);
					else if (!coins.has(key) && !extraAllowed.has(key) && !lexicon?.has(key) && !ordinaryCompound(match[0]))
						coins.set(key, { line, text: match[0] });
				}
			}
			if (
				block.kind !== "heading" &&
				(bareWork.test(clean.replace(leadingMarks, "").trimStart()) || record.test(clean))
			)
				processLines.add(line);
			starts.push({ offset: text.length, line, prose, shown });
			text += `${clean} `;
		}
		if (!text) continue;
		let current = 0;
		const lineAt = (offset: number) => {
			while (current + 1 < starts.length && starts[current + 1].offset <= offset) current++;
			return starts[current].line;
		};
		if (rules.dashes.enabled) {
			const shownBlock = starts.map((start) => start.shown).join("\n");
			const lineOffsets = [0];
			for (let i = 1; i < starts.length; i++) lineOffsets.push(lineOffsets[i - 1] + starts[i - 1].shown.length + 1);
			for (const match of text.matchAll(dashes)) {
				const mark = match[0].trim();
				const { at, column } = sourceAt(starts, match.index + match[0].indexOf(mark));
				const position = lineOffsets[at] + column;
				const before = flat(shownBlock.slice(Math.max(0, position - 160), position)).slice(-32);
				const after = flat(shownBlock.slice(position + mark.length, position + mark.length + 160)).slice(0, 32);
				const from = Math.max(0, match.index - 32);
				// An en dash beside a digit or month marks a range. Code spans are blank in the block text, so a dash
				// beside code is a range only with range ends on both sides, such as `2024-01-02`–`2024-01-09`.
				if (
					mark === "–" &&
					(rangeLeft.test(text.slice(from, match.index)) ||
						rangeRight.test(text.slice(match.index + 1, match.index + 33)) ||
						(rangeLeftCode.test(unquote(before)) && rangeRightCode.test(unquote(after))))
				)
					continue;
				add("dashes", starts[at].line, `${before}${mark}${after}`.trim());
			}
		}
		current = 0;
		if (phrases) for (const match of text.matchAll(phrases)) add("phrases", lineAt(match.index), match[0]);
		if (rules.codeSpans.enabled && running) for (const _ of text.matchAll(words)) totalWords++;
		if (block.kind === "heading") continue;
		const units =
			block.kind === "table" ? tableUnits(text, starts, processLines) : proseUnits(text, starts, processLines);
		for (const unit of units) {
			const { body, line, process } = unit;
			totalSentences++;
			if (process) add("processNarration", line, body);
			if (block.kind !== "table" && negation.test(body)) add("negations", line, body);
			if (block.kind === "paragraph" && firstParagraph) {
				if (signpost.test(body) || work.test(body) || bareWork.test(body) || openingRecord.test(body))
					add("opening", line, body);
				firstParagraph = false;
			}
		}
	}
	for (const [key, { line, text }] of coins) if (!names.has(key)) add("coinages", line, text);
	for (const finding of flags.values())
		if (finding.count > finding.examples.length) finding.unlisted = finding.count - finding.examples.length;
	const spans = flags.get("codeSpans");
	if (spans) spans.count = totalWords ? (spans.count / totalWords) * 100 : 0;
	return RULE_IDS.flatMap((rule) => {
		const finding = flags.get(rule);
		if (!finding) return [];
		const { count, limit } = finding;
		const hit =
			rule === "codeSpans"
				? totalWords >= rules.codeSpans.minWords && count > limit
				: rule === "processNarration"
					? count >= limit && count / totalSentences >= rules.processNarration.share
					: count > limit;
		return hit ? [finding] : [];
	});
}

const findingLabel: Record<Rule, string> = {
	dashes: "Dashes",
	escapedBreaks: "Literal escapes",
	phrases: "Stock phrases",
	labelLines: "Label lines",
	coinages: "Unlisted compounds",
	identifiers: "Bare identifiers",
	codeSpans: "Inline code spans",
	processNarration: "Work notes and check results",
	opening: "Opening",
	negations: "Contrasts that start with what it is not",
};

function listed(examples: CheckExample[]): string {
	const groups: string[] = [];
	let previous: number | undefined;
	for (const { line, text } of examples) {
		if (line === previous) groups[groups.length - 1] += `, ${JSON.stringify(text)}`;
		else groups.push(`Line ${line}: ${JSON.stringify(text)}`);
		previous = line;
	}
	return groups.join(". ");
}

/** One line per finding lists its passages by source line; the repair follows when requested. */
export function describeFindings(findings: Finding[], reparations: boolean): string[] {
	return findings.flatMap(({ rule, count, limit, examples, unlisted }) => {
		return [
			`${findingLabel[rule]}: ${Number(count.toFixed(3))} found${rule === "codeSpans" ? " per 100 words of prose" : ""}. ${rule === "processNarration" ? "Minimum" : "Limit"}: ${limit}. ${listed(examples)}.${unlisted ? ` ${unlisted} more not listed.` : ""}`,
			...(reparations ? [repair[rule]] : []),
		];
	});
}
