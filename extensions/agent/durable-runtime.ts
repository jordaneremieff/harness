import { DURABLE_TARGET_QUESTION, questionLengthRefusal, questionReceipt } from "./peer-questions.ts";
import { readSettings } from "./settings.ts";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	readAgentPreferences,
	resolveExecutionPreset,
	effectiveExecutionSelection,
	parsePreferenceSnapshot,
	type ExecutionSelection,
	type ExecutionFields,
} from "./agent-preferences.ts";
import { defineDocFamily, GenerationTask, hook } from "@earendil-works/pi-durable";
import { effortNoteRequestHooks } from "./effort-notes-native.ts";

const ExecutionSelectionDoc = defineDocFamily<{ input?: string; selection?: ExecutionSelection }, null>({
	kind: "agent.execution-selection",
	family: true,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	checkpointWhen: () => false,
	initial: () => ({}),
});
import { launchIndependentCommand } from "./independent-launch.ts";

function controlRequestId(params: Readonly<Record<string, unknown>>): string {
	return typeof params.requestId === "string" ? params.requestId : randomUUID();
}
import type { Context } from "@earendil-works/chord/context";
import { collaborationStorage } from "./collaboration-contract.ts";
import { projectCollaboration } from "./collaboration.ts";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentCatalog, storageIdOf, validateDeliveryRecipient } from "./catalog.ts";
import {
	isThreadStorage,
	threadStorageRecipientRefusal,
	threadStorageRefusal,
	threadStorageServes,
} from "./identity.ts";
import { storageStatusPageInput } from "./storage-status.ts";
import { boundCatalogView, withAttentionHints, withModelEvidence, type CatalogView } from "./catalog-view.ts";
import { projectCatalogAttention } from "./catalog-attention.ts";
import type { HostMetadata } from "./host-protocol.ts";
import type { HostRuntime } from "./host-process.ts";
import { DurableHost, readTaskGraph, stopBeforeResume } from "./durable-host.ts";
import { onStoredCommit } from "./commit-observation.ts";
import { stopForeignReferences } from "./run-control.ts";
import { createDurableServices, type DurableServices, type CreateDurableServicesOptions } from "./durable-services.ts";
import { publishAgentControlDispatch, type AgentControlDispatch } from "./durable-agents.ts";
import { projectConversationIntents } from "./durable-controls.ts";
import { deliveryPendingCount, migrateDeliveryStore } from "./delivery-store.ts";
import { isThinkingLevel } from "./configuration.ts";
import type { ModelChoicesSchema } from "./observation-schema.ts";
import type { Static } from "@earendil-works/pi-schema";
import { AgentManager } from "./manager.ts";
import {
	PEER_TEXT_LIMIT,
	startDurableDelivery,
	type DurableDelivery,
	type NativeTargetFailure,
} from "./durable-delivery.ts";
import { writeDeliveryWake } from "./delivery-wake.ts";
import { connectPrimaryChannel, readPrimaryEndpointDescriptor } from "./primary-channel.ts";

/** The identity that a control's answer, report or scheduled input is addressed to. */
function controlRecipient(method: string, params: Readonly<Record<string, unknown>>): string | undefined {
	if (method === "rewind" && params.selfOwned === true) return undefined;
	const recipient =
		method === "task-submit"
			? (params.replyTo ?? params.requester)
			: ["submit", "report", "rewind", "timer-schedule"].includes(method)
				? params.ownerId
				: undefined;
	return typeof recipient === "string" ? recipient : undefined;
}

function controlParams(input: unknown): Record<string, unknown> {
	if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input)))
		throw new Error("Control parameters must be an object");
	return { ...(input as Record<string, unknown> | undefined) };
}

/** Methods that admit work or delivery into this storage. */
import { projectProfiles } from "./profile.ts";
import { requestContextHooks, requestContextSection } from "./request-context.ts";
import { RequestRouteState } from "./request-route-state.ts";
import { withProfileHints, withIntentClaims } from "./catalog-view.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Harness, ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";

const ADMITTING_METHODS: ReadonlySet<string> = new Set([
	"task-submit",
	"profile-update",
	"resolve-agent",
	"submit",
	"report",
	"rewind",
	"command",
	"compact",
	"spawn",
	"place",
	"reset",
	"timer-schedule",
	"collaboration-mutate",
	"passive-submit",
]);
const FOREIGN_OBSERVATION_METHODS: ReadonlySet<string> = new Set([
	"inspect",
	"status",
	"snapshot",
	"dashboard",
	"profile-read",
]);
/** Coalesce a burst of native commits into one catalog view publication. */
const PUBLISH_COALESCE_MS = 250;
/** A release decision waits this long for the delivery driver's scheduled pass before it refuses on a stale summary. */
const RELEASE_OBSERVATION_WAIT_MS = 10_000;

