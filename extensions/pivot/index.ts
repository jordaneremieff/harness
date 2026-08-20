/**
 * pivot — frame the first message of a forked session.
 *
 * Pi forks (`pi --fork`, in-session `/fork`, `/clone`) copy the full parent
 * transcript, and the model reflexively resumes parent work. This extension
 * queues a compact task boundary as a hidden custom message on the fork's
 * first real interactive input, so the inherited transcript reads as
 * background context and the active request reads as the new task.
 *
 * The boundary is queued with `deliverAs: "nextTurn"` from the `input`
 * event: pi appends queued messages after the operator's user message, so
 * the boundary sits immediately after the active request — the highest
 * recency position. The operator's message stays byte-identical.
 *
 * The `input` event carries the source field, so programmatic first
 * messages (RPC, extension-injected) never consume the one-shot slot.
 * The boundary is hidden from the chat transcript (`display: false`) but
 * appears in `/tree`, which renders custom messages by content.
 */

import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildForkCommand } from "./command.ts";
import { PIVOT_CUSTOM_TYPE, shouldArm, type SessionEntryLike } from "./gates.ts";
import { pbCopy } from "./pb.ts";

const FORK_BOUNDARY = [
	"[fork task boundary]",
	"",
	"This session is a new fork. The user message immediately before this",
	"boundary is the active request. Everything earlier in this transcript,",
	"including any earlier fork boundary, is inherited context from a parent",
	"session, not active work. Do not resume parent work unless the active",
	"request explicitly asks for it.",
].join("\n");

const STATUS_KEY = "pivot";
const STATUS_ARMED = "fork boundary armed — next message will be framed";

export default function (pi: ExtensionAPI) {
	// Per-session state: extensions load fresh per session, so module-scope
	// state is per-session state. Reconstructed from session entries on
	// every session_start, so reload and restart evaluate the same gates.
	let armed = false;

	function setStatus(
		ctx: { hasUI?: boolean; ui?: { setStatus?: (key: string, value?: string) => void } },
		value: string | undefined,
	) {
		if (ctx.hasUI && ctx.ui?.setStatus) ctx.ui.setStatus(STATUS_KEY, value);
	}

	pi.on("session_start", (_event, ctx) => {
		const header = ctx.sessionManager.getHeader();
		const result = shouldArm({
			hasParent: Boolean(header?.parentSession),
			entries: ctx.sessionManager.getEntries() as SessionEntryLike[],
			leafId: ctx.sessionManager.getLeafId(),
			sessionId: ctx.sessionManager.getSessionId(),
		});
		if (result.record) {
			pi.appendEntry(PIVOT_CUSTOM_TYPE, {
				sessionId: ctx.sessionManager.getSessionId(),
				forkPointLeafId: result.forkPointLeafId,
			});
		}
		armed = result.arm;
		setStatus(ctx, armed ? STATUS_ARMED : undefined);
	});

	pi.on("input", (event, ctx) => {
		if (!armed) return { action: "continue" };
		// Only real human input consumes the slot. Slash commands for known
		// commands never reach this event (command dispatch precedes it); an
		// unrecognized slash or a skill/template command is a real first
		// message and consumes the boundary like any other text.
		if (event.source !== "interactive") return { action: "continue" };
		if (event.text.trim() === "" && (event.images?.length ?? 0) === 0) {
			return { action: "continue" };
		}
		// Disarm at queue time, not at consumption: a failed preflight keeps
		// the queued boundary for the retry without a second queue.
		armed = false;
		setStatus(ctx, undefined);
		pi.sendMessage(
			{ customType: PIVOT_CUSTOM_TYPE, content: FORK_BOUNDARY, display: false },
			{ deliverAs: "nextTurn" },
		);
		return { action: "continue" };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		armed = false;
		setStatus(ctx, undefined);
	});

	pi.registerCommand("pivot", {
		description: "Copy a pi --fork command for this session to the clipboard",
		handler: async (_args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("No session file (ephemeral session)", "error");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish before pivoting", "warning");
				return;
			}
			const command = buildForkCommand(ctx.cwd, sessionFile);
			if (!command.ok) {
				ctx.ui.notify(command.error, "error");
				return;
			}
			try {
				await pbCopy(command.text);
				ctx.ui.notify(`Fork command copied (${basename(sessionFile)})`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
