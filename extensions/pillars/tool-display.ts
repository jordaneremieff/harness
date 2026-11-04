import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolDisplay } from "./display.ts";

export function toolDisplayPublisher(pi: Pick<ExtensionAPI, "events">) {
	const stop = pi.events.on("harness:tool-display:request", (request: unknown) => {
		if (request && typeof request === "object" && "version" in request && request.version === 1)
			pi.events.emit("harness:tool-display:publish", toolDisplay());
	});
	return {
		publish: () => pi.events.emit("harness:tool-display:publish", toolDisplay()),
		stop,
	};
}
