/** A Models boundary that retains exhaustion before native error settlement and ends each request on its caller's abort or a silent first response. */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	Models,
	ModelsSimpleStreamOptions,
	ModelsApiStreamOptions,
	ModelsDeferredFetchOptions,
	ModelsDeferredCancelOptions,
	DeferredHandle,
	Context as ModelContext,
} from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream";
import { onStoredCommit } from "./commit-observation.ts";
import { canonicalIdentity } from "./native-identity.ts";
import { awaitWithContext, withAbortSignal, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import {
	associateProviderBlock,
	captureProviderAttempt,
	isProviderExhaustion,
	providerAttemptCurrent,
	retainProviderBlock,
	readProviderAttemptBlock,
	retainDeferredAttempt,
	readDeferredAttempt,
	type ProviderAttempt,
} from "./provider-block.ts";
import { PROVIDER_BLOCK_ERROR, STALE_PROVIDER_ERROR, type ProviderBlockFact } from "./provider-block-facts.ts";
import { processProviderBlockNotes } from "./provider-block-notes.ts";

const STATE_ERROR = "Agent host: provider state failure; inspect retained state.";
const ABORTED_ERROR = "Request was aborted";
/** The longest delay a Node timer holds; a larger request timeout means no deadline. */
const TIMER_MAX_MS = 2_147_483_647;

/**
 * What ends one request apart from the provider's own terminal message: the caller's abort signal, and a deadline for
 * the provider's first event. Pi's `timeoutMs` bounds the wait for a response; the deadline enforces that bound here
 * as well, because a provider can wait without one, for example on an authentication step that ignores the signal.
 */
type RequestBounds = { readonly signal?: AbortSignal; readonly firstEventMs?: number; readonly idleMs?: number };

function requestBounds(
	options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } | undefined,
): RequestBounds {
	const timeoutMs = options?.timeoutMs;
	const firstEventMs =
		typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= TIMER_MAX_MS
			? timeoutMs
			: undefined;
	return {
		...(options?.signal === undefined ? {} : { signal: options.signal }),
		...(firstEventMs === undefined ? {} : { firstEventMs }),
	};
}

/** The retry classifier treats this text as a transient failure, so the request runs again under the retry policy. */
function firstEventTimeout(ms: number): string {
	return `Provider request timed out after ${ms} ms without a response event`;
}

/** The single end of one request's output: later provider events, results, and state are dropped. */
interface RequestEnd {
	readonly ended: boolean;
	/** The provider answered in time: any event, including a terminal one, meets the response deadline. */
	responded(): void;
	/** Record the partial message of one forwarded provider event. */
	observe(event: AssistantMessageEvent): void;
	finish(message: AssistantMessage): void;
}

