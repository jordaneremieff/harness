/**
 * Fork command assembly — shell-safe `pi --fork` one-liner.
 *
 * Both paths are single-quoted with POSIX `'\''` escaping so spaces and
 * quotes survive any shell. Newlines in a path would break the one-liner
 * entirely and are refused. `cd --` protects a cwd that begins with `-`.
 */

export type ForkCommandResult = { ok: true; text: string } | { ok: false; error: string };

function quoteShell(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildForkCommand(cwd: string, sessionFile: string): ForkCommandResult {
	if (cwd.includes("\n") || sessionFile.includes("\n")) {
		return { ok: false, error: "Cannot pivot from a path containing a newline" };
	}
	return {
		ok: true,
		text: `cd -- ${quoteShell(cwd)} && pi --fork ${quoteShell(sessionFile)}`,
	};
}
