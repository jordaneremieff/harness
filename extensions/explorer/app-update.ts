import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type PaneBuild, readBuild } from "./pane-command.ts";

const script = fileURLToPath(new URL("./native/build.mts", import.meta.url));
const source = fileURLToPath(new URL("./", import.meta.url));
function git(args: string[]) {
	return new Promise<{ ok: boolean; text: string; code: unknown }>((resolve) => {
		execFile(
			"git",
			["-C", source, ...args],
			{ encoding: "utf8", timeout: 3000, maxBuffer: 65536, killSignal: "SIGKILL" },
			(error, stdout) => resolve({ ok: !error, text: stdout.trim(), code: error?.code }),
		);
	});
}
export async function buildCurrency(installed: PaneBuild | undefined): Promise<"install" | "current" | "unknown"> {
	if (!installed?.commit) return "install";
	const head = await git(["rev-parse", "--verify", "HEAD"]);
	if (!head.ok) return "unknown";
	if (head.text === installed.commit) return "current";
	const status = await git(["status", "--porcelain", "--untracked-files=normal", "--", "."]);
	if (!status.ok || status.text) return "unknown";
	const older = await git(["merge-base", "--is-ancestor", installed.commit, head.text]);
	if (older.ok) return "install";
	if (older.code !== 1) return "unknown";
	return (await git(["merge-base", "--is-ancestor", head.text, installed.commit])).ok ? "current" : "unknown";
}
interface Observer {
	notify(text: string, level: "info" | "warning" | "error"): void;
	status(text?: string): void;
}
async function install(app: string, observer: Observer) {
	await mkdir(dirname(app), { recursive: true, mode: 0o700 });
	const logPath = `${app}.update.log`;
	const log = await open(
		logPath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		0o600,
	);
	try {
		if (!(await log.stat()).isFile()) throw new Error("The build log must be a regular file.");
		const child = spawn(process.execPath, [script], {
			detached: true,
			cwd: dirname(script),
			env: { ...process.env, PI_EXPLORER_APP: app },
			stdio: ["ignore", log.fd, log.fd],
		});
		const complete = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		child.unref();
		observer.status("Explorer: updating");
		observer.notify(`Explorer app update started; see ${logPath} for the log.`, "info");
		const { code, signal } = await complete;
		if (code === 0 && (await readBuild(app)))
			observer.notify("Explorer app updated; open a new pane to use this build.", "info");
		else if (code === 75) observer.notify("Another Explorer app update is already in progress.", "info");
		else {
			const reason = signal
				? `the build process ended on ${signal}`
				: code === 0
					? "the installed build did not pass validation"
					: `the build process exited with code ${code}`;
			observer.notify(
				`Explorer app update failed because ${reason}; see ${logPath} and use /explorer update to retry.`,
				"error",
			);
		}
	} finally {
		await log.close();
	}
}
export class ExplorerUpdater {
	private launching = false;
	async check(app: string, observer: Observer, explicit = false) {
		if (process.platform !== "darwin") {
			if (explicit) observer.notify("The Explorer app requires macOS.", "warning");
			return;
		}
		if (this.launching) {
			if (explicit) observer.notify("The Explorer app update is already in progress.", "info");
			return;
		}
		this.launching = true;
		try {
			const currency = explicit ? "install" : await buildCurrency(await readBuild(app));
			if (currency === "current") return;
			if (currency === "unknown") {
				observer.notify(
					"Explorer kept the installed build because it could not establish which build is newer; use /explorer update to replace it.",
					"warning",
				);
				return;
			}
			await install(app, observer);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown cause";
			observer.notify(`Explorer could not start its app update: ${detail}`, "error");
		} finally {
			this.launching = false;
			observer.status();
		}
	}
}
