import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderRegistryCall, renderRegistryResult } from "./presentation.ts";

type ToolDisplayPublication = {
	version: 1;
	tools: Array<{
		name: string;
		renderCall?: ToolDefinition["renderCall"];
		renderResult?: ToolDefinition["renderResult"];
		renderShell?: ToolDefinition["renderShell"];
	}>;
};

/** Pure renderer records for ordinary and standalone tool cards. */
export function toolDisplay(): ToolDisplayPublication {
	return { version: 1, tools: [{ name: "registry", renderCall: renderRegistryCall, renderResult: renderRegistryResult }] };
}
