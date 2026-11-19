import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceRecord } from "./native/build.mts";

const NATIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), "native");
const BUILD_LIMIT = 64 * 1024;

/** What an installed app's build.json says about the source it was built from. */
export interface InstalledBuild {
	digest?: string;
	source?: SourceRecord;
}
/** The build inputs that this extension instance loaded, including the shared native pane package. */
export interface LoadedBuild {
	digest: string;
	source?: SourceRecord;
}

/**
 * How the installed app relates to the loaded build inputs:
 * - current: built from these inputs.
 * - update: missing, unreadable, or built from an earlier commit; replace it without asking.
 * - keep: built from a later commit, or from local changes at this commit; leave it as it is.
 * - notice: the order is unknown; tell the person how to replace it.
 */
export type ReaderState =
	| { state: "current" }
	| { state: "update"; reason: "missing" | "unreadable" | "unrecorded" | "older" }
	| { state: "keep"; reason: "newer" | "modified" }
	| { state: "notice"; reason: "unordered" | "loaded-modified" | "loaded-untracked"; commit?: string };

/** True when `ancestor` is an ancestor of `descendant`, false when it is not, undefined when Git cannot tell. */
export type Ancestry = (ancestor: string, descendant: string) => boolean | undefined;

export function readerState(
	installed: InstalledBuild | "missing" | "unreadable",
	loaded: LoadedBuild,
	ancestry: Ancestry,
): ReaderState {
	if (installed === "missing" || installed === "unreadable") return { state: "update", reason: installed };
	if (installed.digest === loaded.digest) return { state: "current" };
	if (!loaded.source) return { state: "notice", reason: "loaded-untracked" };
	if (loaded.source.modified) return { state: "notice", reason: "loaded-modified" };
	const built = installed.source;
	if (!built) return { state: "update", reason: "unrecorded" };
	if (built.commit === loaded.source.commit)
		return built.modified
			? { state: "keep", reason: "modified" }
			: { state: "notice", reason: "unordered", commit: built.commit };
	if (ancestry(built.commit, loaded.source.commit) === true) return { state: "update", reason: "older" };
	if (ancestry(loaded.source.commit, built.commit) === true) return { state: "keep", reason: "newer" };
	return { state: "notice", reason: "unordered", commit: built.commit };
}

/** Reads the source fields of an installed app's build.json. */
export function readInstalled(app: string): InstalledBuild | "missing" | "unreadable" {
	const path = join(app, "Contents", "Resources", "build.json");
	let value: unknown;
	try {
		if (statSync(path).size > BUILD_LIMIT) return "unreadable";
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return "unreadable";
	const { sourceDigest, source } = value as {
		sourceDigest?: unknown;
		source?: { commit?: unknown; modified?: unknown };
	};
	return {
		...(typeof sourceDigest === "string" ? { digest: sourceDigest } : {}),
		...(source && typeof source.commit === "string" && typeof source.modified === "boolean"
			? { source: { commit: source.commit, modified: source.modified } }
			: {}),
	};
}

export function gitAncestry(cwd: string): Ancestry {
	return (ancestor, descendant) => {
		const result = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], {
			timeout: 10_000,
			stdio: "ignore",
		});
		return result.status === 0 ? true : result.status === 1 ? false : undefined;
	};
}

/** Files beside the app: the install log of the latest update, and the record of a failed update. */
export function updateFiles(app: string): { log: string; failure: string } {
	const parent = dirname(app);
	return { log: join(parent, "update.log"), failure: join(parent, "update-failure.json") };
}

/** The source digest whose update failed last, until an update succeeds. */
export function failedDigest(app: string): string | undefined {
	try {
		const value = JSON.parse(readFileSync(updateFiles(app).failure, "utf8")) as { digest?: unknown };
		return typeof value.digest === "string" ? value.digest : undefined;
	} catch {
		return undefined;
	}
}

export type UpdateOutcome =
	| { status: "installed"; running: number }
	| { status: "busy" }
	| { status: "failed"; detail: string; log: string };

export interface UpdateRun {
	pid?: number;
	log: string;
	done: Promise<UpdateOutcome>;
}

export interface UpdateOptions {
	app: string;
	store: string;
	/** The source digest that a failure is recorded against. */
	digest: string;
	/** Exit status of build.mts when another install holds the lock. */
	busy: number;
	/** Counts the running reader processes of the app. */
	running: (app: string) => number;
	nativeDir?: string;
	execPath?: string;
	start?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
}

/**
 * Runs build.mts as a separate process that outlives this session, with its output in the
 * update log. The install lock in build.mts decides between concurrent updates.
 */
export function runUpdate(options: UpdateOptions): UpdateRun {
	const nativeDir = options.nativeDir ?? NATIVE_DIR;
	const files = updateFiles(options.app);
	mkdirSync(dirname(options.app), { recursive: true, mode: 0o700 });
	const output = openSync(files.log, "w", 0o600);
	let child: ChildProcess;
	try {
		child = (options.start ?? spawn)(options.execPath ?? process.execPath, [join(nativeDir, "build.mts")], {
			cwd: nativeDir,
			detached: true,
			stdio: ["ignore", output, output],
			env: { ...process.env, PI_MARKDOWN_APP: options.app, PI_MARKDOWN_DIR: options.store },
		});
	} finally {
		closeSync(output);
	}
	child.unref();
	const done = new Promise<UpdateOutcome>((resolve) => {
		const failed = (detail: string) => {
			writeFileSync(
				files.failure,
				`${JSON.stringify({ digest: options.digest, failedAt: new Date().toISOString(), detail })}\n`,
				{ mode: 0o600 },
			);
			resolve({ status: "failed", detail, log: files.log });
		};
		child.once("error", (error) => failed(`the build did not start: ${error.message}`));
		child.once("exit", (code, signal) => {
			if (code === 0) {
				rmSync(files.failure, { force: true });
				resolve({ status: "installed", running: options.running(options.app) });
			} else if (code === options.busy) resolve({ status: "busy" });
			else failed(signal ? `the build stopped on ${signal}` : `the build exited with status ${code}`);
		});
	});
	return { pid: child.pid, log: files.log, done };
}

