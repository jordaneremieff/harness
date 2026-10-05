/** One-hop refresh uses existing commit notifications, never a recursive watch. */
import type { Context } from "@earendil-works/chord";
import { OwnAwaitFactSchema, ProducerRetrySchema, type ProducerState, type ProducerAwaitFact } from "./await-facts.ts";
import { Value } from "typebox/value";
import { safeFactText } from "./primary-observation.ts";

async function producerFact(sessionId: string, read: () => Promise<ProducerState>): Promise<ProducerAwaitFact> {
	try {
		const value = await read();
		if (value.awaiting !== undefined && !Value.Check(OwnAwaitFactSchema, value.awaiting)) throw new Error("Producer returned an invalid own await fact");
		if (value.execution !== undefined && (!Value.Check(ProducerRetrySchema, value.execution) || value.execution.results.some((result) => result.sessionId !== sessionId))) throw new Error("Producer returned an invalid retry fact");
		const error = value.execution === undefined ? undefined : safeFactText(value.execution.error);
		return { sessionId, observedAt: Date.now(), source: "producer await-state", ...(value.awaiting === undefined ? {} : { awaiting: value.awaiting }), ...(value.execution === undefined || error === undefined ? {} : { execution: { ...value.execution, error: error.text, errorTruncated: value.execution.errorTruncated || error.truncated } }) };
	} catch (error) { const text = safeFactText(error instanceof Error ? error.message : String(error), 500); return { sessionId, observedAt: Date.now(), source: "producer await-state", unavailable: `${text.text}${text.truncated ? " [truncated]" : ""}`.slice(0, 512) }; }
}

export async function observeProducerAwait(
	sessionId: string,
	read: () => Promise<ProducerState>,
	subscribe: (changed: () => void) => Promise<() => void>,
	publish: (fact: ProducerAwaitFact) => Promise<void>,
	context: Context,
	onClose?: (closed: () => void) => () => void,
): Promise<void> {
	let stop: (() => void) | undefined; let active = true; let dirty = false; let running: Promise<void> | undefined;
	let finish!: () => void; let failure: unknown; let closeJob: Promise<void> | undefined; let stopClose: (() => void) | undefined;
	const ended = new Promise<void>((resolve) => { finish = resolve; });
	const abort = () => { active = false; finish(); };
	context.abortSignal?.addEventListener("abort", abort, { once: true });
	const refresh = async () => {
		while (active && dirty) {
			dirty = false;
			const fact = await producerFact(sessionId, read);
			if (active) await publish(fact);
		}
	};
	const changed = () => {
		if (!active) return;
		dirty = true;
		if (running !== undefined) return;
		running = refresh().catch((error) => { failure = error; active = false; finish(); }).finally(() => { running = undefined; if (active && dirty) changed(); });
	};
	const closed = () => {
		if (!active) return;
		active = false;
		closeJob = publish({ sessionId, observedAt: Date.now(), source: "producer await-state", unavailable: "Producer host connection closed" }).catch((error) => { failure = error; }).finally(finish);
	};
	try {
		if (context.abortSignal?.aborted) return;
		stopClose = onClose?.(closed);
		stop = await subscribe(changed);
		if (context.abortSignal?.aborted) return;
		changed();
		await ended;
		if (failure !== undefined) throw failure;
	} finally { active = false; stop?.(); stopClose?.(); context.abortSignal?.removeEventListener("abort", abort); await running; await closeJob; }
}
