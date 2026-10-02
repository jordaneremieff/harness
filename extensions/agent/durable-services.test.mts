import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { ProjectTrustStore, getPackageDir } from "@earendil-works/pi-coding-agent";
import { createDurableServices } from "./durable-services.ts";
import { promptProjectTrust } from "./trust-support.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const EMIT_EXTENSION = `import { fileURLToPath } from "node:url";

export default function (pi) {
	pi.events.emit("durable:contribution", {
		name: "fixture.emit",
		source: fileURLToPath(import.meta.url),
		commands: [{ name: "fixture-command", description: "Fixture command", run: async (call) => \`ran \${call.args}\` }],
		create(host) {
			return host.durable.defineExtension({ name: "fixture.emit" });
		},
	});
}
`;

const THROW_EXTENSION = `import { fileURLToPath } from "node:url";

export default function (pi) {
	pi.events.emit("durable:contribution", {
		name: "fixture.throw",
		source: fileURLToPath(import.meta.url),
		create() {
			throw new Error("create failed");
		},
	});
}
`;

const UNMATCHED_EXTENSION = `import { fileURLToPath } from "node:url";

export default function (pi) {
	pi.events.emit("durable:contribution", {
		name: "fixture.unmatched",
		source: fileURLToPath(new URL("./elsewhere.ts", import.meta.url)),
		commands: [{ name: "fixture-ghost", description: "Ghost command", run: async () => "ghost" }],
		create() {
			return {};
		},
	});
}
`;

const DUPLICATE_SOURCE_EXTENSION = `import { fileURLToPath } from "node:url";

export default function (pi) {
	const source = fileURLToPath(import.meta.url);
	pi.events.emit("durable:contribution", { name: "fixture.duplicate-a", source, create(host) { return host.durable.defineExtension({ name: "fixture.duplicate-a" }); } });
	pi.events.emit("durable:contribution", { name: "fixture.duplicate-b", source, create(host) { return host.durable.defineExtension({ name: "fixture.duplicate-b" }); } });
}
`;

const TRUST_YES_EXTENSION = `export default function (pi) {
	pi.on("project_trust", () => ({ trusted: "yes", remember: true }));
}
`;

const TRUST_UNDECIDED_EXTENSION = `export default function (pi) {
	pi.on("project_trust", () => ({ trusted: "undecided" }));
}
`;

const TRUST_THROW_EXTENSION = `export default function (pi) {
	pi.on("project_trust", () => { throw new Error("trust handler failed"); });
}
`;

/** A 1x1 transparent PNG. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

interface Fixture {
	root: string;
	cwd: string;
	agentDir: string;
	emitPath: string;
	silentPath: string;
}

/** Isolated agent home with one contributing and one ordinary-only extension. */
function fixture(t: { after(fn: () => void): void }, options: { projectSettings?: object } = {}): Fixture {
	const root = mkdtempSync(join(tmpdir(), "durable-services-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false } }));
	if (options.projectSettings) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(options.projectSettings));
	}
	const emitPath = join(root, "emit.ts");
	const silentPath = join(root, "silent.ts");
	writeFileSync(silentPath, "export default function () {}\n");
	writeFileSync(emitPath, EMIT_EXTENSION);
	return { root, cwd, agentDir, emitPath, silentPath };
}

function localDate(now = new Date()): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Open a MemoryStorage Harness for prepared services, install every contribution, and return both. */
async function installedHarness(services: Awaited<ReturnType<typeof createDurableServices>>): Promise<{ harness: Harness; close(): Promise<void> }> {
	const harness = await Harness.open(new MemoryStorage(), { models: services.services.modelRuntime, registry: services.registry, settings: services.settings, env: services.env }, BACKGROUND_CONTEXT);
	await services.install(harness);
	return { harness, close: async () => { await services.close(); await harness.close(BACKGROUND_CONTEXT); } };
}

it("collects contributions, matches sources, and installs the built-in registry", async (t) => {
	const f = fixture(t);
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-host",
		extensionPaths: [f.emitPath, f.silentPath],
		trusted: true,
		packageDir: getPackageDir(),
	});
	const installed = await installedHarness(services);
	try {
		assert.deepEqual(services.inventory.contributions, [{
			name: "fixture.emit",
			source: f.emitPath,
			commands: [{ name: "fixture-command", description: "Fixture command" }],
		}]);
		assert.deepEqual(services.inventory.ordinaryOnly, [f.silentPath]);
		const command = services.commands.get("fixture-command");
		assert.ok(command);
		assert.equal(await command.run({ args: "x", conversation: {} as never, harness: installed.harness, context: BACKGROUND_CONTEXT, host: services.contributionHost, invocationId: "fixture-invocation" }), "ran x");
		const snapshot = services.registry.snapshot();
		assert.deepEqual(snapshot.installed().map((extension) => extension.name), ["pi.host", "fixture.emit"]);
		const builtinTools = snapshot.tools().filter(({ extension }) => extension.name === "pi.host");
		assert.deepEqual(builtinTools.map(({ tool }) => tool.name), ["read", "write", "edit", "bash"]);
		assert.deepEqual(Object.fromEntries(builtinTools.map(({ tool }) => [tool.name, tool.replay])), {
			read: "safe",
			write: "unsafe",
			edit: "unsafe",
			bash: "unsafe",
		});
		assert.ok(services.settings.retry);
		assert.equal(services.settings.retry.enabled, false);
		const sections = new Map(snapshot.sections().map(({ section }) => [section.key, section]));
		const ordinaryOnly = await sections.get("ordinary_only")?.render({} as never, BACKGROUND_CONTEXT);
		assert.ok(ordinaryOnly?.includes(f.silentPath));
		const preamble = await sections.get("preamble")?.render({} as never, BACKGROUND_CONTEXT);
		assert.ok(preamble?.includes("expert coding assistant"));
		assert.ok(preamble?.includes(localDate()));
		assert.equal(sections.has("cwd"), true);
	} finally {
		await installed.close();
		await installed.close();
	}
	assert.throws(() => services.env({ conversationId: "fixture" } as never, BACKGROUND_CONTEXT), /closed/u);
});

it("installs native built-in extras from buildBuiltin before contributions", async (t) => {
	const f = fixture(t);
	let observedInventory: unknown;
	let observedHost: unknown;
	let extrasClosed = false;
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-builtin",
		extensionPaths: [f.emitPath, f.silentPath],
		trusted: true,
		buildBuiltin: (host) => {
			observedInventory = host.inventory;
			observedHost = host;
			return {
				extensions: [
					host.durable.defineExtension({ name: "fixture.builtin-a" }),
					host.durable.defineExtension({ name: "fixture.builtin-b" }),
				],
				close: () => { extrasClosed = true; },
			};
		},
	});
	const installed = await installedHarness(services);
	try {
		assert.equal(observedHost, services.contributionHost);
		assert.equal(typeof (observedHost as { onClose?: unknown }).onClose, "function");
		assert.deepEqual(observedInventory, services.inventory);
		assert.deepEqual(services.registry.snapshot().installed().map((extension) => extension.name), ["pi.host", "fixture.builtin-a", "fixture.builtin-b", "fixture.emit"]);
		assert.equal(extrasClosed, false);
	} finally {
		await installed.close();
	}
	assert.equal(extrasClosed, true, "buildBuiltin close runs with the bootstrap close");
	const plain = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-builtin-plain",
		trusted: true,
		buildBuiltin: (host) => host.durable.defineExtension({ name: "fixture.builtin-plain" }),
	});
	const plainInstalled = await installedHarness(plain);
	try {
		assert.deepEqual(plain.registry.snapshot().installed().map((extension) => extension.name), ["pi.host", "fixture.builtin-plain"]);
	} finally {
		await plainInstalled.close();
	}
});

