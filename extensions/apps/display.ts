import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ShowInput, ShowOutcome } from "./show.ts";

type Call = NonNullable<ToolDefinition["renderCall"]>;
type Result = NonNullable<ToolDefinition["renderResult"]>;
const clean = (text: string) =>
	stripTerminalSequences(text).replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
const line = (value: unknown) => (typeof value === "string" ? clean(value).replace(/\s+/gu, " ").trim() : "");
const clip = (text: string, width: number) =>
	truncateToWidth(text, width, "…").replace(/\x1b\[0m…\x1b\[0m$/u, "…\x1b[22;23;24;25;27;28;29;39m");
function fields(value: unknown) {
	const args = value && typeof value === "object" ? (value as Partial<ShowInput>) : {};
	return [line(args.app), line(args.window), line(args.url)] as const;
}

const renderCall: Call = (args, theme, context) => {
	const [app, window, url] = fields(args);
	const name = theme.fg("toolTitle", theme.bold("apps_show"));
	const title = app ? `${name} ${theme.fg("accent", app)}` : name;
	const extra = [window && `Window title contains: ${window}`, url && `URL: ${url}`].filter(Boolean);
	context.state.hasResult = false;
	return {
		invalidate() {},
		render(width) {
			if (width < 1) return [];
			if (context.expanded)
				return [
					...wrapTextWithAnsi(title, width),
					...extra.flatMap((row) => wrapTextWithAnsi(row, width).map((part) => theme.fg("muted", part))),
				];
			const rows = [clip(title, width)];
			if (
				!context.state.hasResult &&
				(extra.length || visibleWidth(title) > width) &&
				context.keyText("app.tools.expand")
			)
				rows.push(
					clip(
						theme.fg("muted", "... (") + context.keyHint("app.tools.expand", "to expand") + theme.fg("muted", ")"),
						width,
					),
				);
			return rows;
		},
	};
};

function resultCopy(result: Parameters<Result>[0], partial: boolean) {
	if (partial)
		return { outcome: "Preparing an app pane…", expanded: "Preparing an app pane…", extra: false, failed: false };
	const raw = clean(result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")).trim();
	const details = result.details as ShowOutcome | undefined;
	const failure = details?.ok === false ? line(details.error) : "";
	const newWindow = details?.ok === true && details.app?.browser && !details.show?.includes("--window");
	const complete = details?.ok === true && line(details.app?.name);
	const outcome = complete
		? `Prepared ${complete} for ${newWindow ? "a new browser window" : "an app pane"}; no pane opened.`
		: failure || line(raw.split("\n", 1)[0]) || "No app pane result was retained.";
	const expanded = raw.startsWith(outcome) ? raw : [outcome, raw].filter(Boolean).join("\n");
	return { outcome, expanded, extra: expanded !== outcome, failed: Boolean(failure) };
}

const renderResult: Result = (result, options, theme, context) => {
	context.state.hasResult = true;
	const [app, window, url] = fields(context.args);
	const { outcome, expanded, extra, failed } = resultCopy(result, options.isPartial);
	const color = options.isPartial ? "muted" : context.isError || failed ? "error" : "toolOutput";
	return {
		invalidate() {},
		render(width) {
			if (width < 1) return [];
			if (options.expanded) return ["", ...wrapTextWithAnsi(expanded, width).map((row) => theme.fg(color, row))];
			const rows = ["", theme.fg(color, clip(outcome, width))];
			if (extra || window || url || visibleWidth(`apps_show ${app}`) > width || visibleWidth(outcome) > width) {
				const action = context.keyText("app.tools.expand")
					? context.keyHint("app.tools.expand", "to expand")
					: theme.fg("muted", "click to expand");
				rows.push(clip(theme.fg("muted", "... (") + action + theme.fg("muted", ")"), width));
			}
			return rows;
		},
	};
};

export function toolDisplay(): { version: 1; tools: Pick<ToolDefinition, "name" | "renderCall" | "renderResult">[] } {
	return { version: 1, tools: [{ name: "apps_show", renderCall, renderResult }] };
}