async function bootstrap(
	metadata: HostMetadata,
	controller: AbortController,
	execution: boolean,
	options: Pick<CreateDurableServicesOptions, "modelRuntime"> = {},
): Promise<DurableServices> {
	const independent = metadata.independent;
	return createDurableServices({
		...options,
		cwd: metadata.cwd,
		agentDir: metadata.agentDir,
		storageId: metadata.storageId,
		catalogRoot: dirname(metadata.storagePath),
		packageDir: metadata.packageDir,
		agentExtensionPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
		trusted: metadata.trust,
		signal: controller.signal,
		...(independent === undefined ? {} : { resolveProjectTrust: async () => independent.projectTrusted }),
		launchIndependent: (input) =>
			launchIndependentCommand(input, {
				root: dirname(dirname(metadata.storagePath)),
				agentDir: metadata.agentDir,
				packageDir: metadata.packageDir,
			}),
		askPrimary: async (cwd) => {
			const root = dirname(dirname(metadata.storagePath));
			const primary = new AgentCatalog(root).ordinaryOwner(metadata.ownerId);
			if (primary === undefined) return undefined;
			const channel = await connectPrimaryChannel({ id: primary, sessionsRoot: root });
			try {
				return await channel.trustPrompt(cwd, controller.signal);
			} finally {
				await channel.close();
			}
		},
		ordinarySession: () => new AgentCatalog(dirname(dirname(metadata.storagePath))).ordinaryOwner(metadata.ownerId),
		onReport: (error) => {
			process.stderr.write(`Durable host: ${String(error)}\n`);
		},
		...(execution
			? {
					buildBuiltin: async (host) => {
						const { createDurableExecution } = await import("./durable-execution.ts");
						return createDurableExecution(host);
					},
				}
			: {}),
	});
}
/** One writer invocation with the configured task definitions, but without execution, delivery or an endpoint. */
export async function stopColdRuntime(metadata: HostMetadata, sessionId: string, background: boolean) {
	const controller = new AbortController();
	// The normal contributions supply task definitions. MCP and codemode add tools, not task kinds.
	const services = await bootstrap(metadata, controller, false);
	const open = async (readOnly: boolean) => {
		const storage = await openNodeSqliteStorage(metadata.storagePath);
		try {
			return await Harness.open(
				storage,
				{
					models: services.services.modelRuntime,
					registry: services.registry,
					settings: services.settings,
					env: services.env,
					readOnly,
				},
				BACKGROUND_CONTEXT,
			);
		} catch (error) {
			await storage.close(BACKGROUND_CONTEXT);
			throw error;
		}
	};
	let reader: Harness | undefined;
	try {
		// A contribution gets only the actual storage's read-only Harness. Even an eager installer cannot resume it.
		reader = await open(true);
		await services.install(reader);
		const writer = await open(false);
		try {
			await migrateDeliveryStore(writer, BACKGROUND_CONTEXT);
			const stopped = await stopBeforeResume(writer, metadata.storageId, sessionId, background, BACKGROUND_CONTEXT);
			// Work closure can produce a final report even when no task needed an abort.
			if (!stopped.settled || (await deliveryPendingCount(writer, BACKGROUND_CONTEXT)) > 0)
				new AgentCatalog(dirname(dirname(metadata.storagePath))).markRecoveryDue(metadata.storageId, true);
			return stopped;
		} finally {
			await writer.close(BACKGROUND_CONTEXT);
		}
	} finally {
		controller.abort();
		try {
			await services.close();
		} finally {
			await reader?.close(BACKGROUND_CONTEXT);
		}
	}
}

function configuredModel(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const split = value.indexOf("/");
	if (split < 1 || split === value.length - 1) throw new Error("Model requires an exact provider/model identity");
	return { provider: value.slice(0, split), modelId: value.slice(split + 1) };
}

function validateModel(
	services: DurableServices,
	model: { provider: string; modelId: string },
	level: string,
): ModelThinkingLevel {
	const selected = services.services.modelRuntime.getModel(model.provider, model.modelId);
	if (!selected) throw new Error(`Model is not in the configured catalog: ${model.provider}/${model.modelId}`);
	if (!isThinkingLevel(level)) throw new Error("Unknown reasoning level");
	return clampThinkingLevel(selected, level);
}

/** Last-known available models of the configured runtime; the read starts no credential check or network request. */
export function modelChoices(services: Pick<DurableServices, "services">): Static<typeof ModelChoicesSchema> {
	const runtime = services.services.modelRuntime;
	const error = runtime.getError();
	return {
		models: runtime
			.getAvailableSnapshot()
			.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				reasoning: model.reasoning,
				...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
			}))
			.sort((a, b) => `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`)),
		source: "available-snapshot",
		...(error === undefined ? {} : { error: error.slice(0, 240) }),
		observedAt: new Date().toISOString(),
	};
}

/** Constructed only after the process claims the storage writer. */
/** A message to an ordinary primary; a question must fit the report body that the recipient reads. */
function assertPrimaryMessage(method: string, params: Record<string, unknown>): void {
	if (method === "collaboration-mutate")
		throw new Error(
			"Threads of an ordinary primary live in that primary's own thread storage; repeat agent_collaborate create without sessionId to create the thread in your own storage",
		);
	if (method !== "submit") throw new Error("A registered primary accepts messages, not Durable session controls");
	const refusal =
		params.expectReply === true ? questionLengthRefusal(String(params.message ?? ""), PEER_TEXT_LIMIT) : undefined;
	if (refusal !== undefined) throw new Error(refusal);
}

