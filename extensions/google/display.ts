import {
	type KeybindingHints,
	type Theme,
	type ToolDefinition,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type DisplayRecord = Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">;

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safe(value: string): string {
	return stripTerminalSequences(value.replace(/\r\n?/g, "\n"))
		.replaceAll("\t", "   ")
		.replace(/[\p{Cc}\p{Bidi_Control}\p{Cs}]/gu, (char) => (char === "\n" ? char : ""));
}

function field(value: unknown): string {
	return typeof value === "string" ? safe(value).replace(/\s+/g, " ").trim() : "";
}

function envelope(text: string): Record<string, unknown> | undefined {
	try {
		const value = object(JSON.parse(text));
		return value?.schemaVersion === 1 &&
			(value.status === "ok" || value.status === "partial" || value.status === "error")
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

function statusOutcome(ready: unknown): string {
	if (ready === true) return "Access is ready.";
	if (ready === false) return "Access is not ready.";
	return "Readiness was not established.";
}

function statusText(text: string, isError: boolean) {
	const result = envelope(text);
	const failed = "The Google Workspace status check failed.";
	if (!result) {
		const [first, ...rest] = safe(text).trim().split("\n");
		return {
			outcome: first.trim() || (isError ? failed : statusOutcome(undefined)),
			body: rest.join("\n"),
			details: "",
		};
	}
	const data = object(result.data);
	const error = object(isError ? result.error : data?.error);
	const diagnostic = typeof error?.message === "string" ? safe(error.message).trim() : "";
	const code = field(error?.code);
	const backend = object(data?.backend);
	const backendName = field(backend?.name);
	const version = field(backend?.requiredVersion);
	const observed = field(data?.observedAccount);
	const expected = field(data?.expectedAccount);
	const outcome =
		code === "ABORTED"
			? "Cancelled"
			: isError
				? diagnostic.replace(/\s+/g, " ") || code || failed
				: statusOutcome(data?.ready);
	const body = [
		!isError && code !== "ABORTED" && (diagnostic || code),
		observed && `Signed in as ${observed}`,
		expected && expected !== observed && `Expected account ${expected}`,
		backendName && version && `Requires ${backendName} ${version}`,
	].filter(Boolean);
	return { outcome, body: body.join("\n"), details: safe(JSON.stringify(result, null, 2)) };
}

function clip(line: string, width: number, ellipsis = "…"): string {
	// Drop the full resets that clipping adds; Pi's Box supplies the row background.
	return truncateToWidth(line, width, ellipsis).replaceAll("\u001b[0m", "");
}

function hint(theme: Theme, context: KeybindingHints, skippedCount: number): string {
	const key = "app.tools.expand";
	const count = skippedCount ? `${skippedCount} more ${skippedCount === 1 ? "line" : "lines"}, ` : "";
	const action = context.keyText(key) ? context.keyHint(key, "to expand") : theme.fg("muted", "click to expand");
	return theme.fg("muted", `... (${count}`) + action + theme.fg("muted", ")");
}

function component(render: (width: number) => string[]): Component {
	let cachedWidth: number | undefined;
	let lines: string[] = [];
	return {
		invalidate() {
			cachedWidth = undefined;
		},
		render(width) {
			if (width <= 0) return [];
			if (cachedWidth !== width) {
				lines = render(width);
				cachedWidth = width;
			}
			return lines;
		},
	};
}

const statusDisplay: DisplayRecord = {
	name: "google_status",
	renderShell: "default",
	renderCall(_args, theme) {
		const name = theme.fg("toolTitle", theme.bold("google_status"));
		const subject = theme.fg("accent", "Google Workspace access");
		return component((width) => {
			const ellipsis =
				width <= visibleWidth(name) + 1 ? theme.fg("toolTitle", theme.bold("…")) : theme.fg("accent", "…");
			return [clip(`${name} ${subject}`, width, ellipsis)];
		});
	},
	renderResult(result, { expanded, isPartial }, theme, context) {
		if (isPartial) {
			return component((width) => ["", theme.fg("muted", clip("Checking Google Workspace access.", width))]);
		}
		const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		const { outcome, body, details } = statusText(text, context.isError);
		const outcomeColour = context.isError ? "error" : "toolOutput";
		return component((width) => {
			const lead = expanded ? wrapTextWithAnsi(outcome, width) : [clip(outcome, width)];
			const lines = ["", ...lead.map((line) => theme.fg(outcomeColour, line))];
			if (expanded) {
				if (body) lines.push(...wrapTextWithAnsi(body, width).map((line) => theme.fg("toolOutput", line)));
				if (details) {
					lines.push("", ...wrapTextWithAnsi(details, width).map((line) => theme.fg("toolOutput", line)));
				}
				return lines;
			}
			const { visualLines, skippedCount } = truncateToVisualLines(body, 5, width, 0, "start");
			lines.push(...visualLines.map((line) => theme.fg("toolOutput", line)));
			if (skippedCount || details || visibleWidth(outcome) > width) {
				lines.push(clip(hint(theme, context, skippedCount), width, theme.fg("muted", "…")));
			}
			return lines;
		});
	},
};

export function toolDisplay(): { version: 1; tools: DisplayRecord[] } {
	return { version: 1, tools: [statusDisplay] };
}
