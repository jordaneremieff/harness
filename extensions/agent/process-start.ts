/** Start tokens of local processes: which process holds a PID, by a value that no step of the wall clock changes. */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/** Resolution of a process start time read from `ps`, and the clock tolerance beside it. */
const PROCESS_START_TOLERANCE_MS = 2_000;

/**
 * The sources of a process start token. A token marks the start of the process that holds a PID by a value
 * that no step of the wall clock changes: on Linux the boot identity and the start in clock ticks since boot
 * from `/proc`; on macOS the start time that `ps` prints, which the kernel keeps as set at the process's
 * creation, so a later step moves no start. Other platforms have no such source.
 */
export interface ProcessStartSource {
	readonly platform: NodeJS.Platform;
	/** One small `/proc` file, or undefined when it cannot be read. */
	readonly readFile: (path: string) => string | undefined;
	/** The `lstart` column of `ps` for one PID in UTC, or undefined when it cannot be read. */
	readonly psStart: (pid: number) => Promise<string | undefined>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Seconds since the epoch of `ps -o lstart=` in UTC: `Tue Nov 24 11:55:00 2026`. */
export function lstartSeconds(text: string): number | undefined {
	const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(text.trim());
	const month = match === null ? -1 : MONTHS.indexOf(match[1]);
	if (match === null || month < 0) return undefined;
	const [, , day, hours, minutes, seconds, year] = match;
	return Date.UTC(Number(year), month, Number(day), Number(hours), Number(minutes), Number(seconds)) / 1000;
}

/** The start token of the process that holds `pid`, or undefined where no clock-proof source answers. */
export async function processStartToken(pid: number, source: ProcessStartSource): Promise<string | undefined> {
	if (source.platform === "linux") {
		const stat = source.readFile(`/proc/${pid}/stat`);
		const boot = source.readFile("/proc/sys/kernel/random/boot_id")?.trim();
		// Field 22 of stat; the command name in field 2 can hold spaces, so count from its closing parenthesis.
		const ticks = stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		return boot && ticks && /^\d+$/u.test(ticks) ? `linux:${boot}:${ticks}` : undefined;
	}
	if (source.platform === "darwin") {
		const text = await source.psStart(pid);
		const seconds = text === undefined ? undefined : lstartSeconds(text);
		return seconds === undefined ? undefined : `darwin:${seconds}`;
	}
	return undefined;
}

/** The start sources of this machine's processes. */
export const localProcessStart: ProcessStartSource = {
	platform: process.platform,
	readFile: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	psStart: (pid) =>
		new Promise((done) => {
			execFile(
				"ps",
				["-o", "lstart=", "-p", String(pid)],
				{ timeout: 2_000, env: { ...process.env, TZ: "UTC0", LC_ALL: "C" } },
				(error, stdout) => done(error === null ? String(stdout) : undefined),
			);
		}),
};

/**
 * Whether the process that now holds `pid` started after `writtenAt`, or undefined when no start can be compared.
 * On macOS both are wall times that a later step of the clock leaves as they were, and the comparison allows for
 * the one-second resolution of `ps`. Other platforms supply no start that compares with a wall time.
 */
export async function startedAfter(
	pid: number,
	writtenAt: string,
	source: ProcessStartSource,
): Promise<boolean | undefined> {
	if (source.platform !== "darwin") return undefined;
	const current = await processStartToken(pid, source);
	const written = Date.parse(writtenAt);
	if (current === undefined || !Number.isFinite(written)) return undefined;
	return Number(current.slice("darwin:".length)) * 1000 > written + PROCESS_START_TOLERANCE_MS;
}

/**
 * Whether the process that holds a record's PID is another process than the one that wrote the record. A
 * record with a start token compares it with the holder's token from the same source: a different token proves
 * reuse, whatever the clock did. A record without one compares the holder's start with the record's write time;
 * where no such comparison is available it proves nothing, so the record ends only when no process holds its PID.
 */
export async function ownerStartReused(
	record: { readonly pid: number; readonly startedAt: string; readonly processStart?: string },
	source: ProcessStartSource,
): Promise<boolean> {
	if (record.processStart === undefined) return (await startedAfter(record.pid, record.startedAt, source)) === true;
	const current = await processStartToken(record.pid, source);
	return (
		current !== undefined &&
		current.split(":")[0] === record.processStart.split(":")[0] &&
		current !== record.processStart
	);
}
