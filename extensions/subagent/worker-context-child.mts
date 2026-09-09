import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeErrors: unknown[] = [];
const captureRuntimeError = (error: unknown) => { runtimeErrors.push(error); console.error(error); process.exitCode = 1; };
process.on("unhandledRejection", captureRuntimeError);
process.on("uncaughtException", captureRuntimeError);

const agentDir = mkdtempSync(join(tmpdir(), "subagent-context-agent-"));
const home = mkdtempSync(join(tmpdir(), "subagent-context-home-"));
const parentCwd = mkdtempSync(join(tmpdir(), "subagent-parent-cwd-"));
const trustedCwd = mkdtempSync(join(tmpdir(), "subagent-trusted-cwd-"));
const untrustedCwd = mkdtempSync(join(tmpdir(), "subagent-untrusted-cwd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Pi reads user skills from $HOME/.agents/skills. An empty home keeps the
// observed resource set exactly what this fixture writes.
process.env.HOME = home;

const contextSentinel = (label: string) => `SENTINEL_CONTEXT_FILE_${label}`;
const skillSentinel = (label: string) => `sentinel-skill-${label}`;
const markerPath = (label: string) => join(agentDir, `${label}-extension-ran`);
const sessionMarkerPath = (label: string) => join(agentDir, `${label}-extension-sessions`);
const promptPath = (label: string) => join(agentDir, `${label}-worker-prompt.txt`);
const replacementTurnRequest = join(agentDir, "replacement-turn-request");
const slowReplacementRequest = join(agentDir, "slow-replacement-request");
const slowReplacementBound = join(agentDir, "slow-replacement-bound");

/** Give a directory a project extension, a project skill, and a context file. */
function seedProject(cwd: string, label: string): void {
	const marker = markerPath(label);
	const extensionPath = join(cwd, "project-extension.mjs");
	writeFileSync(
		extensionPath,
		`import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
export default function (pi) {
  appendFileSync(${JSON.stringify(marker)}, "factory\\n");
  pi.on("session_start", async (_event, ctx) => {
    appendFileSync(${JSON.stringify(marker)}, "start\\n");
    appendFileSync(${JSON.stringify(sessionMarkerPath(label))}, ctx.sessionManager.getSessionId() + "\\n");
    const profileEntry = ctx.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === "subagent_profile");
    if (profileEntry) writeFileSync(${JSON.stringify(join(agentDir, "profile-at-session-start.json"))}, JSON.stringify(profileEntry), "utf8");
    const request = ${JSON.stringify(replacementTurnRequest)};
    if (existsSync(request)) {
      rmSync(request, { force: true });
      pi.sendUserMessage("replacement worker task");
    }
    const slowRequest = ${JSON.stringify(slowReplacementRequest)};
    if (existsSync(slowRequest)) {
      rmSync(slowRequest, { force: true });
      writeFileSync(${JSON.stringify(slowReplacementBound)}, "bound", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  pi.registerCommand("worker-reload", {
    description: "Reload the worker session resources",
    handler: async (_args, ctx) => ctx.reload(),
  });
  pi.registerCommand("worker-send", {
    description: "Start worker work through the extension API",
    handler: () => pi.sendUserMessage("command-generated worker task"),
  });
  pi.registerCommand("worker-new", {
    description: "Replace the worker session and continue there",
    handler: async (_args, ctx) => {
      writeFileSync(${JSON.stringify(replacementTurnRequest)}, "start", "utf8");
      return ctx.newSession();
    },
  });
  pi.registerCommand("worker-slow-new", {
    description: "Replace the worker session after a delayed start hook",
    handler: async (_args, ctx) => {
      writeFileSync(${JSON.stringify(slowReplacementRequest)}, "start", "utf8");
      return ctx.newSession();
    },
  });
  pi.on("session_before_compact", (event) => {
    if (event.customInstructions !== "PROFILE_COMPACT") return;
    const firstUser = event.branchEntries.find((entry) => entry.type === "message" && entry.message.role === "user");
    if (!firstUser) throw new Error("Profile fixture requires a retained task before compaction.");
    return { compaction: { summary: "PROFILE_SYNTHETIC_SUMMARY", firstKeptEntryId: firstUser.id, tokensBefore: event.preparation.tokensBefore } };
  });
  pi.registerCommand("worker-profile-compact", {
    description: "Compact the retained profile context and request the next task",
    handler: async (_args, ctx) => {
      pi.sendMessage({ customType: "profile_compaction_input", content: "synthetic context ".repeat(256), display: false }, { triggerTurn: false });
      await new Promise((resolve, reject) => ctx.compact({ customInstructions: "PROFILE_COMPACT", onComplete: resolve, onError: reject }));
      pi.sendUserMessage("PROFILE_POST_COMPACTION_TASK");
    },
  });
  pi.registerCommand("worker-profile-navigate", {
    description: "Return before profile history and request another task",
    handler: async (_args, ctx) => {
      const target = ctx.sessionManager.getBranch().find((entry) => entry.type === "thinking_level_change");
      if (!target) throw new Error("The initial branch metadata is absent.");
      await ctx.navigateTree(target.id, { summarize: false });
      pi.sendUserMessage("PROFILE_POST_NAVIGATION_TASK");
    },
  });
  pi.registerCommand("worker-fail", {
    description: "Fail the worker command",
    handler: () => { throw new Error("command exploded"); },
  });
}
`,
		"utf8",
	);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [extensionPath], compaction: { enabled: false, keepRecentTokens: 128 } }), "utf8");
	const skillDir = join(cwd, ".agents", "skills", skillSentinel(label));
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		[
			"---",
			`name: ${skillSentinel(label)}`,
			"description: Sentinel skill for the worker context fixture.",
			"---",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(join(cwd, "AGENTS.md"), `${contextSentinel(label)}\n`, "utf8");
}

