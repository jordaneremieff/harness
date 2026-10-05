import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { resolveConfiguredAgent } from "./durable-services.ts";
import { testModel } from "./test-runtime.mts";

// The same public-contract checks also run against an explicitly selected installation.
const packageDir = process.env.PI_TEST_PACKAGE_DIR ?? getPackageDir();
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
const pi: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(resolve(packageDir, manifest.exports["."].import)).href);
const first = { ...testModel, id: "first" };
const second = { ...testModel, id: "second" };
const plain = { ...testModel, id: "plain", reasoning: false };
const fixed = { cacheWarming: { mode: "off" }, retry: { enabled: false } };

async function fixture(t: TestContext, global: object, project?: object) {
	const root = mkdtempSync(join(tmpdir(), "configured-defaults-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "work"); const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const globalPath = join(agentDir, "settings.json");
	writeFileSync(globalPath, JSON.stringify({ ...fixed, ...global }));
	const projectPath = join(cwd, ".pi", "settings.json");
	if (project !== undefined) { mkdirSync(join(cwd, ".pi")); writeFileSync(projectPath, JSON.stringify(project)); }
	const runtime = await pi.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const forbidden = () => { throw new Error("Selection must not generate"); };
	runtime.registerNativeProvider({
		id: testModel.provider, name: "Configured defaults fixture", getModels: () => [first, second, plain],
		auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: forbidden, streamSimple: forbidden,
	});
	const stream = t.mock.method(runtime, "stream", forbidden);
	const simple = t.mock.method(runtime, "streamSimple", forbidden);
	const prompt = t.mock.method(pi.AgentSession.prototype, "prompt", async () => { throw new Error("Selection must not prompt"); });
	const dispose = t.mock.method(pi.AgentSession.prototype, "dispose");
	const defaults = { cwd, agentDir, packageDir, modelRuntime: runtime };
	const snapshot = (path: string) => ({ bytes: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs, inode: statSync(path).ino });
	const unchanged = async (run: () => Promise<unknown>) => {
		const before = snapshot(globalPath); const beforeProject = project === undefined ? undefined : snapshot(projectPath);
		try { return await run(); }
		finally {
			assert.deepEqual(snapshot(globalPath), before, "global settings stay untouched");
			if (beforeProject !== undefined) assert.deepEqual(snapshot(projectPath), beforeProject, "project settings stay untouched");
			assert.equal(stream.mock.callCount(), 0); assert.equal(simple.mock.callCount(), 0); assert.equal(prompt.mock.callCount(), 0);
			assert.equal(new pi.ProjectTrustStore(agentDir).get(cwd), null, "session-only decisions do not enter the trust store");
		}
	};
	return { cwd, agentDir, globalPath, projectPath, runtime, defaults, dispose, unchanged };
}

it("prefers a saved second scoped model over the first scope entry", async (t) => {
	const f = await fixture(t, { enabledModels: ["agent-test/first", "agent-test/second"], defaultProvider: "agent-test", defaultModel: "second", defaultThinkingLevel: "high" });
	const selected = await f.unchanged(() => resolveConfiguredAgent(f.defaults));
	assert.deepEqual(selected, { model: { provider: "agent-test", modelId: "second" }, thinkingLevel: "high", projectTrusted: true });
	assert.equal(f.dispose.mock.callCount(), 1);
});

it("rejects an out-of-scope saved model and honors the first scope thinking suffix", async (t) => {
	const f = await fixture(t, { enabledModels: ["agent-test/first:low"], defaultProvider: "agent-test", defaultModel: "second", modelThinkingLevels: { "agent-test/first": "high" }, defaultThinkingLevel: "medium" });
	const selected = await f.unchanged(() => resolveConfiguredAgent(f.defaults)) as Awaited<ReturnType<typeof resolveConfiguredAgent>>;
	assert.equal(selected.model.modelId, "first"); assert.equal(selected.thinkingLevel, "low"); assert.equal(f.dispose.mock.callCount(), 1);
});

it("uses scope thinking on the saved model before its per-model and default settings", async (t) => {
	const f = await fixture(t, { enabledModels: ["agent-test/first:low", "agent-test/second:high"], defaultProvider: "agent-test", defaultModel: "second", modelThinkingLevels: { "agent-test/second": "off" }, defaultThinkingLevel: "low" });
	const selected = await f.unchanged(() => resolveConfiguredAgent(f.defaults)) as Awaited<ReturnType<typeof resolveConfiguredAgent>>;
	assert.equal(selected.model.modelId, "second"); assert.equal(selected.thinkingLevel, "high");
});

for (const [extra, expected] of [
	[{ modelThinkingLevels: { "agent-test/first": "low" }, defaultThinkingLevel: "high" }, "low"],
	[{ defaultThinkingLevel: "high" }, "high"], [{}, "medium"],
] as const) it(`delegates fresh thinking precedence to Pi: ${expected}`, async (t) => {
	const f = await fixture(t, { enabledModels: ["agent-test/first"], ...extra });
	const selected = await f.unchanged(() => resolveConfiguredAgent(f.defaults)) as Awaited<ReturnType<typeof resolveConfiguredAgent>>;
	assert.equal(selected.thinkingLevel, expected); assert.equal(f.dispose.mock.callCount(), 1);
});

it("lets Pi clamp thinking for a model without reasoning", async (t) => {
	const f = await fixture(t, { enabledModels: ["agent-test/plain:high"] });
	const selected = await f.unchanged(() => resolveConfiguredAgent(f.defaults)) as Awaited<ReturnType<typeof resolveConfiguredAgent>>;
	assert.equal(selected.model.modelId, "plain"); assert.equal(selected.thinkingLevel, "off");
});

for (const enabledModels of [[], ["not-a-configured-provider/missing"]]) it(`uses real SDK startup when the resolved scope is empty: ${JSON.stringify(enabledModels)}`, async (t) => {
	const f = await fixture(t, { enabledModels, defaultProvider: "agent-test", defaultModel: "second", modelThinkingLevels: { "agent-test/second": "high" } });
	const selected = await f.unchanged(() => resolveConfiguredAgent(f.defaults)) as Awaited<ReturnType<typeof resolveConfiguredAgent>>;
	assert.equal(selected.model.modelId, "second"); assert.equal(selected.thinkingLevel, "high"); assert.equal(f.dispose.mock.callCount(), 1);
});

it("filters unavailable models through Pi's public scope resolver", async (t) => {
	const f = await fixture(t, { enabledModels: ["unavailable-test/model", "agent-test/second"], defaultProvider: "unavailable-test", defaultModel: "model" });
	f.runtime.registerNativeProvider({ id: "unavailable-test", name: "Unavailable", getModels: () => [{ ...testModel, provider: "unavailable-test" }], auth: { apiKey: { name: "Absent", check: async () => undefined, resolve: async () => undefined } }, stream: () => { throw new Error("Unavailable provider must not stream"); }, streamSimple: () => { throw new Error("Unavailable provider must not stream"); } });
	const selected = await f.unchanged(() => resolveConfiguredAgent(f.defaults)) as Awaited<ReturnType<typeof resolveConfiguredAgent>>;
	assert.equal(selected.model.provider, "agent-test"); assert.equal(selected.model.modelId, "second");
});

for (const trusted of [false, true]) it(`applies project settings only after the normal trust decision: ${trusted}`, async (t) => {
	const f = await fixture(t, { enabledModels: ["agent-test/first"], defaultThinkingLevel: "low" }, { enabledModels: ["agent-test/second"], defaultThinkingLevel: "high" });
	let asks = 0;
	const selected = await f.unchanged(() => resolveConfiguredAgent({ ...f.defaults, askPrimary: async () => { asks++; return { trusted, remember: false }; } })) as Awaited<ReturnType<typeof resolveConfiguredAgent>>;
	assert.equal(asks, 1); assert.equal(selected.projectTrusted, trusted);
	assert.equal(selected.model.modelId, trusted ? "second" : "first"); assert.equal(selected.thinkingLevel, trusted ? "high" : "low");
});

it("reads changed global settings at the next admission, not the caller's cache", async (t) => {
	const f = await fixture(t, { enabledModels: ["agent-test/first", "agent-test/second"], defaultProvider: "agent-test", defaultModel: "first", defaultThinkingLevel: "low" });
	const callerSettings = pi.SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: false });
	const before = await f.unchanged(() => resolveConfiguredAgent(f.defaults)) as Awaited<ReturnType<typeof resolveConfiguredAgent>>;
	writeFileSync(f.globalPath, JSON.stringify({ ...fixed, enabledModels: ["agent-test/first", "agent-test/second"], defaultProvider: "agent-test", defaultModel: "second", defaultThinkingLevel: "high" }));
	assert.equal(callerSettings.getDefaultModel(), "first");
	const after = await f.unchanged(() => resolveConfiguredAgent(f.defaults)) as Awaited<ReturnType<typeof resolveConfiguredAgent>>;
	assert.equal(before.model.modelId, "first"); assert.equal(before.thinkingLevel, "low");
	assert.equal(after.model.modelId, "second"); assert.equal(after.thinkingLevel, "high"); assert.equal(f.dispose.mock.callCount(), 2);
});

