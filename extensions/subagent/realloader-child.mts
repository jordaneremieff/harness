/**
 * Real-loader exercise for the post-submit compaction veto, run as a child
 * process by index.test.mts.
 *
 * Purpose: prove that a jiti-loaded copy of the subagent module (exactly what
 * a worker sees, including a custom-cwd worker, because pi's extension-factory
 * cache is per-cwd and re-imports the file) takes the worker branch through the
 * process-global construction state, registers the session_before_compact
 * veto, and that a real emit cancels post-submit threshold compaction.
 *
 * Why a child process: node's --experimental-test-coverage attributes the
 * jiti-transformed copy's execution to the same file URL as the direct import
 * and corrupts the coverage report for index.ts, pushing the suite below the
 * coverage gate (a measurement artifact, not a real regression). Node also
 * passes NODE_V8_COVERAGE through to every spawned child, so the parent test
 * redirects this child's coverage to a private directory; the child itself
 * runs without the coverage flags. The production loading path stays
 * exercised while the parent suite's coverage measurement stays clean.
 *
 * This is a plain script, not a node:test file: the parent spawns it with
 * `node <path>` and asserts its exit code. It deliberately does not match the
 * repo test glob for extension test files.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "subagent-realloader-"));

const {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { sharedWorkerState, submitResultTool } = await import("./index.ts");

async function main(): Promise<void> {
	const settingsManager = SettingsManager.create(agentDir, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: agentDir,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		additionalExtensionPaths: [
			join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
		],
	});
	// The dispatcher's construction count is process-global: the jiti copy
	// must see itself as a worker load even though its own module scope
	// starts empty.
	sharedWorkerState.constructingWorkers = 1;
	let session: any;
	try {
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
		session = created.session;
	} finally {
		sharedWorkerState.constructingWorkers = 0;
	}

	// The restricted allowlist keeps the callable surface exact even though
	// the module registered its full surface.
	assert.deepEqual(session.getActiveToolNames().sort(), [
		"bash",
		"read",
		"submit_result",
	]);
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
