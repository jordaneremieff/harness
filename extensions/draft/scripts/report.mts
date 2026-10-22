// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import type { Finding, Report } from "./analyze.mts";

export interface RenderOptions {
	verbose: boolean;
	quiet: boolean;
	color: boolean;
}

/** Colour only a terminal that wants it: honour NO_COLOR and skip pipes. */
export function useColor(env: Record<string, string | undefined>, isTty: boolean): boolean {
	if (!isTty) return false;
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
	return env.TERM !== "dumb";
}

const BAND_COLOUR: Record<string, string> = { green: "32", amber: "33", red: "31" };

function paint(text: string, code: string | undefined, color: boolean): string {
	return color && code !== undefined ? `\u001B[${code}m${text}\u001B[0m` : text;
}

function findingLine(finding: Finding): string {
	const where = finding.line === undefined ? "-" : `${finding.line}:${finding.column ?? 1}`;
	const file = finding.file === undefined ? "" : `${finding.file} `;
	return `  ${file}${where}  ${finding.rule}  ${finding.message}  [${finding.text}]`;
}

export function renderText(report: Report, options: RenderOptions): string {
	const { score } = report;
	const bandText = score.band ?? "unavailable";
	const bandPainted = paint(bandText, score.band === null ? undefined : BAND_COLOUR[score.band], options.color);
	if (options.quiet) {
		return `sq ${score.sq} band ${bandText} hard ${report.hard.length + report.omitted.hard} scored ${report.scored.length + report.omitted.scored}\n`;
	}
	const lines: string[] = [];
	lines.push(`draft meter ${report.meterVersion} (contract ${report.contract})`);
	const target = report.input.target === undefined ? "" : ` (${report.input.target})`;
	lines.push(
		`input: ${report.input.kind}${target}, ${report.input.words} words, ${report.input.sentences} sentences, ${report.input.lines} lines`,
	);
	lines.push("");
	lines.push(`Hard findings (${report.hard.length + report.omitted.hard})`);
	for (const finding of report.hard) lines.push(findingLine(finding));
	lines.push("");
	lines.push(`Scored findings (${report.scored.length + report.omitted.scored})`);
	for (const finding of report.scored) lines.push(findingLine(finding));
	const omittedRules = Object.entries(report.omitted.byRule);
	if (omittedRules.length > 0) {
		lines.push("");
		lines.push(`Omitted beyond ${report.omitted.perRuleCap} per rule: ${omittedRules.map(([rule, n]) => `${rule} ${n}`).join(", ")}`);
	}
	lines.push("");
	const reliability = score.reliable ? "" : " (fewer words than the reliability floor; no band is given)";
	lines.push(`Score: SQ ${score.sq}, band ${bandPainted}, threshold ${score.threshold}${reliability}`);
	const c = score.components;
	lines.push(
		`  lexical ${c.lexical.value}, geometry ${c.geometry.value}, epistemic ${c.epistemic.value}, laundering ${c.laundering.value}`,
	);
	if (options.verbose) {
		for (const [name, component] of Object.entries(c)) lines.push(`  ${name}: ${JSON.stringify(component.metrics)}`);
		if (report.omitted.skippedFiles.length > 0) lines.push(`  skipped files: ${report.omitted.skippedFiles.join(", ")}`);
	}
	const cal = report.calibration;
	lines.push(`Calibration: ${cal.status}${cal.cohort === null ? "" : `, cohort ${cal.cohort}, n ${cal.n}, ${cal.date ?? "undated"}`}.`);
	lines.push("A clean result is a floor, not acceptance. The meter never rewrites text.");
	return `${lines.join("\n")}\n`;
}
