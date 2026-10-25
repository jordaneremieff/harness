import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentCatalog } from "./catalog.ts";
import { AgentManager } from "./manager.ts";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureRegistry, hostOptions, scriptedRuntime } from "./durable-host-fixture.mts";
import { callExistingSource, installSourceRoutes, readExistingSources, parseExistingSources, readSourceCall, SOURCE_CALL_BYTES, type RouteCall } from "./source-route.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { machineConfig } from "./settings-fixture.mts";
import { testModel } from "./test-runtime.mts";
import { handleStorageId } from "./identity.ts";

const sourceRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const packageDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const override = process.env.PI_HARNESS_FILE;
delete process.env.PI_HARNESS_FILE;
after(() => { if (override !== undefined) process.env.PI_HARNESS_FILE = override; });

for (const namespace of ["ordinary", "previous-managed"]) test(`a new namespace reuses an expert in the ${namespace} root through its recorded source`, { timeout: 15000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "agent-source-route-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const previousRoot = join(root, namespace), currentRoot = join(root, "next-managed"), agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "harness.json"), JSON.stringify(machineConfig({ presets: { standard: { model: `${testModel.provider}/${testModel.id}` } }, preferences: { defaultPreset: "standard" } })));
	const previous = new AgentCatalog(previousRoot);
	const { record } = previous.createHandled({ cwd: root, agentDir, packageDir, model: { provider: testModel.provider, modelId: testModel.id }, thinkingLevel: "off", ownerId: "original-creator" }, "expert", "Retain the original expert role.");
	assert.ok(record.view);
	const host = await DurableHost.open({ ...hostOptions(record.storagePath, await scriptedRuntime([answerMessage()]), fixtureRegistry()), storageId: record.storageId, profileSeed: record.view.profileSeed }, BACKGROUND_CONTEXT);
	await host.close();
	const { profileSeed: _seed, ...view } = record.view;
	previous.updateView(record.storageId, view);
	const direct = new AgentManager({ root: previousRoot, agentDir, packageDir });
	try { assert.equal(await direct.resolveTarget("@expert"), record.storageId); } finally { direct.close(); }
	await installSourceRoutes(currentRoot, [{ root: previousRoot, sourceRoot, packageDir }]);
	const manager = new AgentManager({ root: currentRoot, agentDir, packageDir });
	t.after(() => manager.close());
	assert.equal(await manager.resolveTarget("@expert"), record.storageId);
	const reused = await manager.spawn({ handle: "expert", role: "Do not replace the existing role." }, { id: "new-operator", cwd: root }) as { sessionId: string; created: boolean; profile: { role: string } };
	assert.equal(reused.sessionId, record.storageId);
	assert.equal(reused.created, false);
	assert.equal(reused.profile.role, "Retain the original expert role.");
	assert.equal((await manager.catalog.page({ limit: 20 })).records.length, 0);
	assert.throws(() => manager.catalog.read(handleStorageId("expert", manager.catalog.root)), { code: "ENOENT" });
	assert.deepEqual(readExistingSources(currentRoot), [{ root: previousRoot, sourceRoot, packageDir }]);
});

test("source routes reject ambiguity and changed source or dependency ownership", { timeout: 10000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "agent-source-ambiguity-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const current = join(root, "current");
	const routes = ["first", "second"].map(name => ({ root: join(root, name), sourceRoot, packageDir }));
	for (const route of routes) new AgentCatalog(route.root).createHandled({ cwd: root, agentDir: root, packageDir, model: { provider: testModel.provider, modelId: testModel.id }, thinkingLevel: "off" }, "expert", "role");
	await installSourceRoutes(current, routes);
	const manager = new AgentManager({ root: current, agentDir: root, packageDir }); t.after(() => manager.close());
	await assert.rejects(manager.resolveTarget("@expert"), /ambiguous ownership/u);
	await assert.rejects(manager.spawn({ handle: "expert" }, { id: "operator", cwd: root }), /ambiguous ownership/u);
	await assert.rejects(installSourceRoutes(current, [{ ...routes[0], packageDir: join(root, "different-installation") }]), /immutable/u);
	assert.throws(() => parseExistingSources([routes[0], routes[0]]));
	assert.throws(() => parseExistingSources([{ ...routes[0], existingSource: routes[1] }]));
	assert.equal((await manager.catalog.page({ limit: 20 })).records.length, 0);
});

