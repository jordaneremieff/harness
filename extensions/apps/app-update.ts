import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_BUSY, sourceDigest } from "./native/build.mts";
import { EXECUTABLE } from "./show.ts";

export type AppPaneBuild = { contract: 1; appPane: 1; sourceDigest: string; source: string };
export interface Observer {
	notify(text: string, level: "info" | "warning" | "error"): void;
	status(text?: string): void;
}
const script = fileURLToPath(new URL("./native/build.mts", import.meta.url));

/** The build manifest of an installed App Pane with an executable program, or undefined. */
export async function readAppPaneBuild(app: string): Promise<AppPaneBuild | undefined> {
	try {
		const executable = join(app, EXECUTABLE);
		if (!(await stat(executable)).isFile()) return undefined;
		await access(executable, constants.X_OK);
		const manifest = join(app, "Contents/Resources/build.json");
		const info = await stat(manifest);
		if (!info.isFile() || info.size > 8192) return undefined;
		const record = JSON.parse(await readFile(manifest, "utf8")) as Partial<AppPaneBuild> | null;
		if (
			record?.contract !== 1 ||
			record.appPane !== 1 ||
			typeof record.source !== "string" ||
			!isAbsolute(record.source) ||
			typeof record.sourceDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(record.sourceDigest)
		)
			return undefined;
		return { contract: 1, appPane: 1, source: record.source, sourceDigest: record.sourceDigest };
	} catch {
		return undefined;
	}
}

async function install(app: string, ui: Observer): Promise<void> {
	await mkdir(dirname(app), { recursive: true, mode: 0o700 });
	const path = `${app}.update.log`;
	const log = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		0o600,
	);
	try {
		if (!(await log.stat()).isFile()) throw new Error("The App Pane build log must be a regular file.");
		const child = spawn(process.execPath, [script, "install", app], {
			detached: true,
			cwd: dirname(script),
			stdio: ["ignore", log.fd, log.fd],
		});
		const finished = new Promise<number | null>((resolve) => {
			child.once("error", () => resolve(null));
			child.once("exit", resolve);
			child.once("spawn", () => {
				ui.status("App Pane update");
				ui.notify(`App Pane build started; see ${path} for progress.`, "info");
			});
		});
		child.unref();
		const code = await finished;
		if (code === 0 && (await readAppPaneBuild(app)))
			ui.notify("App Pane is installed; new app panes use this build.", "info");
		else if (code === INSTALL_BUSY) ui.notify("Another App Pane install is in progress.", "info");
		else ui.notify(`The App Pane build failed; see ${path}.`, "error");
	} finally {
		await log.close();
	}
}

/** Builds and installs App Pane in the background when it is missing or older than this checkout. */
export class AppPaneUpdater {
	private launching = false;

	get busy(): boolean {
		return this.launching;
	}

	async check(app: string, ui: Observer, explicit = false): Promise<void> {
		if (process.platform !== "darwin") {
			if (explicit) ui.notify("App panes require macOS.", "warning");
			return;
		}
		if (this.launching) {
			if (explicit) ui.notify("The App Pane build is already in progress.", "info");
			return;
		}
		this.launching = true;
		try {
			if (!explicit && (await readAppPaneBuild(app))?.sourceDigest === sourceDigest()) return;
			await install(app, ui);
		} catch {
			ui.notify("App Pane could not start its build; check the build log beside the app.", "error");
		} finally {
			this.launching = false;
			ui.status();
		}
	}
}
