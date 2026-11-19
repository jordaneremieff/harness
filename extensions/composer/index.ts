import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerComposer } from "./composer.ts";
import { publishSettings } from "./settings.ts";

export default function composer(pi: ExtensionAPI): void {
	const unsubscribe = publishSettings(pi.events, { agentDir: getAgentDir() });
	pi.on("session_shutdown", () => {
		unsubscribe();
	});
	registerComposer(pi);
}
