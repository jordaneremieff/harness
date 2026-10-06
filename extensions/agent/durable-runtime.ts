import { createHash, randomUUID } from "node:crypto";
import { readAgentPreferences, resolveExecutionPreset, effectiveExecutionSelection, parsePreferenceSnapshot, type ExecutionSelection, type ExecutionFields } from "./agent-preferences.ts";
import { defineDocFamily } from "@earendil-works/pi-durable";

const ExecutionSelectionDoc = defineDocFamily<{ input?: string; selection?: ExecutionSelection }, null>({ kind: "agent.execution-selection", family: true, version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}) });
import { launchIndependentCommand } from "./independent-launch.ts";

function controlRequestId(params: Readonly<Record<string, unknown>>): string { return typeof params.requestId === "string" ? params.requestId : randomUUID(); }
async function nativeResult(host: DurableHost, reference: ResultReference, context: Context): Promise<unknown> {
	const submission = await host.harness.submission(reference.submissionId as SubmissionId, context);
	if (submission === undefined) throw new Error("The native input is not retained");
	const status = await submission.status(context);
	if (status.type !== "input" || host.identity(status.conversationId) !== reference.sessionId || (reference.requestId !== undefined && reference.requestId !== status.requestId)) throw new Error("The exact native result does not identify this conversation's admitted input");
	return host.wait(submission.id, context);
}
import type { Context } from "@earendil-works/chord";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { ResultReference } from "./result-reference.ts";
import type { ProducerAwaitFact } from "./await-facts.ts";
import { observeProducerAwait } from "./await-producer-observer.ts";
import { projectCollaboration, collaborationStorage } from "./collaboration.ts";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { dirname } from "node:path";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentCatalog, hostMetadata, storageIdOf, type CatalogRecord } from "./catalog.ts";
import { boundCatalogView, withModelEvidence } from "./catalog-view.ts";
import { observeColdStorage } from "./cold-observation.ts";
import { acquireHost } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";
import type { HostRuntime } from "./host-process.ts";
import { DurableHost } from "./durable-host.ts";
import { createDurableServices, type DurableServices, type CreateDurableServicesOptions } from "./durable-services.ts";
import { publishAgentControlDispatch, type AgentControlDispatch } from "./durable-agents.ts";
import { AgentDeliveryDoc } from "./durable-controls.ts";
import { isThinkingLevel } from "./configuration.ts";
import { AgentManager } from "./manager.ts";
import { deliveryOwnerIsDead, startDurableDelivery } from "./durable-delivery.ts";
import { connectPrimaryChannel } from "./primary-channel.ts";

function controlParams(input: unknown): Record<string, unknown> {
	if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) throw new Error("Control parameters must be an object");
	return { ...(input as Record<string, unknown> | undefined) };
}

/** Methods that admit work or delivery into this storage. */
import { projectProfiles } from "./profile.ts";
import { requestContextSection } from "./request-context.ts";
import { withProfileHints } from "./catalog-view.ts";
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";

const ADMITTING_METHODS: ReadonlySet<string> = new Set(["task-submit", "profile-update", "resolve-agent", "submit", "report", "rewind", "command", "compact", "spawn", "place", "reset", "timer-schedule", "collaboration-mutate", "passive-submit"]);
/** Coalesce a burst of native commits into one catalog view publication. */
const PUBLISH_COALESCE_MS = 250;

