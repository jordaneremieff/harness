import { homedir } from "node:os";
import {
	type AgentToolResult,
	type KeybindingHints,
	type Theme,
	type ToolRenderResultOptions,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Fields = Record<string, unknown>;
type Name = "policy_propose" | "policy_rules" | "policy_approve" | "policy_control";
type Color = Parameters<Theme["fg"]>[0];
interface CardContext extends Partial<KeybindingHints> {
	expanded: boolean;
	isError: boolean;
	args?: unknown;
	state?: { hasResult?: boolean };
}

const EXPAND = "app.tools.expand";
const DISPLAY_LIMIT = 32_000;
const HOME = homedir();
const PRODUCER_TRUNCATION = "\n[policy text truncated]";

function object(value: unknown): Fields {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};
}

function safe(value: string): string {
	return stripTerminalSequences(value).replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""));
}

function line(value: unknown): string {
	return typeof value === "string" ? safe(value).replace(/\s+/gu, " ").trim() : "";
}

function pathSubject(value: unknown): string {
	if (typeof value !== "string") return "";
	return line(value === HOME || value.startsWith(`${HOME}/`) ? `~${value.slice(HOME.length)}` : value);
}

function count(value: number, singular: string, plural = `${singular}s`): string {
	return `${value} ${value === 1 ? singular : plural}`;
}

function listCount(value: unknown, noun: string): string {
	return Array.isArray(value) ? count(value.length, noun) : "";
}

function facts(...values: string[]): string {
	return values.filter(Boolean).join(" · ");
}

function named(label: string, value: unknown): string {
	const text = line(value);
	return text ? `${label} ${text}` : "";
}

function renderAtWidth(draw: (width: number) => string[]): Component {
	let cache: { width: number; rows: string[] } | undefined;
	return {
		render(width) {
			if (cache?.width !== width) cache = { width, rows: draw(width) };
			return cache.rows;
		},
		invalidate() {
			cache = undefined;
		},
	};
}

function clip(text: string, width: number): string {
	return stripTerminalSequences(truncateToWidth(text, width, "…"));
}

function row(text: string, width: number, theme: Theme, color: Color): string {
	return theme.fg(color, clip(text, width));
}

function wrap(text: string, width: number, theme: Theme, color: Color): string[] {
	return text ? truncateToVisualLines(text, Infinity, width).visualLines.map((value) => theme.fg(color, value)) : [];
}

function heading(name: Name, subject: string, width: number, theme: Theme): string {
	const room = width - name.length - 1;
	const title = theme.fg("toolTitle", theme.bold(clip(name, width)));
	return room > 0 && subject ? `${title} ${row(subject, room, theme, "accent")}` : title;
}

function hint(theme: Theme, context: CardContext, width: number): string {
	const key = context.keyText?.(EXPAND);
	const prefix = "... (";
	const plain = `${prefix}${key ? `${key} to expand` : "click to expand"})`;
	if (!key || !context.keyHint || visibleWidth(plain) > width) return row(plain, width, theme, "muted");
	return theme.fg("muted", prefix) + context.keyHint(EXPAND, "to expand") + theme.fg("muted", ")");
}

function bound(text: string): { text: string; limit: string } {
	const clean = safe(text).replaceAll("\t", "   ");
	const chars = Array.from(clean);
	return chars.length <= DISPLAY_LIMIT
		? { text: clean, limit: "" }
		: {
				text: chars.slice(0, DISPLAY_LIMIT).join(""),
				limit: `[Truncated: showing ${DISPLAY_LIMIT} of ${chars.length} characters]`,
			};
}

function argumentText(args: Fields): string {
	return Object.entries(args)
		.map(([key, val]) => {
			const text = typeof val === "string" ? val : (JSON.stringify(val, null, 2) ?? "");
			return `  ${line(key)}: ${text.replaceAll("\n", "\n    ")}`;
		})
		.join("\n");
}

