/**
 * Agent cards render tool call arguments and retained results from native
 * Durable observation values, plus the `agent.peer` message notices the
 * manager returns to the primary and the ordinary session's own
 * `agent.compaction` and `agent.planning-budget` notices, and the package's
 * `application-message` transcript cards.
 * Target labels use roster facts already observed by the primary footer.
 * Rendering opens no storage and changes no execution behavior.
 */
import { homedir } from "node:os";
import { sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { ProviderBlockFactSchema, providerBlockSummary, providerBlockText } from "./provider-block-facts.ts";
import { matchesSchema } from "./schema-check.ts";
import type { AgentToolResult, MessageRenderer, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, type KeybindingHints } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { dashboardClock } from "./dashboard-time.ts";
import type { Communication } from "./communication.ts";
import { receiptContinuationLine, resultContinuationLines } from "./control-result.ts";
import { planningBudgetSelfFacts } from "./continuity-budget.ts";
import { THREAD_NOTICE_DISPLAY_UNITS, threadEventTitle } from "./thread-notice-display.ts";
import { threadRecoveryText, utcTime } from "./thread-notice-projection.ts";
import { renderBrief } from "./brief.ts";
import {
	toolCallCard,
	toolResultCard,
	type ToolCardGrammarContext,
	type ToolResultPresentation,
} from "./tool-card-grammar.ts";

/**
 * Observed display facts for cards: the roster rows, and in the dashboard also known thread titles and
 * participant names. Every lookup is optional; an unknown value keeps the exact identity.
 */
export type AgentCardLookup = (() => readonly AgentConversationSummary[]) & {
	readonly threadTitle?: (id: string) => string | undefined;
	readonly nameFor?: (identity: string) => string | undefined;
	/** The model of an agent or main session the view has observed, for identities beyond the roster rows. */
	readonly modelFor?: (identity: string) => AgentConversationSummary["model"] | undefined;
};

/** Bytes/units bounds for one expanded display block. */
export const SOURCE_DISPLAY_LIMIT = 32_000;
const MESSAGE_DISPLAY_LIMIT = 32_000;
const NOTICE_PREVIEW_LINES = 3;
const PREVIEW_UNITS = 600;

/**
 * Card context: the subset of `ToolRenderContext` these renderers read. Pi
 * injects `keyText` with the operator's configured keybindings.
 */
export interface AgentCardContext extends ToolCardGrammarContext {
	readonly args?: unknown;
	readonly lookup?: AgentCardLookup;
	readonly state?: NonNullable<ToolCardGrammarContext["state"]> & {
		callHint?: boolean;
		compaction?: Record<string, unknown>;
		compactFactsShown?: boolean;
		observation?: Record<string, unknown>;
		resultSeen?: unknown;
	};
	readonly executionStarted?: boolean;
	readonly isPartial?: boolean;
	readonly expanded: boolean;
	readonly argsComplete?: boolean;
	readonly isError?: boolean;
	readonly lastComponent?: Component;
	/** The dashboard owns disclosure and shows no navigation words under a collapsed card. */
	readonly hideExpansionHint?: boolean;
}

export interface AgentToolCard {
	renderCall(args: unknown, theme: Theme, context: AgentCardContext): Component;
	renderResult(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: AgentCardContext,
	): Component;
	/** `self` when the card draws its own background instead of Pi's tool outcome background. */
	readonly renderShell?: "default" | "self";
}

/**
 * Displayed text, as every harness message card draws it: terminal control and escape sequences and other
 * control or format characters are removed, so none reaches the terminal; newlines and tabs stay.
 */
export function displayText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : "",
	);
}

function displayPrefix(value: string, limit: number): string {
	const end = Math.min(value.length, limit);
	return value.slice(0, end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") ? end - 1 : end);
}

export function displayPreview(value: string, limit: number): string {
	const prefix = displayPrefix(value, limit);
	return displayText(prefix).replace(/\s+/gu, " ").trim() + (value.length > prefix.length ? "…" : "");
}

/** Escape the source prefix; the truncation notice sits outside the display bound. */
function boundedSource(value: string, limit = SOURCE_DISPLAY_LIMIT): string {
	const prefix = displayPrefix(value, limit);
	return (
		displayText(prefix) +
		(value.length > prefix.length
			? `\n[Display limit: ${value.length - prefix.length} more UTF-16 code units. Full text remains in native history.]`
			: "")
	);
}

/** Pi owns the row background; clipping must close text styles without ending it. */
function clipCardLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "…").replace(
		/\x1b\[0m…\x1b\[0m$/u,
		"…\x1b[22;23;24;25;27;28;29;39m",
	);
}

class CardText extends Text {
	private source = "";
	expanded = false;
	override setText(value: string): void {
		this.source = value;
		super.setText(value);
	}
	override render(width: number): readonly string[] {
		return this.expanded ? super.render(width) : this.source.split("\n").map((line) => clipCardLine(line, width));
	}
}

interface CardSections {
	/** The bracket label of a transcript message, drawn before the title in Pi's custom message label colour. */
	readonly tag?: string;
	readonly title?: string;
	readonly label?: string;
	readonly metadata?: readonly string[];
	readonly body?: readonly (string | Component)[];
	/** A transcript card can replace its preview body with the complete source on expansion. */
	readonly expandedBody?: () => readonly (string | Component)[];
	/** Peer cards build and show these lines only while expanded, globally or by a click on the card. */
	readonly details?: () => readonly (string | Component)[];
	readonly limit?: string;
	readonly outcome?: readonly string[];
	readonly hint?: string;
	readonly previewLines?: number;
}

interface CardLayoutOptions {
	readonly expanded: boolean;
	readonly previous?: Component;
	readonly peerPadding?: number;
	readonly peerTitleColor?: "customMessageText";
	/** Peer cards draw their own expansion hint below hidden lines. */
	readonly keys?: Pick<KeybindingHints, "keyText"> & Partial<Pick<KeybindingHints, "keyHint">>;
	readonly fitHint?: boolean;
	/** The stable message object a peer card's pointer disclosure is bound to; absent, the choice lives in the renderer only. */
	readonly message?: object;
}

/**
 * Where one card keeps its pointer disclosure between renderer instances. `get` answers the choice made
 * under the given global expansion, or undefined when none applies; a deliberate global change wins.
 */
export interface CardDisclosure {
	get(global: boolean): boolean | undefined;
	set(expanded: boolean, global: boolean): void;
}

const disclosures = new WeakMap<object, CardDisclosure>();

/** Bind a message object to a disclosure store owned by its view; the store is released with the message. */
export function bindCardDisclosure(message: object, disclosure: CardDisclosure): void {
	disclosures.set(message, disclosure);
}

/** A choice made under one global expansion; a different global value discards it. */
function localDisclosure(): CardDisclosure {
	let choice: { expanded: boolean; under: boolean } | undefined;
	return {
		get: (global) => {
			if (choice && choice.under !== global) choice = undefined;
			return choice?.expanded;
		},
		set: (expanded, under) => {
			choice = { expanded, under };
		},
	};
}

/** Ordinary notices keep their choice with the stored message object Pi hands to every rebuild. */
function disclosureFor(message: object | undefined): CardDisclosure {
	if (!message) return localDisclosure();
	let store = disclosures.get(message);
	if (!store) {
		store = localDisclosure();
		disclosures.set(message, store);
	}
	return store;
}

/** Tool parts inherit Pi's Box(1,1); custom-message renderers must supply that inner vertical padding. */
/** The title line and the muted facts line; message cards draw their bracket label in Pi's label colour. */
function cardHeader(sections: CardSections, theme: Theme, options: CardLayoutOptions): string[] {
	const peer = options.peerPadding !== undefined;
	const header: string[] = [];
	const tag = sections.tag ? `${theme.fg("customMessageLabel", theme.bold(sections.tag))} ` : "";
	const label = sections.label
		? theme.fg(peer ? "text" : "accent", ` · ${displayText(sections.label).replace(/\s+/gu, " ").trim()}`)
		: "";
	if (sections.title) {
		const titleColor = peer ? (options.peerTitleColor ?? "text") : "toolTitle";
		header.push(tag + theme.fg(titleColor, theme.bold(sections.title)) + label);
	}
	const metadata = sections.metadata
		?.filter(Boolean)
		.map((value) => displayText(value).replace(/\s+/gu, " ").trim())
		.join(" · ");
	if (metadata) header.push(theme.fg("muted", metadata));
	return header;
}

function cardLayout(sections: CardSections, theme: Theme, options: CardLayoutOptions): Component {
	const peer = options.peerPadding !== undefined;
	const header = cardHeader(sections, theme, options);
	const content = sections.body ?? [];
	if (!peer) {
		const component = options.previous instanceof CardText ? options.previous : new CardText("", 0, 0);
		component.expanded = options.expanded;
		component.setText(
			[
				...header,
				...content.filter((line): line is string => typeof line === "string"),
				...(sections.outcome ?? []),
				...(sections.hint ? [theme.fg("muted", sections.hint)] : []),
			].join("\n"),
		);
		return component;
	}
	const box = new Box(options.peerPadding, 1, (line) =>
		theme.bg(
			"customMessageBg",
			line.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + theme.getBgAnsi("customMessageBg")),
		),
	);
	const body = new PeerCardBody(header, content, sections, theme, options);
	box.addChild(body);
	return box;
}

/**
 * The peer card body: a preview with its disclosure hint, or the complete body and details. A left click
 * anywhere on the card toggles this card alone, as Pi's compaction and tool cards toggle on a left click;
 * a drag still selects text, because Pi sends no click for it. Pi's global expansion rebuilds the card and
 * resets that local choice.
 */
class PeerCardBody implements Component {
	private expanded: boolean;
	private fullBody?: readonly (string | Component)[];
	private details?: readonly (string | Component)[];
	private readonly header: readonly string[];
	private readonly content: readonly (string | Component)[];
	private readonly sections: CardSections;
	private readonly theme: Theme;
	private readonly options: CardLayoutOptions;
	private readonly disclosure: CardDisclosure;
	constructor(
		header: readonly string[],
		content: readonly (string | Component)[],
		sections: CardSections,
		theme: Theme,
		options: CardLayoutOptions,
	) {
		this.header = header;
		this.content = content;
		this.sections = sections;
		this.theme = theme;
		this.options = options;
		this.disclosure = disclosureFor(options.message);
		this.expanded = this.disclosure.get(options.expanded) ?? options.expanded;
	}
	private static lines(parts: readonly (string | Component)[], width: number): string[] {
		return parts.flatMap((part) =>
			typeof part === "string" ? new Text(part, 0, 0).render(width) : part.render(width),
		);
	}
	/** Details are built on the first expanded paint and kept for the life of the card. */
	private detailLines(width: number): string[] {
		if (!this.expanded) return [];
		this.details ??= this.sections.details?.() ?? [];
		return PeerCardBody.lines(this.details, width);
	}
	private hint(hidden: number): string {
		if (this.sections.hint) return this.theme.fg("muted", this.sections.hint);
		return !this.expanded &&
			(hidden > 0 || this.sections.details !== undefined || this.sections.expandedBody !== undefined)
			? peerHint(this.theme, this.options.keys, hidden)
			: "";
	}
	render(width: number): string[] {
		if (this.expanded) this.fullBody ??= this.sections.expandedBody?.();
		const lines = PeerCardBody.lines((this.expanded && this.fullBody) || this.content, width);
		const shown = this.expanded ? lines : previewWindow(lines, this.sections.previewLines ?? lines.length);
		const hidden = Math.max(0, lines.length - shown.length);
		const counted = this.hint(hidden);
		const hint = this.options.fitHint && visibleWidth(counted) > width ? this.hint(0) : counted;
		const rows = [
			...this.header.map((line) => clipCardLine(line, width)),
			...(this.header.length ? [""] : []),
			...shown,
			...this.detailLines(width),
			...(this.sections.limit ? new Text(this.theme.fg("warning", this.sections.limit), 0, 0).render(width) : []),
			...(this.sections.outcome ?? []),
		];
		return hint ? [...rows, clipCardLine(hint, width)] : rows;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.expanded = !this.expanded;
		this.disclosure.set(this.expanded, this.options.expanded);
		this.invalidate();
		return { handled: true };
	}
	invalidate(): void {
		for (const part of this.content) if (typeof part !== "string") part.invalidate();
		for (const part of this.fullBody ?? []) if (typeof part !== "string") part.invalidate();
		for (const part of this.details ?? []) if (typeof part !== "string") part.invalidate();
	}
}

function expansionHint(keys: Pick<KeybindingHints, "keyText"> | undefined): string {
	const key = keys?.keyText("app.tools.expand");
	return key ? `... (${key} to expand)` : "... (expand for full details)";
}

/** The first visual lines of a body, with a blank line between paragraphs counted and blank lines at the end dropped. */
function previewWindow(lines: readonly string[], limit: number): string[] {
	const window = lines.slice(0, limit);
	while (window.length > 0 && stripVTControlCharacters(window[window.length - 1] ?? "").trim() === "") window.pop();
	return window;
}

/**
 * Pi's tool-card hint for a message card: `... (2 more lines, ctrl+o to expand)` with the key dimmed and the
 * rest muted, or `... (ctrl+o to expand)` when only source details are hidden.
 */
function peerHint(theme: Theme, keys: CardLayoutOptions["keys"], hidden: number): string {
	const key = keys?.keyText("app.tools.expand") ?? "";
	const more = hidden > 0 ? `${hidden} more line${hidden === 1 ? "" : "s"}, ` : "";
	const action = !key
		? theme.fg("muted", "click to expand")
		: typeof keys?.keyHint === "function"
			? keys.keyHint("app.tools.expand", "to expand")
			: theme.fg("dim", key) + theme.fg("muted", " to expand");
	return theme.fg("muted", `... (${more}`) + action + theme.fg("muted", ")");
}

/** Calls own the hint before execution; results own it after execution starts. */
function cardHint(context: AgentCardContext, part: "call" | "result", _subject: string): string {
	if (context.hideExpansionHint) return "";
	if (context.expanded) return "";
	if (part === "call") {
		const shown = context.executionStarted !== true && context.argsComplete !== false;
		if (context.state) context.state.callHint = shown;
		return shown ? expansionHint(context) : "";
	}
	if (context.state?.callHint && context.executionStarted !== true) return "";
	return expansionHint(context);
}

function displayIdentity(identity: string): string {
	return displayText(identity);
}

function modelCaption(model: AgentConversationSummary["model"]): string {
	return model ? resolvedModelLine(model.provider, model.modelId, model.thinkingLevel ?? "") : "";
}

function targetConfiguration(identity: string, context: AgentCardContext): string {
	return displayText(modelCaption(findTarget(identity, context.lookup?.() ?? [])?.model));
}

function findTarget(identity: string, rows: readonly AgentConversationSummary[]): AgentConversationSummary | undefined {
	return rows.find((item) => item.id === identity || (identity.startsWith("@") && item.profile?.handle === identity));
}

