/**
 * pillars/durable: the native Pi Durable form of the pillars extension.
 *
 * The ordinary entrypoint emits one contribution; an agent session host
 * installs it beside the host's built-in extensions. Both entrypoints share
 * the slice's corpus access, draft assessment, access-evidence store, and
 * readback functions. Attribution runs as native ToolTask hooks; each tool
 * round flushes the collected evidence through a GenerationTask `afterTools`
 * hook, the host signal releases the store on shutdown, and the close
 * registration makes the host await the final flush. The contribution also
 * supplies the `pillars` command for the judgment actions.
 */
import { publishSettings, readSettings, type SettingsBus } from "./settings.ts";
import type { Context, JsonValue } from "@earendil-works/chord";
import type * as Durable from "@earendil-works/pi-durable";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { StringEnum, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ACCESS_DESCRIPTION, access, type AccessPage, parseAccess } from "./access.ts";
import { type Catalog, loadCatalog, readBody, type Resource, resourceById, resourceByPath } from "./catalog.ts";
import type { Stage } from "./capacity.ts";
import { Collector, utcDay } from "./collector.ts";
import { judgmentPrompt, parseJudgmentRequest } from "./commands.ts";
import { DRAFT_GUIDANCE, DraftInputError, draftAssessment, MAX_DRAFT_BYTES, splitDraft } from "./draft.ts";
import { InputError } from "./input.ts";
import { accessEvidence, type DeliveryExtent, extract, readEvidence, type ResultEvidence } from "./observation.ts";
import { createReader, errorResponse, parseRequest, TOOL_DESCRIPTION } from "./readback.ts";
import { PillarsStore } from "./store.ts";

