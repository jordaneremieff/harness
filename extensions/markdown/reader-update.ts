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
 * How the installed app relates to the loaded build inputs
 * (see docs/conventions/native-app-updates.md):
 * - current: built from these inputs.
 * - keep: built from a later commit of the same history, with neither side modified; an older
 *   process never replaces a newer install.
 * - update: every other difference; replace it without asking.
 */
export type ReaderState =
	| { state: "current" }
	| { state: "keep"; reason: "newer" }
	| {
			state: "update";
			reason: "missing" | "unreadable" | "unrecorded" | "older" | "unordered" | "modified" | "untracked";
	  };

/** True when `ancestor` is an ancestor of `descendant`, false when it is not, undefined when Git cannot tell. */
export type Ancestry = (ancestor: string, descendant: string) => boolean | undefined;

export function readerState(
	installed: InstalledBuild | "missing" | "unreadable",
	loaded: LoadedBuild,
	ancestry: Ancestry,
): ReaderState {
	if (installed === "missing" || installed === "unreadable") return { state: "update", reason: installed };
	if (installed.digest === loaded.digest) return { state: "current" };
	if (!loaded.source) return { state: "update", reason: "untracked" };
	const built = installed.source;
	if (!built) return { state: "update", reason: "unrecorded" };
	if (loaded.source.modified || built.modified) return { state: "update", reason: "modified" };
	if (built.commit !== loaded.source.commit && ancestry(loaded.source.commit, built.commit) === true)
		return { state: "keep", reason: "newer" };
	return ancestry(built.commit, loaded.source.commit) === true
		? { state: "update", reason: "older" }
		: { state: "update", reason: "unordered" };
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

type BuildOutcome = { status: "installed" } | { status: "busy" } | { status: "failed"; detail: string };
type RecordedOutcome = BuildOutcome & { recordIssue?: string };
export type UpdateOutcome =
	| { status: "installed"; running: number; recordIssue?: string }
	| { status: "busy" }
	| { status: "failed"; detail: string; log: string; recordIssue?: string };

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

function recordOutcome(app: string, digest: string, outcome: BuildOutcome): RecordedOutcome {
	if (outcome.status === "busy") return outcome;
	const { failure } = updateFiles(app);
	try {
		if (outcome.status === "installed") rmSync(failure, { force: true });
		else
			writeFileSync(
				failure,
				`${JSON.stringify({ digest, failedAt: new Date().toISOString(), detail: outcome.detail })}\n`,
				{ mode: 0o600 },
			);
		return outcome;
	} catch (error) {
		const action =
			outcome.status === "installed" ? "remove the previous update failure record" : "record the update failure";
		const reason = (error as NodeJS.ErrnoException).code ?? "filesystem error";
		return { ...outcome, recordIssue: `The reader updater could not ${action} (${reason}).` };
	}
}

/** The detached process owns the failure record. Pi's optional receipt is only for display. */
function updateWorker(nativeDir: string, digest: string, busy: number): void {
	const app = process.env.PI_MARKDOWN_APP;
	if (!app) throw new Error("The Markdown reader updater requires an app path.");
	const result = spawnSync(process.execPath, [join(nativeDir, "build.mts")], { cwd: nativeDir, stdio: "inherit" });
	const built: BuildOutcome = result.error
		? { status: "failed", detail: `the build did not start: ${result.error.message}` }
		: result.status === 0
			? { status: "installed" }
			: result.status === busy
				? { status: "busy" }
				: {
						status: "failed",
						detail: result.signal
							? `the build stopped on ${result.signal}`
							: `the build exited with status ${result.status}`,
					};
	const recorded = recordOutcome(app, digest, built);
	if (recorded.recordIssue) console.error(recorded.recordIssue);
	if (process.connected && process.send)
		process.send(recorded, () => {
			/* The starting session may already have exited. */
		});
}

/** The detached updater reports outcomes independently of the installer lock in build.mts. */
export function runUpdate(options: UpdateOptions): UpdateRun {
	const nativeDir = options.nativeDir ?? NATIVE_DIR;
	const files = updateFiles(options.app);
	mkdirSync(dirname(options.app), { recursive: true, mode: 0o700 });
	const output = openSync(files.log, "w", 0o600);
	let child: ChildProcess;
	try {
		child = (options.start ?? spawn)(
			options.execPath ?? process.execPath,
			[fileURLToPath(import.meta.url), "--update-worker", nativeDir, options.digest, String(options.busy)],
			{
				cwd: nativeDir,
				detached: true,
				stdio: ["ignore", output, output, "ipc"],
				env: { ...process.env, PI_MARKDOWN_APP: options.app, PI_MARKDOWN_DIR: options.store },
			},
		);
	} finally {
		closeSync(output);
	}
	const done = new Promise<UpdateOutcome>((resolve) => {
		let settled = false;
		const finish = (outcome: RecordedOutcome) => {
			if (settled) return;
			settled = true;
			if (outcome.status === "installed") resolve({ ...outcome, running: options.running(options.app) });
			else if (outcome.status === "failed") resolve({ ...outcome, log: files.log });
			else resolve({ status: "busy" });
		};
		const failed = (detail: string) => {
			if (!settled) finish(recordOutcome(options.app, options.digest, { status: "failed", detail }));
		};
		child.once("message", (outcome: RecordedOutcome) => finish(outcome));
		child.once("error", (error) => failed(`the update process did not start: ${error.message}`));
		child.once("close", (code, signal) =>
			failed(`the update process ended without an outcome (${signal ?? `status ${code}`})`),
		);
	});
	child.unref();
	child.channel?.unref();
	return { pid: child.pid, log: files.log, done };
}

/** The surface that reports one update: notices, a footer status, and whether the session still shows them. */
export interface UpdateReporter {
	notify(text: string, error?: boolean | "warning"): void;
	status(text: string | undefined): void;
	active(): boolean;
}

const STATUS = "Markdown reader update";

function installedText(running: number): string {
	const base = "Markdown reader app is up to date; open a new pane to use it";
	if (running === 0) return base;
	const open = running === 1 ? "1 open reader still runs" : `${running} open readers still run`;
	return `${base}. ${open} the previous build until it closes`;
}

function reportInstalled(
	outcome: Extract<UpdateOutcome, { status: "installed" }>,
	record: string,
	reporter: UpdateReporter,
) {
	reporter.notify(
		`${installedText(outcome.running)}${record}.`,
		outcome.recordIssue || outcome.running ? "warning" : undefined,
	);
}

/** Reports a started update and its outcome. A busy outcome is reported only to an explicit request. */
export function reportUpdate(run: UpdateRun, reporter: UpdateReporter, explicit: boolean): void {
	reporter.status(STATUS);
	reporter.notify(`Markdown reader app update started in the background; log: ${run.log}.`);
	void run.done.then((outcome) => {
		if (!reporter.active()) return;
		reporter.status(undefined);
		if (outcome.status === "busy") {
			if (explicit)
				reporter.notify("Markdown reader app update is already running; the installed app stays until it ends.");
			return;
		}
		const record = outcome.recordIssue ? `; ${outcome.recordIssue.replace(/\.$/u, "")}` : "";
		if (outcome.status === "installed") reportInstalled(outcome, record, reporter);
		else
			reporter.notify(
				`Markdown reader app update failed: ${outcome.detail.replace(/\.$/u, "")}${record}; the previous app stays installed. See ${outcome.log} and run /markdown update to try again.`,
				true,
			);
	});
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
 * Compares the installed app with the loaded build inputs and starts an update unless the app is
 * current or built from a later commit. A running install starts nothing. An update that already
 * failed for these inputs is not retried automatically.
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
	if (failedDigest(options.app) === loaded.digest) {
		options.reporter.notify(
			`Markdown reader app update failed earlier for these sources and was not retried; the previous app stays installed. See ${updateFiles(options.app).log} and run /markdown update to try again.`,
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
		options.reporter.notify("The Markdown reader app builds only on macOS.", "warning");
		return;
	}
	const nativeDir = options.nativeDir ?? NATIVE_DIR;
	const build = await import("./native/build.mts");
	const holder = build.lockHolder(dirname(options.app));
	if (holder) {
		options.reporter.notify(
			`Markdown reader app update is already running (process ${holder.pid}); the installed app stays until it ends.`,
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === "--update-worker") {
	updateWorker(process.argv[3], process.argv[4], Number(process.argv[5]));
}
