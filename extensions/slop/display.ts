import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callCard, resultCard } from "./presentation.ts";

type ToolDisplay = Pick<ToolDefinition, "name" | "renderCall" | "renderResult">;
function card(name: string, label: string, keys: string[]): ToolDisplay {
	return { name, renderCall: callCard(label, keys), renderResult: resultCard };
}
const cards = [
	card("slop", "Slop catalog", ["entry", "scope", "query"]),
	card("slop_check", "Slop check", ["text", "path", "diff"]),
	card("slop_record", "Slop record", ["action", "id"]),
];
export function toolDisplay() {
	return { version: 1 as const, tools: cards.map((tool) => ({ ...tool })) };
}
