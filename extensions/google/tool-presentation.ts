import { homedir } from "node:os";
import {
	type KeybindingHints,
	type Theme,
	type ToolDefinition,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type CardResult, type Data, field, object, type Presenter, text } from "./display-data.ts";

type DisplayRecord = Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">;
type Outcome = CardResult & { partial?: boolean; withheldDiagnostic?: "Upstream" | "Unstructured" };

function envelope(source: string) {
	try {
		const value = object(JSON.parse(source));
		const { status } = value;
		if (value.schemaVersion === 1 && (status === "ok" || status === "partial" || status === "error")) {
			return { status, data: object(value.data), error: object(value.error) } as const;
		}
	} catch {
		// Pi can return a diagnostic directly instead of an adapter envelope.
	}
	return undefined;
}

const errorLabels: Record<string, string> = {
	AUTH_REQUIRED: "Google authentication is required.",
	INVALID_ARGUMENT: "The Google request is invalid.",
	API_ERROR: "The Google API rejected the request.",
	BACKEND_ERROR: "The Google backend reported an error.",
	BACKEND_SCHEMA_ERROR: "The Google backend did not return the expected data.",
	ADAPTER_ERROR: "The Google adapter reported an error.",
	DEADLINE_EXCEEDED: "The Google request timed out.",
};

function errorOutcome(error: Data, showDiagnostic: boolean): CardResult {
	const code = field(error.code);
	const message = showDiagnostic ? text(error.message).trim() : "";
	const [first, ...body] = message.split("\n");
	const operation = field(error.operationId);
	return {
		outcome:
			code === "ABORTED"
				? "Cancelled"
				: field(first) ||
					(Object.hasOwn(errorLabels, code) ? errorLabels[code] : undefined) ||
					"The Google tool reported an error.",
		body,
		details: [code && `Error code ${code}`, operation && `Operation ${operation}`].filter(Boolean),
	};
}

function project(presenter: Presenter, source: string, args: Data, isError: boolean, showDiagnostic: boolean): Outcome {
	const result = envelope(source);
	if (!result) {
		if (isError && !showDiagnostic) {
			// Pi's unstructured failures can echo the submitted arguments.
			return { outcome: "The tool call failed.", withheldDiagnostic: "Unstructured" };
		}
		const [first, ...body] = text(source).trim().split("\n");
		return {
			outcome: field(first) || (isError ? "The tool returned no diagnostic." : "The tool returned no readable result."),
			body,
		};
	}
	const view =
		presenter.result({ ...result, args, isError }) ??
		(isError || result.status === "error"
			? errorOutcome(result.error, showDiagnostic)
			: { outcome: "The result did not establish an outcome." });
	return {
		...view,
		partial: result.status === "partial",
		withheldDiagnostic:
			!showDiagnostic &&
			result.error.code !== "ABORTED" &&
			typeof result.error.message === "string" &&
			result.error.message.length > 0
				? "Upstream"
				: undefined,
	};
}

function clip(line: string, width: number, ellipsis = "…"): string {
	// Keep the shell background across Pi's clipping resets.
	return truncateToWidth(line, width, ellipsis).replaceAll("\u001b[0m", "");
}

function hint(theme: Theme, context: KeybindingHints, width: number, skipped: number, hasResult: boolean): string[] {
	const key = "app.tools.expand";
	const bound = context.keyText(key);
	if (!bound && !hasResult) return [];
	const count = skipped ? `${skipped} more ${skipped === 1 ? "line" : "lines"}, ` : "";
	const action = bound ? context.keyHint(key, "to expand") : theme.fg("muted", "click to expand");
	return [clip(theme.fg("muted", `... (${count}`) + action + theme.fg("muted", ")"), width, theme.fg("muted", "…"))];
}

function component(render: (width: number) => string[]): Component {
	let cachedWidth: number | undefined;
	let rows: string[] = [];
	return {
		invalidate() {
			cachedWidth = undefined;
		},
		render(width) {
			if (width <= 0) return [];
			if (cachedWidth !== width) {
				rows = render(width);
				cachedWidth = width;
			}
			return rows;
		},
	};
}

