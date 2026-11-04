/** Ordinary tool-display publication derived from the pure display module so both surfaces share one record set. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolDisplay } from "./display.ts";

type ToolDisplayRequest = { version: 1 };

export function toolDisplayPublisher(pi: Pick<ExtensionAPI, "events" | "registerTool">) {
	const version: ToolDisplayRequest["version"] = 1;
	const publish = () => pi.events.emit("harness:tool-display:publish", toolDisplay());
	pi.events.on("harness:tool-display:request", (request: unknown) => {
		if (request && typeof request === "object" && "version" in request && request.version === version) publish();
	});
	const registerTool: ExtensionAPI["registerTool"] = (definition) => {
		pi.registerTool(definition);
	};
	return { registerTool, publish };
}
