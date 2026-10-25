import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createConversation, parseConversationCreation } from "./create-conversation.ts";
import { AgentCatalog } from "./catalog.ts";
import { DurableHost } from "./durable-host.ts";
import { createDurableServices } from "./durable-services.ts";
import { answerMessage, scriptedRuntime } from "./durable-host-fixture.mts";
import { testModel } from "./test-runtime.mts";
import { machineConfig } from "./settings-fixture.mts";
import { createProjectTrustResolver } from "./trust-support.ts";
import type { HostConnection } from "./host-client.ts";
import { HOST_CONTRACT } from "./version-contract.ts";

const override = process.env.PI_HARNESS_FILE;
delete process.env.PI_HARNESS_FILE;
after(() => { if (override !== undefined) process.env.PI_HARNESS_FILE = override; });
const packageDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));

for (const saved of [true, false]) test(`native creation preserves the saved project trust decision ${saved}`, { timeout: 15000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "agent-native-create-"));
	const agentDir = join(root, "agent"), cwd = join(root, "work"), storeRoot = join(root, "native");
	mkdirSync(agentDir); mkdirSync(cwd);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false } }));
	writeFileSync(join(agentDir, "harness.json"), JSON.stringify(machineConfig({ presets: { standard: { model: `${testModel.provider}/${testModel.id}` } }, preferences: { defaultPreset: "standard" } })));
	const skill = join(agentDir, "skills", "native-proof", "SKILL.md");
	mkdirSync(dirname(skill), { recursive: true });
	writeFileSync(skill, "---\nname: native-proof\ndescription: Write the native proof marker.\n---\nWrite SKILL-NATIVE to the selected output file.\n");
	const output = join(cwd, "proof.txt");
	const call = (name: string, args: Record<string, string>) => ({ ...answerMessage(), stopReason: "toolUse" as const, content: [{ type: "toolCall" as const, id: `native-${name}`, name, arguments: args }] });
	const trust = new ProjectTrustStore(agentDir); trust.set(cwd, saved);
	let host: DurableHost | undefined;
	let services: Awaited<ReturnType<typeof createDurableServices>> | undefined;
	const options: NonNullable<Parameters<typeof createConversation>[1]> = {
		models: { getModel: (provider, id) => provider === testModel.provider && id === testModel.id ? testModel : undefined, getModels: () => [testModel] },
		acquire: async metadata => {
			assert.equal(metadata.trust, undefined);
			const resolver = createProjectTrustResolver({ cwd, trustStore: trust, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }), requiresTrust: () => true, trusted: metadata.trust });
			assert.equal(await resolver({ extensionsResult: { extensions: [], errors: [], runtime: {} } as never }), saved);
			if (!host) {
				services = await createDurableServices({ cwd, agentDir, storageId: metadata.storageId, packageDir, extensionPaths: [], trustStore: trust });
				host = await DurableHost.open({ storagePath: metadata.storagePath, storageId: metadata.storageId, cwd, models: await scriptedRuntime([call("read", { path: skill }), call("write", { path: output, content: "SKILL-NATIVE" }), answerMessage("native edit complete")]), registry: services.registry, settings: services.settings, env: services.env, agent: { model: metadata.model }, resume: false }, BACKGROUND_CONTEXT);
				await services.install(host.harness); host.resume();
			}
			const active = host;
			let closed = false;
			return { pid: process.pid, storageId: metadata.storageId, socketPath: join(root, "unused.sock"), metadata, runtimeContract: HOST_CONTRACT,
				get closed() { return closed; }, request: (method, params) => active.request(method, params as Record<string, unknown>), onClose: () => () => {}, subscribeChanges: async () => () => {}, close: async () => { closed = true; },
			} as HostConnection;
		},
	};
	t.after(async () => { await host?.close(); await services?.close(); rmSync(root, { recursive: true, force: true }); });
	const input = { protocol: 1, root: storeRoot, agentDir, packageDir, cwd, requestId: "creation", name: "operator conversation" };
	const first = await createConversation(JSON.stringify(input), options);
	assert.equal(first.state, "completed");
	assert.equal(first.root, storeRoot); assert.equal(first.packageDir, packageDir);
	const replay = await createConversation(JSON.stringify(input), options);
	assert.equal(replay.identity, first.identity);
	assert.equal((await new AgentCatalog(storeRoot).page({ limit: 20 })).records.length, 1);
	assert.equal((await createConversation(JSON.stringify({ ...input, name: "changed" }), options)).state, "rejected");
	assert.equal(trust.get(cwd), saved);
	assert.ok(host);
	const admission = await host.submit({ message: "/skill:native-proof", requestId: "native-proof" });
	assert.equal((await host.wait(admission.submissionId)).status, "done");
	assert.equal(readFileSync(output, "utf8"), "SKILL-NATIVE");
	assert.throws(() => parseConversationCreation({ ...input, trust: false }));
});