export interface DurableContribution {
	readonly name: string;
	readonly source: string;
	create(host: DurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
	readonly commands?: readonly DurableCommand[];
}

export interface DurableContributionHost {
	readonly durable: typeof Durable;
	readonly services: AgentSessionServices;
	readonly cwd: string;
	readonly agentDir: string;
	readonly storageId: string;
	readonly harness: Durable.Harness;
	readonly signal: AbortSignal;
	onClose(dispose: () => void | Promise<void>): void;
	readonly inventory: DurableInventory;
}

export interface DurableInventory {
	readonly contributions: readonly {
		readonly name: string;
		readonly source: string;
		readonly commands: readonly { readonly name: string; readonly description: string }[];
	}[];
	readonly ordinaryOnly: readonly string[];
}

export interface DurableCommand {
	readonly name: string;
	readonly description: string;
	run(call: DurableCommandCall): Promise<string>;
}

export interface DurableCommandCall {
	readonly args: string;
	readonly conversation: Durable.Conversation;
	readonly harness: Durable.Harness;
	readonly context: Context;
	readonly host: DurableContributionHost;
	readonly invocationId: string;
}

/** Pi Durable details are JSON values; the corpus page and usage response are plain JSON objects. */
const asDetails = (value: unknown): JsonValue => value as JsonValue;

function parsedInput(args: unknown): ReturnType<typeof splitDraft> {
	try {
		return splitDraft(args);
	} catch (error) {
		if (!(error instanceof DraftInputError)) throw error;
		throw new Error(JSON.stringify({ schema: "pillars-source-error", code: "invalid_input", message: error.message }));
	}
}

/** The assessment rides the result as a diagnostic, so the source content stays pure JSON. */
function assessmentDiagnostics(
	input: ReturnType<typeof splitDraft>,
	signal: AbortSignal | undefined,
): Durable.ToolDiagnostic[] {
	if (input.draft === undefined || signal?.aborted === true) return [];
	return [{ severity: "info", message: draftAssessment(input.draft) }];
}

export const PILLARS_COMMAND_DESCRIPTION =
	"Ask the conversation to check Pillars alignment, derive candidates, or review guidance. Accepts an optional hint.";

const pillarsCommand: DurableCommand = {
	name: "pillars",
	description: PILLARS_COMMAND_DESCRIPTION,
	async run(call) {
		const request = parseJudgmentRequest(call.args);
		if (!request) return "The pillars command accepts check, derive, or review with an optional hint.";
		const submission = await call.conversation.submit(
			{
				type: "input",
				content: judgmentPrompt(request),
				requestId: `pillars:${call.invocationId}`,
				whenBusy: "steer",
			},
			call.context,
		);
		return `Submitted the Pillars ${request.action} request as submission ${String(submission.id)}.`;
	},
};

/**
 * Build one contribution for this slice. `source` is the absolute path of the
 * entrypoint that emits it; the agent session host matches it to Pi's loaded
 * extension paths.
 */
export function pillarsDurableContribution(
	source: string,
	publisher: { bus: SettingsBus; stopFactory: () => void },
): DurableContribution {
	return {
		name: "pillars",
		source,
		commands: [pillarsCommand],
		async create(host) {
			const { GenerationTask, ToolTask, defineExtension, defineTool, hook, section } = host.durable;
			publisher.stopFactory();
			const stopSettings = publishSettings(publisher.bus, { agentDir: host.agentDir });
			host.onClose(stopSettings);
			const snapshot = readSettings({ agentDir: host.agentDir });
			const store = new PillarsStore(snapshot.values.dir);
			const invalidCollect = snapshot.records.find((record) => record.key === "collect")?.status === "invalid";
			const enabled = snapshot.values.collect && !invalidCollect;
			for (const issue of snapshot.diagnostics) process.stderr.write(`${issue.field}: ${issue.message}\n`);
			if (invalidCollect)
				process.stderr.write("pillars.collect requires a boolean (environment: 0, 1, false, or true). The collector is disabled.\n");
			const collector = enabled
				? new Collector(store, { diagnostic: (message) => process.stderr.write(`${message}\n`) })
				: undefined;
			const reader = createReader((signal) => store.capture(utcDay(), signal), { enabled: () => enabled });
			let catalog: Catalog | undefined;
			try {
				catalog = await loadCatalog(host.signal, { agentDir: host.agentDir });
			} catch {
				catalog = undefined;
			}
			if (!catalog)
				process.stderr.write("The loaded Pillars source is unavailable. Access attribution remains unavailable.\n");
			let closing = false;
			let flushChain: Promise<void> = Promise.resolve();
			let releaseWork: Promise<void> | undefined;
			function release(): Promise<void> {
				if (releaseWork !== undefined) return releaseWork;
				closing = true;
				stopSettings();
				reader.clear();
				releaseWork = collector?.shutdown() ?? Promise.resolve();
				return releaseWork;
			}
			host.signal.addEventListener("abort", () => void release(), { once: true });
			host.onClose(() => release());

			/** One delivered page is recorded for its result-stage observation; a replay keeps the first extent. */
			async function recordDelivery(page: AccessPage, api: Durable.ToolExecutionApi, context: Context): Promise<void> {
				if (collector === undefined || closing) return;
				await api.memo(
					"pillars.delivery",
					{
						resource: page.resource,
						offset: page.offset,
						endOffset: page.endOffset,
						bodyBytes: page.bodyBytes,
						referenceBodyDigest: page.referenceBodyDigest,
					},
					context,
				);
			}

			/** HookApi exposes no agent; the contract resolves it through the host Harness. */
			async function resolvedAgent(api: Durable.HookApi, context: Context): Promise<Durable.Agent | undefined> {
				const conversation = await host.harness.conversation(api.conversationId, context);
				return conversation?.agent(context);
			}

			/** Resolve one observed call's corpus resource, by name for pillars and by path for read. */
			async function resourceFor(call: ToolCall, cwd: string): Promise<Resource | undefined> {
				if (catalog === undefined) return undefined;
				if (call.name === "pillars") return resourceById(catalog, call.arguments.resource ?? "inventory");
				if (call.name === "read") return resourceByPath(catalog, call.arguments.path, cwd);
				return undefined;
			}

			/** A replay after process loss repeats no admitted observation: the memo gates admission first. */
			async function admitted(name: string, api: Durable.HookApi, context: Context): Promise<boolean> {
				if ((await api.memo(name, context)) !== undefined) return false;
				await api.memo(name, true, context);
				return true;
			}

			async function admit(
				resource: Resource,
				stage: Stage,
				agent: Durable.Agent | undefined,
				evidence: (reference: Buffer | undefined) => ResultEvidence | undefined,
				context: Context,
			): Promise<void> {
				let reference: Buffer | undefined;
				try {
					reference = await readBody(resource.path, context.abortSignal);
				} catch {
					collector?.incident("unresolvedAccessEvents");
				}
				const cell = extract({
					stage,
					day: utcDay(),
					resource,
					model: agent?.model === undefined ? undefined : `${agent.model.provider}/${agent.model.modelId}`,
					reasoning: agent?.thinkingLevel,
					piVersion: VERSION,
					reference,
					result: evidence(reference),
				});
				collector?.admit(cell);
			}

			async function observeRequest(call: ToolCall, api: Durable.HookApi, context: Context): Promise<void> {
				if (closing || collector === undefined) return;
				const agent = await resolvedAgent(api, context);
				const resource = await resourceFor(call, agent?.cwd ?? host.cwd);
				if (resource === undefined) return;
				if (!(await admitted("pillars.observed.request", api, context))) return;
				await admit(resource, "tool_request", agent, () => undefined, context);
			}

			async function observeResult(
				call: ToolCall,
				result: Durable.ToolExecutionResult,
				api: Durable.HookApi,
				context: Context,
			): Promise<void> {
				if (closing || collector === undefined) return;
				const agent = await resolvedAgent(api, context);
				const resource = await resourceFor(call, agent?.cwd ?? host.cwd);
				if (resource === undefined) return;
				if (!(await admitted("pillars.observed.result", api, context))) return;
				const delivered =
					call.name === "pillars" ? await api.memo<DeliveryExtent>("pillars.delivery", context) : undefined;
				await admit(
					resource,
					"tool_result",
					agent,
					(reference) =>
						call.name === "pillars"
							? accessEvidence(result.content, resource.resourceId, result.isError === true, delivered)
							: readEvidence(result.content, reference, result.isError === true),
					context,
				);
			}

			const parameters = Type.Object(
				{
					resource: Type.Optional(
						Type.String({
							maxLength: 64,
							description: "Resource identifier from the inventory; defaults to inventory",
						}),
					),
					offset: Type.Optional(
						Type.Integer({ minimum: 0, maximum: 1048576, description: "UTF-8 byte offset from nextOffset" }),
					),
					referenceBodyDigest: Type.Optional(
						Type.String({
							pattern: "^[a-f0-9]{64}$",
							description: "Required for continuation; prevents mixing source revisions",
						}),
					),
					draft: Type.Optional(
						Type.String({
							minLength: 1,
							maxLength: MAX_DRAFT_BYTES,
							description:
								"Concrete agent-authored proposal to assess after this source read. Nonblank, well-formed Unicode, at most 8192 UTF-8 bytes. Retained in native history, not private scratch.",
						}),
					),
				},
				{ additionalProperties: false },
			);

			return defineExtension({
				name: "pillars",
				tools: [
					{
						...defineTool({
							name: "pillars",
							description: `${ACCESS_DESCRIPTION} ${DRAFT_GUIDANCE}`,
							parameters,
							replay: "safe",
							prepareArguments(input) {
								try {
									const { source, draft } = splitDraft(input);
									const { referenceBodyDigest, ...args } = parseAccess(source, catalog);
									return {
										...args,
										...(referenceBodyDigest === undefined ? {} : { referenceBodyDigest }),
										...(draft === undefined ? {} : { draft }),
									};
								} catch (error) {
									if (!(error instanceof InputError) && !(error instanceof DraftInputError)) throw error;
									throw new Error(
										JSON.stringify({ schema: "pillars-source-error", code: "invalid_input", message: error.message }),
									);
								}
							},
							async execute(args, api, context) {
								const input = parsedInput(args);
								const result = await access(catalog, input.source, context.abortSignal);
								if (result.schema === "pillars-source") await recordDelivery(result, api, context);
								if (result.schema === "pillars-source-error")
									return {
										content: [{ type: "text", text: JSON.stringify(result) }],
										isError: true,
										details: asDetails(result),
									};
								return {
									content: [{ type: "text", text: JSON.stringify(result) }],
									details: asDetails(result),
									diagnostics: assessmentDiagnostics(input, context.abortSignal),
								};
							},
						}),
					},
					{
						...defineTool({
							name: "pillars_usage",
							description: TOOL_DESCRIPTION,
							parameters: Type.Object(
								{
									view: Type.Optional(StringEnum(["overview", "revisions"] as const)),
									windowDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
									cursor: Type.Optional(Type.String({ minLength: 4, maxLength: 256, pattern: "^[-_A-Za-z0-9]+$" })),
								},
								{ additionalProperties: false },
							),
							replay: "safe",
							prepareArguments(input) {
								try {
									return parseRequest(input);
								} catch (error) {
									if (!(error instanceof InputError)) throw error;
									throw new Error(JSON.stringify(errorResponse("invalid_input", error.message)));
								}
							},
							async execute(args, _api, context) {
								const result = await reader.read(args, context.abortSignal);
								return {
									content: [{ type: "text", text: JSON.stringify(result) }],
									details: asDetails(result),
								};
							},
						}),
					},
				],
				sections: [
					section("pillars", () =>
						[
							"Read Pillars and assess an agent-authored draft before delivery.",
							"Call pillars at judgment moments: design or architecture decisions, trade-offs, option menus, verification depth, information placement, and prose tells.",
							'Read resource:"governance" before applying any corpus entry.',
							DRAFT_GUIDANCE,
						].join("\n"),
					),
				],
				hooks: [
					hook(ToolTask, {
						beforeTool: async (call, api, context) => {
							await observeRequest(call, api, context);
							return undefined;
						},
						afterTool: async (call, result, api, context) => {
							await observeResult(call, result, api, context);
							return undefined;
						},
					}),
					hook(GenerationTask, {
						afterTools: async (_assistant, _results, _api, context) => {
							if (collector === undefined || closing) return;
							const flush = flushChain.then(() => collector.flush(true, context.abortSignal));
							flushChain = flush.catch(() => undefined);
							await flush;
						},
					}),
				],
			});
		},
	};
}
