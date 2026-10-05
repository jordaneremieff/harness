import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { getPackageDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { acquireHost, type HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";
import { launchIndependentCommand, type IndependentCommandInput, type IndependentLaunchOptions } from "./independent-launch.ts";
import { AgentManager } from "./manager.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { killHost, runtimeFixture, trackHost } from "./durable-runtime-fixture.mts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "independent-launch-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "work"); mkdirSync(cwd);
	const input: IndependentCommandInput = { invocationId: "invocation-one", creatorId: randomUUID(), cwd, name: "Independent fixture", command: { name: "fixture-independent", data: { hint: "One subject", source: "Captured source", destination: "Captured destination" } } };
	const calls: { method: string; params: unknown }[] = [];
	const metadata: HostMetadata[] = [];
	let selections = 0; let closes = 0; let subscriptions = 0;
	let selected = { model: { provider: "agent-test", modelId: "first" }, thinkingLevel: "high", projectTrusted: false };
	const options = {
		root, agentDir: join(root, "agent"), packageDir: getPackageDir(),
		resolveDefaults: async () => { selections++; return selected; },
		acquire: async (host, launchOptions) => {
			assert.deepEqual(launchOptions, { retryAttempts: 0 }); metadata.push(host);
			return {
				metadata: host, storageId: host.storageId, pid: 4242, socketPath: join(root, "unused.sock"), closed: false, runtimeContract: HOST_CONTRACT,
				request: async (method: string, params: unknown) => { calls.push({ method, params }); return { identity: host.storageId, conversationId: 1, name: input.command.name, text: "committed" }; },
				onClose: () => { throw new Error("Independent launch must not adopt its client"); },
				subscribeChanges: async () => { subscriptions++; throw new Error("Independent launch must not subscribe"); },
				close: async () => { closes++; },
			};
		},
	} satisfies IndependentLaunchOptions;
	return { root, input, options, calls, metadata, selected: (next: typeof selected) => { selected = next; }, counts: () => ({ selections, closes, subscriptions }) };
}

it("commits structured command admission without a requester, task, subscription, or retained link", async (t) => {
	const f = fixture(t);
	const receipt = await launchIndependentCommand(f.input, f.options);
	assert.deepEqual(f.counts(), { selections: 1, closes: 1, subscriptions: 0 });
	assert.deepEqual(f.calls, [{ method: "command", params: { sessionId: receipt.sessionId, invocationId: f.input.invocationId, name: f.input.command.name, args: "", data: f.input.command.data } }]);
	const record = new AgentCatalog(f.root).read(receipt.sessionId);
	assert.equal(record.ownerId, f.input.creatorId, "creator is retained only as provenance");
	assert.ok(record.independent); assert.equal(record.independent.projectTrusted, false); assert.match(record.independent.inputDigest, /^[a-f0-9]{64}$/u);
	assert.deepEqual(record.model, { provider: "agent-test", modelId: "first" }); assert.equal(record.thinkingLevel, "high");
	assert.equal(receipt.admission.text, "committed");
});

it("replays one invocation with its retained defaults and rejects changed input before dispatch", async (t) => {
	const f = fixture(t);
	const first = await launchIndependentCommand(f.input, f.options);
	f.selected({ model: { provider: "agent-test", modelId: "second" }, thinkingLevel: "off", projectTrusted: true });
	const again = await launchIndependentCommand(f.input, f.options);
	assert.deepEqual(again, first); assert.equal(f.counts().selections, 1); assert.deepEqual(f.metadata[1], f.metadata[0]);
	await assert.rejects(launchIndependentCommand({ ...f.input, command: { ...f.input.command, data: { source: "Changed source" } } }, f.options), /different command input/u);
	assert.equal(f.calls.length, 2);
	const next = await launchIndependentCommand({ ...f.input, invocationId: "invocation-two" }, f.options);
	assert.notEqual(next.sessionId, first.sessionId); assert.equal(f.counts().selections, 2); assert.equal(f.metadata[2].thinkingLevel, "off");
});

it("snapshots command data before asynchronous setup", async (t) => {
	const f = fixture(t); let release!: () => void;
	const gate = new Promise<void>((done) => { release = done; });
	const admission = launchIndependentCommand(f.input, { ...f.options, resolveDefaults: async () => { await gate; return { model: { provider: "agent-test", modelId: "first" }, thinkingLevel: "high", projectTrusted: true }; } });
	(f.input.command.data as { source: string }).source = "Mutated during setup";
	release(); await admission;
	assert.equal((f.calls[0].params as { data: { source: string } }).data.source, "Captured source");
});

it("returns selector and unopened startup failures without phantom catalog roots", async (t) => {
	const f = fixture(t);
	await assert.rejects(launchIndependentCommand(f.input, { ...f.options, resolveDefaults: async () => { throw new Error("selector failed"); } }), /selector failed/u);
	assert.equal(new AgentCatalog(f.root).readRequest(f.input.creatorId, `independent:${f.input.invocationId}`), undefined);
	await assert.rejects(launchIndependentCommand(f.input, { ...f.options, acquire: async () => { throw new Error("startup failed"); } }), /startup failed/u);
	assert.equal(new AgentCatalog(f.root).readRequest(f.input.creatorId, `independent:${f.input.invocationId}`), undefined);
	assert.equal(f.calls.length, 0);
});

it("preserves opened storage after an ambiguous startup failure", async (t) => {
	const f = fixture(t);
	await assert.rejects(launchIndependentCommand(f.input, { ...f.options, acquire: async (metadata) => { writeFileSync(metadata.storagePath, "retained storage"); throw new Error("readiness lost"); } }), /readiness lost/u);
	assert.ok(new AgentCatalog(f.root).readRequest(f.input.creatorId, `independent:${f.input.invocationId}`));
});

it("closes the link on admission failure and retains one inspectable root for retry", async (t) => {
	const f = fixture(t); let closes = 0;
	await assert.rejects(launchIndependentCommand(f.input, { ...f.options, acquire: async (metadata, options) => {
		const client = await f.options.acquire(metadata, options);
		return { ...client, request: async () => { throw new Error("command admission failed"); }, close: async () => { closes++; await client.close(); } };
	} }), /command admission failed/u);
	assert.equal(closes, 1);
	assert.ok(new AgentCatalog(f.root).readRequest(f.input.creatorId, `independent:${f.input.invocationId}`));
	await launchIndependentCommand(f.input, f.options); assert.equal(f.counts().selections, 1);
});

it("refuses a host with the old command contract before structured input is sent", async (t) => {
	const f = fixture(t);
	await assert.rejects(launchIndependentCommand(f.input, { ...f.options, acquire: async (metadata, options) => {
		const client = await f.options.acquire(metadata, options);
		return { ...client, runtimeContract: { ...HOST_CONTRACT, operations: { ...HOST_CONTRACT.operations, command: { ...HOST_CONTRACT.operations.command, request: "command/1.0.0" } } } };
	} }), /command/u);
	assert.equal(f.calls.length, 0); assert.equal(f.counts().closes, 1);
});

it("rejects malformed invocation identities and non-JSON data before selecting or launching", async (t) => {
	const f = fixture(t);
	await assert.rejects(launchIndependentCommand({ ...f.input, invocationId: "invalid identity" }, f.options), /bounded identity/u);
	await assert.rejects(launchIndependentCommand({ ...f.input, command: { ...f.input.command, data: { invalid: Number.NaN } } }, f.options), /must be JSON/u);
	assert.equal(f.counts().selections, 0); assert.equal(f.metadata.length, 0);
});

const COMMAND_EXTENSION = `import { fileURLToPath } from "node:url";
export default function (pi) {
	pi.events.emit("durable:contribution", {
		name: "fixture.independent", source: fileURLToPath(import.meta.url),
		commands: [{ name: "fixture-independent", description: "Commit a native input with captured JSON", async run(call) {
			if (!call.data || typeof call.data.source !== "string") throw new Error("Captured source is required");
			const submission = await call.conversation.submit({ type: "input", content: JSON.stringify(call.data), requestId: "independent:" + call.invocationId }, call.context);
			return JSON.stringify({ submissionId: submission.id, projectTrusted: call.host.services.settingsManager.isProjectTrusted() });
		} }],
		create(host) { return host.durable.defineExtension({ name: "fixture.independent" }); },
	});
}
`;

it("keeps real native work after launch-link close and manager shutdown, then recovers without a requester route", { timeout: 60000 }, async (t) => {
	const f = runtimeFixture(t);
	const commandPath = join(f.agentDir, "independent.ts"); writeFileSync(commandPath, COMMAND_EXTENSION);
	const settingsPath = join(f.agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	writeFileSync(settingsPath, JSON.stringify({ ...settings, extensions: [...settings.extensions, commandPath], enabledModels: ["durable-runtime-fixture/fixture-model:high"] }));
	const settingsBefore = readFileSync(settingsPath, "utf8");
	const creatorId = randomUUID(); const calls: string[] = []; let launchClient!: HostConnection; let subscriptions = 0;
	const manager = new AgentManager({ root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir, acquire: async (metadata, options) => {
		const client = await acquireHost(metadata, { ...options, env: f.env("request") }); launchClient = client; trackHost(t, client.pid);
		return { metadata, storageId: client.storageId, pid: client.pid, socketPath: client.socketPath, get runtimeContract() { return client.runtimeContract; }, get closed() { return client.closed; }, request: async (method, params, requestOptions) => { calls.push(method); return client.request(method, params, requestOptions); },
			onClose: () => { throw new Error("Independent client must not be adopted"); }, subscribeChanges: async () => { subscriptions++; throw new Error("Independent client must not subscribe"); }, close: () => client.close() };
	} });
	t.after(() => manager.close());
	const input: IndependentCommandInput = { invocationId: randomUUID(), creatorId, cwd: f.cwd, command: { name: "fixture-independent", data: { source: "Captured invocation text", hint: "Captured subject", destination: "Captured target" } } };
	const receipt = await manager.launchIndependent(input);
	await f.marker("requested");
	assert.equal(launchClient.closed, true); assert.deepEqual(calls, ["command"]); assert.equal(subscriptions, 0);
	await manager.close();
	const record = manager.catalog.read(receipt.sessionId);
	assert.equal(record.thinkingLevel, "high"); assert.equal(record.ownerId, creatorId); assert.equal(record.independent?.projectTrusted, true);
	let client = await acquireHost(hostMetadata(record), { env: f.env("request") });
	try {
		const status = await client.request("status", { sessionId: receipt.sessionId }) as { conversation: { busy: boolean } };
		assert.equal(status.conversation.busy, true, "native generation remains active after caller-manager shutdown");
		const page = await client.request("inspect", { sessionId: receipt.sessionId, view: "history", limit: 20 }) as { entries: { kind: string; text?: string }[] };
		assert.match(JSON.stringify(page), /Captured invocation text/u);
		assert.deepEqual((await client.request("receipts", { ownerId: creatorId }) as { receipts: unknown[] }).receipts, []);
		await killHost(client.pid); await client.close();
		client = await acquireHost(hostMetadata(record), { env: f.env("answer") }); trackHost(t, client.pid);
		await f.marker("answered");
		const deadline = AbortSignal.timeout(10000);
		let resolve!: (value: unknown) => void; let reject!: (error: unknown) => void;
		const resultReady = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
		const expired = () => reject(new Error("Native independent result did not settle"));
		deadline.addEventListener("abort", expired, { once: true });
		assert.ok(client.subscribeChanges);
		const stop = await client.subscribeChanges(() => {
			void client.request("inspect", { sessionId: receipt.sessionId, view: "result", submissionId: Number(JSON.parse(receipt.admission.text).submissionId) }).then((value) => {
				const text = JSON.stringify(value);
				if (text.includes("durable runtime answer") && text.includes('"status":"done"')) resolve(value);
			}, reject);
		}, deadline);
		try { assert.match(JSON.stringify(await resultReady), /durable runtime answer/u); }
		finally { stop(); deadline.removeEventListener("abort", expired); }
		assert.deepEqual((await client.request("receipts", { ownerId: creatorId }) as { receipts: unknown[] }).receipts, []);
		assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
		assert.equal(new ProjectTrustStore(f.agentDir).get(f.cwd), null, "evaluated trust is not written into the trust store");
	} finally { await client.close(); }
});

it("reuses a denied project decision at native startup without loading project extensions or writing trust", { timeout: 60000 }, async (t) => {
	const f = runtimeFixture(t);
	const commandPath = join(f.agentDir, "independent.ts"); writeFileSync(commandPath, COMMAND_EXTENSION);
	const settingsPath = join(f.agentDir, "settings.json"); const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	writeFileSync(settingsPath, JSON.stringify({ ...settings, extensions: [...settings.extensions, commandPath], enabledModels: ["durable-runtime-fixture/fixture-model:high"] }));
	mkdirSync(join(f.cwd, ".pi"));
	const projectMarker = join(f.testDir, "untrusted-extension-loaded");
	const projectExtension = join(f.cwd, ".pi", "untrusted.ts");
	writeFileSync(projectExtension, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(projectMarker)}, "loaded"); export default function () {}`);
	writeFileSync(join(f.cwd, ".pi", "settings.json"), JSON.stringify({ extensions: [projectExtension], enabledModels: ["unavailable-test/model"], defaultThinkingLevel: "off" }));
	let asks = 0; let client!: HostConnection;
	const input: IndependentCommandInput = { invocationId: randomUUID(), creatorId: randomUUID(), cwd: f.cwd, command: { name: "fixture-independent", data: { source: "Denied project snapshot" } } };
	const receipt = await launchIndependentCommand(input, { root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir,
		askPrimary: async () => { asks++; return { trusted: false, remember: false }; },
		acquire: async (metadata, options) => {
			// A later settings change must not overturn the evaluated admission decision.
			writeFileSync(settingsPath, JSON.stringify({ ...settings, extensions: [...settings.extensions, commandPath], enabledModels: ["durable-runtime-fixture/fixture-model:high"], defaultProjectTrust: "always" }));
			client = await acquireHost(metadata, { ...options, env: f.env("answer") }); trackHost(t, client.pid); return client;
		},
	});
	try {
		await f.marker("answered");
		assert.equal(asks, 1); assert.equal(client.closed, true);
		assert.equal(JSON.parse(receipt.admission.text).projectTrusted, false);
		const record = new AgentCatalog(f.root).read(receipt.sessionId); assert.equal(record.independent?.projectTrusted, false); assert.equal(record.thinkingLevel, "high");
		assert.equal(new ProjectTrustStore(f.agentDir).get(f.cwd), null);
		assert.equal(existsSync(projectMarker), false, "denied project code never executes at selector or worker startup");
	} finally { await killHost(client.pid); }
});
