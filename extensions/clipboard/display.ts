/** Presentation-only tool cards for the clipboard tools. Importing this module registers nothing and reads no store. */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	renderCopyCall,
	renderCopyResult,
	renderGetCall,
	renderGetResult,
	renderListCall,
	renderListResult,
	renderPasteCall,
	renderPasteResult,
	renderRestoreCall,
	renderRestoreResult,
} from "./presentation.ts";

type ToolDisplayPublication = {
	version: 1;
	tools: Array<Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">>;
};

export function toolDisplay(): ToolDisplayPublication {
	return {
		version: 1,
		tools: [
			{ name: "clipboard_copy", renderCall: renderCopyCall, renderResult: renderCopyResult },
			{ name: "clipboard_paste", renderCall: renderPasteCall, renderResult: renderPasteResult },
			{ name: "clipboard_list", renderCall: renderListCall, renderResult: renderListResult },
			{ name: "clipboard_get", renderCall: renderGetCall, renderResult: renderGetResult },
			{ name: "clipboard_restore", renderCall: renderRestoreCall, renderResult: renderRestoreResult },
		],
	};
}
