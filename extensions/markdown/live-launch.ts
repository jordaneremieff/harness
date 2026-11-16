import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readLiveConfig, type LiveConfig } from "./live-protocol.ts";

/** The native process consumes the private capability; model-visible argv contains only its one-use path. */
export async function liveArguments(argv: string[], live?: LiveConfig): Promise<{ argv: string[]; remove: () => Promise<void> }> {
	if (!live) return { argv, remove: async () => {} };
	const config = readLiveConfig(live);
	const directory = join(getAgentDir(), "markdown-live");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${randomUUID()}.json`);
	await writeFile(path, JSON.stringify(config), { mode: 0o600, flag: "wx" });
	return { argv: [...argv, "--live", path], remove: async () => { await unlink(path).catch(() => {}); } };
}
async function supportsLive(app?: string): Promise<boolean> {
	if (!app) return false;
	try {
		const path = join(app, "Contents", "Resources", "build.json");
		const info = await lstat(path);
		if (!info.isFile() || info.size > 8192) return false;
		const build: unknown = JSON.parse(await readFile(path, "utf8"));
		return typeof build === "object" && build !== null && "live" in build && build.live === 1;
	} catch { return false; }
}
/** A failed live route does not turn a completed publication or read into a failed document operation. */
export async function withLiveShow<T extends { show?: string[]; showUnavailable?: string }>(outcome: T, app: string | undefined, connection?: () => Promise<LiveConfig>, signal?: AbortSignal): Promise<T> {
	if (!connection || !outcome.show) return outcome;
	if (!await supportsLive(app)) return { ...outcome, show: undefined, showUnavailable: "The installed app does not support live conversation panes. Build it with node extensions/markdown/native/build.mts. The saved document remains readable." };
	try {
		signal?.throwIfAborted();
		const config = await connection();
		signal?.throwIfAborted();
		const launch = await liveArguments(outcome.show, config);
		if (signal?.aborted) { await launch.remove(); signal.throwIfAborted(); }
		return { ...outcome, show: launch.argv };
	}
	catch { return { ...outcome, show: undefined, showUnavailable: "The exact invoking conversation is unavailable. The saved document remains readable from the Markdown view; no replacement conversation was selected." }; }
}