async function bootstrap(metadata: HostMetadata, controller: AbortController, execution: boolean, options: Pick<CreateDurableServicesOptions, "modelRuntime"> = {}): Promise<DurableServices> {
	const independent = metadata.independent;
	return createDurableServices({ ...options, cwd: metadata.cwd, agentDir: metadata.agentDir, storageId: metadata.storageId, catalogRoot: dirname(metadata.storagePath),
		packageDir: metadata.packageDir, trusted: metadata.trust, signal: controller.signal,
		...(independent === undefined ? {} : { resolveProjectTrust: async () => independent.projectTrusted }),
		launchIndependent: (input) => launchIndependentCommand(input, {
			root: dirname(dirname(metadata.storagePath)), agentDir: metadata.agentDir, packageDir: metadata.packageDir,
		}),
		askPrimary: async (cwd) => {
			const root = dirname(dirname(metadata.storagePath));
			const catalog = new AgentCatalog(root);
			let ownerId = metadata.ownerId;
			for (let depth = 0; ownerId !== undefined && depth < 32; depth++) {
				const target = ownerId;
				try { ownerId = catalog.read(target).ownerId; }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					const channel = await connectPrimaryChannel({ id: target, sessionsRoot: root });
					try { return await channel.trustPrompt(cwd, controller.signal); } finally { await channel.close(); }
				}
			}
			return undefined;
		},
		onReport: (error) => { process.stderr.write(`Durable host: ${String(error)}\n`); },
		...(execution ? { buildBuiltin: async (host) => { const { createDurableExecution } = await import("./durable-execution.ts"); return createDurableExecution(host); } } : {}),
	});
}
function configuredModel(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const split = value.indexOf("/");
	if (split < 1 || split === value.length - 1) throw new Error("Model requires an exact provider/model identity");
	return { provider: value.slice(0, split), modelId: value.slice(split + 1) };
}

function validateModel(services: DurableServices, model: { provider: string; modelId: string }, level: string): ModelThinkingLevel {
	const selected = services.services.modelRuntime.getModel(model.provider, model.modelId);
	if (!selected) throw new Error(`Model is not in the configured catalog: ${model.provider}/${model.modelId}`);
	if (!isThinkingLevel(level)) throw new Error("Unknown reasoning level");
	return clampThinkingLevel(selected, level);
}