it("releases the built-in bundle when a contribution create fails", async (t) => {
	const f = fixture(t);
	const throwPath = join(f.root, "throw.ts");
	writeFileSync(throwPath, THROW_EXTENSION);
	let builtinClosed = false;
	let registeredClosed = false;
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-throw",
		extensionPaths: [throwPath],
		trusted: true,
		buildBuiltin: (host) => {
			host.onClose(() => { registeredClosed = true; });
			return { extensions: [], close: () => { builtinClosed = true; } };
		},
	});
	const harness = await Harness.open(new MemoryStorage(), { models: services.services.modelRuntime, registry: services.registry, settings: services.settings, env: services.env }, BACKGROUND_CONTEXT);
	await assert.rejects(services.install(harness), /failed to create its extension: create failed/u);
	assert.equal(builtinClosed, true, "a failed install still closes the built-in bundle");
	assert.equal(registeredClosed, true, "a failed install also drains registered close work");
	await services.close();
	await harness.close(BACKGROUND_CONTEXT);
});

it("runs onClose callbacks in reverse order, continues past failures, and closes idempotently", async (t) => {
	const f = fixture(t);
	const order: string[] = [];
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-close",
		trusted: true,
		buildBuiltin: (host) => {
			host.onClose(() => { order.push("first"); });
			host.onClose(async () => { order.push("second"); throw new Error("second close failed"); });
			host.onClose(() => { order.push("third"); });
			return { extensions: [] };
		},
	});
	const harness = await Harness.open(new MemoryStorage(), { models: services.services.modelRuntime, registry: services.registry, settings: services.settings, env: services.env }, BACKGROUND_CONTEXT);
	await services.install(harness);
	await assert.rejects(services.close(), /second close failed/u);
	assert.deepEqual(order, ["third", "second", "first"]);
	await assert.rejects(services.close(), /second close failed/u);
	assert.deepEqual(order, ["third", "second", "first"], "close is idempotent");
	await harness.close(BACKGROUND_CONTEXT);
});

