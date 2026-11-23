import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callCard, resultCard, type SlopTool } from "./presentation.ts";

type ToolDisplay = Pick<ToolDefinition, "name" | "renderCall" | "renderResult">;
const tools: SlopTool[] = ["slop", "slop_check", "slop_record"];
const cards = tools.map((name): ToolDisplay => ({ name, renderCall: callCard(name), renderResult: resultCard(name) }));
export function toolDisplay() {
	return { version: 1 as const, tools: cards.map((tool) => ({ ...tool })) };
}
