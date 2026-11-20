import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_BUSY, sourceDigest } from "./native/build.mts";

export type SettingsBuild = { contract: 1; settings: 1; sourceDigest: string; source: string };
interface Observer {
	notify(text: string, error?: boolean): void;
	status(text?: string): void;
}
const script = fileURLToPath(new URL("./native/build.mts", import.meta.url));

export async function readSettingsBuild(app: string): Promise<SettingsBuild | undefined> {
	try {
		const executable = join(app, "Contents/MacOS/Settings");
		if (!(await stat(executable)).isFile()) return undefined;
		await access(executable, constants.X_OK);
		const manifest = join(app, "Contents/Resources/build.json");
		const info = await stat(manifest);
		if (!info.isFile() || info.size > 8192) return undefined;
		const record = JSON.parse(await readFile(manifest, "utf8")) as Partial<SettingsBuild> | null;
		if (
			record?.contract !== 1 ||
			record.settings !== 1 ||
			typeof record.source !== "string" ||
			!isAbsolute(record.source) ||
			typeof record.sourceDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(record.sourceDigest)
		)
			return undefined;
		return { contract: 1, settings: 1, source: record.source, sourceDigest: record.sourceDigest };
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
		if (!(await log.stat()).isFile()) throw new Error("The Settings build log must be a regular file.");
		const child = spawn(process.execPath, [script, "install", app], {
			detached: true,
			cwd: dirname(script),
			stdio: ["ignore", log.fd, log.fd],
		});
		const finished = new Promise<number | null>((resolve) => {
			child.once("error", () => resolve(null));
			child.once("exit", resolve);
		});
		child.unref();
		ui.status("Settings update");
		ui.notify(`Settings app update started. Log: ${path}`);
		const code = await finished;
		if (code === 0 && (await readSettingsBuild(app)))
			ui.notify("Settings app installed. Open a new pane to use the new build.");
		else if (code === INSTALL_BUSY) ui.notify("Another Settings app install is in progress.");
		else ui.notify(`Settings app update failed. See ${path}.`, true);
	} finally {
		await log.close();
	}
}

export class SettingsUpdater {
	private launching = false;

	async check(app: string, ui: Observer, explicit = false): Promise<void> {
		if (process.platform !== "darwin") {
			if (explicit) ui.notify("The Settings app requires macOS.", true);
			return;
		}
		if (!isAbsolute(app) || !app.endsWith(".app")) {
			ui.notify("The Settings app path must be an absolute .app path.", true);
			return;
		}
		if (this.launching) {
			if (explicit) ui.notify("The Settings app update is already in progress.");
			return;
		}
		this.launching = true;
		try {
			if (!explicit && (await readSettingsBuild(app))?.sourceDigest === sourceDigest()) return;
			await install(app, ui);
		} catch {
			ui.notify("Settings could not start its app update. Check the app path and the update log.", true);
		} finally {
			this.launching = false;
			ui.status();
		}
	}
}