it("never installs a contribution whose source matches no loaded extension", async (t) => {
	const f = fixture(t);
	const unmatchedPath = join(f.root, "unmatched.ts");
	writeFileSync(unmatchedPath, UNMATCHED_EXTENSION);
	const errors: unknown[] = [];
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-unmatched",
		extensionPaths: [unmatchedPath],
		trusted: true,
		onReport: (error) => errors.push(error),
	});
	try {
		assert.deepEqual(services.inventory.contributions, []);
		assert.equal(services.commands.size, 0);
		assert.deepEqual(services.registry.snapshot().installed().map((extension) => extension.name), ["pi.host"]);
		assert.ok(errors.some((error) => String(error).includes("matches no loaded extension entrypoint")));
	} finally {
		await services.close();
	}
});

it("keeps one contribution per source and reports a duplicate emission", async (t) => {
	const f = fixture(t);
	const duplicatePath = join(f.root, "duplicate.ts");
	writeFileSync(duplicatePath, DUPLICATE_SOURCE_EXTENSION);
	const errors: unknown[] = [];
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-duplicate",
		extensionPaths: [duplicatePath],
		trusted: true,
		onReport: (error) => errors.push(error),
	});
	const installed = await installedHarness(services);
	try {
		assert.deepEqual(services.inventory.contributions.map((contribution) => contribution.name), ["fixture.duplicate-a"]);
		assert.deepEqual(services.registry.snapshot().installed().map((extension) => extension.name), ["pi.host", "fixture.duplicate-a"]);
		assert.ok(errors.some((error) => String(error).includes("emitted more than one durable contribution")));
	} finally {
		await installed.close();
	}
});

