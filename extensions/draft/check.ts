import type { Finding, Report as MeterReport } from "./scripts/analyze.mts";
import { runMeter } from "./meter.ts";
import type { Band, DraftSettings } from "./settings.ts";

/** What one reply check decides. The caller owns delivery and the loop guard. */
export type CheckOutcome =
	| { kind: "skip" }
	| { kind: "clean" }
	| { kind: "repair"; text: string }
	| { kind: "unavailable"; reason: "failed"; text: string };

export type CheckConfig = Pick<DraftSettings, "maxChars" | "notifyBand" | "minScoredFindings" | "maxFindings">;

/** First line of every findings message; a repair pass is recognised by it. */
export const FINDINGS_HEADER = "The prose meter found problems in your reply.";

const BAND_RANK: Record<Band, number> = { green: 0, amber: 1, red: 2 };
const MAX_MESSAGE = 160;

function oneLine(text: string, limit = MAX_MESSAGE): string {
	const flat = text
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * True when the report has a hard finding, at least `minScoredFindings` scored
 * findings, or a reliable score at or above the notify band. Short replies have
 * no reliable band, so the scored-finding count is the trigger for them.
 */
export function needsRepair(report: MeterReport, notifyBand: Band, minScoredFindings: number): boolean {
	if (report.hard.length > 0 || report.omitted.hard > 0) return true;
	if (report.scored.length + report.omitted.scored >= minScoredFindings) return true;
	const { band, reliable } = report.score;
	return reliable && band !== null && BAND_RANK[band] >= BAND_RANK[notifyBand];
}

function listFinding(finding: Finding): string {
	const where = finding.line === undefined ? "" : ` line ${finding.line}`;
	const quoted = finding.text ? ` "${oneLine(finding.text, 40)}"` : "";
	return `- ${oneLine(finding.rule, 80)}${where}${quoted}: ${oneLine(finding.message)}`;
}

export function repairText(report: MeterReport, maxFindings: number): string {
	const hardTotal = report.hard.length + report.omitted.hard;
	const listed = [...report.hard, ...report.scored].slice(0, maxFindings);
	const lines = [FINDINGS_HEADER];
	if (hardTotal > 0) lines.push(`Hard findings: ${hardTotal}. Fix every one.`);
	lines.push(...listed.map(listFinding));
	const unlisted = hardTotal + report.scored.length + report.omitted.scored - listed.length;
	if (unlisted > 0) lines.push(`${unlisted} more not listed.`);
	const { band, sq, reliable } = report.score;
	let score =
		reliable && band !== null
			? `Score ${Math.round(sq)}, band ${band}.`
			: "Score not reliable for text this short; the scored findings above still count.";
	const { calibration } = report;
	if (calibration?.cohort) {
		const date = calibration.date ? `, ${calibration.date}` : "";
		score += ` Calibration: ${calibration.status}, cohort ${oneLine(calibration.cohort, 120)} (n=${calibration.n}${date}).`;
	}
	lines.push(score);
	lines.push(
		"Repair the reply above the token level: change sentence structure and claim order, not single words or symbols. Keep every claim. Do not swap one tell for its neighbour. Do not narrate the repair. Send the repaired reply as your answer.",
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
	if (!needsRepair(result.report, config.notifyBand, config.minScoredFindings)) return { kind: "clean" };
	return { kind: "repair", text: repairText(result.report, config.maxFindings) };
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
