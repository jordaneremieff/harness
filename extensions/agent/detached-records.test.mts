import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DetachedRuns } from "./detached.ts";

for (const kind of ["request", "progress", "result"] as const) {
	test(`detached ${kind} FIFO records cannot block the reader`, { timeout: 6000 }, () => {
		const root = mkdtempSync(join(tmpdir(), "agent-special-record-"));
		try {
			const runs = new DetachedRuns(root);
			const runId = "fifo";
			if (kind !== "request") runs.writeRequest({ runId, sessionId: "session", sessionsRoot: root, agentDir: root, cwd: root, prompt: "work", logFile: runs.logFile(runId), startedAt: new Date().toISOString(), pid: process.pid, launchState: "started" });
			const path = kind === "request" ? runs.requestFile(runId) : kind === "progress" ? runs.progressFile(runId) : runs.resultFile(runId);
			mkdirSync(dirname(path), { recursive: true });
			execFileSync("mkfifo", ["-m", "600", path], { timeout: 2000, maxBuffer: 4096 });
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
				import assert from "node:assert/strict";
				import { DetachedRuns, readDetachedRequest } from ${JSON.stringify(new URL("./detached.ts", import.meta.url).href)};
				const view = new DetachedRuns(${JSON.stringify(root)}).get("fifo");
				if (${JSON.stringify(kind)} === "request") {
					assert.equal(view, undefined);
					assert.equal(readDetachedRequest(${JSON.stringify(path)}), undefined);
				} else {
					assert.equal(view.state, "running");
					assert.equal(view[${JSON.stringify(kind)}], undefined);
				}
				console.log("special-record-rejected");
			`], { timeout: 2500, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 8192 });
			assert.equal(child.status, 0, JSON.stringify({ error: child.error?.message, signal: child.signal, stdout: child.stdout, stderr: child.stderr }));
			assert.equal(child.stdout, "special-record-rejected\n");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}