it("runs the built-in read tool through a real Harness and returns images", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const imagePath = join(f.cwd, "pixel.png");
	writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-run",
		extensionPaths: [f.silentPath],
		trusted: true,
	});
	const runtime = await createTestRuntime();
	const requests: TranscriptContext[] = [];
	const stream = (_model: unknown, context: TranscriptContext) => {
		requests.push(structuredClone(context));
		const answered = context.messages.some((message) => message.role === "toolResult");
		const message: AssistantMessage = answered
			? { role: "assistant", content: [{ type: "text", text: "done" }], api: testModel.api, provider: testModel.provider, model: testModel.id, usage: USAGE, stopReason: "stop", timestamp: Date.now() }
			: { role: "assistant", content: [{ type: "toolCall", id: "read-image", name: "read", arguments: { path: imagePath } }], api: testModel.api, provider: testModel.provider, model: testModel.id, usage: USAGE, stopReason: "toolUse", timestamp: Date.now() };
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: message });
		events.push({ type: "done", reason: answered ? "stop" : "toolUse", message });
		events.end(message);
		return events;
	};
	runtime.registerNativeProvider({
		id: testModel.provider,
		name: "Durable services test",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	const harness = await Harness.open(new MemoryStorage(), { models: runtime, registry: services.registry, settings: services.settings, env: services.env }, BACKGROUND_CONTEXT);
	try {
		await services.install(harness);
		harness.resume();
		const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
		const settled = await (await conversation.submit({ type: "input", content: "read the image" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done");
		const view = await conversation.context(BACKGROUND_CONTEXT);
		const result = view.messages.findLast((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		const image = result.content.find((part) => part.type === "image");
		assert.ok(image?.type === "image");
		assert.equal(image.mimeType, "image/png");
		const system = requests[0]?.messages.find((message) => message.role === "system");
		assert.ok(system?.role === "system");
		const prompt = [
			typeof system.content === "string" ? system.content : system.content.map((part) => part.text).join("\n"),
			...Object.values(system.sections ?? {}).filter((text): text is string => text !== null),
		].join("\n");
		assert.ok(prompt.includes(f.silentPath), "the ordinary-only path reaches the model prompt");
		assert.ok(prompt.includes(localDate()), "the preamble date reaches the model prompt");
	} finally {
		await services.close();
		await harness.close(BACKGROUND_CONTEXT);
	}
});

it("resolves project trust from saved decisions and the default setting", async (t) => {
	const f = fixture(t, { projectSettings: { steeringMode: "all" } });
	const base = { cwd: f.cwd, agentDir: f.agentDir, storageId: "fixture-trust", extensionPaths: [f.silentPath] };
	const untrusted = await createDurableServices(base);
	assert.equal(untrusted.settings.steeringMode, "one-at-a-time");
	await untrusted.close();
	const store = new ProjectTrustStore(f.agentDir);
	store.set(f.cwd, true);
	const saved = await createDurableServices({ ...base, trustStore: store });
	assert.equal(saved.settings.steeringMode, "all");
	await saved.close();
	store.set(f.cwd, false);
	const explicit = await createDurableServices({ ...base, trustStore: store, trusted: true });
	assert.equal(explicit.settings.steeringMode, "all");
	await explicit.close();
	store.set(f.cwd, null);
	writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	const fallback = await createDurableServices(base);
	assert.equal(fallback.settings.steeringMode, "all");
	await fallback.close();
});

it("persists a project_trust handler decision through the public store", async (t) => {
	const f = fixture(t, { projectSettings: { steeringMode: "all" } });
	const trustPath = join(f.root, "trust-yes.ts");
	writeFileSync(trustPath, TRUST_YES_EXTENSION);
	const services = await createDurableServices({ cwd: f.cwd, agentDir: f.agentDir, storageId: "fixture-trust-handler", extensionPaths: [trustPath] });
	try {
		assert.equal(services.settings.steeringMode, "all");
		assert.equal(new ProjectTrustStore(f.agentDir).get(f.cwd), true);
	} finally {
		await services.close();
	}
});

it("falls through an undecided handler to the default setting", async (t) => {
	const f = fixture(t, { projectSettings: { steeringMode: "all" } });
	writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	const trustPath = join(f.root, "trust-undecided.ts");
	writeFileSync(trustPath, TRUST_UNDECIDED_EXTENSION);
	const services = await createDurableServices({ cwd: f.cwd, agentDir: f.agentDir, storageId: "fixture-trust-undecided", extensionPaths: [trustPath] });
	try {
		assert.equal(services.settings.steeringMode, "all");
		assert.equal(new ProjectTrustStore(f.agentDir).get(f.cwd), null);
	} finally {
		await services.close();
	}
});

it("reports a failing trust handler and continues resolution", async (t) => {
	const f = fixture(t, { projectSettings: { steeringMode: "all" } });
	writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	const trustPath = join(f.root, "trust-throw.ts");
	writeFileSync(trustPath, TRUST_THROW_EXTENSION);
	const errors: unknown[] = [];
	const services = await createDurableServices({ cwd: f.cwd, agentDir: f.agentDir, storageId: "fixture-trust-throw", extensionPaths: [trustPath], onReport: (error) => errors.push(error) });
	try {
		assert.equal(services.settings.steeringMode, "all");
		assert.ok(errors.some((error) => String(error).includes("trust handler failed")));
	} finally {
		await services.close();
	}
});

it("routes an unresolved trust ask to the primary and persists the answer", async (t) => {
	const f = fixture(t, { projectSettings: { steeringMode: "all" } });
	const asked: string[] = [];
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-trust-ask",
		askPrimary: async (cwd) => { asked.push(cwd); return { trusted: true, remember: true }; },
	});
	try {
		assert.deepEqual(asked, [f.cwd]);
		assert.equal(services.settings.steeringMode, "all");
		assert.equal(new ProjectTrustStore(f.agentDir).get(f.cwd), true);
	} finally {
		await services.close();
	}
});

it("refuses an ask the primary does not answer without saving it", async (t) => {
	const f = fixture(t, { projectSettings: { steeringMode: "all" } });
	const asked: string[] = [];
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-trust-refuse",
		askPrimary: async (cwd) => { asked.push(cwd); return undefined; },
	});
	try {
		assert.deepEqual(asked, [f.cwd]);
		assert.equal(services.settings.steeringMode, "one-at-a-time");
		assert.equal(new ProjectTrustStore(f.agentDir).get(f.cwd), null);
	} finally {
		await services.close();
	}
});

it("never asks when a saved decision or an explicit decision resolves trust", async (t) => {
	const f = fixture(t, { projectSettings: { steeringMode: "all" } });
	const asked: string[] = [];
	new ProjectTrustStore(f.agentDir).set(f.cwd, true);
	const saved = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-trust-saved",
		askPrimary: async () => { asked.push("saved"); return { trusted: false }; },
	});
	await saved.close();
	assert.equal(saved.settings.steeringMode, "all");
	const trustPath = join(f.root, "trust-throw.ts");
	writeFileSync(trustPath, TRUST_THROW_EXTENSION);
	const errors: unknown[] = [];
	const explicit = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-trust-explicit",
		extensionPaths: [trustPath],
		trusted: true,
		askPrimary: async () => { asked.push("explicit"); return { trusted: false }; },
		onReport: (error) => errors.push(error),
	});
	await explicit.close();
	assert.equal(explicit.settings.steeringMode, "all");
	assert.deepEqual(asked, []);
	assert.deepEqual(errors, []);
});

