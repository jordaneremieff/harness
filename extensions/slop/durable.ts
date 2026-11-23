import type * as Durable from "@earendil-works/pi-durable";
import {
	catalogSection,
	check,
	CHECK_DESCRIPTION,
	CheckOutput,
	CheckParams,
	inspectCatalog,
	record,
	RECORD_DESCRIPTION,
	RecordParams,
	VIEW_DESCRIPTION,
	ViewParams,
} from "./operations.ts";
import { publishSettings, type SettingsBus } from "./settings.ts";

interface Host {
	readonly durable: typeof Durable;
	readonly agentDir: string;
	readonly cwd: string;
	readonly storageId: string;
	onClose(dispose: () => void): void;
}

export function slopContribution(source: string, bus: SettingsBus, stopOrdinaryPublications: () => void) {
	return {
		name: "slop",
		source,
		display: { version: 1, entry: "./display.ts", export: "toolDisplay" } as const,
		create(host: Host): Durable.Extension {
			const { defineExtension, defineTool, section } = host.durable;
			const options = { agentDir: host.agentDir };
			stopOrdinaryPublications();
			host.onClose(publishSettings(bus, options));
			const result = (value: { content: { type: "text"; text: string }[]; details: Durable.JsonObject }) => ({
				output: value.content,
				details: value.details,
			});
			return defineExtension({
				name: "slop",
				sections: [section("slop", () => catalogSection(options))],
				tools: [
					defineTool({
						name: "slop",
						description: VIEW_DESCRIPTION,
						parameters: ViewParams,
						replay: "safe",
						execute: async (args) => result(inspectCatalog(options, args)),
					}),
					defineTool({
						name: "slop_check",
						description: CHECK_DESCRIPTION,
						parameters: CheckParams,
						replay: "safe",
						structuredOutputSchema: CheckOutput,
						execute: async (args, api, context) => {
							const agent = await api.agent(context);
							const checked = await check(options, agent.cwd ?? host.cwd, args, context.abortSignal);
							return { ...result(checked), structuredOutput: checked.details };
						},
					}),
					defineTool({
						name: "slop_record",
						description: RECORD_DESCRIPTION,
						parameters: RecordParams,
						replay: "unsafe",
						execute: async (args, api, context) => {
							const agent = await api.agent(context);
							context.abortSignal?.throwIfAborted();
							return result(
								record(options, args, {
									session: `${host.storageId}:${api.conversationId}`,
									cwd: agent.cwd ?? host.cwd,
									model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : null,
								}),
							);
						},
					}),
				],
			});
		},
	};
}
