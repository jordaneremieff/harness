/**
 * Real-session check for the collaboration contract: one dispatch carries a
 * shared-context snapshot into the worker, the worker sends an interim report
 * through `subagent_report` while it is still running, the report reaches the
 * dispatching session as a `subagent_report` custom message with its provenance
 * frame, and the worker still submits its own result afterwards.
 *
 * Runs in a child process because it sets PI_CODING_AGENT_DIR and HOME and
 * builds real Pi sessions with a faux provider.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeErrors: unknown[] = [];
const captureRuntimeError = (error: unknown) => {
	runtimeErrors.push(error);
};
process.on("unhandledRejection", captureRuntimeError);
process.on("uncaughtException", captureRuntimeError);
const agentDir = mkdtempSync(join(tmpdir(), "subagent-report-agent-"));
const cwd = mkdtempSync(join(tmpdir(), "subagent-report-cwd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Sessions discover user resources under $HOME. An empty home keeps this
// fixture's resource set deterministic on any machine.
const testHome = mkdtempSync(join(tmpdir(), "subagent-report-home-"));
process.env.HOME = testHome;
const marker = join(agentDir, "provider-calls.log");
const providerPath = join(agentDir, "report-provider.mjs");
const SNAPSHOT = "SHARED_SNAPSHOT_LINE_ONE\n\tSHARED_SNAPSHOT_LINE_TWO: é 中文";
function gate(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const reportGate = gate();
const submitGate = gate();
(globalThis as any)[Symbol.for("subagent-test.report-gates")] = {
	report: reportGate.promise,
	submit: submitGate.promise,
};
// A fresh module joins existing live process state without replacing its maps.
const retainedSurfaces = new Map();
(globalThis as any)[Symbol.for("pi-subagent.worker-runtime-state")] = {
	workerSessionIds: new Set(),
	submittedSessionIds: new Set(),
	workerSurfaces: retainedSurfaces,
};
const model = {
	id: "report-model",
	name: "Report Model",
	api: "report-provider-api",
	provider: "report-provider",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};
writeFileSync(
	providerPath,
	`import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const model = ${JSON.stringify(model)};
const snapshot = ${JSON.stringify(SNAPSHOT)};
export default function (pi) {
  const faux = fauxProvider({ api: model.api, provider: model.provider, models: [model] });
  let role;
  let calls = 0;
  const respond = async (context) => {
    calls++;
    const serialized = JSON.stringify(context.messages);
    role ??= serialized.includes("OWNER_TASK") ? "owner" : "worker";
    if (role === "worker") {
      if (calls === 1) {
        await globalThis[Symbol.for("subagent-test.report-gates")].report;
        appendFileSync(${JSON.stringify(marker)}, "worker-shared:" + serialized.includes(JSON.stringify(snapshot).slice(1, -1)) + "\\n");
        return fauxAssistantMessage(fauxToolCall("subagent_report", { message: "INTERIM_ONE: the first source is already correct" }), { stopReason: "toolUse" });
      }
      await globalThis[Symbol.for("subagent-test.report-gates")].submit;
      appendFileSync(${JSON.stringify(marker)}, "worker-ack:" + serialized.includes("sent_unconfirmed") + "\\n");
      return fauxAssistantMessage(fauxToolCall("submit_result", { content: "WORKER_RESULT" }), { stopReason: "toolUse" });
    }
    if (calls === 1) {
      return fauxAssistantMessage(fauxToolCall("subagent", { tasks: [{ task: "WORKER_TASK_A" }, { task: "WORKER_TASK_B" }], sharedContext: snapshot }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(serialized.includes("INTERIM_ONE") ? "OWNER_SAW_REPORT" : "OWNER_IDLE");
  };
  faux.setResponses(Array.from({ length: 16 }, () => respond));
  pi.registerProvider(faux.provider);
}
`,
	"utf-8",
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [providerPath] }), "utf-8");

let ownerSession: any = null;
try {
	const sub = await import("./index.ts");
	assert.equal(sub.sharedWorkerState.workerSurfaces, retainedSurfaces);
	assert.ok(sub.sharedWorkerState.workerOwners instanceof Map);
	assert.ok(sub.sharedWorkerState.reportSinks instanceof Map);
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const selfPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [selfPath],
	});
	await resourceLoader.reload();
	const created = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		model: model as never,
		thinkingLevel: "off",
		tools: ["subagent", "subagent_report"],
	});
	ownerSession = created.session;
	await ownerSession.bindExtensions({ onError: captureRuntimeError });

	await ownerSession.prompt("OWNER_TASK", { expandPromptTemplates: false });
	const reportMessage = () =>
		ownerSession.messages.find((message: any) => message.role === "custom" && message.customType === "subagent_report");
	assert.equal(ownerSession.isStreaming, false, "the parent is idle before reports are released");
	assert.equal(reportMessage(), undefined);
	const sawReport = () =>
		ownerSession.messages.some(
			(message: any) =>
				message.role === "assistant" &&
				message.content?.some((part: any) => part.type === "text" && part.text === "OWNER_SAW_REPORT"),
		);
	assert.equal(sawReport(), false);
	reportGate.resolve();
	const reportDeadline = Date.now() + 15_000;
	while (Date.now() < reportDeadline && !sawReport()) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(sawReport(), true, "the report alone starts a parent turn, before any completion exists");
	const activeWorkers = sub.listWorkers().filter((record) => record.task.startsWith("WORKER_TASK_"));
	assert.equal(activeWorkers.length, 2);
	assert.ok(activeWorkers.every((record) => record.state === "running"));
	submitGate.resolve();
	const deadline = Date.now() + 15_000;
	let workers = activeWorkers;
	while (Date.now() < deadline && workers.some((record) => record.state !== "done")) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		workers = sub.listWorkers().filter((record) => record.task.startsWith("WORKER_TASK_"));
	}
	assert.ok(
		workers.every((record) => record.state === "done"),
		JSON.stringify(workers),
	);
	assert.ok(workers.every((record) => record.sharedContextId === sub.sharedContextSnapshotId(SNAPSHOT)));
	assert.ok(workers.every((record) => record.sharedContextBytes === Buffer.byteLength(SNAPSHOT, "utf-8")));
	assert.ok(workers.every((record) => !sub.sharedWorkerState.workerOwners.has(record.sessionId)));
	const worker = workers.find((record) => record.id === reportMessage()?.details.id);
	assert.ok(worker, "the dispatch must create the reported worker record");
	assert.equal(worker.state, "done", JSON.stringify(worker));
	assert.equal(
		readFileSync(sub.workerFiles(worker.id).result, "utf-8"),
		"WORKER_RESULT",
		"an interim report must not replace or block the submitted result",
	);

	// Shared context: recorded by identifier and size, delivered verbatim.
	assert.equal(worker.sharedContextId, sub.sharedContextSnapshotId(SNAPSHOT), JSON.stringify(worker));
	assert.equal(worker.sharedContextBytes, Buffer.byteLength(SNAPSHOT, "utf-8"));
	const providerLog = readFileSync(marker, "utf-8");
	assert.equal(providerLog.match(/worker-shared:true/g)?.length, 2);
	assert.doesNotMatch(providerLog, /worker-shared:false/);
	// The reporter returned a normal, nonterminal tool result into the worker's
	// own context, and the worker kept working afterwards.
	assert.match(providerLog, /worker-ack:true/);

	const report = reportMessage();
	assert.ok(report, `the parent session must receive the report: ${JSON.stringify(ownerSession.messages)}`);
	const reportText = typeof report.content === "string" ? report.content : JSON.stringify(report.content);
	assert.match(reportText, /INTERIM_ONE/);
	assert.match(reportText, /interim report #1/);
	assert.match(reportText, /worker-authored content begins/);
	assert.equal(report.details.status, "sent_unconfirmed");
	assert.equal(report.details.id, worker.id);
	assert.equal(report.details.reportNumber, 1);

	// The report is delivered into the parent's turn, so the parent's own model
	// sees it.
	assert.equal(sawReport(), true, JSON.stringify(ownerSession.messages));

	// A settled worker keeps no reporting link, so a later report cannot route
	// to a session that no longer owns the worker.
	assert.equal(sub.sharedWorkerState.workerOwners.has(worker.sessionId), false);

	const ownerSessionId = ownerSession.sessionManager.getSessionId();
	sub.shutdownWorkerSession(ownerSession);
	ownerSession = null;
	const cleanupDeadline = Date.now() + 5_000;
	while (Date.now() < cleanupDeadline && sub.sharedWorkerState.reportSinks.has(ownerSessionId)) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(
		sub.sharedWorkerState.reportSinks.has(ownerSessionId),
		false,
		"a closed session must stop accepting reports",
	);
	assert.deepEqual(runtimeErrors, [], "the lifecycle must not emit asynchronous errors");
	console.log("report delivery child: PASS");
} finally {
	reportGate.resolve();
	submitGate.resolve();
	try {
		ownerSession?.dispose();
	} catch {}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
	rmSync(testHome, { recursive: true, force: true });
	process.off("unhandledRejection", captureRuntimeError);
	process.off("uncaughtException", captureRuntimeError);
}