interface Call {
	subject: string;
	facts: string;
	visible: string[];
}

function proposalForm(args: Fields): string {
	const predicate = line(args.predicate);
	if (predicate) return `predicate ${predicate}`;
	if (args.program !== undefined) return "facts/v1 program";
	const match = object(args.match);
	const command = line(match.command);
	if (!command) return "";
	const subcommand = object(match.cli).subcommand;
	return Array.isArray(subcommand)
		? [command, ...subcommand.map(line).filter(Boolean), "CLI match"].join(" ")
		: `${command} command match`;
}

function rulesCall(args: Fields): Call {
	const view = line(args.view) || "rules";
	const id = line(args.id);
	const draft = object(args.draft);
	const target =
		view === "preview"
			? line(args.tool)
			: view === "check"
				? [line(draft.operation), line(draft.id)].filter(Boolean).join(" ")
				: id;
	return {
		subject: [view, target].filter(Boolean).join(" "),
		facts: facts(
			line(args.cursor) ? "next page" : "",
			view === "check"
				? facts(
						named("effect", args.effect),
						Array.isArray(args.cases) && args.cases.length ? count(args.cases.length, "case") : "",
					)
				: "",
			view === "preview"
				? facts(
						Object.keys(object(args.input)).length ? count(Object.keys(object(args.input)).length, "input key") : "",
						args.result !== undefined ? "result replay requested" : "",
					)
				: "",
		),
		visible: ["view", "id", "effect", "tool"],
	};
}

function controlTarget(args: Fields, operation: string): string {
	if (operation === "telemetry") {
		const start = line(args.from) || line(args.since);
		const end = line(args.to) || line(args.until);
		return [start, end].filter(Boolean).join(" to ");
	}
	return (
		line(args.id) ||
		line(args.actionId) ||
		line(args.proposalId) ||
		line(args.selection) ||
		line(args.name) ||
		pathSubject(args.path) ||
		line(object(object(args.artifact).data).name)
	);
}

function describeCall(name: Name, args: Fields): Call {
	if (name === "policy_rules") return rulesCall(args);
	const operation = line(args.operation);
	if (name === "policy_propose") {
		return {
			subject: [operation, line(args.id)].filter(Boolean).join(" "),
			facts: facts(
				named("authority", args.authority),
				proposalForm(args),
				named("expected revision", args.expectedRevision),
			),
			visible: ["operation", "id", "authority", "predicate", "expectedRevision"],
		};
	}
	if (name === "policy_approve") {
		return {
			subject: line(args.proposalId),
			facts: facts(named("effect", args.effect), named("proposal revision", args.proposalRevision)),
			visible: ["proposalId", "effect", "proposalRevision"],
		};
	}
	return {
		subject: [operation, controlTarget(args, operation)].filter(Boolean).join(" "),
		facts: facts(named("effect", args.effect), named("revision", args.revision), line(args.cursor) ? "next page" : ""),
		visible: [
			"operation",
			"id",
			"actionId",
			"proposalId",
			"selection",
			"name",
			"effect",
			"revision",
			"from",
			"to",
			"since",
			"until",
		],
	};
}

function hasExtraArguments(name: Name, call: Call, args: Fields, width: number): boolean {
	return (
		Object.keys(args).some((key) => !call.visible.includes(key)) ||
		(call.subject !== "" && name.length + 1 + visibleWidth(call.subject) > width)
	);
}

function renderCall(name: Name, value: unknown, theme: Theme, context: CardContext): Component {
	const args = object(value);
	const call = describeCall(name, args);
	if (context.state) context.state.hasResult = false;
	const expanded = context.expanded ? bound(argumentText(args)) : undefined;
	return renderAtWidth((width) => {
		const rows = [heading(name, call.subject, width, theme)];
		const hiddenArgs = hasExtraArguments(name, call, args, width);
		if (expanded) {
			rows.push(...wrap(call.facts, width, theme, "muted"));
			if (hiddenArgs) {
				rows.push(...wrap(expanded.text, width, theme, "muted"));
				if (expanded.limit) rows.push(...wrap(expanded.limit, width, theme, "warning"));
			}
		} else if ((call.facts || hiddenArgs) && !context.state?.hasResult && context.keyText?.(EXPAND)) {
			rows.push(hint(theme, context, width));
		}
		return rows;
	});
}

