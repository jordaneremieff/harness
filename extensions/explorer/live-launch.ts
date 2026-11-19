import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { LIVE_LIFETIME, type LiveConfig, readLiveConfig } from "./live-protocol.ts";

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
	if (owner.closed) throw new Error("The live Explorer host closed.");
}

/** The native process consumes the private capability; model-visible argv contains only its one-use path. */
export async function liveArguments(
	argv: string[],
	live?: LiveConfig,
	agentDir = getAgentDir(),
): Promise<{ argv: string[]; remove: () => Promise<void> }> {
	if (!live) return { argv, remove: async () => {} };
	const config = readLiveConfig(live);
	const owner = launchOwner(live[LIVE_LIFETIME]);
	checkOwner(owner);
	const directory = join(agentDir, "explorer-live");
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
