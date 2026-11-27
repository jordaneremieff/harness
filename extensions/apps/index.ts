/** Real macOS application windows docked to terminal panes. */

import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { AppPaneUpdater, readAppPaneBuild } from "./app-update.ts";
import { toolDisplay } from "./display.ts";
import {
	outcomeText,
	resolveWith,
	runShow,
	SHOW_DESCRIPTION,
	SHOW_GUIDELINES,
	SHOW_SNIPPET,
	type ShowInput,
	ShowParameters,
} from "./show.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export default function apps(pi: ExtensionAPI): void {
	const app = join(getAgentDir(), "apps", "AppPane.app");
	const updater = new AppPaneUpdater();
	const lifetime = new AbortController();
	const update = (ctx: ExtensionContext, explicit = false) => {
		const signal = lifetime.signal;
		void updater.check(
			app,
			{
				notify: (text, level) => {
					if (!signal.aborted) ctx.ui.notify(text, level);
				},
				status: (text) => {
					if (!signal.aborted && ctx.mode === "tui") ctx.ui.setStatus("apps", text);
				},
			},
			explicit,
		);
	};
	pi.on("session_start", (event, ctx) => {
		if (ctx.mode === "tui" && (event.reason === "startup" || event.reason === "reload")) update(ctx);
	});
	pi.registerCommand("apps", {
		description: "Show macOS app windows in terminal panes; /apps update rebuilds App Pane",
		async handler(args, ctx) {
			const verb = args.trim();
			if (verb === "update") return update(ctx, true);
			ctx.ui.notify(
				verb
					? `Unknown /apps argument "${verb}". Use /apps update.`
					: "Ask an agent to open an app in a pane. /apps update rebuilds App Pane.",
				verb ? "warning" : "info",
			);
		},
	});
	const display = toolDisplay();
	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", toolDisplay());
	const requestDisplay = pi.events.on("harness:tool-display:request", (value) => {
		if (isRecord(value) && value.version === 1) publishDisplay();
	});
	publishDisplay();
	pi.registerTool({
		...display.tools[0],
		name: "apps_show",
		label: "App pane",
		description: SHOW_DESCRIPTION,
		promptSnippet: SHOW_SNIPPET,
		promptGuidelines: SHOW_GUIDELINES,
		parameters: ShowParameters,
		async execute(_id, input, signal, _update, ctx) {
			const outcome = await runShow(input as ShowInput, {
				app,
				installed: async () => (await readAppPaneBuild(app)) !== undefined,
				resolve: resolveWith,
				install: () => {
					if (ctx.mode !== "tui") return "App Pane is not installed. Run /apps update in interactive Pi.";
					update(ctx);
					return "App Pane is not installed yet; Pi started its build. Call apps_show again after Pi reports the install.";
				},
				...(signal ? { signal } : {}),
			});
			return { content: [{ type: "text", text: outcomeText(outcome) }], details: outcome, isError: !outcome.ok };
		},
	});
	pi.on("session_shutdown", (_event, ctx) => {
		lifetime.abort();
		requestDisplay();
		if (ctx.mode === "tui") ctx.ui.setStatus("apps", undefined);
	});
}
