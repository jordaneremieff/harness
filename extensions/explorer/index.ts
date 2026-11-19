import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ExplorerUpdater } from "./app-update.ts";
import { commandHelp, commandInput, completions, openExplorer, ordinaryLifecycle } from "./command.ts";
import { toolDisplay } from "./display.ts";
import { explorerContribution } from "./durable.ts";
import { ordinaryLive } from "./live-host.ts";
import { isRecord } from "./live-protocol.ts";
import { publishSettings, readSettings } from "./settings.ts";
import {
	NOTES_DESCRIPTION,
	type NotesInput,
	NotesParameters,
	type Outcome,
	outcomeContent,
	runNotes,
	runShow,
	type ShowInput,
	ShowParameters,
	showDescription,
	showGuidance,
	ToolOutcomeSchema,
} from "./tools.ts";

const singleLine = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 1024);
function result(value: Outcome) {
	return {
		content: outcomeContent(value),
		structuredContent: JSON.parse(JSON.stringify(value)),
		details: { summary: value.summary },
		isError: !value.ok,
	};
}
export default function explorer(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const { app, dir, agentPane } = readSettings({ agentDir }).values;
	const lifecycle = ordinaryLifecycle(pi);
	const live = ordinaryLive(pi, lifecycle);
	const updater = new ExplorerUpdater();
	const updateUi = new AbortController();
	pi.on("session_shutdown", (_event, ctx) => {
		updateUi.abort();
		if (ctx.mode === "tui") ctx.ui.setStatus("explorer", undefined);
	});
	const stopSettings = publishSettings(pi.events, { agentDir });
	pi.events.emit("durable:contribution", explorerContribution(fileURLToPath(import.meta.url), pi.events, stopSettings));

	const update = (ctx: ExtensionContext, explicit = false) => {
		const signal = updateUi.signal;
		void updater.check(
			app,
			{
				notify: (text, error) => {
					if (!signal.aborted) ctx.ui.notify(singleLine(text), error ? "error" : "info");
				},
				status: (text) => {
					if (!signal.aborted) ctx.ui.setStatus("explorer", text);
				},
			},
			explicit,
		);
	};
	pi.on("session_start", (event, ctx) => {
		if (ctx.mode === "tui" && (event.reason === "startup" || event.reason === "reload")) update(ctx);
	});
	pi.registerCommand("explorer", {
		description: "Browse local files, changes and notes next to this conversation",
		getArgumentCompletions: completions,
		async handler(args, ctx) {
			const signal = lifecycle();
			try {
				const input = commandInput(args);
				if (input.mode === "help") return ctx.ui.notify(commandHelp(input.value ?? ""), "info");
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Explorer opens no pane outside interactive Pi.", "info");
					return;
				}
				if (input.mode === "update") {
					update(ctx, true);
					return;
				}
				await openExplorer(input, { app, dir, agentDir, cwd: ctx.cwd, signal, connect: () => live.connection(ctx) });
			} catch (error) {
				if (signal.aborted) return;
				ctx.ui.notify(
					singleLine(error instanceof Error ? error.message : "Explorer could not open the location."),
					"error",
				);
			}
		},
	});
	const [showCard, notesCard] = toolDisplay().tools;
	pi.registerTool({
		...showCard,
		name: "explorer_show",
		label: "Explorer",
		description: showDescription(agentPane),
		promptGuidelines: [showGuidance(agentPane)],
		parameters: ShowParameters,
		outputSchema: ToolOutcomeSchema,
		async execute(_id, input, signal, _update, ctx) {
			const combined = signal ? AbortSignal.any([signal, lifecycle()]) : lifecycle();
			return result(
				await runShow(input as ShowInput, {
					app,
					dir,
					agentDir,
					cwd: ctx.cwd,
					signal: combined,
					...(ctx.mode === "tui" ? { find: () => live.find(ctx), connect: () => live.connection(ctx) } : {}),
				}),
			);
		},
	});
	pi.registerTool({
		...notesCard,
		name: "explorer_notes",
		label: "Explorer notes",
		description: NOTES_DESCRIPTION,
		parameters: NotesParameters,
		outputSchema: ToolOutcomeSchema,
		async execute(_id, input, signal, _update, ctx) {
			return result(await runNotes(input as NotesInput, { cwd: ctx.cwd, dir, signal }));
		},
	});
	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", toolDisplay());
	const requestDisplay = pi.events.on("harness:tool-display:request", (value) => {
		if (isRecord(value) && value.version === 1) publishDisplay();
	});
	publishDisplay();
	const publishPalette = () =>
		pi.events.emit("harness:palette:publish", {
			version: 1,
			source: "explorer",
			commands: [
				{
					id: "explorer.folder",
					title: "Explore a Folder…",
					description: "Open a recent folder in Explorer",
					argv: [process.execPath, fileURLToPath(new URL("./palette-command.ts", import.meta.url)), dir, app],
				},
			],
		});
	const requestPalette = pi.events.on("harness:palette:request", (value) => {
		if (isRecord(value) && value.version === 1) publishPalette();
	});
	publishPalette();
	pi.on("session_shutdown", () => {
		requestDisplay();
		requestPalette();
		stopSettings();
	});
}
