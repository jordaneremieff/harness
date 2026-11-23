import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { singleLine, terminalText } from "./presentation-text.ts";

export function callCard(label: string, keys: string[]): NonNullable<ToolDefinition["renderCall"]> {
	return (args, theme) => {
		const names = keys.filter((key) => Object.hasOwn(args ?? {}, key));
		return new Text(
			theme.fg("toolTitle", theme.bold(label)) + (names.length ? theme.fg("muted", ` · ${names.join(", ")}`) : ""),
			0,
			0,
		);
	};
}

export const resultCard: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme) => {
	const body = result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
	const details = result.details as
		| { summary?: unknown; ok?: unknown; findingCount?: unknown; skippedCount?: unknown }
		| undefined;
	const summary =
		typeof details?.summary === "string"
			? details.summary
			: typeof details?.ok === "boolean" &&
					typeof details.findingCount === "number" &&
					typeof details.skippedCount === "number"
				? `${details.ok ? "No slop findings" : `${details.findingCount} slop detector finding(s)`}${details.skippedCount ? ` · ${details.skippedCount} skipped` : ""}`
				: body.split("\n", 1)[0];
	return new Text(
		options.expanded
			? terminalText(body)
			: theme.fg(details?.ok === false ? "warning" : "dim", singleLine(summary).slice(0, 180)),
		0,
		0,
	);
};
