import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Frame } from "./frame.ts";
import { markdownContribution } from "./durable.ts";
import { createBriefTool } from "./brief-tool.ts";
import { writingOptions } from "./writing-config.ts";
import { readSettings, publishSettings } from "./settings.ts";
import { MarkdownStore } from "./store.ts";
import { coverageText, createPublishTool, fileSnapshotInput, referenceSummary } from "./publish.ts";
import { createReadTool } from "./read.ts";
import { toolDisplay } from "./display.ts";
import { readOrdinary, recentOrdinary, type ResponseSnapshot } from "./responses.ts";
import type { Presentation } from "./reveal.ts";
import type { MarkdownOperations, MarkdownScope, MarkdownViewState } from "./operator-view.ts";
import { MARKDOWN_USAGE, markdownHelp, markdownCompletions } from "./commands.ts";
import { ordinaryLive } from "./live-host.ts";
import { createLiveTool } from "./live-tool.ts";
import type { LiveConfig } from "./live-protocol.ts";
import { checkReader, updateNow, type UpdateReporter } from "./reader-update.ts";
type Connection = () => Promise<LiveConfig | undefined>;
export { markdownCompletions } from "./commands.ts";

const OWNER = fileURLToPath(import.meta.url);
const localSettings = () => readSettings({ agentDir: getAgentDir() }).values;
const clean = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 500);
function latest(ctx: ExtensionContext): ResponseSnapshot {
	const recent = recentOrdinary(ctx.sessionManager, { results: 1 });
	const row = recent.rows[0];
	if (!row) throw new Error(`No retained assistant response with text was found (stop: ${recent.stop}).`);
	return readOrdinary(ctx.sessionManager, row.entryId, recent.cutoff);
}
export function ordinaryLifecycle(pi: Pick<ExtensionAPI, "on">): () => AbortSignal {
	let controller = new AbortController();
	const withdraw = () => {
		controller.abort();
		controller = new AbortController();
	};
	pi.on("session_before_switch", withdraw);
	pi.on("session_before_fork", withdraw);
	pi.on("session_before_tree", withdraw);
	pi.on("session_shutdown", withdraw);
	return () => controller.signal;
}
/** Every ordinary entry point uses the same action functions as the view. */
export function ordinaryOperations(
	ctx: ExtensionContext,
	lifecycle: () => AbortSignal,
	presentation: Presentation = "pane",
	connection?: Connection,
): MarkdownOperations {
	const source = ctx.sessionManager;
	const sessionId = source.getSessionId();
	const root = localSettings().dir;
	let cutoff = source.getLeafId();
	const check = (signal: AbortSignal) => {
		signal.throwIfAborted();
		if (source.getSessionId() !== sessionId) throw new Error("The current session changed.");
	};
	return {
		load: async (scope, viewSignal) => {
			const signal = AbortSignal.any([viewSignal, lifecycle()]);
			check(signal);
			if (scope === "recent") {
				const recent = recentOrdinary(source);
				cutoff = recent.cutoff;
				return {
					rows: recent.rows.map((response) => ({ kind: "response", response })),
					coverage: `${recent.rows.length} response${recent.rows.length === 1 ? "" : "s"} · ${recent.visited} entries visited · stop: ${recent.stop} · previews only`,
				};
			}
			const page = await new MarkdownStore(root).list({ kind: "published" });
			check(signal);
			const rows = page.documents;
			return {
				rows: rows.map((document) => ({ kind: "document", document, root })),
				coverage: `${rows.length} document${rows.length === 1 ? "" : "s"} · ${page.scanned} scanned${page.bounded ? " · scan limit reached" : ""}${page.unreadable ? ` · ${page.unreadable} unreadable, not listed` : ""}`,
			};
		},
		read: async (row, viewSignal) => {
			const signal = AbortSignal.any([viewSignal, lifecycle()]);
			check(signal);
			const response = row.kind === "response" ? readOrdinary(source, row.response.entryId, cutoff) : undefined;
			const id = row.kind === "document" ? row.document.id : undefined;
			const reveal = await import("./reveal.ts");
			check(signal);
			const live = await connection?.();
			check(signal);
			const result = await (response
				? reveal.openResponse(response, signal, ctx.mode === "tui", presentation, live)
				: reveal.openStored(root, id ?? "", signal, {
						gui: ctx.mode === "tui",
						presentation,
						live,
						...(row.kind === "document"
							? { pin: { revision: row.document.revision, digest: row.document.digest } }
							: {}),
					}));
			check(signal);
			return result;
		},
		latest: async (viewSignal) => {
			const signal = AbortSignal.any([viewSignal, lifecycle()]);
			check(signal);
			const response = latest(ctx);
			const reveal = await import("./reveal.ts");
			check(signal);
			const live = await connection?.();
			check(signal);
			const result = await reveal.openResponse(response, signal, ctx.mode === "tui", presentation, live);
			check(signal);
			return result;
		},
		newScratchpad: async (viewSignal) => {
			const signal = AbortSignal.any([viewSignal, lifecycle()]);
			check(signal);
			if (ctx.mode !== "tui") throw new Error("Open New scratchpad in the Markdown operator view or native app.");
			const reveal = await import("./reveal.ts");
			check(signal);
			const live = await connection?.();
			check(signal);
			return reveal.openScratchpad(signal, { presentation, live });
		},
		edit: async (row, viewSignal, copy = false) => {
			const signal = AbortSignal.any([viewSignal, lifecycle()]);
			check(signal);
			if (ctx.mode !== "tui") throw new Error("Open Edit in the Markdown operator view or native app.");
			const response = row.kind === "response" ? readOrdinary(source, row.response.entryId, cutoff) : undefined;
			const reveal = await import("./reveal.ts");
			check(signal);
			const live = await connection?.();
			check(signal);
			if (response) return reveal.openEditorResponse(response, signal, { presentation, live });
			if (row.kind !== "document") throw new Error("Select a retained response or document.");
			return reveal.openEditorStored(root, row.document.id, copy ? "copy" : "edit", signal, {
				presentation,
				live,
				pin: { revision: row.document.revision, digest: row.document.digest },
			});
		},
	};
}
function notice(ctx: ExtensionContext, text: string, error = false): void {
	ctx.ui.notify(text, error ? "error" : "info");
}
/**
 * Keeps the reader app in step with the loaded harness. Each interactive start or reload on macOS
 * checks the installed app once; /markdown update installs on request. An update runs on after
 * this session ends; only this session's notices and footer status stop.
 */