function requestEnd(
	output: AssistantMessageEventStream,
	model: Model<Api>,
	bounds: RequestBounds,
	controller: AbortController,
	now: () => number,
): RequestEnd {
	let ended = false;
	let partial: AssistantMessage | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const clearDeadline = (): void => {
		if (deadline !== undefined) clearTimeout(deadline);
		deadline = undefined;
	};
	const end = (message: AssistantMessage): void => {
		if (ended) return;
		ended = true;
		clearDeadline();
		bounds.signal?.removeEventListener("abort", abort);
		finish(output, message);
	};
	const abort = (): void => {
		controller.abort();
		end({
			...(partial ? structuredClone(partial) : failure(model, "", now())),
			stopReason: "aborted",
			errorMessage: ABORTED_ERROR,
		});
	};
	const firstEventMs = bounds.firstEventMs;
	if (firstEventMs !== undefined)
		deadline = setTimeout(() => {
			end(failure(model, firstEventTimeout(firstEventMs), now()));
			controller.abort();
		}, firstEventMs);
	if (bounds.signal?.aborted) abort();
	else bounds.signal?.addEventListener("abort", abort, { once: true });
	return {
		get ended() {
			return ended;
		},
		responded: clearDeadline,
		observe(event) {
			if ("partial" in event) partial = event.partial;
			const idle = bounds.idleMs;
			if (idle && idle > 0 && idle <= TIMER_MAX_MS)
				deadline = setTimeout(() => {
					const hasOutput = partial?.content.some((part) =>
						part.type === "text" ? part.text !== "" : part.type === "thinking" ? part.thinking !== "" : true,
					);
					const message = partial ? structuredClone(partial) : failure(model, "", now());
					end({
						...message,
						stopReason: hasOutput ? "aborted" : "error",
						errorMessage: hasOutput
							? "Provider stopped making progress after partial output; inspect before retry."
							: firstEventTimeout(idle),
					});
					controller.abort();
				}, idle);
		},
		finish: end,
	};
}
function failure(model: Model<Api>, errorMessage: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp,
	};
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function finish(output: AssistantMessageEventStream, message: AssistantMessage): void {
	if (message.stopReason === "pending") {
		output.push({
			type: "error",
			reason: "error",
			error: { ...message, stopReason: "error", errorMessage: STATE_ERROR },
		});
		output.end();
		return;
	}
	if (message.stopReason === "error" || message.stopReason === "aborted")
		output.push({ type: "error", reason: message.stopReason, error: message });
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
	private readonly idleMs: number;
	private readonly deferredMs: number;
	constructor(
		delegate: Models,
		harness: () => Harness,
		storageId: string,
		now: () => number = Date.now,
		idleMs = 0,
		deferredMs = 300_000,
	) {
		this.idleMs = idleMs;
		this.deferredMs = deferredMs;
		this.delegate = delegate;
		this.harness = harness;
		this.storageId = storageId;
		this.now = now;
		this.models = new Proxy(delegate, { get: (target, property) => this.method(target, property) });
	}
	private method(target: Models, property: string | symbol): unknown {
		if (property === "getModel") return this.getModel.bind(this);
		if (property === "streamSimple") return this.streamSimple.bind(this);
		if (property === "completeSimple")
			return (model: Model<Api>, context: ModelContext, options?: ModelsSimpleStreamOptions) =>
				this.streamSimple(model, context, options).result();
		if (property === "stream") return this.stream.bind(this);
		if (property === "complete")
			return (model: Model<Api>, context: ModelContext, options?: ModelsApiStreamOptions<Api>) =>
				this.stream(model, context, options).result();
		if (property === "streamDeferred") return this.streamDeferred.bind(this);
		if (property === "cancelDeferred") return this.cancelDeferred.bind(this);
		if (property === "fetchDeferred") return this.fetchDeferred.bind(this);
		const value = Reflect.get(target, property, target);
		return typeof value === "function" ? value.bind(target) : value;
	}
	private getModel(provider: string, id: string): Model<Api> | undefined {
		const base = this.delegate.getModel(provider, id);
		if (base === undefined) return undefined;
		const model = { ...base };
		this.selected.set(model, this.sequence);
		return model;
	}
	/** Observe committed epochs synchronously, including explicit same-model recovery. */
	bind(): void {
		this.unsubscribe = onStoredCommit(this.harness(), (publication) => {
			for (const change of publication.changes) {
				if (
					change.type !== "document" ||
					change.kind !== "change" ||
					change.record.kind !== "agent.provider-control" ||
					change.record.key === undefined
				)
					continue;
				const epoch = change.value.epoch;
				if (typeof epoch !== "number") continue;
				const previous = this.epochs.get(change.record.key) ?? 0;
				this.epochs.set(change.record.key, epoch);
				if (previous !== epoch) this.configuredAt.set(change.record.key, ++this.sequence);
			}
		});
	}
	close(): void {
		this.unsubscribe?.();
	}
	streamSimple(
		model: Model<Api>,
		context: ModelContext,
		options?: ModelsSimpleStreamOptions,
	): AssistantMessageEventStream {
		return this.request(
			model,
			() => this.capture(model, options?.sessionId),
			(signal) => this.delegate.streamSimple(model, context, { ...options, signal }),
			requestBounds(options),
		);
	}
	private stream(
		model: Model<Api>,
		context: ModelContext,
		options?: ModelsApiStreamOptions<Api>,
	): AssistantMessageEventStream {
		return this.request(
			model,
			() => this.capture(model, options?.sessionId),
			(signal) => this.delegate.stream(model, context, { ...options, signal }),
			requestBounds(options),
		);
	}
	private streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return this.request(
			model,
			() => this.harness().commit((tx) => readDeferredAttempt(tx, model, handle), BACKGROUND_CONTEXT),
			(signal) => this.delegate.streamDeferred(model, handle, { ...options, signal }),
			requestBounds({ signal: options?.signal, timeoutMs: this.deferredMs }),
		);
	}
	private fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.request(
			model,
			() => this.harness().commit((tx) => readDeferredAttempt(tx, model, handle), BACKGROUND_CONTEXT),
			(signal) => {
				const stream = createAssistantMessageEventStream();
				void Promise.resolve()
					.then(() => this.delegate.fetchDeferred(model, handle, { ...options, signal }))
					.then(
						(message) => finish(stream, message),
						(error) => finish(stream, failure(model, errorText(error), this.now())),
					);
				return stream;
			},
			requestBounds({ signal: options?.signal, timeoutMs: this.deferredMs }),
		).result();
	}
	private async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		const ms = this.deferredMs;
		if (!(ms > 0 && ms <= TIMER_MAX_MS)) return this.delegate.cancelDeferred(model, handle, options);
		const deadline = AbortSignal.timeout(ms);
		const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
		signal.throwIfAborted();
		await awaitWithContext(
			this.delegate.cancelDeferred(model, handle, { ...options, signal }),
			withAbortSignal(signal, BACKGROUND_CONTEXT),
		);
	}
	private async capture(model: Model<Api>, sessionId: string | undefined): Promise<ProviderAttempt> {
		if (sessionId === undefined) throw new Error("The provider request has no native session identity.");
		const attempt = await this.harness().commit(
			(tx) => captureProviderAttempt(tx, sessionId, { provider: model.provider, modelId: model.id }),
			BACKGROUND_CONTEXT,
		);
		for (const submissionId of attempt.inputs.slice(0, 16)) {
			const submission = await this.harness().submission(submissionId, BACKGROUND_CONTEXT);
			const record = await submission?.status(BACKGROUND_CONTEXT);
			attempt.originalResults.push({
				sessionId: canonicalIdentity(this.storageId, attempt.conversationId),
				submissionId,
				...(record?.requestId === undefined ? {} : { requestId: record.requestId }),
			});
		}
		return attempt;
	}
	private request(
		model: Model<Api>,
		capture: () => Promise<ProviderAttempt>,
		dispatch: (signal: AbortSignal) => AssistantMessageEventStream,
		bounds: RequestBounds,
	): AssistantMessageEventStream {
		const output = createAssistantMessageEventStream();
		const controller = new AbortController();
		void this.forward(
			output,
			model,
			capture,
			() => dispatch(controller.signal),
			requestEnd(output, model, { ...bounds, idleMs: this.idleMs }, controller, this.now),
		);
		return output;
	}
	private async blocked(model: Model<Api>, attempt: ProviderAttempt): Promise<string | undefined> {
		const selection = this.selected.get(model);
		if (
			attempt.stale ||
			(selection !== undefined && selection < (this.configuredAt.get(attempt.providerSessionId) ?? 0))
		)
			return STALE_PROVIDER_ERROR;
		return this.harness().commit(async (tx) => {
			if (!(await providerAttemptCurrent(tx, attempt))) return STALE_PROVIDER_ERROR;
			const block = await readProviderAttemptBlock(tx, attempt);
			if (block === undefined) return undefined;
			await associateProviderBlock(tx, attempt.inputs, { ...block, source: "host-block" });
			return PROVIDER_BLOCK_ERROR;
		}, BACKGROUND_CONTEXT);
	}
	private async terminal(attempt: ProviderAttempt, original: AssistantMessage): Promise<AssistantMessage> {
		let retained: ProviderBlockFact | undefined;
		const message = await this.harness().commit(async (tx): Promise<AssistantMessage> => {
			retained = undefined;
			if (!(await providerAttemptCurrent(tx, attempt)))
				return { ...original, stopReason: "error", errorMessage: STALE_PROVIDER_ERROR };
			if (
				original.stopReason === "error" &&
				isProviderExhaustion(original.errorMessage ?? "", attempt.model.provider)
			) {
				retained = await retainProviderBlock(tx, attempt, original.errorMessage ?? "", this.storageId, this.now());
				return {
					...original,
					stopReason: "error",
					errorMessage: retained === undefined ? STALE_PROVIDER_ERROR : PROVIDER_BLOCK_ERROR,
				};
			}
			if (original.deferred !== undefined) await retainDeferredAttempt(tx, attempt, original.deferred);
			return original;
		}, BACKGROUND_CONTEXT);
		// Only a committed block becomes a note for later model choices in this host; a note never changes this result.
		if (retained !== undefined) {
			try {
				processProviderBlockNotes().observeBlock(retained);
			} catch {
				/* The note is advisory evidence. */
			}
		}
		return message;
	}
	private async consume(
		output: AssistantMessageEventStream,
		model: Model<Api>,
		attempt: ProviderAttempt,
		stream: AssistantMessageEventStream,
		end: RequestEnd,
	): Promise<void> {
		let partial: AssistantMessage | undefined;
		const iterator = stream[Symbol.asyncIterator]();
		// An output that its bounds ended drops what the provider still sends, and records no provider state for it.
		while (!end.ended) {
			const step = await this.step(iterator, model, stream, partial);
			if (end.ended) return;
			end.responded();
			if ("message" in step) {
				end.finish(await this.terminal(attempt, step.message));
				return;
			}
			end.observe(step.event);
			if ("partial" in step.event) partial = step.event.partial;
			output.push(step.event);
		}
	}
	/** One provider step: an event to forward, or the provider's terminal message. */
	private async step(
		iterator: AsyncIterator<AssistantMessageEvent>,
		model: Model<Api>,
		stream: AssistantMessageEventStream,
		partial: AssistantMessage | undefined,
	): Promise<{ readonly event: AssistantMessageEvent } | { readonly message: AssistantMessage }> {
		let next: IteratorResult<AssistantMessageEvent>;
		try {
			next = await iterator.next();
		} catch (error) {
			const base = partial ?? failure(model, "", this.now());
			return { message: { ...base, stopReason: "error", errorMessage: errorText(error) } };
		}
		if (next.done) return { message: await this.providerResult(model, stream) };
		const event = next.value;
		if (event.type === "done") return { message: event.message };
		if (event.type === "error") return { message: event.error };
		return { event };
	}
	private async providerResult(model: Model<Api>, stream: AssistantMessageEventStream): Promise<AssistantMessage> {
		try {
			return await stream.result();
		} catch (error) {
			return failure(model, errorText(error), this.now());
		}
	}
	private async forward(
		output: AssistantMessageEventStream,
		model: Model<Api>,
		capture: () => Promise<ProviderAttempt>,
		dispatch: () => AssistantMessageEventStream,
		end: RequestEnd,
	): Promise<void> {
		let attempt: ProviderAttempt;
		try {
			attempt = await capture();
			const error = await this.blocked(model, attempt);
			if (error !== undefined) {
				end.finish(failure(model, error, this.now()));
				return;
			}
		} catch {
			end.finish(failure(model, STATE_ERROR, this.now()));
			return;
		}
		// An abort or deadline before dispatch starts no provider request.
		if (end.ended) return;
		let stream: AssistantMessageEventStream;
		try {
			stream = dispatch();
		} catch (error) {
			end.responded();
			try {
				end.finish(await this.terminal(attempt, failure(model, errorText(error), this.now())));
			} catch {
				end.finish(failure(model, STATE_ERROR, this.now()));
			}
			return;
		}
		try {
			await this.consume(output, model, attempt, stream, end);
		} catch {
			end.finish(failure(model, STATE_ERROR, this.now()));
		}
	}
}
