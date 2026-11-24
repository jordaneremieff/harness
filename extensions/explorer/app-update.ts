import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type PaneBuild, readBuild } from "./pane-command.ts";

const script = fileURLToPath(new URL("./native/build.mts", import.meta.url));
const source = fileURLToPath(new URL("./", import.meta.url));
const INSTALL_BUSY = 75;
const STATUS = "Explorer update";

/** The build inputs that this extension instance loaded. `commit` is null outside Git. */
export interface LoadedSource {
	digest: string;
	commit: string | null;
	dirty: boolean;
}
/** True when `ancestor` is an ancestor of `descendant`, false when it is not, undefined when Git cannot tell. */
export type Ancestry = (ancestor: string, descendant: string) => Promise<boolean | undefined>;

/**
 * How the installed app relates to the loaded build inputs (see docs/conventions/native-app-updates.md):
 * current when built from these inputs; keep when built from a later commit of the same history with
 * neither side modified; otherwise update.
 */
export type AppState =
	| { state: "current" }
	| { state: "keep"; reason: "newer" }
	| {
			state: "update";
			reason: "missing" | "unrecorded" | "older" | "unordered" | "modified" | "untracked";
	  };

export async function appState(
	installed: PaneBuild | undefined,
	loaded: LoadedSource,
	ancestry: Ancestry,
): Promise<AppState> {
	if (!installed) return { state: "update", reason: "missing" };
	if (installed.digest === loaded.digest) return { state: "current" };
	if (!loaded.commit) return { state: "update", reason: "untracked" };
	if (!installed.commit || !installed.digest) return { state: "update", reason: "unrecorded" };
	if (loaded.dirty || installed.dirty) return { state: "update", reason: "modified" };
	if (installed.commit !== loaded.commit && (await ancestry(loaded.commit, installed.commit)) === true)
		return { state: "keep", reason: "newer" };
	return (await ancestry(installed.commit, loaded.commit)) === true
		? { state: "update", reason: "older" }
		: { state: "update", reason: "unordered" };
}

export const gitAncestry: Ancestry = (ancestor, descendant) =>
	new Promise((resolve) => {
		execFile(
			"git",
			["-C", source, "merge-base", "--is-ancestor", ancestor, descendant],
			{ timeout: 3000, killSignal: "SIGKILL" },
			(error) => resolve(!error ? true : error.code === 1 ? false : undefined),
		);
	});

/** Files beside the app: the log of the latest install, and the record of a failed install. */
export function updateFiles(app: string): { log: string; failure: string } {
	return { log: `${app}.update.log`, failure: `${app}.update-failure.json` };
}

/** The source digest whose install failed last, until an install succeeds. */
export async function failedDigest(app: string): Promise<string | undefined> {
	try {
		const value = JSON.parse(await readFile(updateFiles(app).failure, "utf8")) as { digest?: unknown };
		return typeof value.digest === "string" ? value.digest : undefined;
	} catch {
		return undefined;
	}
}

async function record(app: string, digest: string, detail?: string): Promise<void> {
	const { failure } = updateFiles(app);
	if (detail === undefined) await rm(failure, { force: true });
	else
		await writeFile(failure, `${JSON.stringify({ digest, failedAt: new Date().toISOString(), detail })}\n`, {
			mode: 0o600,
		});
}

export interface Observer {
	notify(text: string, level: "info" | "warning" | "error"): void;
	status(text?: string): void;
}
export type InstallExit = { code: number | null; signal: NodeJS.Signals | null };

/** Starts the detached build with its output appended to the log; `exit` settles when it exits. */
async function startBuild(app: string, log: string): Promise<{ exit: Promise<InstallExit> }> {
	const file = await open(
		log,
		constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		0o600,
	);
	try {
		if (!(await file.stat()).isFile()) throw new Error("the build log must be a regular file");
		const child = spawn(process.execPath, [script], {
			detached: true,
			cwd: dirname(script),
			env: { ...process.env, PI_EXPLORER_APP: app },
			stdio: ["ignore", file.fd, file.fd],
		});
		const exit = new Promise<InstallExit>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		child.unref();
		return { exit };
	} finally {
		await file.close();
	}
}

