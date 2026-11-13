import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readSettings } from "./settings.ts";
import { MarkdownStore, type StoredDocument } from "./store.ts";
import { responseText, type ResponseSnapshot } from "./responses.ts";

const execute = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILD_REMEDY = "Run node extensions/markdown/native/build.mts with this client's Markdown app setting.";
/** `newlySaved` is true only when this action wrote the revision; otherwise the document already existed. */
export interface SavedDocument { root: string; storeId: string; documentId: string; revision: number; digest: string; newlySaved: boolean }
export type LaunchOrigin = { version: 1; terminal: "Rex"; application: { bundleId: "com.superlogical.rex" }; exact?: Record<string, unknown> };
export type RevealOutcome = SavedDocument & ({ state: "saved" } | { state: "accepted" | "not-confirmed"; request: string } | { state: "reveal-failed"; reason: "app-missing" | "app-incompatible" | "unsupported-platform" | "launch-failed"; remedy: string });
/** Only tests replace the process runner; callers never supply an executable. */
export interface RevealRuntime {
	platform: string;
	acceptanceMs?: number;
	run(executable: string, args: string[], options: { timeout: number; maxBuffer: number; signal?: AbortSignal }): Promise<{ stdout: string }>;
}
const runtime: RevealRuntime = { platform: process.platform, run: async (executable, args, options) => execute(executable, args, { ...options, encoding: "utf8" }) };
export function readLaunchOrigin(value: unknown): LaunchOrigin | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const origin = value as Record<string, unknown>;
	const app = origin.application;
	if (origin.version !== 1 || origin.terminal !== "Rex" || typeof app !== "object" || app === null || !("bundleId" in app) || app.bundleId !== "com.superlogical.rex") return null;
	if (origin.exact !== undefined && (typeof origin.exact !== "object" || origin.exact === null || Array.isArray(origin.exact))) return null;
	return { version: 1, terminal: "Rex", application: { bundleId: "com.superlogical.rex" }, ...(origin.exact === undefined ? {} : { exact: origin.exact as Record<string, unknown> }) };
}
async function captureOrigin(signal: AbortSignal, processRuntime: RevealRuntime): Promise<LaunchOrigin | null> {
	try {
		const result = await processRuntime.run(process.execPath, [join(PACKAGE_ROOT, "extensions", "rex", "terminal-origin.ts"), "capture"], { timeout: 2000, maxBuffer: 8192, signal });
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
export async function selectStored(root: string, id: string, expectedStoreId?: string): Promise<SavedDocument> {
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
	const value = await new MarkdownStore(root).get(id);
	if (expectedStoreId !== undefined && value.document.kind !== "published") throw new Error("The host identity does not name a published document.");
	return savedDocument(root, storeId, value, false);
}
function responseTitle(response: ResponseSnapshot): string {
	const date = new Date(response.timestamp ?? response.provenance.capturedAt);
	const pad = (value: number) => String(value).padStart(2, "0");
	const localTime = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const directory = basename(response.provenance.cwd ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ") || "workspace";
	return `Response · ${Array.from(directory).slice(0, 170).join("")} · ${localTime}`;
}
export async function saveResponse(response: ResponseSnapshot, root: string): Promise<SavedDocument> {
	const store = new MarkdownStore(root);
	const origin = response.provenance;
	const identity = origin.conversation === undefined ? origin.session : `${origin.session}:${origin.conversation}`;
	const sourceKey = `response\0${origin.kind}\0${identity ?? ""}\0${response.entryId}`;
	const result = await store.snapshot(sourceKey, "response", { title: responseTitle(response), source: responseText(response), contentOrigin: origin, completeness: response.completeness, references: { state: "uninspected", truncated: false, items: [], omitted: 0 } });
	return savedDocument(root, await storeIdentity(root), result, !result.replayed);
}
/** Saving and origin capture overlap; only their completed results reach the open request. */
export async function materializeAndReveal(save: () => Promise<SavedDocument>, signal: AbortSignal, options: { gui: boolean; runtime?: RevealRuntime }): Promise<RevealOutcome> {
	signal.throwIfAborted();
	const processRuntime = options.runtime ?? runtime;
	const origin = options.gui ? captureOrigin(signal, processRuntime) : Promise.resolve(null);
	const [saved, launchOrigin] = await Promise.all([save(), origin]);
	signal.throwIfAborted();
	if (!options.gui) return { ...saved, state: "saved" };
	return revealWithOrigin(saved, signal, processRuntime, launchOrigin);
}
async function appStatus(app: string): Promise<"app-missing" | "app-incompatible" | undefined> {
	try {
		const manifest = join(app, "Contents", "Resources", "build.json");
		const stat = await lstat(manifest);
		if (!stat.isFile() || stat.size > 8192) return "app-incompatible";
		const build: unknown = JSON.parse(await readFile(manifest, "utf8"));
		return typeof build === "object" && build !== null && "contract" in build && build.contract === 1 ? undefined : "app-incompatible";
	} catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "app-missing" : "app-incompatible"; }
}
export async function revealSaved(saved: SavedDocument, signal: AbortSignal, processRuntime: RevealRuntime = runtime): Promise<RevealOutcome> {
	signal.throwIfAborted();
	return revealWithOrigin(saved, signal, processRuntime, await captureOrigin(signal, processRuntime));
}
async function revealWithOrigin(saved: SavedDocument, signal: AbortSignal, processRuntime: RevealRuntime, launchOrigin: LaunchOrigin | null): Promise<RevealOutcome> {
	signal.throwIfAborted();
	const failed = (reason: "app-missing" | "app-incompatible" | "unsupported-platform" | "launch-failed", remedy: string): RevealOutcome => ({ ...saved, state: "reveal-failed", reason, remedy });
	if (processRuntime.platform !== "darwin") return failed("unsupported-platform", "Open the saved document on macOS 26 or later.");
	const app = readSettings({ agentDir: getAgentDir() }).values.app;
	const status = await appStatus(app);
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
	try {
		signal.throwIfAborted();
		await processRuntime.run("/usr/bin/open", ["-a", app, request], { timeout: 5000, maxBuffer: 8192, signal });
	} catch (error) {
		if (signal.aborted) throw error;
		return failed("launch-failed", `Retry /markdown ${saved.documentId}; if the app is unavailable, run node extensions/markdown/native/build.mts.`);
	}
	try {
		const accepted = await waitForAcceptance(request, signal, processRuntime.acceptanceMs ?? 5000);
		signal.throwIfAborted();
		return { ...saved, state: accepted ? "accepted" : "not-confirmed", request };
	} catch (error) {
		if (signal.aborted) throw error;
		return { ...saved, state: "not-confirmed", request };
	}
}
export async function openResponse(response: ResponseSnapshot, signal: AbortSignal, gui = true): Promise<string> {
	const root = readSettings({ agentDir: getAgentDir() }).values.dir;
	return revealNotice(await materializeAndReveal(() => saveResponse(response, root), signal, { gui }));
}
export async function openStored(root: string, id: string, signal: AbortSignal, options: { gui: boolean; storeId?: string }): Promise<string> {
	return revealNotice(await materializeAndReveal(() => selectStored(root, id, options.storeId), signal, options));
}
export function revealNotice(outcome: RevealOutcome): string {
	const identity = `${outcome.documentId.slice(0, 11)} revision ${outcome.revision}`;
	const saved = outcome.newlySaved ? `Saved ${identity}.` : `Selected ${identity}.`;
	if (outcome.state === "saved") return `${saved} No window was opened.`;
	if (outcome.state === "reveal-failed") {
		const reason = { "app-missing": "The reader app is missing", "app-incompatible": "The reader app has an incompatible build", "unsupported-platform": "The reader requires macOS 26 or later", "launch-failed": "The reader launch failed" }[outcome.reason];
		return `${saved} ${reason}. ${outcome.remedy}`;
	}
	if (outcome.state === "accepted") return `Markdown Reader accepted ${identity}.`;
	return `${saved} The reader did not confirm within 5 seconds. If no window appeared, run node extensions/markdown/native/build.mts.`;
}
