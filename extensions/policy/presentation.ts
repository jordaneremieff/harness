/** Terminal cards for the policy tools: the request at a glance and bounded outcome summaries. */
import {
	type AgentToolResult,
	keyText,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

const RESULT_DISPLAY_BYTES = 32_000;
const PREVIEW_LIMIT = 200;

/** Escape terminal controls, C1 bytes, and format characters for a single-line preview. */
function escapeControls(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}]/gu, (character) => {
		if (character === "\n") return character;
		const code = character.codePointAt(0) ?? 0;
		return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
	});
}

interface CardContext {
	expanded: boolean;
	isError: boolean;
	args?: unknown;
	lastComponent?: Component;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringField(value: unknown, key: string): string {
	const field = asRecord(value)[key];
	return typeof field === "string" ? field : "";
}

/** Controls escape to text, whitespace collapses, and the value clips with an ellipsis. */
function clip(value: string, limit: number): string {
	const end = Math.min(value.length, limit);
	const bounded = value.slice(0, /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") ? end - 1 : end);
	return bounded.length < value.length ? `${bounded}…` : value;
}

function displayPreview(value: string, limit: number): string {
	return clip(escapeControls(value).replace(/\s+/gu, " ").trim(), limit) || "(empty)";
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** The first output line that carries information; a lone JSON brace carries none. */
function firstMeaningfulLine(output: string): string {
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (!lines.length) return "";
	return lines[0] === "{" || lines[0] === "[" ? (lines[1] ?? "") : lines[0];
}

function parseJsonOutput(output: string): Record<string, unknown> | undefined {
	if (!output.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(output);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function textComponent(text: string, previous?: Component): Text {
	const component = previous instanceof Text ? previous : new Text("", 0, 0);
	component.setText(text);
	return component;
}

function expansionHint(subject: string): string {
	const key = keyText("app.tools.expand");
	return key ? `${key} to expand ${subject}` : `Expand for full ${subject}`;
}

function boundedDisplay(value: string): string {
	const escaped = escapeControls(value);
	const prefix = clip(escaped, RESULT_DISPLAY_BYTES);
	return prefix.length < escaped.length
		? `${prefix}\n[Display limit. The full text remains in the native tool history.]`
		: escaped;
}

function expandedArguments(args: Record<string, unknown>, theme: Theme): string {
	return theme.fg("toolOutput", boundedDisplay(JSON.stringify(args, null, 2) ?? "(none)"));
}

function count(noun: string, value: number): string {
	return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/** Check leads state admission exactly; diagnostics count without replacing the verdict. */
function checkLead(output: string): string {
	const parsed = parseJsonOutput(output);
	if (parsed?.check !== true || typeof parsed.admitted !== "boolean") return "";
	const diagnostics = Array.isArray(parsed.diagnostics) ? parsed.diagnostics.map(asRecord) : [];
	const errors = diagnostics.filter((entry) => entry.severity === "error").length;
	const warnings = diagnostics.filter((entry) => entry.severity === "warning").length;
	const parts = [parsed.admitted ? "admitted" : "not admitted"];
	if (errors > 0) parts.push(count("error", errors));
	if (warnings > 0) parts.push(count("warning", warnings));
	if (errors === 0 && warnings === 0) parts.push("no diagnostics");
	return `check: ${parts.join(" · ")}`;
}

/** Preview leads state the simulated decision and the rules that caused it. */
function stringIds(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

function correctionIds(value: unknown): string[] {
	return Array.isArray(value)
		? value.map((entry) => stringField(entry, "id")).filter((id) => id.length > 0)
		: [];
}

function previewDecisionPhrase(
	denied: boolean,
	wouldCorrectInput: boolean,
	resultCorrected: boolean,
	matches: string[],
	corrections: string[],
): string {
	if (denied) return matches.length > 0 ? `denied by ${matches.join(", ")}` : "denied";
	if (wouldCorrectInput) {
		const ids = corrections.length > 0 ? corrections : matches;
		return ids.length > 0 ? `input corrected by ${ids.join(", ")}` : "input corrected";
	}
	return resultCorrected ? "result corrected" : "allowed";
}

function previewLead(output: string): string {
	const parsed = parseJsonOutput(output);
	const decision = asRecord(parsed?.decision);
	if (parsed?.preview !== true || typeof decision.denied !== "boolean") return "";
	const input = asRecord(parsed.input);
	const parts = [
		previewDecisionPhrase(
			decision.denied === true,
			parsed.wouldCorrectInput === true,
			decision.resultCorrected === true,
			stringIds(input.matches),
			correctionIds(input.corrections),
		),
	];
	if (typeof parsed.nonMatchingRules === "number" && parsed.nonMatchingRules > 0)
		parts.push(count("non-matching rule", parsed.nonMatchingRules));
	return displayPreview(`preview: ${parts.join(" · ")}`, 200);
}

/** The selected rule's identity, state, and effect from the rules listing. */
function selectedRuleLead(output: string): string {
	const lines = output.split("\n");
	const start = lines.findIndex((line) => line.trim() === "RULES");
	if (start === -1) return "";
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index].trim();
		if (line === "") continue;
		if (line.startsWith("PENDING PROPOSALS")) return "";
		const fields = line.split(" | ").map((field) => field.trim());
		const id = fields[0] ?? "";
		const state = fields.find((field) => field.startsWith("state="))?.slice(6) ?? "";
		const effect = fields.find((field) => field.startsWith("effect="))?.slice(7) ?? "";
		const lead = [id, state, effect].filter(Boolean).join(" · ");
		return lead ? displayPreview(lead, 120) : "";
	}
	return "";
}

/** JSON views summarize their top-level fields, with a nested status value when present. */
function jsonLead(output: string): string {
	const parsed = parseJsonOutput(output);
	if (!parsed) return "";
	const fields = Object.entries(parsed).map(([field, value]) => {
		const status = asRecord(value).status;
		return typeof status === "string" && status ? `${field} ${status}` : field;
	});
	return fields.length > 0 ? displayPreview(fields.join(" · "), 96) : "";
}

function storeLead(details: Record<string, unknown>): string {
	if (typeof details.rules !== "number" || typeof details.pending !== "number") return "";
	return `${count("rule", details.rules)} · ${count("pending proposal", details.pending)}`;
}

function degradedSuffix(details: Record<string, unknown>, theme: Theme): string {
	return details.ruleStoreDegraded === true ? theme.fg("warning", " · rule store degraded") : "";
}

function inspectionQualifier(view: string, args: Record<string, unknown>): string {
	if (view === "check") {
		const draft = asRecord(args.draft);
		const parts: string[] = [];
		const operation = stringField(draft, "operation");
		const id = stringField(draft, "id");
		parts.push(operation ? `draft ${displayPreview(`${operation} ${id}`.trim(), 80)}` : "draft pending");
		const effect = stringField(args, "effect");
		if (effect) parts.push(`effect ${displayPreview(effect, 12)}`);
		parts.push(Array.isArray(args.cases) ? count("case", args.cases.length) : "no cases");
		return parts.join(" · ");
	}
	if (view === "preview") {
		const tool = stringField(args, "tool");
		const parts = [tool ? `tool ${displayPreview(tool, 80)}` : "tool pending"];
		parts.push(count("input key", Object.keys(asRecord(args.input)).length));
		parts.push(args.result === undefined ? "no result replay" : "result replayed");
		return parts.join(" · ");
	}
	return "";
}

function authoringForm(args: Record<string, unknown>): string {
	if (typeof args.predicate === "string") return `predicate ${displayPreview(args.predicate, 60)}`;
	if (args.program !== undefined) return "facts/v1 program";
	const match = asRecord(args.match);
	if (Object.keys(match).length === 0) return "";
	const cli = asRecord(match.cli);
	if (Object.keys(cli).length > 0)
		return `${displayPreview(stringField(match, "command"), 40) || "command"} ${Array.isArray(cli.subcommand) ? cli.subcommand.join(" ") : ""} cli match`.trim();
	const command = stringField(match, "command");
	return command ? `${displayPreview(command, 40)} command match` : "";
}

function proposalQualifier(args: Record<string, unknown>, operation: string): string {
	if (operation !== "add" && operation !== "replace") return "";
	const parts: string[] = [];
	const authority = stringField(args, "authority");
	if (authority) parts.push(`authority ${displayPreview(authority, 20)}`);
	const form = authoringForm(args);
	if (form) parts.push(form);
	if (operation === "replace") {
		const revision = stringField(args, "expectedRevision");
		parts.push(revision ? `expected revision ${displayPreview(revision, 16)}` : "expected revision pending");
	}
	return parts.join(" · ");
}

/** The call card identifies the inspection; hidden arguments stay behind expansion. */
export function renderRulesCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = asRecord(value);
	const view = stringField(args, "view") || "rules";
	let heading = theme.fg("toolTitle", theme.bold("policy_rules"));
	heading += theme.fg("accent", ` · ${displayPreview(view, 24)}`);
	const id = stringField(args, "id");
	if (id) heading += theme.fg("accent", ` · ${displayPreview(id, 100)}`);
	const lines = [heading];
	const qualifier = inspectionQualifier(view, args);
	if (context.expanded) lines.push(expandedArguments(args, theme));
	else if (qualifier) lines.push(theme.fg("dim", `${qualifier} · ${expansionHint("arguments")}`));
	return textComponent(lines.join("\n"), context.lastComponent);
}

interface Outcome {
	lead: string;
	color: Parameters<Theme["fg"]>[0];
}

function specificLead(view: string, output: string): Outcome | undefined {
	if (view === "check") {
		const lead = checkLead(output);
		if (!lead) return undefined;
		return { lead, color: parseJsonOutput(output)?.admitted === false ? "error" : "success" };
	}
	if (view === "preview") {
		const lead = previewLead(output);
		if (!lead) return undefined;
		const decision = asRecord(parseJsonOutput(output)?.decision);
		const warning = decision.denied === true || decision.resultCorrected === true;
		return { lead, color: warning ? "warning" : "success" };
	}
	return undefined;
}

/** The view outcome: admission, simulated decision, selected rule, or field summary. */
function rulesOutcome(
	view: string,
	args: Record<string, unknown>,
	details: Record<string, unknown>,
	output: string,
): Outcome {
	const specific = specificLead(view, output);
	if (specific) return specific;
	if (view === "rules") {
		const lead = stringField(args, "id") ? selectedRuleLead(output) : storeLead(details);
		if (lead) return { lead, color: "success" };
	}
	const json = jsonLead(output);
	if (json) return { lead: json, color: "success" };
	return { lead: displayPreview(firstMeaningfulLine(output) || `${view} view returned`, PREVIEW_LIMIT), color: "success" };
}

/** The result card leads with the view outcome: admission, decision, or store counts. */
export function renderRulesResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (options.isPartial)
		return textComponent(`\n${theme.fg("warning", "Inspecting policy...")}`, context.lastComponent);
	const output = textContent(result);
	if (context.isError) {
		const message = firstMeaningfulLine(output) || "inspection failed";
		return textComponent(`\n${theme.fg("error", `policy_rules: ${displayPreview(message, PREVIEW_LIMIT)}`)}`, context.lastComponent);
	}
	const args = asRecord(context.args);
	const view = stringField(args, "view") || "rules";
	const details = asRecord(result.details);
	const { lead, color } = rulesOutcome(view, args, details, output);
	let text = `\n${theme.fg(color, lead)}${degradedSuffix(details, theme)}`;
	if (options.expanded) text += `\n${theme.fg("toolOutput", boundedDisplay(output))}`;
	else text += `\n${theme.fg("dim", expansionHint("result"))}`;
	return textComponent(text, context.lastComponent);
}

/** The call card names the operation and rule; purpose and reason stay behind expansion. */
export function renderProposeCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = asRecord(value);
	const operation = stringField(args, "operation");
	const id = stringField(args, "id");
	let heading = theme.fg("toolTitle", theme.bold("policy_propose"));
	if (operation) heading += theme.fg("accent", ` · ${displayPreview(operation, 12)}`);
	if (id) heading += theme.fg("accent", ` ${displayPreview(id, 80)}`);
	const lines = [heading];
	if (context.expanded) lines.push(expandedArguments(args, theme));
	else {
		const qualifier = proposalQualifier(args, operation);
		if (qualifier) lines.push(theme.fg("dim", `${qualifier} · ${expansionHint("proposal")}`));
		else if (operation) lines.push(theme.fg("dim", expansionHint("proposal")));
	}
	return textComponent(lines.join("\n"), context.lastComponent);
}

/** The receipt states pending status and revision; approval is never implied. */
export function renderProposeResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (options.isPartial)
		return textComponent(`\n${theme.fg("warning", "Submitting proposal...")}`, context.lastComponent);
	const output = textContent(result);
	if (context.isError) {
		const message = firstMeaningfulLine(output) || "proposal failed";
		return textComponent(`\n${theme.fg("error", `policy_propose: ${displayPreview(message, PREVIEW_LIMIT)}`)}`, context.lastComponent);
	}
	const details = asRecord(result.details);
	const proposalId = stringField(details, "proposalId");
	const revision = stringField(details, "proposalRevision");
	const state = stringField(details, "state") || "pending";
	const lead = proposalId
		? [`proposal ${displayPreview(proposalId, 60)}`, displayPreview(state, 12), revision ? `revision ${displayPreview(revision, 16)}` : ""]
				.filter(Boolean)
				.join(" · ")
		: displayPreview(firstMeaningfulLine(output) || "proposal submitted", PREVIEW_LIMIT);
	let text = `\n${theme.fg("success", lead)}`;
	if (options.expanded)
		text += `\n${theme.fg("dim", "inert until operator approval")}\n${theme.fg("toolOutput", boundedDisplay(output))}`;
	else text += `\n${theme.fg("dim", `inert until operator approval · ${expansionHint("proposal text")}`)}`;
	return textComponent(text, context.lastComponent);
}
