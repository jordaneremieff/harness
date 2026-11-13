import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { LoadingView, openOperatorFrame, publishOperatorViews } from "../../operator-ui/registration.ts";
import { markdownContribution } from "./durable.ts";
import { readSettings, publishSettings } from "./settings.ts";
import { MarkdownStore } from "./store.ts";
import { createPublishTool, fileSnapshotInput } from "./publish.ts";
import { toolDisplay } from "./display.ts";
import { readOrdinary, recentOrdinary, type ResponseSnapshot } from "./responses.ts";
import type { MarkdownOperations, MarkdownScope, MarkdownViewState } from "./operator-view.ts";

const OWNER = fileURLToPath(import.meta.url);
const localSettings = () => readSettings({ agentDir: getAgentDir() }).values;
const clean = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 500);
export function markdownCompletions(prefix: string) {
	return ["recent", "published", "file"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
}
function latest(ctx: ExtensionContext): ResponseSnapshot {
	const recent = recentOrdinary(ctx.sessionManager, { results: 1 });
	const row = recent.rows[0];
	if (!row) throw new Error(`No retained assistant response with text was found (stop: ${recent.stop}).`);
	return readOrdinary(ctx.sessionManager, row.entryId, recent.cutoff);
}
export function ordinaryLifecycle(pi: Pick<ExtensionAPI, "on">): () => AbortSignal {
	let controller = new AbortController();
	const withdraw = () => { controller.abort(); controller = new AbortController(); };
	pi.on("session_before_switch", withdraw);
	pi.on("session_before_fork", withdraw);
	pi.on("session_before_tree", withdraw);
	pi.on("session_shutdown", withdraw);
	return () => controller.signal;
}
/** Every ordinary entry point uses the same action functions as the view. */
export function ordinaryOperations(ctx: ExtensionContext, lifecycle: () => AbortSignal): MarkdownOperations {
	const source = ctx.sessionManager;
	const sessionId = source.getSessionId();
	const root = localSettings().dir;
	let cutoff = source.getLeafId();
	const check = (signal: AbortSignal) => { signal.throwIfAborted(); if (source.getSessionId() !== sessionId) throw new Error("The current session changed."); };
	return {
		load: async (scope, viewSignal) => {
			const signal = AbortSignal.any([viewSignal, lifecycle()]);
			check(signal);
			if (scope === "recent") {
				const recent = recentOrdinary(source);
				cutoff = recent.cutoff;
				return { rows: recent.rows.map((response) => ({ kind: "response", response })), coverage: `${recent.rows.length} response${recent.rows.length === 1 ? "" : "s"} · ${recent.visited} entries visited · stop: ${recent.stop} · previews only` };
			}
			const page = await new MarkdownStore(root).list({ kind: "published" });
			check(signal);
			const rows = page.documents;
			return { rows: rows.map((document) => ({ kind: "document", document, root })), coverage: `${rows.length} document${rows.length === 1 ? "" : "s"} · ${page.scanned} scanned${page.bounded ? " · scan limit reached" : ""}` };
		},
		read: async (row, viewSignal) => {
			const signal = AbortSignal.any([viewSignal, lifecycle()]);
			check(signal);
			const response = row.kind === "response" ? readOrdinary(source, row.response.entryId, cutoff) : undefined;
			const id = row.kind === "document" ? row.document.id : undefined;
			const reveal = await import("./reveal.ts");
			check(signal);
			const result = await (response ? reveal.openResponse(response, signal, ctx.mode === "tui") : reveal.openStored(root, id ?? "", signal, { gui: ctx.mode === "tui" }));
			check(signal);
			return result;
		},
		latest: async (viewSignal) => {
			const signal = AbortSignal.any([viewSignal, lifecycle()]);
			check(signal);
			const response = latest(ctx);
			const reveal = await import("./reveal.ts");
			check(signal);
			const result = await reveal.openResponse(response, signal, ctx.mode === "tui");
			check(signal);
			return result;
		},
	};
}
function notice(ctx: ExtensionContext, text: string, error = false): void {
	ctx.ui.notify(text, error ? "error" : "info");
}
/** A leading `~` names the home directory, as in a shell path. */
const expandHome = (path: string) => path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
async function openFile(ctx: ExtensionContext, path: string, signal: AbortSignal): Promise<string> {
	if (!path) throw new Error("Use /markdown file <path>.");
	const settings = localSettings();
	const input = await fileSnapshotInput(expandHome(path), { cwd: ctx.cwd, app: settings.app });
	signal.throwIfAborted();
	const reveal = await import("./reveal.ts");
	signal.throwIfAborted();
	return reveal.revealNotice(await reveal.materializeAndReveal(async () => {
		const store = new MarkdownStore(settings.dir);
		const result = await store.snapshot(`file\0${input.contentOrigin.path}`, "file", input);
		signal.throwIfAborted();
		const identity = await store.initialise();
		signal.throwIfAborted();
		return { root: settings.dir, storeId: identity.storeId, documentId: result.document.id, revision: result.revision.revision, digest: result.revision.digest };
	}, signal, { gui: ctx.mode === "tui" }));
}
export default function markdown(pi: ExtensionAPI): void {
	const states = new Map<string, MarkdownViewState>();
	const lifecycle = ordinaryLifecycle(pi);
	const stopSettings = publishSettings(pi.events, { agentDir: getAgentDir() });
	pi.on("session_shutdown", stopSettings);
	pi.events.emit("durable:contribution", markdownContribution(OWNER, pi.events, stopSettings));
	const stateFor = (ctx: ExtensionContext): MarkdownViewState => {
		const id = ctx.sessionManager.getSessionId();
		let state = states.get(id);
		if (!state) { state = { scope: "recent", query: "" }; states.set(id, state); }
		return state;
	};
	publishOperatorViews(pi, { version: 2, owner: OWNER, views: [{ id: "markdown", label: "Markdown", command: { name: "markdown", args: "recent" }, order: 25,
		view: (ctx, host) => new LoadingView("Markdown", host, async () => {
			const module = await import("./operator-view.ts");
			return module.markdownView(host, ordinaryOperations(ctx, lifecycle), stateFor(ctx));
		}),
	}] });
	const action = async (args: string, ctx: ExtensionContext) => {
		const signal = lifecycle();
		try {
			const value = args.trim();
			const operations = ordinaryOperations(ctx, lifecycle);
			if (["recent", "published"].includes(value)) {
				const scope = value as MarkdownScope;
				stateFor(ctx).scope = scope;
				if (ctx.mode === "tui") await openOperatorFrame(pi, ctx, { owner: OWNER, id: "markdown" });
				else {
					const list = await operations.load(scope, signal);
					notice(ctx, [list.coverage, ...list.rows.map((row) => row.kind === "response" ? `${row.response.entryId}: ${clean(row.response.preview)}` : `${row.document.id}: ${clean(row.document.title)}`)].join("\n"));
				}
				return;
			}
			let result: string;
			if (!value) result = await operations.latest(signal);
			else if (value === "file" || value.startsWith("file ")) result = await openFile(ctx, value.slice(4).trim().replace(/^"(.*)"$/u, "$1"), signal);
			else {
				const reveal = await import("./reveal.ts");
				signal.throwIfAborted();
				result = await reveal.openStored(localSettings().dir, value, signal, { gui: ctx.mode === "tui" });
			}
			if (!signal.aborted) notice(ctx, result);
		} catch (error) { if (!signal.aborted) notice(ctx, clean(error), true); }
	};
	pi.registerCommand("markdown", { description: "Read the latest response; browse recent responses or published documents; open an ID or file", getArgumentCompletions: markdownCompletions, handler: action });
	pi.registerShortcut("ctrl+alt+r", { description: "Read the latest assistant response in Markdown", handler: (ctx) => action("", ctx) });
	pi.registerTool(createPublishTool({ store: new MarkdownStore(localSettings().dir), app: localSettings().app }));
	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", toolDisplay());
	pi.events.on("harness:tool-display:request", (request) => { if (typeof request === "object" && request !== null && "version" in request && request.version === 1) publishDisplay(); });
	publishDisplay();
}
