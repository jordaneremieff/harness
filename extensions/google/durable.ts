import type * as Durable from "@earendil-works/pi-durable";
import { calendarTools } from "./calendar.ts";
import { driveTools } from "./drive.ts";
import { gmailTools } from "./gmail.ts";
import { GoogleRuntime } from "./gws.ts";
import { RESULT_MAX_BYTES } from "./result.ts";
import { publishSettings, type SettingsBus } from "./settings.ts";
import { sheetsTools } from "./sheets.ts";
import { guidance, invoke } from "./tools.ts";

export interface DurableContributionHost {
	readonly durable: typeof Durable;
	readonly agentDir: string;
	onClose(dispose: () => void | Promise<void>): void;
}

export function googleContribution(source: string, bus: SettingsBus, stopFactoryPublisher: () => void) {
	const tools = [...gmailTools, ...driveTools, ...sheetsTools, ...calendarTools];
	return {
		name: "google",
		source,
		create(host: DurableContributionHost): Durable.Extension {
			stopFactoryPublisher();
			host.onClose(publishSettings(bus, { agentDir: host.agentDir }));
			const runtime = new GoogleRuntime(host.agentDir);
			const durable = host.durable;
			return durable.defineExtension({
				name: "google",
				tools: tools.map((tool) =>
					durable.defineTool({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
						replay: tool.replay,
						deferred: true,
						// The result is one line within this byte cap, so the host's output bound
						// never cuts a tool envelope.
						outputLimits: { maxBytes: RESULT_MAX_BYTES, maxLines: 2000, retain: "head" },
						execute: async (args, _api, context) => {
							const result = await invoke(tool, args, runtime, context.abortSignal);
							return { output: result.content, details: result.details, ...(result.isError ? { isError: true } : {}) };
						},
					}),
				),
				sections: [
					durable.section("google-guidance", (input) => {
						const offered = new Set(input.agent.tools.map((offeredTool) => offeredTool.name));
						const selected = tools.filter((tool) => offered.has(tool.name));
						return selected.length === 0 ? undefined : guidance(selected);
					}),
				],
			});
		},
	};
}
