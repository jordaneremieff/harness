import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderReadCall, renderReadResult, renderSearchCall, renderSearchResult } from "./presentation.ts";

type ToolDisplayPublication = {
	version: 1;
	tools: Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">[];
};

export function toolDisplay(): ToolDisplayPublication {
	return {
		version: 1,
		tools: [
			{ name: "web_read", renderCall: renderReadCall, renderResult: renderReadResult, renderShell: undefined },
			{ name: "web_search", renderCall: renderSearchCall, renderResult: renderSearchResult, renderShell: undefined },
		],
	};
}
