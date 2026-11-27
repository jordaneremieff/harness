import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type AgentBeforeSettleEvent,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "@earendil-works/pi-schema";
import {
	addEditorApplicationContext,
	editorApplicationMessage,
	editorInvitationId,
	expectsEditorRunAnswer,
} from "./ordinary-invitations.ts";
import { editorOutputSchema, editorResult } from "./ordinary-result.ts";
import type { Invitation } from "./participants.ts";
import { answerText } from "./request-answer.ts";
import type { EditorRoom } from "./room.ts";
import { editorParameters, editorToolDescription } from "./schema.ts";

type InviteDraft = ReturnType<typeof editorApplicationMessage>;
type Pending = {
	invite: Invitation;
	draft: InviteDraft;
	placement: "idle" | "starting" | "queued" | "restored" | "working";
};
type Binding = {
	id: string;
	cwd: string;
	room: Promise<EditorRoom>;
	pending: Map<string, Pending>;
	writes: Map<string, { path: string; existed: boolean }>;
	answerInputs: number;
};

function toolPath(path: unknown, cwd: string): string | undefined {
	if (typeof path !== "string" || !path || path.includes("\0")) return;
	const value = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	return resolve(cwd, value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
}

function activeInvite(binding: Binding, doc?: unknown): Invitation | undefined {
	const working = [...binding.pending.values()].filter((item) => item.placement === "working");
	return (
		working.find(({ invite }) => doc === invite.doc || (invite.doc && doc === resolve(invite.root, invite.doc)))
			?.invite ?? working.at(-1)?.invite
	);
}

export function registerOrdinary(pi: ExtensionAPI): void {
	let current: Binding | undefined;
	let shuttingDown = false;

	async function closeRoom(ctx: ExtensionContext): Promise<void> {
		const old = current;
		current = undefined;
		if (!old) return;
		const room = await old.room.catch(() => undefined);
		for (const { invite, draft, placement } of old.pending.values()) {
			await room?.requestState(invite, "failed").catch(() => {});
			if (placement !== "restored" && placement !== "working") reportNoRun(ctx, draft);
		}
		old.pending.clear();
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
		pending.set(invite.id, { invite, draft, placement: ctx.isIdle() ? "idle" : "queued" });
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
		current = { id, cwd: ctx.cwd, room, pending, writes: new Map(), answerInputs: 0 };
		void room.catch(() => {
			if (current?.room === room) current = undefined;
		});
		return current;
	}

	function reportNoRun(ctx: ExtensionContext, draft: InviteDraft): void {
		ctx.ui.notify(`Editor invitation #${draft.details.id.slice(0, 8).toLowerCase()} did not start a turn.`, "warning");
	}

	function sessionBinding(ctx: ExtensionContext): Binding | undefined {
		return current?.id === ctx.sessionManager.getSessionId() ? current : undefined;
	}

	async function markWorking(binding: Binding, item: Pending) {
		if (item.placement === "working") return;
		item.placement = "working";
		const room = await binding.room;
		await room.requestState(item.invite, "working");
	}

	function recover(event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext) {
		const pending = sessionBinding(ctx)?.pending;
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
		description: "Connect this session to Editor or open it for a folder or file",
		async handler(args, ctx) {
			if (ctx.mode !== "tui") throw new Error("Open the editor from interactive Pi. Agents use the editor tool.");
			ctx.ui.setStatus("editor", "Connecting to Editor…");
			try {
				const room = await getBinding(ctx).room;
				ctx.ui.notify(await room.command(args), "info");
			} finally {
				ctx.ui.setStatus("editor", undefined);
			}
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
			const binding = getBinding(ctx);
			const room = await binding.room;
			const { content, value } = editorResult(await room.tool(input, signal, activeInvite(binding, input.doc)));
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
		const item = id && sessionBinding(ctx)?.pending.get(id);
		if (item) item.placement = "starting";
	});
	pi.on("message_start", async (event, ctx) => {
		const binding = sessionBinding(ctx);
		if (!binding || ctx.signal?.aborted) return;
		if (expectsEditorRunAnswer(event.message)) binding.answerInputs++;
		const id = editorInvitationId(event.message);
		const item = id ? binding.pending.get(id) : undefined;
		if (item) await markWorking(binding, item);
	});
	pi.on("turn_start", async (_event, ctx) => {
		const binding = sessionBinding(ctx);
		if (!binding || ctx.signal?.aborted) return;
		for (const item of binding.pending.values()) {
			if (item.placement !== "restored") continue;
			binding.answerInputs++;
			await markWorking(binding, item);
		}
	});
	pi.on("tool_call", async (event, ctx) => {
		if (shuttingDown || (event.toolName !== "write" && event.toolName !== "edit")) return;
		if (
			!pi
				.getAllTools()
				.some((tool) => tool.name === event.toolName && tool.sourceInfo.path === `builtin:${event.toolName}`)
		)
			return;
		const path = toolPath(event.input.path, ctx.cwd);
		if (!path) return;
		const binding = getBinding(ctx);
		if (binding.writes.size >= 128) binding.writes.delete(binding.writes.keys().next().value as string);
		binding.writes.set(event.toolCallId, {
			path,
			existed: await lstat(path).then(
				() => true,
				() => false,
			),
		});
	});
	pi.on("tool_result", async (event, ctx) => {
		const binding = sessionBinding(ctx);
		const before = binding?.writes.get(event.toolCallId);
		if (!binding || !before) return;
		binding.writes.delete(event.toolCallId);
		if (event.isError) return;
		const path = toolPath(event.input.path, ctx.cwd);
		if (!path) return;
		const room = await binding.room.catch(() => undefined);
		await room
			?.reportFile(path, path !== before.path || before.existed ? "modified" : "created", activeInvite(binding, path))
			.catch(() => {});
	});
	pi.on("turn_end", async (event, ctx) => {
		const binding = sessionBinding(ctx);
		if (
			binding &&
			event.outcome === "completed" &&
			event.message.role === "assistant" &&
			!ctx.signal?.aborted &&
			["stop", "length"].includes(event.message.stopReason)
		) {
			const body = answerText(event.message, Math.max(0, binding.answerInputs - 1));
			binding.answerInputs = 0;
			const room = await binding.room;
			for (const [id, item] of binding.pending) {
				if (item.placement !== "working") continue;
				binding.pending.delete(id);
				await room.requestState(item.invite, body ? "answered" : "failed", body);
			}
		}
		return recover(event, ctx);
	});
	pi.on("agent_before_settle", recover);
	pi.on("agent_settled", async (_event, ctx) => {
		const binding = sessionBinding(ctx);
		if (!binding) return;
		binding.answerInputs = 0;
		binding.writes.clear();
		const room = await binding.room;
		for (const [id, { invite, draft, placement }] of binding.pending) {
			if (placement !== "starting" && placement !== "working") continue;
			binding.pending.delete(id);
			await room.requestState(invite, "failed");
			if (placement === "starting") reportNoRun(ctx, draft);
		}
	});
	pi.on("session_tree", async (_event, ctx) => await closeRoom(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		await closeRoom(ctx);
	});
}