function targetLabel(identity: string, context: AgentCardContext): string {
	if (!identity) return "";
	const rows = context.lookup?.() ?? [];
	const row = findTarget(identity, rows);
	if (!row) return displayIdentity(identity);
	const label = row.profile?.handle || row.name || row.id;
	const duplicate =
		!row.profile?.handle &&
		row.name &&
		rows.some(
			(other) =>
				other.id !== row.id &&
				other.name === row.name &&
				!other.profile?.handle &&
				modelCaption(other.model) === modelCaption(row.model),
		);
	return `${displayText(label)}${duplicate ? ` [${displayIdentity(row.id)}]` : ""}`;
}

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Entry, task, and submission identities are numbers in native data; render them as text. */
function identifier(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function firstDefined(...values: unknown[]): unknown {
	for (const value of values) if (value !== undefined) return value;
	return undefined;
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function resultDetails(result: AgentToolResult<unknown>): Record<string, unknown> {
	return record(firstDefined(record(result.details).structuredContent, result.structuredContent, result.details));
}

function resultPreview(value: string, limit = PREVIEW_UNITS): string {
	let output = value;
	try {
		const parsed = JSON.parse(value);
		if (parsed !== null && typeof parsed === "object") {
			const details = record(parsed);
			output = text(record(details.error).message) || text(details.error) || text(details.reason) || "Result received";
		}
	} catch {
		/* Plain output remains literal text. */
	}
	return displayText(displayPrefix(output, limit).split("\n").slice(0, 3).join("\n"));
}

function callIdentity(context: AgentCardContext): string {
	const args = record(context.args);
	return text(args.sessionId) || (text(args.handle) ? `@${text(args.handle).replace(/^@/u, "")}` : "");
}

function sameTarget(identity: string, context: AgentCardContext): boolean {
	const requested = callIdentity(context);
	return (
		identity !== "" && (identity === requested || identity === findTarget(requested, context.lookup?.() ?? [])?.id)
	);
}

function targetSuffix(identity: string, context: AgentCardContext): string {
	const name = findTarget(identity, context.lookup?.() ?? [])?.name ?? "";
	return !context.expanded && (sameTarget(identity, context) || headerHasName(identity, name, context))
		? ""
		: ` · ${targetLabel(identity, context)}`;
}

function snapshotFacts(context: AgentCardContext, snapshot: Record<string, unknown> | undefined): AgentCardContext {
	if (!snapshot) return context;
	const identity = text(snapshot.identity) || text(snapshot.sessionId);
	if (!identity) return context;
	const agent = record(snapshot.agent);
	const model = record(agent.model);
	const previous = context.lookup?.() ?? [];
	const known = previous.find((row) => row.id === identity);
	const row: AgentConversationSummary = {
		id: identity,
		storageId: identity.split(":")[0],
		name: text(snapshot.name) || known?.name,
		profile: known?.profile,
		cwd: text(snapshot.cwd),
		modifiedAt: 0,
		owner: "unknown",
		state: "unavailable",
		cost: 0,
		partial: false,
		model:
			text(model.provider) && text(model.modelId)
				? { provider: text(model.provider), modelId: text(model.modelId), thinkingLevel: text(agent.thinkingLevel) }
				: known?.model,
	};
	return { ...context, lookup: () => [row, ...previous.filter((item) => item.id !== identity)] };
}

function headerHasName(identity: string, name: string, context: AgentCardContext): boolean {
	const args = record(context.args);
	const observed = findTarget(callIdentity(context), context.lookup?.() ?? []);
	if (sameTarget(identity, context) && observed?.name === name) return true;
	return !callIdentity(context) && name !== "" && (args.name === name || args.topic === name);
}

function headerHasModel(
	identity: string,
	provider: string,
	modelId: string,
	thinking: string,
	context: AgentCardContext,
): boolean {
	if (!sameTarget(identity, context)) return false;
	const observed = findTarget(callIdentity(context), context.lookup?.() ?? [])?.model;
	return observed?.provider === provider && observed.modelId === modelId && observed.thinkingLevel === thinking;
}

// --- Call cards ------------------------------------------------------------------

function statusCallMode(args: Record<string, unknown>, identity: string): string {
	if (args.view === "fleet") {
		const provider = text(args.provider);
		if (text(args.model) && provider) return `fleet · provider filter ${displayText(provider)}`;
		return text(args.model) || provider ? "fleet" : "";
	}
	if (args.view === "storage-page") return args.cursor === undefined ? "storage page" : "storage page · continuation";
	if (args.detail === true) return "full detail";
	return identity ? "selected status" : "overview";
}

function statusSubject(args: Record<string, unknown>): string | undefined {
	if (args.view === "storage-page" && text(args.storageId)) return "storageId";
	if (args.view === "fleet") {
		if (text(args.model)) return "model";
		if (text(args.provider)) return "provider";
	}
	return undefined;
}

function statusCallSubject(
	args: Record<string, unknown>,
	context: AgentCardContext,
): { subject: string; key?: string } {
	const sessionId = text(args.sessionId);
	if (sessionId) return { subject: targetLabel(sessionId, context) };
	const key = statusSubject(args);
	return { key, subject: key ? text(args[key]) : args.view === "fleet" ? "fleet" : "" };
}

function renderStatusCall(
	name: string,
	args: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): Component {
	const sessionId = text(args.sessionId);
	const { subject, key } = statusCallSubject(args, context);
	const limit = count(args.limit);
	return toolCallCard(
		{
			name,
			subject,
			args,
			shownArgs: [
				...(sessionId && subject === sessionId ? ["sessionId"] : []),
				...(!sessionId && key ? [key] : []),
				...(args.view === "fleet" || args.view === "storage-page" ? ["view"] : []),
				...(args.view === "fleet" && args.model && args.provider ? ["provider"] : []),
				...(args.detail === true && !args.view ? ["detail"] : []),
				...(limit === undefined ? [] : ["limit"]),
			],
			facts: [
				targetConfiguration(sessionId, context),
				statusCallMode(args, sessionId),
				limit === undefined ? "" : `limit ${limit}`,
			],
			expanded: resolvedTargetFact(sessionId, context),
		},
		theme,
		context,
	);
}

function messageMetadata(args: Record<string, unknown>, context: AgentCardContext): string[] {
	const reply = text(args.replyTo) ? targetLabel(text(args.replyTo), context) : "";
	return [
		targetConfiguration(text(args.sessionId), context),
		reply ? `reply to ${reply}` : "",
		text(args.mode) ? `mode ${displayText(text(args.mode))}` : "",
	];
}

function localToolTime(value: number): string {
	const time = new Date(value);
	if (!Number.isFinite(time.getTime())) return "";
	const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(time);
	if (time.toDateString() === new Date().toDateString()) return clock;
	return `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(time)} ${clock}`;
}

function resolvedTargetFact(selector: string, context: AgentCardContext): string | undefined {
	const identity = findTarget(selector, context.lookup?.() ?? [])?.id;
	return identity && identity !== selector ? `  resolved target: ${identity}` : undefined;
}

export function renderSendCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const deadline = localToolTime(Date.parse(text(args.deliverAt)));
	const checkIn = count(args.checkInMinutes);
	const subject = targetLabel(text(args.sessionId), context);
	return toolCallCard(
		{
			name: "agent_send",
			subject,
			shownArgs: [
				...(subject === args.sessionId ? ["sessionId"] : []),
				...(targetLabel(text(args.replyTo), context) === args.replyTo ? ["replyTo"] : []),
				...(text(args.mode) ? ["mode"] : []),
				...(args.passive === true ? ["passive"] : []),
				...(checkIn === undefined ? [] : ["checkInMinutes"]),
			],
			facts: [
				...messageMetadata(args, context),
				args.passive === true ? "passive" : "",
				deadline ? `deliver at ${deadline}` : "",
				checkIn === undefined ? "" : checkIn === 0 ? "check-ins off" : `check-in ${checkIn} min`,
			],
			args,
			body: { key: "message", text: text(args.message) },
			expanded: resolvedTargetFact(text(args.sessionId), context),
		},
		theme,
		context,
	);
}

function intentObservation(details: Record<string, unknown>): Record<string, unknown> | undefined {
	const self = record(details.published ?? record(details.awareness).self);
	const identity = text(self.id);
	return identity
		? { identity, name: self.name, agent: { model: self.model, thinkingLevel: self.thinkingLevel } }
		: undefined;
}

function intentLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const identity = text(intentObservation(details)?.identity);
	if (!identity || context.isError === true || context.isPartial === true) return undefined;
	const outcome =
		details.published === undefined
			? "Related efforts read"
			: record(details.published).intentClaim === undefined
				? "Intent cleared"
				: "Intent published";
	return [theme.fg("toolOutput", `${outcome} · ${displayIdentity(identity)}`)];
}

function homePath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

function briefSectionFacts(args: Record<string, unknown>): string[] {
	const { counts } = renderBrief(args);
	return [
		counts.operator ? cardinal(counts.operator, "operator decision") : "",
		counts.sources ? cardinal(counts.sources, "source") : "",
	];
}

/** Select the actual object of the action and the arguments already visible on the card. */
export function renderAgentCall(name: string, value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	if (name === "agent_status") return renderStatusCall(name, args, theme, context);

	const shownArgs: string[] = [];
	const facts: string[] = [];
	const take = (key: string, prefix = "", format = (input: string) => input): string => {
		const input = identifier(args[key]);
		if (!input.trim()) return "";
		shownArgs.push(key);
		return prefix + format(input);
	};
	const flag = (key: string, label: string): string => {
		if (args[key] !== true) return "";
		shownArgs.push(key);
		return label;
	};
	const bodyFor = (...keys: string[]) => {
		const key = keys.find((key) => text(args[key]).trim());
		return key ? { key, text: text(args[key]) } : undefined;
	};
	let body: ReturnType<typeof bodyFor>;
	let expanded: string | undefined;
	let subject = "";
	const target = (key = "sessionId", format = (input: string) => input): string => {
		const selector = text(args[key]);
		if (!selector.trim()) return "";
		const identity = format(selector);
		const label = targetLabel(identity, context);
		if (identity === label) shownArgs.push(key);
		const extra = resolvedTargetFact(identity, context);
		if (extra) expanded = [expanded, extra].filter(Boolean).join("\n");
		return label;
	};
	const observedModel = () => targetConfiguration(callIdentity({ ...context, args }), context);
	const configuration = () => {
		const model = take("model");
		const level = take("thinkingLevel");
		const observed = observedModel();
		const configuration = findTarget(callIdentity({ ...context, args }), context.lookup?.() ?? [])?.model;
		const requested = [
			model === `${configuration?.provider}/${configuration?.modelId}` ? "" : model,
			level === configuration?.thinkingLevel ? "" : level,
		]
			.filter(Boolean)
			.join(" · ");
		facts.push(observed, requested && observed ? `requested ${requested}` : requested, take("preset", "preset "));
	};
	const creation = () => {
		configuration();
		const minutes = count(args.checkInMinutes);
		if (minutes !== undefined) {
			shownArgs.push("checkInMinutes");
			facts.push(minutes === 0 ? "check-ins off" : `check-in ${minutes} min`);
		}
	};

	switch (name) {
		case "agent_spawn":
		case "agent_brief": {
			subject = target() || target("handle", (input) => `@${input.replace(/^@/u, "")}`) || take("name");
			if (!shownArgs.includes("name")) facts.push(take("name", "name "));
			creation();
			facts.push(take("cwd", "in ", homePath));
			if (name === "agent_brief") {
				facts.push(take("kind"), take("mode", "mode "), flag("preview", "preview"), ...briefSectionFacts(args));
				body = bodyFor("objective");
			} else body = bodyFor("prompt", "role");
			break;
		}
		case "agent_attach":
		case "agent_configure":
			subject = target();
			configuration();
			facts.push(take("name", "name "));
			break;
		case "agent_place":
			subject = take("area", "", homePath) || "current directory";
			creation();
			facts.push(take("topic"));
			body = bodyFor("prompt");
			break;
		case "agent_fork":
		case "agent_rewind":
			subject = target();
			facts.push(observedModel(), take("entryId", "entry "), take("name", "name "));
			body = bodyFor(name === "agent_fork" ? "prompt" : "correction");
			break;
		case "agent_profile":
			subject = target() || "this session";
			facts.push(observedModel(), take("action"), take("expectedRevision", "revision "));
			body = bodyFor("role", "expertise");
			break;
		case "agent_steer": {
			subject = target();
			const reply = target("replyTo");
			facts.push(observedModel(), reply ? `reply to ${reply}` : "");
			body = bodyFor("message");
			break;
		}
		case "agent_compact":
			subject = target() || "this session";
			facts.push(observedModel(), text(args.summary).trim() ? "supplied summary" : "");
			body = bodyFor("summary", "instructions");
			break;
		case "agent_intent": {
			const identity = text(context.state?.observation?.identity);
			subject = args.action === "read" ? "related efforts" : identity ? targetLabel(identity, context) : "this session";
			facts.push(targetConfiguration(identity, context), take("action"));
			if (identity && identity !== subject) expanded = `  resolved session: ${identity}`;
			body = bodyFor("purpose");
			break;
		}
		case "agent_list":
			subject = take("query");
			if (subject) facts.push(take("cwd", "in ", homePath));
			else subject = take("cwd", "", homePath) || "stored conversations";
			facts.push(take("limit", "limit "), text(args.cursor) ? "continuation page" : "");
			break;
		case "agent_abort": {
			subject = target();
			const generation = count(record(args.interrupt).taskId);
			facts.push(
				observedModel(),
				take("timerId", "timer "),
				generation === undefined ? "" : `interrupt generation ${generation}`,
				flag("background", "includes same-storage children and background tasks"),
				flag("release", "release host"),
			);
			break;
		}
		case "agent_command": {
			subject = take("name");
			const recipient = target();
			facts.push(recipient ? `on ${recipient}` : "", observedModel());
			if (text(args.args).includes("\n")) body = bodyFor("args");
			else facts.push(take("args", "args "));
			break;
		}
		case "agent_inspect": {
			const query = take("query");
			const entry = take("entryId", "entry ");
			const operation = take("operationId", "operation ");
			const submission = take("submissionId", "submission ");
			const request = take("requestId", "request ");
			const recipient = target() || "this session";
			const objects = [query, entry, operation, submission, request].filter(Boolean);
			subject = objects.shift() || recipient;
			facts.push(
				subject === recipient ? "" : recipient,
				observedModel(),
				take("view"),
				...objects,
				take("source", "source "),
				take("fromId", "from "),
				take("offset", "offset "),
				take("limit", "limit "),
				flag("finalReport", "final report"),
				text(args.receiptCursor) ? "receipt references page" : "",
				args.cursor !== undefined ? "continuation page" : "",
			);
			break;
		}
		case "agent_collaborate": {
			const thread = text(args.threadId);
			const title = thread ? context.lookup?.threadTitle?.(thread)?.trim() : undefined;
			const targetSession = target();
			subject = title || take("threadId") || take("title") || take("query") || targetSession;
			if (!subject && args.action === "list") subject = "threads";
			facts.push(
				take("action"),
				targetSession === subject ? "" : targetSession,
				shownArgs.includes("title") ? "" : take("title", "title "),
				take("kind"),
				take("replyTo", "reply to event "),
				take("before", "before "),
				take("after", "after "),
				take("knownFrameRevision", "known frame "),
				take("limit", "limit "),
				text(args.cursor) ? "continuation page" : "",
			);
			body = bodyFor("message", "participation", "purpose");
			break;
		}
		case "agent_work": {
			subject = take("request", "request ") || "open work";
			facts.push(
				take("action"),
				take("status"),
				Array.isArray(args.results) && args.results.length ? cardinal(args.results.length, "result reference") : "",
			);
			if (Array.isArray(args.results) && !args.results.length) shownArgs.push("results");
			body = bodyFor("message", "note");
			break;
		}
		case "agent_reset":
			subject = target();
			facts.push(observedModel());
			body = bodyFor("handoff");
			break;
	}
	const presentation = { name, subject, facts, args, shownArgs, body, expanded };
	return toolCallCard(presentation, theme, context);
}

export const renderAbortCall = bindCall("agent_abort");
export const renderCommandCall = bindCall("agent_command");
export const renderCompactCall = bindCall("agent_compact");
export const renderInspectCall = bindCall("agent_inspect");
export const renderListCall = bindCall("agent_list");
export const renderSteerCall = bindCall("agent_steer");

// --- Result cards ----------------------------------------------------------------

function outcomeCard(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
	labels: { error: string; partial: string },
	summarize: (details: Record<string, unknown>, theme: Theme, context: AgentCardContext) => string[] | undefined,
	expandedLines: readonly string[] = [],
): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", labels.error));
	else if (options.isPartial) lines.push(theme.fg("muted", labels.partial));
	if (options.expanded) lines.push(...expandedLines, theme.fg("toolOutput", boundedSource(output)));
	else {
		const summary = summarize(details, theme, context);
		if (summary) lines.push(...summary);
		else lines.push(theme.fg(context.isError === true ? "error" : "toolOutput", resultPreview(output)));
	}
	return cardLayout({ body: lines, hint: options.expanded ? "" : cardHint(context, "result", "result") }, theme, {
		expanded: options.expanded,
		previous: context.lastComponent,
	});
}

function muted(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

/** A receipt states placement only when its source does: whether the input is in the recipient's context. */
function receiptPlacement(details: Record<string, unknown>): "placed" | "unplaced" | "withdrawn" | undefined {
	return details.placement === "placed" || details.placement === "unplaced" || details.placement === "withdrawn"
		? details.placement
		: undefined;
}
const UNPLACED_INPUT_LINE = "The input is placed at the recipient's next tool boundary";
const WITHDRAWN_INPUT_LINE = "The input is not in the recipient's inbox or transcript";

function controlReceiptLines(
	details: Record<string, unknown>,
	theme: Theme,
	subject: string,
	context: AgentCardContext,
): string[] | undefined {
	const identity = text(details.identity);
	const conversationId = count(details.conversationId);
	if (!identity && conversationId === undefined) return undefined;
	const lines = [
		theme.fg(
			"toolOutput",
			`${subject}${identity ? targetSuffix(identity, context) : conversationId !== undefined ? ` · conversation ${conversationId}` : ""}`,
		),
	];
	const submission = count(details.submissionId);
	if (submission !== undefined) lines[0] += muted(theme, ` · submission ${submission}`);
	const placement = receiptPlacement(details);
	if (placement !== undefined) lines[0] += muted(theme, ` · ${placement}`);
	if (details.deduped === true) lines.push(muted(theme, "Already admitted"));
	if (placement === "unplaced") lines.push(muted(theme, UNPLACED_INPUT_LINE));
	if (placement === "withdrawn") lines.push(muted(theme, WITHDRAWN_INPUT_LINE));
	return lines;
}

function receiptLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	if (count(details.submissionId) === undefined || text(details.identity) === "") return undefined;
	return controlReceiptLines(details, theme, "Admitted", context);
}

function forkLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	if (
		text(details.identity) === "" ||
		details.deduped === undefined ||
		count(details.conversationId) === undefined ||
		count(details.submissionId) !== undefined
	)
		return undefined;
	return controlReceiptLines(details, theme, "Fork created", context);
}

function rewindLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	if (count(details.predecessorEntryId) === undefined || text(details.identity) === "") return undefined;
	const lines = controlReceiptLines(details, theme, "Rewind submitted", context) ?? [];
	const predecessor = count(details.predecessorEntryId);
	if (predecessor !== undefined) lines.push(muted(theme, `forked before entry ${predecessor}`));
	return lines;
}

function configureLines(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] | undefined {
	if (text(details.identity) === "" || count(details.conversationId) === undefined) return undefined;
	return [theme.fg("toolOutput", `Configuration applied${targetSuffix(text(details.identity), context)}`)];
}

function timerLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const timer = count(details.timerId);
	if (timer === undefined) return undefined;
	const deadline = count(details.deadline);
	if (deadline !== undefined) {
		const date = new Date(deadline);
		const when = Number.isFinite(date.getTime()) ? date.toISOString() : "deadline unavailable";
		return [
			muted(
				theme,
				`Scheduled${text(details.identity) ? targetSuffix(text(details.identity), context) : ""} · timer ${timer} · ${when}`,
			),
		];
	}
	const status = text(details.status);
	if (!status) return undefined;
	const label = record(context.args).timerId === timer ? "Timer" : `Timer ${timer}`;
	return [
		muted(theme, `${label} ${displayPreview(status, 40)}${details.outcome === "unchanged" ? " · unchanged" : ""}`),
	];
}

function pendingStopLines(details: Record<string, unknown>, theme: Theme): string[] {
	if (details.settled !== false) return [];
	const ids = array(details.pendingTasks).filter((id) => typeof id === "number");
	const shown = ids.slice(0, 4).join(", ");
	const tasks = shown ? ` · pending tasks: ${shown}${ids.length > 4 ? ", …" : ""}` : "";
	return [theme.fg("warning", `Stop not settled; do not repeat${tasks}`)];
}

function interruptLines(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	if (details.state === "protected") return [muted(theme, "Selection changed; no continuation admitted")];
	if (details.state === "pending") return [muted(theme, "Interrupt pending; keep the same intent for any retry")];
	if (details.state === "continued" && count(details.submissionId) !== undefined)
		return [theme.fg("toolOutput", `Continuation admitted · submission ${details.submissionId}`)];
	return undefined;
}

function releaseLines(details: Record<string, unknown>, theme: Theme): string[] {
	const aborted = record(details.aborted);
	const outcome =
		aborted.cold === true
			? "Cold stop recorded; no serving host started"
			: details.retiring
				? "Host retirement requested"
				: "Host remains active";
	const lines = [theme.fg("toolOutput", outcome), ...pendingStopLines(aborted, theme)];
	for (const blocker of array(details.blockers))
		if (typeof blocker === "string") lines.push(muted(theme, displayPreview(blocker, 160)));
	return lines;
}

function abortLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const timer = timerLines(details, theme, context);
	if (timer) return timer;
	if (record(context.args).interrupt !== undefined) return interruptLines(details, theme);
	if (typeof details.retiring === "boolean") return releaseLines(details, theme);
	if (text(details.identity) === "" || details.background === undefined) return undefined;
	const outcome =
		details.cold === true ? "Cold stop recorded" : details.settled === true ? "Stop settled" : "Abort requested";
	const lines = [
		theme.fg("toolOutput", `${outcome}${targetSuffix(text(details.identity), context)}`),
		...pendingStopLines(details, theme),
	];
	if (details.background === true && record(context.args).background !== true)
		lines.push(muted(theme, "Includes background task trees"));
	return lines;
}

function commandLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const reloaded = details.reloaded === true;
	const textValue = text(details.text);
	const identity = text(details.identity);
	const name = text(details.name);
	if (!reloaded && !textValue && !identity && !name) return undefined;
	const lines = [
		theme.fg(
			"toolOutput",
			reloaded ? "Host registrations reloaded" : resultPreview(textValue || "(no command output text)", 240),
		),
	];
	const inventory = record(details.inventory);
	const capabilities = array(inventory.contributions).length;
	if (reloaded && capabilities > 0)
		lines.push(muted(theme, `${capabilities} native contribution${capabilities === 1 ? "" : "s"} installed`));
	if (name && name !== record(context.args).name) lines.push(muted(theme, `command ${displayPreview(name, 120)}`));
	if (identity && !sameTarget(identity, context)) lines.push(muted(theme, targetLabel(identity, context)));
	return lines;
}

function cardinal(value: number, singular: string, plural = `${singular}s`): string {
	return `${value} ${value === 1 ? singular : plural}`;
}

function liveActivity(status: Record<string, unknown>): string {
	if (status.availability !== "live" || typeof status.busy !== "boolean") return "";
	return status.busy ? "working" : "idle";
}

function fleetStatus(details: Record<string, unknown>, context: AgentCardContext): ToolResultPresentation {
	const selection = record(details.selection).outcome;
	const failures = array(details.failures);
	const counts = [
		[array(details.models).length, "model"],
		[failures.length, "failure"],
		[array(details.warnings).length, "warning"],
	] as const;
	const returned = counts.filter(([n]) => n > 0).map(([n, noun]) => cardinal(n, noun));
	const outcome =
		selection === "no-match"
			? "No evidence matched the filter"
			: returned.length
				? `${returned.join(", ")} in local evidence`
				: "No model, failure or warning records returned";
	return {
		outcome,
		body: [
			"Published evidence, not provider health",
			selection === "matched" ? fleetSelectionUsage(details, record(context.args)) : "",
			fleetUsageCoverage(details),
			fleetFailureSample(record(failures[0])),
		]
			.filter(Boolean)
			.join("\n"),
		...fleetCoveragePresentation(details),
	};
}

function fleetFailureSample(failure: Record<string, unknown>): string {
	const message = text(failure.message);
	if (!message) return "";
	const model = resolvedModelLine(text(failure.provider), text(failure.modelId), "");
	return ["Sampled failure", model, message].filter(Boolean).join(" · ");
}

function fleetSelectionUsage(details: Record<string, unknown>, args: Record<string, unknown>): string {
	const model = text(args.model);
	const provider = text(args.provider);
	const row = model
		? array(details.models)
				.map(record)
				.find((row) => row.model === model)
		: array(details.providers)
				.map(record)
				.find((row) => row.provider === provider);
	const last7d = record(record(row?.usage).last7d);
	const responses = count(last7d.responses);
	if (responses === undefined || responses <= 0) return "";
	const cost = count(last7d.reportedCost);
	const costText = cost === undefined ? "" : ` · $${Number(cost.toPrecision(4))} reported`;
	return `${cardinal(responses, "sampled response")} for the filter in the last 7 days${costText}`;
}

function fleetUsageCoverage(details: Record<string, unknown>): string {
	const sampled = count(record(details.usageCoverage).sampledResponses);
	if (sampled === undefined) return "";
	return sampled === 0
		? "No machine-wide usage samples; use is not established"
		: `${cardinal(sampled, "machine-wide usage sample")}`;
}

function fleetCoveragePresentation(
	details: Record<string, unknown>,
): Pick<ToolResultPresentation, "expanded" | "limit"> {
	const coverage = record(details.coverage);
	const catalog = record(coverage.catalog);
	const incomplete = catalog.complete === false || (count(catalog.skipped) ?? 0) > 0;
	const records = count(catalog.records);
	const omitted = Object.values(record(coverage.output)).some((value) => value === true || (count(value) ?? 0) > 0);
	const partial = record(details.usageCoverage).status === "partial";
	return {
		limit: incomplete || omitted || partial ? "Partial fleet coverage" : undefined,
		expanded: [
			incomplete ? "Catalogue scan incomplete" : "",
			incomplete && records !== undefined ? `${cardinal(records, "storage record")} read` : "",
			omitted ? "Fleet result omits some evidence" : "",
			partial ? "Machine-wide usage is sampled" : "",
		]
			.filter(Boolean)
			.join("\n"),
	};
}

function ordinaryStatus(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): ToolResultPresentation {
	const presence = record(details.presence);
	const identity = snapshotIdentityLines(
		{ ...details, name: presence.name, agent: { model: presence.model } },
		theme,
		context,
		false,
	);
	const state = record(presence.process).state;
	const process = state === "live" ? "Local process exists" : state === "dead" ? "Local process not found" : "";
	const source = record(details.source);
	const entry = source.latestKnown === true ? text(record(source.head).id) : "";
	return {
		outcome: "Live session activity not observed",
		body: ["Ordinary primary", ...identity.map(displayText), process, entry ? `Latest retained entry ${entry}` : ""]
			.filter(Boolean)
			.join("\n"),
		limit: record(details.coverage).complete === false ? "Retained ancestry scan incomplete" : undefined,
	};
}

function statusPage(details: Record<string, unknown>, context: AgentCardContext): ToolResultPresentation {
	const coverage = record(details.coverage);
	const rows = array(details.conversations).map(record);
	const storageId = text(details.storageId);
	const retained = details.live === false;
	const scope = retained ? "a retained storage page" : "a storage page";
	const next = record(coverage.next);
	const continuation = next.tool === "agent_status" && next.view === "storage-page";
	const { tool: _tool, ...nextArgs } = next;
	const where = storageId && storageId !== record(context.args).storageId ? `Storage ${storageId}` : "";
	const scanned = count(coverage.scanned);
	return {
		outcome: `${cardinal(rows.length, "conversation")} on ${scope}${continuation ? "; more available" : ""}`,
		body: [
			where,
			...rows.map((row) => storagePageRow(row, retained)),
			scanned === undefined || scanned === rows.length ? "" : `${cardinal(scanned, "conversation")} scanned`,
			coverage.complete === true ? "Storage scan reached its end" : "",
		]
			.filter(Boolean)
			.join("\n"),
		expanded: continuation ? `Continue with agent_status(${JSON.stringify(nextArgs)})` : undefined,
		limit: coverage.complete === false && !continuation ? "Storage scan incomplete" : undefined,
	};
}

function storagePageRow(row: Record<string, unknown>, retained: boolean): string {
	const label = text(row.name) || text(row.identity);
	if (!label) return "";
	const activity = retained ? "" : liveActivity(row);
	return `${label} · ${activity || "live activity not observed"}`;
}

function statusOverview(details: Record<string, unknown>): ToolResultPresentation {
	const rows = array(details.sessions).map(record);
	const sessions = record(record(details.summary).sessions);
	const facts = (keys: [string, string][]) =>
		keys
			.flatMap(([key, label]) => {
				const n = count(sessions[key]);
				return n === undefined || n <= 0 ? [] : [`${n} ${label}`];
			})
			.join(" · ");
	const observed = count(sessions.observed);
	const failures = array(details.failures).length;
	return {
		outcome:
			observed === undefined
				? `${cardinal(rows.length, "conversation row")} returned`
				: `${cardinal(observed, "conversation")} observed; ${cardinal(rows.length, "row")} returned`,
		body: [
			facts([
				["working", "working"],
				["attention", "need attention"],
			]),
			facts([
				["unavailable", "unavailable"],
				["quiet", "quiet"],
			]),
			facts([
				["summarizedUnavailable", "unavailable summarised"],
				["summarizedQuiet", "quiet summarised"],
			]),
			failures ? `${cardinal(failures, "storage", "storages")} unavailable; absence not established` : "",
			...rows.map((row) => [text(row.name) || text(row.id), text(row.state)].filter(Boolean).join(" · ")),
		]
			.filter(Boolean)
			.join("\n"),
		limit:
			record(details.coverage).complete === false
				? "Incomplete coverage; use agent_list to discover stored conversations"
				: undefined,
	};
}

function summarizeGeneric(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] | undefined {
	return (
		resolveProfileLines(details, theme, context) ??
		rewindLines(details, theme, context) ??
		forkLines(details, theme, context) ??
		receiptLines(details, theme, context) ??
		abortLines(details, theme, context) ??
		configureLines(details, theme, context) ??
		commandLines(details, theme, context)
	);
}

function snapshotStatus(details: Record<string, unknown>): Record<string, unknown> | undefined {
	const direct = record(details.conversation);
	if (Object.keys(direct).length > 0) return direct;
	const nested = record(details.status);
	if (count(nested.conversationId) !== undefined && nested.agent !== undefined) return nested;
	const wrapper = record(nested.conversation);
	return Object.keys(wrapper).length > 0 ? wrapper : undefined;
}

function readOnlySnapshot(details: Record<string, unknown>): boolean {
	return details.live === false || record(details.status).live === false;
}

function runningSlots(live: Record<string, unknown>): Record<string, unknown>[] {
	return array(live.tools)
		.map(record)
		.filter((slot) => ["running", "pending", "sleeping", "waiting"].some((status) => status === slot.status));
}

function runningSlotLine(slot: Record<string, unknown>): string {
	const label = slot.status === "sleeping" ? "Sleeping" : slot.status === "waiting" ? "Waiting" : "Running";
	const name = text(slot.name);
	const id = text(slot.callId);
	const parts = [name ? `${label}: ${displayText(name)}` : label];
	if (id) parts.push(`call ${displayIdentity(id)}`);
	if (slot.status === "pending") parts.push("pending");
	return parts.join(" · ");
}

function latestSavedResult(submissions: unknown, label = "Saved: "): string | undefined {
	const rows = array(submissions)
		.map(record)
		.filter((row) => row.type === "input" && (row.status === "done" || row.status === "unanswered"));
	const last = rows.at(-1);
	if (!last) return undefined;
	const id = count(last.id);
	return `${label}${text(last.status)}${id === undefined ? "" : ` · submission ${id}`}`;
}

function retryLines(live: Record<string, unknown>, theme: Theme): string[] {
	const lines: string[] = [];
	const generation = record(record(live.generation).retry);
	if (Object.keys(generation).length > 0)
		lines.push(
			theme.fg(
				"warning",
				`Provider retry${text(generation.error) ? `: ${displayPreview(text(generation.error), 200)}` : ""}`,
			),
		);
	for (const value of array(live.compactions)) {
		const retry = record(record(value).retry);
		if (Object.keys(retry).length > 0)
			lines.push(
				theme.fg(
					"warning",
					`Compaction retry${text(retry.error) ? `: ${displayPreview(text(retry.error), 200)}` : ""}`,
				),
			);
	}
	return lines;
}

/** The newest text is named by its author: the agent's reply or the input it received. */
function newestTextLabel(working: boolean, role: string | undefined): string {
	if (role === "assistant") return working ? "Replying" : "Latest reply";
	if (role === "user") return working ? "Working on input" : "Latest input";
	return working ? "Working on the task" : "Latest message";
}

function providerBlockLines(block: unknown, theme: Theme, compact = false): string[] {
	if (!matchesSchema(ProviderBlockFactSchema, block))
		return [muted(theme, "Provider block unavailable: invalid native fact")];
	const lines = compact ? providerBlockSummary(block) : [providerBlockText(block)];
	return lines.map((line) => theme.fg("warning", displayText(line)));
}
function activityFacts(status: Record<string, unknown>, activity: string, current: string): string {
	const inbox = record(status.inbox);
	return [
		activity ? `Activity: ${activity}` : "",
		current ? `tool ${displayText(current)}` : "",
		Array.isArray(inbox.items) ? `${inbox.items.length} pending` : "",
		unplacedText(status),
	]
		.filter(Boolean)
		.join(" · ");
}