it("maps primary UI selections to trust decisions", async () => {
	const labels = ["Trust this folder", "Trust this folder for this session", "Do not trust", "Do not trust for this session"];
	const decisions = [];
	for (const label of labels) {
		decisions.push(await promptProjectTrust("/work/topic", { select: async (prompt, options) => { assert.match(prompt, /\/work\/topic/u); return options.includes(label) ? label : undefined; } }));
	}
	assert.deepEqual(decisions, [
		{ trusted: true, remember: true },
		{ trusted: true, remember: false },
		{ trusted: false, remember: true },
		{ trusted: false, remember: false },
	]);
	assert.equal(await promptProjectTrust("/work/topic", { select: async () => undefined }), undefined);
});

it("persists an explicit trust decision and reuses it without asking", async (t) => {
	const f = fixture(t, { projectSettings: { steeringMode: "all" } });
	const explicit = await createDurableServices({ cwd: f.cwd, agentDir: f.agentDir, storageId: "fixture-trust-explicit-true", trusted: true });
	await explicit.close();
	assert.equal(explicit.settings.steeringMode, "all");
	assert.equal(new ProjectTrustStore(f.agentDir).get(f.cwd), true);
	const asked: string[] = [];
	const reused = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-trust-reuse-true",
		askPrimary: async (cwd) => { asked.push(cwd); return { trusted: false }; },
	});
	await reused.close();
	assert.equal(reused.settings.steeringMode, "all");
	assert.deepEqual(asked, []);
});

it("persists an explicit refusal and reuses it without asking", async (t) => {
	const f = fixture(t, { projectSettings: { steeringMode: "all" } });
	const explicit = await createDurableServices({ cwd: f.cwd, agentDir: f.agentDir, storageId: "fixture-trust-explicit-false", trusted: false });
	await explicit.close();
	assert.equal(explicit.settings.steeringMode, "one-at-a-time");
	assert.equal(new ProjectTrustStore(f.agentDir).get(f.cwd), false);
	const asked: string[] = [];
	const reused = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-trust-reuse-false",
		askPrimary: async (cwd) => { asked.push(cwd); return { trusted: true }; },
	});
	await reused.close();
	assert.equal(reused.settings.steeringMode, "one-at-a-time");
	assert.deepEqual(asked, []);
});

it("does not persist a session-only trust prompt answer", async (t) => {
	const f = fixture(t, { projectSettings: { steeringMode: "all" } });
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-trust-session-only",
		askPrimary: async () => ({ trusted: true, remember: false }),
	});
	try {
		assert.equal(services.settings.steeringMode, "all");
		assert.equal(new ProjectTrustStore(f.agentDir).get(f.cwd), null);
	} finally {
		await services.close();
	}
});

it("reports an extension whose contribution breaks the contract", async (t) => {
	const f = fixture(t);
	const badPath = join(f.root, "bad.ts");
	writeFileSync(badPath, `export default function (pi) {
	pi.events.emit("durable:contribution", { name: "bad", source: "relative/path", create() { return {}; } });
}
`);
	const errors: unknown[] = [];
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-bad-contribution",
		extensionPaths: [badPath],
		trusted: true,
		onReport: (error) => errors.push(error),
	});
	try {
		assert.equal(services.inventory.contributions.length, 0);
		assert.ok(errors.some((error) => String(error).includes("absolute source path")));
	} finally {
		await services.close();
	}
});

it("rejects a packageDir that is not the coding agent package", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "not-pi" }));
	await assert.rejects(createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: "fixture-bad-package",
		packageDir: f.root,
		trusted: true,
	}), /is not @earendil-works\/pi-coding-agent/u);
});