function sourceCallFixture(t: { after(fn: () => void): void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-source-stdin-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const directory = join(root, "extensions", "agent"), effects = join(root, "effects");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "durable-runner.ts"), "export {};\n");
	writeFileSync(join(directory, "version-contract.ts"), `export const HOST_CONTRACT = ${JSON.stringify(HOST_CONTRACT)};\n`);
	writeFileSync(join(directory, "host-client.ts"), "export async function acquireHost(){throw new Error('No host is needed');} export const connectHost=acquireHost;\n");
	writeFileSync(join(directory, "manager.ts"), `import {appendFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; export class AgentManager { async spawn(input) {appendFileSync(${JSON.stringify(effects)}, 'effect\\n'); return {bytes:Buffer.byteLength(input.prompt),digest:createHash('sha256').update(input.prompt).digest('hex'),args:process.argv.length};} close(){} }\n`);
	const call: RouteCall = { route: { root, sourceRoot: root, packageDir }, agentDir: root, action: "spawn", input: { prompt: "" }, caller: { id: "test-source", cwd: root }, expected: HOST_CONTRACT.operations };
	return { call, effects };
}

test("source calls carry exact prompt JSON above the OS argument limit through private stdin", { timeout: 15000 }, async t => {
	const { call, effects } = sourceCallFixture(t);
	const argumentLimit = Number(execFileSync("getconf", ["ARG_MAX"], { encoding: "utf8", timeout: 1000, maxBuffer: 1024 }));
	assert.ok(argumentLimit > 0 && argumentLimit < SOURCE_CALL_BYTES / 2);
	const prompt = `"quoted"\\\\path\né🙂${"x".repeat(argumentLimit + 1)}\nend`;
	assert.throws(() => execFileSync(process.execPath, ["-e", "process.exit(0)", prompt], { stdio: "ignore", timeout: 1000 }), { code: "E2BIG" });
	const result = await callExistingSource({ ...call, input: { prompt } }) as { bytes: number; digest: string; args: number };
	assert.equal(result.bytes, Buffer.byteLength(prompt));
	assert.equal(result.digest, createHash("sha256").update(prompt).digest("hex"));
	assert.equal(result.args, 2);
	assert.equal(readFileSync(effects, "utf8"), "effect\n");
});

test("complete source-call byte boundary admits exactly the bound and refuses one extra byte before effects", { timeout: 20000 }, async t => {
	const { call, effects } = sourceCallFixture(t);
	const overhead = Buffer.byteLength(JSON.stringify(call));
	const prompt = "x".repeat(SOURCE_CALL_BYTES - overhead);
	const bounded = { ...call, input: { prompt } };
	assert.equal(Buffer.byteLength(JSON.stringify(bounded)), SOURCE_CALL_BYTES);
	const result = await callExistingSource(bounded) as { bytes: number; digest: string };
	assert.equal(result.bytes, prompt.length);
	assert.equal(result.digest, createHash("sha256").update(prompt).digest("hex"));
	await assert.rejects(callExistingSource({ ...call, input: { prompt: `${prompt}x` } }), /byte limit; no operation was started/u);
	assert.equal(readFileSync(effects, "utf8"), "effect\n");
});

test("source-call reader refuses oversize and malformed UTF-8 before target execution", async t => {
	const { call, effects } = sourceCallFixture(t);
	async function* input(bytes: Uint8Array) { yield bytes; }
	await assert.rejects(readSourceCall(input(Buffer.alloc(SOURCE_CALL_BYTES + 1, 120))), /byte limit/u);
	await assert.rejects(readSourceCall(input(Buffer.from([0xff]))), /UTF-8 JSON/u);
	assert.equal(existsSync(effects), false);
	assert.deepEqual(await readSourceCall(input(Buffer.from(JSON.stringify(call)))), call);
});
