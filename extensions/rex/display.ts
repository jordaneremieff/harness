import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRexToolDisplay } from "./presentation.ts";
import { toolSpecs } from "./schema.ts";

type ToolDisplayPublication = {
	version: 1;
	tools: Array<{
		name: string;
		renderCall?: ToolDefinition["renderCall"];
		renderResult?: ToolDefinition["renderResult"];
		renderShell?: ToolDefinition["renderShell"];
	}>;
};

const records = toolSpecs.map((spec) => ({ name: spec.name, ...createRexToolDisplay(spec.name) }));

export function toolDisplay(): ToolDisplayPublication {
	return { version: 1, tools: [...records] };
}
