import { execFileSync } from "node:child_process";
import {
	accessSync,
	appendFileSync,
	constants,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { buildEditorApp, editorSourceDigest, executableInApp, recordInApp } from "./native/build.mts";

const native = fileURLToPath(new URL("./native/", import.meta.url));

/** Full command lines of the running processes. */
export type RunningCommands = () => readonly string[];

function runningCommands(): readonly string[] {
	return execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\n");
}

const slotName = /^[0-9a-f]{64}$/;
/** Builds of other sources that stay for Pi processes still running earlier harness snapshots. */
const keptOtherSlots = 2;

/**
 * Removes the app builds of other sources that nothing can use. A slot stays while a process runs
 * its app, while another process holds its build lock, or while it is one of the newest other
 * slots. Without the process list nothing is removed, and no failure here fails the install.
 */
function removeUnusedSlots(apps: string, current: string, running: RunningCommands): void {
	let commands: readonly string[];
	let names: string[];
	try {
		commands = running();
		names = readdirSync(apps);
	} catch {
		return;
	}
	const present = new Set(names);
	const unused: { slot: string; modified: number }[] = [];
	for (const name of names) {
		if (name === current || !slotName.test(name) || present.has(`${name}.lock`)) continue;
		const slot = join(apps, name);
		const info = lstat(slot);
		if (!info?.isDirectory()) continue;
		const app = `${join(slot, "Editor.app")}/`;
		if (commands.some((command) => command.includes(app))) continue;
		unused.push({ slot, modified: info.mtimeMs });
	}
	unused.sort((a, b) => b.modified - a.modified);
	for (const { slot } of unused.slice(keptOtherSlots)) {
		try {
			rmSync(slot, { recursive: true, force: true });
		} catch {
			// A slot that cannot be removed now stays until a later build.
		}
	}
}

function lstat(path: string) {
	return lstatSync(path, { throwIfNoEntry: false });
}

function matches(app: string, digest: string): boolean {
	try {
		if (!lstat(app)?.isDirectory()) return false;
		const record = join(app, recordInApp);
		const info = lstat(record);
		if (!info?.isFile() || info.size > 1024 || JSON.parse(readFileSync(record, "utf8"))?.sourceDigest !== digest)
			return false;
		const executable = join(app, executableInApp);
		if (!lstat(executable)?.isFile()) return false;
		accessSync(executable, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function buildInSlot(
	app: string,
	sources: string,
	digest: string,
	build: typeof buildEditorApp,
	hasLock: () => boolean,
	paneAppearance: string,
) {
	const slot = dirname(app);
	const stage = mkdtempSync(join(slot, ".stage-"));
	const stagedApp = join(stage, "Editor.app");
	const log = join(stage, "build.log");
	const lastLog = join(slot, "build.log");
	try {
		writeFileSync(log, "", { mode: 0o600 });
		await build({ sources, app: stagedApp, scratch: join(stage, "swift"), log, digest, paneAppearance });
		if (!hasLock()) throw new Error("The cache lock was lost during the build.");
		if (!matches(stagedApp, digest)) throw new Error("The build did not produce an executable Editor app.");
		renameSync(log, lastLog);
		renameSync(stagedApp, app);
	} catch (error) {
		if (lstat(log)) {
			appendFileSync(log, `${error instanceof Error ? error.message : String(error)}\n`);
			renameSync(log, lastLog);
		}
		throw new Error(`Editor did not build. See ${lastLog} and run /editor again.`, { cause: error });
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

export function editorAppInstaller(
	sources = native,
	build = buildEditorApp,
	running: RunningCommands = runningCommands,
): (agentDir: string) => Promise<string> {
	return async (agentDir) => {
		const digest = editorSourceDigest(sources);
		const apps = resolve(agentDir, "editor-apps");
		const slot = join(apps, digest);
		const app = join(slot, "Editor.app");
		const executable = join(app, executableInApp);
		if (matches(app, digest)) return executable;
		mkdirSync(slot, { recursive: true, mode: 0o700 });

		let compromised = false;
		const release = await lockfile
			.lock(slot, {
				stale: 30_000,
				retries: { retries: 210, factor: 1, minTimeout: 750, maxTimeout: 750 },
				onCompromised: () => {
					compromised = true;
				},
			})
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ELOCKED") throw error;
				throw new Error("Another Pi process is still building Editor. Run /editor again after that build ends.");
			});
		try {
			if (matches(app, digest)) return executable;
			if (lstat(app)) throw new Error(`Editor found a damaged bundle at ${app}. Remove it and run /editor again.`);
			await buildInSlot(app, sources, digest, build, () => !compromised, resolve(agentDir, "pane-appearance.json"));
			removeUnusedSlots(apps, digest, running);
			return executable;
		} finally {
			if (!compromised) await release();
		}
	};
}

export const ensureEditorApp = editorAppInstaller();
