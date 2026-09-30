import { closeSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";

const TAIL_BYTES = 8192;

function fileTail(path: string): { text: string; omittedBytes: number } | { error: string } {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
		const start = Math.max(0, size - TAIL_BYTES);
		const bytes = readSync(fd, buffer, 0, buffer.length, start);
		return { text: buffer.subarray(0, bytes).toString("utf8"), omittedBytes: start };
	} catch (error) {
		return { error: String(error) };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Snapshot before cleanup, including when a test timeout leaves its body suspended. */
export function detachedTestEvidence(t: TestContext, root: string, files: Record<string, string>, snapshot: () => unknown) {
	let completed = false;
	let captured = false;
	const capture = (reason: unknown): void => {
		if (captured) return;
		captured = true;
		const evidence = JSON.stringify({
			root, reason: String(reason), snapshot: snapshot(),
			files: Object.fromEntries(Object.entries(files).map(([name, path]) => [name, fileTail(path)])),
		}, null, 2);
		try { writeFileSync(join(root, "failure-evidence.json"), evidence); }
		catch (error) { t.diagnostic(`Could not write detached test evidence: ${String(error)}`); }
		t.diagnostic(`Detached test evidence retained at ${root}\n${evidence}`);
	};
	t.after(() => { if (!completed) capture(t.signal.reason ?? "test did not complete"); });
	return {
		capture,
		complete: () => { completed = true; },
	};
}
