import { stat } from "node:fs/promises";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const INTENT = "pivot.intent";
const FRAME =
	"This is the start of a separate task. Use the earlier conversation as background only. Do not resume work from the parent session unless this request asks for it.\n\n";

function shellWord(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function hasFrame(content: string | ReadonlyArray<{ type: string; text?: string }>): boolean {
	return typeof content === "string"
		? content.startsWith(FRAME)
		: content.some((block) => block.type === "text" && block.text?.startsWith(FRAME));
}

export default function pivot(pi: ExtensionAPI, copy = copyToClipboard): void {
	let pendingSession: string | undefined;

	async function copyLaunch(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file || !(await stat(file).catch(() => undefined))?.isFile()) {
			ctx.ui.notify("There is no saved session to pivot from.", "warning");
			return;
		}
		const dir = ctx.sessionManager.getSessionDir();
		try {
			await copy(`cd -- ${shellWord(ctx.cwd)} && pi --fork ${shellWord(file)} --session-dir ${shellWord(dir)} --pivot`);
			ctx.ui.notify("Paste the pivot command into a new terminal.", "info");
		} catch (error) {
			ctx.ui.notify(`Could not copy the pivot command: ${String(error)}`, "error");
		}
	}

	const description = "Copy a command to fork this session for a separate task";
	pi.registerCommand("pivot", { description, handler: (_args, ctx) => copyLaunch(ctx) });
	pi.registerShortcut("ctrl+alt+n", { description, handler: copyLaunch });
	pi.registerFlag("pivot", { type: "boolean", description: "Treat this fork as the start of a separate task" });

	pi.on("session_start", (event, ctx) => {
		pendingSession = undefined;
		const header = ctx.sessionManager.getHeader();
		if (!ctx.hasUI || !header?.parentSession) return;

		// A fork copies custom entries as well as conversation messages. Only this session's intent applies.
		const entries = ctx.sessionManager.getEntries();
		const intent = entries.findLastIndex(
			(entry) => entry.type === "custom" && entry.customType === INTENT && entry.data === header.id,
		);
		if (intent < 0) {
			if (event.reason !== "startup" || pi.getFlag("pivot") !== true) return;
			pi.appendEntry(INTENT, header.id);
		} else if (
			entries
				.slice(intent + 1)
				.some((entry) => entry.type === "message" && entry.message.role === "user" && hasFrame(entry.message.content))
		) {
			return;
		}
		pendingSession = header.id;
	});

	pi.on("input", (event, ctx) => {
		if (!pendingSession || !ctx.hasUI || event.source !== "interactive") return;
		if (ctx.sessionManager.getSessionId() !== pendingSession || event.text.trimStart().startsWith("/")) return;
		if (!event.text.trim() && !event.images?.length) return;
		pendingSession = undefined;
		return { action: "transform", text: `${FRAME}${event.text}` };
	});
}
