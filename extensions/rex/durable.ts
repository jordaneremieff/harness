import type { Context, JsonValue } from "@earendil-works/chord";
import type * as Durable from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import { boundResult, resultByteLimit, RexCore, type RexCallContext, type RexRequest, type RexResult } from "./core.ts";
import { liveCalls, resultChannels, type RexAdapterOptions } from "./config.ts";
import { initialOwnershipState, validateOwnershipState, type OwnershipState, type OwnershipStore } from "./ownership.ts";
import { REX_GUIDANCE, ResultSchema, toolSpecs, validateRequest, type StatusRequest } from "./schema.ts";
import { publishSettings, readSettings, type SettingsBus } from "./settings.ts";
import { rexStatus, validateStatusBinding, type HostActivity, type RexExecutor, type StatusStore } from "./status.ts";

export interface DurableContributionHost {
	readonly durable: typeof Durable;
	readonly cwd: string;
	readonly agentDir: string;
	readonly storageId: string;
	readonly harness: Durable.Harness;
	readonly signal: AbortSignal;
	onClose(dispose: () => void | Promise<void>): void;
}
export interface DurableContribution {
	readonly name: string;
	readonly source: string;
	create(host: DurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
}
type OwnedDocument = { ownerId: string; state: JsonValue };
type StatusDocument = { ownerId: string; binding: JsonValue };
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** These callbacks run exclusively on Durable's serial commit line. */
export function nativeOwnershipStore(
	api: Pick<Durable.ToolExecutionApi, "conversationId" | "snapshot" | "commit">,
	token: Durable.ConversationDocToken<OwnedDocument>,
	ownerId: string,
	maxRecords: number,
	context: Context,
): OwnershipStore {
	const readState = (document: Readonly<OwnedDocument> | undefined): OwnershipState => {
		if (document?.ownerId && document.ownerId !== ownerId) throw new Error("Rex ownership state belongs to another conversation.");
		const state = document?.ownerId ? validateOwnershipState(json(document.state), maxRecords) : initialOwnershipState();
		if (state.records.some((record) => record.ownerId !== ownerId)) throw new Error("Rex ownership records belong to another conversation.");
		return state;
	};
	return {
		read: async (requestedOwner) => {
			if (requestedOwner !== ownerId) throw new Error("Rex ownership requires the calling conversation.");
			return readState(await api.snapshot(token, api.conversationId, context));
		},
		update: async (requestedOwner, change) => {
			if (requestedOwner !== ownerId) throw new Error("Rex ownership requires the calling conversation.");
			return api.commit(async (tx) => {
				const doc = await tx.doc(token, api.conversationId);
				const state = validateOwnershipState(change(readState(doc)), maxRecords);
				if (state.records.some((record) => record.ownerId !== ownerId)) throw new Error("Rex ownership records belong to another conversation.");
				doc.ownerId = ownerId;
				doc.state = json(state);
				return state;
			}, context);
		},
	};
}

function nativeStatusStore(api: Durable.ToolExecutionApi, token: Durable.ConversationDocToken<StatusDocument>, ownerId: string, context: Context): StatusStore {
	return {
		read: async () => {
			const doc = await api.snapshot(token, api.conversationId, context);
			if (doc?.ownerId && doc.ownerId !== ownerId) throw new Error("The Rex inspection binding belongs to another conversation.");
			return validateStatusBinding(doc?.binding, ownerId);
		},
		write: (binding) => api.commit(async (tx) => {
			const doc = await tx.doc(token, api.conversationId);
			if (doc.ownerId && doc.ownerId !== ownerId) throw new Error("The Rex inspection binding belongs to another conversation.");
			doc.ownerId = ownerId;
			doc.binding = json(validateStatusBinding(binding, ownerId) ?? null);
		}, context),
	};
}

function nativeResult(result: RexResult, maxBytes: number): Durable.ToolExecutionResult<Durable.JsonObject> {
	const channels = resultChannels(boundResult(result, maxBytes));
	return { output: channels.content, structuredOutput: channels.structuredContent, isError: channels.isError, details: channels.details };
}

async function callContext(host: DurableContributionHost, api: Durable.ToolExecutionApi, context: Context, ownerId: string): Promise<RexCallContext> {
	return { ownerId, callId: api.callId, cwd: api.env?.cwd ?? (await api.agent(context)).cwd ?? host.cwd, signal: AbortSignal.any([host.signal, ...(context.abortSignal ? [context.abortSignal] : [])]) };
}

async function hostActivity(host: DurableContributionHost, api: Durable.ToolExecutionApi, context: Context): Promise<HostActivity> {
	const inspection = await host.harness.inspect(context);
	const tasks = inspection.tasks.filter((task) => task.record.conversationId === api.conversationId && task.record.id !== api.taskId);
	return { host: "durable", state: tasks.some((task) => task.state.kind === "blocked") ? "blocked" : tasks.length ? "active" : "idle", observedAt: new Date().toISOString(), source: "Harness.inspect() current conversation tasks", tasks: tasks.slice(0, 64).map((task) => ({ id: String(task.record.id), kind: task.record.kind, state: task.state.kind, background: task.record.background, abortRequested: task.record.abortRequested, ...(task.state.kind === "blocked" ? { reason: task.state.reason } : {}) })), omittedTasks: Math.max(0, tasks.length - 64), note: "A scheduler block is not a request for operator permission. No live task does not prove task completion or acceptance. Other conversations are outside this snapshot." };
}

export function rexContribution(source: string, bus: SettingsBus, stopFactoryPublisher: () => void, options: RexAdapterOptions = {}): DurableContribution {
	return {
		name: "rex", source,
		create(host) {
			stopFactoryPublisher();
			host.onClose(publishSettings(bus, { agentDir: host.agentDir }));
			const settings = readSettings({ agentDir: host.agentDir }).values;
			const active = new Set<RexExecutor>();
			const invocations = liveCalls();
			host.onClose(async () => {
				try { for (const core of active) core.dispose(); }
				finally { await invocations.drain(); }
			});
			const durable = host.durable;
			const ownership = durable.defineDoc<OwnedDocument>({ kind: "rex.ownership", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ ownerId: "", state: json(initialOwnershipState()) }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31 });
			const binding = durable.defineDoc<StatusDocument>({ kind: "rex.status", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ ownerId: "", binding: null }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31 });
			return durable.defineExtension({
				name: "rex",
				sections: [durable.section("rex", () => REX_GUIDANCE)],
				tools: toolSpecs.map((spec) => durable.defineTool<TSchema, Durable.JsonObject>({
					name: spec.name, description: spec.description, parameters: spec.parameters,
					replay: "unsafe", structuredOutputSchema: ResultSchema,
					outputLimits: { maxBytes: resultByteLimit(settings.maxOutputBytes), maxLines: 2000, retain: "head" },
					execute: async (args, api, context) => {
						const maxBytes = resultByteLimit(settings.maxOutputBytes);
						const validated = validateRequest(spec.name, args);
						if (!validated.ok) return nativeResult(validated, maxBytes);
						const ownerId = `${host.storageId}:${api.conversationId}`;
						const store = nativeOwnershipStore(api, ownership, ownerId, settings.maxRecords, context);
						const coreOptions = { ...settings, store, isCallActive: invocations.isCallActive };
						const core = options.createCore?.(coreOptions) ?? new RexCore(coreOptions);
						const release = invocations.enter(ownerId, api.callId);
						active.add(core);
						try {
							const call = await callContext(host, api, context, ownerId);
							const result = spec.name === "rex_status" ? await rexStatus(validated.request as StatusRequest, call, core, nativeStatusStore(api, binding, ownerId, context), () => hostActivity(host, api, context)) : await core.execute(validated.request as RexRequest, call);
							return nativeResult(result, maxBytes);
						} finally { active.delete(core); try { core.dispose(); } finally { release(); } }
					},
				})),
			});
		},
	};
}
