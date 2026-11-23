import type { Context } from "@earendil-works/chord/context";
import type * as Durable from "@earendil-works/pi-durable";
import { checkPrompt, checkUsage, parseCheckHint } from "./command.ts";
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

const slopCommand = {
	name: "slop",
	description: "Check this conversation's work for slop with an optional hint.",
	async run(call: {
		args: string;
		origin?: "operator" | "model";
		conversation: Durable.Conversation;
		context: Context;
		invocationId: string;
	}) {
		const hint = parseCheckHint(call.args);
		if (hint === undefined) return checkUsage;
		if (call.origin !== "operator") return "Only the operator can invoke /slop check.";
		const submission = await call.conversation.submit(
			{ type: "input", content: checkPrompt(hint), requestId: `slop:${call.invocationId}`, whenBusy: "steer" },
			call.context,
		);
		return `Submitted the slop check as submission ${String(submission.id)}.`;
	},
};

export function slopContribution(source: string, bus: SettingsBus, stopOrdinaryPublications: () => void) {
	return {
		name: "slop",
		source,
		commands: [slopCommand],
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
