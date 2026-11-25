/**
 * A host's own account of whether it has work that can run now, beside its storage's writer lease. The host rewrites
 * the file only when the answer changes, so its time says since when the answer holds. Outside supervision reads it
 * to tell a host that waits by design (sleeping, waiting or completing tasks) from one whose runnable work makes no
 * progress. The file names the writing process, so a later process never inherits an earlier host's account.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const FORMAT = "pi.agent.host-activity/1";
const ACTIVITY_BYTES = 4096;

export interface HostActivity {
	readonly pid: number;
	readonly runnable: boolean;
	/** ISO time since which `runnable` holds. */
	readonly since: string;
}

export function hostActivityPath(storagePath: string): string {
	return join(dirname(storagePath), ".leases", `${basename(storagePath)}.activity`);
}

/** A publisher for one host process; it writes when the answer changes and reports a failed write once. */
export function hostActivityPublisher(
	storagePath: string,
	report: (error: unknown) => void,
): (runnable: boolean) => void {
	const path = hostActivityPath(storagePath);
	let last: boolean | undefined;
	let reported = false;
	return (runnable) => {
		if (runnable === last) return;
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			const temporary = `${path}.${process.pid}.tmp`;
			const activity: HostActivity = { pid: process.pid, runnable, since: new Date().toISOString() };
			writeFileSync(temporary, JSON.stringify({ format: FORMAT, ...activity }), { mode: 0o600 });
			renameSync(temporary, path);
			last = runnable;
		} catch (error) {
			if (!reported) report(error);
			reported = true;
		}
	};
}

/** The account that process `pid` published for the storage, or undefined when it published none. */
export function readHostActivity(storagePath: string, pid: number): HostActivity | undefined {
	try {
		const text = readFileSync(hostActivityPath(storagePath), "utf8");
		if (text.length > ACTIVITY_BYTES) return undefined;
		const value = JSON.parse(text) as { format?: unknown; pid?: unknown; runnable?: unknown; since?: unknown };
		if (value.format !== FORMAT || value.pid !== pid || typeof value.runnable !== "boolean") return undefined;
		if (typeof value.since !== "string" || !Number.isFinite(Date.parse(value.since))) return undefined;
		return { pid, runnable: value.runnable, since: value.since };
	} catch {
		return undefined;
	}
}
