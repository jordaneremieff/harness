import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type * as Durable from "@earendil-works/pi-durable";
import { editorInvitationBody, editorInvitationGuidance } from "./ordinary-invitations.ts";
import { editorOutputSchema, editorResult, editorTextLimit } from "./ordinary-result.ts";
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

export function contribution(source: string) {
	return {
		name: "editor",
		source,
		create(host: EditorHost): Durable.Extension {
			const { defineExtension, defineTool, section } = host.durable;
			const rooms = new Map<Durable.ConversationId, EditorRoom>();
			const admissionContext = withAbortSignal(host.signal, BACKGROUND_CONTEXT);
			host.onClose(async () => {
				const closing = [...rooms.values()];
				rooms.clear();
				const results = await Promise.allSettled(closing.map((room) => room.close()));
				const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (failures.length) throw new AggregateError(failures, "Editor rooms did not close");
			});
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
							let room = rooms.get(id);
							if (!room) {
								const [{ EditorRoom }, agent] = await Promise.all([import("./room.ts"), api.agent(context)]);
								signal.throwIfAborted();
								room = rooms.get(id);
								if (!room) {
									const actor = {
										id: `durable:${host.storageId}:${id}`,
										label: `Agent ${host.storageId.slice(0, 8)}/${id}`,
										kind: "durable",
									} as const;
									room = new EditorRoom(host.agentDir, agent.cwd ?? host.cwd, actor, async (invite) => {
										host.signal.throwIfAborted();
										const body = editorInvitationBody(invite);
										const target = await host.harness.conversation(id, admissionContext);
										if (!target) throw new Error("The selected agent conversation is no longer available");
										await target.submit(
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
									});
									rooms.set(id, room);
								}
							}
							const { content, value } = editorResult(await room.tool(input, signal));
							return { output: content, structuredOutput: value };
						},
					}),
				],
			});
		},
	};
}
