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
import { AnswerContinuationSchema } from "./observation-schema.ts";
import { FinalReportReadSchema } from "./open-work-schema.ts";
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

/** Maximum UTF-16 code units retained for a displayed message body. */
export const SOURCE_DISPLAY_LIMIT = 32_000;
const NOTICE_PREVIEW_LINES = 3;

/**
 * Card context: the subset of `ToolRenderContext` these renderers read. Pi
 * injects `keyText` with the operator's configured keybindings.
 */
export interface AgentCardContext extends ToolCardGrammarContext {
	readonly args?: unknown;
	readonly lookup?: AgentCardLookup;
	readonly state?: NonNullable<ToolCardGrammarContext["state"]> & {
		compaction?: Record<string, unknown>;
		observation?: Record<string, unknown>;
		resultSeen?: unknown;
	};
	readonly executionStarted?: boolean;
	readonly isPartial?: boolean;
	readonly expanded: boolean;
	readonly argsComplete?: boolean;
	readonly isError?: boolean;
	readonly lastComponent?: Component;
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

/** Pi owns the row background; clipping must close text styles without ending it. */
function clipCardLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "…").replace(
		/\x1b\[0m…\x1b\[0m$/u,
		"…\x1b[22;23;24;25;27;28;29;39m",
	);
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
	readonly previewLines?: number;
}

interface CardLayoutOptions {
	readonly expanded: boolean;
	readonly peerPadding: number;
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

/** The title line and the muted facts line; message cards draw their bracket label in Pi's label colour. */
function cardHeader(sections: CardSections, theme: Theme, options: CardLayoutOptions): string[] {
	const header: string[] = [];
	const tag = sections.tag ? `${theme.fg("customMessageLabel", theme.bold(sections.tag))} ` : "";
	const label = sections.label
		? theme.fg(options.peerTitleColor ?? "text", ` · ${displayText(sections.label).replace(/\s+/gu, " ").trim()}`)
		: "";
	if (sections.title) {
		const titleColor = options.peerTitleColor ?? "text";
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
	const header = cardHeader(sections, theme, options);
	const content = sections.body ?? [];
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

function resolvedTargetFact(selector: string, context: AgentCardContext): string | undefined {
	const identity = findTarget(selector, context.lookup?.() ?? [])?.id;
	return identity && identity !== selector ? `  resolved target: ${identity}` : undefined;
}

export function renderSendCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const deadline = dashboardClock(Date.parse(text(args.deliverAt)));
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

function intentPresentation(
	details: Record<string, unknown>,
	context: AgentCardContext,
): ToolResultPresentation | undefined {
	const identity = text(intentObservation(details)?.identity);
	if (!identity) return undefined;
	if (details.published !== undefined) {
		const claim = record(record(details.published).intentClaim);
		return {
			outcome: claim.purpose === undefined ? `Intent cleared · ${identity}` : `Intent published · ${identity}`,
			body: claim.purpose === record(context.args).purpose ? undefined : text(claim.purpose),
		};
	}
	const awareness = record(details.awareness);
	const presence = record(awareness.presence),
		threads = record(awareness.threads);
	const effects = Array.isArray(presence.efforts) ? quantity(presence.efforts.length, "related effort") : "";
	const hints = Array.isArray(threads.items) ? quantity(threads.items.length, "thread hint") : "";
	const partial =
		record(presence.coverage).complete === false ||
		record(threads.coverage).complete === false ||
		record(awareness.self).omitted === true;
	return {
		outcome: `Related efforts read · ${identity}`,
		limit: partial ? "Coverage incomplete" : undefined,
		body: factLines([
			effects,
			hints,
			...array(presence.efforts).map((entry) => {
				const effort = record(entry);
				const who = text(effort.name) || text(effort.id);
				const claim = text(record(effort.intentClaim).purpose) || text(effort.purposeClaim);
				return who ? [who, text(effort.liveness), claim].filter(Boolean).join(" · ") : "";
			}),
			...array(threads.items).map((item) => text(record(item).title)),
		]),
	};
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

	const presentSpawnOrBrief = () => {
		const subject = target() || target("handle", (input) => `@${input.replace(/^@/u, "")}`) || take("name");
		if (!shownArgs.includes("name")) facts.push(take("name", "name "));
		creation();
		facts.push(take("cwd", "in ", homePath));
		if (name !== "agent_brief") return { subject, body: bodyFor("prompt", "role") };
		facts.push(take("kind"), take("mode", "mode "), flag("preview", "preview"), ...briefSectionFacts(args));
		return { subject, body: bodyFor("objective") };
	};

	const presentIntent = () => {
		const identity = text(context.state?.observation?.identity);
		const subject =
			args.action === "read" ? "related efforts" : identity ? targetLabel(identity, context) : "this session";
		facts.push(targetConfiguration(identity, context), take("action"));
		if (identity && identity !== subject) expanded = `  resolved session: ${identity}`;
		return { subject, body: bodyFor("purpose") };
	};

	const presentList = () => {
		let subject = take("query");
		if (subject) facts.push(take("cwd", "in ", homePath));
		else subject = take("cwd", "", homePath) || "stored conversations";
		facts.push(take("limit", "limit "), text(args.cursor) ? "continuation page" : "");
		return subject;
	};

	const presentCommand = () => {
		const subject = take("name");
		const recipient = target();
		facts.push(recipient ? `on ${recipient}` : "", observedModel());
		if (text(args.args).includes("\n")) return { subject, body: bodyFor("args") };
		facts.push(take("args", "args "));
		return { subject, body: undefined };
	};

	const presentInspect = () => {
		const query = take("query");
		const entry = take("entryId", "entry ");
		const operation = take("operationId", "operation ");
		const submission = take("submissionId", "submission ");
		const request = take("requestId", "request ");
		const recipient = target() || "this session";
		const objects = [query, entry, operation, submission, request].filter(Boolean);
		const subject = objects.shift() || recipient;
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
		return subject;
	};

	const presentCollaboration = () => {
		const thread = text(args.threadId);
		const title = thread ? context.lookup?.threadTitle?.(thread)?.trim() : undefined;
		const targetSession = target();
		let subject = title || take("threadId") || take("title") || take("query") || targetSession;
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
		return { subject, body: bodyFor("message", "participation", "purpose") };
	};

	const presentWork = () => {
		const subject = take("request", "request ") || "open work";
		facts.push(
			take("action"),
			take("status"),
			Array.isArray(args.results) && args.results.length ? cardinal(args.results.length, "result reference") : "",
		);
		if (Array.isArray(args.results) && !args.results.length) shownArgs.push("results");
		return { subject, body: bodyFor("message", "note") };
	};

	switch (name) {
		case "agent_spawn":
		case "agent_brief":
			({ subject, body } = presentSpawnOrBrief());
			break;
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
		case "agent_intent":
			({ subject, body } = presentIntent());
			break;
		case "agent_list":
			subject = presentList();
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
		case "agent_command":
			({ subject, body } = presentCommand());
			break;
		case "agent_inspect":
			subject = presentInspect();
			break;
		case "agent_collaborate":
			({ subject, body } = presentCollaboration());
			break;
		case "agent_work":
			({ subject, body } = presentWork());
			break;
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

function timerLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const timer = count(details.timerId);
	if (timer === undefined) return undefined;
	const deadline = count(details.deadline);
	if (deadline !== undefined) {
		const when = dashboardClock(deadline) || "deadline unavailable";
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
	const tasks = shown ? ` · pending tasks ${shown}${ids.length > 4 ? ", …" : ""}` : "";
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

function commandFacts(details: Record<string, unknown>, identity: string, context: AgentCardContext): string {
	const name = text(details.name);
	return [
		name && name !== record(context.args).name ? `Command ${name}` : "",
		identity && !sameTarget(identity, context) ? targetLabel(identity, context) : "",
	]
		.filter(Boolean)
		.join("\n");
}

function commandPresentation(details: Record<string, unknown>, context: AgentCardContext): ToolResultPresentation {
	const identity = text(details.identity) || text(details.sessionId);
	const facts = commandFacts(details, identity, context);
	if (details.reloaded === true) {
		const countInstalled = count(details.contributionCount) ?? array(record(details.inventory).contributions).length;
		return {
			outcome: "Host registrations reloaded",
			body: countInstalled ? `${cardinal(countInstalled, "native contribution")} installed` : "",
			expanded: facts,
		};
	}
	const fork =
		text(details.forkedIdentity) ||
		(record(context.args).name === "tree" && typeof details.deduped === "boolean" ? identity : "");
	if (fork)
		return {
			outcome: `${details.deduped === true ? "Existing tree fork" : "Tree fork created"} · ${targetLabel(fork, context)}`,
			expanded: facts,
		};
	if (typeof details.text !== "string") return {};
	return {
		outcome: details.text.trim() ? "Command completed" : "Command completed with no output",
		body: details.text,
		expanded: facts,
		keep: "end",
	};
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

function latestSavedResult(submissions: unknown, label = "Saved: "): string | undefined {
	const rows = array(submissions)
		.map(record)
		.filter((row) => row.type === "input" && (row.status === "done" || row.status === "unanswered"));
	const last = rows.at(-1);
	if (!last) return undefined;
	const id = count(last.id);
	return `${label}${text(last.status)}${id === undefined ? "" : ` · submission ${id}`}`;
}

/** A saved entry names its author; it does not establish what the current run is doing. */
function newestTextLabel(role: string): string {
	if (role === "assistant") return "Latest reply";
	return role === "user" ? "Latest input" : "Latest message";
}

function providerBlockLines(block: unknown, theme: Theme, compact = false): string[] {
	if (!matchesSchema(ProviderBlockFactSchema, block))
		return [muted(theme, "Provider block unavailable: invalid native fact")];
	const lines = compact ? providerBlockSummary(block) : [providerBlockText(block)];
	return lines.map((line) => theme.fg("warning", displayText(line)));
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

function statusTimerFact(status: Record<string, unknown>): string {
	const timer = record(array(status.timers)[0]);
	if (count(timer.id) === undefined) return "";
	const deadline = count(timer.deadline);
	const when = deadline === undefined ? "" : dashboardClock(deadline);
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
		lastText ? `${newestTextLabel(text(status.lastTextRole))} · ${lastText}` : "",
		latestSavedResult(status.submissions, "Saved result · ") ?? "",
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

function controlResultCard(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
	presentation: ToolResultPresentation,
): Component {
	const source = resultText(result);
	const details = resultDetails(result);
	const { text: output, ...rest } = details;
	const evidence = output === source || output === presentation.body ? rest : details;
	const sourceHasDetails = source === JSON.stringify(details) || source === JSON.stringify(details, null, 2);
	const extra = !sourceHasDetails && Object.keys(evidence).length ? JSON.stringify(evidence, null, 2) : "";
	return toolResultCard(result, options, theme, context, {
		...presentation,
		expanded: [presentation.expanded, extra].filter(Boolean).join("\n"),
	});
}

type MutationTool = "agent_spawn" | "agent_attach" | "agent_place" | "agent_fork" | "agent_rewind" | "agent_configure";
type ControlTool = MutationTool | "agent_abort" | "agent_command" | "agent_reset";

function mutationAdmission(details: Record<string, unknown>): Record<string, unknown> {
	const admission = record(details.admission);
	return { ...details, ...record(details.result), ...admission, placement: admission.placement ?? details.placement };
}

function mutationReceipt(outcome: string, admission: Record<string, unknown>): string {
	const submission = count(admission.submissionId);
	return [outcome, submission === undefined ? "" : `submission ${submission}`, receiptPlacement(admission)]
		.filter(Boolean)
		.join(" · ");
}

function mutationPlacement(admission: Record<string, unknown>): string {
	return receiptPlacement(admission) === "withdrawn"
		? WITHDRAWN_INPUT_LINE
		: receiptPlacement(admission) === "unplaced"
			? UNPLACED_INPUT_LINE
			: "";
}

function configurationOutcome(
	details: Record<string, unknown>,
	snapshot: Record<string, unknown> | undefined,
	suffix: string,
): string | undefined {
	if (details.outcome === "applied") return `Configuration applied${suffix}`;
	const agent = record(snapshot?.agent);
	const model = record(agent.model);
	if (text(agent.thinkingLevel) || text(model.provider) || text(model.modelId))
		return `Configuration observed${suffix}`;
	return undefined;
}

function configurationFacts(details: Record<string, unknown>, identity: string, context: AgentCardContext): string[] {
	const before = record(details.before);
	const after = record(details.after);
	const reasoning = record(details.reasoning);
	const model = [text(after.model), text(after.thinkingLevel)].filter(Boolean).join(" · ");
	return [
		text(after.name) && after.name !== before.name && !headerHasName(identity, text(after.name), context)
			? `Renamed to ${after.name}`
			: "",
		(after.model !== before.model || after.thinkingLevel !== before.thinkingLevel) &&
		(!sameTarget(identity, context) || targetConfiguration(identity, context) !== model)
			? model
			: "",
		reasoning.clamped === true && text(reasoning.effective) ? `Reasoning adjusted to ${reasoning.effective}` : "",
	].filter(Boolean);
}

function mutationSnapshotFacts(
	snapshot: Record<string, unknown>,
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
	namedByReceipt: boolean,
): string[] {
	const ordinaryOnly = array(
		record(details.inventory ?? record(details.status).inventory ?? snapshot.limits).ordinaryOnly,
	).length;
	return [
		...snapshotIdentityLines(snapshot, theme, context, namedByReceipt).map(displayText),
		readOnlySnapshot(details) ? "Live activity not observed" : text(snapshot.state),
		ordinaryOnly ? `${cardinal(ordinaryOnly, "configured extension")} without a native form` : "",
	];
}

function mutationTargetSuffix(identity: string, details: Record<string, unknown>, context: AgentCardContext): string {
	const name = text(details.name) || text(record(details.profile).name) || text(record(details.creation).name);
	if (!identity || headerHasName(identity, name, context) || sameTarget(identity, context)) return "";
	return name && targetLabel(identity, context) === displayIdentity(identity)
		? ` · ${name}`
		: targetSuffix(identity, context);
}

function mutationFacts(
	details: Record<string, unknown>,
	snapshot: Record<string, unknown> | undefined,
	theme: Theme,
	context: AgentCardContext,
	namedByReceipt: boolean,
): string[] {
	const snapshotError = text(details.snapshotError);
	const deliveryError = text(details.deliveryError) || text(record(details.status).deliveryError);
	return [
		snapshotError ? `Snapshot unavailable: ${snapshotError}` : "",
		deliveryError ? `Delivery paused: ${deliveryError}` : "",
		...(snapshot ? mutationSnapshotFacts(snapshot, details, theme, context, namedByReceipt) : []),
		...(details.availability === "initializing" ? ["Agent initialization in progress"] : []),
	].filter(Boolean);
}

type MutationTarget = { identity: string; suffix: string; facts: string[] };

function admissionRecorded(admission: Record<string, unknown>): boolean {
	return count(admission.submissionId) !== undefined || admission.admitted === true;
}

function ownerPresentation(
	name: "agent_spawn" | "agent_place",
	details: Record<string, unknown>,
	{ identity, suffix, facts }: MutationTarget,
	context: AgentCardContext,
): ToolResultPresentation {
	const action =
		name === "agent_place"
			? "Directory owner resolved"
			: details.created === true
				? "Agent created"
				: details.created === false
					? "Agent reused"
					: "Agent resolved";
	const admission = mutationAdmission(details);
	if (!admissionRecorded(admission)) return { outcome: identity ? action + suffix : undefined, body: facts.join("\n") };
	const disposition =
		receiptPlacement(admission) === "withdrawn"
			? "Dispatch withdrawn"
			: admission.deduped === true
				? "Already admitted"
				: "Admitted";
	const configuration = !callIdentity(context) ? targetConfiguration(identity, context) : "";
	return {
		outcome: [mutationReceipt(disposition + suffix, admission), configuration].filter(Boolean).join(" · "),
		expanded: [action, mutationPlacement(admission), ...facts.filter((fact) => fact !== configuration)]
			.filter(Boolean)
			.join("\n"),
	};
}

function branchPresentation(
	name: "agent_fork" | "agent_rewind",
	details: Record<string, unknown>,
	{ identity, suffix, facts }: MutationTarget,
): ToolResultPresentation {
	const conversation = count(details.conversationId);
	if (conversation === undefined) return {};
	const branch =
		suffix ||
		(!identity ? ` · ${[text(details.name), `conversation ${conversation}`].filter(Boolean).join(" · ")}` : "");
	const deduped = details.deduped === true;
	const action =
		name === "agent_rewind"
			? deduped
				? "Rewind already submitted"
				: "Rewind submitted"
			: deduped
				? "Existing fork reused"
				: "Fork created";
	const admission = mutationAdmission(details);
	const predecessor = count(details.predecessorEntryId);
	const outcome = mutationReceipt(action + branch, admission);
	const evidence = [
		predecessor === undefined ? "" : `Forked before entry ${predecessor}`,
		mutationPlacement(admission),
		...facts,
	]
		.filter(Boolean)
		.join("\n");
	return name === "agent_rewind" || admissionRecorded(admission)
		? { outcome, expanded: evidence }
		: { outcome, body: evidence };
}

function mutationPresentation(
	name: MutationTool,
	details: Record<string, unknown>,
	theme: Theme,
	context: AgentCardContext,
): ToolResultPresentation {
	const snapshot = snapshotStatus(details);
	const identity = text(details.identity) || text(details.sessionId) || text(snapshot?.identity);
	const suffix = mutationTargetSuffix(identity, details, context);
	const facts = mutationFacts(details, snapshot, theme, context, suffix !== "");
	if (name === "agent_spawn" || name === "agent_place")
		return ownerPresentation(name, details, { identity, suffix, facts }, context);
	if (name === "agent_attach") {
		return {
			outcome: identity || snapshot ? `Agent attached${suffix}` : undefined,
			body: [...facts, text(details.recovery)].filter(Boolean).join("\n"),
		};
	}
	if (name === "agent_configure") {
		return {
			outcome: configurationOutcome(details, snapshot, suffix),
			body: [...new Set([...configurationFacts(details, identity, context), ...facts])].join("\n"),
		};
	}
	return branchPresentation(name, details, { identity, suffix, facts });
}

function controlPresentation(
	name: ControlTool,
	details: Record<string, unknown>,
	diagnostic: ToolResultPresentation,
	theme: Theme,
	context: AgentCardContext,
): ToolResultPresentation {
	if (details.cancelled === true) return { outcome: "Cancelled" };
	if (context.isError || details.outcome === "failed" || details.format === "refused") return diagnostic;
	const view = { ...context, expanded: false };
	switch (name) {
		case "agent_abort": {
			const [outcome, ...facts] = (abortLines(details, theme, view) ?? []).map(displayText);
			const writes = count(details.writesPlaced);
			if (writes) facts.push(`Placed ${cardinal(writes, "leftover write")}`);
			return { outcome, body: facts.join("\n") };
		}
		case "agent_command":
			return commandPresentation(details, view);
		case "agent_reset":
			return resetPresentation(details, view);
		default:
			return mutationPresentation(name, details, theme, view);
	}
}

function renderAgentResult(name: ControlTool): AgentToolCard["renderResult"] {
	return (result, options, theme, context) => {
		const details = resultDetails(result);
		const diagnostic = diagnosticPresentation(details);
		const presentation = controlPresentation(name, details, diagnostic, theme, context);
		return controlResultCard(result, options, theme, context, {
			...presentation,
			outcome: presentation.outcome ?? diagnostic.outcome,
			partial: "Partial result",
		});
	};
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
	const when = deadline === undefined ? "" : dashboardClock(deadline);
	return [`Scheduled${recipient}`, `timer ${timer}`, when].filter(Boolean).join(" · ");
}

function admissionSendOutcome(
	details: Record<string, unknown>,
	identity: string,
	recipient: string,
	context: AgentCardContext,
	label?: string,
): string | undefined {
	if (details.admitted === false) return "Admission refused";
	const submission = count(details.submissionId);
	if (details.admitted !== true && submission === undefined) return undefined;
	const conversation = count(details.conversationId);
	const placement = receiptPlacement(details);
	const kind = label ?? (record(context.args).mode === "report" ? "Report" : "Message");
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

function sendOutcome(details: Record<string, unknown>, context: AgentCardContext, label?: string): string | undefined {
	const identity = text(details.ownerId) || text(details.identity) || text(details.sessionId);
	const recipient = sendRecipient(identity, context);
	return (
		reportSendOutcome(details, recipient) ??
		scheduleSendOutcome(details, recipient) ??
		admissionSendOutcome(details, identity, recipient, context, label)
	);
}

function diagnosticPresentation(details: Record<string, unknown>): ToolResultPresentation {
	const error = record(details.error);
	const diagnostic = text(error.message) || text(details.error) || text(details.reason);
	const [outcome, ...rest] = displayText(diagnostic).trim().split("\n");
	return { outcome: outcome || undefined, body: rest.join("\n") };
}

function sendPresentation(
	details: Record<string, unknown>,
	context: AgentCardContext,
	label?: string,
): ToolResultPresentation {
	if (details.cancelled === true) return { outcome: "Cancelled" };
	const diagnostic = diagnosticPresentation(details);
	if (context.isError || details.format === "refused" || diagnostic.outcome) return diagnostic;
	const placement = receiptPlacement(details);
	return {
		outcome: sendOutcome(details, context, label),
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
	const details = resultDetails(result);
	const presentation = sendPresentation(details, context, "Steer");
	return controlResultCard(result, options, theme, context, {
		...presentation,
		partial: "Steering disposition pending",
	});
}

function renderBriefResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	const details = resultDetails(result);
	if (details.preview === true && !context.isError) {
		const size = count(record(details.brief).characters);
		return controlResultCard(result, options, theme, context, {
			outcome:
				size === undefined
					? "Preview only; nothing was sent"
					: `Preview · ${cardinal(size, "character")}; nothing was sent`,
			body: array(details.problems).map(text).filter(Boolean).join("\n"),
		});
	}
	const args = record(context.args);
	if (!text(args.sessionId)) return renderAgentResult("agent_spawn")(result, options, theme, context);
	if (args.mode === "steer") return renderSteerResult(result, options, theme, context);
	return controlResultCard(result, options, theme, context, {
		...sendPresentation(details, context),
		partial: "Admission pending",
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

function compactFactLines(facts: Record<string, unknown>): string[] {
	const lines = [compactTarget(facts), compactConfiguration(facts)].filter(Boolean);
	const before = record(facts.before);
	const tokens = count(before.tokens),
		window = count(before.contextWindow),
		percent = count(before.percent);
	const parts = [
		tokens === undefined ? "" : `${tokens} tokens`,
		window === undefined ? "" : `${window} window`,
		percent === undefined ? "" : `${percent.toFixed(1)}%`,
	].filter(Boolean);
	if (parts.length) lines.push(`${parts.join(" · ")} before compaction`);
	if (facts.self !== true && count(facts.summaryChars) !== undefined)
		lines.push(`${cardinal(Number(facts.summaryChars), "character")} in summary`);
	if (text(facts.metadataError)) lines.push(`Could not read compaction metadata: ${facts.metadataError}`);
	return lines;
}

function compactPlacement(details: Record<string, unknown>): string {
	const reason = text(details.summaryReason);
	switch (details.summaryPlacement) {
		case "unanswered":
			return `Summary not placed${reason ? `: ${reason}` : ""}`;
		case "placed":
			return "Summary placed";
		case "queued":
			return "Summary queued";
		case "unknown":
			return "Summary placement not established";
		case "none":
			return "No summary recorded";
		default:
			return "";
	}
}

function compactPresentation(
	details: Record<string, unknown>,
	facts: Record<string, unknown>,
	context: AgentCardContext,
): ToolResultPresentation {
	if (details.cancelled === true) return { outcome: "Cancelled" };
	const diagnostic = diagnosticPresentation(details);
	if (context.isError) return diagnostic;
	const status = text(details.status);
	const task = count(details.taskId);
	const entry = count(details.entryId);
	const submission = count(details.submissionId);
	const label = text(record(context.args).summary) ? "Summary" : "Compaction";
	const state = [
		status ? `${label} ${status === "task" ? "admitted" : status}` : task === undefined ? "" : `${label} task recorded`,
		task === undefined ? "" : `task ${task}`,
		submission === undefined ? "" : `submission ${submission}`,
	]
		.filter(Boolean)
		.join(" · ");
	return {
		outcome: [state, diagnostic.outcome].filter(Boolean).join(": ") || undefined,
		body: [
			compactPlacement(details),
			entry === undefined ? "" : `summary entry ${entry}`,
			text(details.summarySizeError) ? `Summary size read failed: ${details.summarySizeError}` : "",
			diagnostic.body,
			...compactFactLines(facts),
		]
			.filter(Boolean)
			.join("\n"),
	};
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
	const facts = rememberCompactionFacts(record(details.compaction), context);
	return controlResultCard(result, options, theme, context, {
		...compactPresentation(details, facts, context),
		partial: "Compaction pending",
	});
}

function quantity(n: number, singular: string, plural = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

function counted(value: unknown, singular: string, plural?: string): string {
	const n = count(value);
	return n === undefined ? "" : quantity(n, singular, plural);
}

function factLines(lines: readonly string[]): string {
	return lines.filter(Boolean).join("\n");
}

function callText(tool: string, args: Record<string, unknown>): string {
	return `${tool}(${JSON.stringify(args)})`;
}

function nextCall(tool: string, value: unknown): string {
	const { tool: name, ...args } = record(value);
	return name === tool ? callText(tool, args) : "";
}

function queryDetails(result: AgentToolResult<unknown>): Record<string, unknown> {
	const details = resultDetails(result);
	if (Object.keys(details).length) return details;
	try {
		return record(JSON.parse(resultText(result)));
	} catch {
		return {};
	}
}

function queryCard(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
	project: (details: Record<string, unknown>, context: AgentCardContext) => ToolResultPresentation | undefined,
): Component {
	const details = queryDetails(result);
	let presentation: ToolResultPresentation | undefined;
	if (context.isError || details.format === "refused")
		presentation = diagnosticPresentation(typeof result.details === "string" ? { error: result.details } : details);
	else if (!options.isPartial)
		presentation = details.cancelled === true ? { outcome: "Cancelled" } : project(details, context);
	return toolResultCard(result, options, theme, context, presentation ?? {});
}

function listPresentation(details: Record<string, unknown>): ToolResultPresentation | undefined {
	if (!Array.isArray(details.rows)) return undefined;
	const coverage = record(details.coverage),
		profiles = record(coverage.profileHints),
		catalog = record(coverage.catalog);
	const next = nextCall("agent_list", coverage.next);
	const scope = !next && coverage.complete === true ? "; end of scan" : pageScope(Boolean(next), coverage);
	const unavailable = array(coverage.unavailable).length;
	const incomplete = unavailable > 0 || profiles.complete === false;
	const visited = count(coverage.storagesVisited),
		settled = count(catalog.settled),
		pending = count(catalog.pending);
	return {
		outcome: `${quantity(details.rows.length, "conversation")} on this page${scope}`,
		limit: incomplete ? "Discovery evidence incomplete" : undefined,
		body: factLines([
			unavailable ? quantity(unavailable, "storage unavailable", "storages unavailable") : "",
			profiles.complete === false ? "Profile search incomplete" : "",
			visited ? quantity(visited, "storage visited on this page", "storages visited on this page") : "",
			pending ? quantity(pending, "storage scan step open", "storage scan steps open") : "",
			settled ? quantity(settled, "storage settled by publication", "storages settled by publication") : "",
			...details.rows.flatMap((value) => {
				const row = record(value);
				const label = [text(row.handle), text(row.name)].filter(Boolean).join(" · ") || text(row.identity);
				return [label, typeof row.role === "string" ? row.role || "No role set" : ""];
			}),
		]),
		expanded: next ? `Next page: ${next}` : undefined,
	};
}

function profileModelFact(profile: Record<string, unknown>, context: AgentCardContext): string {
	const model = record(profile.model);
	const provider = text(model.provider),
		modelId = text(model.modelId),
		thinking = text(profile.thinkingLevel);
	return headerHasModel(text(profile.identity), provider, modelId, thinking, context)
		? ""
		: resolvedModelLine(provider, modelId, thinking);
}

function profileRequestFact(profile: Record<string, unknown>, omitted: number | undefined): string {
	if (!Array.isArray(profile.requests)) return "";
	const shown = profile.requests.length;
	if (omitted) return `${quantity(shown, "request route")} shown`;
	return shown ? quantity(shown, "active request route") : "";
}

function profileSourceFact(live: unknown): string {
	if (live === true) return "Live host";
	return live === false ? "Retained profile" : "";
}

function profilePresentation(
	details: Record<string, unknown>,
	context: AgentCardContext,
): ToolResultPresentation | undefined {
	const profile = typeof details.outcome === "string" ? record(details.profile) : details;
	if (typeof profile.revision !== "string" || typeof profile.role !== "string") return undefined;
	const identity = text(profile.identity),
		name = text(profile.name);
	const label = headerHasName(identity, name, context) ? "" : text(profile.handle) || name || identity;
	const omitted = count(profile.requestsOmitted);
	const outcome =
		details.outcome === "conflict"
			? "Profile conflict; no change"
			: details.outcome === "applied"
				? "Profile saved"
				: "Profile read";
	return {
		outcome: label ? `${outcome} · ${label}` : outcome,
		body: factLines([
			details.deduped === true ? "Already applied" : "",
			profile.role || "No role set",
			profileSourceFact(profile.live),
			`Revision ${profile.revision}`,
			profileRequestFact(profile, omitted),
			profileModelFact(profile, context),
		]),
		limit: omitted ? quantity(omitted, "route omitted by source", "routes omitted by source") : undefined,
	};
}
export function renderProfileResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	return queryCard(result, options, theme, context, profilePresentation);
}

export function renderListResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	return queryCard(result, options, theme, context, listPresentation);
}

function finalReportCall(value: unknown): string {
	return matchesSchema(FinalReportReadSchema, value) ? nextCall("agent_inspect", value) : "";
}

function inspectProviderFacts(block: unknown, expanded: boolean): string[] {
	if (block === undefined) return [];
	if (!matchesSchema(ProviderBlockFactSchema, block)) return ["Provider block unavailable: invalid native fact"];
	return expanded ? [providerBlockText(block)] : providerBlockSummary(block);
}

function resultPageTitle(details: Record<string, unknown>, args: Record<string, unknown>): string {
	if (typeof record(details.finalReport).text === "string") return "Final report page";
	if (args.finalReport === true) return "Final report unavailable";
	const receipt = record(details.receiptGroup);
	if (typeof args.receiptCursor === "string" && Array.isArray(receipt.results))
		return `${quantity(receipt.results.length, "receipt reference")} on this page`;
	if (details.status === "unavailable") return "Result unavailable";
	if (typeof details.answer !== "string") return "No assistant answer";
	return record(details.work).answer === "state-note" ? "State note retained" : "Assistant answer retained";
}

function resultAnswerFacts(details: Record<string, unknown>, receiptPage: boolean, read: string): string[] {
	const work = record(details.work),
		report = record(details.finalReport);
	const reportPage = typeof report.text === "string";
	const offset = count(reportPage ? report.offset : details.offset);
	const workState = work.state === "open" || work.state === "closed" ? `Declared work is ${work.state}` : "";
	const receiptCount = array(record(details.receiptGroup).results).length;
	return [
		offset === undefined ? "" : `${reportPage ? "Report" : "Answer"} offset ${offset} (UTF-16 units)`,
		workState,
		read ? "Completed report available" : "",
		receiptPage ? "" : text(reportPage ? report.text : details.answer),
		!receiptPage && receiptCount ? `${quantity(receiptCount, "receipt reference")} on this page` : "",
	];
}

function inspectResultPresentation(
	details: Record<string, unknown>,
	context: AgentCardContext,
): ToolResultPresentation {
	const report = record(details.finalReport),
		args = record(context.args);
	const continuation = resultContinuationLines(details);
	const reportPage = typeof report.text === "string";
	const read =
		reportPage || args.finalReport === true ? "" : finalReportCall(record(record(details.work).finalReport).read);
	const status = reportPage ? text(report.status) : text(details.status);
	return {
		outcome: `${resultPageTitle(details, args)}${status && status !== "unavailable" ? ` · ${status}` : ""}${continuation.length ? "; continuation available" : ""}`,
		body: factLines([
			...inspectProviderFacts(details.providerBlock, context.expanded),
			text(details.reason),
			...resultAnswerFacts(details, typeof args.receiptCursor === "string", read),
		]),
		expanded: factLines([...continuation, read ? `Read the final report: ${read}` : ""]),
	};
}

function inspectPageCall(details: Record<string, unknown>, context: AgentCardContext): string {
	const view = text(details.view);
	const sessionId = text(details.sessionId) || text(record(context.args).sessionId);
	const args = record(context.args);
	const target = sessionId ? { sessionId } : {};
	const limit = count(args.limit);
	if (Object.keys(record(details.nextCursor)).length && (view !== "search" || text(args.query))) {
		return callText("agent_inspect", {
			view,
			...target,
			cursor: details.nextCursor,
			...(limit === undefined ? {} : { limit }),
			...(view === "search" ? { query: args.query, source: args.source } : {}),
		});
	}
	const offset = count(details.nextOffset),
		entryId = count(details.entryId);
	return view === "exact" && offset !== undefined && entryId !== undefined
		? callText("agent_inspect", { view, ...target, entryId, offset })
		: "";
}

function inspectedEntry(value: unknown): string {
	const entry = record(value);
	const identity = identifier(entry.id) || identifier(entry.entryId);
	const kind = text(entry.role) || text(entry.kind);
	const content = text(entry.excerptText) || text(entry.text) || text(entry.excerpt);
	const label = [kind, identity ? `entry ${identity}` : ""].filter(Boolean).join(" · ");
	return [label, content].filter(Boolean).join(": ");
}

type ReadPage = { headline: string; facts: string[] };

function primaryExactPage(details: Record<string, unknown>, more: boolean): ReadPage {
	const entry = array(details.entries)[0],
		page = record(details.page);
	const start = count(page.offset),
		end = count(page.endOffset),
		total = count(page.totalUnits);
	const headline =
		start !== undefined && end !== undefined && total !== undefined
			? `Retained entry text ${start}–${end} of ${total}`
			: "Retained entry text unavailable";
	return {
		headline,
		facts: [end !== undefined && end === total && !more ? "Retained text complete" : "", inspectedEntry(entry)],
	};
}

function durableExactPage(details: Record<string, unknown>): ReadPage | undefined {
	const id = identifier(details.entryId),
		offset = count(details.offset),
		omitted = record(details.omissions);
	if (!id) return undefined;
	const fields = [
		["providerSignatures", "provider signature"],
		["imagePayloads", "image payload"],
		["redactedThinking", "redacted field"],
	];
	return {
		headline: `Entry ${id}${offset === undefined ? "" : ` from offset ${offset}`}`,
		facts: [
			details.nextOffset === null && details.truncated === false ? "Representation complete" : "",
			...fields.map(([key, label]) => (count(omitted[key]) ? `${counted(omitted[key], label)} omitted` : "")),
			text(details.text),
		],
	};
}

function inspectionPage(details: Record<string, unknown>, more: boolean): ReadPage | undefined {
	const view = text(details.view),
		coverage = record(details.coverage);
	if (view === "exact")
		return details.kind === "ordinary-primary" ? primaryExactPage(details, more) : durableExactPage(details);
	const complete = coverage.complete === true ? "Reached the end of the selected scan" : "";
	const scanned = count(coverage.scannedEntries)
		? counted(coverage.scannedEntries, "entry scanned", "entries scanned")
		: "";
	if (view === "search" && Array.isArray(details.matches))
		return {
			headline: `${quantity(details.matches.length, "match", "matches")} on this page`,
			facts: [scanned, complete, ...details.matches.map(inspectedEntry)],
		};
	if (view === "activity" && Array.isArray(details.turns))
		return {
			headline: `${quantity(details.turns.length, "turn")} on this activity page`,
			facts: [scanned, complete, ...details.turns.flatMap((turn) => array(record(turn).entries).map(inspectedEntry))],
		};
	if (!Array.isArray(details.entries) || !["history", "activity", "branch"].includes(view)) return undefined;
	return {
		headline: `${quantity(details.entries.length, "entry", "entries")} on this ${view} page`,
		facts: [
			details.kind === "ordinary-primary" ? "Latest retained ancestry, not live activity" : "",
			details.nextCursor === null ? "No older page" : "",
			complete,
			...details.entries.map(inspectedEntry),
		],
	};
}

function pageScope(more: boolean, coverage: unknown): string {
	if (more) return "; next page available";
	return record(coverage).complete === false ? "; coverage incomplete" : "";
}

function inspectPresentation(
	details: Record<string, unknown>,
	context: AgentCardContext,
): ToolResultPresentation | undefined {
	if (details.view === "result") return inspectResultPresentation(details, context);
	const next = inspectPageCall(details, context);
	const more = Boolean(next || Object.keys(record(details.nextCursor)).length);
	const page = inspectionPage(details, more);
	if (!page) return undefined;
	return {
		outcome: page.headline + pageScope(more, details.coverage),
		body: factLines(page.facts),
		expanded: next ? `Next page: ${next}` : undefined,
	};
}

export function renderInspectResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AgentCardContext,
): Component {
	return queryCard(result, options, theme, context, inspectPresentation);
}

/** A thread's known title, or its exact identity when the view has not read that thread. */
function threadLabel(thread: string, context: AgentCardContext): string {
	const title = context.lookup?.threadTitle?.(thread)?.trim();
	return title ? displayPreview(title, 100) : `thread ${displayIdentity(thread)}`;
}

function threadEventFact(value: unknown): string {
	const event = record(value),
		seq = count(event.sequence),
		kind = text(event.kind);
	const label = [seq === undefined ? "" : `#${seq}`, kind, text(event.sender)].filter(Boolean).join(" ");
	const body = kind === "create" || kind === "revise" ? "" : text(event.message);
	return [label, body].filter(Boolean).join(": ");
}

function threadPageFacts(details: Record<string, unknown>, context: AgentCardContext, id: string): string[] {
	const thread = record(details.thread),
		coverage = record(details.coverage);
	const forward = details.direction === "forward",
		closed = forward ? details.closed : thread.closed;
	const label = text(thread.title) || (id ? threadLabel(id, context) : "");
	const revision = count(forward ? details.frameRevision : thread.revision);
	const after = count(coverage.after),
		through = count(coverage.through);
	const members = array(thread.members).length;
	return [
		[label, closed === true ? "closed" : closed === false ? "open" : ""].filter(Boolean).join(" · "),
		revision === undefined
			? ""
			: `Frame ${revision}${forward && details.thread === undefined ? " (known frame not repeated)" : ""}`,
		after === undefined || through === undefined ? "" : `Events after ${after} through ${through}`,
		count(details.pending) ? counted(details.pending, "pending notice") : "",
		members ? quantity(members, "member") : "",
	];
}

function backwardEventsCall(details: Record<string, unknown>, args: Record<string, unknown>, threadId: string): string {
	const before = count(details.nextBefore),
		limit = count(args.limit);
	return before === undefined || !threadId
		? ""
		: callText("agent_collaborate", { action: "read", threadId, before, limit });
}

function collaborationThreadPresentation(
	details: Record<string, unknown>,
	context: AgentCardContext,
): ToolResultPresentation | undefined {
	if (!Array.isArray(details.events)) return undefined;
	const args = record(context.args),
		forward = details.direction === "forward";
	const id = text(forward ? details.threadId : record(details.thread).id) || text(args.threadId);
	const next = forward ? nextCall("agent_collaborate", details.next) : backwardEventsCall(details, args, id);
	return {
		outcome: `${quantity(details.events.length, "event")} on this ${forward ? "forward " : ""}page${pageScope(Boolean(next), details.coverage)}`,
		body: factLines([...threadPageFacts(details, context, id), ...details.events.map(threadEventFact)]),
		expanded: next ? `Next events: ${next}` : undefined,
	};
}

function collaborationListPresentation(
	details: Record<string, unknown>,
	args: Record<string, unknown>,
): ToolResultPresentation | undefined {
	if (!Array.isArray(details.items)) return undefined;
	const cursor = text(details.nextCursor),
		visited = count(record(details.coverage).visited);
	const next = cursor
		? callText("agent_collaborate", {
				action: "list",
				sessionId: args.sessionId,
				query: args.query,
				cursor,
				limit: args.limit,
			})
		: "";
	return {
		outcome: `${quantity(details.items.length, "thread")} on this page${pageScope(Boolean(next), details.coverage)}`,
		body: factLines([
			visited ? quantity(visited, "source visited", "sources visited") : "",
			...details.items.map((item) => text(record(item).title) || text(record(item).id)),
		]),
		expanded: next ? `Next page: ${next}` : undefined,
	};
}

function collaborationReceiptPresentation(
	details: Record<string, unknown>,
	context: AgentCardContext,
): ToolResultPresentation | undefined {
	const id = text(details.threadId),
		args = record(context.args);
	if (!id || typeof details.deduped !== "boolean") return undefined;
	const actions: Record<string, string> = {
		create: "Thread created",
		join: "Joined thread",
		leave: "Left thread",
		post: "Posted to thread",
		revise: "Frame revised",
		close: "Thread closed",
	};
	const sequence = count(details.sequence);
	return {
		outcome: [
			actions[text(args.action)] || "Thread change recorded",
			args.threadId === id ? "" : threadLabel(id, context),
			sequence === undefined ? "" : `#${sequence}`,
			details.deduped ? "already recorded" : "",
		]
			.filter(Boolean)
			.join(" · "),
	};
}

function collaborationPresentation(
	details: Record<string, unknown>,
	context: AgentCardContext,
): ToolResultPresentation | undefined {
	return (
		collaborationThreadPresentation(details, context) ??
		collaborationListPresentation(details, record(context.args)) ??
		collaborationReceiptPresentation(details, context)
	);
}

function resetPresentation(details: Record<string, unknown>, context: AgentCardContext): ToolResultPresentation {
	const identity = text(details.identity) || text(details.sessionId);
	const target = identity ? targetSuffix(identity, context) : "";
	if (details.status === "placed" || details.status === "queued")
		return { outcome: `Reset ${details.status}${target}` };
	if (details.status === "unanswered") {
		const reason = diagnosticPresentation(details);
		return { ...reason, outcome: `Reset not placed${target}${reason.outcome ? `: ${reason.outcome}` : ""}` };
	}
	return {};
}

// --- Peer message card ----------------------------------------------------------

function peerTitle(details: Record<string, unknown>): string {
	if (details.threadId !== undefined) return capitalized(threadEventTitle(text(details.threadEventKind) || undefined));
	if (details.checkIn !== undefined) return "Check-in: Work continues";
	if (details.finalReport !== undefined) return "Final work report received";
	if (details.kind === "report") return "Report received";
	if (details.kind !== "receipt") return "Message received";
	if (details.status === "unanswered" || details.status === "failed") return "Input ended without an answer";
	if (details.workLabel !== undefined) return "State note received";
	return details.status === "done" ? "Answer received" : "Input settled";
}

function peerLabel(details: Record<string, unknown>): string {
	return (
		text(details.handle) ||
		text(details.name) ||
		text(details.observedPurpose) ||
		text(details.label) ||
		text(details.senderIdentity) ||
		text(details.identity)
	);
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

function peerMetadata(details: Record<string, unknown>): string[] {
	const checkIn = record(details.checkIn);
	const cost = count(checkIn.cost);
	const sender = peerLabel(details);
	const event = count(details.threadEvent);
	const finalStatus = text(record(details.finalReport).status);
	const work = details.work === "open" ? "Work remains open" : details.work === "closed" ? "Work closed" : "";
	return [
		sender ? `from ${sender}` : "",
		resolvedModelLine(text(details.provider), text(details.modelId), text(details.thinkingLevel)),
		checkInElapsed(checkIn.elapsedMs),
		cost === undefined ? "" : `$${cost.toFixed(3)} conversation total`,
		event === undefined ? "" : `#${event}`,
		details.threadId !== undefined && details.passive === false ? "notified this session" : "",
		work,
		finalStatus ? `Work ${finalStatus}` : "",
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

function authoredPeerBody(details: Record<string, unknown>, content: string): string {
	if (typeof details.operatorMessage === "string") return details.operatorMessage;
	if (details.kind === "receipt") return details.status === "done" ? text(details.answer) : text(details.reason);
	if (details.threadId !== undefined) return "";
	return typeof details.message === "string" ? details.message : content;
}

function peerSourceLines(details: Record<string, unknown>): string[] {
	const thread = text(details.threadId);
	const final = record(details.finalReport);
	const facts = [
		["Sender ID", text(details.senderIdentity) || text(details.identity)],
		["Sender name", text(details.name)],
		["Sender handle", text(details.handle)],
		["Observed session purpose", text(details.observedPurpose)],
		[
			details.kind === "report" ? "Report source" : "Source",
			text(details.reportSourceId) || text(details.sourceId) || text(details.source),
		],
		["Request", text(final.requestId) || text(details.requestId) || text(record(details.checkIn).requestId)],
		["Original recipient", details.fallback === true ? text(details.originalOwnerId) : ""],
		["Thread", text(details.threadTitle)],
		["Thread ID", thread],
	].flatMap(([label, value]) => (value ? [`${label}: ${displayText(value)}`] : []));
	const model = resolvedModelLine(text(details.provider), text(details.modelId), text(details.thinkingLevel));
	if (model) facts.push(model);
	facts.push(...peerSubmissionLines(details));
	if (thread) facts.push(threadRecoveryText(thread, count(details.threadEvent)));
	if (matchesSchema(AnswerContinuationSchema, details.continuation)) {
		const { tool, ...args } = details.continuation;
		facts.push(
			`${args.offset === 0 ? "Read retained answer" : "Answer continuation"}: ${tool}(${JSON.stringify(args)})`,
		);
	}
	if (matchesSchema(FinalReportReadSchema, details.readFinalReport)) {
		const { tool, ...args } = details.readFinalReport;
		facts.push(`Read final report: ${tool}(${JSON.stringify(args)})`);
	}
	facts.push(...resultContinuationLines({ finalReportContinuation: details.finalReportContinuation }));
	if (details.receiptContinuation !== undefined)
		facts.push(
			receiptContinuationLine(details.receiptContinuation) ??
				"Receipt continuation unavailable: invalid source metadata",
		);
	return facts;
}

function peerSubmissionLines(details: Record<string, unknown>): string[] {
	const references = array(record(details.receiptAssociation).results);
	const submissions = array(details.submissions).map(record);
	const bySubmission = new Map(submissions.map((row) => [row.submissionId, row]));
	const lines: string[] = [];
	for (const value of references.length > 0 ? references : submissions) {
		const reference = record(value);
		const submission = count(reference.submissionId);
		if (submission === undefined) continue;
		lines.push(peerSubmissionLine(submission, bySubmission.get(submission) ?? reference));
	}
	return lines;
}

function peerSubmissionLine(submission: number, member: Record<string, unknown>): string {
	const entry = member.entryId;
	const answer = member.answerEntryId;
	const state =
		member.status === "unanswered" ? "No answer" : member.status === "done" ? text(member.workLabel) || "Answer" : "";
	return displayText(
		[
			`Submission ${submission}`,
			text(member.requestId),
			typeof entry === "string" || typeof entry === "number" ? `entry ${entry}` : "",
			typeof answer === "string" || typeof answer === "number" ? `answer entry ${answer}` : "",
			state,
		]
			.filter(Boolean)
			.join(" · "),
	);
}

function peerLimit(details: Record<string, unknown>, source: string, prefix: string): string | undefined {
	if (prefix !== source) return `[Truncated: showing ${prefix.length} of ${source.length} UTF-16 code units]`;
	if (details.threadId !== undefined && details.passive === true)
		return `[Passive copy: up to ${THREAD_NOTICE_DISPLAY_UNITS} UTF-16 code units retained]`;
	if (details.operatorTextTruncated === true) return `[Excerpt: first ${prefix.length} UTF-16 code units retained]`;
	if (details.kind === "receipt" && details.operatorTextTruncated === undefined && details.textTruncated === true)
		return "[Excerpt: retained answer is incomplete]";
	return undefined;
}

function ordinaryMessageCard(
	message: Parameters<MessageRenderer>[0],
	options: Parameters<MessageRenderer>[1],
	theme: Theme,
	sections: Omit<CardSections, "tag" | "previewLines">,
): Component {
	return cardLayout({ tag: "[agent]", previewLines: NOTICE_PREVIEW_LINES, ...sections }, theme, {
		expanded: options.expanded,
		peerPadding: options.outputPad,
		peerTitleColor: "customMessageText",
		keys: options,
		message,
	});
}

export const renderAgentPeerMessage: MessageRenderer = (message, options, theme) => {
	const details = record(message.details);
	const source = authoredPeerBody(details, messageText(message.content));
	const prefix = displayPrefix(source, SOURCE_DISPLAY_LIMIT);
	const body: (Component | string)[] = [];
	if (details.liveOwner === false) body.push(theme.fg("warning", "No live recipient; this is a retained copy"));
	if (details.saved === false && details.kind === "receipt") body.push(theme.fg("warning", "Receipt not saved"));
	if (displayText(prefix).trim()) body.push(messageMarkdown(displayText(prefix), theme, "customMessageText"));
	const facts = peerSourceLines(details);
	return ordinaryMessageCard(message, options, theme, {
		title: peerTitle(details),
		label: text(details.threadTitle) || text(details.threadId),
		metadata: peerMetadata(details),
		body,
		limit: peerLimit(details, source, prefix),
		...(facts.length === 0
			? {}
			: {
					details: () => [
						...(body.length === 0 ? [] : [new Spacer(1)]),
						theme.fg("muted", theme.bold("Source details")),
						...facts.map((line) => theme.fg("muted", line)),
					],
				}),
	});
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

function noticeMessageBody(message: Parameters<MessageRenderer>[0], theme: Theme): Component {
	const details = record(message.details);
	const body = typeof details.operatorMessage === "string" ? details.operatorMessage : messageText(message.content);
	return messageMarkdown(displayText(body), theme, "customMessageText");
}

export const renderAgentCompactionMessage: MessageRenderer = (message, options, theme) =>
	ordinaryMessageCard(message, options, theme, {
		title: "Self-compaction not applied",
		body: [noticeMessageBody(message, theme)],
	});

export const renderAgentPlanningBudgetMessage: MessageRenderer = (message, options, theme) => {
	const details = record(message.details);
	const tokens = count(details.tokens);
	const budget = count(details.budget);
	return ordinaryMessageCard(message, options, theme, {
		title: "Planning budget reached",
		metadata: [
			resolvedModelLine(text(details.provider), text(details.modelId), text(details.thinkingLevel)),
			tokens === undefined || budget === undefined ? "" : `${tokens} of ${budget} tokens`,
		],
		body: [noticeMessageBody(message, theme)],
	});
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

/**
 * The context a card of this factory receives. Pi's context refers to the component of the previous display
 * update; no card here reuses that component, and a card that kept the reference would keep every earlier
 * card of the tool alive.
 */
function cardContext(context: AgentCardContext, lookup: AgentCardLookup): AgentCardContext {
	return { ...context, lookup, lastComponent: undefined };
}

function sameRows(left: readonly AgentConversationSummary[], right: readonly AgentConversationSummary[]): boolean {
	return left === right || (left.length === right.length && left.every((row, index) => row === right[index]));
}

/**
 * A call card whose target facts can change after Pi built it: the result renderer observes the target after
 * the call renderer ran, and the roster changes without a display update. A frame builds the card again only
 * when one of these two observed values changed; an unchanged frame returns the line array of the built card.
 */
class ObservedCallCard implements Component {
	private readonly build: (observation: Record<string, unknown> | undefined) => Component;
	private readonly state: NonNullable<AgentCardContext["state"]>;
	private readonly lookup: AgentCardLookup;
	private observation: Record<string, unknown> | undefined;
	private rows: readonly AgentConversationSummary[];
	private component: Component | undefined;
	constructor(
		build: (observation: Record<string, unknown> | undefined) => Component,
		state: NonNullable<AgentCardContext["state"]>,
		lookup: AgentCardLookup,
	) {
		this.build = build;
		this.state = state;
		this.lookup = lookup;
		this.observation = state.observation;
		this.rows = lookup();
		this.component = build(this.observation);
	}
	render(width: number): readonly string[] {
		const observation = this.state.observation;
		const rows = this.lookup();
		if (!this.component || observation !== this.observation || !sameRows(rows, this.rows))
			this.component = this.build(observation);
		this.observation = observation;
		this.rows = rows;
		return this.component.render(width);
	}
	invalidate(): void {
		this.component = undefined;
	}
}

function observedCall(
	card: AgentToolCard,
	args: unknown,
	theme: Theme,
	context: AgentCardContext,
	lookup: AgentCardLookup,
): Component {
	const build = (observation: Record<string, unknown> | undefined) =>
		card.renderCall(args, theme, snapshotFacts(context, observation));
	return context.state ? new ObservedCallCard(build, context.state, lookup) : build(undefined);
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
	}
	return snapshotFacts(context, snapshot);
}

function completedWorkPresentation(
	details: Record<string, unknown>,
	item: Record<string, unknown>,
	request: string,
	context: AgentCardContext,
): ToolResultPresentation {
	const status = text(details.status),
		report = record(details.report),
		close = record(item.close);
	const delivery = text(close.delivery),
		owner = text(report.ownerId),
		read = finalReportCall(close.read);
	const acknowledgement =
		report.acknowledged === true
			? "Report acknowledged"
			: report.acknowledged === false
				? "Report not acknowledged"
				: "";
	return {
		outcome: `${details.deduped === true ? "Work already closed" : "Work closed"}${status ? ` (${status})` : ""} · request ${request}`,
		expanded: factLines([
			text(report.sourceId) ? "Final report retained" : "",
			owner ? `Report to ${targetLabel(owner, context)}` : "",
			acknowledgement,
			delivery ? `Final report delivery: ${delivery}` : "",
			read ? `Read the final report: ${read}` : "",
		]),
	};
}

function workDependencyFact(value: unknown, context: AgentCardContext): string {
	const dependency = record(value),
		id = text(dependency.sessionId),
		submission = count(dependency.submissionId);
	return [
		id ? targetLabel(id, context) : "",
		submission === undefined ? "" : `submission ${submission}`,
		text(dependency.state),
		text(dependency.unavailable),
	]
		.filter(Boolean)
		.join(" · ");
}

function workPresentation(
	details: Record<string, unknown>,
	context: AgentCardContext,
): ToolResultPresentation | undefined {
	const item = record(details.item),
		request = text(item.requestId) || text(details.requestId);
	if (!request) {
		if (details.action !== "continue" || typeof details.note !== "string") return undefined;
		return {
			outcome: "State note recorded",
			body: details.note === record(context.args).note ? undefined : details.note,
		};
	}
	if (details.action === "complete") return completedWorkPresentation(details, item, request, context);
	if (details.action !== "continue") return undefined;
	const state = text(item.state),
		replyTo = text(item.replyTo);
	return {
		outcome: `Work declared · request ${request}${state ? ` · ${state}` : ""}`,
		body: factLines([
			Array.isArray(item.dependencies) ? quantity(item.dependencies.length, "dependency", "dependencies") : "",
			replyTo ? `Final report to ${targetLabel(replyTo, context)}` : "",
			...array(item.dependencies).map((value) => workDependencyFact(value, context)),
		]),
	};
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
	const groups = {
		due: [] as typeof waiting,
		scheduled: [] as typeof waiting,
		questions: [] as typeof waiting,
		unconfirmed: [] as typeof waiting,
	};
	for (const row of waiting) {
		const key =
			row.state === "admitted"
				? "due"
				: row.state === "scheduled"
					? "scheduled"
					: row.state === "question"
						? "questions"
						: "unconfirmed";
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
		return head ? `${title} ${theme.fg(error === undefined ? "toolOutput" : "error", head)}` : title;
	}
	private metadata(groups: ReturnType<typeof noteRequestGroups>): string {
		const { at, waiting, waitingOmitted } = this.facts;
		const counts =
			waitingOmitted > 0
				? [cardinal(waiting.length + waitingOmitted, "open agent request")]
				: [
						groups.due.length ? `${cardinal(groups.due.length, "agent result")} due` : "",
						groups.scheduled.length ? cardinal(groups.scheduled.length, "scheduled input") : "",
						groups.questions.length ? cardinal(groups.questions.length, "open question") : "",
						groups.unconfirmed.length ? cardinal(groups.unconfirmed.length, "unconfirmed request") : "",
					];
		return [...counts, at === undefined ? "" : dashboardClock(at)].filter(Boolean).join(" · ");
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
			["Questions awaiting a reply from:", groups.questions],
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
		if (!hiddenLines && !details) return [];
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
		agent_spawn: { renderCall: bindCall("agent_spawn"), renderResult: renderAgentResult("agent_spawn") },
		agent_brief: { renderCall: bindCall("agent_brief"), renderResult: renderBriefResult },
		agent_attach: { renderCall: bindCall("agent_attach"), renderResult: renderAgentResult("agent_attach") },
		agent_place: { renderCall: bindCall("agent_place"), renderResult: renderAgentResult("agent_place") },
		agent_intent: {
			renderCall: bindCall("agent_intent"),
			renderResult: (result, options, theme, context) => queryCard(result, options, theme, context, intentPresentation),
		},
		agent_collaborate: {
			renderCall: bindCall("agent_collaborate"),
			renderResult: (result, options, theme, context) =>
				queryCard(result, options, theme, context, collaborationPresentation),
		},
		agent_status: { renderCall: bindCall("agent_status"), renderResult: renderStatusResult },
		agent_fork: { renderCall: bindCall("agent_fork"), renderResult: renderAgentResult("agent_fork") },
		agent_rewind: { renderCall: bindCall("agent_rewind"), renderResult: renderAgentResult("agent_rewind") },
		agent_configure: { renderCall: bindCall("agent_configure"), renderResult: renderAgentResult("agent_configure") },
		agent_profile: { renderCall: bindCall("agent_profile"), renderResult: renderProfileResult },
		agent_abort: { renderCall: renderAbortCall, renderResult: renderAgentResult("agent_abort") },
		agent_list: { renderCall: renderListCall, renderResult: renderListResult },
		agent_send: { renderCall: renderSendCall, renderResult: renderSendResult },
		agent_steer: { renderCall: renderSteerCall, renderResult: renderSteerResult },
		agent_work: {
			renderCall: bindCall("agent_work"),
			renderResult: (result, options, theme, context) => queryCard(result, options, theme, context, workPresentation),
		},
		agent_command: { renderCall: renderCommandCall, renderResult: renderAgentResult("agent_command") },
		agent_inspect: { renderCall: renderInspectCall, renderResult: renderInspectResult },
		agent_compact: { renderCall: renderCompactCall, renderResult: renderCompactResult },
		agent_reset: { renderCall: bindCall("agent_reset"), renderResult: renderAgentResult("agent_reset") },
	};
	return Object.fromEntries(
		Object.entries(cards).map(([name, card]) => [
			name,
			{
				renderCall(args: unknown, theme: Theme, context: AgentCardContext) {
					return observedCall(card, args, theme, cardContext(context, lookup), lookup);
				},
				renderResult(
					result: AgentToolResult<unknown>,
					options: ToolRenderResultOptions,
					theme: Theme,
					context: AgentCardContext,
				) {
					const observed = observeResult(result, cardContext(context, lookup), name);
					return card.renderResult(result, options, theme, observed);
				},
			},
		]),
	);
}
