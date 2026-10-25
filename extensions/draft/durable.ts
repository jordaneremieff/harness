/**
 * Native Pi Durable form of the draft extension.
 *
 * The ordinary entrypoint emits one contribution; the agent session host
 * installs the extension returned by `create(host)`. The form checks each final
 * answer with the same domain code as the ordinary form and returns the
 * findings through the generation `onYield` hook. Decisions that must not change
 * on replay are memoized on the task; the notice latch lives in a conversation
 * document.
 */
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import type * as Durable from "@earendil-works/pi-durable";
import type { JsonObject } from "@earendil-works/pi-durable";
import { checkReply, type CheckOutcome } from "./check.ts";
import { publishSettings, readSettings, type SettingsBus } from "./settings.ts";
import { checkDraft, description, parameters, promptGuidelines, promptSnippet } from "./tool.ts";

/** What the host supplies to one Durable extension instance. */
export interface DraftDurableHost {
	readonly durable: typeof Durable;
	readonly agentDir: string;
	readonly services: AgentSessionServices;
	readonly harness: Durable.Harness;
	onClose(dispose: () => void | Promise<void>): void;
}

export interface DraftDurableContribution {
	readonly name: string;
	readonly source: string;
	create(host: DraftDurableHost): Durable.Extension;
}

type DraftState = {
	/** A meter-unavailable notice was delivered and the meter has not worked since. */
	noticed: boolean;
	/** Task that delivered the latest notice; a replayed hook does not deliver it twice. */
	noticeTask: string;
	/** Oldest submission in the run that already received its repair pass. */
	repairedRun?: number;
};

type Decision = {
	continue: boolean;
	text?: string;
	/** Set when a meter-unavailable notice must be delivered. */
	notice?: string;
	/** Set when a working meter must clear the notice latch. */
	cleared?: boolean;
	/** Oldest placed input identifies the run across successor generation tasks. */
	repairedRun?: number;
};

function checkedDecision(outcome: CheckOutcome, noticed: boolean, run: number): Decision {
	if (outcome.kind === "repair") return { continue: true, text: outcome.text, cleared: true, repairedRun: run };
	if (outcome.kind === "unavailable") return noticed ? { continue: false } : { continue: false, notice: outcome.text };
	if (outcome.kind === "clean") return { continue: false, cleared: noticed };
	return { continue: false };
}

function answerText(answer: AssistantMessage): string {
	return answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

export function draftDurableContribution(
	source: string,
	bus: SettingsBus,
	disposeFactorySettings: () => void,
): DraftDurableContribution {
	return {
		name: "draft",
		source,
		create(host) {
			disposeFactorySettings();
			host.services.resourceLoader.extendResources({
				skillPaths: [
					{
						path: fileURLToPath(new URL(".", import.meta.url)),
						metadata: { source, scope: "temporary", origin: "top-level" },
					},
				],
			});
			host.onClose(publishSettings(bus, { agentDir: host.agentDir }));
			return createDraftDurableExtension(host);
		},
	};
}

export function createDraftDurableExtension(host: DraftDurableHost, checker = checkReply): Durable.Extension {
	const stateDoc = host.durable.defineDoc<DraftState>({
		kind: "draft.state",
		version: 1,
		checkpointWhen: () => false,
		scope: "conversation",
		history: "latest",
		fork: "initial",
		initial: () => ({ noticed: false, noticeTask: "" }),
	});

	/** Placed submissions belong to the active run; queued input and passive writes do not. */
	async function operatorRun(api: Durable.HookApi, context: Context): Promise<number | undefined> {
		const conversation = await host.harness.conversation(api.conversationId, context);
		if (!conversation) return undefined;
		const { submissions } = await host.harness.inspect(context);
		const placed = submissions.filter(
			(input) => input.conversationId === api.conversationId && input.type === "input" && input.status === "placed",
		);
		for (const input of placed) {
			if (input.type !== "input" || input.status !== "placed") continue;
			const page = await conversation.entries(
				{ minEntryId: input.entry, maxEntryId: input.entry },
				1,
				undefined,
				context,
			);
			if (page.items[0]?.kind === "pi.user") return placed[0]?.id;
		}
		return undefined;
	}

	async function decide(answer: AssistantMessage, api: Durable.HookApi, context: Context): Promise<Decision> {
		const config = readSettings({ agentDir: host.agentDir }).values;
		if (!config.enabled) return { continue: false };
		const run = await operatorRun(api, context);
		if (run === undefined) return { continue: false };
		const state = await api.snapshot(stateDoc, api.conversationId, context);
		if (state?.repairedRun === run) return { continue: false };
		return checkedDecision(await checker(answerText(answer), config), state?.noticed === true, run);
	}

	async function apply(decision: Decision, api: Durable.HookApi, context: Context): Promise<void> {
		if (decision.notice === undefined && !decision.cleared) return;
		const task = String(api.taskId);
		await host.harness.commit(async (tx) => {
			const state = await tx.doc(stateDoc, api.conversationId);
			if (decision.repairedRun !== undefined) state.repairedRun = decision.repairedRun;
			if (decision.cleared) {
				state.noticed = false;
				return;
			}
			if (state.noticed || state.noticeTask === task || decision.notice === undefined) return;
			state.noticed = true;
			state.noticeTask = task;
			await tx.appendEntry(api.conversationId, {
				kind: "draft.notice",
				model: [{ role: "user", content: decision.notice, timestamp: Date.now() }],
				data: { text: decision.notice },
			});
		}, context);
	}

	return host.durable.defineExtension({
		name: "draft",
		tools: [
			host.durable.defineTool({
				name: "draft",
				description,
				parameters,
				replay: "safe",
				async execute(input, api, context) {
					const agent = await api.agent(context);
					const result = await checkDraft(input, agent.cwd ?? process.cwd(), context.abortSignal);
					return { output: [{ type: "text", text: result.text }] };
				},
			}),
		],
		sections: [
			{
				key: "draft",
				render: ({ agent }) =>
					agent.tools.some((tool) => tool.name === "draft")
						? [promptSnippet, ...promptGuidelines].join("\n")
						: undefined,
			},
		],
		hooks: [
			host.durable.hook(host.durable.GenerationTask, {
				onYield: async (answer: AssistantMessage, api, context) => {
					const known = (await api.memo<JsonObject>(`answer:${answer.timestamp}`, context)) as Decision | undefined;
					const decision: Decision = known ?? (await decide(answer, api, context));
					const stored = (await api.memo(`answer:${answer.timestamp}`, decision as JsonObject, context)) as Decision;
					await apply(stored, api, context);
					return stored.continue && stored.text !== undefined ? { continue: stored.text } : undefined;
				},
			}),
		],
	});
}
