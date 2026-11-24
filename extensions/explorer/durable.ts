import type * as Durable from "@earendil-works/pi-durable";
import { nativeConversationConnection, nativeLive } from "./live-host.ts";
import { publishSettings, readSettings, type SettingsBus } from "./settings.ts";
import {
	NOTES_DESCRIPTION,
	NOTES_OUTPUT_BYTES,
	NotesParameters,
	outcomeContent,
	outcomeDetails,
	runNotes,
	runShow,
	ShowParameters,
	showDescription,
	showGuidance,
	ToolOutcomeSchema,
} from "./tools.ts";

export interface ExplorerHost {
	readonly durable: typeof Durable;
	readonly agentDir: string;
	readonly cwd: string;
	readonly harness: Durable.Harness;
	onClose(dispose: () => void | Promise<void>): void;
}
export function explorerContribution(source: string, bus: SettingsBus, stopFactoryPublisher: () => void) {
	return {
		name: "explorer",
		source,
		display: { version: 1 as const, entry: "./display.ts", export: "toolDisplay" as const },
		create(host: ExplorerHost): Durable.Extension {
			stopFactoryPublisher();
			host.onClose(publishSettings(bus, { agentDir: host.agentDir }));
			const { dir, app } = readSettings({ agentDir: host.agentDir }).values;
			const { bridges } = nativeLive(host);
			const show = host.durable.defineTool({
				name: "explorer_show",
				description: showDescription("native"),
				parameters: ShowParameters,
				structuredOutputSchema: ToolOutcomeSchema,
				replay: "unsafe",
				outputLimits: { maxBytes: 64 * 1024, maxLines: 32 },
				async execute(input, api, context) {
					const value = await runShow(input, {
						cwd: host.cwd,
						app,
						dir,
						agentDir: host.agentDir,
						signal: context.abortSignal,
						find: () => bridges.find(String(api.conversationId)),
						connect: async () => {
							const conversation = await host.harness.conversation(api.conversationId, context);
							if (!conversation) throw new Error("The exact invoking conversation is unavailable.");
							return nativeConversationConnection(host, conversation);
						},
					});
					return {
						output: outcomeContent(value),
						structuredOutput: JSON.parse(JSON.stringify(value)),
						details: outcomeDetails(value),
						isError: !value.ok,
					};
				},
			});
			const notes = host.durable.defineTool({
				name: "explorer_notes",
				description: NOTES_DESCRIPTION,
				parameters: NotesParameters,
				structuredOutputSchema: ToolOutcomeSchema,
				replay: "unsafe",
				outputLimits: { maxBytes: NOTES_OUTPUT_BYTES, maxLines: 32 },
				async execute(input, _api, context) {
					const value = await runNotes(input, { cwd: host.cwd, dir, signal: context.abortSignal });
					return {
						output: outcomeContent(value),
						structuredOutput: JSON.parse(JSON.stringify(value)),
						details: outcomeDetails(value),
						isError: !value.ok,
					};
				},
			});
			return host.durable.defineExtension({
				name: "explorer",
				tools: [show, notes],
				sections: [host.durable.section("explorer", () => showGuidance("native"))],
			});
		},
	};
}
