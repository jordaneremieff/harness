import { copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export function createIdCommand(copy = copyToClipboard) {
	return {
		description: "Show and copy the current Pi session ID",
		handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return;
			if (args.trim()) {
				ctx.ui.notify("Usage: /id", "warning");
				return;
			}
			const id = ctx.sessionManager.getSessionId();
			// Pi's clipboard helper can write terminal escapes to stdout, which RPC reserves for JSON.
			let copied = false;
			if (ctx.mode === "tui") {
				try {
					await copy(id);
					copied = true;
				} catch {
					// The ID remains available to copy by hand.
				}
			}
			ctx.ui.notify(`Session ID ${id} ${copied ? "copied" : "not copied"}`, copied ? "info" : "warning");
		},
	};
}