function activityLines(status: Record<string, unknown>, readOnly: boolean, theme: Theme): string[] {
	const lines = readOnly ? [muted(theme, "Read-only snapshot; live owner state unavailable")] : [];
	if (status.providerBlock !== undefined) return [...lines, ...providerBlockLines(status.providerBlock, theme)];
	const live = record(status.live);
	const working = !readOnly && (status.busy === true || Object.keys(record(live.run)).length > 0);
	const activity = working ? "working" : !readOnly && status.busy === false ? "idle" : "";
	const running = readOnly ? [] : runningSlots(live);
	const current = text(running.find((slot) => slot.status === "running")?.name);
	const facts = activityFacts(status, activity, current);
	if (facts) lines.push(muted(theme, facts));
	for (const slot of running.slice(0, 4)) lines.push(muted(theme, runningSlotLine(slot)));
	if (running.length > 4) lines.push(muted(theme, `${running.length - 4} more active tools`));
	const lastText = text(status.lastText);
	if (lastText)
		lines.push(
			theme.fg(
				"toolOutput",
				`${newestTextLabel(working, text(status.lastTextRole))}: ${displayPreview(lastText, 240)}`,
			),
		);
	const saved = latestSavedResult(status.submissions);
	if (saved) lines.push(muted(theme, saved));
	if (!readOnly) lines.push(...retryLines(live, theme));
	return lines;
}

/** Admitted inputs that are not yet in the conversation's context, with the age of the oldest one. */
function unplacedText(status: Record<string, unknown>): string {
	const unplaced = count(status.unplaced);
	if (unplaced === undefined) return "";
	const oldest = count(status.oldest);
	if (unplaced === 0 || oldest === undefined) return `unplaced: ${unplaced}`;
	const seconds = Math.floor(oldest / 1000),
		minutes = Math.floor(seconds / 60);
	const age =
		seconds < 60
			? `${seconds}s`
			: minutes < 60
				? `${minutes}m ${seconds % 60}s`
				: `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return `unplaced: ${unplaced}, oldest: ${age}`;
}

function openWorkText(status: Record<string, unknown>): string {
	const open = count(status.openWorkCount),
		oldest = count(status.openWorkOldest);
	if (open === undefined) return "";
	if (open === 0 || oldest === undefined) return `work open: ${open}`;
	const seconds = Math.floor(oldest / 1000),
		minutes = Math.floor(seconds / 60);
	const age =
		seconds < 60
			? `${seconds}s`
			: minutes < 60
				? `${minutes}m ${seconds % 60}s`
				: `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return `work open: ${open}, oldest: ${age}`;
}

function snapshotLabel(identity: string, name: string, context: AgentCardContext): string {
	return name ? displayPreview(name, 120) : targetLabel(identity, context);
}

function resolvedModelLine(provider: string, modelId: string, thinking: string): string {
	const model = provider && modelId ? `${provider}/${modelId}` : provider || modelId;
	return [displayText(model), displayText(thinking)].filter(Boolean).join(" · ");
}

function snapshotIdentityLines(
	status: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
	namedByReceipt: boolean,
): string[] {
	const agent = record(status.agent);
	const model = record(agent.model);
	const provider = text(model.provider);
	const modelId = text(model.modelId);
	const thinking = text(agent.thinkingLevel);
	const name = text(status.name);
	const identity = text(status.identity) || text(status.sessionId);
	const lines: string[] = [];
	const hideName = !context.expanded && (namedByReceipt || headerHasName(identity, name, context));
	const hideModel = !context.expanded && headerHasModel(identity, provider, modelId, thinking, context);
	if ((name || identity) && !hideName) lines.push(theme.fg("accent", snapshotLabel(identity, name, context)));
	const configuration = resolvedModelLine(provider, modelId, thinking);
	if (!hideModel && configuration) lines.push(muted(theme, configuration));
	return lines;
}

function durableStatusSourceLines(
	status: Record<string, unknown>,
	details: Record<string, unknown>,
	theme: Theme,
): string[] {
	if (details.conversation !== status || count(status.conversationId) === undefined) return [];
	const liveHost = details.live !== false && (details.pid !== undefined || details.inventory !== undefined);
	const lines = [theme.fg("toolOutput", liveHost ? "Durable agent · live host observation" : "Durable agent")];
	const timer = record(array(status.timers)[0]);
	const deadline = count(timer.deadline);
	if (count(timer.id) === undefined || deadline === undefined) return lines;
	const when = new Date(deadline);
	if (Number.isFinite(when.getTime()))
		lines.push(
			muted(
				theme,
				`Earliest timer ${timer.id} · ${when.toISOString()} · ${text(timer.status)}${timer.overdue === true ? " · overdue" : ""}`,
			),
		);
	return lines;
}

function snapshotLines(
	status: Record<string, unknown>,
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
	namedByReceipt = false,
): string[] {
	if (details.format === "compact") return compactStatusLines(status, details, theme, context);
	const lines = snapshotIdentityLines(status, theme, context, namedByReceipt);
	lines.push(...durableStatusSourceLines(status, details, theme));
	if (status.live === undefined && typeof status.state === "string")
		lines.push(muted(theme, `State: ${displayPreview(status.state, 40)}`));
	else lines.push(...activityLines(status, readOnlySnapshot(details), theme));
	const limits = record(details.inventory ?? record(details.status).inventory ?? record(status.limits));
	const ordinaryOnly = array(limits.ordinaryOnly).length;
	if (ordinaryOnly)
		lines.push(
			muted(
				theme,
				`Capability limits: ${ordinaryOnly} configured extension${ordinaryOnly === 1 ? "" : "s"} without a native form`,
			),
		);
	return lines;
}

function compactRecoveryLines(
	status: Record<string, unknown>,
	details: Record<string, unknown>,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const failure = record(status.runFailure);
	if (typeof failure.reason === "string")
		lines.push(
			theme.fg(
				"warning",
				`Run failure: ${displayText(failure.reason)}${failure.reasonTruncated === true ? " [truncated]" : ""}${typeof failure.detail === "string" ? ` · ${displayText(failure.detail)}${failure.detailTruncated === true ? " [truncated]" : ""}` : ""}`,
			),
		);
	if (typeof details.deliveryError === "string")
		lines.push(
			theme.fg(
				"warning",
				`Delivery error: ${displayText(details.deliveryError)}${details.deliveryErrorTruncated === true ? " [truncated]" : ""}`,
			),
		);
	return lines;
}

function compactActivityFacts(status: Record<string, unknown>): string[] {
	const queue = count(record(status.queue).inbox);
	const timers = count(status.timers);
	return [
		liveActivity(status),
		count(status.unplaced) === undefined && queue !== undefined ? cardinal(queue, "queued input") : "",
		timers === undefined ? "" : cardinal(timers, "timer"),
		unplacedText(status),
		openWorkText(status),
	].filter(Boolean);
}

function compactStatusLines(
	status: Record<string, unknown>,
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] {
	const model = record(status.model);
	const lines = snapshotIdentityLines(
		{ ...status, agent: { model, thinkingLevel: status.thinkingLevel } },
		theme,
		context,
		false,
	);
	const live = status.availability === "live";
	const retained = status.availability === "retained";
	const ordinary = count(status.conversationId) === undefined;
	const source = ordinary ? "Ordinary primary" : "Durable agent";
	const reach = live ? "live host observation" : "live session activity not observed";
	lines.push(theme.fg("toolOutput", `${source} · ${retained ? "retained snapshot; " : ""}${reach}`));
	const activity = compactActivityFacts(status);
	if (activity.length) lines.push(muted(theme, `${live ? "Activity" : "Snapshot facts"}: ${activity.join(" · ")}`));
	lines.push(...compactRecoveryLines(status, details, theme));
	const block = record(status.providerBlock);
	if (text(block.blockId))
		lines.push(theme.fg("warning", `Provider block ${text(block.blockId)} · ${text(block.recovery)}`));
	if (context.expanded && array(status.omitted).length)
		lines.push(muted(theme, `Omitted: ${array(status.omitted).join(", ")}`));
	if (context.expanded && array(details.omitted).length)
		lines.push(muted(theme, `Omitted envelope fields: ${array(details.omitted).join(", ")}`));
	const detail = record(status.detail);
	if (context.expanded && detail.tool === "agent_status" && typeof detail.sessionId === "string")
		lines.push(
			muted(theme, `Full detail: agent_status(${JSON.stringify({ sessionId: detail.sessionId, detail: true })})`),
		);
	return lines;
}

/** Snapshot and control result card for spawn, attach, place, status, fork, rewind, and configure. */
function nestedReceiptLines(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] | undefined {
	const admission = record(details.admission);
	if (count(admission.submissionId) === undefined) return undefined;
	const snapshot = snapshotStatus(details);
	const identity = text(admission.identity) || text(details.sessionId) || text(snapshot?.identity);
	const receiptContext =
		identity === text(snapshot?.identity)
			? { ...context, args: { ...record(context.args), sessionId: identity } }
			: context;
	return controlReceiptLines(
		{ placement: details.placement, ...admission, identity },
		theme,
		"Admitted",
		receiptContext,
	);
}

function collapsedAgentLines(
	details: Record<string, unknown>,
	output: string,
	theme: Theme,
	context: AgentCardContext,
): string[] {
	const snapshot = snapshotStatus(details);
	const observed = snapshotFacts(context, snapshot);
	const summary = summarizeGeneric(details, theme, observed) ?? nestedReceiptLines(details, theme, observed);
	const identity = text(details.identity);
	const snapshotIdentity = text(snapshot?.identity) || text(snapshot?.sessionId);
	const namedByReceipt =
		summary !== undefined &&
		identity !== "" &&
		identity === snapshotIdentity &&
		!sameTarget(identity, context) &&
		!headerHasName(identity, text(snapshot?.name), context);
	const lines = snapshot ? snapshotLines(snapshot, details, theme, context, namedByReceipt) : [];
	if (summary) lines.push(...summary);
	else if (!snapshot) lines.push(theme.fg(context.isError === true ? "error" : "toolOutput", resultPreview(output)));
	return lines;
}
function statusTimerFact(status: Record<string, unknown>): string {
	const timer = record(array(status.timers)[0]);
	if (count(timer.id) === undefined) return "";
	const deadline = count(timer.deadline);
	const when = deadline === undefined ? "" : localToolTime(deadline);
	return [`Earliest timer ${timer.id}`, when, text(timer.status), timer.overdue === true ? "overdue" : ""]
		.filter(Boolean)
		.join(" · ");
}

function fullStatusFacts(
	status: Record<string, unknown>,
	details: Record<string, unknown>,
	live: boolean,
	theme: Theme,
): string[] {
	const inventory = record(details.inventory ?? record(details.status).inventory ?? status.limits);
	const ordinaryOnly = array(inventory.ordinaryOnly).length;
	return [
		statusTimerFact(status),
		...fullStatusActivityFacts(status, live, theme),
		ordinaryOnly ? `${cardinal(ordinaryOnly, "configured extension")} without a native form` : "",
	];
}

function fullStatusActivityFacts(status: Record<string, unknown>, live: boolean, theme: Theme): string[] {
	if (status.providerBlock !== undefined) return providerBlockLines(status.providerBlock, theme);
	const inbox = record(status.inbox);
	const pending = Array.isArray(inbox.items) ? inbox.items.length : 0;
	const runtime = record(status.live);
	const running = live ? runningSlots(runtime) : [];
	const lastText = text(status.lastText);
	return [
		pending > 0 ? cardinal(pending, "pending input") : "",
		statusUnplaced(status),
		...running.map(statusToolFact),
		lastText ? `${newestTextLabel(live && status.busy === true, text(status.lastTextRole))} · ${lastText}` : "",
		latestSavedResult(status.submissions, "Saved result · "),
		...(live ? statusRetryFacts(runtime) : []),
	];
}

function statusToolFact(slot: Record<string, unknown>): string {
	const states = { sleeping: "Sleeping", waiting: "Waiting", pending: "Pending", running: "Running" };
	const label = states[slot.status as keyof typeof states];
	const id = text(slot.callId);
	return [[label, text(slot.name)].filter(Boolean).join(" "), id ? `call ${id}` : ""].filter(Boolean).join(" · ");
}

function statusRetryFacts(runtime: Record<string, unknown>): string[] {
	const generation = record(record(runtime.generation).retry);
	const compactions = array(runtime.compactions).map((value) => record(record(value).retry));
	const fact = (label: string, retry: Record<string, unknown>) =>
		Object.keys(retry).length > 0 ? [label, text(retry.error)].filter(Boolean).join(" · ") : "";
	return [fact("Provider retry", generation), ...compactions.map((retry) => fact("Compaction retry", retry))];
}

