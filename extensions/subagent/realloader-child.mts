/**
 * Real-loader exercise for the post-submit compaction veto.
 *
 * The parent test runs this plain child script because V8 attributes a
 * jiti-transformed copy to the direct import's source URL. A separate coverage
 * directory keeps that measurement from merging two module instances. The
 * script verifies that a fresh loader copy registers the veto and honors a
 * real session_before_compact event.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "subagent-realloader-"));
// Sessions discover user resources under $HOME. An empty home keeps this
// exercise's resource set deterministic on any machine.
process.env.HOME = mkdtempSync(join(tmpdir(), "subagent-realloader-home-"));

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
	"@earendil-works/pi-coding-agent"
);
const { sharedWorkerState, submitResultTool } = await import("./index.ts");

async function main(): Promise<void> {
	const settingsManager = SettingsManager.create(agentDir, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: agentDir,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
	});
	await resourceLoader.reload();
	const created = await createAgentSession({
		cwd: agentDir,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		tools: ["read", "bash", "submit_result"],
		customTools: [
			submitResultTool(
				join(agentDir, "unused-result.txt"),
				() => undefined,
				() => "unused",
			),
		],
	});
	const session: any = created.session;

	// The restricted allowlist keeps the callable surface exact even though
	// the module registered its full surface.
	assert.deepEqual(session.getActiveToolNames().sort(), ["bash", "read", "submit_result"]);
	// The fresh jiti copy registered the veto on this session's runner.
	assert.equal(
		session.extensionRunner.hasHandlers("session_before_compact"),
		true,
		"a jiti copy of this module must register the veto on a worker load",
	);
	// Fire the real handler through the real runner: it must cancel a
	// threshold compaction for the submitted session.
	const sessionId = session.sessionManager.getSessionId();
	sharedWorkerState.submittedSessionIds.add(sessionId);
	try {
		const result = await session.extensionRunner.emit({
			type: "session_before_compact",
			preparation: {},
			branchEntries: [],
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		} as never);
		assert.deepEqual(
			(result as { cancel?: boolean } | undefined)?.cancel,
			true,
			"the veto cancels post-submit threshold compaction",
		);
	} finally {
		sharedWorkerState.submittedSessionIds.delete(sessionId);
	}
}

main().then(
	() => {
		console.log("real-loader child: PASS");
		process.exitCode = 0;
	},
	(error: unknown) => {
		console.error("real-loader child: FAIL", error);
		process.exitCode = 1;
	},
);
