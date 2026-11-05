import {
	createCodemodeExtension,
	createReadToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	createGrepToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	type ExtensionAPI,
	type AgentToolResult,
	type Theme,
	type ToolDefinition,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { Container, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { obj } from "@earendil-works/pi-schema";
import { createAgentToolCards, type AgentCardLookup } from "./tool-cards.ts";
import type { ToolDisplayLookup } from "./tool-display.ts";

/** Capture presentation only. Unexpected factory API access fails closed. */
export function captureCodemodeRenderers(): ToolRenderers {
	const definitions: ToolDefinition[] = [];
	const standIn = new Proxy({
		registerTool: ((definition: ToolDefinition) => { definitions.push(definition); }) as ExtensionAPI["registerTool"],
	} satisfies Pick<ExtensionAPI, "registerTool">, {
		get(target, property) {
			if (property === "registerTool") return target.registerTool;
			throw new Error(`Codemode capture requested unsupported API: ${String(property)}`);
		},
	});
	const returned = createCodemodeExtension()(standIn as ExtensionAPI);
	if (returned && typeof (returned as PromiseLike<void>).then === "function") {
		void Promise.resolve(returned).catch(() => undefined);
		throw new Error("Codemode renderer capture became asynchronous");
	}
	const definition = definitions.length === 1 ? definitions[0] : undefined;
	if (definition?.name !== "codemode" || typeof definition.renderCall !== "function" || typeof definition.renderResult !== "function" ||
		(definition.renderShell !== undefined && definition.renderShell !== "default" && definition.renderShell !== "self")) {
		throw new Error("Codemode renderer capture unavailable");
	}
	return { renderCall: definition.renderCall, renderResult: definition.renderResult, renderShell: definition.renderShell };
}

let captured = false;
let codemode: ToolRenderers | undefined;
function codemodeRenderers(): ToolRenderers | undefined {
	if (!captured) {
		captured = true;
		try { codemode = captureCodemodeRenderers(); } catch { /* Pi's standard card remains available. */ }
	}
	return codemode;
}

async function cannotExecute(): Promise<never> {
	throw new Error("Transcript tools cannot execute");
}

/** Dashboard tools draw no outer colour block; the transcript owns the reading margin. */
function presentationFields(presentation: ToolRenderers | undefined): ToolRenderers {
	return {
		...(presentation?.renderCall === undefined ? {} : { renderCall: presentation.renderCall }),
		...(presentation?.renderResult === undefined ? {} : { renderResult: presentation.renderResult }),
		renderShell: "self",
	};
}

type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
type CallContext = Parameters<CallRenderer>[2];
type ResultContext = Parameters<ResultRenderer>[3];
type SummaryResult = AgentToolResult<unknown>;

function singleLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

const ARGUMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
	bash: ["command"], powershell: ["command"],
	read: ["path"], write: ["path"], edit: ["path"], ls: ["path"],
	grep: ["pattern", "path"], find: ["pattern", "path"],
};
const DEFAULT_ARGUMENT_KEYS = ["command", "path", "pattern", "query", "code", "message", "prompt", "name"];
const FILE_TOOLS = new Set(["read", "write", "edit", "ls"]);
const BASH_TOOLS = new Set(["bash", "powershell"]);
const JSON_OUTCOME_KEYS = ["outcome", "status", "state", "error"] as const;

function withoutTrailingSlash(value: string): string {
	return value.replace(/\/+$/u, "");
}

/** Display-only shortening: a path inside the cwd is relative, one under home starts with `~/`. */
function shortenPaths(text: string, cwd: string): string {
	let value = text;
	const base = withoutTrailingSlash(cwd);
	if (base) value = value.split(`${base}/`).join("");
	const home = withoutTrailingSlash(homedir());
	if (home) value = value.split(`${home}/`).join("~/");
	return value;
}

/** Drop a leading `cd <cwd> && `; any other leading cd keeps its shortened path. */
function bashCommand(command: string, cwd: string): string {
	const trimmed = command.trim();
	const base = withoutTrailingSlash(cwd);
	const match = /^cd\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*&&\s*([\s\S]+)$/u.exec(trimmed);
	if (base && match && withoutTrailingSlash(match[1] ?? match[2] ?? match[3] ?? "") === base) return shortenPaths(match[4], cwd);
	return shortenPaths(trimmed, cwd);
}

function displayArgument(name: string, value: string, cwd: string): string {
	if (BASH_TOOLS.has(name)) return bashCommand(value, cwd);
	if (FILE_TOOLS.has(name)) return shortenPaths(value, cwd);
	return value;
}

/** The one useful argument for a tool summary, chosen by the tool's own vocabulary. */
function argumentText(name: string, args: unknown, cwd: string): string {
	if (typeof args === "string") return displayArgument(name, singleLine(args), cwd);
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	const record = args as Record<string, unknown>;
	for (const key of ARGUMENT_KEYS[name] ?? DEFAULT_ARGUMENT_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return displayArgument(name, singleLine(value), cwd);
	}
	for (const value of Object.values(record)) if (typeof value === "string" && value.trim()) return singleLine(value);
	return "";
}

/** A result whose whole text is one JSON object; other text keeps the plain-text presentation. */
function jsonObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
	try {
		const value: unknown = JSON.parse(trimmed);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** A JSON object result shows its first named status field; no field means no outcome. */
function jsonOutcome(text: string): { found: boolean; value?: string } {
	const value = jsonObject(text);
	if (!value) return { found: false };
	for (const key of JSON_OUTCOME_KEYS) {
		const field = value[key];
		if (typeof field === "string" && field.trim()) return { found: true, value: singleLine(field) };
	}
	return { found: true };
}

const ERROR_DETAIL_KEYS = ["message", "detail", "reason", "description", "error", "errors"] as const;

/** The message inside an error payload, including a nested error object or array. */
function errorDetail(value: unknown, depth = 0): string | undefined {
	if (typeof value === "string") return singleLine(value) || undefined;
	if (depth >= 4 || !value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = errorDetail(item, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of ERROR_DETAIL_KEYS) {
		const found = errorDetail(record[key], depth + 1);
		if (found) return found;
	}
	return undefined;
}

/**
 * A failure always shows a message, whatever its payload: a message field, including a nested one, or
 * the payload text itself. The error colour marks the failure, and expansion keeps the full detail.
 */
function errorOutcome(text: string, partial: boolean): { text: string; error: boolean } {
	const object = jsonObject(text);
	const detail = object ? errorDetail(object) : firstMeaningfulLine(text)?.replace(/^\[error\]\s*/u, "");
	return { text: marked(detail || (object ? singleLine(text) : "") || "failed", partial), error: true };
}

function resultText(result: SummaryResult): string {
	return result.content.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function fileArgument(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const path = (args as Record<string, unknown>).path;
	return typeof path === "string" && path.trim() ? path : undefined;
}

/** Drop a trailing ` in <path>` when the path is the tool's own file argument. */
function withoutPathSuffix(name: string, args: unknown, cwd: string, outcome: string): string {
	if (!FILE_TOOLS.has(name)) return outcome;
	const path = fileArgument(args);
	if (!path) return outcome;
	const resolved = isAbsolute(path) ? path : resolve(cwd, path);
	for (const suffix of [` in ${resolved}`, ` in ${path}`]) {
		if (outcome.endsWith(suffix)) return outcome.slice(0, -suffix.length);
	}
	return outcome;
}

function readOutcome(result: SummaryResult, partial: boolean): { text: string; error: boolean } {
	if (result.content.some((part) => part.type === "image")) return { text: partial ? "image…" : "image", error: false };
	const text = resultText(result);
	const count = text === "" ? 0 : text.replace(/\n$/u, "").split("\n").length;
	return { text: `${count} line${count === 1 ? "" : "s"}${partial ? "…" : ""}`, error: false };
}

function marked(text: string, partial: boolean): string {
	return partial ? `${text}…` : text;
}

/** The first line that says something: blank lines and lone markup tags such as `<harness>` are skipped. */
function firstMeaningfulLine(text: string): string | undefined {
	return text.split("\n").map(singleLine).find((line) => line.length > 0 && !/^<\/?[A-Za-z][\w.-]*>$/u.test(line));
}

/** The first non-empty result line, a named JSON status, a read line count or a read image. */
function resultOutcome(name: string, result: SummaryResult, partial: boolean, isError: boolean): { text: string; error: boolean } | undefined {
	if (name === "read" && !isError) return readOutcome(result, partial);
	const text = resultText(result);
	const json = jsonOutcome(text);
	if (json.found) {
		if (json.value) return { text: marked(json.value, partial), error: isError };
		return isError ? errorOutcome(text, partial) : undefined;
	}
	if (isError) return errorOutcome(text, partial);
	const first = firstMeaningfulLine(text);
	return first ? { text: marked(first, partial), error: false } : undefined;
}

/** One plain line: `name · args → outcome`, with the name bold and a failure in the error colour. */
class ToolSummaryLine implements Component {
	private readonly name: string;
	private readonly cwd: string;
	private theme?: Theme;
	private args: unknown;
	private result?: SummaryResult;
	private partial = false;
	private isError = false;
	constructor(name: string, cwd: string) {
		this.name = name;
		this.cwd = cwd;
	}
	setCall(args: unknown, theme: Theme): void {
		this.args = args;
		this.theme = theme;
	}
	setResult(result: SummaryResult, partial: boolean, theme: Theme, isError: boolean): void {
		this.result = result;
		this.partial = partial;
		this.isError = isError;
		this.theme = theme;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const theme = this.theme;
		if (!theme) return [];
		const limit = Math.max(1, width);
		const name = theme.fg("toolTitle", theme.bold(this.name));
		const nameWidth = visibleWidth(name);
		const outcome = this.result ? resultOutcome(this.name, this.result, this.partial, this.isError) : undefined;
		const outcomeValue = !this.result ? "pending" : outcome ? shortenPaths(withoutPathSuffix(this.name, this.args, this.cwd, outcome.text), this.cwd) : undefined;
		const outcomeRoom = Math.max(1, limit - nameWidth - 3);
		const outcomePart = outcomeValue === undefined
			? ""
			: theme.fg(outcome?.error === true ? "error" : "muted", ` → ${truncateToWidth(outcomeValue, Math.min(40, outcomeRoom), "…")}`);
		const argument = argumentText(this.name, this.args, this.cwd);
		const argumentRoom = Math.max(0, limit - nameWidth - visibleWidth(outcomePart) - 3);
		const argumentPart = argument && argumentRoom > 0 ? theme.fg("muted", ` · ${truncateToWidth(argument, argumentRoom, "…")}`) : "";
		return [truncateToWidth(`${name}${argumentPart}${outcomePart}`, limit, "…")];
	}
}

const noLines: Component = { render: () => [], invalidate: () => {} };

/** Expanded fallback for a tool with no renderer: the call arguments and the full text output. */
function fallbackArguments(args: unknown): string {
	if (typeof args === "string") return singleLine(args);
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	return Object.entries(args as Record<string, unknown>).map(([key, value]) => {
		if (typeof value === "string") return `${key}: ${singleLine(value)}`;
		try { return `${key}: ${JSON.stringify(value)}`; } catch { return `${key}: ?`; }
	}).join(" ");
}

function expandedCall(name: string, args: unknown, theme: Theme, context: CallContext, presentation: ToolRenderers | undefined): Component {
	if (presentation?.renderCall) return presentation.renderCall(args, theme, context);
	const argument = fallbackArguments(args);
	return new Text(`${theme.fg("toolTitle", theme.bold(name))}${argument ? ` ${theme.fg("toolOutput", argument)}` : ""}`, 0, 0);
}

function expandedResult(result: SummaryResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ResultContext, presentation: ToolRenderers | undefined): Component {
	if (presentation?.renderResult) return presentation.renderResult(result, options, theme, context);
	const text = result.content.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
	return text ? new Text(theme.fg("toolOutput", text), 0, 0) : new Container();
}

/**
 * Collapsed dashboard tools are one summary line. The native renderer keeps the expanded presentation,
 * so a renderer's own semantic styling survives and only the outer colour block is gone.
 */
function summarisedRenderers(name: string, presentation: ToolRenderers | undefined, cwd: string): ToolRenderers {
	const renderCall: CallRenderer = (args, theme, context) => {
		if (context.expanded) return expandedCall(name, args, theme, context, presentation);
		const state = context.state as { summary?: ToolSummaryLine };
		const line = state.summary instanceof ToolSummaryLine ? state.summary : new ToolSummaryLine(name, cwd);
		state.summary = line;
		line.setCall(args, theme);
		return line;
	};
	const renderResult: ResultRenderer = (result, options, theme, context) => {
		if (options.expanded) return expandedResult(result, options, theme, context, presentation);
		const state = context.state as { summary?: ToolSummaryLine };
		state.summary?.setResult(result, options.isPartial, theme, context.isError);
		return noLines;
	};
	return { renderShell: "self", renderCall, renderResult };
}

/**
 * Renderer identities stay stable so a result-first card keeps its component when the call arrives.
 * The key includes the cwd, because summaries show paths relative to the agent's own directory.
 */
const wrappedRenderers = new WeakMap<object, Map<string, ToolRenderers>>();
const unknownPresentation = {};
function dashboardRenderers(name: string, presentation: ToolRenderers | undefined, cwd: string): ToolRenderers {
	const owner = presentation ?? unknownPresentation;
	let byKey = wrappedRenderers.get(owner);
	if (!byKey) {
		byKey = new Map();
		wrappedRenderers.set(owner, byKey);
	}
	const key = `${cwd}\u0000${name}`;
	let cached = byKey.get(key);
	if (!cached) {
		cached = summarisedRenderers(name, presentation, cwd);
		byKey.set(key, cached);
	}
	return cached;
}

/** Dashboard agent cards keep their two-line header and lose the expansion hint under the card. */
const agentWrappers = new WeakMap<object, ToolRenderers>();
function dashboardAgentRenderers(presentation: ToolRenderers | undefined): ToolRenderers {
	if (!presentation) return presentationFields(undefined);
	const cached = agentWrappers.get(presentation);
	if (cached) return cached;
	const call = presentation.renderCall;
	const result = presentation.renderResult;
	const wrapped: ToolRenderers = {
		renderShell: "self",
		...(call ? { renderCall: (args, theme, context) => {
			const enriched = { ...context, hideExpansionHint: true };
			return call(args, theme, enriched);
		} } : {}),
		...(result ? { renderResult: (value, options, theme, context) => {
			const enriched = { ...context, hideExpansionHint: true };
			return result(value, options, theme, enriched);
		} } : {}),
	};
	agentWrappers.set(presentation, wrapped);
	return wrapped;
}

/** The shared presentation for one tool, before the dashboard shell is applied. */
function toolPresentation(name: string, knownCall: boolean, native: ReadonlyMap<string, unknown>, agents: Record<string, ToolRenderers>, renderers: ToolRenderers | undefined, toolDisplay?: ToolDisplayLookup): ToolRenderers | undefined {
	if (native.has(name)) return knownCall ? (native.get(name) as ToolDefinition | undefined) : undefined;
	if (name === "codemode") return renderers;
	if (Object.hasOwn(agents, name)) return agents[name];
	return toolDisplay?.(name);
}

/**
 * Native and shared presentation with no execution or loadout hooks. `rows` supplies the already-observed
 * roster facts (names, applied configuration) that agent cards show for their targets; it reads no store.
 * Every dashboard definition uses the self-render shell, so no dashboard tool draws an outer colour block.
 */
export function createDashboardToolDefinitions(cwd: string, toolDisplay?: ToolDisplayLookup, rows: AgentCardLookup = () => []): (name: string, knownCall?: boolean) => ToolDefinition {
	const native = new Map([
		createReadToolDefinition(cwd), createBashToolDefinition(cwd), createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd), createGrepToolDefinition(cwd), createFindToolDefinition(cwd),
		createLsToolDefinition(cwd), createPowerShellToolDefinition(cwd),
	].map((definition) => [definition.name, definition]));
	const agents = createAgentToolCards(rows) as Record<string, ToolRenderers>;
	const renderers = codemodeRenderers();
	return (name, knownCall = true) => {
		const builtin = knownCall ? native.get(name) : undefined;
		const presentation = toolPresentation(name, knownCall, native, agents, renderers, toolDisplay);
		return {
			name, label: builtin?.label ?? name, description: builtin?.description ?? "Retained tool display",
			parameters: builtin?.parameters ?? obj({}, { open: true }),
			...(Object.hasOwn(agents, name) ? dashboardAgentRenderers(presentation) : dashboardRenderers(name, presentation, cwd)),
			execute: cannotExecute,
		};
	};
}
