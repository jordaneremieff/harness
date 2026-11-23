import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
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
	type RecordArgs,
	RecordParams,
	VIEW_DESCRIPTION,
	type ViewArgs,
	ViewParams,
} from "./operations.ts";
import { terminalText } from "./presentation-text.ts";
import { publishSettings, readSettings } from "./settings.ts";
import { type Identity, readCatalog, saveFlag, setDisabled } from "./store.ts";
import type { ViewState } from "./view.ts";

function identity(ctx: ExtensionContext): Identity {
	return {
		session: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
	};
}

function lastReply(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>) {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		if (text.trim()) return { text, model: `${message.provider}/${message.model}` };
	}
}

function flagReply(pi: ExtensionAPI, ctx: ExtensionContext, root: string, note: string) {
	const reply = lastReply(ctx.sessionManager.getBranch());
	if (!reply) throw new Error("There is no assistant reply to flag in this session.");
	saveFlag(root, reply.text, note, { ...identity(ctx), model: reply.model });
	pi.sendUserMessage(
		`I flagged your last assistant reply as slop. Name the tells in plain words. Read the catalog and use slop_record for each tell it does not cover, with the flagged passage as a Slop example and your repair as a Better example. Add a detector when the tell has a fixed wording or form that a phrase list or pattern finds without matching the repair. ${note ? `Then act on this note. If it has no other request, give the corrected reply.\n\n${note}` : "Then give the corrected reply."}`,
		{ deliverAs: "followUp" },
	);
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
		parameters: ViewParams,
		execute: async (_id, args: ViewArgs) => inspectCatalog(options, args),
	});
	pi.registerTool<typeof CheckParams>({
		...checkCard,
		name: "slop_check",
		label: "Slop check",
		description: CHECK_DESCRIPTION,
		parameters: CheckParams,
		execute: async (_id, args: CheckArgs, signal, _update, ctx) => check(options, ctx.cwd, args, signal),
	});
	pi.registerTool<typeof RecordParams>({
		...recordCard,
		name: "slop_record",
		label: "Slop record",
		description: RECORD_DESCRIPTION,
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
		description: "Browse slop entries, or use /slop flag [note] on the last reply.",
		handler: async (args, ctx) => {
			try {
				const flag = /^flag(?:\s+([\s\S]*))?$/.exec(args.trim());
				if (flag) return flagReply(pi, ctx, root(), flag[1] ?? "");
				if (args.trim()) throw new Error("Use /slop or /slop flag [note].");
				await openBrowser(ctx);
			} catch (error) {
				ctx.ui.notify(terminalText(error instanceof Error ? error.message : String(error)), "error");
			}
		},
	});
}
