import { getAgentDir, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAgentContribution, resolveAgentControlDispatch } from "./durable-agents.ts";
import { publishSettings } from "./settings.ts";

export function createNativeAgentEntry(source: string): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const settingsAgentDir = process.env.PI_AGENT_DIR ?? getAgentDir();
		const disposeFactorySettings = publishSettings(pi.events, { agentDir: settingsAgentDir });
		pi.events.emit(
			"durable:contribution",
			createAgentContribution({
				source,
				configureSettings: (host) => {
					disposeFactorySettings();
					const disposeNativeSettings = publishSettings(pi.events, { agentDir: host.agentDir });
					host.onClose(disposeNativeSettings);
				},
				dispatch: (method, params, context) => resolveAgentControlDispatch()(method, params, context),
			}),
		);
		pi.on("session_shutdown", () => {
			disposeFactorySettings();
		});
	};
}