it("disposes the SDK session and refuses its core fallback when no model is available", async (t) => {
	const f = await fixture(t, {});
	t.mock.method(f.runtime, "getAvailable", async () => [] as Model<"openai-completions">[]);
	t.mock.method(f.runtime, "getAvailableSnapshot", () => [] as Model<"openai-completions">[]);
	t.mock.method(f.runtime, "hasConfiguredAuth", () => false);
	await assert.rejects(f.unchanged(() => resolveConfiguredAgent(f.defaults)), /No configured model is available/u);
	assert.equal(f.dispose.mock.callCount(), 1);
});

it("offers one synchronous ordinary launch provider on real Pi discovery and reload without starting work", async (t) => {
	const f = await fixture(t, {});
	await f.unchanged(async () => {
		const eventBus = pi.createEventBus();
		const services = await pi.createAgentSessionServices({ cwd: f.cwd, agentDir: f.agentDir, modelRuntime: f.runtime,
			settingsManager: pi.SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: false }),
			resourceLoaderOptions: { eventBus, additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))] },
			resourceLoaderReloadOptions: { resolveProjectTrust: async () => false },
		});
		const discover = () => {
			const providers: unknown[] = [];
			eventBus.emit("durable:launch-provider", { provide: (launch: unknown) => providers.push(launch) });
			assert.equal(providers.length, 1); assert.equal(typeof providers[0], "function");
		};
		const { session } = await pi.createAgentSessionFromServices({ services, sessionManager: pi.SessionManager.inMemory(f.cwd), noTools: "all", model: first });
		try {
			discover();
			await session.reload();
			discover();
		} finally { session.dispose(); }
	});
});

it("returns explicit malformed-settings and missing-command setup errors without generation", async (t) => {
	const f = await fixture(t, { enabledModels: ["agent-test/first"] });
	await assert.rejects(f.unchanged(() => resolveConfiguredAgent({ ...f.defaults, command: "unregistered-command" })), /not registered/u);
	assert.equal(f.dispose.mock.callCount(), 0, "no session exists before command registration passes");
	writeFileSync(f.globalPath, "{not valid JSON");
	await assert.rejects(f.unchanged(() => resolveConfiguredAgent(f.defaults)), /Could not read global settings/u);
	assert.equal(existsSync(join(f.agentDir, "sessions")), false, "selection owns no disk session");
});