export function readerUpdates(
	pi: Pick<ExtensionAPI, "on">,
	check: typeof checkReader = checkReader,
	update: typeof updateNow = updateNow,
): (ctx: ExtensionContext) => Promise<void> {
	const session = new AbortController();
	pi.on("session_shutdown", () => session.abort());
	const reporter = (ctx: ExtensionContext): UpdateReporter => ({
		notify: (text, error) => {
			if (!session.signal.aborted) notice(ctx, text, error);
		},
		status: (text) => {
			if (!session.signal.aborted) ctx.ui.setStatus("markdown-update", text);
		},
		active: () => !session.signal.aborted,
	});
	pi.on("session_start", (event, ctx) => {
		if (
			(event.reason !== "startup" && event.reason !== "reload") ||
			ctx.mode !== "tui" ||
			process.platform !== "darwin"
		)
			return;
		const settings = localSettings();
		const report = reporter(ctx);
		void check({ app: settings.app, store: settings.dir, reporter: report }).catch((error) =>
			report.notify(`The Markdown reader app check failed: ${clean(error)}`, true),
		);
	});
	return (ctx) => {
		const settings = localSettings();
		return update({ app: settings.app, store: settings.dir, reporter: reporter(ctx) });
	};
}
/** A leading `~` names the home directory, as in a shell path. */
const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);
async function openFile(
	ctx: ExtensionContext,
	path: string,
	signal: AbortSignal,
	presentation: Presentation,
	connection?: Connection,
): Promise<string> {
	if (!path) throw new Error(markdownHelp("file"));
	const settings = localSettings();
	const input = await fileSnapshotInput(expandHome(path), { cwd: ctx.cwd, app: settings.app });
	signal.throwIfAborted();
	const reveal = await import("./reveal.ts");
	signal.throwIfAborted();
	const live = await connection?.();
	signal.throwIfAborted();
	let coverage: string | undefined;
	const notice = reveal.revealNotice(
		await reveal.materializeAndReveal(
			async () => {
				const store = new MarkdownStore(settings.dir);
				const result = await store.snapshot(`file\0${input.contentOrigin.path}`, "file", input);
				coverage = coverageText(referenceSummary(result.revision.references), "file");
				signal.throwIfAborted();
				const identity = await store.initialise();
				signal.throwIfAborted();
				return {
					root: settings.dir,
					storeId: identity.storeId,
					documentId: result.document.id,
					revision: result.revision.revision,
					digest: result.revision.digest,
					newlySaved: !result.replayed,
				};
			},
			signal,
			{ gui: ctx.mode === "tui", presentation, live },
		),
	);
	return coverage ? `${notice} ${coverage}` : notice;
}
async function readSelection(
	value: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
	operations: MarkdownOperations,
	presentation: Presentation,
	connection?: Connection,
): Promise<string> {
	if (!value) return operations.latest(signal);
	if (value === "new") return operations.newScratchpad(signal);
	if (value === "edit" || value === "copy" || value.startsWith("edit ") || value.startsWith("copy "))
		return editSelection(value, ctx, signal, presentation, connection);
	if (value === "file" || value.startsWith("file "))
		return openFile(
			ctx,
			value
				.slice(4)
				.trim()
				.replace(/^"(.*)"$/u, "$1"),
			signal,
			presentation,
			connection,
		);
	if (!/^md-[0-9a-f]{1,20}$/u.test(value)) throw new Error(MARKDOWN_USAGE);
	const reveal = await import("./reveal.ts");
	signal.throwIfAborted();
	const live = await connection?.();
	signal.throwIfAborted();
	return reveal.openStored(localSettings().dir, value, signal, { gui: ctx.mode === "tui", presentation, live });
}
async function editSelection(
	value: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
	presentation: Presentation,
	connection?: Connection,
): Promise<string> {
	if (ctx.mode !== "tui")
		throw new Error("Use the Markdown operator view or native app to edit. No editor was opened.");
	const copy = value === "copy" || value.startsWith("copy ");
	const selected = value.slice(4).trim();
	const reveal = await import("./reveal.ts");
	const live = await connection?.();
	signal.throwIfAborted();
	if (!copy && selected.startsWith("file ")) {
		const path = selected
			.slice(5)
			.trim()
			.replace(/^"(.*)"$/u, "$1");
		if (!path) throw new Error(markdownHelp("edit"));
		return reveal.openEditorFile(resolve(ctx.cwd, expandHome(path)), signal, { presentation, live });
	}
	if (!/^md-[0-9a-f]{3,20}$/u.test(selected)) throw new Error(markdownHelp(copy ? "copy" : "edit"));
	return reveal.openEditorStored(localSettings().dir, selected, copy ? "copy" : "edit", signal, { presentation, live });
}
function readPresentation(value: string): { value: string; presentation: Presentation } {
	if (value === "window" || value.startsWith("window "))
		return { value: value.slice(6).trim(), presentation: "window" };
	return { value, presentation: "pane" };
}
export default function markdown(pi: ExtensionAPI): void {
	const states = new Map<string, MarkdownViewState>();
	const lifecycle = ordinaryLifecycle(pi);
	const updateReader = readerUpdates(pi);
	const live = ordinaryLive(pi);
	const connectionFor = (ctx: ExtensionContext, presentation: Presentation = "pane"): Connection | undefined =>
		ctx.mode === "tui" && presentation === "pane" ? () => live.connection(ctx) : undefined;
	const stopSettings = publishSettings(pi.events, { agentDir: getAgentDir() });
	let frame: Frame | undefined;
	let opening = false;
	pi.on("session_shutdown", () => {
		frame?.close();
		stopSettings();
	});
	pi.events.emit("durable:contribution", markdownContribution(OWNER, pi.events, stopSettings));
	const stateFor = (ctx: ExtensionContext): MarkdownViewState => {
		const id = ctx.sessionManager.getSessionId();
		let state = states.get(id);
		if (!state) {
			state = { scope: "recent", query: "" };
			states.set(id, state);
		}
		return state;
	};
	const browse = async (
		scope: MarkdownScope,
		ctx: ExtensionContext,
		operations: MarkdownOperations,
		signal: AbortSignal,
	) => {
		if (ctx.mode !== "tui") {
			stateFor(ctx).scope = scope;
			const list = await operations.load(scope, signal);
			notice(
				ctx,
				[
					list.coverage,
					...list.rows.map((row) =>
						row.kind === "response"
							? `${row.response.entryId}: ${clean(row.response.preview)}`
							: `${row.document.id}: ${clean(row.document.title)}`,
					),
				].join("\n"),
			);
			return;
		}
		if (opening || signal.aborted) return;
		opening = true;
		try {
			const [{ openFrame }, module] = await Promise.all([import("./frame.ts"), import("./operator-view.ts")]);
			if (signal.aborted) return;
			const state = stateFor(ctx);
			state.scope = scope;
			await openFrame(
				ctx,
				(host) => module.markdownView(host, operations, state),
				(current) => {
					frame = current;
				},
			);
		} finally {
			opening = false;
		}
	};
	const action = async (args: string, ctx: ExtensionContext) => {
		const signal = lifecycle();
		try {
			const input = args.trim();
			if (input === "help" || input.startsWith("help ")) {
				notice(ctx, markdownHelp(input.slice(4).trim()));
				return;
			}
			if (input === "update") {
				await updateReader(ctx);
				return;
			}
			const { value, presentation } = readPresentation(input);
			const connection = connectionFor(ctx, presentation);
			const operations = ordinaryOperations(ctx, lifecycle, presentation, connection);
			if (presentation === "pane" && ["recent", "published"].includes(value)) {
				await browse(value as MarkdownScope, ctx, operations, signal);
				return;
			}
			const result = await readSelection(value, ctx, signal, operations, presentation, connection);
			if (!signal.aborted) notice(ctx, result);
		} catch (error) {
			if (!signal.aborted) notice(ctx, clean(error), true);
		}
	};
	pi.registerCommand("markdown", {
		description:
			"Read or write beside this conversation; use new, edit, copy, recent, published, file, window, update or help",
		getArgumentCompletions: markdownCompletions,
		handler: action,
	});
	pi.registerShortcut("ctrl+alt+r", {
		description: "Read the latest assistant response in Markdown",
		handler: (ctx) => action("", ctx),
	});
	const agentDir = getAgentDir();
	const snapshot = readSettings({ agentDir });
	const { dir, app, agentPane } = snapshot.values;
	const writing = writingOptions(agentDir, snapshot);
	pi.registerTool(createBriefTool(writing));
	pi.registerTool(
		createPublishTool({
			writing,
			store: new MarkdownStore(dir),
			app,
			connection: live.connection,
			panes: async (ctx) => (await live.find(ctx))?.list().length ?? 0,
			pane: agentPane,
			paneNotices: true,
		}),
	);
	pi.registerTool(
		createReadTool({
			store: new MarkdownStore(dir),
			app,
			connection: live.connection,
		}),
	);
	pi.registerTool(createLiveTool(live.find));
	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", toolDisplay());
	pi.events.on("harness:tool-display:request", (request) => {
		if (typeof request === "object" && request !== null && "version" in request && request.version === 1)
			publishDisplay();
	});
	publishDisplay();
}
