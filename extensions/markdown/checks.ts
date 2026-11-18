import { effectiveRules, RULE_IDS, type CheckOverrides, type Rule } from "./check-rules.ts";
import { proseBlocks } from "./prose-source.ts";

export type CheckExample = { line: number; text: string };
export type Finding = { rule: Rule; count: number; limit: number; examples: CheckExample[] };
const allowed = new Set("well-known up-to-date follow-up built-in real-time long-term short-term one-off e-mail re-run set-up sign-in read-only open-source third-party high-level low-level so-called self-contained hands-on stand-in close-out".split(" "));
const countedCompound = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)-/u;
const rangeMonth = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|present)";
const rangeLeft = new RegExp(`(?:\\d|\\b${rangeMonth}\\.?) *$`, "iu");
const rangeRight = new RegExp(`^ *(?:\\d|${rangeMonth}(?![-\\p{L}\\p{N}_]))`, "iu");
const compound = /(?<![\p{L}\p{N}_-])\p{L}+(?:-\p{L}+)+(?![\p{L}\p{N}_-])/gu;
const dashes = /[—–]|(?<=[\p{L}\p{N}])[\t ]+-[\t ]+(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])--(?=[\p{L}\p{N}])/gu;
const id = /(?<![\p{L}\p{N}_/])(?:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|(?:~\/|\/)[\p{L}\p{N}_.-][\p{L}\p{N}_.@%~+/-]*|(?=[a-f\d]{0,39}\d)(?=[a-f\d]{0,39}[a-f])[a-f\d]{7,40})(?![\p{L}\p{N}_/])/giu;
const pathOrUrl = /(?<![a-z\d+.-])(?:[a-z][a-z\d+.-]{0,31}:\/\/|www\.)[^\s<>]+/giu;
const label = /^(?:\*{1,2}[^*:\n]{1,80}(?::\*{1,2}|\*{1,2}:)|\*{1,2}[^*\n]{1,60}\.\*{1,2}(?=[ \t]+\S)|[\p{L}\p{N}][\p{L}\p{N}'’/-]*(?:[ \t]+[\p{L}\p{N}][\p{L}\p{N}'’/-]*){0,3}:)(?=\s|$)/u;
const codeLabel = /^\s*(?:[-+*]|\d{1,9}[.)])?\s*(`+)([^`\n]{1,80})\1[ \t]*:(?=\s|$)/u;
const workVerbs = "checked|ran|re-ran|verified|read|searched|inspected|confirmed|tested|reviewed|looked|compared|traced|scanned|measured|probed|opened|loaded|grepped|audited";
const work = new RegExp(`^(?:I|we)\\s+(?:${workVerbs})\\b`, "iu");
// A bare “read” is also an instruction, unlike the other verb forms.
const bareWork = new RegExp(`^(?:${workVerbs.replace("|read|", "|")})\\b`, "iu");
const record = /(?<![\d/])\b\d+\/\d+\b(?!\/\d)|\b(?:\d+\s+tests?|0\s+failures|(?:lint|typecheck)\s+clean|(?:all\s+tests|checks)\s+pass(?:ed)?|all\s+green|passed)\b/iu;
const openingRecord = new RegExp(`^(?:${record.source})`, "iu");
const signpost = /^(?:(?:this|in this)\s+(?:document|report|note|page)|(?:here|below)\s+(?:is|are)|the\s+following)\b/iu;
const negation = /(?:\bnot\s+(?:just\s+)?[^.!?;,:]{1,100},\s+but\s+\S|\bisn['’]t\s+[^.!?;,:]{1,100},\s+it['’]s\s+\S|\bis\s+not\s+[^.!?;,:]{1,100};\s+it\s+is\s+\S|^rather\s+than\s+[^.!?;,:]{1,100},\s+\S)/iu;
const words = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const sentence = /\S(?:[^.!?]|[.!?](?![\s\p{Pe}\p{Pf}"']|$))*(?:[.!?]+[\p{Pe}\p{Pf}"']*)?/gu;
const leadingMarks = /^[*_~]+/u;

const repair: Record<Rule, string> = {
	dashes: "Join the clauses with ordinary words or split them into sentences. Do not swap the dash for other punctuation.",
	escapedBreaks: "The text contains a literal \\n, \\r or \\t sequence. Send real line breaks or tabs.",
	phrases: "Remove the stock phrase and state the point directly.",
	labelLines: "Write the point as a sentence instead of announcing it with a label.",
	coinages: "Name each thing in ordinary words.",
	identifiers: "Keep an exact name only where the reader needs it to act. Say what it is.",
	codeSpans: "Keep an exact name only where the reader needs it to act. Say what it is.",
	processNarration: "Say what you found and why it matters. Include a check only if the reader needs it to trust or act on the result.",
	opening: "Start with the answer, the result or the decision.",
	negations: "Say what the thing is.",
};
function excerpt(text: string): string {
	return [...text.slice(0, 240).replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, 120).join("");
}
function phrasePattern(phrases: string[]): RegExp | undefined {
	const alternatives = [...phrases].sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^$(){}|[\]\\]/gu, "\\$&"));
	return alternatives.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, "giu") : undefined;
}

