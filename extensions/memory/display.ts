import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderCall, renderResult } from "./presentation.ts";

type ToolDisplayPublication = {
	version: 1;
	tools: Array<{
		name: string;
		renderCall?: ToolDefinition["renderCall"];
		renderResult?: ToolDefinition["renderResult"];
		renderShell?: ToolDefinition["renderShell"];
	}>;
};

const tools: ToolDisplayPublication["tools"] = [
	"memory_search", "memory_read", "memory_history", "memory_write", "memory_edit", "memory_review", "memory_retire",
].map((name) => ({
	name,
	renderCall: (args, theme, context) => renderCall(name, args, theme, context),
	renderResult: (result, options, theme, context) => renderResult(name, result, options, theme, context),
}));

/** Pure renderer records for ordinary and standalone tool cards. */
export function toolDisplay(): ToolDisplayPublication {
	return { version: 1, tools: tools.map((tool) => ({ ...tool })) };
}
