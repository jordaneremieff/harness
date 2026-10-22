// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import { buildDoc, DEFAULT_OPTIONS, type Doc, detect, type Hit, type Options, restrictToLines } from "./detect.mts";
import { columnOf, extract, type Kind, lineOf, normalizeText } from "./extract.mts";
import { type CalibrationStatus, type CompiledRule, compileRules, type RuleSet, type Severity } from "./rules.mts";
import { type Band, computeScore, countAnchors, type PlacedHit, placeHits, type ScoreReport } from "./score.mts";

export const METER_VERSION = "1.0.0";
export const CONTRACT = 1;
export const PER_RULE_CAP = 50;

export interface Finding {
	rule: string;
	severity: Severity;
	line?: number;
	column?: number;
	text: string;
	message: string;
	file?: string;
}

export interface Report {
	contract: number;
	meterVersion: string;
	input: { kind: Kind | "diff"; words: number; sentences: number; lines: number; target?: string };
	hard: Finding[];
	scored: Finding[];
	score: ScoreReport & { threshold: number };
	calibration: { cohort: string | null; n: number; date: string | null; status: CalibrationStatus };
	omitted: { hard: number; scored: number; perRuleCap: number; byRule: Record<string, number>; skippedFiles: string[] };
}

export interface Analyzer {
	set: RuleSet;
	compiled: CompiledRule[];
	options: Options;
}

export interface DocResult {
	doc: Doc;
	hits: Hit[];
	file?: string;
	/** Maps a 1-based line of the analysed text to the reported line. */
	lineMap?: (line: number) => number;
}

export function makeAnalyzer(set: RuleSet, options: Partial<Options> = {}): Analyzer {
	return { set, compiled: compileRules(set), options: { ...DEFAULT_OPTIONS, ...options } };
}

export function analyzeDocument(
	analyzer: Analyzer,
	input: string,
	kind: Kind,
	keepLines?: ReadonlySet<number>,
): DocResult {
	let ex = extract(input, kind);
	if (keepLines !== undefined) ex = restrictToLines(ex, keepLines);
	const doc = buildDoc(ex);
	const hits = detect(doc, analyzer.compiled, analyzer.options);
	if (keepLines === undefined) return { doc, hits };
	return { doc, hits: hits.filter((hit) => keepLines.has(lineOf(ex.lineStarts, hit.start))) };
}

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

function lineCount(text: string): number {
	const normalized = normalizeText(text);
	if (normalized === "") return 0;
	return normalized.endsWith("\n") ? normalized.split("\n").length - 1 : normalized.split("\n").length;
}

function toFinding(result: DocResult, hit: Hit): Finding {
	const { ex } = result.doc;
	const line = lineOf(ex.lineStarts, hit.start);
	const finding: Finding = {
		rule: hit.rule.id,
		severity: hit.severity,
		line: result.lineMap?.(line) ?? line,
		column: columnOf(ex.lineStarts, hit.start),
		text: clip(hit.text),
		message: hit.rule.message,
	};
	if (result.file !== undefined) finding.file = result.file;
	return finding;
}

function capFindings(findings: Finding[], omitted: Report["omitted"]): Finding[] {
	const seen = new Map<string, number>();
	const kept: Finding[] = [];
	for (const finding of findings) {
		const count = (seen.get(finding.rule) ?? 0) + 1;
		seen.set(finding.rule, count);
		if (count <= PER_RULE_CAP) {
			kept.push(finding);
			continue;
		}
		omitted.byRule[finding.rule] = (omitted.byRule[finding.rule] ?? 0) + 1;
		omitted[finding.severity] += 1;
	}
	return kept;
}

export interface BuildOptions {
	inputKind: Kind | "diff";
	threshold: number;
	target?: string;
	rawLines: number;
	skippedFiles?: string[];
}

export function buildReport(analyzer: Analyzer, results: DocResult[], build: BuildOptions): Report {
	const placed: PlacedHit[] = [];
	const sentenceLengths: number[] = [];
	let words = 0;
	let anchors = 0;
	const hard: Finding[] = [];
	const scored: Finding[] = [];
	for (const result of results) {
		placed.push(
			...placeHits(
				result.doc,
				result.hits.filter((hit) => hit.severity === "scored"),
				words,
			),
		);
		sentenceLengths.push(...result.doc.sentenceLengths);
		words += result.doc.words;
		anchors += countAnchors(result.doc);
		for (const hit of result.hits) (hit.severity === "hard" ? hard : scored).push(toFinding(result, hit));
	}
	const byLocation = (a: Finding, b: Finding): number =>
		(a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0);
	hard.sort(byLocation);
	scored.sort(byLocation);
	const omitted: Report["omitted"] = {
		hard: 0,
		scored: 0,
		perRuleCap: PER_RULE_CAP,
		byRule: {},
		skippedFiles: build.skippedFiles ?? [],
	};
	const score = computeScore({ words, sentenceLengths, anchors, hits: placed }, analyzer.set.scoring);
	const input: Report["input"] = {
		kind: build.inputKind,
		words,
		sentences: sentenceLengths.length,
		lines: build.rawLines,
	};
	if (build.target !== undefined) input.target = build.target;
	return {
		contract: CONTRACT,
		meterVersion: METER_VERSION,
		input,
		hard: capFindings(hard, omitted),
		scored: capFindings(scored, omitted),
		score: { ...score, threshold: build.threshold },
		calibration: { ...analyzer.set.scoring.calibration },
		omitted,
	};
}

export function analyzeText(
	analyzer: Analyzer,
	text: string,
	kind: Kind,
	build: { threshold?: number; target?: string } = {},
): Report {
	const result = analyzeDocument(analyzer, text, kind);
	const buildOptions: BuildOptions = {
		inputKind: kind,
		threshold: build.threshold ?? analyzer.set.scoring.defaultThreshold,
		rawLines: lineCount(text),
	};
	if (build.target !== undefined) buildOptions.target = build.target;
	return buildReport(analyzer, [result], buildOptions);
}

export function exitCodeFor(report: Report): number {
	const hardPresent = report.hard.length + report.omitted.hard > 0;
	const scoreHit = report.score.reliable && report.score.sq >= report.score.threshold;
	return (hardPresent ? 1 : 0) + (scoreHit ? 2 : 0);
}

export type { Band };