function fauxModel(label: string): Record<string, unknown> {
	return {
		id: `cwd-model-${label}`,
		name: `Cwd Model ${label}`,
		api: `cwd-api-${label}`,
		provider: `cwd-provider-${label}`,
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

/**
 * Write a provider package whose first response records the requesting
 * session's whole system prompt, then submits a result. Each worker gets its
 * own provider so one worker's response queue cannot starve the other.
 */
function seedProvider(label: string): string {
	const providerPath = join(agentDir, `provider-${label}.mjs`);
	writeFileSync(
		providerPath,
		`import { existsSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const guard = Symbol.for("pi-subagent.test.provider.${label}");
const model = ${JSON.stringify(fauxModel(label))};
export default function (pi) {
  if (globalThis[guard]) return;
  globalThis[guard] = true;
  const faux = fauxProvider({ api: model.api, provider: model.provider, models: [model] });
  const respond = (context) => {
    const path = ${JSON.stringify(promptPath(label))};
    if (!existsSync(path)) writeFileSync(path, context.systemPrompt ?? "", "utf8");
    writeFileSync(path + ".context.json", JSON.stringify(context), "utf8");
    return fauxAssistantMessage(fauxToolCall("submit_result", { content: "CWD_RESULT" }), { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 8 }, () => respond));
  pi.registerProvider(faux.provider);
}
`,
		"utf8",
	);
	return providerPath;
}

seedProject(trustedCwd, "trusted");
seedProject(untrustedCwd, "untrusted");
const providerLabels = [
	"trusted",
	"reload",
	"command",
	"replacement",
	"slow-replacement",
	"failure",
	"untrusted",
	"profile",
	"profile-override",
	"profile-instructions",
	"profile-replacement",
	"fallback",
];
const providerPaths = providerLabels.map(seedProvider);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: providerPaths, compaction: { enabled: false, keepRecentTokens: 128 } }), "utf8");

