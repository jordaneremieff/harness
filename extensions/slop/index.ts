import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkPrompt, parseCheckHint } from "./command.ts";
import { toolDisplay } from "./display.ts";
import { slopContribution } from "./durable.ts";
import {
	catalogSection,
	check,
	CHECK_DESCRIPTION,
	type CheckArgs,
	CheckParams,
	inspectCatalog,
	record,
	RECORD_DESCRIPTION,
	RECORD_GUIDELINES,
	type RecordArgs,
	RecordParams,
	SNIPPETS,
	VIEW_DESCRIPTION,
	type ViewArgs,
	ViewParams,
} from "./operations.ts";
import { terminalText } from "./presentation-text.ts";
import { publishSettings, readSettings } from "./settings.ts";
import { type Identity, readCatalog, setDisabled } from "./store.ts";
import type { ViewState } from "./view.ts";

function identity(ctx: ExtensionContext): Identity {
	return {
		session: ctx.sessionManager.getSessionId(),
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
	};
}

export default function slopExtension(pi: ExtensionAPI) {
	const options = { agentDir: getAgentDir() };
	const root = () => readSettings(options).values.dir;
	const [catalogCard, checkCard, recordCard] = toolDisplay().tools;
	const publish = () => pi.events.emit("harness:tool-display:publish", toolDisplay());
	const stopDisplay = pi.events.on("harness:tool-display:request", (value: unknown) => {
		if (value && typeof value === "object" && "version" in value && value.version === 1) publish();
	});
	publish();
	const stopSettings = publishSettings(pi.events, options);
	const stopPublications = () => {
		stopSettings();
		stopDisplay();
	};
	pi.events.emit("durable:contribution", slopContribution(fileURLToPath(import.meta.url), pi.events, stopPublications));

	pi.registerTool<typeof ViewParams>({
		...catalogCard,
		name: "slop",
		label: "Slop catalog",
		description: VIEW_DESCRIPTION,
		promptSnippet: SNIPPETS.slop,
		parameters: ViewParams,
		execute: async (_id, args: ViewArgs) => inspectCatalog(options, args),
	});
	pi.registerTool<typeof CheckParams>({
		...checkCard,
		name: "slop_check",
		label: "Slop check",
		description: CHECK_DESCRIPTION,
		promptSnippet: SNIPPETS.check,
		parameters: CheckParams,
		execute: async (_id, args: CheckArgs, signal, _update, ctx) => check(options, ctx.cwd, args, signal),
	});
	pi.registerTool<typeof RecordParams>({
		...recordCard,
		name: "slop_record",
		label: "Slop record",
		description: RECORD_DESCRIPTION,
		promptSnippet: SNIPPETS.record,
		promptGuidelines: RECORD_GUIDELINES,
		parameters: RecordParams,
		execute: async (_id, args: RecordArgs, signal, _update, ctx) => {
			signal?.throwIfAborted();
			return record(options, args, identity(ctx));
		},
	});

	pi.on("before_agent_start", (event) => {
		delete event.systemPromptOptions.sections.slop;
		const text = catalogSection(options);
		if (text !== undefined) event.systemPromptOptions.sections.slop = text;
	});

	const state: ViewState = { query: "" };
	let opening = false;
	let closed = false;
	let closeView: (() => void) | undefined;
	pi.on("session_shutdown", () => {
		closed = true;
		closeView?.();
		stopPublications();
	});
	async function openBrowser(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") throw new Error("The slop browser requires the interactive terminal.");
		if (opening || closed) return;
		opening = true;
		try {
			const { openView } = await import("./view.ts");
			if (!closed)
				await openView(ctx, state, {
					entries: () => readCatalog(root()),
					setDisabled: (id, disabled) => setDisabled(root(), id, disabled, identity(ctx)),
					attach: (close) => {
						closeView = close;
					},
				});
		} finally {
			opening = false;
			closeView = undefined;
		}
	}
	pi.registerCommand("slop", {
		description: "Browse the slop catalog or check this conversation's work with an optional hint.",
		getArgumentCompletions: (prefix) => ("check".startsWith(prefix) ? [{ value: "check", label: "check" }] : null),
		handler: async (args, ctx) => {
			try {
				const hint = parseCheckHint(args);
				if (hint !== undefined) {
					pi.sendMessage(
						{ customType: "slop-check-request", content: checkPrompt(hint), display: true },
						{ triggerTurn: true, deliverAs: "steer" },
					);
					return;
				}
				if (args.trim()) {
					ctx.ui.notify("Use /slop to browse, or /slop check [hint] to check your work.", "info");
					return;
				}
				await openBrowser(ctx);
			} catch (error) {
				ctx.ui.notify(terminalText(error instanceof Error ? error.message : String(error)), "error");
			}
		},
	});
}
