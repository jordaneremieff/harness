import { strict as assert } from "node:assert";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "subagent-owner-shutdown-agent-"));
const cwd = mkdtempSync(join(tmpdir(), "subagent-owner-shutdown-cwd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
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
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ packages: [providerPath], defaultProjectTrust: "always" }),
	"utf-8",
);

let ownerSession: any = null;
try {
	const sub = await import("./index.ts");
	const {
		createAgentSession,
		DefaultResourceLoader,
		SessionManager,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");
	const selfPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
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
		tools: [
			"subagent",
			"subagent_steer",
			"subagent_interrupt",
			"subagent_kill",
			"submit_result",
		],
	});
	ownerSession = created.session;
	sub.sharedWorkerState.workerSessionIds.add(
		ownerSession.sessionManager.getSessionId(),
	);
	await ownerSession.bindExtensions({});

	const tool = ownerSession.extensionRunner.getToolDefinition("subagent");
	const steerTool =
		ownerSession.extensionRunner.getToolDefinition("subagent_steer");
	const interruptTool =
		ownerSession.extensionRunner.getToolDefinition("subagent_interrupt");
	const killTool =
		ownerSession.extensionRunner.getToolDefinition("subagent_kill");
	assert.ok(tool && steerTool && interruptTool && killTool);
	const ownerSessionId = ownerSession.sessionManager.getSessionId();
	const ctx = {
		cwd,
		thinkingLevel: "off",
		model,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === model.provider && id === model.id ? model : null,
			getAvailable: () => [model],
			hasConfiguredAuth: () => true,
		},
		sessionManager: { getSessionId: () => ownerSessionId },
		ui: { setStatus: () => undefined },
	};
	const dispatched = (await tool.execute(
		"nested-owner",
		{ task: "hold until the owner closes" },
		undefined,
		undefined,
		ctx,
	)) as any;
	const id = dispatched.details.workers[0].id as string;
	assert.ok(id, JSON.stringify(dispatched));

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
		[
			...new Set([...ownerSession.getActiveToolNames(), "submit_result"]),
		].sort(),
		"nested dispatch must inherit the owner session's exact active surface",
	);
	assert.equal(
		sub.sharedWorkerState.workerSurfaces.has(before?.sessionId ?? ""),
		true,
		"dispatch must publish the nested worker's actual surface",
	);
	assert.equal(
		Boolean(before?.socketPath && existsSync(before.socketPath)),
		true,
	);

	const foreignCtx = {
		...ctx,
		sessionManager: { getSessionId: () => "different-live-session" },
	};
	const refusedSteer = (await steerTool.execute(
		"foreign-steer",
		{ id, message: "must not arrive" },
		undefined,
		undefined,
		foreignCtx,
	)) as any;
	assert.equal(refusedSteer.details.ok, false);
	const refusedInterrupt = (await interruptTool.execute(
		"foreign-interrupt",
		{ id },
		undefined,
		undefined,
		foreignCtx,
	)) as any;
	assert.match(
		JSON.stringify(refusedInterrupt.content),
		/another live session/,
	);
	const refusedKill = (await killTool.execute(
		"foreign-kill",
		{ id },
		undefined,
		undefined,
		foreignCtx,
	)) as any;
	assert.match(JSON.stringify(refusedKill.content), /another live session/);
	assert.equal(sub.readWorker(id)?.state, "running");
	assert.equal(sub.readWorker(id)?.interruptedAt, null);

	// A second steer during the abort window must not queue a second resumed
	// prompt over the same run leg.
	const interrupting = interruptTool.execute(
		"owner-interrupt",
		{ id },
		undefined,
		undefined,
		ctx,
	) as Promise<any>;
	const interruptDeadline = Date.now() + 2_000;
	while (Date.now() < interruptDeadline && !sub.readWorker(id)?.interruptedAt) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(sub.readWorker(id)?.interruptedAt);
	const firstResume = (await steerTool.execute(
		"owner-resume",
		{ id, message: "resume exactly once" },
		undefined,
		undefined,
		ctx,
	)) as any;
	assert.match(JSON.stringify(firstResume.content), /Resume queued/);
	const duplicateResume = (await steerTool.execute(
		"owner-resume-duplicate",
		{ id, message: "must not start" },
		undefined,
		undefined,
		ctx,
	)) as any;
	assert.equal(duplicateResume.details.ok, false);
	assert.match(JSON.stringify(duplicateResume.content), /already queued/);
	await interrupting;
	const resumedDeadline = Date.now() + 2_000;
	while (
		Date.now() < resumedDeadline &&
		readFileSync(marker, "utf-8").trim().split("\n").length < 2
	) {
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
	while (
		Date.now() < closedDeadline &&
		(after?.state === "running" ||
			Boolean(after?.socketPath && existsSync(after.socketPath)))
	) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		after = sub.readWorker(id);
	}
	assert.equal(after?.state, "owner_lost", JSON.stringify(after));
	assert.equal(
		Boolean(after?.socketPath && existsSync(after.socketPath)),
		false,
	);
	assert.equal(
		readFileSync(marker, "utf-8").trim().split("\n").length,
		2,
		"owner shutdown must not start another turn in the closing session",
	);
	assert.equal(sub.sharedWorkerState.workerSurfaces.has(ownerSessionId), false);
	assert.equal(
		sub.sharedWorkerState.workerSurfaces.has(after?.sessionId ?? ""),
		false,
	);
	if (after?.socketPath) {
		rmSync(dirname(after.socketPath), { recursive: true, force: true });
	}
	console.log("owner shutdown child: PASS");
} finally {
	try {
		ownerSession?.dispose();
	} catch {}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}