/** Constructed only after the process claims the storage writer. */
export async function createDurableRuntime(metadata: HostMetadata, options: Pick<CreateDurableServicesOptions, "modelRuntime"> = {}): Promise<HostRuntime> {
	const controller = new AbortController();
	let services = await bootstrap(metadata, controller, true, options);
	let host: DurableHost;
	let closed = false;
	let reloading = false;
	let reloadFailed = false;
	let activeRequests = 0;
	let activityGeneration = 0;
	let retirementSealed = false;
	const changeListeners = new Set<() => void>();
	const activityListeners = new Set<() => void>();
	function notifyActivity(): void { for (const listener of activityListeners) listener(); }
	let unsubscribeChanges: (() => void) | undefined;
	const catalog = new AgentCatalog(dirname(dirname(metadata.storagePath)));
	let publishTimer: ReturnType<typeof setTimeout> | undefined;
	let publishPromise: Promise<void> | undefined;
	let publishingView = false;
	let flushingView = false;
	let publishAgain = false;

	function runtimeUnavailable(): boolean { return closed || reloadFailed || retirementSealed; }

	/** Check committed work and delivery under one unchanged admission generation. */
	async function tryRetire(seal: () => boolean): Promise<boolean> {
		if (runtimeUnavailable() || reloading || activeRequests > 0 || deliveries.busy) return false;
		const generation = activityGeneration;
		const state = await recoveryState();
		if (state.workPending || state.deliveriesActive || !host.isIdle() || generation !== activityGeneration
			|| runtimeUnavailable() || reloading || activeRequests > 0 || deliveries.busy || !seal()) return false;
		deliveries.sealAdmission();
		retirementSealed = true;
		return true;
	}

	/** Write the recovery marker; a failed write blocks the admitting request. */
	function markRecoveryDue(due: boolean): void {
		catalog.markRecoveryDue(metadata.storageId, due);
	}

	/** Pending delivery rows: unsettled intents, unacknowledged receipts, and unacknowledged reports. */
	async function deliveriesPending(): Promise<boolean> {
		const state = await host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
		if (state === undefined) return false;
		if (state.intents.some((intent) => intent.submissionId === null || state.receipts[String(intent.submissionId)] === undefined)) return true;
		if (Object.values(state.receipts).some((receipt) => !receipt.acknowledged)) return true;
		return state.reports.some((report) => !report.acknowledged);
	}

	/** Native work plus pending delivery state used by the marker and transient monitors. */
	async function recoveryState(): Promise<{ readonly workPending: boolean; readonly deliveriesPending: boolean; readonly deliveriesActive: boolean }> {
		const idle = await host.refreshIdle();
		const state = await host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
		const sessionsRoot = dirname(dirname(metadata.storagePath));
		const active = (owner: string) => !deliveryOwnerIsDead(catalog, sessionsRoot, owner);
		const deliveriesActive = state !== undefined && (
			state.intents.some((intent) => intent.submissionId === null || state.receipts[String(intent.submissionId)] === undefined)
			|| Object.values(state.receipts).some((receipt) => !receipt.acknowledged && active(receipt.ownerId))
			|| state.reports.some((report) => !report.acknowledged && active(report.ownerId)));
		return { workPending: !idle, deliveriesPending: await deliveriesPending(), deliveriesActive };
	}

	/** Clear the marker only when the storage closes with no work and no pending delivery. */
	async function settleRecoveryMarker(): Promise<void> {
		const state = await recoveryState();
		if (!state.workPending && !state.deliveriesPending) markRecoveryDue(false);
	}

	/** Build and publish one bounded catalog view; `force` publishes during shutdown. */
	async function publishCatalogView(force = false): Promise<void> {
		if (closed && !force) return;
		publishingView = true;
		publishPromise = (async () => {
			try {
				const projection = await host.catalogProjection();
				const base = boundCatalogView({ updatedAt: projection.updatedAt, rows: projection.rows, storageId: metadata.storageId });
				const ids = base.rows.map((row) => row.id === metadata.storageId ? ROOT_CONVERSATION_ID : Number(row.id.split(":")[1]) as ConversationId);
				const profiles = await projectProfiles(host.harness, metadata.storageId, ids);
				const profiled = withProfileHints(base, { ...profiles, coverage: { complete: profiles.coverage.complete && base.coverage.omitted === 0, omitted: profiles.coverage.omitted + base.coverage.omitted } });
				const view = withModelEvidence(profiled, projection.modelEvidence);
				catalog.updateView(metadata.storageId, view, await projectCollaboration(host.harness, BACKGROUND_CONTEXT));
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
		} finally { flushingView = false; }
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
			const manager = new AgentManager({ root: dirname(dirname(metadata.storagePath)), agentDir: metadata.agentDir, packageDir: metadata.packageDir });
			try { return await manager.observePrimary(sessionId, method === "status" ? { view: "status" } : params); }
			finally { await manager.close(); }
		}
		const channel = await connectPrimaryChannel({ id: sessionId, sessionsRoot: dirname(dirname(metadata.storagePath)) });
		try {
			if (method !== "submit") throw new Error("A registered primary accepts messages, not Durable session controls");
			markRecoveryDue(true);
			const report = await host.request("report", { ...params, ownerId: sessionId }) as { sourceId: string };
			return { sessionId, admitted: true, sourceId: report.sourceId, boundary: "Retained for delivery; does not prove action or task acceptance" };
		} finally { await channel.close(); }
	}
	async function attachForeign(client: import("./host-client.ts").HostConnection, params: Record<string, unknown>, sessionId: string): Promise<unknown> {
		if (params.model !== undefined) {
			const outcome = await client.request("configure", params);
			if ((outcome as { outcome?: string })?.outcome === "failed") return outcome;
		}
		return client.request("status", { sessionId });
	}
	async function foreignControl(method: string, params: Record<string, unknown>, sessionId: string, context?: Context): Promise<unknown> {
		let record: CatalogRecord;
		try { record = catalog.read(sessionId); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return primaryControl(method, params, sessionId);
		}
		const client = await acquireHost(hostMetadata(record, metadata.packageDir));
		try {
			if (method === "submit" && typeof params.senderIdentity === "string" && (params.replyTo !== undefined || client.runtimeContract.operations["task-submit"])) return await client.request("task-submit", { ...params, requester: params.senderIdentity });
			if (method !== "attach") return await client.request(method, params, { signal: context?.abortSignal });
			return await attachForeign(client, params, sessionId);
		} finally { await client.close(); }
	}
	async function collaborationObservation(method: string, params: Record<string, unknown>): Promise<unknown> {
		const manager = new AgentManager({ root: dirname(dirname(metadata.storagePath)), agentDir: metadata.agentDir, packageDir: metadata.packageDir });
		try { return await manager.collaborate({ ...params, action: method === "collaboration-list" ? "list" : "read" }, { id: String(params.senderIdentity ?? metadata.storageId), cwd: metadata.cwd }); } finally { await manager.close(); }
	}
	async function resolveSelectors(input: Readonly<Record<string, unknown>>, collaboration: boolean): Promise<Record<string, unknown>> {
		const params = { ...input };
		const selectors = ["sessionId", "replyTo", "integrator"] as const;
		if (!collaboration && !selectors.some((key) => typeof params[key] === "string" && (params[key] as string).startsWith("@")) && !Array.isArray(params.notify)) return params;
		const manager = new AgentManager({ root: dirname(dirname(metadata.storagePath)), agentDir: metadata.agentDir, packageDir: metadata.packageDir });
		try {
			if (collaboration) return await manager.collaborationTargets(params);
			for (const key of selectors) if (typeof params[key] === "string") params[key] = await manager.resolveTarget(params[key] as string);
			if (Array.isArray(params.notify)) params.notify = await Promise.all(params.notify.map((id) => manager.resolveTarget(String(id))));
		} finally { await manager.close(); }
		return params;
	}
	async function dispatchForeign(method: string, params: Record<string, unknown>, sessionId: string, context?: Context): Promise<unknown> {
		if (runtimeUnavailable() || reloading) throw new Error("Durable host is closed or reloading");
		activeRequests++;
		activityGeneration++;
		try { return await foreignControl(method, params, sessionId, context); }
		finally { activeRequests--; notifyActivity(); }
	}
	async function observeAwaitProducer(params: Record<string, unknown>, context: Context): Promise<unknown> {
		const sessionId = String(params.sessionId);
		if (typeof params.publish !== "function") throw new Error("Producer observation requires an in-process callback");
		const publish = params.publish as (fact: ProducerAwaitFact) => Promise<void>;
		if (storageIdOf(sessionId) === metadata.storageId) return observeProducerAwait(sessionId, async () => await host.request("await-state", { sessionId, results: params.results }, context) as import("./await-facts.ts").ProducerState, async (changed) => host.harness.subscribeCommits((publication) => { if (publication.changes.length) changed(); }), publish, context);
		const record = catalog.read(sessionId);
		const client = await acquireHost(hostMetadata(record, metadata.packageDir));
		try {
			const subscribe = client.subscribeChanges?.bind(client);
			if (subscribe === undefined) throw new Error("Producer host has no commit observation capability");
			return await observeProducerAwait(sessionId, async () => await client.request("await-state", { sessionId, results: params.results }, { signal: context.abortSignal }) as import("./await-facts.ts").ProducerState, (changed) => subscribe(changed, context.abortSignal), publish, context, client.onClose.bind(client));
		} finally { await client.close(); }
	}
	const dispatch: AgentControlDispatch = async (method, input, context = BACKGROUND_CONTEXT) => {
		const params = await resolveSelectors(input, method.startsWith("collaboration-"));
		if (method === "await-native") return nativeResult(host, params.result as ResultReference, context);
		if (method === "observe-producer-await") return observeAwaitProducer(params, context);
		if (method === "report") return request("report", { ...params, ownerId: params.sessionId }, controlRequestId(params));
		if (["collaboration-list", "collaboration-read"].includes(method)) return collaborationObservation(method, params);
		if (typeof params.threadId === "string") params.sessionId = collaborationStorage(params.threadId);
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : metadata.storageId;
		if (storageIdOf(sessionId) !== metadata.storageId) return dispatchForeign(method, params, sessionId, context);
		return request(method, params, controlRequestId(params), context.abortSignal);
	};
	const restoreDispatch = publishAgentControlDispatch(dispatch);
	/** Mark recovery due before scheduling when committed work or delivery is pending. */
	async function markPendingRecovery(): Promise<void> {
		const pending = await recoveryState();
		if (pending.workPending || pending.deliveriesPending) markRecoveryDue(true);
	}

	/** Agent choices for the opened Harness; a missing retained model keeps its stored level for attach repair. */
	function hostAgent(): { readonly model: HostMetadata["model"]; readonly thinkingLevel: ModelThinkingLevel; readonly cwd: string; readonly instructions?: string } {
		const selectedModel = services.services.modelRuntime.getModel(metadata.model.provider, metadata.model.modelId);
		return {
			model: metadata.model,
			thinkingLevel: selectedModel ? clampThinkingLevel(selectedModel, metadata.thinkingLevel as ModelThinkingLevel) : metadata.thinkingLevel as ModelThinkingLevel,
			cwd: metadata.cwd,
		};
	}

	/** Open the Harness without scheduling, install every contribution, then start scheduling. */
	const openHost = async (): Promise<DurableHost> => {
		const opened = await DurableHost.open({ storagePath: metadata.storagePath, storageId: metadata.storageId, cwd: metadata.cwd,
			models: services.services.modelRuntime, registry: services.registry, settings: services.settings, env: services.env,
			retryMaxAttempts: services.services.settingsManager.getRetrySettings().enabled ? services.services.settingsManager.getRetrySettings().maxRetries + 1 : 1,
			agent: hostAgent(),
			meta: { name: metadata.name, owner: metadata.ownerId }, profileSeed: catalog.read(metadata.storageId).view?.profileSeed, commands: services.commands, contributionHost: services.contributionHost,
			resume: false, onReport: (error) => { process.stderr.write(`Durable task: ${String(error)}\n`); },
		});
		try {
			await services.install(opened.harness);
			host = opened;
			services.registry.install({ name: "agent.request-context", sections: [requestContextSection(() => host.harness)] });
			unsubscribeChanges?.();
			unsubscribeChanges = opened.harness.subscribeCommits((publication) => {
				activityGeneration++;
				if (publication.changes.length) { notifyActivity(); scheduleCatalogView(); }
			});
			await markPendingRecovery();
			await opened.resume(BACKGROUND_CONTEXT);
			scheduleCatalogView();
			return opened;
		} catch (error) {
			try { await services.close(); } catch { /* Retain the open failure. */ }
			try { await opened.close(); } catch { /* Retain the open failure. */ }
			throw error;
		}
	};
	try { host = await openHost(); }
	catch (error) { restoreDispatch(); controller.abort(); await services.close().catch(() => {}); throw error; }
	const delivery = () => startDurableDelivery({ host, metadata, catalog, sessionsRoot: dirname(dirname(metadata.storagePath)), signal: controller.signal, onIdle: notifyActivity, onError: (error) => { process.stderr.write(`Agent delivery: ${error.message}\n`); } });
	let deliveries = delivery();

	async function configure(params: Record<string, unknown>, requestId: string): Promise<ExecutionSelection> {
		const conversation = await host.conversation(typeof params.sessionId === "string" ? params.sessionId : undefined);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const input = { ...(params as ExecutionFields & { preset?: string }), ...(typeof params.model === "object" && params.model !== null ? { model: `${(params.model as { provider: string }).provider}/${(params.model as { modelId: string }).modelId}` } : {}) };
		const inputKey = createHash("sha256").update(JSON.stringify([input.preset, input.model, input.thinkingLevel, params.name])).digest("hex");
		const selection = await host.harness.commit(async (tx) => {
			const state = await tx.doc(ExecutionSelectionDoc, conversation.id, createHash("sha256").update(requestId).digest("hex"), null);
			if (state.selection) { if (state.input !== inputKey) throw new Error("Configuration request ID belongs to different inputs"); return JSON.parse(JSON.stringify(state.selection)) as ExecutionSelection; }
			const snapshot = params.preferenceSnapshot === undefined ? readAgentPreferences(metadata.agentDir, services.services.modelRuntime) : parsePreferenceSnapshot(params.preferenceSnapshot);
			const selected = resolveExecutionPreset(snapshot, input, { model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : undefined, thinkingLevel: agent.thinkingLevel });
			state.input = inputKey; state.selection = selected;
			return selected;
		}, BACKGROUND_CONTEXT);
		for (const field of ["model", "thinkingLevel"] as const) {
			if (selection.origins[field] === "explicit" || selection.origins[field] === "preset") params[field] = selection.values[field];
		}
		params.model = configuredModel(params.model);
		return selection;
	}
	async function runCommand(params: Record<string, unknown>): Promise<unknown> {
		if (params.name === "tree") {
			if (typeof params.args !== "string" || !/^\d+$/u.test(params.args.trim())) throw new Error("tree requires one native entry ID");
			return host.request("fork", { sessionId: params.sessionId, entryId: params.args.trim(), ownerId: params.ownerId });
		}
		if (params.name !== "reload") return host.request("command", params);
		if (!host.isIdle()) throw new Error("Reload requires an idle storage; it cannot replace another conversation's active tasks");
		if (host.observationCount > 0) throw new Error("Reload requires closed live observations; release every observer before reload");
		await services.services.resourceLoader.reload();
		try {
			await deliveries.close();
			unsubscribeChanges?.();
			unsubscribeChanges = undefined;
			await flushCatalogView();
			await settleRecoveryMarker();
			await services.close(); await host.close();
			services = await bootstrap(metadata, controller, true, options);
			host = await openHost();
			deliveries = delivery();
		} catch (error) {
			// Teardown has started; only a fresh process can own a usable runtime.
			reloadFailed = true;
			throw error;
		}
		return { sessionId: params.sessionId ?? metadata.storageId, inventory: services.inventory, reloaded: true };
	}
	async function request(method: string, input: unknown, requestId: string, signal?: AbortSignal): Promise<unknown> {
		if (runtimeUnavailable()) throw new Error("Durable host is closed");
		if (reloading) throw new Error("Durable host reload is in progress; retry the control after reload");
		const reload = method === "command" && (input as { name?: unknown } | undefined)?.name === "reload";
		if (reload && activeRequests > 0) throw new Error("Reload requires all other controls to settle");
		const counted = method !== "receipts";
		activityGeneration++;
		if (counted) activeRequests++;
		reloading = reload;
		try { return await executeRequest(method, input, requestId, signal); }
		finally { if (counted) activeRequests--; if (reload) reloading = false; notifyActivity(); }
	}
	async function spawn(params: Record<string, unknown>, requestId: string, method: "spawn" | "place" = "spawn"): Promise<unknown> {
		if (typeof params.senderIdentity !== "string") throw new Error("A native spawn requires its sender identity");
		const conversation = await host.conversation(params.senderIdentity);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const key = createHash("sha256").update(JSON.stringify([method, requestId])).digest("hex");
		const inputKey = createHash("sha256").update(JSON.stringify([params.handle, params.area, params.cwd, params.name, params.topic, params.prompt, params.preset, params.model, params.thinkingLevel, params.role, params.checkInMinutes])).digest("hex");
		const retained = await host.harness.snapshot(ExecutionSelectionDoc, conversation.id, key, BACKGROUND_CONTEXT);
		if (retained?.input !== undefined && retained.input !== inputKey) throw new Error("Creation request ID belongs to different inputs");
		const selection = retained?.selection;
		const retainExecutionSelection = async (selected: ExecutionSelection): Promise<void> => {
			await host.harness.commit(async (tx) => {
				const state = await tx.doc(ExecutionSelectionDoc, conversation.id, key, null);
				if (state.selection !== undefined) {
					if (state.input !== inputKey || JSON.stringify(state.selection) !== JSON.stringify(selected)) throw new Error("Creation request already retains a different execution selection");
					return;
				}
				state.input = inputKey; state.selection = selected;
			}, BACKGROUND_CONTEXT);
		};
		const manager = new AgentManager({ root: dirname(dirname(metadata.storagePath)), agentDir: metadata.agentDir, packageDir: metadata.packageDir, validateModel: (model, level) => validateModel(services, model, level) });
		try {
			const caller = { id: params.senderIdentity, cwd: metadata.cwd, model: agent.model, thinkingLevel: agent.thinkingLevel, preferenceCatalog: services.services.modelRuntime, retainExecutionSelection };
			return method === "place" ? await manager.place({ ...params, requestId, selection }, caller) : await manager.spawn({ ...params, requestId, selection }, caller);
		}
		finally { await manager.close(); }
	}
	async function discover(params: Record<string, unknown>, profiles = false): Promise<unknown> {
		const manager = new AgentManager({ root: dirname(dirname(metadata.storagePath)), agentDir: metadata.agentDir, packageDir: metadata.packageDir });
		try {
			const result = await manager.list(params) as { rows: Record<string, unknown>[]; coverage: Record<string, unknown> };
			if (profiles) return result;
			const { profileHints: _hints, ...coverage } = result.coverage;
			const rows = result.rows.map(({ handle: _handle, role: _role, profile: _profile, profileCoverage: _coverage, ...row }) => row);
			return { ...result, rows, coverage };
		} finally { await manager.close(); }
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
		const outcome = await host.request("configure", params) as { after?: { thinkingLevel?: string }; [key: string]: unknown };
		return { ...outcome, selection: effectiveExecutionSelection(selection, outcome.after?.thinkingLevel) };
	}
	async function executeRequest(method: string, input: unknown, requestId: string, signal?: AbortSignal): Promise<unknown> {
		const params = controlParams(input);
		if (method === "recovery-state") {
			const state = await recoveryState();
			if (state.deliveriesPending) deliveries.refresh();
			return state;
		}
		if (ADMITTING_METHODS.has(method)) markRecoveryDue(true);
		switch (method) {
			case "spawn": case "resolve-agent": return spawn(params, requestId);
			case "place": return spawn(params, requestId, "place");
			case "list": return params.global === true ? discover(params) : host.request(method, params);
			case "profile-list": return discover(params, true);
			case "attach": return attach(params);
			case "configure": return configureRequest(params, requestId);
			case "command": params.invocationId ??= requestId; return runCommand(params);
			case "status": return { ...await host.request(method, params) as Record<string, unknown>, inventory: services.inventory, pid: process.pid, storageId: metadata.storageId };
			case "receipts": return host.request(method, params, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
			case "task-submit": case "profile-update": case "submit": case "rewind": case "report": params.requestId ??= requestId; break;
		}
		return host.request(method, params);
	}
	async function closeIdleRuntime(): Promise<void> {
		try {
			await flushCatalogView();
			await settleRecoveryMarker();
		} finally {
			changeListeners.clear();
			try { await deliveries.close(); } finally { try { await services.close(); } finally { await host.close(); } }
		}
	}
	const closeHost = async (): Promise<"process-exit" | undefined> => {
		if (closed) return;
		closed = true;
		// A failed reload no longer provides a reliable native work or delivery snapshot.
		const processExit = reloadFailed || !(await host.refreshIdle());
		restoreDispatch();
		activityListeners.clear();
		controller.abort();
		if (publishTimer !== undefined) {
			clearTimeout(publishTimer);
			publishTimer = undefined;
		}
		unsubscribeChanges?.();
		if (processExit) {
			markRecoveryDue(true);
			try { await flushCatalogView(); } catch (error) { process.stderr.write(`Catalog view: ${String(error)}\n`); }
			changeListeners.clear();
			// Native close seals admission synchronously, but joins even noncooperative task code.
			// Process death ends those invocations without manufacturing a durable task outcome.
			void host.close().catch((error: unknown) => process.stderr.write(`Native close: ${String(error)}\n`));
			try { try { await deliveries.close(); } finally { await services.close(); } }
			catch (error) { process.stderr.write(`Service close: ${String(error)}\n`); }
			return "process-exit";
		}
		await closeIdleRuntime();
		return undefined;
	};
	return { request, get shutdownRequired() { return reloadFailed; }, isIdle: () => !runtimeUnavailable() && !reloading && activeRequests === 0 && host.isIdle(), tryRetire, onActivity: (listener) => { activityListeners.add(listener); return () => { activityListeners.delete(listener); }; }, onChange: (listener) => { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; }, close: closeHost };
}

/** Cold inspection writes a bounded disposable SQLite snapshot; it never writes source content. */
export async function observeDurableStorage(metadata: HostMetadata, method: string, params: Record<string, unknown>): Promise<unknown> {
	return observeColdStorage(metadata, method, params);
}
