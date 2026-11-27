import { homedir } from "node:os";
import {
	type AgentToolResult,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getCapabilities,
	imageFallback,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

type Fields = Record<string, unknown>;
type CardContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3] & {
	state: { resultPresent?: boolean };
	args: unknown;
};
const NAMES = [
	"browser_tabs",
	"browser_inspect",
	"browser_act",
	"browser_evaluate",
	"browser_save",
	"browser_capture",
] as const;
type Name = (typeof NAMES)[number];
type Display = Pick<ToolDefinition, "name" | "renderCall" | "renderResult"> & { name: Name };
const EXPAND = "app.tools.expand";
const DISPLAY_LIMIT = 32_000;

function object(value: unknown): Fields {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};
}

function records(value: unknown): Fields[] {
	return Array.isArray(value) ? value.map(object) : [];
}

function safe(value: string): string {
	return stripTerminalSequences(value)
		.replace(/\r\n/g, "\n")
		.replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""))
		.replace(/\t/g, "   ");
}

function line(value: unknown): string {
	return typeof value === "string" ? safe(value).replace(/\s+/gu, " ").trim() : "";
}

function path(value: unknown): string {
	if (typeof value !== "string") return "";
	const home = homedir();
	return line(value === home || value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value);
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function qty(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function join(...parts: (string | undefined)[]): string {
	return parts.filter(Boolean).join(" · ");
}

function json(value: unknown): string {
	return safe(JSON.stringify(value, null, 2) ?? "");
}

function clip(value: string, width: number): string {
	return truncateToWidth(value, width, "…").replace(/\x1b\[0m…\x1b\[0m$/u, "…\x1b[22;23;24;25;27;28;29;39m");
}

function bound(text: string, tail = false): { text: string; limit?: string } {
	if (text.length <= DISPLAY_LIMIT) return { text };
	const chars = Array.from(text);
	if (chars.length <= DISPLAY_LIMIT) return { text };
	return {
		text: (tail ? chars.slice(-DISPLAY_LIMIT) : chars.slice(0, DISPLAY_LIMIT)).join(""),
		limit: `Truncated: showing ${DISPLAY_LIMIT} of ${chars.length} characters`,
	};
}

function atWidth(draw: (width: number) => string[]): Component {
	return { render: draw, invalidate() {} };
}

function hint(theme: Theme, context: CardContext): string {
	const action = context.keyText(EXPAND) ? context.keyHint(EXPAND, "to expand") : theme.fg("muted", "click to expand");
	return theme.fg("muted", "... (") + action + theme.fg("muted", ")");
}

function identify(args: Fields): string {
	return join(
		line(args.browser),
		num(args.pid) === undefined ? "" : `pid ${args.pid}`,
		line(args.tab) ? `tab ${line(args.tab)}` : "",
	);
}

function callSubject(name: Name, args: Fields): string {
	if (name === "browser_tabs") return line(args.match) || line(args.browser) || "browser availability";
	if (name === "browser_act") {
		return [line(args.action), line(args.url) || line(args.ref) || line(args.selector)].filter(Boolean).join(" ");
	}
	if (name === "browser_inspect") return join(line(args.view), line(args.selector), identify(args));
	if (name === "browser_save")
		return args.cancel === true ? "cancel Save dialog" : line(args.fileName) || "Save dialog";
	return identify(args);
}

function callFacts(name: Name, args: Fields): string {
	return join(
		name === "browser_act" || name === "browser_save" ? identify(args) : undefined,
		name === "browser_tabs" && args.match ? line(args.browser) : undefined,
		name === "browser_tabs" && num(args.pid) !== undefined ? `pid ${args.pid}` : undefined,
		name === "browser_inspect" ? undefined : line(args.view),
		line(args.origin),
		path(args.savePath),
		typeof args.value === "string" ? `${qty(args.value.length, "character")} of input` : undefined,
		num(args.offset) ? `offset ${args.offset}` : undefined,
		...(["limit", "index"] as const).map((key) => (num(args[key]) === undefined ? "" : `${key} ${args[key]}`)),
	);
}

function hasHiddenArgs(name: Name, args: Fields): boolean {
	const visible = new Set([
		"browser",
		"pid",
		"tab",
		"match",
		"view",
		"origin",
		"savePath",
		"value",
		"offset",
		"limit",
		"index",
		"expression",
		...(name === "browser_act" ? ["action", args.url ? "url" : args.ref ? "ref" : "selector"] : []),
		...(name === "browser_inspect" ? ["selector"] : []),
		...(name === "browser_save" ? ["fileName", "cancel"] : []),
	]);
	return Object.entries(args).some(([key, item]) => item != null && !visible.has(key));
}

function expandedArgs(args: Fields) {
	return bound(
		Object.entries(args)
			.filter(([key, item]) => key !== "expression" && item != null)
			.map(([key, item]) => {
				const display =
					key === "value" && typeof item === "string"
						? qty(item.length, "character")
						: key === "savePath"
							? path(item)
							: typeof item === "string"
								? safe(item)
								: json(item);
				return `  ${line(key)}: ${display.replace(/\n/g, "\n    ")}`;
			})
			.join("\n"),
	);
}

function call(name: Name, value: unknown) {
	const args = object(value);
	const subject = callSubject(name, args);
	const facts = callFacts(name, args);
	const hiddenArgs = hasHiddenArgs(name, args);
	const source = bound(name === "browser_evaluate" && typeof args.expression === "string" ? safe(args.expression) : "");
	const showArgs = (width: number) =>
		hiddenArgs || visibleWidth(subject ? `${name} ${subject}` : name) > width || visibleWidth(facts) > width;
	return {
		subject,
		facts,
		args,
		source,
		showArgs,
		hidden: (width: number) => Boolean(facts || source.text || showArgs(width)),
	};
}

function fieldRows(text: string, width: number): readonly string[] {
	return text ? truncateToVisualLines(text, Infinity, width, 0, "start").visualLines : [];
}

function warning(theme: Theme, limits: (string | undefined)[], width: number): string[] {
	const text = limits.filter(Boolean).join("; ");
	return fieldRows(text && `[${text}]`, width).map((row) => theme.fg("warning", row));
}

function renderCall(name: Name, args: unknown, theme: Theme, context: CardContext): Component {
	const card = call(name, args);
	const { expanded } = context;
	const title = theme.fg("toolTitle", theme.bold(name));
	const header = card.subject ? `${title} ${theme.fg("accent", card.subject)}` : title;
	const argsView = expanded ? expandedArgs(card.args) : undefined;
	return atWidth((width) => {
		if (!expanded) {
			const rows = [clip(header, width)];
			if (!context.state.resultPresent && context.keyText(EXPAND) && card.hidden(width)) {
				rows.push(clip(hint(theme, context), width));
			}
			return rows;
		}
		const disclosure = card.showArgs(width) ? argsView : undefined;
		return [
			...fieldRows(header, width),
			...fieldRows(disclosure?.text ?? card.facts, width).map((row) => theme.fg("muted", row)),
			...fieldRows(card.source.text, width).map((row) => theme.fg("toolOutput", row)),
			...warning(theme, [disclosure?.limit, card.source.limit], width),
		];
	});
}

interface Receipt {
	outcome: string;
	body?: string;
	evidence?: string;
	continuation?: string;
}

function availabilityRow(item: Fields): string {
	const installed = item.installed ? line(object(item.installed).version) || "installed" : "not installed";
	const running = Array.isArray(item.running) ? item.running.map(num).filter((pid) => pid !== undefined) : [];
	const access = line(item.access);
	const automation = line(item.automation);
	return join(
		line(item.name),
		installed,
		running.length ? `pid ${running.join(", ")}` : undefined,
		access === "none" ? "no access" : access && `${access} access`,
		automation === "unknown" ? undefined : automation,
	);
}

function tabOutcome(count: number, omitted: number, matching: boolean): string {
	if (!count) return matching ? "No tabs matched." : "No tabs found.";
	const unit = matching ? "matching tab" : "tab";
	return omitted ? `Returned ${count - omitted} of ${qty(count, unit)}.` : `Found ${qty(count, unit)}.`;
}

function tabs(report: Fields, args: Fields): Receipt {
	const n = num(report.tabCount);
	if (n === undefined) {
		const browsers = records(report.browsers);
		return {
			outcome: browsers.length
				? `Checked availability for ${qty(browsers.length, "browser")}.`
				: "No browser availability was reported.",
			body: browsers.map(availabilityRow).join("\n"),
		};
	}
	const omitted = num(report.omittedTabs) ?? 0;
	const body = records(report.windows)
		.flatMap((window) =>
			records(window.tabs).map((tab) =>
				join(
					`tab ${line(tab.tab)}`,
					line(tab.title),
					line(tab.url),
					`window ${line(window.window)}`,
					tab.active ? "active" : undefined,
					tab.loading ? "loading" : undefined,
				),
			),
		)
		.join("\n");
	return {
		outcome: tabOutcome(n, omitted, Boolean(line(args.match))),
		body,
		evidence: [path(report.userDataDir) && `User data directory: ${path(report.userDataDir)}`, line(report.profile)]
			.filter(Boolean)
			.join("\n"),
	};
}

/** The producer puts the text/HTML trailer after its JSON header. JSON escapes embedded newlines. */
function trailer(text: string, view: string): string {
	const marker = `\n--- ${view} (untrusted page content) ---\n`;
	const start = text.indexOf(marker);
	return start === -1 ? "" : text.slice(start + marker.length);
}

function responseRows(rows: Fields[]): string {
	return rows
		.map((item) =>
			join(
				line(item.url),
				num(item.status) ? `HTTP ${item.status}` : undefined,
				line(item.initiator),
				num(item.durationMs) === undefined ? undefined : `${item.durationMs}ms`,
			),
		)
		.filter(Boolean)
		.join("\n");
}

function pageFacts(page: Fields): string {
	return join(line(page.title), line(page.url));
}

function networkOutcome(count: number, total: number | undefined): string {
	if (!count) return "No resources returned.";
	if (total !== undefined && total > count) return `Read the last ${count} of ${qty(total, "resource")}.`;
	return `Read ${qty(count, "resource")}.`;
}

function networkView(data: Fields, page: Fields): Receipt {
	const resources = records(data.resources);
	const total = num(data.total);
	const navigation = responseRows(records(data.navigation ? [data.navigation] : []));
	return {
		outcome: networkOutcome(resources.length, total),
		body: responseRows(resources),
		evidence: [pageFacts(page), navigation && `Navigation: ${navigation}`].filter(Boolean).join("\n"),
	};
}

function pagedView(window: Fields, size: number, elements: boolean, args: Fields): Receipt {
	const total = num(window.total);
	const offset = num(window.offset);
	const next = num(window.nextOffset);
	const unit = elements ? "element" : "character";
	const read = size ? `Read ${qty(size, unit)}` : elements ? "No elements returned" : "No text returned";
	const scope = `${read}${offset ? ` from offset ${offset}` : ""}${total ? ` (${total} total)` : ""}`;
	const continuation =
		next !== undefined && args.browser && args.pid && args.tab
			? safe(`browser_inspect ${JSON.stringify({ ...args, offset: next })}`)
			: undefined;
	const more = elements ? "; more elements follow" : "; more text follows";
	return { outcome: `${scope}${next === undefined ? "" : more}.`, continuation };
}

function inspectPage(report: Fields, args: Fields, text: string): Receipt {
	const view = line(report.view);
	const data = object(report.result);
	const page = object(report.page);
	if (view === "network") return networkView(data, page);
	if (view === "elements") {
		const elements = records(data.elements);
		return {
			...pagedView(data, elements.length, true, args),
			body: elements
				.map((item) => join(line(item.name) || line(item.role) || line(item.tag), line(item.ref), line(item.selector)))
				.join("\n"),
			evidence: [pageFacts(page), elements.length ? json(elements) : ""].filter(Boolean).join("\n"),
		};
	}
	const summary = view === "summary";
	const window = object(summary ? data.text : report.window);
	const content = summary ? String(window.text ?? "") : trailer(text, view);
	const { text: _content, ...facts } = data;
	return {
		...pagedView(window, content.length, false, args),
		body: safe(content),
		evidence: [pageFacts(page), summary && Object.keys(facts).length ? json(facts) : ""].filter(Boolean).join("\n"),
	};
}

function dispatchOutcome(action: Fields, dispatch: Fields, application: Fields): string {
	const navigate = action.type === "navigate";
	switch (dispatch.status) {
		case "dispatched":
			if (!navigate) return "Action dispatched";
			return application.documentReplaced === true
				? "Navigation sent; document replacement observed"
				: "Navigation sent; document replacement not observed";
		case "not-needed":
			return "No action was needed";
		case "not-dispatched":
			return navigate ? "Navigation was not sent" : "Action was not dispatched";
		case "failed":
			return "Action dispatch failed";
		case "unknown":
			return navigate ? "Navigation dispatch was not confirmed" : "Action dispatch was not confirmed";
		default:
			return "Action dispatch was not established";
	}
}

function conditionOutcome(post: Fields): string {
	if (post.status === "verified") return "condition verified";
	if (post.status === "failed") return "condition not met";
	return post.condition ? "condition not observed" : "";
}

function actDiagnostic(report: Fields, status: string): string {
	const dispatch = object(report.dispatch);
	const observed = object(report.observation);
	const transport = object(report.transport);
	return (
		line(object(dispatch.error).message) ||
		line(observed.message) ||
		(observed.status === "failed" ? line(object(report.postcondition).note) : "") ||
		(transport.status === "failed" ? line(transport.message) : "") ||
		(status === "stale-reference" ? line(dispatch.note) : "")
	);
}

function dispatchReceipt(action: Fields, dispatch: Fields, application: Fields, status: string): string {
	const outcome = dispatchOutcome(action, dispatch, application);
	if (status !== "cancelled") return outcome;
	if (dispatch.status === "dispatched" || dispatch.status === "failed") return `${outcome}; observation cancelled`;
	return `Cancelled. ${outcome}`;
}

/** What the focus watch saw: the keyboard the browser took and gave back, and windows that wait for a person. */
function focusLine(report: Fields): string {
	const focus = object(report.focus);
	const parts: string[] = [];
	const describe = (facts: Fields, when: string) => {
		const taken = records(facts.taken);
		const failed = taken.find((item) => item.returned === false);
		const last = taken[taken.length - 1];
		if (failed)
			parts.push(
				`The browser took the keyboard ${when}; returning it to ${line(failed.returnedTo) || "the previous app"} failed.`,
			);
		else if (last)
			parts.push(
				`The browser took the keyboard ${when}; returned to ${line(last.returnedTo) || "the previous app"} after ${num(last.heldMs) ?? "?"} ms.`,
			);
		const windows = records(facts.windows);
		if (windows.length)
			parts.push(`Browser window ${when}: ${windows.map((item) => line(item.title) || "untitled").join(", ")}.`);
		if (facts.yielded) parts.push(`A click gave the browser the keyboard ${when}.`);
	};
	describe(focus, "during the call");
	describe(object(focus.earlier), "after the previous call");
	if (focus.unavailable) parts.push(`Keyboard focus not watched: ${line(focus.unavailable)}`);
	return parts.join(" ");
}

function act(report: Fields, status: string): Receipt {
	const dispatch = object(report.dispatch);
	const application = object(report.application);
	const post = object(report.postcondition);
	const dispatchCopy = dispatchReceipt(object(report.action), dispatch, application, status);
	const condition = conditionOutcome(post);
	const diagnostic = actDiagnostic(report, status);
	const page = pageFacts(object(application.page));
	const delivery = line(object(report.dispatchReply).note);
	return {
		outcome: [
			`${dispatchCopy}${condition ? `; ${condition}` : ""}.${diagnostic ? ` ${diagnostic}` : ""}`,
			focusLine(report),
		]
			.filter(Boolean)
			.join(" "),
		body: [page, responseRows(records(application.responses))].filter(Boolean).join("\n"),
		evidence: [
			line(dispatch.note),
			line(post.note),
			delivery,
			line(report.replay),
			post.checks ? json(post.checks) : "",
		]
			.filter((fact) => fact && fact !== diagnostic)
			.join("\n"),
	};
}

function evaluate(report: Fields, status: string): Receipt {
	const run = object(report.execution);
	const error = object(run.error);
	const problem = object(run.unserializable);
	const value =
		typeof run.preview === "string"
			? safe(run.preview)
			: typeof run.special === "string"
				? safe(run.special)
				: json(run.value);
	const type = line(run.valueType);
	const bytes = num(run.bytes);
	const note = line(run.note);
	const diagnostic = line(run.message) || line(error.message) || join(line(problem.path), line(problem.reason)) || note;
	let outcome: string;
	switch (status) {
		case "fulfilled":
			outcome = type
				? `Expression returned ${type === "null" || type === "undefined" ? type : `a value of type ${type}`}.`
				: "Expression returned a value.";
			break;
		case "too-large":
			outcome = "The value exceeds the return budget; only a prefix arrived.";
			break;
		case "syntax-error":
			outcome = "The expression has invalid syntax and was not sent.";
			break;
		case "cancelled":
			outcome = "Cancelled.";
			break;
		case "rejected":
			outcome = "Expression rejected.";
			break;
		case "unserializable":
			outcome = "The expression returned a value without a JSON representation.";
			break;
		default:
			outcome = "The expression result was not observed.";
	}
	return {
		outcome: [`${outcome}${diagnostic ? ` ${diagnostic}` : ""}`, focusLine(report)].filter(Boolean).join(" "),
		body: value || json(error.thrown),
		evidence: [
			bytes === undefined ? "" : qty(bytes, "byte"),
			line(object(report.startReply).note),
			line(report.replay),
			typeof error.stack === "string" ? safe(error.stack) : "",
		]
			.filter(Boolean)
			.join("\n"),
	};
}

function dimensions(report: Fields): { widthPx: number; heightPx: number } | undefined {
	const image = object(report.image);
	const widthPx = num(image.width);
	const heightPx = num(image.height);
	return widthPx && heightPx ? { widthPx, heightPx } : undefined;
}

function saveDialog(report: Fields, status: string): Receipt {
	const dialog = object(report.dialog);
	const file = object(report.saved);
	const download = object(report.download);
	const bytes = num(file.bytes);
	const outcomes: Record<string, string> = {
		"dialog-cancelled": "Save dialog cancelled.",
		saved: `Saved ${path(file.path)}${bytes === undefined ? "" : ` (${qty(bytes, "byte")})`}.`,
		"download-unfinished": `Saved as ${path(file.path)}; the download had not finished.`,
		"saved-unlocated": `Saved “${line(file.name)}”; the file did not appear where the dialog saves.`,
		cancelled: "Saved; the wait for the download was cancelled.",
	};
	return {
		outcome: outcomes[status] ?? "Save dialog answered.",
		evidence: [
			line(dialog.suggestedName) && `Suggested name: ${line(dialog.suggestedName)}`,
			line(dialog.folderName) && `Folder shown: ${line(dialog.folderName)}`,
			num(download.waitedMs) === undefined ? "" : `Waited ${num(download.waitedMs)} ms for the download`,
		]
			.filter(Boolean)
			.join("\n"),
	};
}

function capture(report: Fields): Receipt {
	const size = dimensions(report);
	const saved = path(report.savedPath);
	const saveError = line(report.saveError);
	return {
		outcome: `Captured the window${size ? ` (${size.widthPx} × ${size.heightPx})` : ""}.`,
		body: saveError ? `Optional save failed. ${saveError}` : saved ? `Saved to ${saved}` : undefined,
		evidence: [line(object(report.target).url), line(object(report.identity).assurance), line(report.limits)]
			.filter(Boolean)
			.join("\n"),
	};
}

function reportFromContent(name: Name, text: string): Fields {
	const start = text.indexOf("\n");
	if (!text.startsWith(`${name}: `) || start < 0 || text[start + 1] !== "{") return {};
	// The header uses JSON.stringify with a one-space indent. Only the outer brace closes at column one.
	const closing = text.indexOf("\n}", start);
	const end = text.startsWith("{}", start + 1) ? start + 3 : closing < 0 ? -1 : closing + 2;
	if (end < 0) return {};
	try {
		return object(JSON.parse(text.slice(start + 1, end)));
	} catch {
		return {};
	}
}

function contentStatus(name: Name, report: Fields): string {
	if (report.blocked) return "blocked";
	const transport = object(report.transport);
	if (transport.kind === "cancelled") return "cancelled";
	if (name === "browser_evaluate") return line(object(report.execution).status);
	if (
		(name === "browser_tabs" && (report.browsers || report.windows)) ||
		(name === "browser_inspect" && report.view) ||
		(name === "browser_capture" && report.image)
	)
		return "ok";
	return "";
}

function fallback(name: Name, status: string, text: string, isError: boolean): Receipt {
	if (status === "cancelled") return { outcome: "Cancelled." };
	// An unstructured host error can echo raw arguments, even when parsing left no usable call arguments.
	if (name === "browser_act" && isError) return { outcome: "Browser action failed; its outcome is not known." };
	const [first = "", ...rest] = safe(text).trim().split("\n");
	return { outcome: line(first), body: rest.join("\n") };
}

function blockedReceipt(blocked: Fields): Receipt {
	const { message, reason, instances, ...facts } = blocked;
	return {
		outcome: line(message),
		body: records(instances)
			.map((item) => join(`pid ${item.pid}`, path(item.userDataDir)))
			.join("\n"),
		evidence: [line(reason), Object.keys(facts).length ? json(facts) : ""].filter(Boolean).join("\n"),
	};
}

function failureReceipt(status: string, report: Fields): Receipt | undefined {
	const blocked = object(report.blocked);
	const transport = object(report.transport);
	if (status === "blocked" && blocked.message) return blockedReceipt(blocked);
	if (!report.dispatch && transport.status === "failed" && !report.startReply) {
		const delivery =
			transport.delivery === "none" ? "Not delivered to the browser." : "Delivery to the browser was not confirmed.";
		return {
			outcome: [status === "cancelled" ? "Cancelled." : "Transport failed.", line(transport.message)]
				.filter(Boolean)
				.join(" "),
			evidence: delivery,
		};
	}
}

function receipt(name: Name, status: string, report: Fields, args: Fields, text: string, isError: boolean): Receipt {
	const failure = failureReceipt(status, report);
	if (failure) return failure;
	if (name === "browser_tabs" && status === "ok") return tabs(report, args);
	if (name === "browser_inspect" && status === "ok") return inspectPage(report, args, text);
	if (name === "browser_act" && report.dispatch) return act(report, status);
	if (name === "browser_evaluate" && report.execution) return evaluate(report, status);
	if (name === "browser_capture" && status === "ok") return capture(report);
	if (name === "browser_save" && report.dialog) return saveDialog(report, status);
	return fallback(name, status, text, isError);
}

function duration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const start = minutes >= 60 ? `${Math.floor(minutes / 60)}h ` : "";
	return `${start}${minutes % 60}m ${Math.floor(seconds) % 60}s`;
}

function imageNotices(result: AgentToolResult<unknown>, report: Fields, showImages: boolean): string[] {
	if (showImages && getCapabilities().images) return [];
	return result.content.flatMap((item) =>
		item.type === "image" ? [imageFallback(item.mimeType, dimensions(report))] : [],
	);
}

function compactResult(
	view: {
		heading: string;
		body: string;
		inlineBody: boolean;
		notice: string[];
		timing: string;
		color: "error" | "muted" | "toolOutput";
	},
	hasEvidence: (width: number) => boolean,
	theme: Theme,
	context: CardContext,
): Component {
	const summary = view.inlineBody ? [view.heading, view.body].filter(Boolean).join(" ") : view.heading;
	const outcome = join(
		summary && theme.fg(view.color, summary),
		...view.notice.map((row) => theme.fg("toolOutput", row)),
		view.timing && theme.fg("muted", view.timing),
	);
	const hiddenBody = !view.inlineBody && Boolean(view.body);
	return atWidth((width) => [
		"",
		...(outcome ? [clip(outcome, width)] : []),
		...(hiddenBody || hasEvidence(width) || visibleWidth(outcome) > width ? [clip(hint(theme, context), width)] : []),
	]);
}

function renderResult(
	name: Name,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	context.state.resultPresent = true;
	const args = object(context.args);
	const details = object(result.details);
	const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
	const report = details.report ? object(details.report) : reportFromContent(name, text);
	const status = line(details.status) || contentStatus(name, report);
	const view = receipt(name, status, report, args, text, context.isError);
	const request = call(name, args);
	const { expanded, isPartial } = options;
	const tail = name === "browser_evaluate";
	const color = context.isError ? "error" : isPartial ? "muted" : "toolOutput";
	const heading = bound(view.outcome || (isPartial ? "Waiting for the browser…" : ""));
	const body = bound(view.body ?? "", tail);
	const evidence = bound(view.evidence ?? "");
	const elapsed = tail ? (context.durationMs ?? num(object(report.execution).elapsedMs)) : undefined;
	const notice = imageNotices(result, report, context.showImages);
	const extra = [evidence.text, view.continuation].filter(Boolean).join("\n");
	const limits = [heading.limit, body.limit, evidence.limit];
	const timingLabel = isPartial ? "Elapsed" : "Took";
	const timing = elapsed === undefined ? "" : `${timingLabel} ${duration(elapsed)}`;
	if (!expanded)
		return compactResult(
			{
				heading: heading.text,
				body: body.text,
				inlineBody: name === "browser_capture" && status === "ok",
				notice,
				timing,
				color,
			},
			(width) => Boolean(extra) || request.hidden(width) || limits.some(Boolean),
			theme,
			context,
		);
	return atWidth((width) => [
		"",
		...fieldRows(heading.text, width).map((row) => theme.fg(color, row)),
		...fieldRows(body.text, width).map((row) => theme.fg(color, row)),
		...notice.flatMap((row) => fieldRows(row, width).map((fit) => theme.fg("toolOutput", fit))),
		...fieldRows(extra, width).map((row) => theme.fg("muted", row)),
		...warning(theme, limits, width),
		...(timing ? ["", theme.fg("muted", clip(timing, width))] : []),
	]);
}

const tools: Display[] = NAMES.map((name) => ({
	name,
	renderCall: (args, theme, context) => renderCall(name, args, theme, context),
	renderResult: (result, options, theme, context) => renderResult(name, result, options, theme, context),
}));

export function toolDisplay(): { version: 1; tools: Display[] } {
	return { version: 1, tools: tools.map((record) => ({ ...record })) };
}