function outputText(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function jsonObject(text: string): Fields {
	if (!text.trimStart().startsWith("{")) return {};
	try {
		return object(JSON.parse(text));
	} catch {
		return {};
	}
}

interface Receipt {
	outcome: string;
	extra?: string;
	limit?: string;
	qualifier?: string;
	summary?: string;
	omitRaw?: boolean;
}

function continuation(name: Name, selection: Fields, cursor: unknown): string {
	return typeof cursor === "string" && cursor ? `Next call: ${name} ${JSON.stringify({ ...selection, cursor })}` : "";
}

function pageNoun(view: string, id: unknown): string {
	if (view === "rules") return "entry";
	if (view === "capabilities") return "configured tool";
	return typeof id === "string" ? "row" : "binding";
}

function pageScope(noun: string, start: number, returned: number, total: number): string {
	const plural = noun === "entry" ? "entries" : `${noun}s`;
	if (returned === 0) return `Returned no ${plural}${total ? ` on this page (${total} total)` : ""}`;
	if (returned === 1) return `Returned ${noun} ${start + 1} of ${total}`;
	return `Returned ${plural} ${start + 1}–${start + returned} of ${total}`;
}

function pageSummary(view: string, details: Fields, json: Fields): string {
	if (view === "rules" && typeof details.rules === "number" && typeof details.pending === "number") {
		return facts(
			details.rules ? count(details.rules, "stored rule") : "",
			details.pending ? count(details.pending, "pending proposal") : "",
		);
	}
	if (view === "capabilities") return named("effective mode", json.effectiveMode);
	return named("binding status", object(json.binding).status);
}

function pageReceipt(view: string, args: Fields, details: Fields, json: Fields): Receipt | undefined {
	const { start, returned, total, nextCursor } = object(details.page);
	if (typeof start !== "number" || typeof returned !== "number" || typeof total !== "number") return undefined;
	if (object(json.binding).status === "missing") {
		return {
			outcome:
				details.ruleStoreDegraded === true || object(json.health).incompleteFinalLine
					? "Named data binding not established."
					: "Named data binding not found in the rule store.",
		};
	}
	const scope = pageScope(pageNoun(view, args.id), start, returned, total);
	const extra = continuation("policy_rules", { view, id: args.id }, nextCursor);
	return { outcome: `${scope}${extra ? "; more follow" : ""}.`, extra, summary: pageSummary(view, details, json) };
}

/** Project decision facts before the model's inspection text is capped. */
export function inspectionFacts(view: string, value: unknown): Fields | undefined {
	const payload = object(value);
	if (view === "check" && payload.check === true && typeof payload.admitted === "boolean") {
		const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics.map(object) : [];
		return {
			admitted: payload.admitted,
			errors: diagnostics.filter((item) => item.severity === "error").length,
			warnings: diagnostics.filter((item) => item.severity === "warning").length,
			caseOutputLimited:
				Array.isArray(payload.cases) && payload.cases.some((item) => typeof object(item).unavailable === "string"),
		};
	}
	const decision = object(payload.decision);
	if (view !== "preview" || payload.preview !== true || typeof decision.denied !== "boolean") return undefined;
	const input = object(payload.input);
	const ids = Array.isArray(input.matches) ? [...new Set(input.matches.filter((id) => typeof id === "string"))] : [];
	return {
		denied: decision.denied,
		correctedInput: decision.correctedInput === true || payload.wouldCorrectInput === true,
		resultCorrected: decision.resultCorrected === true,
		mode: payload.mode,
		matches: ids.length,
		ruleId: ids[0],
		nonMatchingRules: payload.nonMatchingRules,
	};
}

function checkReceipt(details: Fields): Receipt {
	if (typeof details.admitted !== "boolean") return { outcome: "Draft admission not established." };
	const diagnostics = [
		typeof details.errors === "number" && details.errors > 0 && count(details.errors, "error"),
		typeof details.warnings === "number" && details.warnings > 0 && count(details.warnings, "warning"),
	].filter(Boolean);
	return {
		outcome: `Draft ${details.admitted ? "admitted" : "not admitted"}${diagnostics.length ? ` (${diagnostics.join(", ")})` : ""}. No authority changed.`,
		qualifier: details.caseOutputLimited === true ? "Case output is incomplete." : "",
		limit: details.caseOutputLimited === true ? "[Draft case output reached the aggregate bound]" : "",
	};
}

function previewReceipt(details: Fields): Receipt {
	if (typeof details.denied !== "boolean") return { outcome: "Dry-run decision not established." };
	const corrections = [
		details.correctedInput === true ? "input" : "",
		details.resultCorrected === true ? "result" : "",
	].filter(Boolean);
	const decision = details.denied ? "deny" : corrections.length ? `correct ${corrections.join(" and ")}` : "allow";
	const mode = line(details.mode);
	const matching =
		typeof details.matches === "number" && details.matches > 0
			? details.matches === 1 && line(details.ruleId)
				? `matched ${line(details.ruleId)}`
				: count(details.matches, "input match", "input matches")
			: "";
	const nonMatching =
		typeof details.nonMatchingRules === "number" && details.nonMatchingRules > 0
			? count(details.nonMatchingRules, "non-matching rule")
			: "";
	const summary = [matching, nonMatching].filter(Boolean).join(", ");
	return { outcome: `Dry run would ${decision}${mode ? ` in ${mode} mode` : ""}. No simulated tool ran.`, summary };
}

function targetReceipt(target: Fields, json: Fields): Receipt {
	if (target.status === "rule") {
		return { outcome: `Rule ${line(target.id)} is ${line(target.state)} (${line(target.effect)}).` };
	}
	const pendingId = line(target.id) || line(object(json.proposal).id);
	if (pendingId) return { outcome: "Proposal is pending and inert until operator approval.", summary: pendingId };
	return target.status === "missing"
		? { outcome: "No rule or pending proposal found.", omitRaw: true }
		: { outcome: "Rule or proposal state not established." };
}

function explainReceipt(json: Fields): Receipt {
	if (line(json.callId) && Array.isArray(json.records)) {
		return {
			outcome: json.records.length
				? `Found ${count(json.records.length, "recorded observation")} for the call.`
				: "No observation found in the bounded read; the call decision is not established.",
			qualifier: json.partial === true ? "Evidence is partial." : "",
			limit: json.partial === true ? "[Recorded evidence is partial]" : "",
		};
	}
	const id = line(json.id);
	const state = line(json.active);
	return { outcome: id && state ? `Read the program for ${state} rule ${id}.` : "Rule explanation not established." };
}

function inspectionOutcome(view: string, json: Fields): string {
	switch (view) {
		case "health": {
			const authority = line(object(json.authority).status);
			const telemetry = named("telemetry", object(json.telemetry).status);
			return authority
				? `Rule store is ${authority}${telemetry ? `; ${telemetry}` : ""}.`
				: "Policy health not established.";
		}
		case "state": {
			const periods = listCount(json.observationPeriods, "observation period");
			const turn = typeof json.turn === "number" ? ` at turn ${json.turn}` : "";
			return periods ? `Read ${periods}${turn}.` : "Observation state not established.";
		}
		case "catalog": {
			const rules = listCount(json.rules, "bundled rule");
			const id = line(object(json.row).id);
			if (id) return `Read bundled rule ${id}.`;
			return rules ? `Read ${rules} from the bundled catalog.` : "Catalog contents not established.";
		}
		default:
			return "Inspection outcome not established.";
	}
}

function rulesReceipt(args: Fields, details: Fields, output: string): Receipt {
	const view = line(args.view) || "rules";
	const json = jsonObject(output);
	const inspection = object(details.inspection ?? inspectionFacts(view, json));
	const page = pageReceipt(view, args, details, json);
	if (page) return page;
	if (view === "check") return checkReceipt(inspection);
	if (view === "preview") return previewReceipt(inspection);
	if (view === "rules") return targetReceipt(object(details.target), json);
	if (view === "explain") return explainReceipt(json);
	if (view === "authoring") {
		return { outcome: output ? "Read the policy authoring guide." : "Authoring guide not available in the receipt." };
	}
	return { outcome: inspectionOutcome(view, json) };
}

function controlProgress(operation: string): string {
	switch (operation) {
		case "inspect":
			return "Inspecting the policy target…";
		case "actions":
			return "Listing exact actions…";
		case "action-inspect":
			return "Inspecting the exact action…";
		case "mode":
			return "Reading the session mode…";
		case "telemetry":
			return "Reading recorded telemetry…";
		case "import-preview":
			return "Preparing an import preview…";
		case "data-preview":
			return "Preparing a data preview…";
		case "reset-preview":
			return "Preparing a reset preview…";
		default:
			return operation ? "Applying the requested policy control…" : "Waiting for the policy control request…";
	}
}

function modeFact(details: Fields): string {
	const mode = line(details.mode) || line(object(details.binding).mode);
	return mode === "unavailable" ? "Session mode not established." : mode ? `Session is in ${mode} mode.` : "";
}

function telemetryReceipt(args: Fields, details: Fields): Receipt {
	const next = object(details.continuation);
	const coverage = object(details.coverage);
	const recording = line(object(details.recording).status);
	const extra = continuation(
		"policy_control",
		{
			operation: "telemetry",
			...(args.from !== undefined ? { from: args.from, to: args.to } : { since: args.since, until: args.until }),
		},
		next.nextCursor,
	);
	const scope =
		coverage.pageStatus === "unavailable"
			? "Telemetry page unavailable"
			: typeof details.records === "number"
				? `Read ${count(details.records, "record")} on this telemetry page`
				: "Telemetry page not established";
	const partial =
		coverage.status === "partial" || coverage.pageStatus === "partial" || next.olderSegments === "removed";
	const incomplete = recording === "incomplete" || recording === "unknown";
	return {
		outcome: `${scope}${extra ? "; more follow" : ""}.`,
		extra,
		qualifier: partial ? "Coverage is partial." : incomplete ? "Recording may be incomplete." : "",
		limit: partial ? "[Telemetry coverage is partial]" : incomplete ? "[Complete recording is not established]" : "",
	};
}

function controlInspection(op: string, details: Fields): string | undefined {
	switch (op) {
		case "inspect": {
			const rule = line(object(details.record).id);
			const pending = line(object(details.proposal).id);
			if (rule) return `Read stored rule ${rule} and its control revision.`;
			return pending ? `Read inert pending proposal ${pending}.` : undefined;
		}
		case "actions": {
			const entries = listCount(details.actions, "current exact action");
			return entries ? `Found ${entries}.` : undefined;
		}
		case "import-preview": {
			const plan = listCount(details.rows, "bundled rule");
			return plan ? `Previewed import of ${plan}. No rules changed.` : undefined;
		}
		case "reset-preview":
			return line(details.revision) ? "Previewed the observation reset. No state changed." : undefined;
		case "data-preview":
			return details.complete === true ? "Previewed the complete data artifact. No data changed." : undefined;
	}
}

function exactActionOutcome(op: string, details: Fields): string | undefined {
	const state = line(details.state);
	if (op === "action-inspect" && state) return `The exact action is ${state}.`;
	if (op === "action-approve" && state === "approved" && details.uses === 1) {
		return "Approved one unchanged retry. This did not run the action.";
	}
	if (op === "action-reject" && state === "rejected") return "Rejected the exact action.";
}

const APPLIED_CONTROLS = new Map([
	["import", "Imported the selected bundled definitions."],
	["reset", "Reset the selected observations in this session."],
	["data-remove", "Removed the named data binding."],
	["data-set", "Saved the named data binding."],
	["data-set-file", "Saved the named data binding."],
]);

function appliedOutcome(op: string, details: Fields): string | undefined {
	if (op === "reject" && details.decision === "rejected") return "Rejected the proposal.";
	if (details.applied !== true) return undefined;
	const state = line(details.state);
	const effect = line(details.effect);
	return (
		APPLIED_CONTROLS.get(op) ??
		(state
			? `Control applied. The rule is ${state}${effect ? ` (${effect})` : ""}.`
			: "Control applied; current rule state not established.")
	);
}

function controlReceipt(args: Fields, details: Fields): Receipt {
	const op = line(args.operation);
	if (op === "telemetry") return telemetryReceipt(args, details);
	if (op === "mode") return { outcome: modeFact(details) || "Session mode not established." };
	if (op === "data-preview" && details.complete === false) {
		return {
			outcome: "Previewed data metadata only; no data changed.",
			limit: "[Complete artifact exceeds the preview output bound]",
		};
	}
	return {
		outcome:
			controlInspection(op, details) ??
			exactActionOutcome(op, details) ??
			appliedOutcome(op, details) ??
			"Control outcome not established.",
		summary: modeFact(details),
	};
}

function receiptFor(name: Name, args: Fields, details: Fields, output: string): Receipt {
	if (name === "policy_rules") return rulesReceipt(args, details, output);
	if (name === "policy_control") return controlReceipt(args, details);
	if (name === "policy_propose") {
		const id = line(details.proposalId);
		const revision = line(details.proposalRevision);
		return id && details.state === "pending"
			? {
					outcome: `Staged inert proposal ${id} for operator approval.`,
					summary: named("revision", revision),
				}
			: { outcome: "Proposal state not established." };
	}
	const id = line(details.ruleId);
	const state = line(details.state);
	const effect = named("effect", details.effect);
	const mode = modeFact(details);
	return {
		outcome:
			details.decision === "approved" && id
				? `Approved the proposal for ${id}; enforcement is not confirmed.`
				: "Approval not established.",
		summary: [id ? facts(id, state, effect) : "", mode].filter(Boolean).join("\n"),
		qualifier: details.matcherAvailable === false ? "Matcher unavailable." : "",
		limit: details.matcherAvailable === false ? "[The rule matcher is unavailable]" : "",
	};
}

function progress(name: Name, args: Fields): string {
	if (name === "policy_control") return controlProgress(line(args.operation));
	if (name === "policy_propose") return "Submitting the proposal for review…";
	if (name === "policy_approve") return "Recording the approval…";
	return "Inspecting policy…";
}

interface ResultRows {
	receipt: Receipt;
	body: string;
	limit: string;
	color: Color;
}

function errorResult(name: Name, args: Fields, body: ReturnType<typeof bound>): ResultRows {
	// Pi validation diagnostics can quote the full input. Empty args can mean an unparseable call.
	const keys = Object.keys(args);
	const shown = describeCall(name, args).visible;
	const privateInput = keys.length === 0 || keys.some((key) => !shown.includes(key) || typeof args[key] !== "string");
	if (privateInput) {
		return {
			receipt: {
				outcome: body.text ? "Policy request failed. Diagnostic hidden in collapsed view." : "No diagnostic returned.",
			},
			body: body.text,
			limit: body.limit,
			color: "error",
		};
	}
	const retained = body.text.trimStart();
	const first = retained.split("\n", 1)[0];
	return {
		receipt: { outcome: line(first) || "No diagnostic returned." },
		body: retained.slice(first.length).replace(/^\n/u, ""),
		limit: body.limit,
		color: "error",
	};
}

function prepareResult(
	name: Name,
	args: Fields,
	result: AgentToolResult<unknown>,
	isPartial: boolean,
	error: boolean,
): ResultRows {
	const output = outputText(result);
	if (error) return errorResult(name, args, bound(output));
	const producerLimited = !isPartial && output.endsWith(PRODUCER_TRUNCATION);
	const retained = producerLimited ? output.slice(0, -PRODUCER_TRUNCATION.length) : output;
	const body = bound(retained);
	if (isPartial)
		return { receipt: { outcome: progress(name, args) }, body: body.text, limit: body.limit, color: "muted" };
	const details = object(result.details ?? jsonObject(retained));
	const receipt = receiptFor(name, args, details, retained);
	const degraded = details.ruleStoreDegraded === true || details.registryHealth === "degraded";
	const limit = facts(
		receipt.limit ?? "",
		degraded ? "[Rule store is degraded]" : "",
		producerLimited ? "[Policy output was truncated by the producer]" : "",
		body.limit,
	);
	const qualifier =
		receipt.qualifier || (degraded ? "Rule store is degraded." : producerLimited ? "Output truncated." : "");
	return {
		receipt: { ...receipt, qualifier },
		body: receipt.omitRaw || body.text.trim() === receipt.outcome ? "" : body.text,
		limit,
		color: "toolOutput",
	};
}

function expandedRows(model: ResultRows, width: number, theme: Theme): string[] {
	const { receipt, limit, body, color } = model;
	return [
		"",
		...wrap(receipt.outcome, width, theme, color),
		...wrap(receipt.summary ?? "", width, theme, "toolOutput"),
		...wrap(safe(receipt.extra ?? ""), width, theme, "toolOutput"),
		...wrap(body, width, theme, color),
		...wrap(limit, width, theme, "warning"),
	];
}

function collapsedRows(
	model: ResultRows,
	width: number,
	theme: Theme,
	context: CardContext,
	hiddenCall: boolean,
): string[] {
	const { receipt, body, color, limit } = model;
	const { outcome, qualifier, extra, summary } = receipt;
	const statement = [outcome, qualifier].filter(Boolean).join(" ");
	const rows = ["", row(statement, width, theme, color)];
	if (hiddenCall || extra || summary || body.trim() || limit || visibleWidth(statement) > width) {
		rows.push(hint(theme, context, width));
	}
	return rows;
}

function renderResult(
	name: Name,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (context.state) context.state.hasResult = true;
	const args = object(context.args);
	const call = describeCall(name, args);
	const model = prepareResult(name, args, result, options.isPartial, context.isError);
	return renderAtWidth((width) =>
		options.expanded
			? expandedRows(model, width, theme)
			: collapsedRows(model, width, theme, context, Boolean(call.facts || hasExtraArguments(name, call, args, width))),
	);
}

export const renderProposeCall = (args: unknown, theme: Theme, context: CardContext): Component =>
	renderCall("policy_propose", args, theme, context);
export const renderRulesCall = (args: unknown, theme: Theme, context: CardContext): Component =>
	renderCall("policy_rules", args, theme, context);
export const renderApproveCall = (args: unknown, theme: Theme, context: CardContext): Component =>
	renderCall("policy_approve", args, theme, context);
export const renderControlCall = (args: unknown, theme: Theme, context: CardContext): Component =>
	renderCall("policy_control", args, theme, context);

type ResultRenderer = (
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
) => Component;
export const renderProposeResult: ResultRenderer = (...args) => renderResult("policy_propose", ...args);
export const renderRulesResult: ResultRenderer = (...args) => renderResult("policy_rules", ...args);
export const renderApproveResult: ResultRenderer = (...args) => renderResult("policy_approve", ...args);
export const renderControlResult: ResultRenderer = (...args) => renderResult("policy_control", ...args);
