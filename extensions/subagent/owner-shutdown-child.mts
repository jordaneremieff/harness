import { strict as assert } from "node:assert";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The host fields a directly-executed tool reads from this sparse fixture context. */
type ToolContextFixture = Pick<ExtensionContext, "cwd" | "modelRegistry"> & {
	thinkingLevel?: ExtensionContext["thinkingLevel"];
	model?: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
	ui: Pick<ExtensionContext["ui"], "setStatus">;
};

const agentDir = mkdtempSync(join(tmpdir(), "subagent-owner-shutdown-agent-"));
const cwd = mkdtempSync(join(tmpdir(), "subagent-owner-shutdown-cwd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Sessions discover user resources under $HOME. An empty home keeps this
// fixture's resource set deterministic on any machine.
const testHome = mkdtempSync(join(tmpdir(), "subagent-owner-shutdown-home-"));
process.env.HOME = testHome;
const marker = join(agentDir, "provider-started");
const providerPath = join(agentDir, "owner-provider.mjs");
const model = {
	id: "owner-model",
	name: "Owner Model",
	api: "owner-provider-api",
	provider: "owner-provider",
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
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const model = ${JSON.stringify(model)};
export default function (pi) {
  const faux = fauxProvider({ api: model.api, provider: model.provider, models: [model] });
  const hold = (_context, options) => {
    appendFileSync(${JSON.stringify(marker)}, "started\\n");
    return new Promise((resolve) => {
      const finish = () => setTimeout(
        () => resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" })),
        100,
      );
      if (options?.signal?.aborted) finish();
      else options?.signal?.addEventListener("abort", finish, { once: true });
    });
  };
  faux.setResponses([hold, hold]);
  pi.registerProvider(faux.provider);
}
`,
	"utf-8",
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [providerPath] }), "utf-8");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
/** getToolDefinition erases each tool's detail type; narrow the shape the fixture consumes. */
const toolDetails = (result: { details: unknown }): Record<string, unknown> => {
	assert.ok(isRecord(result.details), "the tool result carries object details");
	return result.details;
};
let ownerSession: AgentSession | null = null;
try {
	const sub = await import("./index.ts");
	const { createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } = await import(
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
		tools: ["subagent", "subagent_steer", "subagent_interrupt", "subagent_kill", "submit_result"],
	});
	ownerSession = created.session;
	sub.sharedWorkerState.workerSessionIds.add(ownerSession.sessionManager.getSessionId());
	await ownerSession.bindExtensions({});

	const tool = ownerSession.extensionRunner.getToolDefinition("subagent");
	const steerTool = ownerSession.extensionRunner.getToolDefinition("subagent_steer");
	const interruptTool = ownerSession.extensionRunner.getToolDefinition("subagent_interrupt");
	const killTool = ownerSession.extensionRunner.getToolDefinition("subagent_kill");
	assert.ok(tool && steerTool && interruptTool && killTool);
	const ownerSessionId = ownerSession.sessionManager.getSessionId();
	// The extension reads only these context fields when its tool runs directly here,
	// so the fixture supplies a partial host context instead of a full session interior.
	const ctx = {
		cwd,
		thinkingLevel: "off",
		model,
		modelRegistry: new ModelRegistry(ownerSession.modelRuntime),
		sessionManager: { getSessionId: () => ownerSessionId },
		ui: { setStatus: () => undefined },
	} satisfies ToolContextFixture as unknown as ExtensionContext;
	const dispatched = await tool.execute(
		"nested-owner",
		{ task: "hold until the owner closes" },
		undefined,
		undefined,
		ctx,
	);
	const workers = toolDetails(dispatched).workers;
	assert.ok(isUnknownArray(workers), JSON.stringify(dispatched));
	const firstWorker = workers[0];
	assert.ok(isRecord(firstWorker), JSON.stringify(dispatched));
	const idValue = firstWorker.id;
	assert.ok(isString(idValue), JSON.stringify(dispatched));
	const id = idValue;

	const startedDeadline = Date.now() + 5_000;
	while (Date.now() < startedDeadline) {
		if (existsSync(marker) && sub.readWorker(id)?.state === "running") break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(existsSync(marker), true, "the nested provider must start");
	const before = sub.readWorker(id);
	assert.equal(before?.state, "running");
	assert.equal(before?.ownerSession, ownerSessionId);
	assert.deepEqual(
		[...(before?.resolvedTools ?? [])].sort(),
		[...new Set([...ownerSession.getActiveToolNames(), "submit_result"])].sort(),
		"nested dispatch must inherit the owner session's exact active surface",
	);
	assert.equal(
		sub.sharedWorkerState.workerSurfaces.has(before?.sessionId ?? ""),
		true,
		"dispatch must publish the nested worker's actual surface",
	);

	const foreignCtx = {
		...ctx,
		sessionManager: { getSessionId: () => "different-live-session" },
	} satisfies ToolContextFixture as unknown as ExtensionContext;
	const refusedSteer = await steerTool.execute(
		"foreign-steer",
		{ id, message: "must not arrive" },
		undefined,
		undefined,
		foreignCtx,
	);
	assert.equal(toolDetails(refusedSteer).ok, false);
	const refusedInterrupt = await interruptTool.execute("foreign-interrupt", { id }, undefined, undefined, foreignCtx);
	assert.match(JSON.stringify(refusedInterrupt.content), /another live session/);
	const refusedKill = await killTool.execute("foreign-kill", { id }, undefined, undefined, foreignCtx);
	assert.match(JSON.stringify(refusedKill.content), /another live session/);
	assert.equal(sub.readWorker(id)?.state, "running");
	assert.equal(sub.readWorker(id)?.interruptedAt, null);

	// A second steer during the abort window must not queue a second resumed
	// prompt over the same run leg.
	const interrupting = interruptTool.execute("owner-interrupt", { id }, undefined, undefined, ctx);
	const interruptDeadline = Date.now() + 2_000;
	while (Date.now() < interruptDeadline && !sub.readWorker(id)?.interruptedAt) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(sub.readWorker(id)?.interruptedAt);
	const firstResume = await steerTool.execute(
		"owner-resume",
		{ id, message: "resume exactly once" },
		undefined,
		undefined,
		ctx,
	);
	assert.match(JSON.stringify(firstResume.content), /Resume queued/);
	const duplicateResume = await steerTool.execute(
		"owner-resume-duplicate",
		{ id, message: "must not start" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(toolDetails(duplicateResume).ok, false);
	assert.match(JSON.stringify(duplicateResume.content), /already queued/);
	await interrupting;
	const resumedDeadline = Date.now() + 2_000;
	while (Date.now() < resumedDeadline && readFileSync(marker, "utf-8").trim().split("\n").length < 2) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(
		readFileSync(marker, "utf-8").trim().split("\n").length,
		2,
		"only the first queued resume starts a new provider turn",
	);

	sub.shutdownWorkerSession(ownerSession);
	ownerSession = null;
	const closedDeadline = Date.now() + 5_000;
	let after = sub.readWorker(id);
	// shutdownWorkerSession schedules its async lifecycle handler. Wait for both
	// worker cleanup and the owning session's surface cleanup before asserting.
	while (
		Date.now() < closedDeadline &&
		(after?.state === "running" || sub.sharedWorkerState.workerSurfaces.has(ownerSessionId))
	) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		after = sub.readWorker(id);
	}
	assert.equal(after?.state, "owner_lost", JSON.stringify(after));
	assert.equal(
		readFileSync(marker, "utf-8").trim().split("\n").length,
		2,
		"owner shutdown must not start another turn in the closing session",
	);
	assert.equal(sub.sharedWorkerState.workerSurfaces.has(ownerSessionId), false);
	assert.equal(sub.sharedWorkerState.workerSurfaces.has(after?.sessionId ?? ""), false);
	console.log("owner shutdown child: PASS");
} finally {
	try {
		ownerSession?.dispose();
	} catch {}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
	rmSync(testHome, { recursive: true, force: true });
}
