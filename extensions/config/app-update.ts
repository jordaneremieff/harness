import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_BUSY, sourceDigest } from "./native/build.mts";

export type ConfigBuild = { contract: 1; config: 1; sourceDigest: string; source: string };
interface Observer {
	notify(text: string, level: "info" | "warning" | "error"): void;
	status(text?: string): void;
}
const script = fileURLToPath(new URL("./native/build.mts", import.meta.url));

export async function readConfigBuild(app: string): Promise<ConfigBuild | undefined> {
	try {
		const executable = join(app, "Contents/MacOS/Config");
		if (!(await stat(executable)).isFile()) return undefined;
		await access(executable, constants.X_OK);
		const manifest = join(app, "Contents/Resources/build.json");
		const info = await stat(manifest);
		if (!info.isFile() || info.size > 8192) return undefined;
		const record = JSON.parse(await readFile(manifest, "utf8")) as Partial<ConfigBuild> | null;
		if (
			record?.contract !== 1 ||
			record.config !== 1 ||
			typeof record.source !== "string" ||
			!isAbsolute(record.source) ||
			typeof record.sourceDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(record.sourceDigest)
		)
			return undefined;
		return { contract: 1, config: 1, source: record.source, sourceDigest: record.sourceDigest };
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
		if (!(await log.stat()).isFile()) throw new Error("The Config build log must be a regular file.");
		const child = spawn(process.execPath, [script, "install", app], {
			detached: true,
			cwd: dirname(script),
			stdio: ["ignore", log.fd, log.fd],
		});
		const finished = new Promise<number | null>((resolve) => {
			child.once("error", () => resolve(null));
			child.once("exit", resolve);
			child.once("spawn", () => {
				ui.status("Config update");
				ui.notify(`Config app update started; see ${path} for progress.`, "info");
			});
		});
		child.unref();
		const code = await finished;
		if (code === 0 && (await readConfigBuild(app)))
			ui.notify("The Config app is installed; open a new pane to use this build.", "info");
		else if (code === INSTALL_BUSY) ui.notify("Another Config app install is in progress.", "info");
		else ui.notify(`The Config app update failed; see ${path}.`, "error");
	} finally {
		await log.close();
	}
}

export class ConfigUpdater {
	private launching = false;

	async check(app: string, ui: Observer, explicit = false): Promise<void> {
		if (process.platform !== "darwin") {
			if (explicit) ui.notify("The Config app requires macOS.", "warning");
			return;
		}
		if (!isAbsolute(app) || !app.endsWith(".app")) {
			ui.notify("The Config app path must be an absolute .app path.", "warning");
			return;
		}
		if (this.launching) {
			if (explicit) ui.notify("The Config app update is already in progress.", "info");
			return;
		}
		this.launching = true;
		try {
			if (!explicit && (await readConfigBuild(app))?.sourceDigest === sourceDigest()) return;
			await install(app, ui);
		} catch {
			ui.notify("Config could not start its app update; check the app path and the update log.", "error");
		} finally {
			this.launching = false;
			ui.status();
		}
	}
}
