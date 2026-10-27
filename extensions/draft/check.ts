import type { Finding, Report as MeterReport } from "./scripts/analyze.mts";
import { loadRules } from "./scripts/rules.mts";
import { runMeter } from "./meter.ts";
import type { Band, DraftSettings } from "./settings.ts";

/** Facts about one reply check that triggered a repair, kept for later audit and never sent to the model. */
export type CheckRecord = {
	trigger: "hard" | "band";
	hard: number;
	scored: number;
	sq: number;
	band: Band | null;
	reliable: boolean;
	words: number;
	/** Every finding counted per rule, including findings past the listing cap. */
	rules: Record<string, number>;
};

/** What one reply check decides. The caller owns delivery and the loop guard. */
export type CheckOutcome =
	| { kind: "skip" }
	| { kind: "clean" }
	| { kind: "repair"; text: string; record: CheckRecord }
	| { kind: "unavailable"; reason: "failed"; text: string };

export type CheckConfig = Pick<DraftSettings, "maxChars" | "notifyBand" | "maxRules">;

/** First line of every findings message; a repair pass is recognised by it. */
export const FINDINGS_HEADER = "The prose meter found problems in your reply.";

/** System prompt section that carries the reply writing rules. */
export const RULES_SECTION = "draft-rules";

/** Reason given for a tool call blocked while the agent owes a repaired reply. */
export const REPAIR_BLOCK =
	"Tools are unavailable while you repair your reply. Send the repaired reply as text now, without tool calls.";

const BAND_RANK: Record<Band, number> = { green: 0, amber: 1, red: 2 };
const MAX_MESSAGE = 160;
const MAX_LINES_PER_RULE = 8;

