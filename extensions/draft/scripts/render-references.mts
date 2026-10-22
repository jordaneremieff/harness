#!/usr/bin/env node
// Render the generated reference files from the rule data.
// Usage: node extensions/draft/scripts/render-references.mts [--check] [--help]

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GROUPS, loadRules, type Rule, type RuleSet, termText } from "./rules.mts";

const HELP = `Usage: node extensions/draft/scripts/render-references.mts [--check] [--help]

Write references/lexicon.md, references/findings.md and references/judgement.md from data/rules.json.
  --check   Write nothing. Exit 1 when a generated file differs from the data.
  --help    Show this text.
`;

const GROUP_TITLES: Record<string, string> = {
	lexical: "Lexical",
	geometry: "Geometry",
	epistemic: "Epistemic",
	laundering: "Laundering",
	punctuation: "Punctuation",
	structure: "Structure",
	link: "Links",
	spelling: "Spelling",
	time: "Times",
	commit: "Commit and review text",
};

const BANNER =
	"This file is generated from `data/rules.json` by `scripts/render-references.mts`. Do not edit it by hand: change the data and run the script.";

function title(group: string): string {
	return GROUP_TITLES[group] ?? group;
}

function anchor(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9 -]/g, "")
		.replace(/ /g, "-");
}

function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function code(text: string): string {
	return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function severityText(rule: Rule): string {
	if (rule.severity === "hard") return "hard";
	const base = rule.component === "none" ? "advisory" : `scored, ${rule.component}, weight ${rule.weight}`;
	return rule.strictSeverity === "hard" ? `${base}; hard with --strict-semicolons` : base;
}

function byGroup(set: RuleSet): Array<[string, Rule[]]> {
	return GROUPS.map((group): [string, Rule[]] => [group, set.rules.filter((rule) => rule.group === group)]).filter(
		([, rules]) => rules.length > 0,
	);
}

function toc(groups: Array<[string, Rule[]]>): string {
	return groups.map(([group]) => `- [${title(group)}](#${anchor(title(group))})`).join("\n");
}

export function renderFindings(set: RuleSet): string {
	const groups = byGroup(set);
	const lines: string[] = [
		"# Findings",
		"",
		BANNER,
		"",
		"Every rule the meter can report, with its severity, what it means and one direction for repair. Hard findings are absolute rules. Scored findings feed the weighted score. Advisory findings are reported and carry no weight. Repair above the form: swapping a flagged symbol for a neighbour keeps the same move.",
		"",
		"## Contents",
		"",
		toc(groups),
	];
	for (const [group, rules] of groups) {
		lines.push("", `## ${title(group)}`, "", "| Rule | Severity | Meaning | Repair direction |", "|---|---|---|---|");
		for (const rule of rules) {
			lines.push(`| ${code(rule.id)} | ${cell(severityText(rule))} | ${cell(rule.message)} | ${cell(rule.repair)} |`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function matchSummary(rule: Rule): string[] {
	if (rule.terms !== undefined) return [`Terms: ${rule.terms.map((term) => code(termText(term))).join(", ")}`];
	if (rule.pattern !== undefined) return [`Pattern: ${code(rule.pattern)}`];
	return [`Built-in detector: ${code(rule.detector ?? "")}`];
}

function exemptions(rule: Rule): string[] {
	const out: string[] = [];
	if (rule.twin !== undefined)
		out.push(`Exempt when the hit overlaps: ${rule.twin.map((entry) => code(entry)).join(", ")}`);
	if (rule.context !== undefined)
		out.push(`Exempt when this appears nearby: ${rule.context.map((entry) => code(entry)).join(", ")}`);
	return out;
}

function ruleEntry(rule: Rule): string[] {
	const entry = ["", `### ${rule.id}`, "", `${cell(rule.message)} Severity: ${severityText(rule)}.`, ""];
	const details = [...matchSummary(rule), ...exemptions(rule)];
	entry.push(...details.map((line) => `- ${line}`));
	return entry;
}

export function renderLexicon(set: RuleSet): string {
	const groups = byGroup(set)
		.map(([group, rules]): [string, Rule[]] => [group, rules.filter((rule) => rule.detector === undefined)])
		.filter(([, rules]) => rules.length > 0);
	const lines: string[] = [
		"# Lexicon",
		"",
		BANNER,
		"",
		"The vocabulary and phrase rules, with their exemptions. A listed word is not banned. The meter judges density: one hit counts little and a cluster dominates. An exemption marks an ordinary technical sense, for example a test harness or dynamic dispatch. Terms ending in `*` match any word ending. Patterns are regular expressions.",
		"",
		"## Contents",
		"",
		toc(groups),
	];
	for (const [group, rules] of groups) {
		lines.push("", `## ${title(group)}`);
		for (const rule of rules) lines.push(...ruleEntry(rule));
	}
	return `${lines.join("\n")}\n`;
}

export function renderJudgement(set: RuleSet): string {
	const lines: string[] = [
		"# Judgement",
		"",
		BANNER,
		"",
		"What the meter cannot detect. These failures need a reader's judgement. A clean meter result says nothing about them. Each item names the procedure step in SKILL.md, or the reference, that handles it.",
		"",
		"## Contents",
		"",
		set.judgement.map((item) => `- [${item.title}](#${anchor(item.title)})`).join("\n"),
	];
	for (const item of set.judgement) {
		lines.push(
			"",
			`## ${item.title}`,
			"",
			item.description,
			"",
			`Repair direction: ${item.repair}`,
			"",
			`Handled by: ${item.handledBy}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

const TARGETS = [
	{ name: "judgement.md", render: renderJudgement },
	{ name: "findings.md", render: renderFindings },
	{ name: "lexicon.md", render: renderLexicon },
];

function targetPath(name: string): string {
	return fileURLToPath(new URL(`../references/${name}`, import.meta.url));
}

/** Names of generated files whose content differs from what the data produces. */
export function driftedFiles(set: RuleSet): string[] {
	return TARGETS.filter((target) => {
		try {
			return readFileSync(targetPath(target.name), "utf8") !== target.render(set);
		} catch {
			return true;
		}
	}).map((target) => target.name);
}

function main(argv: string[]): number {
	if (argv.includes("--help")) {
		process.stdout.write(HELP);
		return 0;
	}
	const set = loadRules();
	if (argv.includes("--check")) {
		const drifted = driftedFiles(set);
		if (drifted.length > 0) process.stderr.write(`generated references differ from the data: ${drifted.join(", ")}\n`);
		return drifted.length > 0 ? 1 : 0;
	}
	for (const target of TARGETS) writeFileSync(targetPath(target.name), target.render(set));
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