export async function createDurableRuntime(
	metadata: HostMetadata,
	options: Pick<CreateDurableServicesOptions, "modelRuntime"> = {},
): Promise<HostRuntime> {
	const controller = new AbortController();
	let services = await bootstrap(metadata, controller, true, options);
	let host: DurableHost;
	let closed = false;
	let reloading = false;
	let reloadFailed = false;
	let sessionFailed = false;
	let reloadClosingHost: DurableHost | undefined;
	let activeRequests = 0;
	let activeAdmissions = 0;
	const requestScope = new AsyncLocalStorage<string>();
	let releaseRequested = false;
	const releaseListeners = new Set<(requested: boolean) => void>();
	let recoveryReady = false;
	let recoveryDirty = false;
	let recoverySync: Promise<void> | undefined;
	let activityGeneration = 0;
	let retirementSealed = false;
	const changeListeners = new Set<() => void>();
	let publishedView: CatalogView | undefined;
	const observationListeners = new Set<() => void>();
	const activityListeners = new Set<() => void>();
	const quiescentListeners = new Set<() => void>();
	function notifyActivity(): void {
		for (const listener of activityListeners) listener();
	}
	let unsubscribeChanges: (() => void) | undefined;
	let unsubscribeObservation: (() => void) | undefined;
	let unsubscribeClose: (() => void) | undefined;
	const catalog = new AgentCatalog(dirname(dirname(metadata.storagePath)));
	const threadStorageOwner = isThreadStorage(metadata, catalog.root) ? metadata.ownerId : undefined;
	/** A recipient in this storage needs no catalog read; any other identity costs one record stat. */
	function refuseThreadStorageRecipient(field: string, recipient: string): void {
		let storageId: string;
		try {
			storageId = storageIdOf(recipient);
		} catch {
			return;
		}
		const owner = storageId === metadata.storageId ? threadStorageOwner : catalog.threadStorageOwner(storageId);
		if (owner !== undefined) throw new Error(threadStorageRecipientRefusal(field, recipient, owner));
	}
	/** The target's own host refuses too; a host that started before it learned the refusal does not. */
	function refuseThreadStorageTarget(target: HostMetadata, method: string, params: Record<string, unknown>): void {
		if (isThreadStorage(target, catalog.root) && !threadStorageServes(method, params))
			throw new Error(threadStorageRefusal(target.storageId, String(target.ownerId)));
	}
	const unavailableDeliveryTargets = new Map<string, NativeTargetFailure>();
	let deliveries: DurableDelivery;
	let publishTimer: ReturnType<typeof setTimeout> | undefined;
	let publishPromise: Promise<void> | undefined;
	let publishingView = false;
	let flushingView = false;
	let publishAgain = false;

	function runtimeUnavailable(): boolean {
		return closed || reloadFailed || retirementSealed;
	}

	/** Check committed work and delivery under one unchanged admission generation. */
	async function tryRetire(seal: () => boolean): Promise<boolean> {
		if (runtimeUnavailable() || reloading || activeRequests > 0 || deliveries.busy) return false;
		const generation = activityGeneration;
		const state = await recoveryState(true);
		if (state.workPending || state.deliveriesActive || !host.isIdle()) {
			cancelRequestedRelease();
			return false;
		}
		if (
			generation !== activityGeneration ||
			runtimeUnavailable() ||
			reloading ||
			activeRequests > 0 ||
			!deliveries.summary(true).fresh ||
			!seal()
		)
			return false;
		deliveries.sealAdmission();
		retirementSealed = true;
		return true;
	}

	/**
	 * True once this storage's catalog record is gone. No caller can discover the storage again, so the host records
	 * no marker or view, never recreates the record, admits no new work and retires when idle.
	 */
	let recordRemoved = false;
	function catalogRecordRemoved(error: unknown): boolean {
		if (recordRemoved) return true;
		if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") return false;
		if (lstatSync(catalog.path(metadata.storageId), { throwIfNoEntry: false }) !== undefined) return false;
		recordRemoved = true;
		process.stderr.write("Durable host: the storage's catalog record was removed; the host retires when idle.\n");
		return true;
	}

	/** Write the recovery marker; a failed write blocks the admitting request. A removed record takes no marker. */
	function markRecoveryDue(due: boolean): void {
		if (recordRemoved) return;
		try {
			catalog.markRecoveryDue(metadata.storageId, due);
		} catch (error) {
			if (!catalogRecordRemoved(error)) throw error;
		}
	}

	/** Mark recovery before an admission; a storage that no caller can discover again admits nothing. */
	function markAdmissionDue(): void {
		markRecoveryDue(true);
		if (recordRemoved) throw new Error("The storage's catalog record was removed; this host admits no new work.");
	}

	/** Pending delivery rows: unsettled intents, unacknowledged receipts, and unacknowledged reports. */
	async function deliveriesPending(): Promise<boolean> {
		return (await deliveryPendingCount(host.harness, BACKGROUND_CONTEXT)) > 0;
	}

	/** Publish the parked recipients a later process wakes for; a storage without its record publishes none. */
	function writeParkedWake(summary: NonNullable<ReturnType<DurableDelivery["summary"]>>): void {
		if (recordRemoved) return;
		const wake = writeDeliveryWake(
			dirname(dirname(metadata.storagePath)),
			metadata.storageId,
			summary.parkedRecipients,
			(recipient) => unavailableDeliveryTargets.get(storageIdOf(recipient))?.availability ?? null,
			summary.parkedOmitted,
			summary.parkedRows,
		);
		if (wake.changed && wake.omitted > 0)
			host.reportDeliveryError(
				new Error(
					`parked: delivery wake metadata omits ${wake.omitted} recipient rows at its bound; retained rows require explicit acquisition`,
				),
			);
	}

	/** Native work plus pending delivery state used by the marker and transient monitors. */
	async function recoveryState(validateRecipients = false): Promise<{
		readonly workPending: boolean;
		readonly deliveriesPending: boolean;
		readonly deliveriesActive: boolean;
	}> {
		const generation = activityGeneration;
		const idle = await host.refreshIdle();
		const summary = deliveries?.summary(validateRecipients);
		const deliveriesActive = summary === undefined || !summary.fresh || summary.active;
		const pending = summary?.fresh ? summary.pendingCount > 0 : await deliveriesPending();
		if (generation === activityGeneration) {
			if (summary?.fresh) writeParkedWake(summary);
			markRecoveryDue(activeAdmissions > 0 || !idle || deliveriesActive);
		} else recoveryDirty = true;
		return { workPending: !idle, deliveriesPending: pending, deliveriesActive };
	}

	/** Keep the crash marker aligned with runnable work, preserving in-progress admissions. */
	async function settleRecoveryMarker(): Promise<void> {
		await recoveryState();
	}

	/** Commit bursts share one observation; read-only requests do not create marker writes. */
	function scheduleRecoveryMarker(): void {
		if (!recoveryReady || closed || reloading) return;
		recoveryDirty = true;
		if (recoverySync !== undefined) return;
		recoverySync = (async () => {
			do {
				recoveryDirty = false;
				await settleRecoveryMarker();
			} while (recoveryDirty && !closed && !reloading);
		})()
			.catch((error: unknown) => {
				process.stderr.write(`Recovery marker: ${String(error)}\n`);
			})
			.finally(() => {
				recoverySync = undefined;
				if (recoveryDirty) scheduleRecoveryMarker();
			});
	}

	async function nativeReleaseBlockers(): Promise<string[]> {
		const graph = await readTaskGraph(host.harness, BACKGROUND_CONTEXT);
		return Object.values(graph.tasks).map((task) => {
			const kind =
				task.kind === "agent.timer"
					? "A waiting timer"
					: task.kind === "agent.check-in" || task.kind === "agent.check-in-deadline"
						? "A waiting check-in task"
						: "Native work";
			return `${kind} in conversation ${host.identity(task.conversationId)}`;
		});
	}

	function hasOtherActiveRequests(): boolean {
		return activeRequests > (requestScope.getStore() === "release" ? 1 : 0);
	}

	function cancelRequestedRelease(): void {
		if (!releaseRequested) return;
		releaseRequested = false;
		for (const listener of releaseListeners) listener(false);
	}

	function deliveryReleaseBlockers(): string[] {
		const summary = deliveries.summary();
		const blockers = summary.fresh ? [] : [summary.blocker ?? "Delivery observation has not completed"];
		if (summary.active) blockers.push(...summary.activeRecipients.map((identity) => `Active delivery to ${identity}`));
		return blockers;
	}

	/** A pass the driver has not started yet; unfinished pages, in-flight effects and failures refuse at once. */
	function deliveryPassPending(): boolean {
		const blocker = deliveries.summary().blocker;
		return blocker === "Delivery observation requires a fresh pass" || blocker === "Delivery observation is scheduled";
	}

	/** The driver already owns the next pass; a release waits for a pass it has not started instead of refusing on a stale summary. */
	async function awaitDeliveryObservation(): Promise<void> {
		deliveries.summary(true);
		if (!deliveryPassPending()) return;
		await new Promise<void>((resolve) => {
			const finish = (): void => {
				clearTimeout(timer);
				quiescentListeners.delete(listener);
				resolve();
			};
			const listener = (): void => {
				if (!deliveryPassPending()) finish();
			};
			const timer = setTimeout(finish, RELEASE_OBSERVATION_WAIT_MS);
			quiescentListeners.add(listener);
		});
	}

	async function releaseBlockers(): Promise<string[]> {
		const generation = activityGeneration;
		const blockers: string[] = [];
		if (hasOtherActiveRequests()) blockers.push("Another active request uses this storage");
		const native = await nativeReleaseBlockers();
		blockers.push(...native);
		const state = await recoveryState(true);
		if (state.workPending && native.length === 0) blockers.push("Native work remains in this storage");
		blockers.push(...deliveryReleaseBlockers());
		if (generation !== activityGeneration)
			blockers.push("Native state changed during the release check; retry the request");
		return [...new Set(blockers)];
	}

	/** Release never cancels native tasks or removes retained delivery rows. */
	async function requestRelease(): Promise<{ retiring: boolean; blockers: string[] }> {
		if (runtimeUnavailable() || reloading)
			return { retiring: false, blockers: ["The runtime is closed or reload is in progress"] };
		await awaitDeliveryObservation();
		if (runtimeUnavailable() || reloading)
			return { retiring: false, blockers: ["The runtime is closed or reload is in progress"] };
		const blockers = await releaseBlockers();
		if (blockers.length > 0) return { retiring: false, blockers };
		markRecoveryDue(false);
		releaseRequested = true;
		for (const listener of releaseListeners) listener(true);
		return { retiring: true, blockers: [] };
	}

	/** Write one view into the catalog record; false when the record is gone. */
	function writeCatalogView(view: CatalogView, threads: Parameters<AgentCatalog["updateView"]>[2]): boolean {
		if (recordRemoved) return false;
		try {
			catalog.updateView(metadata.storageId, view, threads);
			return true;
		} catch (error) {
			if (catalogRecordRemoved(error)) return false;
			throw error;
		}
	}

	/** Build and publish one bounded catalog view; `force` publishes during shutdown. */
	async function publishCatalogView(force = false): Promise<void> {
		if (closed && !force) return;
		publishingView = true;
		publishPromise = (async () => {
			try {
				const projection = await host.catalogProjection();
				const base = boundCatalogView({
					updatedAt: projection.updatedAt,
					rows: projection.rows,
					storageId: metadata.storageId,
				});
				const attentionSources = base.rows.map((row) => ({
					identity: row.id,
					conversationId:
						row.id === metadata.storageId ? ROOT_CONVERSATION_ID : (Number(row.id.split(":")[1]) as ConversationId),
					state: row.state,
				}));
				const profiles = await projectProfiles(
					host.harness,
					metadata.storageId,
					attentionSources.map((source) => source.conversationId),
				);
				const profiled = withProfileHints(base, {
					...profiles,
					coverage: {
						complete: profiles.coverage.complete && base.coverage.omitted === 0,
						omitted: profiles.coverage.omitted + base.coverage.omitted,
					},
				});
				const attention = await projectCatalogAttention(host.harness, attentionSources);
				const attentive = withAttentionHints(profiled, {
					...attention,
					coverage: {
						complete: attention.coverage.complete && base.coverage.omitted === 0,
						omitted: attention.coverage.omitted + base.coverage.omitted,
					},
				});
				const intents = await projectConversationIntents(
					host.harness,
					metadata.storageId,
					projection.rows,
					BACKGROUND_CONTEXT,
				);
				const intended = withIntentClaims(attentive, intents);
				const view = withModelEvidence(intended, projection.modelEvidence);
				if (!writeCatalogView(view, await projectCollaboration(host.harness, BACKGROUND_CONTEXT))) return;
				publishedView = view;
				for (const listener of changeListeners) listener();
			} catch (error) {
				if (force) throw error;
				process.stderr.write(`Catalog view: ${String(error)}\n`);
			}
		})();
		try {
			await publishPromise;
		} finally {
			publishingView = false;
			publishPromise = undefined;
			if (publishAgain) {
				publishAgain = false;
				scheduleCatalogView();
			}
		}
	}

	/** Cancel the coalescing timer, join an in-flight publication, and publish once more. */
	async function flushCatalogView(): Promise<void> {
		flushingView = true;
		try {
			if (publishTimer !== undefined) {
				clearTimeout(publishTimer);
				publishTimer = undefined;
			}
			if (publishPromise !== undefined) await publishPromise.catch(() => undefined);
			publishAgain = false;
			await publishCatalogView(true);
		} finally {
			flushingView = false;
		}
	}

	/** Coalesce native commits into one view publication. */
	function scheduleCatalogView(): void {
		if (closed || flushingView) return;
		if (publishingView) {
			publishAgain = true;
			return;
		}
		if (publishTimer !== undefined) return;
		publishTimer = setTimeout(() => {
			publishTimer = undefined;
			void publishCatalogView();
		}, PUBLISH_COALESCE_MS);
		publishTimer.unref?.();
	}
	async function primaryControl(method: string, params: Record<string, unknown>, sessionId: string): Promise<unknown> {
		if (method === "status" || method === "inspect") {
			const manager = new AgentManager({
				root: dirname(dirname(metadata.storagePath)),
				agentDir: metadata.agentDir,
				packageDir: metadata.packageDir,
			});
			try {
				return await manager.observePrimary(sessionId, method === "status" ? { view: "status" } : params);
			} finally {
				await manager.close();
			}
		}
		assertPrimaryMessage(method, params);
		const channel = await connectPrimaryChannel({
			id: sessionId,
			sessionsRoot: dirname(dirname(metadata.storagePath)),
		});
		try {
			markAdmissionDue();
			// A message names its recipient: if that session ends first, the message waits for it and never
			// reaches another session as an informational copy.
			const report = (await host.request("report", { ...params, ownerId: sessionId, direct: true })) as {
				sourceId: string;
			};
			return {
				sessionId,
				admitted: true,
				sourceId: report.sourceId,
				...(params.expectReply === true ? questionReceipt({ question: String(params.requestId) }, "agent") : {}),
				boundary: "Retained for delivery; does not prove action or task acceptance",
			};
		} finally {
			await channel.close();
		}
	}
	async function attachForeign(
		client: import("./host-client.ts").HostConnection,
		params: Record<string, unknown>,
		sessionId: string,
	): Promise<unknown> {
		if (params.model !== undefined) {
			const outcome = await client.request("configure", params);
			if ((outcome as { outcome?: string })?.outcome === "failed") return outcome;
		}
		return client.request("status", { sessionId });
	}
	async function acquiringForeignControl(
		manager: AgentManager,
		method: string,
		params: Record<string, unknown>,
		sessionId: string,
		context?: Context,
	): Promise<unknown> {
		if (params.expectReply === true) throw new Error(DURABLE_TARGET_QUESTION);
		const client = await manager.connectNative(sessionId);
		if (
			method === "submit" &&
			typeof params.senderIdentity === "string" &&
			(params.replyTo !== undefined || client.runtimeContract.operations["task-submit"])
		)
			return await client.request(
				"task-submit",
				{ ...params, requester: params.senderIdentity },
				{ signal: context?.abortSignal },
			);
		if (method !== "attach") return await client.request(method, params, { signal: context?.abortSignal });
		return attachForeign(client, params, sessionId);
	}
	async function foreignControl(
		method: string,
		params: Record<string, unknown>,
		sessionId: string,
		context?: Context,
	): Promise<unknown> {
		const manager = new AgentManager({
			root: dirname(dirname(metadata.storagePath)),
			agentDir: metadata.agentDir,
			packageDir: metadata.packageDir,
		});
		try {
			let target: HostMetadata;
			try {
				target = manager.nativeTarget(sessionId);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				if (!readPrimaryEndpointDescriptor(dirname(dirname(metadata.storagePath)), sessionId).info)
					throw new Error("The exact native target is not retained and no ordinary primary is registered");
				return await primaryControl(method, params, sessionId);
			}
			refuseThreadStorageTarget(target, method, params);
			if (
				FOREIGN_OBSERVATION_METHODS.has(method) ||
				method === "abort" ||
				method === "release" ||
				method === "interrupt-continue"
			) {
				const caller = {
					id: typeof params.senderIdentity === "string" ? params.senderIdentity : metadata.storageId,
					cwd: metadata.cwd,
				};
				return await manager.control(method, params, caller, { signal: context?.abortSignal });
			}
			return await acquiringForeignControl(manager, method, params, sessionId, context);
		} finally {
			await manager.close();
		}
	}
	async function collaborationObservation(method: string, params: Record<string, unknown>): Promise<unknown> {
		const manager = new AgentManager({
			root: dirname(dirname(metadata.storagePath)),
			agentDir: metadata.agentDir,
			packageDir: metadata.packageDir,
		});
		try {
			return await manager.collaborate(
				{ ...params, action: method === "collaboration-list" ? "list" : "read" },
				{ id: String(params.senderIdentity ?? metadata.storageId), cwd: metadata.cwd },
			);
		} finally {
			await manager.close();
		}
	}
	async function resolveSelectors(
		input: Readonly<Record<string, unknown>>,
		collaboration: boolean,
	): Promise<Record<string, unknown>> {
		const params = { ...input };
		const selectors = ["sessionId", "replyTo", "integrator"] as const;
		if (
			!collaboration &&
			!selectors.some((key) => typeof params[key] === "string" && (params[key] as string).startsWith("@")) &&
			!Array.isArray(params.notify)
		)
			return params;
		const manager = new AgentManager({
			root: dirname(dirname(metadata.storagePath)),
			agentDir: metadata.agentDir,
			packageDir: metadata.packageDir,
		});
		try {
			if (collaboration) return await manager.collaborationTargets(params);
			for (const key of selectors)
				if (typeof params[key] === "string") params[key] = await manager.resolveTarget(params[key] as string);
			if (Array.isArray(params.notify))
				params.notify = await Promise.all(params.notify.map((id) => manager.resolveTarget(String(id))));
		} finally {
			await manager.close();
		}
		return params;
	}
	async function dispatchForeign(
		method: string,
		params: Record<string, unknown>,
		sessionId: string,
		context?: Context,
	): Promise<unknown> {
		if (runtimeUnavailable() || reloading) throw new Error("Durable host is closed or reloading");
		const observation = FOREIGN_OBSERVATION_METHODS.has(method);
		const stopping = method === "abort" || method === "release" || method === "interrupt-continue";
		if (observation || stopping) context?.abortSignal?.throwIfAborted();
		activeRequests++;
		activityGeneration++;
		if (ADMITTING_METHODS.has(method)) {
			activeAdmissions++;
			cancelRequestedRelease();
		}
		// Activity owns the full read and manager disposal, even after its caller stops waiting.
		const work = Promise.resolve()
			.then(() => foreignControl(method, params, sessionId, context))
			.finally(() => {
				if (ADMITTING_METHODS.has(method)) activeAdmissions--;
				activeRequests--;
				scheduleRecoveryMarker();
				notifyActivity();
			});
		return observation || stopping ? awaitWithContext(work, context ?? BACKGROUND_CONTEXT) : work;
	}
	const readStoragePage = async (params: Record<string, unknown>, context: Context): Promise<unknown> => {
		const input = storageStatusPageInput(params);
		if (input.storageId === metadata.storageId)
			return request("status", { ...input }, controlRequestId(params), context.abortSignal);
		const manager = new AgentManager({
			root: dirname(dirname(metadata.storagePath)),
			agentDir: metadata.agentDir,
			packageDir: metadata.packageDir,
		});
		try {
			return await manager.status(input);
		} finally {
			await manager.close();
		}
	};
	const dispatchResolved = async (
		method: Parameters<AgentControlDispatch>[0],
		params: Record<string, unknown>,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<unknown> => {
		if (typeof params.replyTo === "string") refuseThreadStorageRecipient("replyTo", params.replyTo);
		if (method === "report")
			return request("report", { ...params, ownerId: params.sessionId }, controlRequestId(params));
		if (method === "collaboration-mutate" && typeof params.threadId === "string")
			params.sessionId = collaborationStorage(params.threadId);
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : metadata.storageId;
		if (storageIdOf(sessionId) !== metadata.storageId) return dispatchForeign(method, params, sessionId, context);
		if (method !== "abort" && method !== "release")
			return request(method, params, controlRequestId(params), context.abortSignal);
		context.abortSignal?.throwIfAborted();
		return awaitWithContext(request(method, params, controlRequestId(params)), context);
	};
	const dispatch: AgentControlDispatch = async (method, input, context = BACKGROUND_CONTEXT) => {
		if (method === "resolve-target") {
			const manager = new AgentManager({
				root: dirname(dirname(metadata.storagePath)),
				agentDir: metadata.agentDir,
				packageDir: metadata.packageDir,
			});
			try {
				return await manager.resolveTarget(String(input.sessionId), context.abortSignal);
			} finally {
				await manager.close();
			}
		}
		if (method === "status" && input.view === "storage-page") return readStoragePage(input, context);
		if (method === "collaboration-list" || method === "collaboration-read")
			return collaborationObservation(method, input);
		const params = await resolveSelectors(input, method === "collaboration-mutate");
		return dispatchResolved(method, params, context);
	};
	const restoreDispatch = publishAgentControlDispatch(dispatch);
	/** Agent choices for the opened Harness; a missing retained model keeps its stored level for attach repair. */
	function hostAgent(): {
		readonly model: HostMetadata["model"];
		readonly thinkingLevel: ModelThinkingLevel;
		readonly cwd: string;
		readonly instructions?: string;
	} {
		const selectedModel = services.services.modelRuntime.getModel(metadata.model.provider, metadata.model.modelId);
		return {
			model: metadata.model,
			thinkingLevel: selectedModel
				? clampThinkingLevel(selectedModel, metadata.thinkingLevel as ModelThinkingLevel)
				: (metadata.thinkingLevel as ModelThinkingLevel),
			cwd: metadata.cwd,
		};
	}

	/** Open the Harness without scheduling, install every contribution, then start scheduling. */
	const openHost = async (): Promise<DurableHost> => {
		const opened = await DurableHost.open({
			storagePath: metadata.storagePath,
			storageId: metadata.storageId,
			cwd: metadata.cwd,
			models: services.services.modelRuntime,
			registry: services.registry,
			settings: services.settings,
			env: services.env,
			providerIdleMs: readSettings({ agentDir: metadata.agentDir }).values.providerProgressIdleMs,
			deferredRequestMs:
				services.services.settingsManager.getProviderRetrySettings().timeoutMs ??
				services.services.settingsManager.getHttpIdleTimeoutMs(),
			retryMaxAttempts: services.services.settingsManager.getRetrySettings().enabled
				? services.services.settingsManager.getRetrySettings().maxRetries + 1
				: 1,
			agent: hostAgent(),
			meta: { name: metadata.name, owner: metadata.ownerId },
			profileSeed: catalog.read(metadata.storageId).view?.profileSeed,
			commands: services.commands,
			contributionHost: services.contributionHost,
			resume: false,
			...(threadStorageOwner === undefined ? {} : { threadStorageOwner }),
			onReport: (report) => {
				process.stderr.write(`Durable task: ${report.kind}: ${String(report.error)}\n`);
			},
			planningBudget: (provider, modelId) =>
				readAgentPreferences(metadata.agentDir).document?.preferences?.contextBudgetTokens?.[`${provider}/${modelId}`],
			requestRelease: () => requestRelease(),
		});
		const install = async (setup: Harness): Promise<void> => {
			await services.install(setup);
			host = opened;
			opened.setForeignStop(async (references, context) => {
				const manager = new AgentManager({
					root: dirname(dirname(metadata.storagePath)),
					agentDir: metadata.agentDir,
					packageDir: metadata.packageDir,
				});
				const caller = { id: metadata.storageId, cwd: metadata.cwd };
				try {
					return await stopForeignReferences(
						(method, input) => manager.control(method, input, caller, { signal: context.abortSignal }),
						references,
						context,
					);
				} finally {
					await manager.close();
				}
			});
			// Effort notes are request-scoped agent context, not task input: they enter after every
			// contribution's hooks, beside the route and continuity notes.
			services.registry.install({
				name: "agent.effort-notes",
				hooks: [hook(GenerationTask, effortNoteRequestHooks(metadata.storageId))],
			});
			const requestRoutes = new RequestRouteState();
			services.registry.install({
				name: "agent.request-context",
				sections: [requestContextSection(opened.harness)],
				hooks: [hook(GenerationTask, requestContextHooks(opened.harness, requestRoutes))],
			});
			// Thread ranges settle first; the continuity note is the last change and reads memory only.
			services.registry.install({
				name: "agent.continuity",
				hooks: [hook(GenerationTask, opened.threadNoticeHooks()), hook(GenerationTask, opened.continuityHooks())],
			});
			unsubscribeClose?.();
			unsubscribeClose = opened.harness.subscribeClose(() => {
				activityGeneration++;
				queueMicrotask(notifyActivity);
			});
			void opened.harness.closed.then((end) => {
				if (end.kind !== "failed" || host !== opened || closed) return;
				sessionFailed = true;
				try {
					markRecoveryDue(true);
				} catch (error) {
					process.stderr.write(`Recovery marker: ${String(error)}\n`);
				}
				activityGeneration++;
				notifyActivity();
			});
			unsubscribeObservation?.();
			unsubscribeObservation = opened.onObservationChange(() => {
				for (const listener of observationListeners) listener();
			});
			unsubscribeChanges?.();
			unsubscribeChanges = onStoredCommit(opened.harness, (publication) => {
				requestRoutes.observe(publication);
				activityGeneration++;
				if (publication.changes.length) {
					scheduleRecoveryMarker();
					notifyActivity();
					scheduleCatalogView();
				}
			});
			await settleRecoveryMarker();
		};
		try {
			await opened.resume(BACKGROUND_CONTEXT, install);
			scheduleCatalogView();
			return opened;
		} catch (error) {
			try {
				await services.close();
			} catch {
				/* Retain the open failure. */
			}
			try {
				await opened.close();
			} catch {
				/* Retain the open failure. */
			}
			throw error;
		}
	};
	try {
		host = await openHost();
	} catch (error) {
		restoreDispatch();
		controller.abort();
		await services.close().catch(() => {});
		throw error;
	}
	const delivery = () => {
		const sessionsRoot = dirname(dirname(metadata.storagePath));
		const targets = new AgentManager({
			root: sessionsRoot,
			agentDir: metadata.agentDir,
			packageDir: metadata.packageDir,
		});
		const readDeliveryTarget = (identity: string) => {
			try {
				return targets.nativeTarget(identity);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return undefined;
			}
		};
		return startDurableDelivery({
			host,
			metadata,
			catalog,
			sessionsRoot,
			signal: controller.signal,
			unavailableTargets: unavailableDeliveryTargets,
			retriesProviderErrors: () => {
				const retry = services.services.settingsManager.getRetrySettings();
				return retry.enabled && retry.maxRetries > 0;
			},
			onIdle: () => {
				scheduleRecoveryMarker();
				for (const listener of quiescentListeners) listener();
			},
			readTarget: readDeliveryTarget,
			connectTarget: (record) => targets.connectNative(record.storageId),
			onClose: () => targets.close(),
			onError: (error) => {
				process.stderr.write(`Agent delivery: ${error.message}\n`);
			},
		});
	};
	deliveries = delivery();
	recoveryReady = true;
	scheduleRecoveryMarker();

	async function configure(params: Record<string, unknown>, requestId: string): Promise<ExecutionSelection> {
		const conversation = await host.conversation(typeof params.sessionId === "string" ? params.sessionId : undefined);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const input = {
			...(params as ExecutionFields & { preset?: string }),
			...(typeof params.model === "object" && params.model !== null
				? {
						model: `${(params.model as { provider: string }).provider}/${(params.model as { modelId: string }).modelId}`,
					}
				: {}),
		};
		const inputKey = createHash("sha256")
			.update(JSON.stringify([input.preset, input.model, input.thinkingLevel, params.name]))
			.digest("hex");
		const selection = await host.harness.commit(async (tx) => {
			const state = await tx.doc(
				ExecutionSelectionDoc,
				conversation.id,
				createHash("sha256").update(requestId).digest("hex"),
				null,
			);
			if (state.selection) {
				if (state.input !== inputKey) throw new Error("Configuration request ID belongs to different inputs");
				return JSON.parse(JSON.stringify(state.selection)) as ExecutionSelection;
			}
			const snapshot =
				params.preferenceSnapshot === undefined
					? readAgentPreferences(metadata.agentDir, services.services.modelRuntime)
					: parsePreferenceSnapshot(params.preferenceSnapshot);
			const selected = resolveExecutionPreset(snapshot, input, {
				model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : undefined,
				thinkingLevel: agent.thinkingLevel,
			});
			state.input = inputKey;
			state.selection = selected;
			return selected;
		}, BACKGROUND_CONTEXT);
		for (const field of ["model", "thinkingLevel"] as const) {
			if (selection.origins[field] === "explicit" || selection.origins[field] === "preset")
				params[field] = selection.values[field];
		}
		params.model = configuredModel(params.model);
		return selection;
	}
	async function runCommand(params: Record<string, unknown>): Promise<unknown> {
		if (params.name === "tree") {
			if (typeof params.args !== "string" || !/^\d+$/u.test(params.args.trim()))
				throw new Error("tree requires one native entry ID");
			return host.request("fork", {
				sessionId: params.sessionId,
				entryId: params.args.trim(),
				ownerId: params.ownerId,
			});
		}
		if (params.name !== "reload") return host.request("command", params);
		if (!host.isIdle())
			throw new Error("Reload requires an idle storage; it cannot replace another conversation's active tasks");
		if (host.observationCount > 0)
			throw new Error("Reload requires closed live observations; release every observer before reload");
		await services.reloadResources();
		try {
			await deliveries.close();
			unsubscribeChanges?.();
			unsubscribeChanges = undefined;
			unsubscribeObservation?.();
			unsubscribeObservation = undefined;
			await flushCatalogView();
			await settleRecoveryMarker();
			// Only this host has an expected close; a replacement still needs failure supervision.
			reloadClosingHost = host;
			unsubscribeClose?.();
			unsubscribeClose = undefined;
			await services.close();
			await host.close();
			services = await bootstrap(metadata, controller, true, options);
			host = await openHost();
			reloadClosingHost = undefined;
			deliveries = delivery();
		} catch (error) {
			// Teardown has started; only a fresh process can own a usable runtime.
			reloadFailed = true;
			throw error;
		}
		return { sessionId: params.sessionId ?? metadata.storageId, inventory: services.inventory, reloaded: true };
	}
	function beginRequest(method: string, counted: boolean): void {
		if (counted) activeRequests++;
		if (ADMITTING_METHODS.has(method)) {
			activeAdmissions++;
			cancelRequestedRelease();
		}
	}

	function finishRequest(method: string, counted: boolean, reload: boolean): void {
		if (counted) activeRequests--;
		if (ADMITTING_METHODS.has(method)) activeAdmissions--;
		if (reload) reloading = false;
		scheduleRecoveryMarker();
		notifyActivity();
	}

	async function request(method: string, input: unknown, requestId: string, signal?: AbortSignal): Promise<unknown> {
		if (runtimeUnavailable()) throw new Error("Durable host is closed");
		if (reloading) throw new Error("Durable host reload is in progress; retry the control after reload");
		if (threadStorageOwner !== undefined && !threadStorageServes(method, (input ?? undefined) as { model?: unknown }))
			throw new Error(threadStorageRefusal(metadata.storageId, threadStorageOwner));
		const reload = method === "command" && (input as { name?: unknown } | undefined)?.name === "reload";
		if (reload && activeRequests > 0) throw new Error("Reload requires all other controls to settle");
		const counted = method !== "receipts";
		activityGeneration++;
		beginRequest(method, counted);
		reloading = reload;
		try {
			return await requestScope.run(method, () => executeRequest(method, input, requestId, signal));
		} finally {
			finishRequest(method, counted, reload);
		}
	}
	async function spawn(
		params: Record<string, unknown>,
		requestId: string,
		method: "spawn" | "place" = "spawn",
	): Promise<unknown> {
		if (typeof params.senderIdentity !== "string") throw new Error("A native spawn requires its sender identity");
		const conversation = await host.conversation(params.senderIdentity);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const key = createHash("sha256")
			.update(JSON.stringify([method, requestId]))
			.digest("hex");
		const inputKey = createHash("sha256")
			.update(
				JSON.stringify([
					params.handle,
					params.area,
					params.cwd,
					params.name,
					params.topic,
					params.prompt,
					params.preset,
					params.model,
					params.thinkingLevel,
					params.role,
					params.checkInMinutes,
				]),
			)
			.digest("hex");
		const retained = await host.harness.snapshot(ExecutionSelectionDoc, conversation.id, key, BACKGROUND_CONTEXT);
		if (retained?.input !== undefined && retained.input !== inputKey)
			throw new Error("Creation request ID belongs to different inputs");
		const selection = retained?.selection;
		const retainExecutionSelection = async (selected: ExecutionSelection): Promise<void> => {
			await host.harness.commit(async (tx) => {
				const state = await tx.doc(ExecutionSelectionDoc, conversation.id, key, null);
				if (state.selection !== undefined) {
					if (state.input !== inputKey || JSON.stringify(state.selection) !== JSON.stringify(selected))
						throw new Error("Creation request already retains a different execution selection");
					return;
				}
				state.input = inputKey;
				state.selection = selected;
			}, BACKGROUND_CONTEXT);
		};
		const manager = new AgentManager({
			root: dirname(dirname(metadata.storagePath)),
			agentDir: metadata.agentDir,
			packageDir: metadata.packageDir,
			validateModel: (model, level) => validateModel(services, model, level),
		});
		try {
			const caller = {
				id: params.senderIdentity,
				cwd: metadata.cwd,
				model: agent.model,
				thinkingLevel: agent.thinkingLevel,
				preferenceCatalog: services.services.modelRuntime,
				retainExecutionSelection,
			};
			return method === "place"
				? await manager.place({ ...params, requestId, selection }, caller)
				: await manager.spawn({ ...params, requestId, selection }, caller);
		} finally {
			await manager.close();
		}
	}
	async function discover(params: Record<string, unknown>, profiles = false): Promise<unknown> {
		const manager = new AgentManager({
			root: dirname(dirname(metadata.storagePath)),
			agentDir: metadata.agentDir,
			packageDir: metadata.packageDir,
		});
		try {
			const result = (await manager.list(params)) as {
				rows: Record<string, unknown>[];
				coverage: Record<string, unknown>;
			};
			if (profiles) return result;
			const { profileHints: _hints, ...coverage } = result.coverage;
			const rows = result.rows.map(
				({ handle: _handle, role: _role, profile: _profile, profileCoverage: _coverage, ...row }) => row,
			);
			return { ...result, rows, coverage };
		} finally {
			await manager.close();
		}
	}
	async function attach(params: Record<string, unknown>): Promise<unknown> {
		if (params.model !== undefined) {
			params.model = configuredModel(params.model);
			const outcome = await host.request("configure", params);
			if ((outcome as { outcome?: string })?.outcome === "failed") return outcome;
		}
		return host.request("status", { sessionId: params.sessionId });
	}
	async function configureRequest(params: Record<string, unknown>, requestId: string): Promise<unknown> {
		const selection = await configure(params, typeof params.requestId === "string" ? params.requestId : requestId);
		const outcome = (await host.request("configure", params)) as {
			after?: { thinkingLevel?: string };
			[key: string]: unknown;
		};
		return { ...outcome, selection: effectiveExecutionSelection(selection, outcome.after?.thinkingLevel) };
	}
	async function executeRequest(
		method: string,
		input: unknown,
		requestId: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		const params = controlParams(input);
		const recipient = controlRecipient(method, params);
		if (recipient !== undefined) {
			validateDeliveryRecipient(recipient);
			refuseThreadStorageRecipient("recipient", recipient);
		}
		if (method === "recovery-state") {
			return recoveryState(true);
		}
		if (ADMITTING_METHODS.has(method)) markAdmissionDue();
		switch (method) {
			case "spawn":
			case "resolve-agent":
				return spawn(params, requestId);
			case "place":
				return spawn(params, requestId, "place");
			case "list":
				return params.global === true ? discover(params) : host.request(method, params);
			case "profile-list":
				return discover(params, true);
			case "attach":
				return attach(params);
			case "configure":
				return configureRequest(params, requestId);
			case "command":
				params.invocationId ??= requestId;
				return runCommand(params);
			case "models":
				return modelChoices(services);
			case "status":
				return {
					...((await host.request(method, params)) as Record<string, unknown>),
					inventory: services.inventory,
					pid: process.pid,
					storageId: metadata.storageId,
				};
			case "receipts":
				return host.request(method, params, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
			case "task-submit":
			case "profile-update":
			case "submit":
			case "rewind":
			case "report":
				params.requestId ??= requestId;
				break;
		}
		return host.request(method, params);
	}
	async function closeIdleRuntime(): Promise<void> {
		try {
			await flushCatalogView();
			await settleRecoveryMarker();
		} finally {
			changeListeners.clear();
			try {
				await deliveries.close();
			} finally {
				try {
					await services.close();
				} finally {
					await host.close();
				}
			}
		}
	}
	async function requiredExit(): Promise<"process-exit" | "failed-process-exit" | undefined> {
		if (reloadFailed || sessionFailed || host.sessionEnded) return "failed-process-exit";
		return (await host.refreshIdle()) ? undefined : "process-exit";
	}
	const closeHost = async (): Promise<"process-exit" | "failed-process-exit" | undefined> => {
		if (closed) return;
		closed = true;
		const processExit = await requiredExit();
		restoreDispatch();
		activityListeners.clear();
		quiescentListeners.clear();
		controller.abort();
		await recoverySync;
		releaseListeners.clear();
		if (publishTimer !== undefined) {
			clearTimeout(publishTimer);
			publishTimer = undefined;
		}
		unsubscribeChanges?.();
		unsubscribeObservation?.();
		observationListeners.clear();
		unsubscribeClose?.();
		if (processExit) {
			markRecoveryDue(true);
			try {
				await flushCatalogView();
			} catch (error) {
				process.stderr.write(`Catalog view: ${String(error)}\n`);
			}
			changeListeners.clear();
			// Native close seals admission synchronously, but joins even noncooperative task code.
			// Process death ends those invocations without manufacturing a durable task outcome.
			void host.close().catch((error: unknown) => process.stderr.write(`Native close: ${String(error)}\n`));
			try {
				try {
					await deliveries.close();
				} finally {
					await services.close();
				}
			} catch (error) {
				process.stderr.write(`Service close: ${String(error)}\n`);
			}
			return processExit;
		}
		await closeIdleRuntime();
		return undefined;
	};
	return {
		request,
		requestRelease,
		get publishedView() {
			return publishedView;
		},
		get releaseRequested() {
			return releaseRequested;
		},
		onReleaseRequested: (listener) => {
			releaseListeners.add(listener);
			return () => {
				releaseListeners.delete(listener);
			};
		},
		onQuiescent: (listener) => {
			quiescentListeners.add(listener);
			return () => {
				quiescentListeners.delete(listener);
			};
		},
		get shutdownRequired() {
			return reloadFailed || sessionFailed || (host.sessionEnded && host !== reloadClosingHost);
		},
		isIdle: () => !runtimeUnavailable() && !reloading && activeRequests === 0 && host.isIdle(),
		tryRetire,
		onActivity: (listener) => {
			activityListeners.add(listener);
			return () => {
				activityListeners.delete(listener);
			};
		},
		onChange: (listener) => {
			changeListeners.add(listener);
			return () => {
				changeListeners.delete(listener);
			};
		},
		onObservationChange: (listener) => {
			observationListeners.add(listener);
			return () => {
				observationListeners.delete(listener);
			};
		},
		close: closeHost,
	};
}
