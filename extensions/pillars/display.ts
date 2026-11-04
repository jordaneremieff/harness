import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { accessRenderers, usageRenderers } from "./presentation.ts";

type ToolDisplayPublication = {
	version: 1;
	tools: Array<{
		name: string;
		renderCall?: ToolDefinition["renderCall"];
		renderResult?: ToolDefinition["renderResult"];
		renderShell?: ToolDefinition["renderShell"];
	}>;
};

// Each renderer accepts the result shape its own tool produces; Pi passes exactly those results.
const records = [
	{ name: "pillars", ...accessRenderers() },
	{ name: "pillars_usage", ...usageRenderers() },
] as unknown as ToolDisplayPublication["tools"];

/** Pure renderer records for the ordinary publication and the standalone display descriptor. */
export function toolDisplay(): ToolDisplayPublication {
	return { version: 1, tools: records.map((record) => ({ ...record })) };
}
