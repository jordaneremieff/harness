import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mutateCollaboration, projectCollaboration, type CollaborationPage } from "./collaboration.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureRuntime, hostOptions } from "./durable-host-fixture.mts";
import { closeColdObservations } from "./cold-observation.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentManager } from "./manager.ts";
import { eventLog, waitForProcessExit } from "./host-fixture.mts";

/** Failure reports name the failed wait and carry bounded publisher evidence. */
const PUBLISHER_STDERR_BYTES = 8192;

function failedWait(label: string, evidence: () => string = () => "") {
	return (error: unknown): never => {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${label} failed: ${detail}${evidence()}`, { cause: error });
	};
}

/** Bounded ordered producer trace; a failed wait reports what progressed and in which order. */
function producerTrace(limitBytes = 8192) {
	const start = Date.now();
	const lines: string[] = [];
	let bytes = 0;
	return {
		push(line: string): void {
			const entry = `t+${Date.now() - start}ms ${line}`;
			if (bytes >= limitBytes) return;
			const bounded = entry.slice(0, limitBytes - bytes);
			bytes += bounded.length;
			lines.push(bounded);
		},
		text(): string {
			return lines.length === 0 ? "" : `\nproducer trace (bounded): ${lines.join(" | ")}`;
		},
	};
}

/** The writer is already initialized before the observer subscribes or creates a file. */
async function publisher(t: { after(fn: () => void | Promise<void>): void }, root: string) {
	const messages = eventLog<{ type: string; id?: string; submissions?: number }>();
	const source = `
		import { AgentCatalog } from ${JSON.stringify(new URL("./catalog.ts", import.meta.url).href)};
		import { DurableHost } from ${JSON.stringify(new URL("./durable-host.ts", import.meta.url).href)};
		import { fixtureRuntime, fixtureRegistry, hostOptions } from ${JSON.stringify(new URL("./durable-host-fixture.mts", import.meta.url).href)};
		import { mutateCollaboration, projectCollaboration } from ${JSON.stringify(new URL("./collaboration.ts", import.meta.url).href)};
		import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
		const root = process.argv[1];
		const catalog = new AgentCatalog(root);
		process.on('message', async command => {
			if (command.type === 'create') {
				const record = catalog.create({cwd:root,agentDir:root,packageDir:root,model:{provider:'test',modelId:'test'},thinkingLevel:'off'});
				process.send({type:'created',id:record.storageId});
			} else if (command.type === 'update') {
				catalog.markRecoveryDue(command.id,true);
				process.send({type:'updated',id:command.id});
			} else if (command.type === 'discard') {
				catalog.discardUnopened(catalog.read(command.id));
				process.send({type:'discarded',id:command.id});
			} else if (command.type === 'post') {
				const record = catalog.read(command.id);
				const host = await DurableHost.open({...hostOptions(record.storagePath,await fixtureRuntime('answer'),fixtureRegistry()),storageId:record.storageId},BACKGROUND_CONTEXT);
				try {
					await mutateCollaboration(host.harness,record.storageId,{action:'post',threadId:command.threadId,requestId:command.requestId,senderIdentity:record.storageId,origin:'model',message:command.message},BACKGROUND_CONTEXT);
					catalog.updateView(record.storageId,{updatedAt:new Date().toISOString(),rows:[],coverage:{complete:true,omitted:0}},await projectCollaboration(host.harness,BACKGROUND_CONTEXT));
					process.send({type:'posted',id:record.storageId,submissions:(await host.harness.inspect(BACKGROUND_CONTEXT)).submissions.length});
				} finally {await host.close();}
			}
		});
		process.send({type:'ready'});
	`;
	// Capture bounded publisher stderr for cross-process wait failures.
	const stderrChunks: Buffer[] = [];
	let stderrBytes = 0;
	const child = spawn(process.execPath, ["--input-type=module", "-e", source, root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderrBytes >= PUBLISHER_STDERR_BYTES) return;
		const bounded = chunk.subarray(0, PUBLISHER_STDERR_BYTES - stderrBytes);
		stderrBytes += bounded.length;
		stderrChunks.push(bounded);
	});
	const publisherEvidence = (): string => {
		const state = child.exitCode !== null ? `exit ${child.exitCode}` : child.signalCode !== null ? `signal ${child.signalCode}` : "still running";
		const text = Buffer.concat(stderrChunks).toString("utf8").trim();
		return `\npublisher ${state}${text === "" ? "" : `; stderr (${stderrBytes} bytes, bounded): ${text}`}`;
	};
	child.on("message", (value) => messages.push(value as { type: string; id?: string; submissions?: number }));
	const exited = waitForProcessExit(child, 30000);
	void exited.catch(() => undefined);
	t.after(async () => { child.kill("SIGTERM"); await exited; });
	await messages.waitForCount(1).catch(failedWait("publisher ready wait", publisherEvidence));
	assert.equal(messages[0]?.type, "ready");
	return { child, messages, evidence: publisherEvidence };
}

function fixture(t: { after(fn: () => void | Promise<void>): void }) {
	const root = mkdtempSync(join(tmpdir(), "catalog-events-"));
	let acquisitions = 0;
	const manager = new AgentManager({ root, agentDir: root, packageDir: root, acquire: async () => { acquisitions++; throw new Error("Observation must not acquire a host"); } });
	t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
	return { root, manager, acquisitions: () => acquisitions };
}

it("receives immediate external creates after subscription without a watcher warm-up", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const { child, messages, evidence: publisherEvidence } = await publisher(t, f.root);
	for (let trial = 0; trial < 12; trial++) {
		const changed = eventLog<void>();
		const off = f.manager.subscribeRoster(() => changed.push(undefined));
		try {
			child.send({ type: "create" });
			await Promise.all([
				changed.waitForCount(1).catch(failedWait("roster change wait", publisherEvidence)),
				messages.waitForCount(trial + 2).catch(failedWait("publisher create-message wait", publisherEvidence)),
			]);
			const id = messages[trial + 1]?.id;
			assert.ok(id);
			assert.equal(f.manager.catalog.read(id).storageId, id);
		} finally { off(); }
	}
	assert.deepEqual(readdirSync(join(f.manager.catalog.root, ".observers")), []);
	assert.equal(f.acquisitions(), 0);
});

it("notifies every manager for external rewrite and discard, then releases its registration", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const second = new AgentManager({ root: f.root, agentDir: f.root, packageDir: f.root });
	t.after(() => second.close());
	const { child, messages, evidence: publisherEvidence } = await publisher(t, f.root);
	const firstEvents = eventLog<void>();
	const secondEvents = eventLog<void>();
	const offFirst = f.manager.subscribeRoster(() => firstEvents.push(undefined));
	const offSecond = second.subscribeRoster(() => secondEvents.push(undefined));
	child.send({ type: "create" });
	await Promise.all([
		firstEvents.waitForCount(1).catch(failedWait("first manager roster notice wait", publisherEvidence)),
		secondEvents.waitForCount(1).catch(failedWait("second manager roster notice wait", publisherEvidence)),
		messages.waitForCount(2).catch(failedWait("publisher create-message wait", publisherEvidence)),
	]);
	const id = messages[1]?.id;
	assert.ok(id);
	child.send({ type: "update", id });
	await Promise.all([
		firstEvents.waitForCount(2).catch(failedWait("first manager rewrite notice wait", publisherEvidence)),
		secondEvents.waitForCount(2).catch(failedWait("second manager rewrite notice wait", publisherEvidence)),
		messages.waitForCount(3).catch(failedWait("publisher update-message wait", publisherEvidence)),
	]);
	assert.equal(f.manager.catalog.read(id).recoveryDue, true);
	assert.equal(second.catalog.read(id).recoveryDue, true);
	offFirst();
	child.send({ type: "discard", id });
	await Promise.all([
		secondEvents.waitForCount(3).catch(failedWait("second manager discard notice wait", publisherEvidence)),
		messages.waitForCount(4).catch(failedWait("publisher discard-message wait", publisherEvidence)),
	]);
	assert.equal(firstEvents.length, 2, "released listeners receive no later notice");
	assert.equal(existsSync(f.manager.catalog.path(id)), false);
	const records = readdirSync(join(f.manager.catalog.root, ".observers"));
	assert.equal(records.length, 1);
	const recordName = records[0];
	assert.ok(recordName);
	const registration = JSON.parse(readFileSync(join(f.manager.catalog.root, ".observers", recordName), "utf8")) as { socketPath: string };
	second.close();
	assert.deepEqual(readdirSync(join(f.manager.catalog.root, ".observers")), []);
	offSecond();
	assert.throws(() => second.subscribeRoster(() => {}), /closed/u);
	assert.equal(f.acquisitions(), 0);
	assert.equal(existsSync(registration.socketPath), false, "close removes the private socket synchronously");
});

it("refreshes a real cold thread after external publication without acquiring a host or scheduling input", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	t.after(() => closeColdObservations());
	const record = f.manager.catalog.create({ cwd: f.root, agentDir: f.root, packageDir: f.root, model: { provider: "test", modelId: "test" }, thinkingLevel: "off" });
	const host = await DurableHost.open({ ...hostOptions(record.storagePath, await fixtureRuntime("answer"), fixtureRegistry()), storageId: record.storageId }, BACKGROUND_CONTEXT);
	let threadId: string;
	try {
		const created = await mutateCollaboration(host.harness, record.storageId, { action: "create", requestId: "create", senderIdentity: record.storageId, origin: "model", title: "Cold source", purpose: "Observe external publication", authority: "Isolated test", source: "Current native storage", restrictions: "No observation host or model", acceptance: "Catalog event causes a cold read" }, BACKGROUND_CONTEXT);
		threadId = created.threadId;
		f.manager.catalog.updateView(record.storageId, { updatedAt: new Date().toISOString(), rows: [], coverage: { complete: true, omitted: 0 } }, await projectCollaboration(host.harness, BACKGROUND_CONTEXT));
		assert.equal((await host.harness.inspect(BACKGROUND_CONTEXT)).submissions.length, 0);
	} finally { await host.close(); }
	const caller = { id: randomUUID(), cwd: f.root };
	const before = await f.manager.collaborate({ action: "read", threadId }, caller) as CollaborationPage;
	assert.equal(before.thread.sequence, 1);
	const { child, messages, evidence: publisherEvidence } = await publisher(t, f.root);
	const refreshed = eventLog<CollaborationPage>();
	const errors = eventLog<unknown>();
	const trace = producerTrace();
	child.on("message", (value) => trace.push(`child ${(value as { type?: string }).type ?? "message"}`));
	let active = true;
	const off = f.manager.subscribeRoster(() => {
		trace.push("roster notice");
		if (active) void f.manager.collaborate({ action: "read", threadId }, caller).then((page) => {
			trace.push(`refresh sequence ${(page as CollaborationPage).thread.sequence}`);
			refreshed.push(page as CollaborationPage);
		}, (error) => {
			trace.push("refresh failed");
			errors.push(error);
		});
	});
	child.send({ type: "post", id: record.storageId, threadId, requestId: "external-post", message: "External cold publication" });
	try {
		await Promise.all([
			messages.waitForCount(2).catch(failedWait("publisher posted-message wait", () => `${publisherEvidence()}${trace.text()}`)),
			refreshed.waitFor((pages) => pages.some((page) => page.thread.sequence === 2)).catch(failedWait("cold refresh wait", () => `${publisherEvidence()}${trace.text()}`)),
		]);
		assert.ok(refreshed.some((page) => page.events.some((event) => event.message === "External cold publication")));
		assert.equal(messages[1]?.submissions, 0);
		assert.deepEqual(errors, []);
		assert.equal(f.acquisitions(), 0);
		assert.deepEqual(f.manager.connectedStorageIds(), []);
	} finally { active = false; off(); }
});

it("refuses excess subscriptions and reclaims only proven-dead local slots", async (t) => {
	const f = fixture(t);
	const managers: AgentManager[] = [];
	t.after(() => { for (const manager of managers) manager.close(); });
	for (let index = 0; index < 32; index++) {
		const manager = new AgentManager({ root: f.root, agentDir: f.root, packageDir: f.root });
		managers.push(manager);
		manager.subscribeRoster(() => {});
	}
	assert.throws(() => f.manager.subscribeRoster(() => {}), /capacity/u);
	const slot = join(f.manager.catalog.root, ".observers", "0.json");
	const previous = readFileSync(slot, "utf8");
	managers[0]?.close();
	const dead = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
	assert.ok(dead.pid);
	writeFileSync(slot, JSON.stringify({ ...JSON.parse(previous), id: randomUUID(), pid: dead.pid, hostname: hostname() }));
	const off = f.manager.subscribeRoster(() => {});
	const current = JSON.parse(readFileSync(slot, "utf8"));
	assert.equal(current.pid, process.pid);
	assert.notEqual(current.id, JSON.parse(previous).id);
	off();
});
