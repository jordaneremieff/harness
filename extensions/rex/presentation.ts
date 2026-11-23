import {
	type ExtensionAPI,
	type KeybindingHints,
	type Theme,
	type ThemeColor,
	type ToolDefinition,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { prepareRequest, validateRequest } from "./schema.ts";

type DisplayRecord = Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">;
type Row = { text: string; colour: ThemeColor };
type Fields = Record<string, unknown>;
const PREVIEW_ROWS = 5;

export function publishRexToolDisplay(events: ExtensionAPI["events"], tools: readonly DisplayRecord[]): () => void {
	const publish = () =>
		events.emit("harness:tool-display:publish", {
			version: 1,
			tools: tools.map(({ name, renderCall, renderResult, renderShell }) => ({
				name,
				renderCall,
				renderResult,
				renderShell,
			})),
		});
	const stop = events.on("harness:tool-display:request", (request) => {
		if (object(request).version === 1) publish();
	});
	publish();
	return stop;
}

export function createRexToolDisplay(name: string) {
	return {
		renderShell: "default" as const,
		renderCall(args, theme, context) {
			const call = callParts(name, args);
			const title = theme.fg("toolTitle", theme.bold(name));
			const head = call.subject ? `${title} ${theme.fg("accent", call.subject)}` : title;
			return atWidth((width) => {
				const { rows, skipped, hidden } = callRows(call, name, head, width, theme, context.expanded);
				if (!context.expanded && !context.state.rexResult && hidden && context.keyText("app.tools.expand"))
					rows.push(clip(hint(theme, context, skipped), width));
				return rows;
			});
		},
		renderResult(result, options, theme, context) {
			context.state.rexResult = true;
			const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			const call = callParts(name, context.args);
			const receipt = canonicalResult(result.details, text);
			const resultView = receipt
				? resultParts(name, call, receipt, context.isError)
				: fallback(text, call, context.isError);
			const view = options.isPartial
				? {
						...resultView,
						outcome: progress(name, call.request),
						colour: "muted" as const,
						summary: [],
						next: undefined,
					}
				: resultView;
			return atWidth((width) => {
				const { rows, skipped, hidden } = resultRows(view, width, theme, options.expanded);
				if (options.expanded) return rows;
				const callSkipped = visual(call.body, width, false).skippedCount;
				if (hidden || expandedCallArguments(name, call, width) || callSkipped)
					rows.push(clip(hint(theme, context, skipped || callSkipped), width));
				return rows;
			});
		},
	} satisfies Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell">;
}

function callRows(call: Call, name: string, head: string, width: number, theme: Theme, expanded: boolean) {
	const rows = [clip(head, width)];
	if (call.facts) rows.push(clip(theme.fg("muted", call.facts), width));
	const preview = visual(call.body, width, expanded);
	for (const text of preview.visualLines) rows.push(theme.fg("toolOutput", text));
	const args = expandedCallArguments(name, call, width);
	if (expanded && args) rows.push(...wrapped(argumentText(args), width, theme, "muted"));
	return { rows, skipped: preview.skippedCount, hidden: !!args || preview.skippedCount > 0 };
}

function resultRows(view: ResultView, width: number, theme: Theme, expanded: boolean) {
	const rows = [""];
	const lead = [row(view.outcome, view.colour), ...view.summary].filter((part) => part.text);
	const limits = view.limit ? [row(`[${view.limit}]`, "warning")] : [];
	const draw = ({ text, colour }: Row) =>
		expanded ? wrapped(text, width, theme, colour) : [clip(theme.fg(colour, text), width)];
	rows.push(...lead.flatMap(draw));
	const preview = visual(view.body, width, expanded, view.keepTail ? "end" : "start");
	for (const part of preview.visualLines) rows.push(theme.fg(view.bodyColour ?? "toolOutput", part));
	rows.push(...limits.flatMap(draw));
	if (expanded) appendResultDetail(rows, view, width, theme);
	return {
		rows,
		skipped: preview.skippedCount,
		hidden:
			Boolean(view.detail || view.next || preview.skippedCount) ||
			[...lead, ...limits].some((part) => visibleWidth(part.text) > width),
	};
}

function appendResultDetail(rows: string[], view: ResultView, width: number, theme: Theme): void {
	for (const { text, colour } of [
		{ text: view.detail, colour: "toolOutput" as const },
		{ text: view.next && `Next call: ${view.next}`, colour: "muted" as const },
	]) {
		if (!text) continue;
		rows.push("");
		for (const line of wrapped(text, width, theme, colour)) rows.push(line);
	}
}

function atWidth(draw: (width: number) => string[]): Component {
	return { invalidate() {}, render: (width) => (width > 0 ? draw(width) : []) };
}

function safe(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, (ch) => (ch === "\n" || ch === "\t" ? ch : " "));
}
function one(text: string): string {
	return safe(text).replace(/\s+/gu, " ").trim();
}
function clip(text: string, width: number): string {
	return truncateToWidth(text, width, "…").replace(/\x1b\[0m…\x1b\[0m$/u, "…\x1b[22;23;24;25;27;28;29;39m");
}
function visual(text: string, width: number, expanded: boolean, direction: "start" | "end" = "start") {
	if (!text) return { visualLines: [], skippedCount: 0 };
	return truncateToVisualLines(
		safe(text).replace(/\t/g, "   "),
		expanded ? Infinity : PREVIEW_ROWS,
		width,
		0,
		direction,
	);
}
function wrapped(text: string, width: number, theme: Theme, colour: ThemeColor): string[] {
	return visual(text, width, true).visualLines.map((part) => theme.fg(colour, part));
}
function hint(theme: Theme, keys: KeybindingHints, skipped: number): string {
	const action = keys.keyText("app.tools.expand")
		? keys.keyHint("app.tools.expand", "to expand")
		: theme.fg("muted", "click to expand");
	return (
		theme.fg("muted", `... (${skipped ? `${counted(skipped, "more line")}, ` : ""}`) + action + theme.fg("muted", ")")
	);
}
function object(value: unknown): Fields {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};
}
function field(record: Fields, key: string): string {
	const value = record[key];
	return typeof value === "string" ? one(value) : "";
}
function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
function values(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
function counted(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
function row(text: string, colour: ThemeColor = "muted"): Row {
	return { text: one(text), colour };
}
function words(value: string): string {
	return value.replaceAll("_", " ");
}
function sentence(text: string): string {
	return text ? text[0]?.toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".") : "";
}
function json(value: unknown): string {
	return safe(JSON.stringify(value, null, 2) ?? "");
}

function targetParts(value: unknown): string[] {
	const t = object(value);
	return [
		...["block", "window", "session", "client"].map((key) => field(t, `${key}Id`) || field(t, key)),
		field(t, "server") || field(object(t.server), "endpoint"),
		field(t, "source") && `${field(t, "source")} target`,
	].filter(Boolean);
}

const CALL_FACTS = new Set([
	"op",
	"kind",
	"target",
	"label",
	"recordId",
	"query",
	"method",
	"action",
	"view",
	"condition",
	"phase",
	"state",
	"statusId",
	"timeoutMs",
	"offset",
	"limit",
	"maxBytes",
	"maxSnapshots",
]);
const NUMERIC_FACTS: Record<string, string> = {
	offset: "offset",
	limit: "limit",
	maxBytes: "max bytes",
	maxSnapshots: "max snapshots",
};

function callParts(name: string, args: unknown) {
	const request = object(prepareRequest(name, args));
	const op = field(request, "op");
	const kind = field(request, "kind");
	const target = targetParts(request.target);
	const { subject, facts } = callHeading(request, op, kind, target);
	const exposure = requestExposure(name, request);
	const waitLiteral = name === "rex_wait" && typeof request.text === "string" ? request.text : undefined;
	const argumentsForDisplay = displayArguments(request, exposure.unverified);
	const body = !exposure.unverified && kind === "lua" && typeof request.code === "string" ? safe(request.code) : "";
	return { request, subject, body, exposure, waitLiteral, arguments: argumentsForDisplay, facts };
}

function requestExposure(name: string, request: Fields) {
	const terminal = name === "rex_terminal";
	const native = name === "rex_native";
	const unverified = (terminal || native) && !validateRequest(name, request).ok;
	const delivery =
		terminal && (request.op === "input" || Object.hasOwn(request, "text") || Object.hasOwn(request, "keys"));
	const nativePayload = native && (Object.hasOwn(request, "args") || Object.hasOwn(request, "code"));
	return { unverified, delivery, nativePayload };
}
function displayArguments(request: Fields, unverified: boolean): Fields {
	return Object.fromEntries(
		Object.entries(request).flatMap(([key, value]) => {
			if (key === "code" && !unverified) return [];
			if (["text", "keys", "args", "code"].includes(key)) return [[key, inputSize(key, value)]];
			const shown = unverified ? malformedFact(key, value) : value;
			return shown === undefined ? [] : [[key, shown]];
		}),
	);
}
function malformedFact(key: string, value: unknown): unknown {
	if (!CALL_FACTS.has(key)) return undefined;
	if (typeof value === "string" || typeof value === "number") return value;
	if (key === "target") return targetParts(value).join(" · ") || undefined;
	return undefined;
}
function inputSize(key: string, value: unknown): string {
	if (typeof value === "string") return counted([...value].length, "character");
	if (key === "keys" && Array.isArray(value)) return counted(value.length, "key");
	if (key === "args" && value && typeof value === "object") return counted(Object.keys(value).length, "argument");
	return "Withheld";
}
function privateReceipt(call: Call, failure: boolean): boolean {
	// Validators and native transports may echo request data in diagnostics or secondary evidence.
	return call.exposure.delivery || call.exposure.unverified || (failure && call.exposure.nativePayload);
}
function withheldDiagnostic(call: Call): string {
	return call.exposure.delivery && !call.exposure.unverified
		? "Rex did not confirm input delivery. The diagnostic is withheld."
		: "Rex reported a failure. The diagnostic is withheld because it may contain request data.";
}
function callHeading(request: Fields, op: string, kind: string, target: string[]) {
	const values = [
		"label",
		"recordId",
		"method",
		"action",
		"query",
		"view",
		"condition",
		"phase",
		"state",
		"statusId",
	].map((key) => field(request, key));
	const [label, id, method, action, query, view, condition, phase, state, statusId] = values;
	const subject =
		[id, label, method, action, op === "resolve" ? query : "", target[0], kind, view, words(condition), op].find(
			Boolean,
		) || "";
	const numbers = Object.entries(NUMERIC_FACTS).flatMap(([key, label]) => {
		const n = number(request[key]);
		return n === undefined ? [] : [`${label} ${n}`];
	});
	const qualifiers = [
		op === "native" || op === "wait" ? "" : op,
		kind,
		view,
		words(condition),
		requestedAllowance(request.timeoutMs),
		...target,
		query !== subject && qualified("query", query),
		qualified("phase", phase),
		qualified("state", state),
		statusId,
		...numbers,
	];
	return { subject, facts: [...new Set(qualifiers.filter((part) => part && part !== subject))].join(" · ") };
}
function requestedAllowance(value: unknown): string {
	const ms = number(value);
	if (ms === undefined || ms <= 0) return "";
	const seconds = ms / 1000;
	// Use Pi's tool duration units; the exact requested milliseconds stay in expanded arguments.
	const whole = Math.floor(seconds);
	const duration =
		seconds < 60 ? `${seconds.toFixed(1).replace(/\.0$/, "")}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`;
	return `requested ${duration}`;
}
function qualified(label: string, value: string): string {
	return value ? `${label} ${value}` : "";
}
type Call = ReturnType<typeof callParts>;
function expandedCallArguments(name: string, call: Call, width: number): Fields | undefined {
	if (
		Object.keys(call.arguments).some((key) => !CALL_FACTS.has(key)) ||
		visibleWidth(`${name} ${call.subject}`.trimEnd()) > width ||
		visibleWidth(call.facts) > width
	)
		return call.arguments;
	const timeoutMs = number(call.arguments.timeoutMs);
	return timeoutMs === undefined ? undefined : { timeoutMs };
}
function argumentText(args: Fields): string {
	return Object.entries(args)
		.map(([key, value]) => `  ${one(key)}: ${typeof value === "string" ? safe(value) : json(value)}`)
		.join("\n");
}
function canonicalResult(details: unknown, content: string): Fields | undefined {
	const isReceipt = (value: Fields) =>
		typeof value.ok === "boolean" &&
		typeof value.outcome === "string" &&
		["none", "confirmed", "unknown"].includes(field(object(value.effects), "state")) &&
		object(value.coverage).bounded === true;
	if (isReceipt(object(details))) return object(details);
	// Rex's own machine content carries evidence that its compact details do not repeat.
	try {
		const parsed = object(JSON.parse(content));
		return isReceipt(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

interface ResultView {
	outcome: string;
	colour: ThemeColor;
	summary: Row[];
	body: string;
	bodyColour?: ThemeColor;
	keepTail?: boolean;
	limit?: string;
	detail?: string;
	next?: string;
}

function fallback(text: string, call: Call, isError: boolean): ResultView {
	const withheld = privateReceipt(call, isError) || call.exposure.nativePayload;
	const body = withheld ? "" : redactWait(call)(text).trim();
	const diagnostic = withheld ? withheldDiagnostic(call) : "Rex did not return a displayable diagnostic.";
	return {
		outcome: one(body.split("\n")[0] ?? "") || (isError ? diagnostic : ""),
		colour: isError ? "error" : "toolOutput",
		summary: [],
		body: body.split("\n").slice(1).join("\n"),
		bodyColour: isError ? "error" : "toolOutput",
	};
}

function progress(name: string, request: Fields): string {
	if (name === "rex_wait") return "Observing the terminal…";
	if (request.op === "input") return "Delivering input…";
	if (request.op === "create") return "Requesting a terminal…";
	if (name === "rex_native" && ["api", "lua", "action"].includes(field(request, "kind")))
		return "Waiting for the Rex CLI…";
	if (request.op === "reconcile" || request.op === "cleanup") return "Checking owned resources…";
	if (request.op === "bind" || request.op === "unbind") return "Checking the Rex binding…";
	return "Reading Rex evidence…";
}

const OUTCOMES: Readonly<Record<string, string>> = {
	acknowledged: "The Rex CLI acknowledged the request; application success is not established",
	already_closed: "The owned blocks were already closed or absent",
	capture: "Read a bounded terminal capture",
	capture_unavailable: "Terminal capture unavailable",
	cancelled: "Cancelled",
	claim_recovered: "Updated the claim from current resource observations",
	claim_released: "Released only the retained claim",
	cleanup_report: "Confirmed closure of the owned blocks",
	cleanup_unknown: "Cleanup effects are not established",
	condition_observed: "The requested condition was observed",
	created: "Rex created the terminal; readiness is not established",
	environment: "Read the Rex environment",
	forgotten: "Removed the ownership record",
	host_status: "Read Rex status",
	input_delivered: "Input delivered; application execution is not established",
	not_observed: "The requested condition was not observed within the wait budget",
	observation_incomplete: "Observation is incomplete",
	observed: "Read current observations of owned records",
	observer_ended: "The event source ended before the condition was established",
	reconciled: "Checked retained claims against current resource presence",
	reconciliation_incomplete: "Some retained claims lack conclusive resource observations",
	resolved: "Resolved the Rex target",
	schema: "Read the installed method schema",
	snapshot: "Read a Rex snapshot",
	status_bound: "Verified and saved the Rex binding",
	status_unbound: "Removed the Rex binding",
};

function resultParts(name: string, call: Call, receipt: Fields, isError: boolean): ResultView {
	const code = field(receipt, "outcome");
	const withheld = code === "input_delivered" || privateReceipt(call, isError || receipt.ok === false);
	const data = withheld ? deliveryEvidence(code, receipt.data) : object(receipt.data);
	const coverage = object(receipt.coverage);
	const redact = redactWait(call);
	const diagnostic = !withheld && typeof receipt.error === "string" ? redact(receipt.error).trim() : "";
	const [first = "", ...remaining] = diagnostic.split("\n");
	const capture = captureOf(data);
	const tail = typeof capture.content === "string" ? redact(capture.content).trimEnd() : "";
	const window = nativeBody(name, code, data);
	const methods = values(data.methods).flatMap((part) => (typeof part === "string" ? [one(part)] : []));
	const continuation = continuationCall(name, call, data, coverage);
	const page = pageOutcome(name, code, data, coverage, Boolean(continuation));
	const normalOutcome =
		withheld && isError && code !== "cancelled" ? withheldDiagnostic(call) : outcomeText(name, code, data, page);
	const outcome = first && isError && code !== "cancelled" ? one(first) : normalOutcome;
	return {
		outcome,
		colour: isError ? "error" : "toolOutput",
		summary: [...resultFacts(name, code, receipt), ...evidenceRows(name, code, data, receipt, redact)],
		body: [...remaining, ...methods, window, tail].filter(Boolean).join("\n"),
		bodyColour: remaining.length && isError && !methods.length && !window && !tail ? "error" : "toolOutput",
		keepTail: Boolean(tail && !remaining.length && !methods.length && !window),
		limit: limits(coverage, capture, data, code),
		detail: withheld ? "" : redact(expandedEvidence(receipt, data, capture, Boolean(window))),
		next: continuation,
	};
}
function deliveryEvidence(code: string, value: unknown): Fields {
	if (code !== "input_delivered") return {};
	const data = object(value);
	return {
		observationError: Boolean(data.observationError),
		observation: data.observation ? { ok: object(data.observation).ok } : undefined,
	};
}
function redactWait(call: Call): (text: string) => string {
	const literal = call.waitLiteral;
	if (!literal) return safe;
	const escaped = JSON.stringify(literal).slice(1, -1);
	const hidden = new Set([literal, escaped]);
	return (text) => {
		for (const value of hidden) if (value) text = text.replaceAll(value, "[withheld]");
		text = safe(text);
		const plain = safe(literal);
		return plain.trim() ? text.replaceAll(plain, "[withheld]") : text;
	};
}
function resultFacts(name: string, code: string, receipt: Fields): Row[] {
	const effects = object(receipt.effects);
	const target = targetParts(receipt.target);
	const effectId = field(effects, "recordId");
	const summary: Row[] = [];
	if (effects.state === "unknown") summary.push(row("Native effects are not established.", "warning"));
	if (code === "not_observed" || (name === "rex_wait" && code === "timeout"))
		summary.push(row("The observer does not stop terminal work."));
	if (target.length) summary.push(row(`target ${target.join(" · ")}`));
	if (effectId) summary.push(row(`effect record ${effectId}`));
	return summary;
}
function evidenceRows(
	name: string,
	code: string,
	data: Fields,
	receipt: Fields,
	redact: (text: string) => string,
): Row[] {
	if (code === "input_delivered") {
		if (data.observationError) return [row("The optional snapshot failed.", "warning")];
		if (object(data.observation).ok === true)
			return [row("A separate snapshot was returned. Its content is withheld on the input card.")];
		return data.observation ? [row("The optional snapshot was not confirmed.", "warning")] : [];
	}
	if (code === "environment") return environmentRows(data);
	if (name === "rex_status") return statusRows(data).map((text) => row(text, "toolOutput"));
	if (name === "rex_owned") return ownershipRows(receipt, data).map((text) => row(text, "toolOutput"));
	const error = field(data, "captureError");
	return error ? [row(redact(error), "warning")] : [];
}
function outcomeText(name: string, code: string, data: Fields, page: string): string {
	if (code === "cancelled") return "Cancelled";
	if (code === "child_completed" || code === "child_failed") {
		const exit = number(object(object(data.process).last_exit).exit_code);
		return exit === undefined ? "The direct child exited." : `The direct child exited with code ${exit}.`;
	}
	if (name === "rex_wait" && code === "timeout") return "The observer deadline ended.";
	if (code === "not_observed" && data.ending === "snapshot_limit")
		return "The snapshot limit ended the wait without an observed condition.";
	return sentence(page || OUTCOMES[code] || words(code));
}
function nativeBody(name: string, code: string, data: Fields): string {
	if (name !== "rex_native" || code !== "acknowledged") return "";
	const value = object(data.value);
	if (value.completeJson === false && typeof value.stdout === "string") return value.stdout.trimEnd();
	return data.value === undefined || data.value === null ? "" : json(data.value);
}
function captureOf(data: Fields): Fields {
	if (typeof data.content === "string") return data;
	if (typeof object(data.snapshot).content === "string") return object(data.snapshot);
	return object(data.capture);
}
function environmentRows(data: Fields): Row[] {
	const inherited = targetParts(data.inherited);
	const counts = (["sessions", "clients", "hosts"] as const).flatMap((key) => {
		const entries = object(data[key])[key];
		return Array.isArray(entries) && entries.length
			? [counted(entries.length, key === "sessions" ? "session" : key === "clients" ? "client" : "host")]
			: [];
	});
	return [
		inherited.length ? row(`launch context ${inherited.join(" · ")}`) : undefined,
		counts.length ? row(counts.join(" · "), "toolOutput") : undefined,
	].filter((part) => part !== undefined);
}
function statusRows(data: Fields): string[] {
	const activity = object(data.hostActivity);
	const binding = object(object(data.binding).target);
	const host = [field(activity, "host"), field(activity, "state")].filter(Boolean).join(" · ");
	const reports = new Set<string>();
	function states(value: unknown, depth: number): void {
		if (depth > 4 || reports.size >= 4 || !value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const child of value) states(child, depth + 1);
			return;
		}
		const report = object(value);
		if (field(report, "state")) reports.add(field(report, "state"));
		for (const child of Object.values(report)) states(child, depth + 1);
	}
	states(data.reportedStatus, 0);
	return [
		host ? `Host ${host}` : "",
		reports.size ? `program reported ${[...reports].join(", ")}` : "",
		qualified("bound to", targetParts(binding).join(" · ")),
		number(activity.omittedTasks) ? `${counted(Number(activity.omittedTasks), "task")} outside the host snapshot` : "",
	].filter(Boolean);
}
function ownershipRows(receipt: Fields, data: Fields): string[] {
	const reports = values(data.reports);
	const claims = values(data.records).map(object);
	if (!reports.length)
		return values(receipt.records).flatMap((ref) => {
			const id = field(object(ref), "recordId");
			const claim = claims.find((entry) => field(entry, "callId") === id);
			return id ? [[`Record ${id}`, qualified("stored", field(claim ?? {}, "phase"))].filter(Boolean).join(" · ")] : [];
		});
	return reports.flatMap((report) => {
		const r = object(report);
		const id = field(r, "recordId");
		const phase = field(r, "phase");
		const observed = values(r.observations);
		const title = [
			id && `Record ${id}`,
			phase && `stored ${phase}`,
			r.complete === true && !observed.length ? "no owned resources" : "",
		]
			.filter(Boolean)
			.join(" · ");
		return [
			title,
			...observed.slice(0, 1).map((part) => {
				const obs = object(part);
				const exit = number(object(object(obs.process).last_exit).exit_code);
				const child = field(obs, "childState");
				return [
					targetParts(obs.resource).join(" · ") || field(obs, "blockId"),
					field(obs, "presence"),
					child && `child ${child}`,
					exit === undefined ? "" : `exit ${exit}`,
				]
					.filter(Boolean)
					.join(" · ");
			}),
			observed.length > 1 ? `${counted(observed.length - 1, "other resource observation")} in the retained report` : "",
			observationDiagnostic(r, object(observed[0])),
		].filter(Boolean);
	});
}
function observationDiagnostic(report: Fields, observation: Fields): string {
	return (
		field(report, "error") ||
		["error", "processError", "statusError", "captureError"].map((key) => field(observation, key)).find(Boolean) ||
		""
	);
}
function pageOutcome(name: string, code: string, data: Fields, coverage: Fields, hasNext: boolean): string {
	const more = hasNext ? "; a continuation is available" : "";
	if (code === "catalog") return catalogOutcome(data, more);
	if (
		name === "rex_owned" &&
		number(coverage.returnedRecords) !== undefined &&
		number(coverage.totalRecords) !== undefined
	) {
		const refs = number(coverage.emittedRecordRefs);
		const qualifier = refs && refs < Number(coverage.returnedRecords) ? `; ${counted(refs, "record ID")} retained` : "";
		if (coverage.returnedRecords === 0) return `No records returned${more}`;
		const verb =
			(
				{
					observation_incomplete: "Partially observed",
					observed: "Observed",
					reconciled: "Checked",
					reconciliation_incomplete: "Partially checked",
				} as Record<string, string>
			)[code] ?? "Selected";
		return `${verb} ${coverage.returnedRecords} of ${counted(Number(coverage.totalRecords), "record")}${qualifier}${more}`;
	}
	return "";
}
function catalogOutcome(data: Fields, more: string): string {
	const returned = number(data.returnedMethods);
	const matched = number(data.matchedMethods);
	if (returned === undefined || matched === undefined) return "";
	if (matched === 0) return "No matching methods";
	if (returned === 0) return `No matching methods in this page${more}`;
	return `Returned ${returned} of ${counted(matched, "matching method")}${more}`;
}
function continuationCall(name: string, call: Call, data: Fields, coverage: Fields): string | undefined {
	const { request } = call;
	const offset =
		name === "rex_native" && request.kind === "catalog"
			? number(data.nextOffset)
			: name === "rex_owned" && request.recordId === undefined
				? number(coverage.nextOffset)
				: undefined;
	if (offset === undefined) return undefined;
	return `${name} ${JSON.stringify({ ...request, offset, ...(number(coverage.omittedRecordRefs) ? { limit: 1 } : {}) })}`;
}
function captureIsPartial(capture: Fields): boolean {
	const start = number(capture.start);
	const end = number(capture.end);
	const total = number(capture.total);
	return start !== undefined && end !== undefined && total !== undefined && (start > 0 || end < total);
}
function limits(coverage: Fields, capture: Fields, data: Fields, code: string): string | undefined {
	const parts = [];
	if (coverage.dataOmitted) parts.push("Bulk data omitted by the Rex result byte limit");
	if (values(coverage.truncatedFields).length) parts.push("diagnostics shortened by the Rex result byte limit");
	if (number(coverage.omittedRecordRefs))
		parts.push(`${counted(Number(coverage.omittedRecordRefs), "record ID")} omitted by the Rex result byte limit`);
	if (captureIsPartial(capture))
		parts.push(`terminal capture retained bytes ${capture.start}–${capture.end} of ${capture.total} (end exclusive)`);
	const reports = values(data.reports).map(object);
	const observations = reports.flatMap((report) => values(report.observations));
	if (observations.some((observation) => captureIsPartial(object(object(observation).capture))))
		parts.push("owned observations include partial terminal captures");
	if (reports.some((report) => report.complete === false || report.conclusive === false))
		parts.push("some resource observations are incomplete");
	const eventCount = number(data.eventCount);
	if (eventCount !== undefined && Array.isArray(data.events) && eventCount > data.events.length)
		parts.push(`${data.events.length} of ${counted(eventCount, "event")} retained`);
	if (!parts.length && coverage.truncated && code !== "catalog" && number(coverage.totalRecords) === undefined)
		parts.push("Rex retained partial evidence");
	const text = parts.join("; ");
	return text ? text[0]?.toUpperCase() + text.slice(1) : undefined;
}
function expandedEvidence(receipt: Fields, data: Fields, capture: Fields, showedNativeReply: boolean): string {
	const { content: _content, methods: _methods, ...rest } = data;
	if (showedNativeReply) delete rest.value;
	for (const key of ["capture", "snapshot"])
		if (rest[key] === capture) {
			const { content: _tail, ...facts } = capture;
			rest[key] = facts;
		}
	const effects = object(receipt.effects);
	const coverage = object(receipt.coverage);
	const server = object(object(receipt.target).server);
	const identity = [qualified("host", field(server, "hostId")), qualified("instance", field(server, "instanceId"))]
		.filter(Boolean)
		.join(" · ");
	const refs = values(receipt.records);
	return [
		identity ? `Server identity: ${identity}` : "",
		field(effects, "note"),
		field(coverage, "note"),
		values(effects.resources).length ? `Resources\n${json(effects.resources)}` : "",
		refs.length && !Array.isArray(data.records) ? `Retained record references\n${json(refs)}` : "",
		values(coverage.omittedRecordIds).length ? `Omitted record references\n${json(coverage.omittedRecordIds)}` : "",
		Object.keys(rest).length ? json(rest) : "",
	]
		.filter(Boolean)
		.join("\n");
}
