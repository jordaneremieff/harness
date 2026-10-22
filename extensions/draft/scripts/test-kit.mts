// Shared helpers for the draft prose meter tests. The command line entry is meter.mts (run it with --help).
import { type Analyzer, analyzeText, makeAnalyzer, type Report } from "./analyze.mts";
import type { Options } from "./detect.mts";
import type { Kind } from "./extract.mts";
import { loadRules } from "./rules.mts";

const rules = loadRules();

export function analyzerFor(options: Partial<Options> = {}): Analyzer {
	return makeAnalyzer(rules, options);
}

export function run(text: string, kind: Kind = "md", options: Partial<Options> = {}): Report {
	return analyzeText(analyzerFor(options), text, kind);
}

export function ruleIds(report: Report): string[] {
	return [...report.hard, ...report.scored].map((finding) => finding.rule);
}

export function count(report: Report, rule: string): number {
	return ruleIds(report).filter((id) => id === rule).length;
}

export const ALL_OPTIONS: Partial<Options> = { spelling: "au", times: "12h", strictSemicolons: false };

export function filler(words: number): string {
	const base =
		"The scheduler reads the queue and writes the result to disk after each batch finishes. Operators check the log on Monday morning. ";
	const per = base.split(/\s+/).filter(Boolean).length;
	return base.repeat(Math.ceil(words / per));
}