function oneLine(text: string, limit = MAX_MESSAGE): string {
	const flat = text
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Hard findings always fail. Otherwise only a reliable score at or past the
 * notify band fails; text too short for a reliable band fails on hard findings alone.
 */
export function needsRepair(report: MeterReport, notifyBand: Band): boolean {
	if (report.hard.length + report.omitted.hard > 0) return true;
	const { band, reliable } = report.score;
	return reliable && band !== null && BAND_RANK[band] >= BAND_RANK[notifyBand];
}

/** One-line verdict appended to an explicit check, using the same gate as the reply check. */
export function verdictText(report: MeterReport, notifyBand: Band): string {
	if (!needsRepair(report, notifyBand))
		return `Verdict: pass. No hard findings and no reliable score at or past the ${notifyBand} band. Do not run the meter again on this text; reread it once for position instead.`;
	return "Verdict: fail. Repair every hard finding and any cluster of scored findings above the token level, then check the repaired text once.";
}

let ruleIndex: Map<string, { message: string; repair: string; severity: string }> | undefined;
function rulesById(): Map<string, { message: string; repair: string; severity: string }> {
	ruleIndex ??= new Map(
		loadRules().rules.map((rule) => [rule.id, { message: rule.message, repair: rule.repair, severity: rule.severity }]),
	);
	return ruleIndex;
}

/**
 * Hard prose rules as writing instructions for the system prompt, so a reply
 * avoids the findings that would trigger a repair. Commit-message rules apply
 * only to explicit commit checks and stay out of chat guidance.
 */
export function replyRulesText(): string {
	const lines = [...rulesById()]
		.filter(([id, rule]) => rule.severity === "hard" && !id.startsWith("commit."))
		.map(([, rule]) => `- Avoid: ${rule.message} Instead: ${rule.repair}`);
	return [
		"A prose meter checks each final reply to the operator. Any of these findings makes you write the reply a second time, and the operator reads both versions. Write the reply without them the first time:",
		...lines,
	].join("\n");
}

type Group = {
	rule: string;
	severity: Finding["severity"];
	count: number;
	lines: number[];
	/** Some findings of the rule carry no listed line because the report capped them. */
	unlisted: boolean;
	message: string;
};

function groupFindings(report: MeterReport, findings: readonly Finding[]): Group[] {
	const groups = new Map<string, Group>();
	for (const finding of findings) {
		const group = groups.get(finding.rule) ?? {
			rule: finding.rule,
			severity: finding.severity,
			count: report.omitted.byRule[finding.rule] ?? 0,
			lines: [],
			unlisted: (report.omitted.byRule[finding.rule] ?? 0) > 0,
			message: finding.message,
		};
		group.count += 1;
		if (finding.line !== undefined && !group.lines.includes(finding.line)) group.lines.push(finding.line);
		groups.set(finding.rule, group);
	}
	return [...groups.values()].sort(
		(a, b) => Number(a.severity !== "hard") - Number(b.severity !== "hard") || b.count - a.count,
	);
}

function groupLine(group: Group): string {
	const shown = group.lines.slice(0, MAX_LINES_PER_RULE);
	const more = group.unlisted || group.lines.length > shown.length ? " and more" : "";
	const where = shown.length === 0 ? "" : ` on line${group.lines.length === 1 ? "" : "s"} ${shown.join(", ")}${more}`;
	const repair = rulesById().get(group.rule)?.repair;
	const fix = repair === undefined ? "" : ` Repair: ${oneLine(repair)}`;
	return `- ${oneLine(group.rule, 80)}, ${group.count} time${group.count === 1 ? "" : "s"}${where}: ${oneLine(group.message)}${fix}`;
}

/** Counts per rule across listed and omitted findings. */
export function ruleCounts(report: MeterReport): Record<string, number> {
	const counts: Record<string, number> = { ...report.omitted.byRule };
	for (const finding of [...report.hard, ...report.scored]) counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;
	return counts;
}

export function checkRecord(report: MeterReport): CheckRecord {
	const hard = report.hard.length + report.omitted.hard;
	return {
		trigger: hard > 0 ? "hard" : "band",
		hard,
		scored: report.scored.length + report.omitted.scored,
		sq: Math.round(report.score.sq),
		band: report.score.band,
		reliable: report.score.reliable,
		words: report.input.words,
		rules: ruleCounts(report),
	};
}

/**
 * Findings grouped by rule with every line number, so no rule is hidden by a
 * listing cap. Scored rules appear only when the score itself failed the gate.
 */
export function repairText(report: MeterReport, maxRules: number): string {
	const record = checkRecord(report);
	const groups = groupFindings(report, record.trigger === "hard" ? report.hard : report.scored);
	const listed = groups.slice(0, maxRules);
	const lines = [FINDINGS_HEADER];
	if (record.hard > 0) lines.push(`Hard findings: ${record.hard}. Fix every one.`);
	else lines.push(`The score reached the ${report.score.band} band. Repair the clusters below.`);
	lines.push(...listed.map(groupLine));
	if (groups.length > listed.length) lines.push(`${groups.length - listed.length} more rules not listed.`);
	const { band, sq, reliable } = report.score;
	let score =
		reliable && band !== null ? `Score ${Math.round(sq)}, band ${band}.` : "Score not reliable for text this short.";
	const { calibration } = report;
	if (calibration?.cohort) {
		const date = calibration.date ? `, ${calibration.date}` : "";
		score += ` Calibration: ${calibration.status}, cohort ${oneLine(calibration.cohort, 120)} (n=${calibration.n}${date}).`;
	}
	lines.push(score);
	lines.push(
		"Repair the reply above the token level: change sentence structure and claim order, not single words or symbols. Keep every claim. Do not swap one tell for its neighbour, such as one dash for another. Do not narrate the repair. Send the repaired reply as text only: tool calls are blocked until you do, and no draft tool call is needed.",
	);
	return lines.join("\n");
}

export function unavailableText(_reason: "failed", detail: string): string {
	return `The prose meter check did not run: the meter failed (${oneLine(detail, 120)}). The previous reply was not checked. This notice appears once until the meter works again.`;
}

/** Run the meter on a reply and decide what the agent should hear, if anything. */
export async function checkReply(text: string, config: CheckConfig): Promise<CheckOutcome> {
	const reply = text.slice(0, config.maxChars);
	if (!reply.trim()) return { kind: "skip" };
	const result = runMeter(reply);
	if (!result.ok)
		return { kind: "unavailable", reason: result.reason, text: unavailableText(result.reason, result.detail) };
	if (!needsRepair(result.report, config.notifyBand)) return { kind: "clean" };
	return { kind: "repair", text: repairText(result.report, config.maxRules), record: checkRecord(result.report) };
}

/** Text of the last assistant message in a boundary context, or "" when it has none. */
export function finalReplyText(messages: readonly { role: string; content?: unknown }[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const { content } = message;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.flatMap((part: unknown) => {
				const block = part as { type?: unknown; text?: unknown };
				return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
			})
			.join("\n");
	}
	return "";
}
