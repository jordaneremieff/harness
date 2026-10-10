/** A Models boundary that retains exhaustion before native error settlement. */
import type { Api, AssistantMessage, Model, Models, ModelsSimpleStreamOptions, ModelsApiStreamOptions, ModelsDeferredFetchOptions, DeferredHandle, Context as ModelContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { canonicalIdentity } from "./identity.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { associateProviderBlock, captureProviderAttempt, isProviderExhaustion, providerAttemptCurrent, retainProviderBlock, readProviderAttemptBlock, retainDeferredAttempt, readDeferredAttempt, PROVIDER_BLOCK_ERROR, STALE_PROVIDER_ERROR, type ProviderAttempt } from "./provider-block.ts";

const STATE_ERROR = "Agent host: provider state failure; inspect retained state.";
function failure(model: Model<Api>, errorMessage: string, timestamp: number): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error", errorMessage, timestamp };
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function finish(output: AssistantMessageEventStream, message: AssistantMessage): void {
	if (message.stopReason === "pending") {
		output.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: STATE_ERROR } });
		output.end(); return;
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") output.push({ type: "error", reason: message.stopReason, error: message });
	else output.push({ type: "done", reason: message.stopReason, message });
	output.end();
}

/** Catalog methods retain the delegate's receiver; chat requests cross the retained block boundary. */
export class ProviderModels {
	readonly models: Models;
	private sequence = 0;
	private readonly selected = new WeakMap<Model<Api>, number>();
	private readonly epochs = new Map<string, number>();
	private readonly configuredAt = new Map<string, number>();
	private unsubscribe?: () => void;
	private readonly delegate: Models;
	private readonly harness: () => Harness;
	private readonly storageId: string;
	private readonly now: () => number;
	constructor(delegate: Models, harness: () => Harness, storageId: string, now: () => number = Date.now) {
		this.delegate = delegate; this.harness = harness; this.storageId = storageId; this.now = now;
		this.models = new Proxy(delegate, { get: (target, property) => this.method(target, property) });
	}
	private method(target: Models, property: string | symbol): unknown {
		if (property === "getModel") return this.getModel.bind(this);
		if (property === "streamSimple") return this.streamSimple.bind(this);
		if (property === "completeSimple") return (model: Model<Api>, context: ModelContext, options?: ModelsSimpleStreamOptions) => this.streamSimple(model, context, options).result();
		if (property === "stream") return this.stream.bind(this);
		if (property === "complete") return (model: Model<Api>, context: ModelContext, options?: ModelsApiStreamOptions<Api>) => this.stream(model, context, options).result();
		if (property === "streamDeferred") return this.streamDeferred.bind(this);
		if (property === "fetchDeferred") return this.fetchDeferred.bind(this);
		const value = Reflect.get(target, property, target);
		return typeof value === "function" ? value.bind(target) : value;
	}
	private getModel(provider: string, id: string): Model<Api> | undefined {
		const base = this.delegate.getModel(provider, id);
		if (base === undefined) return undefined;
		const model = { ...base }; this.selected.set(model, this.sequence); return model;
	}
	/** Observe committed epochs synchronously, including explicit same-model recovery. */
	bind(): void {
		this.unsubscribe = this.harness().subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (change.type !== "document" || change.record.kind !== "agent.provider-control" || change.record.key === undefined || change.value === null) continue;
				const epoch = change.value.epoch;
				if (typeof epoch !== "number") continue;
				const previous = this.epochs.get(change.record.key) ?? 0;
				this.epochs.set(change.record.key, epoch);
				if (previous !== epoch) this.configuredAt.set(change.record.key, ++this.sequence);
			}
		});
	}
	close(): void { this.unsubscribe?.(); }
	streamSimple(model: Model<Api>, context: ModelContext, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.request(model, () => this.capture(model, options?.sessionId), () => this.delegate.streamSimple(model, context, options));
	}
	private stream(model: Model<Api>, context: ModelContext, options?: ModelsApiStreamOptions<Api>): AssistantMessageEventStream {
		return this.request(model, () => this.capture(model, options?.sessionId), () => this.delegate.stream(model, context, options));
	}
	private streamDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredFetchOptions): AssistantMessageEventStream {
		return this.request(model, () => this.harness().commit((tx) => readDeferredAttempt(tx, model, handle), BACKGROUND_CONTEXT), () => this.delegate.streamDeferred(model, handle, options));
	}
	private fetchDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredFetchOptions): Promise<AssistantMessage> {
		return this.request(model, () => this.harness().commit((tx) => readDeferredAttempt(tx, model, handle), BACKGROUND_CONTEXT), () => {
			const stream = createAssistantMessageEventStream();
			void Promise.resolve().then(() => this.delegate.fetchDeferred(model, handle, options)).then((message) => finish(stream, message), (error) => finish(stream, failure(model, errorText(error), this.now())));
			return stream;
		}).result();
	}
	private async capture(model: Model<Api>, sessionId: string | undefined): Promise<ProviderAttempt> {
		if (sessionId === undefined) throw new Error("The provider request has no native session identity.");
		const attempt = await this.harness().commit((tx) => captureProviderAttempt(tx, sessionId, { provider: model.provider, modelId: model.id }), BACKGROUND_CONTEXT);
		for (const submissionId of attempt.inputs.slice(0, 16)) {
			const submission = await this.harness().submission(submissionId, BACKGROUND_CONTEXT);
			const record = await submission?.status(BACKGROUND_CONTEXT);
			attempt.originalResults.push({ sessionId: canonicalIdentity(this.storageId, attempt.conversationId), submissionId, ...(record?.requestId === undefined ? {} : { requestId: record.requestId }) });
		}
		return attempt;
	}
	private request(model: Model<Api>, capture: () => Promise<ProviderAttempt>, dispatch: () => AssistantMessageEventStream): AssistantMessageEventStream {
		const output = createAssistantMessageEventStream(); void this.forward(output, model, capture, dispatch); return output;
	}
	private async blocked(model: Model<Api>, attempt: ProviderAttempt): Promise<string | undefined> {
		const selection = this.selected.get(model);
		if (attempt.stale || (selection !== undefined && selection < (this.configuredAt.get(attempt.providerSessionId) ?? 0))) return STALE_PROVIDER_ERROR;
		return this.harness().commit(async (tx) => {
			if (!await providerAttemptCurrent(tx, attempt)) return STALE_PROVIDER_ERROR;
			const block = await readProviderAttemptBlock(tx, attempt);
			if (block === undefined) return undefined;
			await associateProviderBlock(tx, attempt.inputs, { ...block, source: "host-block" });
			return PROVIDER_BLOCK_ERROR;
		}, BACKGROUND_CONTEXT);
	}
	private async terminal(attempt: ProviderAttempt, original: AssistantMessage): Promise<AssistantMessage> {
		return this.harness().commit(async (tx) => {
			if (!await providerAttemptCurrent(tx, attempt)) return { ...original, stopReason: "error", errorMessage: STALE_PROVIDER_ERROR };
			if (original.stopReason === "error" && isProviderExhaustion(original.errorMessage ?? "", attempt.model.provider)) {
				const retained = await retainProviderBlock(tx, attempt, original.errorMessage ?? "", this.storageId, this.now());
				return { ...original, stopReason: "error", errorMessage: retained === undefined ? STALE_PROVIDER_ERROR : PROVIDER_BLOCK_ERROR };
			}
			if (original.deferred !== undefined) await retainDeferredAttempt(tx, attempt, original.deferred);
			return original;
		}, BACKGROUND_CONTEXT);
	}
	private async consume(output: AssistantMessageEventStream, model: Model<Api>, attempt: ProviderAttempt, stream: AssistantMessageEventStream): Promise<void> {
		let partial: AssistantMessage | undefined;
		const iterator = stream[Symbol.asyncIterator]();
		while (true) {
			let step: Awaited<ReturnType<typeof iterator.next>>;
			try { step = await iterator.next(); }
			catch (error) { finish(output, await this.terminal(attempt, { ...(partial ?? failure(model, "", this.now())), stopReason: "error", errorMessage: errorText(error) })); return; }
			if (step.done) { finish(output, await this.terminal(attempt, await this.providerResult(model, stream))); return; }
			const event = step.value;
			if (event.type === "done" || event.type === "error") { finish(output, await this.terminal(attempt, event.type === "error" ? event.error : event.message)); return; }
			if ("partial" in event) partial = event.partial;
			output.push(event);
		}
	}
	private async providerResult(model: Model<Api>, stream: AssistantMessageEventStream): Promise<AssistantMessage> {
		try { return await stream.result(); } catch (error) { return failure(model, errorText(error), this.now()); }
	}
	private async forward(output: AssistantMessageEventStream, model: Model<Api>, capture: () => Promise<ProviderAttempt>, dispatch: () => AssistantMessageEventStream): Promise<void> {
		let attempt: ProviderAttempt;
		try {
			attempt = await capture();
			const error = await this.blocked(model, attempt);
			if (error !== undefined) { finish(output, failure(model, error, this.now())); return; }
		} catch { finish(output, failure(model, STATE_ERROR, this.now())); return; }
		let stream: AssistantMessageEventStream;
		try { stream = dispatch(); }
		catch (error) {
			try { finish(output, await this.terminal(attempt, failure(model, errorText(error), this.now()))); }
			catch { finish(output, failure(model, STATE_ERROR, this.now())); }
			return;
		}
		try { await this.consume(output, model, attempt, stream); }
		catch { finish(output, failure(model, STATE_ERROR, this.now())); }
	}
}
