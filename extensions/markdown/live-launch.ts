import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { LIVE_LIFETIME, readLiveConfig, type LiveConfig } from "./live-protocol.ts";

interface LaunchOwner {
	files: Set<string>;
	closed: boolean;
	close(): void;
}
const owners = new WeakMap<AbortSignal, LaunchOwner>();
const activeOwners = new Set<LaunchOwner>();
const processLifetime = new AbortController().signal;
function closeLaunchFiles(): void {
	for (const owner of activeOwners) owner.close();
}
function launchOwner(signal = processLifetime): LaunchOwner {
	const prior = owners.get(signal);
	if (prior) return prior;
	const owner: LaunchOwner = {
		files: new Set(),
		closed: signal.aborted,
		close() {
			owner.closed = true;
			signal.removeEventListener("abort", owner.close);
			// Exit handlers cannot await filesystem work; only this owner's exact paths are eligible.
			for (const path of owner.files) {
				try {
					unlinkSync(path);
				} catch {}
			}
			owner.files.clear();
			activeOwners.delete(owner);
			if (!activeOwners.size) process.off("exit", closeLaunchFiles);
		},
	};
	owners.set(signal, owner);
	if (!owner.closed) {
		signal.addEventListener("abort", owner.close, { once: true });
		if (!activeOwners.size) process.once("exit", closeLaunchFiles);
		activeOwners.add(owner);
	}
	return owner;
}
function checkOwner(owner: LaunchOwner): void {
	if (owner.closed) throw new Error("The live Markdown host closed.");
}

/** The native process consumes the private capability; model-visible argv contains only its one-use path. */
export async function liveArguments(
	argv: string[],
	live?: LiveConfig,
): Promise<{ argv: string[]; remove: () => Promise<void> }> {
	if (!live) return { argv, remove: async () => {} };
	const config = readLiveConfig(live);
	const owner = launchOwner(live[LIVE_LIFETIME]);
	checkOwner(owner);
	const directory = join(getAgentDir(), "markdown-live");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	checkOwner(owner);
	const path = join(directory, `${randomUUID()}.json`);
	const file = await open(path, "wx", 0o600);
	owner.files.add(path);
	const remove = async () => {
		owner.files.delete(path);
		await unlink(path).catch(() => {});
	};
	try {
		checkOwner(owner);
		await file.writeFile(JSON.stringify(config));
		checkOwner(owner);
	} catch (error) {
		await remove();
		throw error;
	} finally {
		await file.close();
	}
	checkOwner(owner);
	return { argv: [...argv, "--live", path], remove };
}
async function supportsLive(app?: string): Promise<boolean> {
	if (!app) return false;
	try {
		const path = join(app, "Contents", "Resources", "build.json");
		const info = await lstat(path);
		if (!info.isFile() || info.size > 8192) return false;
		const build: unknown = JSON.parse(await readFile(path, "utf8"));
		return typeof build === "object" && build !== null && "live" in build && (build.live === 1 || build.live === 2);
	} catch {
		return false;
	}
}
/** A failed live route does not turn a completed publication or read into a failed document operation. */
export async function withLiveShow<T extends { show?: string[]; showUnavailable?: string }>(
	outcome: T,
	app: string | undefined,
	connection?: () => Promise<LiveConfig>,
	signal?: AbortSignal,
): Promise<T> {
	if (!connection || !outcome.show) return outcome;
	if (!(await supportsLive(app)))
		return {
			...outcome,
			show: undefined,
			showUnavailable:
				"The installed app does not support live conversation panes. Build it with node extensions/markdown/native/build.mts. The saved document remains readable.",
		};
	try {
		signal?.throwIfAborted();
		const config = await connection();
		signal?.throwIfAborted();
		const launch = await liveArguments(outcome.show, config);
		if (signal?.aborted) {
			await launch.remove();
			signal.throwIfAborted();
		}
		return { ...outcome, show: launch.argv };
	} catch {
		return {
			...outcome,
			show: undefined,
			showUnavailable:
				"The exact invoking conversation is unavailable. The saved document remains readable from the Markdown view; no replacement conversation was selected.",
		};
	}
}
