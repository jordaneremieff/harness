import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isRecord } from "./live-protocol.ts";

type Card = Pick<ToolDefinition, "name" | "renderCall" | "renderResult">;
function safe(value: string, limit: number) {
	return value.slice(0, limit).replace(/[\p{Cf}\p{Cc}\ud800-\udfff]/gu, (char) => (char === "\n" ? "\n" : " "));
}
function line(value: unknown) {
	return typeof value === "string" ? safe(value, 240).replace(/\s+/gu, " ").trim() : "";
}
function card(name: "explorer_show" | "explorer_notes"): Card {
	return {
		name,
		renderCall(args, theme, context) {
			const value = isRecord(args) ? args : {};
			const subject =
				name === "explorer_notes"
					? [value.op, value.path ?? value.id ?? value.root].map(line).filter(Boolean).join(" · ")
					: line(value.path ?? value.tour) || "working directory";
			const heading = `${theme.fg("toolTitle", theme.bold(name))}${subject ? theme.fg("accent", ` · ${subject}`) : ""}`;
			const key = context.keyText?.("app.tools.expand");
			return new Text(
				`${heading}\n${context.expanded ? theme.fg("toolOutput", safe(JSON.stringify(args, null, 2) ?? "", 8192)) : theme.fg("dim", key ? `${key} to expand arguments` : "Expand for arguments")}`,
				0,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			const info = isRecord(result.details) ? result.details : {};
			const summary =
				line(info.summary) || (context.isError ? line(text) || "Explorer operation failed" : "Explorer result");
			const key = context.keyText?.("app.tools.expand");
			return new Text(
				`\n${theme.fg(context.isError ? "error" : "muted", summary)}\n${options.expanded ? theme.fg("toolOutput", safe(text, 16384)) : theme.fg("dim", key ? `${key} to expand result` : "Expand for result")}`,
				0,
				0,
			);
		},
	};
}
export function toolDisplay() {
	return { version: 1 as const, tools: [card("explorer_show"), card("explorer_notes")] };
}
