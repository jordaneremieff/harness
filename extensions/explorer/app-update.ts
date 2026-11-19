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
	notify(text: string, error?: boolean): void;
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
		const complete = new Promise<number | null>((resolve) => {
			child.once("error", () => resolve(null));
			child.once("exit", resolve);
		});
		child.unref();
		observer.status("Explorer update");
		observer.notify(`Explorer app update started. Log: ${logPath}`);
		const code = await complete;
		if (code === 0 && (await readBuild(app)))
			observer.notify("Explorer app installed. Open a new pane to use the new build.");
		else if (code === 75) observer.notify("Another Explorer app install is in progress.");
		else observer.notify(`Explorer app update failed. See ${logPath}. Use /explorer update to try again.`, true);
	} finally {
		await log.close();
	}
}
export class ExplorerUpdater {
	private launching = false;
	async check(app: string, observer: Observer, explicit = false) {
		if (process.platform !== "darwin") {
			if (explicit) observer.notify("The Explorer app requires macOS.", true);
			return;
		}
		if (this.launching) {
			if (explicit) observer.notify("The Explorer app update is already in progress.");
			return;
		}
		this.launching = true;
		try {
			const currency = explicit ? "install" : await buildCurrency(await readBuild(app));
			if (currency === "current") return;
			if (currency === "unknown") {
				observer.notify(
					"The installed Explorer build could not be ordered against this checkout. Use /explorer update to replace it.",
				);
				return;
			}
			await install(app, observer);
		} catch {
			observer.notify(
				"Explorer could not start its app update. Check the app and log paths, then use /explorer update.",
				true,
			);
		} finally {
			this.launching = false;
			observer.status();
		}
	}
}
