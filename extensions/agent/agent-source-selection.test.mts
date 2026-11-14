import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { getPackageDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type TranscriptContext } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Registry, type SubmissionId } from "@earendil-works/pi-durable";
import { str, obj } from "@earendil-works/pi-schema";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { DurableHost } from "./durable-host.ts";
import { completed, toolCallMessage } from "./durable-host-fixture.mts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { createDurableServices } from "./durable-services.ts";
import type { RunScope, RunStop } from "./run-control.ts";
import { AGENT_ENTRY_CHANNEL, type AgentEntryRequest } from "./entry-binding.ts";
import registerAgentExtension from "./index.ts";
import { machineConfig } from "./settings-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const selectedAgent = realpathSync(fileURLToPath(new URL("./index.ts", import.meta.url)));

function emitter(name: string, marker?: string): string {
	return `import {fileURLToPath} from "node:url";
import {writeFileSync} from "node:fs";
export default function (pi) { ${marker === undefined ? "" : `writeFileSync(${JSON.stringify(marker)}, "factory executed");`} pi.events.emit("durable:contribution", {
 name: ${JSON.stringify(name)}, source: fileURLToPath(import.meta.url),
 create(host) { return host.durable.defineExtension({name: ${JSON.stringify(name)}}); }
}); }`;
}

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "agent-source-selection-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "work"), agentDir = join(root, "home");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir);
	const originalFixture = join(root, "original", "extensions", "agent", "index.ts");
	mkdirSync(dirname(originalFixture), { recursive: true });
	const originalMarker = join(root, "original-factory"), projectMarker = join(root, "project-factory");
	writeFileSync(originalFixture, emitter("agent", originalMarker));
	const originalAgent = process.env.AGENT_SOURCE_SELECTION_ORIGINAL ?? originalFixture;
	const other = join(root, "other.ts"), project = join(root, "project.ts");
	writeFileSync(other, emitter("selection.other"));
	writeFileSync(project, emitter("selection.project", projectMarker));
	const ordinary = join(root, "ordinary.ts"), prompt = join(root, "selection-prompt.md");
	writeFileSync(ordinary, "export default function () {}\n");
	writeFileSync(prompt, "---\ndescription: Configured prompt fixture.\n---\nUse this configured prompt.\n");
	const skill = join(root, "selection-skill"), projectSkill = join(root, "project-skill");
	for (const [path, name] of [[skill, "selection-skill"], [projectSkill, "project-skill"]]) {
		mkdirSync(path);
		writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Test source selection.\n---\nUse the fixture.\n`);
	}
	const globalSettings = join(agentDir, "settings.json"), projectSettings = join(cwd, ".pi", "settings.json");
	writeFileSync(globalSettings, JSON.stringify({
		packages: [relative(agentDir, originalAgent), { source: relative(agentDir, other) }], extensions: [ordinary], skills: [skill], prompts: [prompt],
		transport: "sse", defaultThinkingLevel: "high", cacheWarming: "off", retry: { enabled: false },
	}));
	writeFileSync(projectSettings, JSON.stringify({ extensions: [project], skills: [projectSkill], compaction: { reserveTokens: 1234 } }));
	const originalGlobal = readFileSync(globalSettings, "utf8"), originalProject = readFileSync(projectSettings, "utf8");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; });
	return { root, cwd, agentDir, originalAgent, originalFixture, originalMarker, projectMarker, other, project, ordinary, unchanged() {
		assert.equal(readFileSync(globalSettings, "utf8"), originalGlobal);
		assert.equal(readFileSync(projectSettings, "utf8"), originalProject);
	} };
}

for (const trusted of [false, true]) test(`selects the runner Agent before factories and preserves resource scopes with trust=${trusted}`, { timeout: 20000 }, async t => {
	const f = fixture(t);
	const originalSettings = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: false });
	const services = await createDurableServices({
		cwd: f.cwd, agentDir: f.agentDir, storageId: "source-selection", packageDir: getPackageDir(),
		settingsManager: originalSettings, modelRuntime: await createTestRuntime(),
		resolveProjectTrust: async () => { assert.equal(existsSync(f.projectMarker), false); return trusted; },
		agentExtensionPath: selectedAgent,
	});
	try {
		assert.equal(services.inventory.contributions.find(item => item.name === "agent")?.source, selectedAgent);
		assert.ok(services.inventory.contributions.some(item => item.name === "selection.other"));
		assert.equal(services.inventory.contributions.some(item => item.name === "selection.project"), trusted);
		assert.ok(!services.services.resourceLoader.getExtensions().extensions.some(item => item.resolvedPath === f.originalAgent));
		assert.equal(existsSync(f.originalMarker), false);
		assert.equal(existsSync(f.projectMarker), trusted);
		assert.ok(services.inventory.ordinaryOnly.includes(f.ordinary));
		assert.ok(services.services.resourceLoader.getPrompts().prompts.some(item => item.name === "selection-prompt"));
		const skills = services.services.resourceLoader.getSkills().skills.map(item => item.name);
		assert.ok(skills.includes("selection-skill"));
		assert.equal(skills.includes("project-skill"), trusted);
		assert.equal(services.services.settingsManager.getTransport(), "sse");
		assert.equal(services.services.settingsManager.getCompactionSettings().reserveTokens === 1234, trusted);
		assert.equal(originalSettings.getGlobalSettings().packages?.[0], relative(f.agentDir, f.originalAgent));
		services.services.settingsManager.setDefaultThinkingLevel("low");
		services.services.settingsManager.setPackages(originalSettings.getGlobalSettings().packages ?? []);
		await services.services.settingsManager.flush();
		await services.services.settingsManager.reload();
		assert.equal(services.services.settingsManager.getDefaultThinkingLevel(), "low");
		assert.equal(services.services.settingsManager.getPackages()[0], selectedAgent);
		f.unchanged();
	} finally { await services.close(); }
});

test("rejects another Agent from a configured package directory before native installation", async t => {
	const f = fixture(t);
	const packageRoot = dirname(f.originalFixture);
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "selection-original-agent", version: "1.0.0", pi: { extensions: ["index.ts"] } }));
	const path = join(f.agentDir, "settings.json");
	const settings = JSON.stringify({ packages: [relative(f.agentDir, packageRoot)], cacheWarming: "off", retry: { enabled: false } });
	writeFileSync(path, settings);
	let services: Awaited<ReturnType<typeof createDurableServices>> | undefined;
	try {
		await assert.rejects(async () => {
			services = await createDurableServices({
				cwd: f.cwd, agentDir: f.agentDir, storageId: "duplicate-agent-selection", packageDir: getPackageDir(),
				modelRuntime: await createTestRuntime(), trusted: false, agentExtensionPath: selectedAgent,
			});
		}, /unselected Agent contribution/u);
		assert.equal(existsSync(f.originalMarker), true);
		assert.equal(readFileSync(path, "utf8"), settings);
	} finally { await services?.close(); }
});

/** One directory of a fixture package: its manifest, an Agent emitter and one more native extension. */
function packageCopy(root: string, directory: string, name: string, extension: string) {
	const packageRoot = join(root, directory);
	const agent = join(packageRoot, "extensions", "agent", "index.ts"), extra = join(packageRoot, "extensions", "extra", "index.ts");
	const agentMarker = join(root, `${directory}-agent-factory`), extraMarker = join(root, `${directory}-extra-factory`);
	mkdirSync(dirname(agent), { recursive: true });
	mkdirSync(dirname(extra), { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name, version: "1.0.0", pi: { extensions: ["./extensions"] } }));
	writeFileSync(agent, emitter("agent", agentMarker));
	writeFileSync(extra, emitter(extension, extraMarker));
	return { packageRoot, agent, agentMarker, extraMarker };
}

test("loads the runner's package copy when settings name another directory of the same package", { timeout: 20000 }, async t => {
	const f = fixture(t);
	const root = realpathSync(f.root);
	const runner = packageCopy(root, "release-runner", "selection-package", "selection.runner-extra");
	const configured = packageCopy(root, "release-configured", "selection-package", "selection.configured-extra");
	const path = join(f.agentDir, "settings.json");
	const settings = JSON.stringify({ packages: [{ source: relative(f.agentDir, configured.packageRoot), skills: [] }], cacheWarming: "off", retry: { enabled: false } });
	writeFileSync(path, settings);
	const reports: unknown[] = [];
	const services = await createDurableServices({
		cwd: f.cwd, agentDir: f.agentDir, storageId: "package-copy-selection", packageDir: getPackageDir(),
		modelRuntime: await createTestRuntime(), trusted: false, agentExtensionPath: runner.agent,
		onReport: error => { reports.push(error); },
	});
	try {
		const contributions = services.inventory.contributions;
		assert.deepEqual(contributions.filter(item => item.name === "agent").map(item => item.source), [runner.agent]);
		assert.ok(contributions.some(item => item.name === "selection.runner-extra"));
		assert.ok(!contributions.some(item => item.name === "selection.configured-extra"));
		assert.ok(!services.services.resourceLoader.getExtensions().extensions.some(item => item.resolvedPath.startsWith(configured.packageRoot)));
		assert.equal(existsSync(configured.agentMarker), false);
		assert.equal(existsSync(configured.extraMarker), false);
		assert.equal(existsSync(runner.agentMarker), true);
		assert.deepEqual(services.services.settingsManager.getPackages(), [{ source: runner.packageRoot, skills: [] }], "the entry keeps its other fields");
		const lines = reports.filter((item): item is string => typeof item === "string");
		assert.equal(lines.length, 1, "one report for one replaced directory");
		assert.ok(lines[0]?.includes(configured.packageRoot) && lines[0].includes(runner.packageRoot));
		assert.deepEqual(reports.filter(item => typeof item !== "string"), []);
		const section = services.registry.snapshot().sections().find(({ section }) => section.key === "package_source")?.section;
		assert.equal(await section?.render({} as never, BACKGROUND_CONTEXT), [
			"Pi settings configure a package directory that this conversation's host did not load. The host loaded the copy of that package that its starting process runs:",
			`- configured ${configured.packageRoot}; loaded ${runner.packageRoot}`,
		].join("\n"));
		assert.equal(readFileSync(path, "utf8"), settings);
	} finally { await services.close(); }
});

test("keeps a configured package under another name, and rejects its Agent", { timeout: 20000 }, async t => {
	const f = fixture(t);
	const root = realpathSync(f.root);
	const runner = packageCopy(root, "release-runner", "selection-package", "selection.runner-extra");
	const configured = packageCopy(root, "release-configured", "selection-other-package", "selection.configured-extra");
	const path = join(f.agentDir, "settings.json");
	const settings = JSON.stringify({ packages: [relative(f.agentDir, configured.packageRoot)], cacheWarming: "off", retry: { enabled: false } });
	writeFileSync(path, settings);
	const reports: unknown[] = [];
	let services: Awaited<ReturnType<typeof createDurableServices>> | undefined;
	try {
		await assert.rejects(async () => {
			services = await createDurableServices({
				cwd: f.cwd, agentDir: f.agentDir, storageId: "package-name-selection", packageDir: getPackageDir(),
				modelRuntime: await createTestRuntime(), trusted: false, agentExtensionPath: runner.agent,
				onReport: error => { reports.push(error); },
			});
		}, /unselected Agent contribution/u);
		assert.equal(existsSync(configured.agentMarker), true);
		assert.deepEqual(reports.filter(item => typeof item === "string"), []);
		assert.equal(readFileSync(path, "utf8"), settings);
	} finally { await services?.close(); }
});

test("refuses a selected entrypoint without its native Agent contribution", async t => {
	const f = fixture(t);
	await assert.rejects(createDurableServices({
		cwd: f.cwd, agentDir: f.agentDir, storageId: "invalid-selection", packageDir: getPackageDir(),
		modelRuntime: await createTestRuntime(), trusted: false, agentExtensionPath: f.other,
	}), /selected Agent entrypoint did not supply/u);
	f.unchanged();
});

for (const scope of ["global", "project"] as const) for (const trusted of [false, true]) test(`preserves malformed ${scope} settings evidence with trust=${trusted}`, { timeout: 20000 }, async t => {
	const f = fixture(t);
	const path = scope === "global" ? join(f.agentDir, "settings.json") : join(f.cwd, ".pi", "settings.json");
	const invalid = "{ invalid settings";
	writeFileSync(path, invalid);
	const reports: unknown[] = [];
	const services = await createDurableServices({
		cwd: f.cwd, agentDir: f.agentDir, storageId: "malformed-selection", packageDir: getPackageDir(),
		modelRuntime: await createTestRuntime(), trusted, agentExtensionPath: selectedAgent,
		onReport: error => { reports.push(error); },
	});
	try {
		const expected = scope === "global" || trusted;
		const errors = services.services.settingsManager.drainErrors().filter(item => item.scope === scope);
		assert.equal(errors.length > 0, expected);
		assert.equal(reports.some(error => error instanceof Error && error.message.includes(path)), expected);
		if (expected) assert.ok(errors.some(item => item.error.message.includes(path)));
		assert.equal(readFileSync(path, "utf8"), invalid);
		assert.equal(services.inventory.contributions.find(item => item.name === "agent")?.source, selectedAgent);
	} finally { await services.close(); }
});

test("native bootstrap defers malformed project settings without an injected manager", { timeout: 20000 }, async t => {
	const f = fixture(t);
	const projectPath = join(f.cwd, ".pi", "settings.json"), globalPath = join(f.agentDir, "settings.json");
	const invalid = "{ invalid project settings", globalBefore = readFileSync(globalPath, "utf8");
	writeFileSync(projectPath, invalid);
	const open = DurableHost.open.bind(DurableHost);
	let observed = false;
	t.mock.method(DurableHost, "open", async (...args: Parameters<typeof open>) => {
		const services = args[0].contributionHost?.services;
		assert.ok(services);
		assert.equal(services.settingsManager.isProjectTrusted(), false);
		assert.deepEqual(services.settingsManager.drainErrors(), []);
		assert.ok(!args[0].contributionHost?.inventory.contributions.some(item => item.name === "selection.project"));
		observed = true;
		return open(...args);
	});
	const record = new AgentCatalog(f.root).create({ cwd: f.cwd, agentDir: f.agentDir, packageDir: getPackageDir(), model: { provider: testModel.provider, modelId: testModel.id }, thinkingLevel: "off", trust: false });
	const runtime = await createDurableRuntime(hostMetadata(record), { modelRuntime: await createTestRuntime() });
	try {
		assert.equal(observed, true);
		assert.equal(readFileSync(projectPath, "utf8"), invalid);
		assert.equal(readFileSync(globalPath, "utf8"), globalBefore);
		assert.equal(existsSync(f.projectMarker), false);
	} finally { await runtime.close(); }
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

test("selected native Agent retains delegation ownership across generation handover and Stop", { timeout: 20000 }, async t => {
	const f = fixture(t);
	writeFileSync(join(f.agentDir, "harness.json"), JSON.stringify(machineConfig({
		presets: { standard: { model: `${testModel.provider}/${testModel.id}`, thinkingLevel: "off" } },
		preferences: { defaultPreset: "standard" },
	})));
	const firstModel = deferred(), releaseModel = deferred(), releaseTools = deferred();
	const rootGate = deferred(), childGate = deferred();
	const aborted = new Set<string>();
	const context = withAbortSignal(t.signal, BACKGROUND_CONTEXT);
	const models = await createTestRuntime();
	let spawned = false;
	const stream = (_model: unknown, transcript: TranscriptContext) => {
		const user = transcript.messages.find(message => message.role === "user");
		const content = user?.content;
		const text = typeof content === "string" ? content : content?.filter(item => item.type === "text").map(item => item.text).join("");
		const root = text === "source-root";
		if (!root || spawned) return completed(toolCallMessage("selection_gate", { role: root ? "root" : "child" }));
		spawned = true;
		const message = toolCallMessage("agent_spawn", { name: "source child", prompt: "source-child", model: `${testModel.provider}/${testModel.id}`, thinkingLevel: "off" });
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: message });
		firstModel.resolve();
		void releaseModel.promise.then(() => { events.push({ type: "done", reason: "toolUse", message }); events.end(message); });
		return events;
	};
	models.registerNativeProvider({
		id: testModel.provider, name: "Source selection fixture", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream, streamSimple: stream,
	});
	const gate = defineTool({
		name: "selection_gate", description: "Hold one fixture generation.", parameters: obj({ role: str() }, { open: true }),
		execute: async (args, _api, callContext) => {
			(args.role === "root" ? rootGate : childGate).resolve();
			await new Promise<void>(done => {
				const stop = () => { aborted.add(args.role); done(); };
				if (callContext.abortSignal?.aborted) stop();
				else callContext.abortSignal?.addEventListener("abort", stop, { once: true });
				releaseTools.promise.then(done);
			});
			return {};
		},
	});
	const open = DurableHost.open.bind(DurableHost);
	let native: DurableHost | undefined;
	t.mock.method(DurableHost, "open", async (...args: Parameters<typeof open>) => {
		assert.equal(args[0].contributionHost?.inventory.contributions.find(item => item.name === "agent")?.source, selectedAgent);
		(args[0].registry as Registry).install(defineExtension({ name: "selection.gate", tools: [gate] }));
		native = await open(...args);
		return native;
	});
	const catalog = new AgentCatalog(f.root);
	const record = catalog.create({ cwd: f.cwd, agentDir: f.agentDir, packageDir: getPackageDir(), model: { provider: testModel.provider, modelId: testModel.id }, thinkingLevel: "off", trust: true });
	let runtime: Awaited<ReturnType<typeof createDurableRuntime>> | undefined;
	try {
		runtime = await createDurableRuntime(hostMetadata(record), { modelRuntime: models });
		assert.ok(native);
		const receipt = await runtime.request("submit", { message: "source-root", origin: "operator", requestId: "source-root" }, "source-root", t.signal) as { submissionId: number };
		await awaitWithContext(firstModel.promise, context);
		const before = await runtime.request("run-scope", {}, "scope-before", t.signal) as RunScope;
		assert.equal(before.runId, receipt.submissionId);
		releaseModel.resolve();
		await awaitWithContext(Promise.all([rootGate.promise, childGate.promise]), context);
		const after = await runtime.request("run-scope", {}, "scope-after", t.signal) as RunScope;
		assert.equal(after.runId, before.runId);
		assert.notEqual(after.taskId, before.taskId);
		assert.equal(after.coverage.complete, true);
		const child = after.delegations.find(item => item.result !== undefined);
		assert.ok(child?.result);
		assert.equal(child.ownership, "created");
		assert.ok(child.sessionId.startsWith(`${record.storageId}:`));
		const stopped = await runtime.request("run-stop", { runId: before.runId }, "stop-source", t.signal) as RunStop;
		assert.equal(stopped.state, "stopped");
		assert.ok(stopped.delegations.some(item => item.sessionId === child.sessionId && item.state === "stopped"));
		assert.equal((await native.wait(receipt.submissionId as SubmissionId, context)).status, "unanswered");
		assert.equal((await native.wait(child.result.submissionId as SubmissionId, context)).status, "unanswered");
		assert.deepEqual([...aborted].sort(), ["child", "root"]);
		f.unchanged();
		t.diagnostic(JSON.stringify({ original: f.originalAgent, selected: selectedAgent, packageDir: record.packageDir, runId: before.runId, firstTaskId: before.taskId, nextTaskId: after.taskId, child: child.result, stop: stopped.state }));
	} finally {
		releaseModel.resolve(); releaseTools.resolve();
		await runtime?.close();
	}
});

test("entry dispatcher selects native or ordinary registration, preserves original source, and removes its bootstrap listener", async t => {
	const f = fixture(t);
	const services = await createDurableServices({
		cwd: f.cwd, agentDir: f.agentDir, storageId: "entry-binding-selection", packageDir: getPackageDir(),
		modelRuntime: await createTestRuntime(), trusted: false, agentExtensionPath: selectedAgent,
	});
	try {
		const agentContributions = services.inventory.contributions.filter(item => item.name === "agent");
		assert.equal(agentContributions.length, 1);
		assert.equal(agentContributions[0]?.source, selectedAgent);
		const loadedAgent = services.services.resourceLoader.getExtensions().extensions.find(item => item.resolvedPath === selectedAgent);
		assert.ok(loadedAgent);
		assert.equal(loadedAgent.tools.size, 0, "native entry does not register ordinary tools");
		assert.equal(loadedAgent.commands.size, 0, "native entry does not register ordinary commands");
	} finally {
		await services.close();
	}

	await assert.rejects(
		registerAgentExtension({
			events: {
				emit(channel: string, data: unknown) {
					if (channel === AGENT_ENTRY_CHANNEL) {
						(data as AgentEntryRequest).result = { kind: "rejected", reason: "Rejected fixture Agent entrypoint" };
					}
				},
				on: () => () => {},
			},
		} as never),
		/Rejected fixture Agent entrypoint/u,
	);

	let ordinaryContribution: { name: string; source: string } | undefined;
	const ordinaryTools: string[] = [];
	await registerAgentExtension({
		events: {
			emit(channel: string, data: unknown) {
				if (channel === "durable:contribution") ordinaryContribution = data as { name: string; source: string };
			},
			on: () => () => {},
		},
		on: () => () => {},
		registerTool(tool: { name: string }) { ordinaryTools.push(tool.name); },
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		getThinkingLevel: () => "off",
		getSettings: () => ({}),
	} as never);
	assert.deepEqual(ordinaryContribution && { name: ordinaryContribution.name, source: ordinaryContribution.source }, {
		name: "agent",
		source: selectedAgent,
	});
	assert.ok(ordinaryTools.includes("agent_spawn"));
});


const probeKey = "__agentEntryProbe";
function entryProbe(source: string): string {
	return `export default function (pi) {
	const request = { version: 1, source: ${JSON.stringify(source)} };
	pi.events.emit("durable:agent-entry", request);
	(globalThis[${JSON.stringify(probeKey)}] ??= []).push(request.result?.kind ?? "none");
}\n`;
}

function probeResults(): string[] {
	const state = globalThis as Record<string, unknown>;
	state[probeKey] ??= [];
	return state[probeKey] as string[];
}

function assertNoOrdinaryRegistrations(services: Awaited<ReturnType<typeof createDurableServices>>): void {
	const loaded = services.services.resourceLoader.getExtensions().extensions;
	const agent = loaded.find(item => item.resolvedPath === selectedAgent);
	assert.ok(agent);
	assert.equal(agent.tools.size, 0, "reloaded native entry registers no ordinary tools");
	assert.equal(agent.commands.size, 0, "reloaded native entry registers no ordinary commands");
	assert.equal(agent.shortcuts.size, 0);
	assert.equal(agent.messageRenderers.size, 0);
}

test("scoped resource reload binds the canonical Agent source around the whole reload and removes it afterwards", { timeout: 30000 }, async t => {
	const f = fixture(t);
	const probe = join(f.root, "entry-probe.ts");
	writeFileSync(probe, entryProbe(selectedAgent));
	writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ extensions: [probe], cacheWarming: "off", retry: { enabled: false } }));
	probeResults().length = 0;
	t.after(() => { delete (globalThis as Record<string, unknown>)[probeKey]; });
	const services = await createDurableServices({
		cwd: f.cwd, agentDir: f.agentDir, storageId: "scoped-reload", packageDir: getPackageDir(),
		modelRuntime: await createTestRuntime(), trusted: false, agentExtensionPath: selectedAgent,
	});
	try {
		assert.deepEqual(probeResults(), ["native"]);
		assertNoOrdinaryRegistrations(services);

		await services.reloadResources();
		assert.deepEqual(probeResults(), ["native", "native"], "the reload answers the source request natively");
		assertNoOrdinaryRegistrations(services);
		assert.equal(services.services.resourceLoader.getExtensions().errors.length, 0);

		await services.services.resourceLoader.reload();
		assert.deepEqual(probeResults(), ["native", "native", "none"], "the binding is gone once the scoped reload settles");

		writeFileSync(probe, entryProbe(join(f.root, "foreign", "index.ts")));
		await assert.rejects(services.reloadResources(), /unselected Agent contribution/u);
		assert.equal(probeResults().at(-1), "rejected");
		const afterFailure = probeResults().length;

		writeFileSync(probe, entryProbe(selectedAgent));
		await services.services.resourceLoader.reload();
		assert.deepEqual(probeResults().slice(afterFailure), ["none"], "the binding is removed after a failed reload");

		await services.reloadResources();
		assert.equal(probeResults().at(-1), "native");
		assertNoOrdinaryRegistrations(services);
	} finally { await services.close(); }
});

test("native host reload keeps the Agent entry native and registers nothing ordinary", { timeout: 30000 }, async t => {
	const f = fixture(t);
	const probe = join(f.root, "entry-probe.ts");
	writeFileSync(probe, entryProbe(selectedAgent));
	writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ extensions: [probe], cacheWarming: "off", retry: { enabled: false } }));
	probeResults().length = 0;
	t.after(() => { delete (globalThis as Record<string, unknown>)[probeKey]; });
	const record = new AgentCatalog(f.root).create({ cwd: f.cwd, agentDir: f.agentDir, packageDir: getPackageDir(), model: { provider: testModel.provider, modelId: testModel.id }, thinkingLevel: "off", trust: false });
	const runtime = await createDurableRuntime(hostMetadata(record), { modelRuntime: await createTestRuntime() });
	try {
		const initial = probeResults().length;
		assert.ok(initial > 0);
		assert.ok(probeResults().every(kind => kind === "native"));
		const result = await runtime.request("command", { name: "reload" }, "native-reload") as { reloaded?: boolean };
		assert.equal(result.reloaded, true);
		assert.ok(probeResults().length > initial, "reload evaluated the factories again");
		assert.ok(probeResults().every(kind => kind === "native"), "every entry request during reload resolved natively");
	} finally { await runtime.close(); }
});