function statusCountWithAge(value: unknown, oldest: unknown, noun: string): string {
	const n = count(value);
	if (n === undefined || n <= 0) return "";
	const name = cardinal(n, noun);
	const millis = count(oldest);
	if (millis === undefined) return name;
	const seconds = Math.floor(millis / 1000);
	const minutes = Math.floor(seconds / 60);
	const age =
		seconds < 60
			? `${seconds}s`
			: minutes < 60
				? `${minutes}m ${seconds % 60}s`
				: `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return `${name} · oldest ${age}`;
}

function statusUnplaced(status: Record<string, unknown>): string {
	return statusCountWithAge(status.unplaced, status.oldest, "unplaced input");
}

function compactStatusFacts(status: Record<string, unknown>, details: Record<string, unknown>): string[] {
	const queue = count(record(status.queue).inbox) ?? 0;
	const timers = count(status.timers) ?? 0;
	const failure = record(status.runFailure);
	const block = record(status.providerBlock);
	const unplaced = statusUnplaced(status);
	return [
		!unplaced && queue > 0 ? cardinal(queue, "queued input") : "",
		timers > 0 ? cardinal(timers, "timer") : "",
		unplaced,
		statusCountWithAge(status.openWorkCount, status.openWorkOldest, "open work item"),
		statusDiagnostic(
			"Run failed",
			text(failure.reason),
			failure.reasonTruncated,
			text(failure.detail),
			failure.detailTruncated,
		),
		statusDiagnostic("Delivery error", text(details.deliveryError), details.deliveryErrorTruncated),
		text(block.blockId)
			? [`Provider block ${text(block.blockId)}`, text(block.recovery)].filter(Boolean).join(" · ")
			: "",
	];
}

function statusDiagnostic(
	label: string,
	diagnostic: string,
	truncated?: unknown,
	detail = "",
	detailTruncated?: unknown,
): string {
	if (!diagnostic) return "";
	const excerpt = (value: string, bound: unknown) => (bound === true ? `${value} [Excerpt]` : value);
	return [label, excerpt(diagnostic, truncated), detail ? excerpt(detail, detailTruncated) : ""]
		.filter(Boolean)
		.join(" · ");
}

function statusDetailCall(detail: Record<string, unknown>): string {
	if (detail.tool !== "agent_status" || typeof detail.sessionId !== "string") return "";
	const { tool: _tool, ...args } = detail;
	return `Get full detail with agent_status(${JSON.stringify(args)})`;
}

function statusSnapshot(
	status: Record<string, unknown>,
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): ToolResultPresentation {
	const retained = readOnlySnapshot(details) || status.availability === "retained";
	const compact = details.format === "compact";
	const kind = compact && count(status.conversationId) === undefined ? "Ordinary primary" : "Durable agent";
	const live = !retained && (compact ? status.availability === "live" : fullStatusObserved(status, details));
	const activity = live ? selectedLiveOutcome(status) : "";
	const outcome = activity || (live ? "Live session activity not established" : "Live session activity not observed");
	const basis = live ? "live host observation" : retained ? "retained snapshot" : "";
	const body = compact ? compactStatusFacts(status, details) : fullStatusFacts(status, details, live, theme);
	const observed = compact
		? { ...status, agent: { model: status.model, thinkingLevel: status.thinkingLevel } }
		: status;
	const identityFacts = snapshotIdentityLines(observed, theme, context, false).map(displayText);
	const omissions = [...array(status.omitted), ...array(details.omitted)].map(text).filter(Boolean);
	return {
		outcome,
		body: [[kind, basis].filter(Boolean).join(" · "), ...identityFacts, ...body].filter(Boolean).join("\n"),
		expanded: [statusDetailCall(record(status.detail)), ...omissions.map((fact) => `Omitted ${fact}`)]
			.filter(Boolean)
			.join("\n"),
		limit: omissions.length ? "Compact status omits facts; see full detail" : undefined,
	};
}

function selectedLiveOutcome(status: Record<string, unknown>): string {
	if (status.busy === true || Object.keys(record(record(status.live).run)).length > 0) return "Working";
	return status.busy === false ? "Idle" : "";
}

function fullStatusObserved(status: Record<string, unknown>, details: Record<string, unknown>): boolean {
	return details.pid !== undefined || details.inventory !== undefined || status.live !== undefined;
}

function statusPresentation(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): ToolResultPresentation {
	if (details.cancelled === true) return { outcome: "Cancelled" };
	const diagnostic = diagnosticPresentation(details);
	if (context.isError || details.format === "refused" || diagnostic.outcome) return diagnostic;
	if (details.view === "fleet") return fleetStatus(details, context);
	if (details.view === "status" && details.kind === "ordinary-primary") return ordinaryStatus(details, theme, context);
	if (Array.isArray(details.sessions)) return statusOverview(details);
	if (Array.isArray(details.conversations)) return statusPage(details, context);
	const snapshot = snapshotStatus(details);
	return snapshot ? statusSnapshot(snapshot, details, theme, context) : {};
}

function renderStatusResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	const details = resultDetails(result);
	const presentation = statusPresentation(details, theme, { ...context, expanded: false });
	const snapshotError = text(details.snapshotError);
	const deliveryError = text(details.deliveryError) || text(record(details.status).deliveryError);
	const body = [
		snapshotError ? `Snapshot unavailable · ${snapshotError}` : "",
		deliveryError && details.format !== "compact" ? `Delivery paused · ${deliveryError}` : "",
		presentation.body,
	]
		.filter(Boolean)
		.join("\n");
	return toolResultCard(result, options, theme, context, { ...presentation, body, partial: "Status read in progress" });
}

export function renderAgentResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", "Tool error"));
	else if (options.isPartial) lines.push(theme.fg("muted", "Partial result"));
	const snapshot = snapshotStatus(details);
	const snapshotError = text(details.snapshotError);
	if (snapshotError) lines.push(theme.fg("warning", `Snapshot unavailable: ${displayPreview(snapshotError, 240)}`));
	const deliveryError = text(details.deliveryError) || text(record(details.status).deliveryError);
	if (deliveryError && details.format !== "compact")
		lines.push(theme.fg("warning", `Delivery paused: ${displayPreview(deliveryError, 240)}`));
	if (options.expanded) {
		if (snapshot) lines.push(...snapshotLines(snapshot, details, theme, { ...context, expanded: true }));
		lines.push(theme.fg("toolOutput", boundedSource(output)));
		if (snapshot) lines.push(theme.fg("dim", boundedSource(JSON.stringify(snapshot, null, 2))));
		return cardLayout({ body: lines }, theme, { expanded: true, previous: context.lastComponent });
	}
	lines.push(...collapsedAgentLines(details, output, theme, context));
	return cardLayout({ body: lines, hint: cardHint(context, "result", "details") }, theme, {
		expanded: false,
		previous: context.lastComponent,
	});
}

function primaryMessageLines(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] | undefined {
	if (details.admitted !== true || !text(details.sessionId)) return undefined;
	const kind = record(context.args).mode === "report" ? "Report" : "Message";
	if (receiptPlacement(details) === "withdrawn")
		return [
			theme.fg("toolOutput", `${kind} withdrawn for ${targetLabel(text(details.sessionId), context)}`),
			muted(theme, WITHDRAWN_INPUT_LINE),
		];
	return [
		theme.fg(
			"toolOutput",
			`${kind} ${kind === "Report" ? "queued for" : "delivered to"} ${targetLabel(text(details.sessionId), context)}`,
		),
	];
}

function reportPlacementLines(details: Record<string, unknown>, theme: Theme): string[] {
	const placement = receiptPlacement(details);
	if (placement === "withdrawn") return [muted(theme, WITHDRAWN_INPUT_LINE)];
	// A parked or terminal delivery does not reach the recipient's next tool boundary.
	if (details.delivery === "parked" || details.delivery === "terminal")
		return [
			theme.fg(
				details.delivery === "terminal" ? "warning" : "muted",
				`Delivery ${details.delivery}; the report is not placed`,
			),
		];
	return placement === "unplaced" ? [muted(theme, UNPLACED_INPUT_LINE)] : [];
}

function reportReceiptLines(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] | undefined {
	if (!text(details.sourceId) || typeof details.acknowledged !== "boolean") return undefined;
	const placement = receiptPlacement(details);
	return [
		theme.fg(
			"toolOutput",
			`Report retained${text(details.ownerId) ? targetSuffix(text(details.ownerId), context) : ""} · ${details.acknowledged ? "Acknowledged" : "Acknowledgement pending"}${details.passive === true ? " · passive" : ""}${placement === undefined ? "" : ` · ${placement}`}`,
		),
		...reportPlacementLines(details, theme),
	];
}

function messageResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
	labels: { error: string; partial: string; receipt: string },
): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", labels.error));
	else if (options.isPartial) lines.push(theme.fg("muted", labels.partial));
	const summary =
		reportReceiptLines(details, theme, context) ??
		primaryMessageLines(details, theme, context) ??
		timerLines(details, theme, context) ??
		controlReceiptLines(details, theme, labels.receipt, context);
	if (summary) lines.push(...summary);
	if (options.expanded) lines.push(theme.fg("toolOutput", boundedSource(output)));
	else {
		if (!summary) lines.push(theme.fg("toolOutput", resultPreview(output, 300)));
	}
	const identity = text(details.identity) || text(details.sessionId);
	return cardLayout(
		{
			metadata: [sameTarget(identity, context) ? "" : targetConfiguration(identity, context)],
			outcome: lines,
			hint: options.expanded ? "" : cardHint(context, "result", "result"),
		},
		theme,
		{ expanded: options.expanded, previous: context.lastComponent },
	);
}

function sendRecipient(identity: string, context: AgentCardContext): string {
	if (!identity) return "";
	const label = targetLabel(identity, context);
	const requested = callIdentity(context);
	return sameTarget(identity, context) && label === targetLabel(requested, context) ? "" : ` for ${label}`;
}

function reportSendOutcome(details: Record<string, unknown>, recipient: string): string | undefined {
	if (!text(details.sourceId) || typeof details.acknowledged !== "boolean") return undefined;
	const ack = details.acknowledged ? "acknowledged" : "acknowledgement pending";
	const flags = details.passive === true ? " · passive" : "";
	const outcome = `Report retained${recipient}; ${ack}${flags}`;
	const placement = receiptPlacement(details);
	if (placement === "withdrawn") return `${outcome} · withdrawn`;
	if (parkedReport(details)) return `${outcome} · delivery ${details.delivery}; the report is not placed`;
	return placement ? `${outcome} · ${placement}` : outcome;
}

function parkedReport(details: Record<string, unknown>): boolean {
	return details.delivery === "parked" || details.delivery === "terminal";
}

function scheduleSendOutcome(details: Record<string, unknown>, recipient: string): string | undefined {
	const timer = count(details.timerId);
	if (timer === undefined) return undefined;
	const deadline = count(details.deadline);
	const when = deadline === undefined ? "" : localToolTime(deadline);
	return [`Scheduled${recipient}`, `timer ${timer}`, when].filter(Boolean).join(" · ");
}

function admissionSendOutcome(
	details: Record<string, unknown>,
	identity: string,
	recipient: string,
	context: AgentCardContext,
): string | undefined {
	if (details.admitted === false) return "Admission refused";
	const submission = count(details.submissionId);
	if (details.admitted !== true && submission === undefined) return undefined;
	const conversation = count(details.conversationId);
	const placement = receiptPlacement(details);
	const kind = record(context.args).mode === "report" ? "Report" : "Message";
	const state = placement === "withdrawn" ? "withdrawn" : details.deduped === true ? "already admitted" : "admitted";
	return [
		`${kind} ${state}${recipient}`,
		!identity && conversation !== undefined ? `conversation ${conversation}` : "",
		submission === undefined ? "" : `submission ${submission}`,
		placement === "withdrawn" ? "" : placement,
	]
		.filter(Boolean)
		.join(" · ");
}

function sendOutcome(details: Record<string, unknown>, context: AgentCardContext): string | undefined {
	const identity = text(details.ownerId) || text(details.identity) || text(details.sessionId);
	const recipient = sendRecipient(identity, context);
	return (
		reportSendOutcome(details, recipient) ??
		scheduleSendOutcome(details, recipient) ??
		admissionSendOutcome(details, identity, recipient, context)
	);
}

function diagnosticPresentation(details: Record<string, unknown>): ToolResultPresentation {
	const error = record(details.error);
	const diagnostic = text(error.message) || text(details.error) || text(details.reason);
	const [outcome, ...rest] = displayText(diagnostic).trim().split("\n");
	return { outcome: outcome || undefined, expanded: rest.join("\n") };
}

function sendPresentation(details: Record<string, unknown>, context: AgentCardContext): ToolResultPresentation {
	if (details.cancelled === true) return { outcome: "Cancelled" };
	const diagnostic = diagnosticPresentation(details);
	if (context.isError || details.format === "refused" || diagnostic.outcome) return diagnostic;
	const placement = receiptPlacement(details);
	return {
		outcome: sendOutcome(details, context),
		expanded:
			placement === "withdrawn"
				? WITHDRAWN_INPUT_LINE
				: placement === "unplaced" && !parkedReport(details)
					? UNPLACED_INPUT_LINE
					: undefined,
	};
}

export function renderSendResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	return toolResultCard(result, options, theme, context, {
		...sendPresentation(resultDetails(result), context),
		partial: "Admission pending",
	});
}

export function renderSteerResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	return messageResult(result, options, theme, context, {
		error: "Steer error",
		partial: "Steering disposition pending",
		receipt: "Steer admitted",
	});
}

function renderBriefResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	const details = resultDetails(result);
	if (details.preview === true) {
		const problems = Array.isArray(details.problems) ? details.problems : [];
		const size = record(details.brief).characters;
		const lines = [theme.fg("toolOutput", `Preview · ${size} characters`), muted(theme, "Nothing was sent")];
		for (const problem of problems) {
			if (typeof problem === "string")
				lines.push(theme.fg("warning", options.expanded ? boundedSource(problem) : displayPreview(problem, 300)));
		}
		return cardLayout({ body: lines }, theme, { expanded: options.expanded, previous: context.lastComponent });
	}
	const args = record(context.args);
	if (!text(args.sessionId)) return renderAgentResult(result, options, theme, context);
	return args.mode === "steer"
		? renderSteerResult(result, options, theme, context)
		: messageResult(result, options, theme, context, {
				error: "Send error",
				partial: "Admission pending",
				receipt: "Admitted",
			});
}

function compactTarget(facts: Record<string, unknown>): string {
	const identity = text(facts.identity);
	const name = text(facts.name);
	return facts.self === true
		? `this session${name ? ` · ${displayText(name)}` : ` · ${displayIdentity(identity)}`}`
		: displayText(name || identity);
}

function compactConfiguration(facts: Record<string, unknown>): string {
	return resolvedModelLine(text(facts.provider), text(facts.modelId), text(facts.thinkingLevel));
}

function compactFactLines(facts: Record<string, unknown>, showTarget: boolean): string[] {
	const lines: string[] = [];
	if (showTarget) {
		if (compactTarget(facts)) lines.push(`Target: ${compactTarget(facts)}`);
		const configuration = compactConfiguration(facts);
		if (configuration) lines.push(configuration);
	}
	const before = record(facts.before);
	const tokens = count(before.tokens),
		window = count(before.contextWindow),
		percent = count(before.percent);
	const parts = [
		tokens === undefined ? "" : `${tokens} tokens`,
		window === undefined ? "" : `${window} window`,
		percent === undefined ? "" : `${percent.toFixed(1)}%`,
	].filter(Boolean);
	if (parts.length) lines.push(`Before: ${parts.join(" · ")}`);
	if (facts.self !== true && count(facts.summaryChars) !== undefined)
		lines.push(`Summary: ${facts.summaryChars} chars`);
	if (text(facts.metadataError)) lines.push(`Metadata read failed: ${displayPreview(text(facts.metadataError), 240)}`);
	return lines;
}

function compactSummary(details: Record<string, unknown>, context: AgentCardContext): string[] | undefined {
	const self = text(record(context.args).summary) !== "";
	const status = text(details.status);
	const taskId = count(details.taskId);
	const entryId = count(details.entryId);
	const submissionId = count(details.submissionId);
	const error = text(details.error);
	if (!status && !taskId && !error) return undefined;
	const lines = [
		`${self ? "Summary" : "Compaction"} ${displayPreview(status === "task" ? "admitted" : status || "pending", 40)}${taskId !== undefined ? ` · task ${taskId}` : ""}${submissionId !== undefined ? ` · submission ${submissionId}` : ""}`,
	];
	if (entryId !== undefined) lines.push(`summary entry ${entryId}`);
	if (error) lines.push(displayPreview(error, 240));
	if (text(details.summarySizeError))
		lines.push(`Summary size read failed: ${displayPreview(text(details.summarySizeError), 240)}`);
	return lines;
}

function rememberCompactionFacts(
	received: Record<string, unknown>,
	context: AgentCardContext,
): Record<string, unknown> {
	if (Object.keys(received).length && context.state && context.state.compaction === undefined)
		context.state.compaction = received;
	return context.state?.compaction ?? received;
}

export function renderCompactResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const received = record(details.compaction);
	const facts = rememberCompactionFacts(received, context);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", "Compact error"));
	else if (options.isPartial) lines.push(theme.fg("muted", "Compaction pending"));
	if (options.expanded) {
		lines.push(...compactFactLines(facts, true).map((line) => muted(theme, line)));
		lines.push(theme.fg("toolOutput", boundedSource(output)));
		if (Object.keys(received).length) lines.push(theme.fg("dim", boundedSource(JSON.stringify(received, null, 2))));
	} else {
		const summary = compactSummary(details, context);
		if (summary) lines.push(...summary);
		else lines.push(theme.fg("toolOutput", resultPreview(output, 300)));
		lines.push(...compactFactLines(facts, context.state?.compactFactsShown !== true).map((line) => muted(theme, line)));
	}
	return cardLayout({ outcome: lines, hint: options.expanded ? "" : cardHint(context, "result", "result") }, theme, {
		expanded: options.expanded,
		previous: context.lastComponent,
	});
}

function listedProfiles(rows: unknown[], theme: Theme): string[] {
	const lines = rows.slice(0, 4).flatMap((value) => {
		const row = record(value);
		return [
			theme.fg(
				"accent",
				text(row.handle) || text(row.name)
					? displayPreview([text(row.handle), text(row.name)].filter(Boolean).join(" · "), 160)
					: displayIdentity(text(row.identity)),
			),
			muted(
				theme,
				typeof row.role === "string"
					? `Role: ${displayPreview(row.role, 180) || "(empty)"}`
					: "Role: unknown profile coverage",
			),
		];
	});
	if (rows.length > 4) lines.push(muted(theme, `${rows.length - 4} more rows`));
	return lines;
}
/** Catalog counts of one discovery page: `settled` storages need no observation, `pending` ones are not observed yet. */
function listCatalogText(coverage: Record<string, unknown>, field: "settled" | "pending"): string {
	const value = count(record(coverage.catalog)[field]) ?? 0;
	if (!value) return "";
	return field === "settled"
		? ` · ${value} settled by publication`
		: ` · ${value} storage observation${value === 1 ? "" : "s"} open`;
}

function listSummary(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	const rows = details.rows;
	if (!Array.isArray(rows)) return undefined;
	const coverage = record(details.coverage);
	const visited = count(coverage.storagesVisited);
	const unavailable = array(coverage.unavailable).length;
	const lines = [
		theme.fg(
			"toolOutput",
			`${rows.length} conversation${rows.length === 1 ? "" : "s"} on this page · ${visited ?? "?"} storage${visited === 1 ? "" : "s"} observed${listCatalogText(coverage, "settled")}${unavailable ? ` · ${unavailable} storage${unavailable === 1 ? "" : "s"} unavailable (unknown, not absent)` : ""}`,
		),
	];
	const profiles = record(coverage.profileHints);
	if (profiles.complete === false)
		lines.push(
			theme.fg(
				"warning",
				`Profile search incomplete · ${count(profiles.unknownStorages) ?? "?"} stores with unknown hints · ${count(profiles.omitted) ?? "?"} omitted hints`,
			),
		);
	lines.push(...listedProfiles(rows, theme));
	const next = details.nextCursor;
	lines.push(
		muted(
			theme,
			typeof next === "string" && next
				? `Next page available${listCatalogText(coverage, "pending")}; repeat with coverage.next, including after an empty page`
				: coverage.complete === false
					? "Inventory may be incomplete; continue discovery"
					: "Inventory covered; no further page",
		),
	);
	return lines;
}

function profileRouteLines(profile: Record<string, unknown>, theme: Theme): string[] {
	const omitted = count(profile.requestsOmitted) ?? 0;
	return [
		muted(
			theme,
			`Expertise: ${text(profile.expertise) ? "saved" : "empty"} · ${array(profile.requests).length} ${omitted > 0 ? "shown" : "active"} request routes`,
		),
		...(omitted > 0 ? [theme.fg("warning", `Request routes omitted: ${omitted}`)] : []),
	];
}
function profileIdentityLines(
	details: Record<string, unknown>,
	profile: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] {
	const model = record(profile.model);
	const identity = text(profile.identity);
	const sameName = headerHasName(identity, text(profile.name), context);
	const sameModel = headerHasModel(
		identity,
		text(model.provider),
		text(model.modelId),
		text(profile.thinkingLevel),
		context,
	);
	const configuration = resolvedModelLine(text(model.provider), text(model.modelId), text(profile.thinkingLevel));
	return [
		...(!sameName || details.outcome
			? [
					theme.fg(
						details.outcome === "conflict" ? "warning" : "accent",
						`${details.outcome === "conflict" ? "Profile conflict; no change" : details.outcome === "applied" ? "Profile saved" : "Profile"} · ${text(profile.handle) || text(profile.name) ? displayPreview(text(profile.handle) || text(profile.name), 160) : displayIdentity(text(profile.identity))}`,
					),
				]
			: []),
		...(!sameModel && configuration ? [muted(theme, configuration)] : []),
	];
}

function profileLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const profile = typeof details.outcome === "string" ? record(details.profile) : details;
	if (typeof profile.revision !== "string" || typeof profile.role !== "string") return undefined;
	return [
		...profileIdentityLines(details, profile, theme, context),
		muted(theme, `Role: ${displayPreview(text(profile.role), 240) || "(empty)"}`),
		muted(
			theme,
			`Revision: ${displayIdentity(text(profile.revision))} · ${profile.live === true ? "live host" : "retained"}`,
		),
		...profileRouteLines(profile, theme),
	];
}
function resolveProfileLines(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] | undefined {
	if (typeof details.created !== "boolean") return undefined;
	const lines = profileLines(record(details.profile), theme, context) ?? profileLines(details, theme, context);
	return lines ? [theme.fg("toolOutput", details.created ? "Agent created" : "Agent reused"), ...lines] : undefined;
}
export function renderProfileResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	return outcomeCard(
		result,
		options,
		theme,
		context,
		{ error: "Profile error", partial: "Profile pending" },
		profileLines,
	);
}

export function renderListResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	return outcomeCard(
		result,
		options,
		theme,
		context,
		{ error: "List error", partial: "Discovery pending" },
		listSummary,
	);
}

function inspectSummary(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] | undefined {
	const view = text(details.view);
	if (view === "result") return inspectResultSummary(details, theme, context);
	if (view === "exact" && details.kind === "ordinary-primary") return inspectPrimaryEntrySummary(details, theme);
	if (view === "exact" || (count(details.nextOffset) !== undefined && identifier(details.entryId) !== ""))
		return inspectEntrySummary(details, theme);
	if (view === "search") return inspectSearchSummary(details, theme);
	if (view === "activity") return inspectActivitySummary(details, theme);
	if (Array.isArray(details.entries)) return inspectHistorySummary(details, view || "history", theme);
	return undefined;
}

function inspectResultSummary(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] {
	const status = text(details.status);
	const args = record(context.args);
	const submission =
		identifier(args.submissionId) === identifier(details.submissionId) ? undefined : count(details.submissionId);
	const operation = args.operationId === details.operationId ? "" : text(details.operationId);
	const reason = text(details.reason);
	const hasAnswer = text(details.answer) !== "";
	const headline = `saved result${status ? ` · ${displayPreview(status, 40)}` : ""}${operation ? ` · operation ${displayIdentity(operation)}` : submission !== undefined ? ` · submission ${submission}` : ""}`;
	const lines = [theme.fg("toolOutput", headline)];
	lines.push(
		muted(
			theme,
			`${hasAnswer ? "assistant answer retained" : "no assistant answer"}${reason ? ` · ${displayPreview(reason, 160)}` : ""}`,
		),
	);
	if (details.providerBlock !== undefined) lines.push(...providerBlockLines(details.providerBlock, theme, true));
	if (count(details.offset) !== undefined)
		lines.push(
			muted(
				theme,
				`Answer offset ${String(details.offset)} (UTF-16 units)${details.truncated === true ? " · more answer text remains" : ""}`,
			),
		);
	for (const continuation of resultContinuationLines(details)) lines.push(muted(theme, continuation));
	return lines;
}

function inspectPrimaryEntrySummary(details: Record<string, unknown>, theme: Theme): string[] {
	const entry = Array.isArray(details.entries) ? record(details.entries[0]) : {};
	const page = record(details.page);
	const [from, to, total] = [count(page.offset), count(page.endOffset), count(page.totalUnits)];
	const range =
		from !== undefined && to !== undefined && total !== undefined ? ` · text ${from}-${to} of ${total}` : "";
	const lines = [theme.fg("toolOutput", `entry ${displayIdentity(identifier(entry.id))}${range}`)];
	lines.push(
		muted(
			theme,
			details.nextCursor
				? "more of this entry remains"
				: page.totalUnits === undefined
					? "entry unavailable"
					: "text complete",
		),
	);
	return lines;
}

function inspectEntrySummary(details: Record<string, unknown>, theme: Theme): string[] {
	const entryId = identifier(details.entryId);
	const offset = count(details.offset);
	const truncated = details.truncated === true;
	const omissions = record(details.omissions);
	const omitted = ["providerSignatures", "imagePayloads", "redactedThinking"].reduce(
		(sum, key) => sum + (count(omissions[key]) ?? 0),
		0,
	);
	const remaining = details.nextOffset === null ? "representation complete" : "more of this entry remains";
	const lines = [
		theme.fg("toolOutput", `entry ${displayIdentity(entryId)}${offset !== undefined ? ` · offset ${offset}` : ""}`),
	];
	lines.push(
		muted(
			theme,
			`${remaining}${truncated ? " · clipped to the display bound" : ""}${omitted ? ` · ${omitted} omitted fields` : ""}`,
		),
	);
	return lines;
}

function inspectSearchSummary(details: Record<string, unknown>, theme: Theme): string[] {
	const matches = Array.isArray(details.matches) ? details.matches.length : 0;
	const coverage = record(details.coverage);
	const complete = coverage.complete === true;
	const scanned = count(coverage.scannedEntries);
	const lines = [
		theme.fg(
			"toolOutput",
			`search · ${matches} ${matches === 1 ? "match" : "matches"}${complete ? " · ancestry covered" : scanned !== undefined ? ` · ${scanned} entries scanned` : ""}`,
		),
	];
	lines.push(muted(theme, details.nextCursor === null ? "No continuation" : "Continuation available"));
	return lines;
}

function inspectActivitySummary(details: Record<string, unknown>, theme: Theme): string[] {
	const turns = Array.isArray(details.turns) ? details.turns.length : 0;
	const coverage = record(details.coverage);
	const scanned = count(coverage.scannedEntries);
	const lines = [
		theme.fg(
			"toolOutput",
			`activity · ${turns} ${turns === 1 ? "turn" : "turns"}${scanned !== undefined ? ` · ${scanned} entries scanned` : ""}`,
		),
	];
	lines.push(
		muted(
			theme,
			`${coverage.complete === true ? "page complete" : "page bounded or partial"}${details.nextCursor === null ? "" : " · older turns available"}`,
		),
	);
	return lines;
}

function inspectHistorySummary(details: Record<string, unknown>, view: string, theme: Theme): string[] {
	const entries = array(details.entries).length;
	const lines = [theme.fg("toolOutput", `${view} page · ${entries} ${entries === 1 ? "entry" : "entries"}`)];
	lines.push(
		muted(theme, details.nextCursor === null ? "older-page boundary; no further page" : "older page available"),
	);
	return lines;
}

export function renderInspectResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	const details = resultDetails(result);
	const recovery =
		options.expanded && details.view === "result" && details.providerBlock !== undefined
			? providerBlockLines(details.providerBlock, theme)
			: [];
	return outcomeCard(
		result,
		options,
		theme,
		context,
		{ error: "Inspect error", partial: "Inspection pending" },
		inspectSummary,
		recovery,
	);
}

/** A thread's known title, or its exact identity when the view has not read that thread. */
function threadLabel(thread: string, context: AgentCardContext): string {
	const title = context.lookup?.threadTitle?.(thread)?.trim();
	return title ? displayPreview(title, 100) : `thread ${displayIdentity(thread)}`;
}

function collaborationReceiptLines(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] | undefined {
	const args = record(context.args);
	const threadId = text(details.threadId);
	if (threadId) {
		const actions: Record<string, string> = {
			create: "Thread created",
			join: "Joined",
			leave: "Left",
			post: "Posted",
			revise: "Frame revised",
			close: "Thread closed",
		};
		const sequence = count(details.sequence);
		return [
			muted(
				theme,
				`${actions[text(args.action)] || "Recorded"}${sequence !== undefined ? ` · #${sequence}` : ""}${args.threadId === threadId ? "" : ` · ${threadLabel(threadId, context)}`}${details.deduped === true ? " · replay" : ""}`,
			),
		];
	}
	return undefined;
}

function forwardThreadLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] {
	const coverage = record(details.coverage),
		next = record(details.next);
	const lines = [
		muted(
			theme,
			`${threadLabel(text(details.threadId), context)} · forward events · frame ${String(details.frameRevision)} · ${details.closed === true ? "closed" : "open"}`,
		),
		muted(
			theme,
			`${array(details.events).length} events · after ${String(coverage.after)} through ${String(coverage.through)}${coverage.complete === false ? " · bounded page" : ""} · ${String(details.pending)} pending notices`,
		),
	];
	if (details.thread === undefined) lines.push(muted(theme, "Known frame not repeated"));
	if (next.tool === "agent_collaborate" && next.action === "read") {
		const { tool: _tool, ...args } = next;
		lines.push(muted(theme, `Next events: agent_collaborate(${JSON.stringify(args)})`));
	}
	return lines;
}

function collaborationLines(
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): string[] | undefined {
	if (details.direction === "forward") return forwardThreadLines(details, theme, context);
	const receipt = collaborationReceiptLines(details, theme, context);
	if (receipt) return receipt;
	const thread = record(details.thread);
	if (text(thread.title))
		return [
			muted(
				theme,
				`${displayPreview(text(thread.title), 100)} · ${thread.closed === true ? "closed" : "open"} · ${array(thread.members).length} members`,
			),
			muted(
				theme,
				`${array(details.events).length} events · ${count(details.pending) ?? "?"} pending notices${record(details.coverage).complete === false ? " · bounded page" : ""}`,
			),
		];
	if (!Array.isArray(details.items)) return undefined;
	return [
		muted(
			theme,
			`${details.items.length} threads${record(details.coverage).complete === false ? " · incomplete coverage" : ""}`,
		),
		...details.items.slice(0, 3).map((value) => muted(theme, displayPreview(text(record(value).title), 100))),
		...(details.nextCursor ? [muted(theme, "Next page available")] : []),
	];
}

function resetLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const source = text(details.text);
	if (!source) return undefined;
	const placed = /^Reset (placed|queued) for “(.*?)”[;.]/u.exec(source);
	if (placed) {
		const known = findTarget(callIdentity(context), context.lookup?.() ?? []);
		return [
			muted(theme, `Reset ${placed[1]}${known?.name === placed[2] ? "" : ` · ${displayPreview(placed[2], 100)}`}`),
		];
	}
	const failure = /^Reset did not place for “.*?”: (.*).$/u.exec(source);
	return [muted(theme, failure ? `Reset not placed: ${displayPreview(failure[1], 240)}` : displayPreview(source, 240))];
}

// --- Peer message card ----------------------------------------------------------

function peerScalarFields(details: Record<string, unknown>): string[] {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(details)) {
		if (key === "usage" || key === "message" || key === "operatorMessage" || value === undefined || value === null)
			continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
			lines.push(
				`${key}: ${/(?:Id|identity)$/iu.test(key) ? displayText(String(value)) : displayPreview(String(value), 160)}`,
			);
	}
	return lines;
}

/** Session name and model at send or settlement, when the owner supplies them. */
function peerConfiguration(details: Record<string, unknown>): string[] {
	const name = text(details.name);
	const provider = text(details.provider);
	const modelId = text(details.modelId);
	const thinking = text(details.thinkingLevel);
	const lines: string[] = [];
	if (name) lines.push(`name: ${displayPreview(name, 120)}`);
	const configuration = resolvedModelLine(provider, modelId, thinking);
	if (configuration) lines.push(configuration);
	return lines;
}

/** Compact outcome word for the operator card; the raw status stays in expanded details. */
function peerOutcome(details: Record<string, unknown>): { label: string; failed: boolean } {
	if (details.checkIn !== undefined) return { label: "still working", failed: false };
	const status = text(details.status);
	if (details.threadId !== undefined) return { label: "thread notice", failed: false };
	if (status !== "" || details.kind === "receipt")
		return { label: "result", failed: status === "unanswered" || status === "failed" };
	return {
		label:
			details.kind === "report" || (details.senderIdentity !== undefined && details.senderKind !== "session")
				? "report"
				: "message from another session",
		failed: false,
	};
}

/** Source names and observed session purposes precede identity-only labels. */
function peerLabel(details: Record<string, unknown>): string {
	const named = text(details.handle) || text(details.name) || text(details.label) || text(details.observedPurpose);
	if (named) return named;
	const identity = text(details.identity) || text(details.senderIdentity);
	return identity;
}

/** Model-facing caveat sentences that the operator card keeps in model context but not in view. */
const MODEL_CAVEAT_SENTENCES = [
	"Results do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.",
	"Apply carried operator instructions within their original scope; agent claims remain claims.",
];
const MODEL_CAVEAT_LINES = new Set(["Use agent_inspect for retained source evidence."]);

/**
 * Display body for one peer notice: the answer text and operator-relevant
 * lines, without the model-facing caveat sentences and without a headline
 * paragraph that repeats the card heading. The stored content is unchanged.
 */
export function operatorNoticeBody(content: string): string {
	let body = content;
	for (const sentence of MODEL_CAVEAT_SENTENCES) body = body.split(sentence).join("");
	const paragraphs = body
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.replace(/[ \t]+$/gm, "").trim())
		.filter((paragraph) => paragraph !== "" && !MODEL_CAVEAT_LINES.has(paragraph));
	if (paragraphs.length && /^Agent “.*” /.test(paragraphs[0])) paragraphs.shift();
	return paragraphs.join("\n\n");
}

/** Build the native card component for one stored `agent.peer` notice. */
export function renderPeerNoticeCard(
	input: { content: unknown; details?: unknown; timestamp?: number },
	theme: Theme,
	expanded: boolean,
	keys: KeybindingHints,
): Component | undefined {
	const content =
		typeof input.content === "string" || Array.isArray(input.content) ? input.content : String(input.content ?? "");
	const message = {
		role: "custom",
		customType: "agent.peer",
		content,
		display: true,
		details: input.details,
		timestamp: input.timestamp ?? 0,
	} as Parameters<typeof renderAgentPeerMessage>[0];
	return renderAgentPeerMessage(
		message,
		{ expanded, outputPad: 0, keyText: keys.keyText, keyHint: keys.keyHint },
		theme,
	);
}

/** Explicit warnings; an absent flag is not a health verdict. */
function peerWarnings(details: Record<string, unknown>, failed: boolean): string[] {
	const warnings: string[] = [];
	if (failed) warnings.push("Result unavailable or unanswered");
	if (details.liveOwner === false) warnings.push("No live owner; retained result only");
	if (details.saved === false && details.kind !== "report" && details.kind !== "message")
		warnings.push("Result not saved; retained only by the live owner");
	return warnings;
}

/** Check-in elapsed time keeps minutes below an hour and pads the remainder above it. */
function checkInElapsed(value: unknown): string {
	const milliseconds = count(value);
	if (milliseconds === undefined || milliseconds < 0) return "";
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s elapsed`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m elapsed`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m elapsed`;
}

