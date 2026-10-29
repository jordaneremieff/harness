import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { GenerationHooks, HookApi } from "@earendil-works/pi-durable";
import { inputDigest, memoryNotice, noteKey, type Notice } from "./proactive.ts";

import { DurableRecallState, type RecallState as State, type SavedNotice as Saved } from "./durable-state.ts";
type Recorder = (
	notice: { slug: string | null; digest: string | null; kind: string; inputDigest: string },
	api: HookApi,
	context: Context,
) => Promise<void>;
type User = { message: Extract<Message, { role: "user" }>; index: number; occurrence: string };
function userInputs(messages: readonly Message[]): User[] {
	let prefix = "";
	return messages.flatMap((message, index) => {
		if (message.role !== "user") return [];
		// The ordered prefix distinguishes identical values at a shared admission timestamp.
		prefix = inputDigest(`${prefix}:${inputDigest(JSON.stringify(message))}`);
		return [{ message, index, occurrence: prefix }];
	});
}
function readKeys(messages: readonly Message[], root: string | undefined, notices: Saved[]): Set<string> {
	const satisfied = new Set(
		notices.flatMap((notice) =>
			notice.slug && notice.digest ? [noteKey(notice.root, notice.slug, notice.digest)] : [],
		),
	);
	if (!root) return satisfied;
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "memory_read" || message.isError) continue;
		const details = message.details as { slug?: unknown; digest?: unknown } | undefined;
		if (typeof details?.slug === "string" && typeof details.digest === "string")
			satisfied.add(noteKey(root, details.slug, details.digest));
	}
	return satisfied;
}
function insertNotices(messages: readonly Message[], users: User[], saved: Saved[]): readonly Message[] {
	const result = [...messages];
	let inserted = 0;
	for (const { message, index, occurrence } of users) {
		const notice = saved.find((item) => item.occurrence === occurrence);
		if (notice)
			result.splice(index + 1 + inserted++, 0, {
				role: "user",
				content: [{ type: "text", text: notice.text }],
				timestamp: message.timestamp,
			});
	}
	return result;
}
async function recordNotice(
	record: Recorder | undefined,
	notice: Parameters<Recorder>[0],
	api: HookApi,
	context: Context,
): Promise<boolean> {
	try {
		await record?.(notice, api, context);
		return true;
	} catch (error) {
		if (context.abortSignal?.aborted) throw error;
		return false;
	}
}
function retainNotice(state: State, occurrence: string, notice: Notice, satisfied: Set<string>): void {
	state.notices.push({ occurrence, text: notice.text, root: notice.root, slug: notice.slug, digest: notice.digest });
	if (notice.slug && notice.digest) satisfied.add(noteKey(notice.root, notice.slug, notice.digest));
}
async function collectNotices(
	state: State,
	users: User[],
	root: string | undefined,
	satisfied: Set<string>,
	api: HookApi,
	context: Context,
	record?: Recorder,
): Promise<void> {
	for (const { message, occurrence } of users) {
		if (state.notices.length >= 128 || context.abortSignal?.aborted) return;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		if (/<skill\b/i.test(text)) continue;
		const notice = await memoryNotice(
			root,
			text,
			"unknown admitted task input, not verified operator authorship",
			false,
			satisfied,
			context.abortSignal,
		);
		if (!notice || context.abortSignal?.aborted) continue;
		if (
			!(await recordNotice(
				record,
				{ slug: notice.slug, digest: notice.digest, kind: notice.kind, inputDigest: notice.inputDigest },
				api,
				context,
			))
		)
			continue;
		retainNotice(state, occurrence, notice, satisfied);
	}
}

/** Conversation state spans generation tasks; task memos freeze each retry's payload. */
export function durableRecall(
	configuration: () => { dir: string | undefined; proactive: boolean },
	record?: Recorder,
): Partial<GenerationHooks> {
	const conversations = new DurableRecallState();
	const prepare = async (
		messages: readonly Message[],
		users: User[],
		root: string | undefined,
		api: HookApi,
		context: Context,
	): Promise<Saved[]> => {
		const occurrences = users.map(({ occurrence }) => occurrence);
		let state = conversations.get(api.conversationId);
		let previous = state ? occurrences.indexOf(state.watermark) : -1;
		if (!state || previous < 0) {
			state = { watermark: occurrences.at(-1) as string, notices: [] };
			previous = users.length - 2;
		}
		state.notices = state.notices.filter((notice) => occurrences.includes(notice.occurrence));
		await collectNotices(
			state,
			users.slice(previous + 1, previous + 33),
			root,
			readKeys(messages, root, state.notices),
			api,
			context,
			record,
		);
		state.watermark = occurrences.at(-1) as string;
		return state.notices;
	};
	const requestNotices = async (
		messages: readonly Message[],
		users: User[],
		root: string | undefined,
		api: HookApi,
		context: Context,
	): Promise<Saved[]> => {
		try {
			const memoName = `memory:notices:${users.at(-1)?.occurrence}`;
			const saved = await api.memo<Saved[]>(memoName, context);
			if (saved !== undefined) return saved;
			const notices = await prepare(messages, users, root, api, context);
			if (context.abortSignal?.aborted) return [];
			return await api.memo(memoName, notices, context);
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			return conversations.get(api.conversationId)?.notices ?? [];
		}
	};
	return {
		async beforeRequest(request, api, context) {
			const config = configuration();
			if (!config.proactive || context.abortSignal?.aborted) return undefined;
			const users = userInputs(request.messages);
			if (!users.length) {
				conversations.delete(api.conversationId);
				return undefined;
			}
			const saved = await requestNotices(request.messages, users, config.dir, api, context);
			if (context.abortSignal?.aborted) return undefined;
			conversations.set(api.conversationId, { watermark: users.at(-1)?.occurrence as string, notices: saved });
			return saved.length ? { messages: insertNotices(request.messages, users, saved) } : undefined;
		},
	};
}