/** The surface that reports one update: notices, a footer status, and whether the session still shows them. */
export interface UpdateReporter {
	notify(text: string, error?: boolean): void;
	status(text: string | undefined): void;
	active(): boolean;
}

const STARTED = "Updating the Markdown reader app for this harness in the background";

function installedText(running: number): string {
	if (running === 0) return "The Markdown reader app is up to date with this harness.";
	const open =
		running === 1
			? "One open reader still runs the previous build; close it"
			: `${running} open readers still run the previous build; close them`;
	return `The Markdown reader app is up to date with this harness. ${open} to load the update.`;
}

/** Reports a started update and its outcome. A busy outcome is reported only to an explicit request. */
export function reportUpdate(run: UpdateRun, reporter: UpdateReporter, explicit: boolean): void {
	reporter.status("Markdown reader: updating");
	reporter.notify(`${STARTED}${run.pid ? ` (process ${run.pid})` : ""}. Log: ${run.log}`);
	void run.done.then((outcome) => {
		if (!reporter.active()) return;
		reporter.status(undefined);
		if (outcome.status === "installed") reporter.notify(installedText(outcome.running));
		else if (outcome.status === "failed")
			reporter.notify(
				`The Markdown reader update failed: ${outcome.detail}. The previous app stays installed. Log: ${outcome.log}. Run /markdown update to try again.`,
				true,
			);
		else if (explicit)
			reporter.notify(
				"Another Markdown reader update is already running. The installed app stays as it is until that update ends.",
			);
	});
}

/** The notice for an installed app that this harness does not replace on its own. */
export function noticeText(state: Extract<ReaderState, { state: "notice" }>): string {
	if (state.reason === "loaded-modified")
		return "This harness has uncommitted changes to the Markdown reader, so the installed reader app was not replaced. Run /markdown update to install a reader built from them.";
	if (state.reason === "loaded-untracked")
		return "The installed Markdown reader app differs from this harness, and this harness is not a Git checkout, so the app was not replaced. Run /markdown update to install the reader of this harness.";
	return `The installed Markdown reader app was built from ${state.commit ? `commit ${state.commit.slice(0, 12)}` : "other source"}, which is not an earlier version of this harness, so it was not replaced. Run /markdown update to install the reader of this harness.`;
}

export interface StartupOptions {
	app: string;
	store: string;
	reporter: UpdateReporter;
	nativeDir?: string;
	ancestry?: Ancestry;
	run?: (options: UpdateOptions) => UpdateRun;
}

/**
 * Compares the installed app with the loaded build inputs and starts an update when the app is
 * missing or older. A running update, a current or newer app, and a developer build stay
 * untouched. An update that already failed for these inputs is not retried automatically.
 */
export async function checkReader(
	options: StartupOptions,
): Promise<ReaderState | { state: "busy" } | { state: "failed" }> {
	const nativeDir = options.nativeDir ?? NATIVE_DIR;
	const build = await import("./native/build.mts");
	const loaded: LoadedBuild = { digest: build.sourceDigest(nativeDir), source: build.sourceRecord(nativeDir) };
	const state = readerState(readInstalled(options.app), loaded, options.ancestry ?? gitAncestry(nativeDir));
	if (state.state === "current" || state.state === "keep") return state;
	if (build.lockHolder(dirname(options.app))) return { state: "busy" };
	if (state.state === "notice") {
		options.reporter.notify(noticeText(state));
		return state;
	}
	if (failedDigest(options.app) === loaded.digest) {
		options.reporter.notify(
			`The last Markdown reader update for this harness failed, so it was not retried. Log: ${updateFiles(options.app).log}. Run /markdown update to try again.`,
			true,
		);
		return { state: "failed" };
	}
	reportUpdate(
		(options.run ?? runUpdate)({
			app: options.app,
			store: options.store,
			digest: loaded.digest,
			busy: build.INSTALL_BUSY,
			running: build.runningReaders,
			nativeDir,
		}),
		options.reporter,
		false,
	);
	return state;
}

/** /markdown update: installs the reader of this harness now, whatever the installed app is. */
export async function updateNow(options: StartupOptions): Promise<void> {
	if (process.platform !== "darwin") {
		options.reporter.notify("The Markdown reader app builds only on macOS.", true);
		return;
	}
	const nativeDir = options.nativeDir ?? NATIVE_DIR;
	const build = await import("./native/build.mts");
	const holder = build.lockHolder(dirname(options.app));
	if (holder) {
		options.reporter.notify(
			`A Markdown reader update is already running (process ${holder.pid}). Its outcome replaces the installed app when it ends.`,
		);
		return;
	}
	reportUpdate(
		(options.run ?? runUpdate)({
			app: options.app,
			store: options.store,
			digest: build.sourceDigest(nativeDir),
			busy: build.INSTALL_BUSY,
			running: build.runningReaders,
			nativeDir,
		}),
		options.reporter,
		true,
	);
}