let parentSession: any = null;
try {
	const sub = await import("./index.ts");
	const { deriveWorkerLabel } = await import("./profiles.ts");
	const {
		createAgentSessionFromServices,
		createAgentSessionServices,
		ModelRegistry,
		ProjectTrustStore,
		SessionManager,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");
	// Only one directory carries a saved trust decision. The other has no answer
	// available, which is what any session finds when nobody can be asked.
	new ProjectTrustStore(agentDir).set(trustedCwd, true);

	const selfPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
	const services = await createAgentSessionServices({
		cwd: parentCwd,
		agentDir,
		settingsManager: SettingsManager.create(parentCwd, agentDir),
		resourceLoaderOptions: { additionalExtensionPaths: [selfPath] },
	});
	const created = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(),
		model: fauxModel("trusted") as never,
		thinkingLevel: "off",
		tools: ["subagent", "read"],
	});
	parentSession = created.session;
	const parentSessionId = parentSession.sessionManager.getSessionId();
	sub.sharedWorkerState.workerSessionIds.add(parentSessionId);
	await parentSession.bindExtensions({});
	// Native registration refreshes availability asynchronously. Synchronous
	// dispatch validation needs the completed public runtime snapshot.
	await parentSession.modelRuntime.refresh({ allowNetwork: false });

	const dispatch = parentSession.extensionRunner.getToolDefinition("subagent");
	const kill = parentSession.extensionRunner.getToolDefinition("subagent_kill");
	assert.ok(dispatch);
	assert.ok(kill);
	const parentRegistry = new ModelRegistry(parentSession.modelRuntime);
	for (const label of providerLabels) {
		assert.ok(
			parentRegistry.getRegisteredNativeProvider(`cwd-provider-${label}`),
			`the parent must hold the native-form provider registration for ${label}`,
		);
	}

	const startWorker = async (cwd: string, label: string, task = "work in the selected directory"): Promise<string> => {
		const model = fauxModel(label);
		const toolContext = {
			cwd: parentCwd,
			thinkingLevel: "off",
			model,
			modelRegistry: parentRegistry,
			sessionManager: { getSessionId: () => parentSessionId },
			ui: { setStatus: () => undefined },
		};
		const result = (await dispatch.execute(
			"worker-context",
			{ task, cwd, tools: ["read"], model: `${model.provider}/${model.id}` },
			undefined,
			undefined,
			toolContext,
		)) as any;
		const id = result.details.workers[0].id as string;
		assert.ok(id, JSON.stringify(result));
		return id;
	};

	const runWorker = async (
		cwd: string,
		label: string,
		task = "work in the selected directory",
		expectedState = "done",
		expectedDiagnostics: string[] = [],
	): Promise<any> => {
		const id = await startWorker(cwd, label, task);
		const deadline = Date.now() + 10_000;
		let record = sub.readWorker(id);
		while (Date.now() < deadline && record?.state === "running") {
			await new Promise((resolve) => setTimeout(resolve, 10));
			record = sub.readWorker(id);
		}
		assert.equal(record?.state, expectedState, JSON.stringify(record));
		assert.deepEqual(record?.setupDiagnostics, expectedDiagnostics, JSON.stringify(record?.setupDiagnostics));
		return record;
	};

	// A full-session worker that ends an ordinary turn without a submitted result
	// stays live and idle; only a defined terminal path finalizes it.
	const waitForIdle = async (id: string): Promise<any> => {
		const deadline = Date.now() + 10_000;
		let record = sub.readWorker(id);
		while (Date.now() < deadline && record?.idleSince == null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			record = sub.readWorker(id);
		}
		assert.equal(record?.state, "running", JSON.stringify(record));
		assert.ok(record?.idleSince != null, JSON.stringify(record));
		return record!;
	};

	await runWorker(trustedCwd, "trusted");
	const trustedPrompt = readFileSync(promptPath("trusted"), "utf8");

	// A trusted working directory gives the worker that directory's project
	// extension, project skill, and context file.
	assert.equal(
		existsSync(markerPath("trusted")) ? readFileSync(markerPath("trusted"), "utf8") : "",
		"factory\nstart\n",
		"a trusted working directory must load and start its project extension",
	);
	assert.equal(
		trustedPrompt.includes(skillSentinel("trusted")),
		true,
		"a trusted working directory must offer its project skill",
	);
	assert.equal(
		trustedPrompt.includes(contextSentinel("trusted")),
		true,
		"the worker must load its working directory's context file",
	);

	// Worker command contexts use the same real session-control host as Pi's
	// normal modes. Reload rebuilds resources, and a pure control command ends
	// cleanly without a submitted result: the worker stays live and idle.
	rmSync(markerPath("trusted"), { force: true });
	rmSync(sessionMarkerPath("trusted"), { force: true });
	const reloadId = await startWorker(trustedCwd, "reload", "/worker-reload");
	const reloadRecord = await waitForIdle(reloadId);
	assert.deepEqual(reloadRecord.setupDiagnostics, [], JSON.stringify(reloadRecord.setupDiagnostics));
	assert.equal(readFileSync(markerPath("trusted"), "utf8"), "factory\nstart\nfactory\nstart\n");
	const reloadSessions = readFileSync(sessionMarkerPath("trusted"), "utf8").trim().split("\n");
	assert.equal(reloadSessions.length, 2);
	assert.equal(reloadSessions[0], reloadSessions[1]);

	// A fire-and-forget pi.sendUserMessage() turn remains owned until it settles.
	rmSync(markerPath("trusted"), { force: true });
	rmSync(sessionMarkerPath("trusted"), { force: true });
	await runWorker(trustedCwd, "command", "/worker-send");
	assert.equal(readFileSync(markerPath("trusted"), "utf8"), "factory\nstart\n");
	assert.equal(existsSync(promptPath("command")), true);

	const failedCommandRecord = await runWorker(trustedCwd, "failure", "/worker-fail", "failed", [
		'warning: command: Extension "command:worker-fail" error: command exploded',
	]);
	assert.equal(failedCommandRecord.error, "worker extension command failed: command exploded");

	// Session replacement rebinds resources and sends the command's work through
	// the new live AgentSession.
	rmSync(markerPath("trusted"), { force: true });
	rmSync(sessionMarkerPath("trusted"), { force: true });
	const replacementRecord = await runWorker(trustedCwd, "replacement", "/worker-new");
	assert.equal(readFileSync(markerPath("trusted"), "utf8"), "factory\nstart\nfactory\nstart\n");
	const replacementSessions = readFileSync(sessionMarkerPath("trusted"), "utf8").trim().split("\n");
	assert.equal(replacementSessions.length, 2);
	assert.notEqual(replacementSessions[0], replacementSessions[1]);
	assert.equal(replacementRecord.sessionId, replacementSessions[1]);

	// Cancellation during replacement binding owns the terminal state. The late
	// rebind callback must not attach or rewrite the replacement session.
	rmSync(slowReplacementBound, { force: true });
	const slowReplacementId = await startWorker(trustedCwd, "slow-replacement", "/worker-slow-new");
	const bindDeadline = Date.now() + 5_000;
	while (Date.now() < bindDeadline && !existsSync(slowReplacementBound)) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(existsSync(slowReplacementBound), true, "the replacement session must enter session_start");
	const cancelledReplacement = (await kill.execute(
		"worker-context-kill",
		{ id: slowReplacementId },
		undefined,
		undefined,
		{
			cwd: parentCwd,
			model: fauxModel("trusted"),
			modelRegistry: parentRegistry,
			sessionManager: { getSessionId: () => parentSessionId },
			ui: { setStatus: () => undefined },
		},
	)) as any;
	assert.equal(cancelledReplacement.details.state, "cancelled", JSON.stringify(cancelledReplacement));
	await new Promise((resolve) => setTimeout(resolve, 150));
	const slowReplacementRecord = sub.readWorker(slowReplacementId);
	assert.equal(slowReplacementRecord?.state, "cancelled", JSON.stringify(slowReplacementRecord));

	await runWorker(untrustedCwd, "untrusted");
	const untrustedPrompt = readFileSync(promptPath("untrusted"), "utf8");

	// An untrusted working directory withholds exactly what pi withholds from
	// any session there: project extensions and project skills. Context files
	// are not trust-gated, so they still load.
	assert.equal(
		existsSync(markerPath("untrusted")),
		false,
		"an untrusted working directory must not run its project extension",
	);
	assert.equal(
		untrustedPrompt.includes(skillSentinel("untrusted")),
		false,
		"an untrusted working directory must not offer its project skill",
	);
	assert.equal(
		untrustedPrompt.includes(contextSentinel("untrusted")),
		true,
		"context files are not trust-gated, so the worker still loads them",
	);

	const profileDir = join(parentCwd, "profiles");
	mkdirSync(profileDir);
	const selectedProfilePath = join(profileDir, "check.json");
	const selectedProfile = {
		name: "review-check",
		model: "cwd-provider-profile/cwd-model-profile",
		thinking: "off",
		cwd: trustedCwd,
		grounding: [{ name: "Check contract", path: "./contract.md" }],
		instructions: "PROFILE_OPERATING_MODE\nUse all ordinary session capabilities.",
	};
	writeFileSync(selectedProfilePath, JSON.stringify(selectedProfile));
	const promptDir = join(trustedCwd, ".pi", "prompts");
	mkdirSync(promptDir, { recursive: true });
	writeFileSync(join(promptDir, "profile-check.md"), "PROFILE_TEMPLATE_EXPANDED $1");
	const profileContext = {
		cwd: parentCwd,
		thinkingLevel: "off",
		model: fauxModel("trusted"),
		modelRegistry: parentRegistry,
		sessionManager: { getSessionId: () => parentSessionId },
		ui: { setStatus: () => undefined },
	};
	const waitForProfile = async (id: string) => {
		const deadline = Date.now() + 10_000;
		let record = sub.readWorker(id);
		while (Date.now() < deadline && record?.state === "running") {
			await new Promise((resolve) => setTimeout(resolve, 10));
			record = sub.readWorker(id);
		}
		assert.equal(record?.state, "done", JSON.stringify(record));
		return record!;
	};
	const profileResult = (await dispatch.execute(
		"profile",
		{
			task: "/profile-check input",
			tasks: [],
			profile: "profiles/check.json",
		},
		undefined,
		undefined,
		profileContext,
	)) as any;
	const profileId = profileResult.details.workers[0].id;
	const profileRecord = await waitForProfile(profileId);
	assert.equal(profileRecord.cwd, trustedCwd);
	assert.equal(profileRecord.model, selectedProfile.model);
	assert.equal(profileRecord.thinking, "off");
	assert.equal(profileRecord.label, "review-check");
	assert.match(readFileSync(join(agentDir, "profile-at-session-start.json"), "utf8"), /Check contract/);
	assert.deepEqual(profileRecord.resolvedTools.slice().sort(), ["read", "subagent", "submit_result"]);
	assert.deepEqual(profileResult.details.workers[0].profile, profileRecord.profile);
	assert.equal(profileResult.details.workers[0].label, "review-check");
	const received = JSON.parse(readFileSync(`${promptPath("profile")}.context.json`, "utf8"));
	assert.match(received.systemPrompt, /SENTINEL_CONTEXT_FILE_trusted/);
	assert.match(received.systemPrompt, /sentinel-skill-trusted/);
	assert.ok(!received.systemPrompt.includes("Check contract"), "profile pointers never replace system instructions");
	const messages = JSON.stringify(received.messages);
	assert.match(messages, /PROFILE_TEMPLATE_EXPANDED input/);
	assert.ok(messages.includes(join(profileDir, "contract.md")));
	assert.ok(messages.indexOf("Check contract") < messages.indexOf("PROFILE_TEMPLATE_EXPANDED"));
	assert.equal(messages.split("PROFILE_OPERATING_MODE").length - 1, 1);
	assert.ok(messages.indexOf("PROFILE_OPERATING_MODE") < messages.indexOf("PROFILE_TEMPLATE_EXPANDED"));
	assert.ok(!received.systemPrompt.includes("PROFILE_OPERATING_MODE"));

	// A task-selected file replaces unused top-level profile input. Explicit
	// fields still win, and an explicit empty tool list retains its meaning.
	const overrideResult = (await dispatch.execute(
		"profile-override",
		{
			profile: "does-not-exist.json",
			model: "cwd-provider-profile-override/cwd-model-profile-override",
			cwd: untrustedCwd,
			tasks: [{ task: "override task", profile: "profiles/check.json", tools: [] }],
		},
		undefined,
		undefined,
		profileContext,
	)) as any;
	const overrideRecord = await waitForProfile(overrideResult.details.workers[0].id);
	assert.equal(overrideRecord.model, "cwd-provider-profile-override/cwd-model-profile-override");
	assert.equal(overrideRecord.cwd, untrustedCwd);
	assert.deepEqual(overrideRecord.resolvedTools, ["submit_result"]);
	assert.equal(overrideRecord.profile?.model, selectedProfile.model);
	assert.equal(overrideRecord.label, "review-check");

	// Profile preflight completes before any batch worker exists.
	const beforeInvalid = sub.sharedWorkerState.workerSessionIds.size;
	await assert.rejects(
		() =>
			dispatch.execute(
				"profile-invalid",
				{
					tasks: [
						{ task: "valid", profile: "profiles/check.json" },
						{ task: "invalid", profile: "missing.json" },
					],
				},
				undefined,
				undefined,
				profileContext,
			),
		/Profile .*ENOENT/,
	);
	assert.equal(sub.sharedWorkerState.workerSessionIds.size, beforeInvalid);

	// Continuation retains effective settings and transcript input after the
	// selected file disappears. It neither reloads nor reapplies profile defaults.
	rmSync(selectedProfilePath);
	const continuation = parentSession.extensionRunner.getToolDefinition("subagent_continue");
	const continued = (await continuation.execute(
		"profile-continue",
		{ id: profileId, message: "Continue the check" },
		undefined,
		undefined,
		profileContext,
	)) as any;
	const continuedRecord = await waitForProfile(continued.details.worker.id);
	assert.equal(continuedRecord.cwd, trustedCwd);
	assert.equal(continuedRecord.model, selectedProfile.model);
	assert.deepEqual(continuedRecord.profile, profileRecord.profile);
	assert.equal(continuedRecord.label, "review-check");
	assert.deepEqual(continuedRecord.resolvedTools, profileRecord.resolvedTools);
	const continuedContext = readFileSync(`${promptPath("profile")}.context.json`, "utf8");
	assert.ok(continuedContext.includes("Check contract"));
	assert.ok(continuedContext.includes("Continue the check"));
	assert.equal(continuedContext.split("PROFILE_OPERATING_MODE").length - 1, 1, "normal continuation does not duplicate exact profile context");

	const compacted = (await continuation.execute(
		"profile-compact", { id: continuedRecord.id, message: "/worker-profile-compact" }, undefined, undefined, profileContext,
	)) as any;
	const compactedRecord = await waitForProfile(compacted.details.worker.id);
	assert.deepEqual(compactedRecord.profile, profileRecord.profile);
	const compactedContext = JSON.parse(readFileSync(`${promptPath("profile")}.context.json`, "utf8"));
	const compactedMessages = JSON.stringify(compactedContext.messages);
	assert.match(compactedMessages, /PROFILE_SYNTHETIC_SUMMARY/);
	assert.match(compactedMessages, /PROFILE_POST_COMPACTION_TASK/);
	assert.equal(compactedMessages.split("PROFILE_OPERATING_MODE").length - 1, 1, "effective context restores the compacted-out profile exactly once");

	const navigated = (await continuation.execute(
		"profile-navigate", { id: compactedRecord.id, message: "/worker-profile-navigate" }, undefined, undefined, profileContext,
	)) as any;
	await waitForProfile(navigated.details.worker.id);
	const navigatedContext = JSON.parse(readFileSync(`${promptPath("profile")}.context.json`, "utf8"));
	assert.match(JSON.stringify(navigatedContext.messages), /PROFILE_POST_NAVIGATION_TASK/);
	assert.equal(JSON.stringify(navigatedContext.messages).split("PROFILE_OPERATING_MODE").length - 1, 1);

	const instructionPath = join(profileDir, "instructions.json");
	writeFileSync(instructionPath, JSON.stringify({ cwd: trustedCwd, instructions: "PROFILE_INSTRUCTIONS_ONLY" }));
	const instructionOnly = (await dispatch.execute(
		"profile-instructions", { task: "/profile-check instruction-only", profile: instructionPath, model: "cwd-provider-profile-instructions/cwd-model-profile-instructions" }, undefined, undefined, profileContext,
	)) as any;
	const instructionRecord = await waitForProfile(instructionOnly.details.workers[0].id);
	assert.deepEqual(instructionRecord.profile?.grounding, []);
	const instructionContext = JSON.parse(readFileSync(`${promptPath("profile-instructions")}.context.json`, "utf8"));
	assert.ok(!instructionContext.systemPrompt.includes("PROFILE_INSTRUCTIONS_ONLY"));
	assert.match(JSON.stringify(instructionContext.messages), /PROFILE_INSTRUCTIONS_ONLY/);
	assert.match(readFileSync(join(agentDir, "profile-at-session-start.json"), "utf8"), /PROFILE_INSTRUCTIONS_ONLY/);

	const replacementProfile = (await dispatch.execute(
		"profile-replacement", { task: "/worker-new", profile: instructionPath, model: "cwd-provider-profile-replacement/cwd-model-profile-replacement" }, undefined, undefined, profileContext,
	)) as any;
	await waitForProfile(replacementProfile.details.workers[0].id);
	const replacementContext = JSON.parse(readFileSync(`${promptPath("profile-replacement")}.context.json`, "utf8"));
	assert.match(JSON.stringify(replacementContext.messages), /replacement worker task/);
	assert.equal(JSON.stringify(replacementContext.messages).split("PROFILE_INSTRUCTIONS_ONLY").length - 1, 1);
	assert.match(readFileSync(join(agentDir, "profile-at-session-start.json"), "utf8"), /PROFILE_INSTRUCTIONS_ONLY/);

	// A profile-less dispatch derives a task-based label with the per-owner-session
	// dispatch ordinal, seeded from the workers this session already persisted.
	const fallbackOrdinal = sub.listWorkers().filter((worker) => worker.ownerSession === parentSessionId).length + 1;
	const fallbackResult = (await dispatch.execute(
		"profile-fallback",
		{ task: "Fallback label check", model: "cwd-provider-fallback/cwd-model-fallback" },
		undefined,
		undefined,
		profileContext,
	)) as any;
	const fallbackRecord = await waitForProfile(fallbackResult.details.workers[0].id);
	assert.equal(fallbackRecord.label, deriveWorkerLabel("Fallback label check", fallbackOrdinal));
	assert.match(fallbackRecord.label ?? "", /^fallback-label-check#\d+$/);
	assert.equal(fallbackResult.details.workers[0].label, fallbackRecord.label);

	sub.shutdownWorkerSession(parentSession);
	parentSession = null;
	assert.deepEqual(runtimeErrors, []);
	console.log("worker context child: PASS");
} finally {
	try {
		parentSession?.dispose();
	} catch {}
	for (const dir of [agentDir, home, parentCwd, trustedCwd, untrustedCwd]) {
		rmSync(dir, { recursive: true, force: true });
	}
}