function homePath(value: string): string {
	const home = homedir();
	return value === home || value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

function safeJson(value: unknown, indent?: number): string {
	return (
		JSON.stringify(value, null, indent)?.replace(
			/[\p{Bidi_Control}\u2028\u2029]/gu,
			(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
		) ?? ""
	);
}

function argumentRows(args: Data, theme: Theme, width: number): string[] {
	return Object.entries(args).flatMap(([key, value]) => {
		const shown = typeof value === "string" ? text(homePath(value)) : safeJson(value, 2);
		return wrapTextWithAnsi(`  ${key}: ${shown.replaceAll("\n", "\n    ")}`, width).map((row) =>
			theme.fg("muted", row),
		);
	});
}

function disclosure(view: Outcome, name: string): string[] {
	const details = (view.details ?? []).map(text).filter(Boolean);
	if (view.next) details.push(`Continue with ${view.next.name ?? name} ${safeJson(view.next.args)}`);
	return details;
}

function renderText(value: string, width: number, expanded: boolean, ellipsis?: string): string[] {
	if (!value) return [];
	return expanded ? wrapTextWithAnsi(value, width) : [clip(value, width, ellipsis)];
}

function hidesCall(heading: string, facts: string, args: Data, width: number): boolean {
	return Object.keys(args).length > 0 || visibleWidth(heading) > width || visibleWidth(facts) > width;
}

function factsLine(facts: string[] | undefined): string {
	return (facts ?? []).map(field).filter(Boolean).join(" · ");
}

function resultExtras(view: Outcome): string[] {
	return [
		view.partial && !view.next && "[Partial result]",
		view.withheldDiagnostic && `[${view.withheldDiagnostic} diagnostic withheld]`,
	].filter((row): row is string => typeof row === "string");
}

export function presentTool(name: string, presenter: Presenter, showDiagnostic: boolean): DisplayRecord {
	return {
		name,
		renderShell: "default",
		renderCall(value, theme, context) {
			const call = presenter.call(object(value));
			const title = theme.fg("toolTitle", theme.bold(name));
			const subject = homePath(field(call.subject));
			const heading = subject ? `${title} ${theme.fg("accent", subject)}` : title;
			const facts = factsLine(call.facts);
			const args = call.args ?? {};
			return component((width) => {
				const ellipsis =
					width <= visibleWidth(title) + 1 ? theme.fg("toolTitle", theme.bold("…")) : theme.fg("accent", "…");
				const rows = [
					...renderText(heading, width, context.expanded, ellipsis),
					...renderText(facts, width, context.expanded).map((row) => theme.fg("muted", row)),
				];
				if (context.expanded) return [...rows, ...argumentRows(args, theme, width)];
				if (!context.state.googleResult && hidesCall(heading, facts, args, width))
					rows.push(...hint(theme, context, width, 0, false));
				return rows;
			});
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			// Pi constructs the call first and draws its component after the result renderer runs.
			context.state.googleResult = true;
			const args = object(context.args);
			const call = presenter.call(args);
			if (isPartial) {
				return component((width) => [
					"",
					theme.fg(
						"muted",
						clip(name === "google_status" ? "Checking Google Workspace access." : "Awaiting the Google result.", width),
					),
				]);
			}
			const source = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			const view = project(presenter, source, args, context.isError, showDiagnostic);
			const outcome = field(view.outcome);
			const body = (view.body ?? []).map(text).join("\n");
			const details = disclosure(view, name);
			const notices = resultExtras(view);
			const heading = [name, homePath(field(call.subject))].filter(Boolean).join(" ");
			const facts = factsLine(call.facts);
			const colour = context.isError ? "error" : "toolOutput";
			return component((width) => {
				const preview = expanded
					? { visualLines: renderText(body, width, true), skippedCount: 0 }
					: truncateToVisualLines(body, 5, width, 0, "start");
				const rows = [
					"",
					...renderText(outcome, width, expanded).map((row) => theme.fg(colour, row)),
					...preview.visualLines.map((row) => theme.fg(colour, row)),
					...notices.flatMap((notice) => renderText(notice, width, expanded).map((row) => theme.fg("warning", row))),
				];
				if (expanded)
					return details.length
						? [
								...rows,
								"",
								...details.flatMap((line) => wrapTextWithAnsi(line, width).map((row) => theme.fg("toolOutput", row))),
							]
						: rows;
				const hidden =
					preview.skippedCount ||
					details.length ||
					visibleWidth(outcome) > width ||
					hidesCall(heading, facts, call.args ?? {}, width) ||
					notices.some((notice) => visibleWidth(notice) > width);
				return hidden ? [...rows, ...hint(theme, context, width, preview.skippedCount, true)] : rows;
			});
		},
	};
}