export interface UpdaterRuntime {
	loaded(): Promise<LoadedSource>;
	installRunning(app: string): Promise<boolean>;
	ancestry: Ancestry;
	start(app: string, log: string): Promise<{ exit: Promise<InstallExit> }>;
	readBuild(app: string): Promise<PaneBuild | undefined>;
}

const defaultRuntime: UpdaterRuntime = {
	async loaded() {
		return (await import("./native/build.mts")).sourceRecord();
	},
	async installRunning(app) {
		return (await import("./native/build.mts")).installRunning(app);
	},
	ancestry: gitAncestry,
	start: startBuild,
	readBuild,
};

const BUSY = "Explorer app update is already running; the installed app stays until it ends.";
function exitReason(exit: InstallExit): string {
	if (exit.signal) return `the build stopped on ${exit.signal}`;
	return exit.code === 0 ? "the installed build did not pass validation" : `the build exited with status ${exit.code}`;
}
const retry = (log: string) => `the previous app stays installed. See ${log} and run /explorer update to try again.`;

/**
 * Keeps the Explorer app in step with the loaded harness. `check` at an interactive start or reload
 * installs in the background unless the app is current, newer, already being installed, or failed
 * for these sources before; an explicit request installs whatever is installed.
 */
export class ExplorerUpdater {
	private launching = false;
	private readonly runtime: UpdaterRuntime;
	constructor(runtime: UpdaterRuntime = defaultRuntime) {
		this.runtime = runtime;
	}

	async check(
		app: string,
		observer: Observer,
		explicit = false,
	): Promise<AppState | { state: "busy" | "failed" | "unsupported" }> {
		if (process.platform !== "darwin") {
			if (explicit) observer.notify("The Explorer app builds only on macOS.", "warning");
			return { state: "unsupported" };
		}
		if (this.launching || (await this.runtime.installRunning(app))) {
			if (explicit) observer.notify(BUSY, "info");
			return { state: "busy" };
		}
		this.launching = true;
		const { log } = updateFiles(app);
		try {
			const loaded = await this.runtime.loaded();
			const state: AppState = explicit
				? { state: "update", reason: "missing" }
				: await appState(await this.runtime.readBuild(app), loaded, this.runtime.ancestry);
			if (state.state !== "update") return state;
			if (!explicit && (await failedDigest(app)) === loaded.digest) {
				observer.notify(
					`Explorer app update failed earlier for these sources and was not retried; ${retry(log)}`,
					"error",
				);
				return { state: "failed" };
			}
			await this.install(app, loaded.digest, observer, explicit);
			return state;
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown cause";
			observer.notify(`Explorer app update failed: ${detail}; ${retry(log)}`, "error");
			return { state: "failed" };
		} finally {
			this.launching = false;
			observer.status();
		}
	}

	private async install(app: string, digest: string, observer: Observer, explicit: boolean): Promise<void> {
		const { log } = updateFiles(app);
		await mkdir(dirname(app), { recursive: true, mode: 0o700 });
		let exit: InstallExit;
		try {
			const running = await this.runtime.start(app, log);
			observer.status(STATUS);
			observer.notify(`Explorer app update started in the background; log: ${log}.`, "info");
			exit = await running.exit;
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown cause";
			await this.fail(app, digest, `the build did not start (${detail})`, observer);
			return;
		}
		if (exit.code === 0 && (await this.runtime.readBuild(app))) {
			await record(app, digest).catch(() => undefined);
			observer.notify("Explorer app is up to date; open a new pane to use it.", "info");
		} else if (exit.code === INSTALL_BUSY) {
			if (explicit) observer.notify(BUSY, "info");
		} else await this.fail(app, digest, exitReason(exit), observer);
	}

	private async fail(app: string, digest: string, reason: string, observer: Observer) {
		const { log } = updateFiles(app);
		const issue = await record(app, digest, reason).then(
			() => "",
			(error: NodeJS.ErrnoException) =>
				` (the failure record could not be written: ${error.code ?? "filesystem error"})`,
		);
		observer.notify(`Explorer app update failed: ${reason}${issue}; ${retry(log)}`, "error");
	}
}