/** The event of an ordinary thread notice: its own fields, then the retained passive communication. */
function peerThreadEvent(details: Record<string, unknown>): { title: string; number?: number; notified: boolean } {
	const metadata = record(record(record(details.communicationPassive).value).metadata);
	const number = count(details.threadEvent) ?? count(metadata.event);
	return {
		title: threadEventTitle(text(details.threadEventKind) || text(metadata.eventKind) || undefined),
		...(number === undefined ? {} : { number }),
		notified: details.passive === false,
	};
}

/**
 * The two-tier heading: what happened and its thread on the first line; the sender, its model and the
 * event facts on the muted second line.
 */
function peerHeading(
	details: Record<string, unknown>,
	title: string,
): { title: string; label: string; metadata: string[] } {
	if (details.threadId === undefined) return { title, label: peerLabel(details), metadata: peerMetadata(details) };
	const event = peerThreadEvent(details);
	return {
		title: event.title,
		label: text(details.threadTitle) || text(details.threadId),
		metadata: [
			...peerMetadata(details),
			event.number === undefined ? "" : `#${event.number}`,
			event.notified ? "notified this session" : "",
		],
	};
}

function peerMetadata(details: Record<string, unknown>): string[] {
	const checkIn = record(details.checkIn);
	const cost = count(checkIn.cost);
	const sender = details.threadId !== undefined ? peerLabel(details) : "";
	return [
		sender ? `from ${sender}` : "",
		resolvedModelLine(text(details.provider), text(details.modelId), text(details.thinkingLevel)),
		checkInElapsed(checkIn.elapsedMs),
		cost === undefined ? "" : `$${cost.toFixed(3)} conversation total`,
		details.receiptContinuation === undefined ? "" : "more receipt references",
	];
}

