import { analyzeText, buildReport, makeAnalyzer, type Report } from "./scripts/analyze.mts";
import { analyzeDiff, parseDiff } from "./scripts/diff.mts";
import { type Kind, normalizeText } from "./scripts/extract.mts";
import { loadRules } from "./scripts/rules.mts";

/** Analyse in process; loading rule data stays inside the checked operation. */
export function measure(text: string, kind: Kind | "diff" = "md", target?: string): Report {
	const analyzer = makeAnalyzer(loadRules());
	const threshold = analyzer.set.scoring.defaultThreshold;
	if (kind !== "diff")
		return analyzeText(analyzer, text, kind, { threshold, ...(target === undefined ? {} : { target }) });
	const diff = analyzeDiff(analyzer, parseDiff(text));
	return buildReport(analyzer, diff.results, {
		inputKind: "diff",
		threshold,
		rawLines: normalizeText(text).split("\n").length,
		skippedFiles: diff.skipped,
		...(target === undefined ? {} : { target }),
	});
}

export function runMeter(text: string): { ok: true; report: Report } | { ok: false; reason: "failed"; detail: string } {
	try {
		return { ok: true, report: measure(text) };
	} catch (error) {
		return { ok: false, reason: "failed", detail: error instanceof Error ? error.message : "analysis error" };
	}
}
