/**
 * Pure presentation module for the standalone terminal's display descriptor.
 *
 * It exports exactly the renderer records the ordinary registration publishes
 * and imports presentation code only: no extension factory, no tool
 * registration, no event emission, no settings, store, or host lifecycle.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	renderCompleteCall,
	renderCompleteResult,
	renderEditCall,
	renderEditResult,
	renderListCall,
	renderListResult,
	renderReadCall,
	renderReadResult,
	renderRotateCall,
	renderRotateResult,
	renderWriteCall,
	renderWriteResult,
} from "./presentation.ts";

type ToolDisplayPublication = {
	version: 1;
	tools: Array<{
		name: string;
		renderCall?: ToolDefinition["renderCall"];
		renderResult?: ToolDefinition["renderResult"];
		renderShell?: ToolDefinition["renderShell"];
	}>;
};

export function toolDisplay(): ToolDisplayPublication {
	return {
		version: 1,
		tools: [
			{ name: "stash_write", renderCall: renderWriteCall, renderResult: renderWriteResult },
			{ name: "stash_list", renderCall: renderListCall, renderResult: renderListResult },
			{ name: "stash_read", renderCall: renderReadCall, renderResult: renderReadResult },
			{ name: "stash_edit", renderCall: renderEditCall, renderResult: renderEditResult },
			{ name: "stash_complete", renderCall: renderCompleteCall, renderResult: renderCompleteResult },
			{ name: "stash_rotate", renderCall: renderRotateCall, renderResult: renderRotateResult },
		],
	};
}
