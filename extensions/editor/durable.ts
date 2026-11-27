import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import type * as Durable from "@earendil-works/pi-durable";
import { editorInvitationBody, editorInvitationGuidance } from "./ordinary-invitations.ts";
import { editorOutputSchema, editorResult, editorTextLimit } from "./ordinary-result.ts";
import type { Invitation } from "./participants.ts";
import { answerText } from "./request-answer.ts";
import type { EditorRoom } from "./room.ts";
import { editorParameters, editorToolDescription } from "./schema.ts";

interface EditorHost {
	readonly durable: typeof Durable;
	readonly harness: Durable.Harness;
	readonly cwd: string;
	readonly agentDir: string;
	readonly storageId: string;
	readonly signal: AbortSignal;
	onClose(dispose: () => void | Promise<void>): void;
}

type PendingRequest = { invite: Invitation; submission?: Durable.Submission };
type PendingRequests = Map<string, PendingRequest>;
const requestActions = new Set(["new", "edit", "patch", "save", "revert", "replace", "reply"]);

async function placedInvitation(
	input: { doc?: unknown; id?: unknown },
	requests: PendingRequests | undefined,
	context: Context,
): Promise<Invitation | undefined> {
	let related: Invitation | undefined;
	for (const record of Array.from(requests?.values() ?? []).reverse()) {
		const status = await record.submission?.status(context).catch(() => undefined);
		if (status?.status !== "placed") continue;
		related ??= record.invite;
		if (input.doc === record.invite.doc || input.id === record.invite.thread) return record.invite;
	}
	return related;
}

export function contribution(source: string) {
	return {
		name: "editor",
		source,
		create(host: EditorHost): Durable.Extension {
			const { defineExtension, defineTool, section } = host.durable;
			const rooms = new Map<Durable.ConversationId, EditorRoom>();
			const pending = new Map<Durable.ConversationId, PendingRequests>();
			const work = new Set<Promise<void>>();
			const lifetime = new AbortController();
			const admissionContext = withAbortSignal(AbortSignal.any([host.signal, lifetime.signal]), BACKGROUND_CONTEXT);
			host.onClose(async () => {
				lifetime.abort();
				await Promise.allSettled(work);
				const closing = [...rooms.values()];
				rooms.clear();
				const results = await Promise.allSettled(closing.map((room) => room.close()));
				const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (failures.length) throw new AggregateError(failures, "Editor rooms did not close");
			});
			async function observe(
				target: Durable.Conversation,
				submission: Durable.Submission,
				room: EditorRoom,
				invite: Invitation,
			) {
				let progress: Promise<void> | undefined;
				const markPlaced = () => (progress ??= room.requestState(invite, "working").catch(() => {}));
				const check = async (entries: readonly Durable.EntryRecord[]) => {
					if (
						progress ||
						!entries.some(
							({ kind, data }) =>
								kind === "editor.invitation" &&
								data &&
								typeof data === "object" &&
								"id" in data &&
								data.id === invite.id,
						)
					)
						return;
					await markPlaced();
				};
				const watcher = target
					.watch(admissionContext, { min: 8, max: 32 })
					.then(async (watch) => {
						watch.start(async (frame) => {
							if (frame.kind === "value") await check(frame.value.entries);
						});
						await check(watch.value.entries);
						return watch;
					})
					.catch(() => undefined);
				try {
					const result = await submission.wait(admissionContext);
					if (result.type === "input" && result.entry !== undefined) await markPlaced();
					if (result.type !== "input" || result.status !== "done") {
						await room.requestState(invite, "failed");
						return;
					}
					const entries = await target.entries(
						{ minEntryId: result.answer, maxEntryId: result.answer },
						1,
						undefined,
						admissionContext,
					);
					const answer = entries.items[0]?.model?.findLast((message) => message.role === "assistant");
					const text = answerText(answer);
					await room.requestState(invite, text ? "answered" : "failed", text);
				} catch {
					await room.requestState(invite, "failed").catch(() => {});
				} finally {
					await (await watcher)?.stop();
				}
			}

			async function admit(
				id: Durable.ConversationId,
				room: EditorRoom,
				requests: PendingRequests,
				invite: Invitation,
			) {
				host.signal.throwIfAborted();
				if (requests.size >= 32) throw Error("The selected agent has too many pending Editor requests.");
				const body = editorInvitationBody(invite);
				const target = await host.harness.conversation(id, admissionContext);
				if (!target) throw Error("The selected agent conversation is no longer available.");
				const record: PendingRequest = { invite };
				requests.set(invite.id, record);
				try {
					const submission = await target.submit(
						{
							type: "input",
							requestId: `editor:${invite.id}`,
							whenBusy: "followUp",
							onAbort: "keep",
							entry: { kind: "editor.invitation", data: { id: invite.id, thread: invite.thread } },
							content: `Editor invitation #${invite.id.slice(0, 8).toLowerCase()}\n\n${editorInvitationGuidance}\n\n${body}`,
						},
						admissionContext,
					);
					record.submission = submission;
					const observing = observe(target, submission, room, invite)
						.catch(() => {})
						.finally(() => {
							requests.delete(invite.id);
							work.delete(observing);
						});
					work.add(observing);
				} catch (error) {
					requests.delete(invite.id);
					throw error;
				}
			}

			async function createRoom(
				id: Durable.ConversationId,
				signal: AbortSignal,
				readAgent: () => ReturnType<Durable.Conversation["agent"]>,
			): Promise<EditorRoom> {
				const [{ EditorRoom: Room }, agent] = await Promise.all([import("./room.ts"), readAgent()]);
				signal.throwIfAborted();
				const concurrent = rooms.get(id);
				if (concurrent) return concurrent;
				const actor = {
					id: `durable:${host.storageId}:${id}`,
					label: `Agent ${host.storageId.slice(0, 8)}/${id}`,
					kind: "durable",
				} as const;
				const requests: PendingRequests = new Map();
				const room: EditorRoom = new Room(host.agentDir, agent.cwd ?? host.cwd, actor, (invite) =>
					admit(id, room, requests, invite),
				);
				pending.set(id, requests);
				rooms.set(id, room);
				return room;
			}

			return defineExtension({
				name: "editor",
				sections: [
					section("editor", ({ conversationId }) =>
						rooms.has(conversationId)
							? "Use editor read for the current shared draft. Editor edits stay in the shared draft until an explicit save."
							: undefined,
					),
				],
				tools: [
					defineTool({
						name: "editor",
						description: editorToolDescription,
						parameters: editorParameters,
						structuredOutputSchema: editorOutputSchema,
						outputLimits: { maxBytes: editorTextLimit },
						// An interrupted edit, note or reply can already exist in the shared store.
						replay: "unsafe",
						executionMode: "sequential",
						async execute(input, api, context) {
							const id = api.conversationId;
							const signal = context.abortSignal ? AbortSignal.any([host.signal, context.abortSignal]) : host.signal;
							signal.throwIfAborted();
							const room = rooms.get(id) ?? (await createRoom(id, signal, () => api.agent(context)));
							const related = requestActions.has(input.op)
								? await placedInvitation(input, pending.get(id), context)
								: undefined;
							const { content, value } = editorResult(await room.tool(input, signal, related));
							return { output: content, structuredOutput: value };
						},
					}),
				],
			});
		},
	};
}
