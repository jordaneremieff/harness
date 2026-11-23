import { copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { actionErrorCause } from "./action-outcome.ts";

export function createIdCommand(copy = copyToClipboard) {
	return {
		description: "Show and copy the current Pi session ID",
		handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return;
			if (args.trim()) {
				ctx.ui.notify("Use /id without arguments to show the session ID.", "warning");
				return;
			}
			const id = ctx.sessionManager.getSessionId();
			// Pi's clipboard helper can write terminal escapes to stdout, which RPC reserves for JSON.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`Session ID ${id}`, "info");
				return;
			}
			try {
				await copy(id);
				ctx.ui.notify(`Session ID ${id} copied.`, "info");
			} catch (error) {
				ctx.ui.notify(`Session ID ${id} was not copied: ${actionErrorCause(error)}`, "warning");
			}
		},
	};
}