type LineStart = { offset: number; line: number };
function* markedLineUnits(text: string, line: number) {
	let marked = false;
	for (const match of text.matchAll(sentence)) {
		const body = match[0].trim().replace(leadingMarks, "");
		const process: boolean = work.test(body) || (!marked && (record.test(body) || (match.index === 0 && bareWork.test(body))));
		marked ||= process;
		if (/[\p{L}\p{N}]/u.test(body)) yield { body, line, process };
	}
}
function* tableUnits(text: string, starts: LineStart[], processLines: Set<number>) {
	for (const [index, start] of starts.entries()) {
		const body = text.slice(start.offset, starts[index + 1]?.offset).trim().replace(leadingMarks, "");
		yield { body, line: start.line, process: processLines.has(start.line) };
	}
}
function* proseUnits(text: string, starts: LineStart[], processLines: Set<number>) {
	let index = 0;
	while (index < starts.length) {
		const start = starts[index];
		if (processLines.has(start.line)) {
			const body = text.slice(start.offset, starts[index + 1]?.offset).trim().replace(leadingMarks, "");
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
		if (!finding) { finding = { rule, count: 0, limit: rules[rule].limit, examples: [] }; flags.set(rule, finding); }
		finding.count++;
		if (finding.examples.length < 3) finding.examples.push({ line, text: excerpt(text) });
	}
	const phrases = rules.phrases.enabled ? phrasePattern(rules.phrases.phrases) : undefined;
	const extraAllowed = new Set(rules.coinages.allow.map((term) => term.trim().toLowerCase()));
	const coins = new Set<string>();
	let totalWords = 0, totalSentences = 0, firstParagraph = true;
	for (const block of proseBlocks(source)) {
		const processLines = new Set<number>();
		for (const code of block.codeSpans) add("codeSpans", code.line, code.text);
		let text = "";
		const starts: LineStart[] = [];
		for (const { line, text: prose, raw } of block.lines) {
			if (block.kind === "paragraph" || block.kind === "list") {
				const plainLabel = label.exec(prose.trimStart());
				const inlineLabel = codeLabel.exec(raw);
				if (plainLabel || (inlineLabel && block.codeSpans.some((code) => code.line === line && inlineLabel[0].includes(code.text)))) add("labelLines", line, (plainLabel ?? inlineLabel)?.[0].trim() ?? "");
			}
			const clean = prose.trim().replace(/\s+/gu, " ");
			if (!clean) continue;
			if (rules.escapedBreaks.enabled) for (const match of clean.matchAll(/\\[nrt]/gu)) add("escapedBreaks", line, clean.slice(Math.max(0, match.index - 24), match.index + 26));
			if (rules.identifiers.enabled) for (const match of clean.replace(pathOrUrl, " ").matchAll(id)) add("identifiers", line, match[0]);
			if (rules.coinages.enabled) for (const match of clean.replace(pathOrUrl, " ").matchAll(compound)) {
				const key = match[0].toLowerCase();
				if (!coins.has(key) && !allowed.has(key) && !countedCompound.test(key) && !extraAllowed.has(key) && !lexicon?.has(key)) { coins.add(key); add("coinages", line, key); }
			}
			if (block.kind !== "heading" && (bareWork.test(clean.replace(leadingMarks, "").trimStart()) || record.test(clean))) processLines.add(line);
			starts.push({ offset: text.length, line });
			text += `${clean} `;
		}
		if (!text) continue;
		let current = 0;
		const lineAt = (offset: number) => {
			while (current + 1 < starts.length && starts[current + 1].offset <= offset) current++;
			return starts[current].line;
		};
		if (rules.dashes.enabled) for (const match of text.matchAll(dashes)) {
			const from = Math.max(0, match.index - 32);
			if (match[0] === "–" && (rangeLeft.test(text.slice(from, match.index)) || rangeRight.test(text.slice(match.index + 1, match.index + 33)))) continue;
			add("dashes", lineAt(match.index), text.slice(from, match.index + match[0].length + 32).trim());
		}
		current = 0;
		if (phrases) for (const match of text.matchAll(phrases)) add("phrases", lineAt(match.index), match[0]);
		if (rules.codeSpans.enabled) for (const _ of text.matchAll(words)) totalWords++;
		if (block.kind === "heading") continue;
		const units = block.kind === "table" ? tableUnits(text, starts, processLines) : proseUnits(text, starts, processLines);
		for (const unit of units) {
			const { body, line, process } = unit;
			totalSentences++;
			if (process) add("processNarration", line, body);
			if (block.kind !== "table" && negation.test(body)) add("negations", line, body);
			if (block.kind === "paragraph" && firstParagraph) {
				if (signpost.test(body) || work.test(body) || bareWork.test(body) || openingRecord.test(body)) add("opening", line, body);
				firstParagraph = false;
			}
		}
	}
	const spans = flags.get("codeSpans");
	if (spans) spans.count = totalWords ? (spans.count / totalWords) * 100 : 0;
	return RULE_IDS.flatMap((rule) => {
		const finding = flags.get(rule);
		if (!finding) return [];
		const { count, limit } = finding;
		const hit = rule === "codeSpans" ? totalWords >= rules.codeSpans.minWords && count > limit
			: rule === "processNarration" ? count >= limit && count / totalSentences >= rules.processNarration.share
				: count > limit;
		return hit ? [finding] : [];
	});
}

const findingLabel: Record<Rule, string> = {
	dashes: "Dashes", escapedBreaks: "Literal escapes", phrases: "Stock phrases", labelLines: "Label lines",
	coinages: "Unlisted compounds", identifiers: "Bare identifiers", codeSpans: "Inline code spans",
	processNarration: "Work notes and check results", opening: "Opening", negations: "Contrasts that start with what it is not",
};

export function describeFindings(findings: Finding[], reparations: boolean): string[] {
	return findings.flatMap(({ rule, count, limit, examples }) => [
		`${findingLabel[rule]}: ${Number(count.toFixed(3))} found${rule === "codeSpans" ? " per 100 words" : ""}. ${rule === "processNarration" ? "Minimum" : "Limit"}: ${limit}. ${examples.map(({ line, text }) => `Line ${line}: ${JSON.stringify(text)}`).join(". ")}`,
		...(reparations ? [repair[rule]] : []),
	]);
}
