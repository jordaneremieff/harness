import type { ExtensionAPI, KeybindingHints, Theme, ThemeColor, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

type DisplayRecord = Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">;
type CardTheme = Pick<Theme, "fg">;
type RenderResult = Parameters<NonNullable<ToolDefinition["renderResult"]>>[0];
interface Line { text: string; colour: ThemeColor; preview?: boolean }

export function publishRexToolDisplay(events: ExtensionAPI["events"], tools: readonly DisplayRecord[]): () => void {
	const publish = () => events.emit("harness:tool-display:publish", {
		version: 1,
		tools: tools.map(({ name, renderCall, renderResult, renderShell }) => ({ name, renderCall, renderResult, renderShell })),
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
		renderCall(args: unknown, theme: CardTheme, context: { expanded: boolean; isPartial: boolean }): Component {
			const request = object(args);
			const lines = callHeader(name, request);
			if (context.isPartial || context.expanded) {
				const target = targetText(request.target);
				if (target) lines.push(line(target, "muted"));
			}
			lines.push(...callBody(args, request, context.expanded));
			return card(lines, theme);
		},
		renderResult(result: RenderResult, options: ToolRenderResultOptions, theme: CardTheme, context: { args: unknown; isError: boolean } & Partial<KeybindingHints>): Component {
			const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			const value = canonicalResult(text);
			const lines = value ? canonicalLines(name, value, options, context.args) : fallbackLines(text, options, context.isError);
			// The host injects keyText with the operator's configured bindings; without it the card omits the key row.
			const key = context.keyText?.("app.tools.expand");
			if (key) lines.push(line(`${key} to ${options.expanded ? "collapse" : "expand · complete bounded result"}`, "muted"));
			return card(lines, theme);
		},
	} satisfies Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell">;
}

function callHeader(name: string, request: Record<string, unknown>): Line[] {
	const action = [string(request.op), string(request.kind) ?? string(request.view) ?? string(request.condition)].filter(Boolean).join(" ");
	const lines = [line(`${name}${action ? ` · ${action}` : ""}`, "toolTitle")];
	const facts = [string(request.label), string(request.method), string(request.action),
		string(request.phase) ? `phase ${request.phase}` : undefined,
		string(request.recordId) ? "one record" : undefined,
		string(request.query) ? `query ${JSON.stringify(request.query)}` : undefined].filter(Boolean).join(" · ");
	if (facts) lines.push(line(facts, "muted"));
	return lines;
}

function callBody(args: unknown, request: Record<string, unknown>, expanded: boolean): Line[] {
	if (expanded) return [line(""), ...jsonLines(args)];
	const lines: Line[] = [];
	if (typeof request.text === "string") lines.push(line(JSON.stringify(request.text), "toolOutput", true));
	if (Array.isArray(request.keys)) lines.push(line(`keys ${request.keys.filter((key) => typeof key === "string").join(" · ")}`, "muted", true));
	return lines;
}

function fallbackLines(text: string, options: ToolRenderResultOptions, isError: boolean): Line[] {
	return [
		line(options.isPartial ? "partial result" : "tool result", isError ? "error" : "toolOutput"),
		...text.split("\n").slice(0, options.expanded ? undefined : 2).map((part) => line(part, "toolOutput", !options.expanded)),
	];
}

function canonicalLines(name: string, value: Record<string, unknown>, options: ToolRenderResultOptions, args: unknown): Line[] {
	const effects = object(value.effects);
	const coverage = object(value.coverage);
	const data = object(value.data);
	const request = object(args);
	return [
		leadLine(name, request, value, data, options.isPartial),
		...statusSummaryLines(name, data),
		...terminalQualifications(name, request, value),
		...authorityQualifications(name, request, value),
		...deadlineLine(name, request),
		...omissionLines(coverage, data),
		...countLines(coverage, data),
		...ownedObservationLines(name, request, data, options.expanded),
		...resultDetails(value, effects, coverage, data, options.expanded),
	];
}

/**
 * The collapsed lead: the human subject (the resolved label, or the plain resource kind) and the precise
 * outcome. Unknown effects stay on this line; exact identities, endpoints and the effect record wait in Details.
 */
function leadLine(name: string, request: Record<string, unknown>, value: Record<string, unknown>, data: Record<string, unknown>, isPartial: boolean): Line {
	const unknown = object(value.effects).state === "unknown";
	const subject = string(data.label) ?? string(request.label) ?? subjectKind(name, request, value.target);
	const parts = [isPartial ? "partial" : undefined, subject, String(value.outcome).replaceAll("_", " "), unknown ? "UNKNOWN EFFECTS" : undefined].filter(Boolean);
	return line(parts.join(" · "), unknown ? "warning" : value.ok ? "toolOutput" : "error");
}

const OWNED_SUBJECTS: Record<string, string> = { owned: "owned records", observe: "observation", reconcile: "reconciliation", cleanup: "cleanup" };
const STATUS_SUBJECTS: Record<string, string> = { bind: "binding", unbind: "unbinding" };
const TARGET_KINDS: ReadonlyArray<readonly [string, string, string]> = [["blockId", "block", "block"], ["windowId", "window", "window"], ["sessionId", "session", "session"], ["clientId", "client", "client"]];

/** The subject of a native call: the method or action it named, or its kind. */
function nativeSubject(request: Record<string, unknown>): string {
	const kind = string(request.kind);
	if (kind !== "api" && kind !== "action") return kind ?? "native call";
	return `${kind} ${string(request.method) ?? string(request.action) ?? ""}`.trim();
}

/** A plain name for what the operation acted on, without identifiers. */
function subjectKind(name: string, request: Record<string, unknown>, target: unknown): string | undefined {
	const op = string(request.op) ?? "";
	const kind = string(request.kind);
	const byTool: Record<string, () => string | undefined> = {
		rex_terminal: () => (op === "create" ? `new ${kind ?? "terminal"}` : undefined),
		rex_native: () => nativeSubject(request),
		rex_wait: () => (string(request.condition) ? `wait for ${String(request.condition).replaceAll("_", " ")}` : "wait"),
		rex_owned: () => OWNED_SUBJECTS[op],
		rex_status: () => STATUS_SUBJECTS[op] ?? "status",
		rex_environment: () => (op === "resolve" ? `${kind ?? "target"} resolution` : "environment"),
	};
	const named = byTool[name]?.();
	if (named) return named;
	const t = object(target);
	return TARGET_KINDS.find(([id, alias]) => t[id] ?? t[alias])?.[2];
}

/** Program states reported anywhere inside the status payload, bounded in depth and count. */
function reportedStates(value: unknown, depth: number, states: string[]): string[] {
	if (depth > 3 || states.length >= 4) return states;
	const entries = Array.isArray(value) ? value.map((item) => ["", item] as const) : Object.entries(object(value));
	for (const [key, entry] of entries) {
		if (key === "state" && typeof entry === "string") states.push(entry);
		else if (entry !== null && typeof entry === "object") reportedStates(entry, depth + 1, states);
	}
	return states;
}

/** rex_status leads with actual host activity, reported program states, and the caller's binding. */
function statusSummaryLines(name: string, data: Record<string, unknown>): Line[] {
	if (name !== "rex_status") return [];
	const lines: Line[] = [];
	const activity = object(data.hostActivity);
	if (activity.host)
		lines.push(
			line(
				`Host ${string(activity.host)} · ${string(activity.state) ?? "state unknown"}${number(activity.omittedTasks) > 0 ? ` · ${activity.omittedTasks} tasks outside snapshot` : ""}`,
				"toolOutput",
			),
		);
	const states = reportedStates(data.reportedStatus, 0, []);
	if (states.length) lines.push(line(`Reported: ${[...new Set(states)].join(", ")}`, "toolOutput"));
	const binding = object(data.binding);
	const bound = object(binding.target);
	lines.push(line(binding.target ? `Binding: ${string(bound.blockId) ? "block" : "target"} bound` : "Binding: none", "muted"));
	return lines;
}

function deadlineLine(name: string, request: Record<string, unknown>): Line[] {
	return name === "rex_wait" && typeof request.timeoutMs === "number" ? [line(`deadline ${request.timeoutMs} ms`, "muted")] : [];
}

function terminalQualifications(name: string, request: Record<string, unknown>, value: Record<string, unknown>): Line[] {
	const lines: Line[] = [];
	if (request.op === "input" || value.outcome === "input_delivered") lines.push(line("Input delivery is not application execution.", "muted"));
	if (name === "rex_wait") lines.push(line(value.outcome === "timeout" ? "Observer deadline; terminal work remains independent." : "Observer end does not stop terminal work.", "muted"));
	if (request.op === "inspect" && request.view === "capture") lines.push(line("Bounded capture, not a complete transcript.", "muted"));
	return lines;
}

function authorityQualifications(name: string, request: Record<string, unknown>, value: Record<string, unknown>): Line[] {
	const lines: Line[] = [];
	if (name === "rex_owned" && ["owned", "observe"].includes(String(request.op))) lines.push(line("Stored phase is not live presence or cleanup permission.", "muted"));
	if (name === "rex_owned" && request.op === "observe") lines.push(line("Observation does not stop work or establish task success.", "muted"));
	if (name === "rex_status") lines.push(line("Reported status is not permission or task acceptance.", "muted"));
	if (name === "rex_native" && ["api", "lua", "action"].includes(String(request.kind)) && value.ok) lines.push(line("CLI success is not inner application success.", "muted"));
	return lines;
}

function ownedObservationLines(name: string, request: Record<string, unknown>, data: Record<string, unknown>, expanded: boolean): Line[] {
	if (name !== "rex_owned" || request.op !== "observe" || expanded || !Array.isArray(data.reports)) return [];
	const count = data.reports.length;
	return data.reports.flatMap((value, index) => reportLines(object(value), count > 1 ? `#${index + 1} · ` : ""));
}

/** One owned record as the collapsed card shows it: stored phase and current child evidence, without its identity. */
function reportLines(report: Record<string, unknown>, prefix: string): Line[] {
	const observations = Array.isArray(report.observations) ? report.observations : [];
	const observation = object(observations[0]);
	const exit = object(object(observation.process).last_exit).exit_code;
	const facts = [string(observation.presence), string(observation.childState) ? `child ${observation.childState}` : undefined, typeof exit === "number" ? `exit ${exit}` : undefined].filter(Boolean).join(" · ");
	const lines = [line(`${prefix}stored ${report.phase} · ${facts || "unresolved"}`, "toolOutput")];
	const error = report.error ?? observation.error ?? observation.processError ?? observation.statusError ?? observation.captureError;
	if (typeof error === "string") lines.push(line(error, "muted", true));
	const capture = string(object(observation.capture).content);
	if (capture) lines.push(line(capture.trimEnd().split("\n").at(-1) ?? "", "toolOutput", true));
	if (observations.length > 1) lines.push(line(`${observations.length - 1} more resource observations in the complete result.`, "muted"));
	return lines;
}

function omissionLines(coverage: Record<string, unknown>, data: Record<string, unknown>): Line[] {
	const omitted: string[] = [];
	if (coverage.dataOmitted) omitted.push("bulk data omitted");
	if (Array.isArray(coverage.truncatedFields) && coverage.truncatedFields.length) omitted.push("diagnostics shortened");
	if (number(coverage.omittedRecordRefs) > 0) omitted.push(`${coverage.omittedRecordRefs} record references omitted`);
	if (number(coverage.omittedRecords) > 0) omitted.push(`${coverage.omittedRecords} records outside this page`);
	if (number(data.omittedMethods) > 0) omitted.push(`${data.omittedMethods} methods outside this page`);
	if (coverage.truncated && omitted.length === 0) omitted.push("source output is incomplete");
	return omitted.length ? [line(omitted.join(" · "), "muted")] : [];
}

function countLines(coverage: Record<string, unknown>, data: Record<string, unknown>): Line[] {
	const lines: Line[] = [];
	if (typeof coverage.returnedRecords === "number" && typeof coverage.totalRecords === "number") lines.push(line(`${coverage.returnedRecords} of ${coverage.totalRecords} records`, "muted"));
	if (typeof data.returnedMethods === "number" && typeof data.matchedMethods === "number") lines.push(line(`${data.returnedMethods} of ${data.matchedMethods} methods · ${data.totalMethods} installed`, "muted"));
	const next = coverage.nextOffset ?? data.nextOffset;
	if (typeof next === "number") lines.push(line(`next offset ${next}`, "muted"));
	return lines;
}

/** Collapsed: the error, notes and a two-line capture preview. Expanded: exact identities, then the complete bounded result. */
function resultDetails(value: Record<string, unknown>, effects: Record<string, unknown>, coverage: Record<string, unknown>, data: Record<string, unknown>, expanded: boolean): Line[] {
	const lines: Line[] = [];
	if (string(value.error)) lines.push(line(String(value.error), "error", true));
	if (!expanded) {
		if (string(effects.note)) lines.push(line(String(effects.note), "muted", true));
		if (string(coverage.note)) lines.push(line(String(coverage.note), "muted", true));
		const capture = string(data.content) ?? string(object(data.snapshot).content);
		if (capture) lines.push(...capture.split("\n").slice(0, 2).map((part) => line(part, "toolOutput", true)));
		return lines;
	}
	lines.push(line(""), line("Details", "muted"));
	const target = targetText(value.target);
	if (target) lines.push(line(`target ${target}`, "muted"));
	if (string(effects.recordId)) lines.push(line(`record ${effects.recordId}`, "muted"));
	lines.push(...identityDetails(data));
	const state = effects.state;
	lines.push(line(state === "unknown" ? "effects UNKNOWN" : state === "confirmed" ? "effects confirmed" : "no effects", state === "unknown" ? "warning" : "muted"));
	lines.push(line(""), ...jsonLines(value));
	return lines;
}

/** The exact bound target, its verification time and owner. */
function bindingDetail(data: Record<string, unknown>): Line[] {
	const binding = object(data.binding);
	if (!binding.target) return [];
	const owner = string(binding.ownerId) ? ` · owner ${binding.ownerId}` : "";
	return [line(`binding ${targetText(object(binding.target)) || "target"} · verified ${string(binding.verifiedAt) ?? "unknown time"}${owner}`, "muted")];
}

/** Each observed record identity, numbered as in the collapsed rows when there is more than one. */
function recordDetails(data: Record<string, unknown>): Line[] {
	if (!Array.isArray(data.reports)) return [];
	const numbered = data.reports.length > 1;
	return data.reports.flatMap((value, index) => {
		const id = string(object(value).recordId);
		return id ? [line(`${numbered ? `#${index + 1} ` : ""}record ${id}`, "muted")] : [];
	});
}

/** Exact binding and owned-record identities that the collapsed lines summarise. */
function identityDetails(data: Record<string, unknown>): Line[] {
	return [...bindingDetail(data), ...recordDetails(data)];
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function number(value: unknown): number { return typeof value === "number" ? value : 0; }
function safe(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]|\p{Cs}/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function line(text: string, colour: ThemeColor = "toolOutput", preview = false): Line { return { text: safe(text), colour, preview }; }
function targetText(value: unknown): string {
	const target = object(value);
	const id = string(target.blockId) ?? string(target.block) ?? string(target.windowId) ?? string(target.window) ?? string(target.sessionId) ?? string(target.session) ?? string(target.clientId) ?? string(target.client);
	const source = string(target.source);
	const server = string(target.server) ?? string(object(target.server).endpoint);
	return [id, source ? `${source} target` : undefined, server].filter(Boolean).join(" · ");
}
function canonicalResult(text: string): Record<string, unknown> | undefined {
	try {
		const value = object(JSON.parse(text));
		return typeof value.ok === "boolean" && typeof value.outcome === "string" && ["none", "confirmed", "unknown"].includes(String(object(value.effects).state)) && object(value.coverage).bounded === true ? value : undefined;
	} catch { return undefined; }
}
function jsonLines(value: unknown): Line[] {
	return (JSON.stringify(value, null, 2) ?? "null").split("\n").map((text) => line(text));
}
function card(lines: Line[], theme: CardTheme): Component {
	let cachedWidth: number | undefined;
	let cached: string[] = [];
	return {
		invalidate() { cachedWidth = undefined; },
		render(width) {
			if (width <= 0) return [];
			if (cachedWidth === width) return cached;
			cachedWidth = width;
			cached = lines.flatMap((entry) => {
				// Input is plain escaped text. Remove only the utility's SGR reset before applying the row colour.
				const rows = entry.preview ? [truncateToWidth(entry.text, width, "…").replaceAll("\u001b[0m", "")] : wrapTextWithAnsi(entry.text, width);
				return rows.map((row) => theme.fg(entry.colour, row));
			});
			return cached;
		},
	};
}