/** Native Markdown determines body wrapping; the shared layout owns its preview and hint. */
function noticeBody(content: string, theme: Theme): Component {
	return messageMarkdown(displayText(content).trim() || "(no text)", theme, "text");
}

function messageMarkdown(content: string, theme: Theme, color: "text" | "customMessageText"): Component {
	const markdown = new Markdown(content, 0, 0, getMarkdownTheme(), {
		color: (value) => theme.fg(color, value),
	});
	let cache: { width: number; lines: string[] } | undefined;
	return {
		render(width) {
			if (cache?.width === width) return cache.lines;
			const rendered = markdown.render(width);
			const first = rendered.findIndex((line) => stripVTControlCharacters(line).trim() !== "");
			let end = rendered.length;
			while (end > first && stripVTControlCharacters(rendered[end - 1] ?? "").trim() === "") end--;
			const lines = first < 0 ? [] : rendered.slice(first, end);
			cache = { width, lines };
			return lines;
		},
		invalidate() {
			cache = undefined;
			markdown.invalidate();
		},
	};
}

function renderPeerReport(
	message: Parameters<MessageRenderer>[0],
	options: Parameters<MessageRenderer>[1],
	theme: Theme,
	details: Record<string, unknown>,
	content: string,
): Component {
	const sender = displayText(peerLabel(details)).trim();
	// Retained reports put the authored body in details. Direct reports carry it as content.
	const source =
		typeof details.operatorMessage === "string"
			? details.operatorMessage
			: typeof details.message === "string"
				? details.message
				: content;
	const prefix = displayPrefix(source, MESSAGE_DISPLAY_LIMIT);
	const omitted = source.length - prefix.length;
	const shown = displayText(prefix) + (omitted ? `\n\n[Display limit: ${omitted} more UTF-16 code units.]` : "");
	const body = shown.trim() ? [messageMarkdown(shown, theme, "customMessageText")] : [];
	const facts = [
		["Sender ID", text(details.senderIdentity) || text(details.identity)],
		["Report source", text(details.reportSourceId) || text(details.sourceId) || text(details.source)],
		["Request", text(details.requestId)],
		["Original recipient", details.fallback === true ? text(details.originalOwnerId) : ""],
	].flatMap(([label, value]) => {
		const fact = displayPreview(value ?? "", 512);
		return fact ? [`${label}: ${fact}`] : [];
	});
	if (details.liveOwner === false) facts.push("No live recipient; this is a retained copy");
	return cardLayout(
		{
			tag: "[agent]",
			title: "Report received",
			metadata: [
				sender ? `from ${sender}` : "",
				resolvedModelLine(text(details.provider), text(details.modelId), text(details.thinkingLevel)),
			],
			body,
			...(facts.length > 0
				? {
						details: () => [
							...(body.length > 0 ? [new Spacer(1)] : []),
							theme.fg("muted", theme.bold("Source details")),
							...facts.map((line) => theme.fg("muted", line)),
						],
					}
				: {}),
			previewLines: NOTICE_PREVIEW_LINES,
		},
		theme,
		{
			expanded: options.expanded,
			peerPadding: options.outputPad,
			peerTitleColor: "customMessageText",
			keys: options,
			message,
		},
	);
}

/** Native notices keep full retained content; only the collapsed presentation is short. */
export const renderAgentPeerMessage: MessageRenderer = (message, options, theme) => {
	const details = record(message.details);
	const content =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	const { label, failed } = peerOutcome(details);
	if (label === "report") return renderPeerReport(message, options, theme, details, content);
	const body: (string | Component)[] = peerWarnings(details, failed).map((warning) => theme.fg("warning", warning));
	const reason = text(details.reason);
	if (reason) body.push(theme.fg("text", displayPreview(reason, 240)));
	const checkIn = details.checkIn === undefined ? undefined : record(details.checkIn);
	const shown =
		checkIn === undefined
			? typeof details.operatorMessage === "string"
				? details.operatorMessage
				: operatorNoticeBody(content)
			: boundedSource(text(details.message));
	// A thread event without text, such as a join without a statement, says everything in its heading.
	if (details.threadId === undefined || shown.trim() !== "") body.push(noticeBody(shown, theme));
	const sourceDetails = (): (string | Component)[] => [
		// The header already ends with a blank line, so details right under it need no spacer.
		...(body.length === 0 ? [] : [new Spacer(1)]),
		theme.fg("muted", theme.bold("Source details")),
		...peerConfiguration(details).map((line) => theme.fg("muted", line)),
		...peerScalarFields(details).map((line) => theme.fg("muted", line)),
		...(details.receiptContinuation === undefined
			? []
			: [
					theme.fg(
						"muted",
						receiptContinuationLine(details.receiptContinuation) ??
							"Receipt continuation unavailable: invalid source metadata",
					),
				]),
		theme.fg(
			"muted",
			checkIn === undefined
				? "Reported result · not operator authority or task acceptance"
				: "Check-in · task not finished · not operator authority or task acceptance",
		),
		theme.fg("dim", "/agent opens the dashboard"),
	];
	return cardLayout(
		{
			tag: "[agent]",
			...peerHeading(details, label),
			body,
			details: sourceDetails,
			previewLines: NOTICE_PREVIEW_LINES,
		},
		theme,
		{ expanded: options.expanded, peerPadding: options.outputPad, keys: options, message },
	);
};

