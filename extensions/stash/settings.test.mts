import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createEventBus, type AgentSessionServices } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { readSettings, SETTINGS_PUBLISH, type SettingsPublication, type SettingsBus, settings } from "./settings.ts";
import { capacityConfig, invalidCapacityFields } from "./capacity.ts";
import type { StashDurableContribution, StashDurableHost } from "./durable.ts";
import registerStash from "./index.ts";
import { listStashes } from "./store.ts";

test("configuration path resolution remains internal", async () => {
	assert.equal("settingsPath" in (await import("./settings.ts")), false);
});

let root: string;
let agentDir: string;
const environmentKeys = [
	"PI_CODING_AGENT_DIR",
	"PI_HARNESS_FILE",
	"PI_STASH_DIR",
	"PI_STASH_CAPACITY",
	"PI_STASH_CHECKPOINT_PERCENT",
	"PI_STASH_DECISION_PERCENT",
	"PI_STASH_INTAKE_TOKEN_BUDGET",
	"PI_STASH_CHECKPOINT_DIR",
];
const saved = environmentKeys.map((key) => [key, process.env[key]] as const);
before(async () => {
	root = await mkdtemp(join(tmpdir(), "stash-settings-"));
	agentDir = join(root, "ordinary");
	await mkdir(agentDir);
	for (const key of environmentKeys) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
after(async () => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
});

async function document(stash: Record<string, unknown>) {
	await writeFile(join(agentDir, "harness.json"), JSON.stringify({ version: 1, stash }));
}
function read(env: Record<string, string | undefined> = {}) {
	return readSettings({ agentDir, env });
}

test("declared defaults and file/environment selection preserve derived path dependencies", async () => {
	await document({});
	let snapshot = read();
	assert.equal(snapshot.values.dir, join(agentDir, "stash"));
	assert.equal(snapshot.values.checkpointDir, join(agentDir, "stash", "checkpoints"));
	assert.deepEqual(capacityConfig(snapshot.values), {
		enabled: true,
		checkpointPercent: 85,
		decisionPercent: 90,
		intakeTokenBudget: undefined,
	});
	await document({ dir: "file-store", checkpointPercent: 60, decisionPercent: 75, intakeTokenBudget: 2000 });
	assert.equal(read().values.checkpointDir, join(agentDir, "file-store", "checkpoints"));
	snapshot = read({ PI_STASH_DIR: "env-store", PI_STASH_CHECKPOINT_PERCENT: "65" });
	assert.equal(snapshot.values.dir, join(agentDir, "env-store"));
	assert.equal(snapshot.values.checkpointDir, join(agentDir, "env-store", "checkpoints"));
	assert.equal(snapshot.values.checkpointPercent, 65);
	assert.equal(snapshot.values.decisionPercent, 75);
	assert.equal(snapshot.values.intakeTokenBudget, 2000);
	assert.equal(snapshot.records.find((record) => record.key === "dir")?.origin, "env");
	assert.equal(snapshot.records.find((record) => record.key === "decisionPercent")?.origin, "file");
	assert.equal(snapshot.records.find((record) => record.key === "checkpointDir")?.origin, "default");
	assert.equal(read({ PI_STASH_CHECKPOINT_DIR: "working" }).values.checkpointDir, join(agentDir, "working"));
});

test("boolean environment inputs accept 0/1 and true/false without string coercion in JSON", async () => {
	await document({ capacity: false });
	assert.equal(read().values.capacity, false);
	for (const [input, expected] of [
		["0", false],
		["1", true],
		["false", false],
		["true", true],
	] as const) {
		assert.equal(read({ PI_STASH_CAPACITY: input }).values.capacity, expected);
	}
	await document({ capacity: "0" });
	assert.equal(read().values.capacity, true);
	assert.equal(read().records.find((record) => record.key === "capacity")?.status, "invalid");
});

test("invalid selected thresholds, budgets, and paths use defaults and name rejected sources", async () => {
	await document({ checkpointPercent: 60, decisionPercent: 75, dir: "file-store" });
	for (const [key, input, fallback] of [
		["PI_STASH_CHECKPOINT_PERCENT", "0", 85],
		["PI_STASH_CHECKPOINT_PERCENT", "NaN", 85],
		["PI_STASH_DECISION_PERCENT", "101", 90],
		["PI_STASH_INTAKE_TOKEN_BUDGET", "1.5", undefined],
		["PI_STASH_DIR", "", join(agentDir, "stash")],
		["PI_STASH_DIR", "bad\u0000path", join(agentDir, "stash")],
		["PI_STASH_CHECKPOINT_DIR", "", join(agentDir, "file-store", "checkpoints")],
	] as const) {
		const snapshot = read({ [key]: input });
		const record = snapshot.records.find((entry) => entry.env === key);
		assert.equal(record?.value, fallback);
		assert.equal(record?.status, "invalid");
		assert.equal(record?.origin, "default");
		assert.ok(snapshot.diagnostics.some((fact) => fact.field === record?.name && fact.source === "env"));
	}
	await document({ dir: null, checkpointDir: 4, checkpointPercent: -1, decisionPercent: 200 });
	const snapshot = read();
	assert.equal(snapshot.diagnostics.filter((fact) => fact.source === "file").length, 4);
	assert.equal(snapshot.values.checkpointDir, join(agentDir, "stash", "checkpoints"));
});

test("owning threshold validation rejects enabled relations and skips disabled observation", async () => {
	await document({ checkpointPercent: 90, decisionPercent: 90 });
	const raw = read();
	assert.equal(
		raw.diagnostics.some((issue) => issue.code === "relation"),
		false,
	);
	assert.ok(raw.records.every((record) => record.status !== "invalid"));
	const values = raw.values;
	assert.deepEqual(invalidCapacityFields(values), ["checkpointPercent", "decisionPercent"]);
	assert.throws(() => capacityConfig(values), /stash.checkpointPercent.*stash.decisionPercent/);
	assert.deepEqual(invalidCapacityFields({ ...values, capacity: false }), []);
	assert.equal(capacityConfig({ ...values, capacity: false }).enabled, false);
});

function factory() {
	const bus = createEventBus();
	const shutdowns: Array<() => unknown> = [];
	let contribution: StashDurableContribution | undefined;
	bus.on("durable:contribution", (value) => {
		contribution = value as StashDurableContribution;
	});
	const pi: Parameters<typeof registerStash>[0] = {
		events: bus,
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		sendUserMessage: () => {},
		sendMessage: () => {},
		appendEntry: () => {},
		on: ((event: string, handler: () => unknown) => {
			if (event === "session_shutdown") shutdowns.push(handler);
			return () => {};
		}) as Parameters<typeof registerStash>[0]["on"],
	};
	registerStash(pi);
	assert.ok(contribution);
	return { bus, shutdowns, contribution };
}

test("ordinary factory publishes fresh relation diagnostics and releases its subscription", async () => {
	await document({ checkpointPercent: 90, decisionPercent: 90 });
	const { bus, shutdowns } = factory();
	const collector = captureSettings(bus);
	let publication = collector.snapshots()[0];
	assert.ok(publication);
	assert.equal(publication.source.path, join(agentDir, "harness.json"));
	for (const key of ["checkpointPercent", "decisionPercent"]) {
		assert.equal(publication.records.find((record) => record.key === key)?.status, "invalid");
		assert.ok(publication.diagnostics.some((fact) => fact.field === `stash.${key}` && fact.code === "relation"));
	}
	await document({ checkpointPercent: 50, decisionPercent: 70 });
	collector.refresh();
	publication = collector.snapshots()[0];
	assert.equal(publication.records.find((record) => record.key === "checkpointPercent")?.value, 50);
	assert.equal(publication.diagnostics.length, 0);
	for (const shutdown of shutdowns) await shutdown();
	collector.refresh();
	assert.deepEqual(collector.snapshots(), []);
	collector.dispose();
});

test("native creation replaces the ordinary publisher with the host agent directory", async () => {
	await document({ dir: "ordinary-store", capacity: false });
	const nativeDir = join(root, "native");
	await mkdir(nativeDir);
	await writeFile(
		join(nativeDir, "harness.json"),
		JSON.stringify({ version: 1, stash: { dir: "native-store", capacity: false } }),
	);
	const { bus, contribution, shutdowns } = factory();
	const collector = captureSettings(bus);
	assert.equal(
		collector.snapshots()[0].records.find((record) => record.key === "dir")?.value,
		join(agentDir, "ordinary-store"),
	);
	const cleanups: Array<() => void | Promise<void>> = [];
	const host: StashDurableHost = {
		durable: Durable,
		services: {} as AgentSessionServices,
		cwd: join(root, "project"),
		agentDir: nativeDir,
		storageId: "fixture-storage",
		signal: new AbortController().signal,
		onClose: (cleanup) => {
			cleanups.push(cleanup);
		},
		inventory: { contributions: [], ordinaryOnly: [] },
		launchIndependent: async () => {
			throw new Error("No launch in this fixture.");
		},
	};
	contribution.create(host);
	const publications: SettingsPublication[] = [];
	const unsubscribe = bus.on(SETTINGS_PUBLISH, (value) => {
		publications.push(value as SettingsPublication);
	});
	collector.refresh();
	assert.equal(publications.length, 1);
	const publication = collector.snapshots()[0];
	assert.equal(publication.source.path, join(nativeDir, "harness.json"));
	assert.equal(publication.records.find((record) => record.key === "dir")?.value, join(nativeDir, "native-store"));
	assert.equal(
		publication.records.find((record) => record.key === "checkpointDir")?.value,
		join(nativeDir, "native-store", "checkpoints"),
	);
	for (const shutdown of shutdowns) await shutdown();
	collector.refresh();
	assert.equal(collector.snapshots().length, 1);
	for (const cleanup of cleanups) await cleanup();
	collector.refresh();
	assert.deepEqual(collector.snapshots(), []);
	unsubscribe();
	collector.dispose();
});

test("native tools use file settings and resolve checkpoint paths against their host, not ambient cwd", async (t) => {
	await document({ dir: "wrong-store", capacity: false });
	const nativeDir = join(root, "native-runtime");
	await mkdir(nativeDir);
	await writeFile(
		join(nativeDir, "harness.json"),
		JSON.stringify({
			version: 1,
			stash: { dir: "native-store", checkpointDir: "working", capacity: false },
		}),
	);
	const { contribution, shutdowns } = factory();
	const cleanups: Array<() => void | Promise<void>> = [];
	const faux = fauxProvider({ provider: "acme", models: [{ id: "model-x", contextWindow: 100000 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const host: StashDurableHost = {
		durable: Durable,
		services: { modelRuntime: models } as unknown as AgentSessionServices,
		cwd: join(root, "other-project"),
		agentDir: nativeDir,
		storageId: "runtime-fixture",
		signal: new AbortController().signal,
		onClose: (cleanup) => {
			cleanups.push(cleanup);
		},
		inventory: { contributions: [], ordinaryOnly: [] },
		launchIndependent: async () => {
			throw new Error("No launch in this fixture.");
		},
	};
	const registry = Durable.createRegistry();
	registry.install(contribution.create(host));
	const context = BACKGROUND_CONTEXT;
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	t.after(async () => {
		await harness.close(context);
		for (const cleanup of cleanups) await cleanup();
		for (const shutdown of shutdowns) await shutdown();
	});
	const conversation = await harness.root(context, {
		agent: { model: { provider: "acme", modelId: "model-x" }, cwd: host.cwd },
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("stash_write", { title: "Handover", summary: "Saved state." }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			fauxToolCall("stash_write", { title: "Checkpoint", summary: "Working state.", checkpoint: true }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("saved"),
	]);
	const submission = await conversation.submit({ type: "input", content: "Save the fixture state." }, context);
	const settled = await submission.wait(context);
	assert.equal(settled.status, "done");
	assert.equal((await listStashes(join(nativeDir, "native-store"), {})).length, 1);
	assert.equal((await listStashes(join(nativeDir, "working"), {})).length, 1);
	assert.deepEqual(await listStashes(join(agentDir, "wrong-store"), {}), []);
	const command = contribution.commands?.[0];
	assert.ok(command);
	const message = await command.run({
		args: "capacity",
		conversation,
		harness,
		context,
		host,
		invocationId: "capacity-status",
	});
	assert.match(message, /Capacity observation is disabled by stash.capacity/);
	assert.doesNotMatch(message, /PI_STASH_CAPACITY=0/);
});

test("README table lists each declared field and environment name", async () => {
	const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
	for (const [key, field] of Object.entries(settings.fields)) {
		assert.ok(readme.includes(`| ${key} | \`${field.env}\` |`));
	}
});

function captureSettings(bus: SettingsBus) {
	let publications: SettingsPublication[] = [];
	const dispose = bus.on("harness:settings:publish", (value) => {
		publications.push(value as SettingsPublication);
	});
	const refresh = () => {
		publications = [];
		bus.emit("harness:settings:request", { version: 1 });
	};
	refresh();
	return { snapshots: () => publications, refresh, dispose };
}

test("zero thresholds are invalid for file and environment selections", async () => {
	await document({ checkpointPercent: 0, decisionPercent: 0 });
	const file = read();
	assert.equal(file.values.checkpointPercent, 85);
	assert.equal(file.values.decisionPercent, 90);
	assert.deepEqual(
		file.diagnostics.map((issue) => [issue.field, issue.source, issue.code]),
		[
			["stash.checkpointPercent", "file", "invalid"],
			["stash.decisionPercent", "file", "invalid"],
		],
	);
	await document({ checkpointPercent: 60, decisionPercent: 75 });
	const env = read({ PI_STASH_CHECKPOINT_PERCENT: "0", PI_STASH_DECISION_PERCENT: "0" });
	assert.equal(env.values.checkpointPercent, 85);
	assert.equal(env.values.decisionPercent, 90);
	assert.ok(
		env.records
			.filter((record) => record.type === "number")
			.every((record) => record.status === "invalid" && record.origin === "default"),
	);
});
test("invalid safe defaults throw only a field-naming declaration error", async () => {
	const field = settings.fields.checkpointPercent as { default: number };
	const original = field.default;
	try {
		field.default = 0;
		assert.throws(() => read(), { message: "Invalid default for stash.checkpointPercent" });
	} finally {
		field.default = original;
	}
});
