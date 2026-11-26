import {
	type AgentBeforeSettleEvent,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "@earendil-works/pi-schema";
import { addEditorApplicationContext, editorApplicationMessage, editorInvitationId } from "./ordinary-invitations.ts";
import { editorOutputSchema, editorResult } from "./ordinary-result.ts";
import type { Invitation } from "./participants.ts";
import type { EditorRoom } from "./room.ts";
import { editorParameters, editorToolDescription } from "./schema.ts";

type InviteDraft = ReturnType<typeof editorApplicationMessage>;
type Pending = { draft: InviteDraft; placement: "idle" | "starting" | "queued" | "restored" };
type Binding = {
	id: string;
	cwd: string;
	room: Promise<EditorRoom>;
	pending: Map<string, Pending>;
};

export function registerOrdinary(pi: ExtensionAPI): void {
	let current: Binding | undefined;
	let shuttingDown = false;

	async function closeRoom(ctx: ExtensionContext): Promise<void> {
		const old = current;
		current = undefined;
		if (!old) return;
		for (const { draft, placement } of old.pending.values()) {
			if (placement !== "restored") reportNoRun(ctx, draft);
		}
		old.pending.clear();
		const room = await old.room.catch(() => undefined);
		await room?.close();
	}

	async function acceptInvite(
		invite: Invitation,
		ctx: ExtensionContext,
		id: string,
		room: Promise<EditorRoom>,
		pending: Map<string, Pending>,
	): Promise<void> {
		if (current?.room !== room || ctx.sessionManager.getSessionId() !== id) {
			throw new Error("The selected Pi session is no longer connected to the editor");
		}
		if (!ctx.model) throw new Error("The selected Pi session has no model");
		if (pending.has(invite.id)) return;
		if (pending.size >= 32) throw new Error("The selected Pi session has too many pending editor invitations");
		const draft = editorApplicationMessage(invite);
		pending.set(invite.id, { draft, placement: ctx.isIdle() ? "idle" : "queued" });
		try {
			const { type: _type, ...message } = draft;
			pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
		} catch (error) {
			pending.delete(invite.id);
			throw error;
		}
	}

	function getBinding(ctx: ExtensionContext): Binding {
		if (shuttingDown) throw new Error("The Pi session is closed");
		const id = ctx.sessionManager.getSessionId();
		if (current?.id === id && current.cwd === ctx.cwd) return current;
		const before = closeRoom(ctx);
		const pending = new Map<string, Pending>();
		const room: Promise<EditorRoom> = Promise.all([import("./room.ts"), before]).then(([{ EditorRoom }]) => {
			if (current?.room !== room) throw new Error("The Pi session changed before the editor opened");
			const name = ctx.sessionManager
				.getSessionName()
				?.replace(/[\p{Cc}\p{Cf}]/gu, " ")
				.trim();
			const label = name?.slice(0, 80).replace(/[\ud800-\udbff]$/, "") || `Pi ${id.slice(0, 8)}`;
			return new EditorRoom(getAgentDir(), ctx.cwd, { id: `ordinary:${id}`, label, kind: "ordinary" }, (invite) =>
				acceptInvite(invite, ctx, id, room, pending),
			);
		});
		current = { id, cwd: ctx.cwd, room, pending };
		void room.catch(() => {
			if (current?.room === room) current = undefined;
		});
		return current;
	}

	function reportNoRun(ctx: ExtensionContext, draft: InviteDraft): void {
		ctx.ui.notify(`Editor invitation #${draft.details.id.slice(0, 8).toLowerCase()} did not start a turn.`, "warning");
	}

	function sessionPending(ctx: ExtensionContext): Map<string, Pending> | undefined {
		return current?.id === ctx.sessionManager.getSessionId() ? current.pending : undefined;
	}

	function recover(event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext) {
		const pending = sessionPending(ctx);
		if (!pending?.size || event.context.pendingMessages.length !== 0) return;
		const entries: InviteDraft[] = [];
		for (const item of pending.values()) {
			if (item.placement !== "queued") continue;
			entries.push(item.draft);
			item.placement = "restored";
		}
		if (entries.length) return { entries, continue: true };
	}

	pi.registerCommand("editor", {
		description: "Open a folder or file in Editor and connect this session",
		async handler(args, ctx) {
			if (ctx.mode !== "tui") throw new Error("Open the editor from interactive Pi. Agents use the editor tool.");
			const room = await getBinding(ctx).room;
			const message = await room.command(args);
			ctx.ui.notify(message, "info");
		},
	});
	pi.registerTool({
		name: "editor",
		label: "Editor",
		description: editorToolDescription,
		parameters: editorParameters,
		outputSchema: editorOutputSchema,
		executionMode: "sequential",
		async execute(_id, input: Static<typeof editorParameters>, signal, _update, ctx) {
			signal?.throwIfAborted();
			const room = await getBinding(ctx).room;
			const { content, value } = editorResult(await room.tool(input, signal));
			return { content, structuredContent: value, details: undefined };
		},
	});

	pi.on("context", (event) => {
		const messages = addEditorApplicationContext(event.messages);
		if (messages) return { messages };
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType !== "custom") return;
		const id = editorInvitationId(event.message);
		const item = id && sessionPending(ctx)?.get(id);
		if (item) item.placement = "starting";
	});
	pi.on("message_start", (event, ctx) => {
		const pending = sessionPending(ctx);
		if (!pending?.size) return;
		const id = editorInvitationId(event.message);
		if (id) pending.delete(id);
	});
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.signal?.aborted) return;
		const pending = sessionPending(ctx);
		if (!pending?.size) return;
		for (const [id, invite] of pending) if (invite.placement === "restored") pending.delete(id);
	});
	pi.on("turn_end", recover);
	pi.on("agent_before_settle", recover);
	pi.on("agent_settled", (_event, ctx) => {
		const pending = sessionPending(ctx);
		if (!pending?.size) return;
		for (const [id, { draft, placement }] of pending) {
			if (placement !== "starting") continue;
			pending.delete(id);
			reportNoRun(ctx, draft);
		}
	});
	pi.on("session_tree", async (_event, ctx) => await closeRoom(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		await closeRoom(ctx);
	});
}