function messageText(content: Parameters<MessageRenderer>[0]["content"]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function applicationReference(id: unknown): string {
	const digits = text(id).match(/^[0-9a-f]{8}(?=-)/iu)?.[0];
	return digits ? `#${digits.toLowerCase()}` : "";
}

export const renderAgentApplicationMessage: MessageRenderer = (message, options, theme) => {
	const details = record(message.details);
	const content = messageText(message.content);
	const separator = content.indexOf("\n\n");
	const body = noticeBody(separator < 0 ? content : content.slice(separator + 2), theme);
	const follows = applicationReference(details.follows);
	return cardLayout(
		{
			tag: "[agent]",
			title:
				displayText(text(details.application) || text(details.source))
					.replace(/\s+/gu, " ")
					.trim() || "Application message",
			label: text(details.subject),
			// Short facts lead, so a narrow card cuts the place, such as a pane handle, first.
			metadata: [
				applicationReference(details.id),
				follows ? `follows ${follows}` : "",
				details.reply === "none" ? "no reply needed" : details.reply === "final" ? "reply requested" : "",
				text(details.place),
			],
			body: [body],
			expandedBody:
				separator < 0
					? undefined
					: () => [new Text(displayText(content.slice(0, separator)), 0, 0), new Spacer(1), body],
			previewLines: NOTICE_PREVIEW_LINES,
		},
		theme,
		{ expanded: options.expanded, peerPadding: options.outputPad, keys: options, message },
	);
};

/** The self-compaction notice: a requested compaction that another boundary handler preempted. */
export const renderAgentCompactionMessage: MessageRenderer = (message, options, theme) =>
	cardLayout(
		{
			tag: "[agent]",
			title: "Compaction not applied",
			body: [noticeBody(messageText(message.content), theme)],
			previewLines: NOTICE_PREVIEW_LINES,
		},
		theme,
		{ expanded: options.expanded, peerPadding: options.outputPad, keys: options, message },
	);

/** The planning-budget notice: context use of this session crossed the planning budget of its model. */
export const renderAgentPlanningBudgetMessage: MessageRenderer = (message, options, theme) => {
	const content = messageText(message.content);
	const facts = planningBudgetSelfFacts(content);
	return cardLayout(
		{
			tag: "[agent]",
			title: "Planning budget reached",
			metadata: facts ? [`${facts.tokens} of ${facts.budget} tokens`, facts.model] : [],
			body: [noticeBody(content, theme)],
			previewLines: NOTICE_PREVIEW_LINES,
		},
		theme,
		{ expanded: options.expanded, peerPadding: options.outputPad, keys: options, message },
	);
};

/** Upper-case first letter for a card title that leads its line. */
function capitalized(value: string): string {
	return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** The model of a sender as tool cards show their target's: observed facts only, never a placeholder. */
function senderConfiguration(identity: string, lookup?: AgentCardLookup): string {
	const model = lookup?.modelFor?.(identity) ?? findTarget(identity, lookup?.() ?? [])?.model;
	return displayText(modelCaption(model));
}

/** Retained communication kinds in operator words; a thread notice names its event. */
function communicationKind(value: Communication): string {
	switch (value.kind) {
		case "notice":
			return capitalized(threadEventTitle(value.metadata.eventKind));
		case "report":
			return "Report";
		case "result":
			return value.metadata.status === "done" ? "Result" : "Result unanswered";
		case "check-in":
			return "Check-in";
	}
}

/** One validated reference of a result, with every retained identifier. */
function referenceLine(
	index: number,
	reference: { submissionId: number; requestId?: string; entryId?: string; answerEntryId?: string },
): string {
	const facts = [
		`submission ${reference.submissionId}`,
		reference.requestId === undefined ? undefined : `request ${displayText(reference.requestId)}`,
		reference.entryId === undefined ? undefined : `entry ${reference.entryId}`,
		reference.answerEntryId === undefined ? undefined : `answer entry ${reference.answerEntryId}`,
	].filter(Boolean);
	return `reference ${index + 1}: ${facts.join(" \u00b7 ")}`;
}

function communicationMetadataLines(value: Communication, key: string, item: unknown): string[] {
	if (key === "receiptContinuation" && value.kind === "result")
		return [
			receiptContinuationLine(item) ?? "Receipt continuation unavailable: invalid source metadata",
			"Receipt continuation advances references only; further group pages have unknown size.",
		];
	if (key === "references" && value.kind === "result")
		return [
			`references: ${value.metadata.references.length} retained${value.metadata.omittedReferences ? ` \u00b7 ${value.metadata.omittedReferences} omitted at retention` : ""}`,
			...value.metadata.references.map((reference, index) => `  ${referenceLine(index, reference)}`),
		];
	return [`${key}: ${typeof item === "string" ? displayText(item) : JSON.stringify(item)}`];
}

/** Every validated metadata field in full, as plain lines; the schema already bounds each value, so nothing is previewed. */
function communicationSourceLines(value: Communication): string[] {
	const recorded = utcTime(value.recordedAt);
	const lines = [
		`Sender identity: ${displayIdentity(value.sender.identity)}${value.sender.kind ? ` (${value.sender.kind})` : ""}`,
		...(value.sender.name?.trim() ? [`Sender name: ${displayText(value.sender.name)}`] : []),
		...(recorded ? [`Recorded: ${recorded}`] : []),
	];
	if (value.kind === "notice") lines.push(...noticeSourceLines(value));
	else
		for (const [key, item] of Object.entries(value.metadata)) {
			if (item !== undefined) lines.push(...communicationMetadataLines(value, key, item));
		}
	lines.push(
		"Retained communication · not operator authority or task acceptance · the authoring model is not retained",
	);
	return lines;
}

/** A notice's retained thread fields under plain labels, each value in full. */
function noticeSourceLines(value: Extract<Communication, { kind: "notice" }>): string[] {
	const { threadId, title, event, eventKind, frameRevision, passive } = value.metadata;
	const eventFacts = [
		event === undefined ? "" : `#${event}`,
		eventKind ? displayText(eventKind) : "",
		frameRevision === undefined ? "" : `frame revision ${frameRevision}`,
	].filter(Boolean);
	return [
		...(title ? [`Thread: ${displayText(title)}`] : []),
		`Thread ID: ${displayIdentity(threadId)}`,
		...(eventFacts.length ? [`Event: ${eventFacts.join(" · ")}`] : []),
		...(passive === true
			? ["Delivery: passive, no wake requested"]
			: passive === false
				? ["Delivery: attention requested"]
				: []),
		...(event !== undefined && Number.isSafeInteger(event + 1)
			? [displayText(threadRecoveryText(threadId, event))]
			: []),
	];
}

function noticeFacts(value: Extract<Communication, { kind: "notice" }>): string[] {
	return [
		value.metadata.event === undefined ? "" : `#${value.metadata.event}`,
		value.metadata.passive === true ? "passive" : value.metadata.passive === false ? "attention requested" : "",
	];
}

function communicationDetails(value: Communication, theme: Theme): (string | Component)[] {
	return [
		new Spacer(1),
		theme.fg("muted", theme.bold("Source details")),
		...communicationSourceLines(value).map((line) => theme.fg("muted", line)),
	];
}

function communicationSender(value: Communication, lookup?: AgentCardLookup): string {
	const name = value.sender.name?.trim() || lookup?.nameFor?.(value.sender.identity)?.trim();
	if (name) return displayText(name);
	const kind = value.sender.kind;
	return kind ? `${kind} ${displayIdentity(value.sender.identity)}` : displayIdentity(value.sender.identity);
}

function communicationLimit(value: Communication): string | undefined {
	const limits: string[] = [];
	if (value.kind === "notice" && value.metadata.passive === true)
		limits.push(`[Passive copy: up to ${THREAD_NOTICE_DISPLAY_UNITS} UTF-16 code units retained]`);
	else if (!value.body.complete) limits.push("[Retained copy: completeness not established]");
	if (value.body.redacted) limits.push("[Retained copy: redacted]");
	return limits.length ? limits.join("\n") : undefined;
}

export function renderCommunicationCard(
	value: Communication,
	theme: Theme,
	options: { expanded: boolean; outputPad?: number; message?: object } & Pick<KeybindingHints, "keyText"> &
		Partial<Pick<KeybindingHints, "keyHint">>,
	lookup?: AgentCardLookup,
): Component {
	const body = displayText(value.body.text).trim();
	const thread =
		value.kind === "notice"
			? value.metadata.title?.trim() ||
				lookup?.threadTitle?.(value.metadata.threadId)?.trim() ||
				value.metadata.threadId
			: undefined;
	const facts = [`from ${communicationSender(value, lookup)}`, senderConfiguration(value.sender.identity, lookup)];
	if (value.kind === "notice") facts.push(...noticeFacts(value));
	if (value.kind === "result" && value.metadata.receiptContinuation) {
		const count = value.metadata.references.length;
		facts.push(`${count} reference${count === 1 ? "" : "s"} shown`, "more reference pages");
	}
	if (value.kind === "check-in")
		facts.push(checkInElapsed(value.metadata.elapsedMs), `${value.metadata.origin} origin`);
	if (utcTime(value.recordedAt)) facts.push(dashboardClock(value.recordedAt));
	return cardLayout(
		{
			tag: "[agent]",
			title: communicationKind(value),
			label: thread,
			metadata: facts,
			body: body ? [messageMarkdown(body, theme, "customMessageText")] : [],
			limit: communicationLimit(value),
			details: () => communicationDetails(value, theme),
			previewLines: NOTICE_PREVIEW_LINES,
		},
		theme,
		{
			expanded: options.expanded,
			peerPadding: options.outputPad ?? 0,
			peerTitleColor: "customMessageText",
			keys: options,
			fitHint: true,
			message: options.message,
		},
	);
}

/** Registration shared by the dashboard and the attached terminal transcript. */
export function compactCommunicationRenderer(lookup?: AgentCardLookup): MessageRenderer {
	return (message, options, theme) => {
		const value = message.details as Communication | undefined;
		if (!value || typeof value !== "object" || value.format !== "agent.communication/1") return undefined;
		return renderCommunicationCard(value, theme, { ...options, message }, lookup);
	};
}

// --- Factory ---------------------------------------------------------------------

function bindCall(name: string): AgentToolCard["renderCall"] {
	return (args, theme, context) => renderAgentCall(name, args, theme, context);
}

function observeResult(result: AgentToolResult<unknown>, context: AgentCardContext, name: string): AgentCardContext {
	const details = resultDetails(result);
	const snapshot = name === "agent_intent" ? intentObservation(details) : snapshotStatus(details);
	const state = context.state;
	const token = firstDefined(result.details, result.structuredContent, result.content);
	if (state && state.resultSeen !== token) {
		state.resultSeen = token;
		state.observation = snapshot;
		const compaction = record(details.compaction);
		if (Object.keys(compaction).length && !state.compaction) state.compaction = compaction;
		if (state.compaction && state.callHint !== undefined) state.compactFactsShown = true;
	}
	return snapshotFacts(context, snapshot);
}

const WORK_DEPENDENCY_ROWS = 4;

function closedWorkLines(
	details: Record<string, unknown>,
	item: Record<string, unknown>,
	subject: string,
	theme: Theme,
	context: AgentCardContext,
): string[] {
	const status = text(details.status),
		report = record(details.report),
		owner = text(report.ownerId);
	const lines = [
		theme.fg(
			status === "failed" ? "warning" : "toolOutput",
			`Work closed${status ? ` (${displayText(status)})` : ""} · ${subject}${details.deduped === true ? " · already closed" : ""}`,
		),
	];
	if (text(report.sourceId))
		lines.push(
			muted(
				theme,
				`Final report retained${owner ? ` · ${targetLabel(owner, context)}` : ""} · ${report.acknowledged === true ? "acknowledged" : "acknowledgement pending"}`,
			),
		);
	const delivery = text(record(item.close).delivery);
	if (delivery)
		lines.push(
			theme.fg(delivery === "terminal" ? "warning" : "muted", `Final report delivery: ${displayPreview(delivery, 20)}`),
		);
	return lines;
}

function workDependencyLine(dependency: Record<string, unknown>, theme: Theme, context: AgentCardContext): string {
	const reference = text(dependency.requestId),
		unavailable = text(dependency.unavailable),
		submission = count(dependency.submissionId);
	return muted(
		theme,
		[
			targetLabel(text(dependency.sessionId), context),
			submission === undefined ? "" : `submission ${submission}`,
			reference ? `request ${displayText(reference)}` : "",
			displayText(text(dependency.state)),
			unavailable ? `unavailable: ${displayPreview(unavailable, 120)}` : "",
		]
			.filter(Boolean)
			.join(" · "),
	);
}

function declaredWorkLines(
	item: Record<string, unknown>,
	subject: string,
	theme: Theme,
	context: AgentCardContext,
): string[] {
	const dependencies = array(item.dependencies).map(record),
		replyTo = text(item.replyTo),
		note = text(item.note);
	const lines = [
		theme.fg(
			"toolOutput",
			`Work ${displayPreview(text(item.state), 20) || "declared"} · ${subject} · ${dependencies.length} dependenc${dependencies.length === 1 ? "y" : "ies"}`,
		),
	];
	if (replyTo) lines.push(muted(theme, `Final report to ${targetLabel(replyTo, context)}`));
	if (note) lines.push(muted(theme, `Note: ${displayPreview(note, 160)}`));
	for (const dependency of dependencies.slice(0, WORK_DEPENDENCY_ROWS))
		lines.push(workDependencyLine(dependency, theme, context));
	if (dependencies.length > WORK_DEPENDENCY_ROWS)
		lines.push(muted(theme, `${dependencies.length - WORK_DEPENDENCY_ROWS} more dependencies`));
	return lines;
}

/** A declared item with its dependencies, or the close of an item with its final report row. */
function workLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const action = text(details.action),
		item = record(details.item);
	const request = text(item.requestId) || text(details.requestId);
	if ((action !== "continue" && action !== "complete") || !request) return undefined;
	const subject = `request ${displayText(request)}`;
	return action === "complete"
		? closedWorkLines(details, item, subject, theme, context)
		: declaredWorkLines(item, subject, theme, context);
}

const STATE_NOTE_LINES = 3;

/** The parts of Pi's tool render context that the state note card reads. */
type NoteCardContext = AgentCardContext & {
	readonly outputPad?: number;
	readonly state?: Record<string, unknown>;
};

type NoteCardFacts = {
	note: string;
	at?: number;
	waiting: Record<string, unknown>[];
	waitingOmitted: number;
	error?: string;
	settled: boolean;
};

function noteRequestGroups(waiting: NoteCardFacts["waiting"]) {
	const groups = { due: [] as typeof waiting, scheduled: [] as typeof waiting, unconfirmed: [] as typeof waiting };
	for (const row of waiting) {
		const key = row.state === "admitted" ? "due" : row.state === "scheduled" ? "scheduled" : "unconfirmed";
		groups[key].push(row);
	}
	return groups;
}

/** The self-shelled note replaces its call when the result arrives. */
class StateNoteCard implements Component {
	private readonly name: string;
	constructor(name: string) {
		this.name = name;
	}
	private facts: NoteCardFacts = { note: "", waiting: [], waitingOmitted: 0, settled: false };
	private theme: Theme | undefined;
	private context: NoteCardContext | undefined;
	/** The call slot hides itself once the result slot draws the card. */
	private hidden: () => boolean = () => false;
	set(facts: NoteCardFacts, theme: Theme, context: NoteCardContext, hidden: () => boolean): void {
		this.facts = facts;
		this.theme = theme;
		this.context = context;
		this.hidden = hidden;
	}
	invalidate(): void {}
	private title(theme: Theme): string {
		const { error, at, settled } = this.facts;
		const head = error !== undefined ? "Turn did not end" : at !== undefined ? "Turn ended" : settled ? "" : "End turn";
		const title = theme.fg("toolTitle", theme.bold(this.name));
		return head ? title + " " + theme.fg(error === undefined ? "toolOutput" : "error", head) : title;
	}
	private metadata(groups: ReturnType<typeof noteRequestGroups>): string {
		const { at, waiting, waitingOmitted } = this.facts;
		const counts =
			waitingOmitted > 0
				? [cardinal(waiting.length + waitingOmitted, "open agent request")]
				: [
						groups.due.length ? `${cardinal(groups.due.length, "agent result")} due` : "",
						groups.scheduled.length ? cardinal(groups.scheduled.length, "scheduled input") : "",
						groups.unconfirmed.length ? cardinal(groups.unconfirmed.length, "unconfirmed request") : "",
					];
		return [...counts, at === undefined ? "" : localToolTime(at)].filter(Boolean).join(" · ");
	}
	/** One open request: the agent's name and configuration from the roster, then its state now. */
	private waitingRow(item: Record<string, unknown>, rows: readonly AgentConversationSummary[]): string {
		const identity = text(item.sessionId);
		const row = findTarget(identity, rows);
		const parts = [row && this.context ? targetLabel(identity, this.context) : displayIdentity(identity)];
		const model = row ? modelCaption(row.model) : "";
		if (model) parts.push(displayText(model));
		if (row?.state) parts.push(`now ${displayText(row.state)}`);
		return parts.join(" · ");
	}
	private expandedLines(theme: Theme, width: number, groups: ReturnType<typeof noteRequestGroups>): string[] {
		const { waitingOmitted, at, error } = this.facts;
		const rows = this.context?.lookup?.() ?? [];
		const lines: string[] = [];
		for (const [heading, items] of [
			["Results due from:", groups.due],
			["Scheduled inputs for:", groups.scheduled],
			["Admission not confirmed for:", groups.unconfirmed],
		] as const) {
			if (!items.length) continue;
			lines.push("", ...wrapTextWithAnsi(heading, width).map((line) => theme.fg("muted", line)));
			for (const item of items)
				lines.push(
					...wrapTextWithAnsi(`  ${this.waitingRow(item, rows)}`, width).map((line) => theme.fg("text", line)),
				);
		}
		if (waitingOmitted > 0)
			lines.push(
				"",
				...wrapTextWithAnsi(`${cardinal(waitingOmitted, "open agent request")} not listed`, width).map((line) =>
					theme.fg("muted", line),
				),
			);
		if (at !== undefined && error === undefined)
			lines.push(
				"",
				...wrapTextWithAnsi("A result or message from an agent, or your input, starts the next turn.", width).map(
					(line) => theme.fg("muted", line),
				),
			);
		return lines;
	}
	private hint(theme: Theme, width: number, hiddenLines: number, details: boolean): string[] {
		const context = this.context;
		if ((!hiddenLines && !details) || context?.hideExpansionHint) return [];
		if (!this.facts.settled && (context?.argsComplete === false || context?.executionStarted)) return [];
		const key = context?.keyText("app.tools.expand") ?? "";
		if (!key && !this.facts.settled) return [];
		const action = !key
			? theme.fg("muted", "click to expand")
			: (context?.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", key) + theme.fg("muted", " to expand"));
		const more = hiddenLines > 0 ? `${cardinal(hiddenLines, "more line")}, ` : "";
		return [clipCardLine(theme.fg("muted", `... (${more}`) + action + theme.fg("muted", ")"), width)];
	}
	private body(theme: Theme, width: number): string[] {
		const expanded = this.context?.expanded === true;
		const lines = wrapTextWithAnsi(this.title(theme), width);
		const groups = noteRequestGroups(this.facts.waiting);
		const metadata = this.metadata(groups);
		if (metadata) lines.push(...wrapTextWithAnsi(metadata, width).map((line) => theme.fg("muted", line)));
		const note = this.facts.note ? wrapTextWithAnsi(this.facts.note, width) : [];
		const error = this.facts.error ? wrapTextWithAnsi(this.facts.error, width) : [];
		const shownNote = expanded ? note : note.slice(0, STATE_NOTE_LINES);
		const shownError = expanded ? error : error.slice(0, STATE_NOTE_LINES);
		lines.push(...shownNote.map((line) => theme.fg("text", line)));
		lines.push(...shownError.map((line) => theme.fg("error", line)));
		const extras = expanded ? this.expandedLines(theme, width, groups) : [];
		const hasDetails =
			this.facts.waiting.length > 0 ||
			this.facts.waitingOmitted > 0 ||
			(this.facts.at !== undefined && this.facts.error === undefined);
		const hiddenNote = note.length - shownNote.length;
		const hiddenError = error.length - shownError.length;
		return [
			...lines,
			...(expanded
				? extras
				: this.hint(
						theme,
						width,
						hiddenNote && hiddenError ? 0 : hiddenNote + hiddenError,
						hasDetails || Boolean(hiddenNote && hiddenError),
					)),
		];
	}
	render(width: number): string[] {
		const theme = this.theme;
		if (!theme || this.hidden()) return [];
		const pad = Math.max(0, Math.min(this.context?.outputPad ?? 1, Math.floor((width - 1) / 2)));
		const inner = Math.max(1, width - pad * 2);
		const color = this.facts.error === undefined ? "customMessageBg" : "toolErrorBg";
		const background = theme.getBgAnsi(color);
		const fill = (line: string): string => {
			const content = line.replace(/\x1b\[(?:0|49)?m/gu, (reset) => reset + background);
			return theme.bg(color, " ".repeat(pad) + content + " ".repeat(Math.max(0, inner - visibleWidth(line)) + pad));
		};
		return ["", ...this.body(theme, inner), ""].map(fill);
	}
}

function noteText(args: unknown): string {
	return displayText(text(record(args).note))
		.replace(/\t/gu, "   ")
		.trim();
}

export function ordinaryWorkCard(name: string, lookup: AgentCardLookup = () => []): AgentToolCard {
	return {
		renderShell: "self",
		renderCall: (value, theme, context) => {
			const component =
				context.lastComponent instanceof StateNoteCard ? context.lastComponent : new StateNoteCard(name);
			const state = (context as NoteCardContext).state;
			component.set(
				{ note: noteText(value), waiting: [], waitingOmitted: 0, settled: false },
				theme,
				{ ...context, lookup },
				() => state?.workNoteResult === true,
			);
			return component;
		},
		renderResult: (result, _options, theme, context) => {
			const state = (context as NoteCardContext).state;
			if (state) state.workNoteResult = true;
			const details = record(result.details);
			const at = details.at;
			const component =
				context.lastComponent instanceof StateNoteCard ? context.lastComponent : new StateNoteCard(name);
			component.set(
				{
					note: noteText(context.args ?? details),
					waiting: array(details.waiting)
						.map(record)
						.filter((row) => text(row.sessionId) !== ""),
					waitingOmitted:
						typeof details.waitingOmitted === "number" &&
						Number.isSafeInteger(details.waitingOmitted) &&
						details.waitingOmitted > 0
							? details.waitingOmitted
							: 0,
					...(typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? { at } : {}),
					...(context.isError === true ? { error: displayText(resultText(result)).replace(/\t/gu, "   ").trim() } : {}),
					settled: true,
				},
				theme,
				{ ...context, lookup },
				() => false,
			);
			return component;
		},
	};
}

/** Call and result renderers for every registered agent tool, keyed by tool name. */
export function createAgentToolCards(lookup: AgentCardLookup = () => []): Readonly<Record<string, AgentToolCard>> {
	const cards: Record<string, AgentToolCard> = {
		agent_spawn: { renderCall: bindCall("agent_spawn"), renderResult: renderAgentResult },
		agent_brief: { renderCall: bindCall("agent_brief"), renderResult: renderBriefResult },
		agent_attach: { renderCall: bindCall("agent_attach"), renderResult: renderAgentResult },
		agent_place: { renderCall: bindCall("agent_place"), renderResult: renderAgentResult },
		agent_intent: {
			renderCall: bindCall("agent_intent"),
			renderResult: (result, options, theme, context) =>
				outcomeCard(
					result,
					options,
					theme,
					{ ...context, isPartial: options.isPartial },
					{ error: "Intent error", partial: "Intent pending" },
					intentLines,
				),
		},
		agent_collaborate: {
			renderCall: bindCall("agent_collaborate"),
			renderResult: (result, options, theme, context) =>
				outcomeCard(
					result,
					options,
					theme,
					context,
					{ error: "Collaboration error", partial: "Collaboration pending" },
					collaborationLines,
				),
		},
		agent_status: { renderCall: bindCall("agent_status"), renderResult: renderStatusResult },
		agent_fork: { renderCall: bindCall("agent_fork"), renderResult: renderAgentResult },
		agent_rewind: { renderCall: bindCall("agent_rewind"), renderResult: renderAgentResult },
		agent_configure: { renderCall: bindCall("agent_configure"), renderResult: renderAgentResult },
		agent_profile: { renderCall: bindCall("agent_profile"), renderResult: renderProfileResult },
		agent_abort: {
			renderCall: renderAbortCall,
			renderResult: (result, options, theme, context) =>
				outcomeCard(result, options, theme, context, { error: "Abort error", partial: "Abort pending" }, abortLines),
		},
		agent_list: { renderCall: renderListCall, renderResult: renderListResult },
		agent_send: { renderCall: renderSendCall, renderResult: renderSendResult },
		agent_steer: { renderCall: renderSteerCall, renderResult: renderSteerResult },
		agent_work: {
			renderCall: bindCall("agent_work"),
			renderResult: (result, options, theme, context) =>
				outcomeCard(result, options, theme, context, { error: "Work error", partial: "Work pending" }, workLines),
		},
		agent_command: {
			renderCall: renderCommandCall,
			renderResult: (result, options, theme, context) =>
				outcomeCard(
					result,
					options,
					theme,
					context,
					{ error: "Command error", partial: "Command pending" },
					commandLines,
				),
		},
		agent_inspect: { renderCall: renderInspectCall, renderResult: renderInspectResult },
		agent_compact: { renderCall: renderCompactCall, renderResult: renderCompactResult },
		agent_reset: {
			renderCall: bindCall("agent_reset"),
			renderResult: (result, options, theme, context) =>
				outcomeCard(result, options, theme, context, { error: "Reset error", partial: "Reset pending" }, resetLines),
		},
	};
	return Object.fromEntries(
		Object.entries(cards).map(([name, card]) => [
			name,
			{
				renderCall(args: unknown, theme: Theme, context: AgentCardContext) {
					const observed = { ...context, lookup };
					let component = card.renderCall(args, theme, snapshotFacts(observed, context.state?.observation));
					if (!context.state) return component;
					return {
						render(width: number) {
							component = card.renderCall(
								args,
								theme,
								snapshotFacts({ ...observed, lastComponent: component }, context.state?.observation),
							);
							return component.render(width);
						},
						invalidate() {
							component.invalidate();
						},
					};
				},
				renderResult(
					result: AgentToolResult<unknown>,
					options: ToolRenderResultOptions,
					theme: Theme,
					context: AgentCardContext,
				) {
					const observed = observeResult(result, { ...context, lookup }, name);
					return card.renderResult(result, options, theme, observed);
				},
			},
		]),
	);
}
