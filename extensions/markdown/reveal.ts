import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readSettings } from "./settings.ts";
import type { LiveConfig } from "./live-protocol.ts";
import { liveArguments } from "./live-launch.ts";
import { MarkdownStore, type StoredDocument } from "./store.ts";
import { responseSnapshotWrite, type ResponseSnapshot } from "./responses.ts";
import { editorCommand, paneRequestCommand, type EditorOpenIntent } from "./pane-command.ts";
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILD_REMEDY = "Run node extensions/markdown/native/build.mts with this client's Markdown app setting.";
/** `newlySaved` is true only when this action wrote the revision; otherwise the document already existed. */
export interface SavedDocument { root: string; storeId: string; documentId: string; revision: number; digest: string; newlySaved: boolean }
/** The revision and digest of a listed row; the adapter opens that revision or nothing. */
export interface PinnedRevision { revision: number; digest: string }
export type LaunchOrigin = { version: 1; terminal: "Rex"; application: { bundleId: "com.superlogical.rex" }; exact?: Record<string, unknown> };
export type Presentation = "pane" | "window";
/** The placement receipt is opaque here; the terminal-pane contract owns its fields. */
export type PaneDispatch = { version: 1; outcome: "created" | "stale" | "unavailable" | "uncertain"; detail: string; receipt?: unknown };
export type RevealOutcome = SavedDocument & ({ state: "saved" } | { state: "accepted" | "not-confirmed"; request: string; pane?: PaneDispatch } | { state: "pane-unavailable" | "pane-uncertain"; request: string; pane: PaneDispatch } | { state: "reveal-failed"; reason: "app-missing" | "app-incompatible" | "unsupported-platform" | "launch-failed"; remedy: string });
/** Only tests replace the process runner; callers never supply an executable. */
export interface RevealRuntime {
	platform: string;
	acceptanceMs?: number;
	run(executable: string, args: string[], options: { timeout: number; maxBuffer: number; signal?: AbortSignal; input?: string }): Promise<{ stdout: string }>;
}
const runtime: RevealRuntime = { platform: process.platform, run: (executable, args, { input, ...options }) => new Promise((resolve, reject) => {
	const child = execFile(executable, args, { ...options, encoding: "utf8", killSignal: "SIGKILL" }, (error, stdout) => { if (error) reject(error); else resolve({ stdout }); });
	child.stdin?.on("error", () => {});
	child.stdin?.end(input);
}) };
export function readLaunchOrigin(value: unknown): LaunchOrigin | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const origin = value as Record<string, unknown>;
	const app = origin.application;
	if (origin.version !== 1 || origin.terminal !== "Rex" || typeof app !== "object" || app === null || !("bundleId" in app) || app.bundleId !== "com.superlogical.rex") return null;
	if (origin.exact !== undefined && (typeof origin.exact !== "object" || origin.exact === null || Array.isArray(origin.exact))) return null;
	return { version: 1, terminal: "Rex", application: { bundleId: "com.superlogical.rex" }, ...(origin.exact === undefined ? {} : { exact: origin.exact as Record<string, unknown> }) };
}
/** Exceeds the helper's own child deadline plus process start, so a slow terminal still yields the helper's result. */
const ORIGIN_TIMEOUT_MS = 4000;
async function captureOrigin(signal: AbortSignal, processRuntime: RevealRuntime): Promise<LaunchOrigin | null> {
	try {
		const result = await processRuntime.run(process.execPath, [join(PACKAGE_ROOT, "extensions", "rex", "terminal-origin.ts"), "capture"], { timeout: ORIGIN_TIMEOUT_MS, maxBuffer: 8192, signal });
		return readLaunchOrigin(JSON.parse(result.stdout));
	} catch { return null; }
}
/** An event-based deadline observes request consumption, not rendering or focus. */
export async function waitForAcceptance(request: string, signal: AbortSignal, milliseconds = 5000): Promise<boolean> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const done = (accepted: boolean, error?: unknown) => {
			clearTimeout(timer); watcher.close(); signal.removeEventListener("abort", abort);
			if (error) reject(error); else resolve(accepted);
		};
		const inspect = () => { void lstat(request).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") done(true); }); };
		const watcher = watch(dirname(request), (_event, name) => { if (name === basename(request)) inspect(); });
		const timer = setTimeout(() => done(false), milliseconds);
		const abort = () => done(false, signal.reason);
		watcher.on("error", () => done(false));
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort(); else inspect();
	});
}
async function storeIdentity(root: string): Promise<string> {
	try {
		const value = await new MarkdownStore(root).identity();
		if (!value) throw new Error("Store identity is absent.");
		return value.storeId;
	} catch { throw new Error("The document store is not readable on this machine. No document transfer route is configured."); }
}
function savedDocument(root: string, storeId: string, value: StoredDocument, newlySaved: boolean): SavedDocument {
	return { root, storeId, documentId: value.document.id, revision: value.revision.revision, digest: value.revision.digest, newlySaved };
}
export async function selectStored(root: string, id: string, expectedStoreId?: string, pin?: PinnedRevision): Promise<SavedDocument> {
	const storeId = await storeIdentity(root);
	if (expectedStoreId !== undefined && storeId !== expectedStoreId) throw new Error("The local store identity differs from the host's store. No document was opened.");
	if (expectedStoreId !== undefined) {
		if (!/^md-[a-f0-9]{20}$/u.test(id)) throw new Error("The published document is not locally available.");
		const directory = await lstat(join(root, "documents", id)).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!directory?.isDirectory()) throw new Error("The published document is not locally available.");
	}
	const value = await new MarkdownStore(root).get(id, pin?.revision);
	if (expectedStoreId !== undefined && value.document.kind !== "published") throw new Error("The host identity does not name a published document.");
	if (pin && value.revision.digest !== pin.digest) throw new Error("The selected revision differs from the listed one. No document was opened.");
	return savedDocument(root, storeId, value, false);
}
export async function saveResponse(response: ResponseSnapshot, root: string): Promise<SavedDocument> {
	const store = new MarkdownStore(root);
	const { sourceKey, input } = responseSnapshotWrite(response);
	const result = await store.snapshot(sourceKey, "response", input);
	return savedDocument(root, await storeIdentity(root), result, !result.replayed);
}
/** Saving and origin capture overlap; only their completed results reach the open request. */
export async function materializeAndReveal(save: () => Promise<SavedDocument>, signal: AbortSignal, options: { gui: boolean; runtime?: RevealRuntime; presentation?: Presentation; live?: LiveConfig }): Promise<RevealOutcome> {
	signal.throwIfAborted();
	const processRuntime = options.runtime ?? runtime;
	const origin = options.gui ? captureOrigin(signal, processRuntime) : Promise.resolve(null);
	const [saved, launchOrigin] = await Promise.all([save(), origin]);
	signal.throwIfAborted();
	if (!options.gui) return { ...saved, state: "saved" };
	return revealWithOrigin(saved, signal, processRuntime, launchOrigin, options.presentation ?? "pane", options.live);
}
async function appStatus(app: string, presentation: Presentation, live = false): Promise<"app-missing" | "app-incompatible" | undefined> {
	try {
		const manifest = join(app, "Contents", "Resources", "build.json");
		const stat = await lstat(manifest);
		if (!stat.isFile() || stat.size > 8192) return "app-incompatible";
		const build: unknown = JSON.parse(await readFile(manifest, "utf8"));
		if (typeof build !== "object" || build === null || !("contract" in build) || build.contract !== 1) return "app-incompatible";
		if (live && (!("live" in build) || build.live !== 1)) return "app-incompatible";
		if (presentation === "pane" && (!("pane" in build) || build.pane !== 1 || !("paneOpenRequest" in build) || build.paneOpenRequest !== 1)) return "app-incompatible";
		return undefined;
	} catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "app-missing" : "app-incompatible"; }
}
export async function revealSaved(saved: SavedDocument, signal: AbortSignal, processRuntime: RevealRuntime = runtime, presentation: Presentation = "pane"): Promise<RevealOutcome> {
	signal.throwIfAborted();
	return revealWithOrigin(saved, signal, processRuntime, await captureOrigin(signal, processRuntime), presentation);
}
async function dispatchPane(app: string, request: string, origin: LaunchOrigin | null, signal: AbortSignal, processRuntime: RevealRuntime, live?: LiveConfig): Promise<PaneDispatch> {
	const command = paneRequestCommand(app, request);
	if ("showUnavailable" in command) return { version: 1, outcome: "unavailable", detail: command.showUnavailable };
	const launch = await liveArguments(command.show, live);
	const result = await dispatchPaneArgv(launch.argv, origin, signal, processRuntime);
	if (result.outcome === "unavailable" || result.outcome === "stale") await launch.remove();
	return result;
}
async function dispatchPaneArgv(argv: string[], origin: LaunchOrigin | null, signal: AbortSignal, processRuntime: RevealRuntime): Promise<PaneDispatch> {
	signal.throwIfAborted();
	try {
		const output = await processRuntime.run(process.execPath, [join(PACKAGE_ROOT, "extensions", "rex", "terminal-pane.ts"), "split"], { timeout: 7000, maxBuffer: 32768, signal, input: JSON.stringify({ version: 1, origin, argv, cwd: process.cwd() }) });
		const value = JSON.parse(output.stdout) as PaneDispatch;
		if (value?.version !== 1 || !["created", "stale", "unavailable", "uncertain"].includes(value.outcome) || typeof value.detail !== "string" || value.detail.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value.detail) || (value.outcome === "created" && !value.receipt)) throw new Error("Invalid pane result.");
		return value;
	} catch { return { version: 1, outcome: "uncertain", detail: "Pane creation is unconfirmed. Do not retry automatically." }; }
}
async function launchWindow(app: string, request: string, signal: AbortSignal, processRuntime: RevealRuntime): Promise<boolean> {
	try {
		signal.throwIfAborted();
		await processRuntime.run("/usr/bin/open", ["-a", app, request], { timeout: 5000, maxBuffer: 8192, signal });
		return true;
	} catch (error) { if (signal.aborted) throw error; return false; }
}
async function acceptanceOutcome(saved: SavedDocument, request: string, signal: AbortSignal, processRuntime: RevealRuntime, pane?: PaneDispatch): Promise<RevealOutcome> {
	try {
		const accepted = await waitForAcceptance(request, signal, processRuntime.acceptanceMs ?? 5000);
		signal.throwIfAborted();
		return { ...saved, state: accepted ? "accepted" : "not-confirmed", request, pane };
	} catch (error) {
		if (signal.aborted && !pane) throw error;
		return { ...saved, state: "not-confirmed", request, pane };
	}
}
async function revealWithOrigin(saved: SavedDocument, signal: AbortSignal, processRuntime: RevealRuntime, launchOrigin: LaunchOrigin | null, presentation: Presentation, live?: LiveConfig): Promise<RevealOutcome> {
	signal.throwIfAborted();
	const failed = (reason: "app-missing" | "app-incompatible" | "unsupported-platform" | "launch-failed", remedy: string): RevealOutcome => ({ ...saved, state: "reveal-failed", reason, remedy });
	if (processRuntime.platform !== "darwin") return failed("unsupported-platform", "Open the saved document on macOS 26 or later.");
	const app = readSettings({ agentDir: getAgentDir() }).values.app;
	const status = await appStatus(app, presentation, live !== undefined);
	signal.throwIfAborted();
	if (status) return failed(status, BUILD_REMEDY);
	const identity = await storeIdentity(saved.root);
	signal.throwIfAborted();
	if (identity !== saved.storeId) throw new Error("The local store identity changed. No document was opened.");
	const store = new MarkdownStore(saved.root);
	const exact = await store.get(saved.documentId, saved.revision);
	signal.throwIfAborted();
	if (exact.revision.digest !== saved.digest) throw new Error("The saved revision digest changed. No document was opened.");
	const request = await store.writeOpenRequest(saved.documentId, saved.revision, launchOrigin);
	let pane: PaneDispatch | undefined;
	if (presentation === "pane") {
		pane = await dispatchPane(app, request, launchOrigin, signal, processRuntime, live);
		if (pane.outcome !== "created") return { ...saved, state: pane.outcome === "uncertain" ? "pane-uncertain" : "pane-unavailable", request, pane };
		if (signal.aborted) return { ...saved, state: "pane-uncertain", request, pane };
	} else if (!await launchWindow(app, request, signal, processRuntime)) return failed("launch-failed", `Use /markdown window ${saved.documentId}; if the app is unavailable, run node extensions/markdown/native/build.mts.`);
	return acceptanceOutcome(saved, request, signal, processRuntime, pane);
}
export async function openResponse(response: ResponseSnapshot, signal: AbortSignal, gui = true, presentation: Presentation = "pane", live?: LiveConfig): Promise<string> {
	const root = readSettings({ agentDir: getAgentDir() }).values.dir;
	return revealNotice(await materializeAndReveal(() => saveResponse(response, root), signal, { gui, presentation, live }));
}
export async function openStored(root: string, id: string, signal: AbortSignal, options: { gui: boolean; storeId?: string; pin?: PinnedRevision; presentation?: Presentation; live?: LiveConfig }): Promise<string> {
	return revealNotice(await materializeAndReveal(() => selectStored(root, id, options.storeId, options.pin), signal, options));
}
type EditorRevealOptions = { presentation?: Presentation; runtime?: RevealRuntime; live?: LiveConfig };
async function launchEditorPane(argv: string[], origin: LaunchOrigin | null, signal: AbortSignal, processRuntime: RevealRuntime, live?: LiveConfig): Promise<string | undefined> {
	const launch = await liveArguments(argv, live);
	const pane = await dispatchPaneArgv(launch.argv, origin, signal, processRuntime);
	if (pane.outcome === "unavailable" || pane.outcome === "stale") await launch.remove();
	if (pane.outcome === "uncertain" || signal.aborted) return "Editor pane creation is unconfirmed. Do not retry automatically.";
	return pane.outcome === "created" ? undefined : `${pane.detail} No separate window was selected.`;
}
async function revealEditor(root: string, intent: EditorOpenIntent, input: string | undefined, signal: AbortSignal, origin: LaunchOrigin | null, options: EditorRevealOptions): Promise<string> {
	const processRuntime = options.runtime ?? runtime;
	if (processRuntime.platform !== "darwin") throw new Error("The Markdown editor requires macOS 26 or later.");
	signal.throwIfAborted();
	const app = readSettings({ agentDir: getAgentDir() }).values.app;
	const presentation = options.presentation ?? "pane";
	if (options.live && await appStatus(app, presentation, true)) throw new Error(`The installed app cannot connect to the invoking conversation. ${BUILD_REMEDY}`);
	const command = editorCommand(app, root, intent, presentation, input, intent === "scratchpad" || intent === "file" ? origin : undefined);
	if ("showUnavailable" in command) throw new Error(command.showUnavailable);
	if (presentation === "pane") {
		const notice = await launchEditorPane(command.show, origin, signal, processRuntime, options.live);
		if (notice) return notice;
	} else {
		const launch = await liveArguments(command.show, options.live);
		await processRuntime.run("/usr/bin/open", ["-n", "-a", app, "--args", ...launch.argv.slice(1)], { timeout: 5000, maxBuffer: 8192, signal });
	}
	return editorLaunchNotice(intent, input, signal, processRuntime, presentation);
}
async function editorLaunchNotice(intent: EditorOpenIntent, input: string | undefined, signal: AbortSignal, processRuntime: RevealRuntime, presentation: Presentation): Promise<string> {
	if ((intent === "edit" || intent === "copy") && input) {
		const accepted = await waitForAcceptance(input, signal, processRuntime.acceptanceMs ?? 5000).catch(() => false);
		return accepted ? "The Markdown editor accepted the selected revision. Native edits retain private recovery; captured records stay unchanged." : "The editor launch was requested; document acceptance is unconfirmed. Do not retry automatically.";
	}
	return presentation === "pane" ? "Rex created the editor pane. Editor focus and readiness are not yet confirmed." : "The editor window launch was requested. Editor focus and readiness are not yet confirmed.";
}
/** Explicit client-local editor actions; none starts model work or sends conversation text. */
export async function openScratchpad(signal: AbortSignal, options: EditorRevealOptions = {}): Promise<string> {
	signal.throwIfAborted();
	const root = readSettings({ agentDir: getAgentDir() }).values.dir;
	const origin = await captureOrigin(signal, options.runtime ?? runtime);
	return revealEditor(root, "scratchpad", undefined, signal, origin, options);
}
export async function openEditorFile(path: string, signal: AbortSignal, options: EditorRevealOptions = {}): Promise<string> {
	signal.throwIfAborted();
	if (!isAbsolute(path) || path.length > 4096 || /[\p{Cc}\ud800-\udfff]/u.test(path)) throw new Error("Edit file requires an explicit absolute path without control characters.");
	const root = readSettings({ agentDir: getAgentDir() }).values.dir;
	const origin = await captureOrigin(signal, options.runtime ?? runtime);
	return revealEditor(root, "file", path, signal, origin, options);
}
async function openEditorSelection(select: () => Promise<SavedDocument>, intent: "edit" | "copy", signal: AbortSignal, options: EditorRevealOptions): Promise<string> {
	signal.throwIfAborted();
	const [saved, origin] = await Promise.all([select(), captureOrigin(signal, options.runtime ?? runtime)]);
	signal.throwIfAborted();
	const store = new MarkdownStore(saved.root);
	if ((await store.identity())?.storeId !== saved.storeId || (await store.get(saved.documentId, saved.revision)).revision.digest !== saved.digest) throw new Error("The selected store or revision changed. No editor was opened.");
	signal.throwIfAborted();
	const request = await store.writeOpenRequest(saved.documentId, saved.revision, origin);
	signal.throwIfAborted();
	return revealEditor(saved.root, intent, request, signal, origin, options);
}
export async function openEditorStored(root: string, id: string, intent: "edit" | "copy", signal: AbortSignal, options: EditorRevealOptions & { storeId?: string; pin?: PinnedRevision } = {}): Promise<string> {
	return openEditorSelection(() => selectStored(root, id, options.storeId, options.pin), intent, signal, options);
}
export async function openEditorResponse(response: ResponseSnapshot, signal: AbortSignal, options: EditorRevealOptions = {}): Promise<string> {
	const root = readSettings({ agentDir: getAgentDir() }).values.dir;
	return openEditorSelection(() => saveResponse(response, root), "copy", signal, options);
}
export function revealNotice(outcome: RevealOutcome): string {
	const identity = `${outcome.documentId.slice(0, 11)} revision ${outcome.revision}`;
	const saved = outcome.newlySaved ? `Saved ${identity}.` : `Selected ${identity}.`;
	if (outcome.state === "saved") return `${saved} No window was opened.`;
	if (outcome.state === "reveal-failed") {
		const reason = { "app-missing": "The reader app is missing", "app-incompatible": "The reader app has an incompatible build", "unsupported-platform": "The reader requires macOS 26 or later", "launch-failed": "The reader launch failed" }[outcome.reason];
		return `${saved} ${reason}. ${outcome.remedy}`;
	}
	if (outcome.state === "pane-unavailable") return `${saved} ${outcome.pane.detail} For a separate Mac window, use /markdown window ${outcome.documentId}.`;
	if (outcome.state === "pane-uncertain") return `${saved} Pane creation is unconfirmed. Do not retry automatically or close an unconfirmed pane.`;
	if (outcome.state === "accepted") return `Markdown Reader accepted ${identity}.`;
	return outcome.pane ? `${saved} Rex confirmed pane creation, but the reader did not confirm acceptance within 5 seconds. Do not retry automatically.` : `${saved} The reader did not confirm within 5 seconds. If no window appeared, run node extensions/markdown/native/build.mts.`;
}
