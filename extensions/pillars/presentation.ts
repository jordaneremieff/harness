import {
	type AgentToolResult,
	keyText,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AccessError, AccessPage, AccessRequest } from "./access.ts";
import type { Response } from "./readback.ts";

export interface UsageRequest {
	view?: "overview" | "revisions";
	windowDays?: number;
	cursor?: string;
}

interface RenderContext {
	isError: boolean;
}

/** Collapsed results name the hidden content and the host's tool-output expansion binding. */
function expandHint(theme: Theme): string {
	const key = keyText("app.tools.expand") || "ctrl+o";
	return theme.fg("muted", "... (") + theme.fg("dim", key) + theme.fg("muted", " to expand)");
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Terminal rendering for the `pillars` tool: compact by default, full source text when expanded. */
export function accessRenderers(): {
	renderCall(args: AccessRequest | undefined, theme: Theme): Text;
	renderResult(
		result: AgentToolResult<AccessPage | AccessError | undefined>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: RenderContext,
	): Text;
} {
	return {
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("pillars "));
			text += theme.fg("accent", args?.resource ?? "inventory");
			if (args?.offset !== undefined) text += theme.fg("dim", ` (offset ${args.offset})`);
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) return new Text(`\n${theme.fg("warning", "Reading the corpus...")}`, 0, 0);
			const details = result.details;
			if (context.isError || !details || details.schema === "pillars-source-error") {
				const structured = details?.schema === "pillars-source-error" ? `pillars: ${details.code}` : "";
				const message = structured || (context.isError ? textContent(result) : "") || "pillars: unavailable";
				return new Text(`\n${theme.fg("error", message)}`, 0, 0);
			}
			let text = `\n${theme.fg("success", details.resource)}`;
			text += theme.fg("dim", ` (${details.endOffset - details.offset} of ${details.bodyBytes} bytes)`);
			if (details.nextOffset !== undefined) text += theme.fg("warning", " (continuation available)");
			if (options.expanded) {
				if (details.text) {
					text += `\n\n${details.text
						.split("\n")
						.map((line) => theme.fg("toolOutput", line))
						.join("\n")}`;
				}
			} else {
				text += `\n${expandHint(theme)}`;
			}
			return new Text(text, 0, 0);
		},
	};
}

/** Terminal rendering for the `pillars_usage` tool: compact by default, the evidence page when expanded. */
export function usageRenderers(): {
	renderCall(args: UsageRequest | undefined, theme: Theme): Text;
	renderResult(
		result: AgentToolResult<Response | undefined>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: RenderContext,
	): Text;
} {
	return {
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("pillars_usage"));
			const parts: string[] = [];
			if (args?.view !== undefined) parts.push(args.view);
			if (args?.windowDays !== undefined) parts.push(`${args.windowDays} days`);
			if (args?.cursor !== undefined) parts.push("continuation");
			if (parts.length > 0) text += theme.fg("dim", ` (${parts.join(", ")})`);
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) return new Text(`\n${theme.fg("warning", "Reading access evidence...")}`, 0, 0);
			const details = result.details;
			if (context.isError || !details || details.kind === "error") {
				const message =
					details && details.kind === "error" ? details.message : "The access-evidence read did not complete.";
				return new Text(`\n${theme.fg("error", `pillars_usage: ${message}`)}`, 0, 0);
			}
			let text = `\n${theme.fg("success", details.view)}`;
			text += theme.fg(
				"dim",
				` (page ${details.pagination.pageNumber} of ${details.pagination.pageCount}, read requests: ${details.totals.readRequests}, ${details.window.fromDay} through ${details.window.toDay})`,
			);
			if (options.expanded) {
				text += `\n\n${usageMarkdown(details)
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n")}`;
			} else {
				text += `\n${expandHint(theme)}`;
			}
			return new Text(text, 0, 0);
		},
	};
}

export function usageMarkdown(response: Response): string {
	if (response.kind === "error")
		return `# Pillars access evidence\n\n${response.message}\n\n${Object.values(response.meaning).join("\n\n")}`;
	const lines = [
		"# Pillars access evidence",
		`${response.window.fromDay} through ${response.window.toDay}. Page ${response.pagination.pageNumber} of ${response.pagination.pageCount}.`,
		`Retained shards: ${response.coverage.retainedDayShards}. Collector enabled here: ${response.enabled}.`,
		`Storage assessment: ${response.storageEvidence.assessment}. Live collectors, whole-window coverage, and unpersisted loss: unknown.`,
		"## Totals",
		...Object.entries(response.totals).map(([name, count]) => `- ${name}: ${count}`),
		"## Recorded storage evidence",
		...Object.entries(response.storageEvidence).map(([name, value]) => `- ${name}: ${value}`),
		`Capture omissions: ${response.coverage.captureOmissions.join(", ") || "none recorded; not complete collection"}.`,
		`Revision rows: ${response.summary.revisionRows}. Additional resource identities folded in this overview: ${response.summary.foldedResourceIdentities}.`,
		"## Rows",
	];
	const rows = response.view === "revisions" ? response.rows : response.byResource;
	for (const row of rows) {
		lines.push(`### ${row.resourceClass}: ${row.resourceId}`);
		if ("observationStage" in row)
			lines.push(
				`Day: ${row.day}; stage: ${row.observationStage}.`,
				`Model: ${row.model}; reasoning: ${row.reasoning}.`,
				`Reference SHA-256: ${row.referenceBodyDigest}.`,
				`Observer version: ${row.observerVersion}; Pi version: ${row.piVersion}.`,
			);
		else lines.push(`Last observed day: ${row.lastSeenDay}.`);
		lines.push(
			Object.entries(row.counters)
				.map(([name, count]) => `${name}: ${count}`)
				.join("; "),
		);
	}
	lines.push("## Interpretation", ...Object.values(response.meaning));
	if (response.pagination.nextCursor)
		lines.push(
			`Next page: /pillars next ${response.pagination.nextCursor}`,
			`Capture expires at ${response.pagination.cursorExpiresAt}.`,
		);
	return lines.join("\n\n");
}
