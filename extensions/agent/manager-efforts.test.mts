import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { eventLog, waitForProcessExit, type EventLog } from "./host-fixture.mts";

const DEADLINE_MS = 12_000;
const FIXTURE = fileURLToPath(new URL("./manager-efforts-fixture.mts", import.meta.url));
interface FixtureEvent { readonly type: string; readonly [key: string]: unknown }
interface ChildFixture {
	readonly child: ChildProcess;
	readonly events: EventLog<FixtureEvent>;
	readonly id: string;
	readonly pid: number;
	command(type: string, values?: Record<string, unknown>): Promise<FixtureEvent>;
}

async function startFixture(root: string, sessionsRoot: string, cwd: string, label: string): Promise<ChildFixture> {
	const agentDir = join(root, `agent-${label}`);
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const child = spawn(process.execPath, ["--experimental-strip-types", FIXTURE, root, agentDir, sessionsRoot, cwd], {
		cwd: process.cwd(),
		env: { PATH: process.env.PATH ?? "", HOME: root, PI_AGENT_DIR: agentDir, PI_AGENT_SESSIONS_DIR: sessionsRoot },
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const events = eventLog<FixtureEvent>();
	child.on("message", (message: unknown) => {
		if (message !== null && typeof message === "object") events.push(message as FixtureEvent);
	});
	child.on("error", (error) => events.push({ type: "fixture-error", error: error.message }));
	child.on("exit", (code, signal) => {
		if (!events.some((event) => event.type === "ready")) events.push({ type: "fixture-error", error: `Child exited before readiness: ${code ?? signal}` });
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-16 * 1024); });
	try {
		await events.waitFor((items) => items.some((item) => item.type === "ready" || item.type === "fixture-error"), DEADLINE_MS);
	} catch (error) {
		child.kill("SIGTERM");
		await waitForProcessExit(child, DEADLINE_MS).catch(() => undefined);
		throw new Error(`Fixture ${label} did not report readiness. Events: ${JSON.stringify(events)}. stderr: ${stderr}. ${String(error)}`);
	}
	const started = events.find((item) => item.type === "ready");
	if (!started) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		await waitForProcessExit(child, DEADLINE_MS).catch(() => undefined);
		throw new Error(`Fixture ${label} failed to start: ${String(events.find((item) => item.type === "fixture-error")?.error ?? stderr)}`);
	}
	if (typeof started.id !== "string" || typeof started.pid !== "number") {
		child.kill("SIGTERM");
		await waitForProcessExit(child, DEADLINE_MS).catch(() => undefined);
		throw new Error(`Fixture ${label} sent an invalid ready event`);
	}
	let nextCommand = 0;
	return {
		child, events, id: started.id, pid: started.pid,
		command: async (type, values = {}) => {
			const id = ++nextCommand;
			const response = events.waitFor((items) => items.some((item) => (item.type === "command-done" || item.type === "command-error") && item.id === id), DEADLINE_MS);
			child.send?.({ type, id, ...values });
			try { await response; }
			catch (error) { throw new Error(`Fixture command ${type} timed out. Events: ${JSON.stringify(events)}. ${String(error)}`); }
			const result = events.find((item) => (item.type === "command-done" || item.type === "command-error") && item.id === id);
			if (result?.type === "command-error") throw new Error(String(result.error));
			assert.ok(result);
			return result;
		},
	};
}

function entriesFor(fixture: ChildFixture): Array<{ customType?: string; content?: unknown; details?: unknown }> {
	const ready = fixture.events.find((event) => event.type === "ready");
	return Array.isArray(ready?.customEntries) ? ready.customEntries as Array<{ customType?: string; content?: unknown; details?: unknown }> : [];
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

async function waitForEvent(fixture: ChildFixture, label: string, predicate: (events: readonly FixtureEvent[]) => boolean): Promise<void> {
	try { await fixture.events.waitFor(predicate, DEADLINE_MS); }
	catch (error) { throw new Error(`Missing ${label}. Events: ${JSON.stringify(fixture.events)}. ${String(error)}`); }
}

it("keeps discovery and intent out of ordinary transcripts across processes", { timeout: 90000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-efforts-"));
	const sessionsRoot = join(root, "sessions");
	const sharedCwd = join(root, "shared-work");
	const isolatedCwd = join(root, "unrelated-work");
	mkdirSync(sessionsRoot);
	const fixtures: ChildFixture[] = [];
	t.after(async () => {
		for (const fixture of fixtures) {
			if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGTERM");
		}
		await Promise.all(fixtures.map((fixture) => waitForProcessExit(fixture.child, DEADLINE_MS).catch(() => undefined)));
		rmSync(root, { recursive: true, force: true });
	});

	const first = await startFixture(root, sessionsRoot, sharedCwd, "first");
	fixtures.push(first);
	const second = await startFixture(root, sessionsRoot, sharedCwd, "second");
	fixtures.push(second);
	assert.notEqual(first.pid, second.pid, "each primary runs in a distinct ordinary Pi process");
	assert.notEqual(first.id, second.id);

	assert.equal(first.events.filter((event) => event.type === "provider-request").length, 0, "the first process stays idle during discovery");
	assert.equal(second.events.filter((event) => event.type === "provider-request").length, 0, "the second process starts without a provider call");
	const secondAwareness = await second.command("inspect");
	const secondView = secondAwareness.awareness as { presence: { efforts: Array<{ id: string; liveness?: string }> }; threads: { items: unknown[] } };
	const initialPage = secondView.presence;
	assert.ok(initialPage.efforts.some((effort) => effort.id === first.id && effort.liveness === "live"), `the second process discovers the existing live primary: ${JSON.stringify(initialPage)}`);
	assert.deepEqual(entriesFor(second), [], "a fresh session with a live related effort has no transcript message");
	assert.deepEqual(secondAwareness.customEntries, []);
	assert.deepEqual((await first.command("snapshot")).customEntries, [], "a new related session does not send a transcript notice");
	await second.command("prompt");
	const injectedContext = second.events.find((event) => event.type === "provider-request");
	assert.ok(textOf(injectedContext?.effortSections).includes(first.id), "the stable before-agent-start context names the existing related primary");
	const parameters = injectedContext?.intentParameters as { type?: string; properties?: Record<string, unknown>; anyOf?: unknown; oneOf?: unknown };
	assert.equal(parameters.type, "object", "the real loader exposes an object schema to the model");
	assert.deepEqual(Object.keys(parameters.properties ?? {}).sort(), ["action", "authority", "contactThread", "integration", "purpose", "scope"]);
	assert.equal(parameters.anyOf, undefined);
	assert.equal(parameters.oneOf, undefined);
	const observed = await second.command("inspect");
	const observedSelf = (observed.awareness as { self: { observedPurpose?: { source: string; text: string } }; threads: { items: unknown[] } }).self;
	assert.deepEqual(observedSelf.observedPurpose, { source: "interactive-input", text: "Check the current effort context" }, "the first interactive input becomes a bounded purpose claim");
	assert.ok(Array.isArray((observed.awareness as { threads: { items: unknown[] } }).threads.items), "the awareness result includes the bounded recent-thread view");

	const publish = await second.command("prompt-intent", { action: "publish" });
	assert.equal(publish.totalRequests, 3, "the synthetic provider returns one tool call and one completion after the context probe");
	assert.deepEqual(publish.customEntries, [], "intent publication does not append a transcript message");
	assert.equal(first.events.filter((event) => event.type === "provider-request").length, 0, "publishing intent does not wake the receiving process");
	const firstView = await first.command("inspect");
	assert.deepEqual(firstView.customEntries, [], "a related intent update does not append a transcript message");
	const firstPage = (firstView.awareness as { presence: { efforts: Array<{ id: string; intentClaim?: { purpose?: string; integration?: string; authority?: string; contactThread?: string } }> } }).presence;
	const claim = firstPage.efforts.find((item) => item.id === second.id)?.intentClaim;
	assert.equal(claim?.purpose, "Review the shared parser");
	assert.equal(claim?.integration, "Send findings to the other primary before merge");
	assert.equal(claim?.authority, "Operator asked for an isolated effort regression");
	assert.equal(claim?.contactThread, "thread-parser-review");

	const operatorMessage = await first.command("control", { sessionId: second.id, message: "Operator note without a wake", origin: "operator" });
	assert.equal((operatorMessage.outcome as { admitted?: boolean }).admitted, true);
	await waitForEvent(second, "operator delivery", (items) => items.some((event) => event.type === "custom-message" && textOf(event.content).includes("Operator note without a wake")));
	const operatorNotice = second.events.find((event) => event.type === "custom-message" && textOf(event.content).includes("Operator note without a wake"));
	assert.equal((operatorNotice?.details as Record<string, unknown> | undefined)?.wake, false);
	assert.equal(second.events.filter((event) => event.type === "provider-request").length, 3, "operator delivery does not invoke the provider");

	await first.command("control", { sessionId: second.id, message: "Model-origin note", origin: "model" });
	await waitForEvent(second, "model-origin provider request", (items) => items.filter((event) => event.type === "provider-request").length === 4);
	assert.equal(second.events.filter((event) => event.type === "provider-request").length, 4, "model-origin delivery retains its wake behavior");

	const unrelated = await startFixture(root, sessionsRoot, isolatedCwd, "unrelated");
	fixtures.push(unrelated);
	const unrelatedView = await unrelated.command("inspect");
	const localEfforts = ((unrelatedView.awareness as { presence: { efforts: Array<{ id: string; relationship: string; intentClaim?: unknown; purposeClaim?: string; authority?: string; integration?: string; sharedSubstrates?: string[] }> } }).presence).efforts;
	assert.ok(localEfforts.some((item) => item.id === first.id && item.relationship === "machine"), "the bounded view includes a local primary from another cwd");
	const isolatedRow = localEfforts.find((item) => item.id === second.id);
	assert.equal(isolatedRow?.intentClaim, undefined, "an unrelated cwd does not expose the full intent claim");
	assert.ok(isolatedRow?.purposeClaim, "an unrelated cwd exposes only the bounded purpose claim");
	assert.equal(isolatedRow?.authority, undefined);
	assert.equal(isolatedRow?.integration, undefined);
	assert.ok(isolatedRow?.sharedSubstrates?.includes("machine-gates"), "a declared full-gate plan marks the shared machine gate substrate");
	assert.deepEqual(entriesFor(unrelated), [], "local efforts from other directories do not create startup transcript messages");
	assert.equal(first.events.filter((event) => event.type === "provider-request").length, 0, "all-local awareness stays quiet in the first process");
	assert.equal(second.events.filter((event) => event.type === "provider-request").length, 4, "all-local awareness stays quiet in the second process");

	const clear = await second.command("prompt-intent", { action: "clear" });
	assert.equal(clear.totalRequests, 6);
	const cleared = await first.command("inspect");
	assert.deepEqual(cleared.customEntries, [], "start, publish and clear leave the other transcript untouched");
	assert.equal((clear.customEntries as unknown[]).length, 2, "only the explicit operator and model messages enter the receiving transcript");
	const clearedPage = (cleared.awareness as { presence: { efforts: Array<{ id: string; intentClaim?: unknown }> } }).presence;
	assert.equal(clearedPage.efforts.find((item) => item.id === second.id)?.intentClaim, undefined, "clear removes the session claim for readers");

	unrelated.child.kill("SIGKILL");
	await waitForProcessExit(unrelated.child, DEADLINE_MS);
	const afterDeath = await first.command("inspect");
	const afterDeathPage = (afterDeath.awareness as { presence: { efforts: Array<{ id: string }>; coverage: { dead: number } } }).presence;
	assert.equal(afterDeathPage.efforts.some((effort) => effort.id === unrelated.id), false, "a dead endpoint is not shown as a live effort");
	assert.ok(afterDeathPage.coverage.dead > 0, "the page records the dead endpoint in coverage");

	for (const fixture of fixtures.filter((item) => item !== unrelated)) await fixture.command("close");
	await Promise.all(fixtures.map((fixture) => waitForProcessExit(fixture.child, DEADLINE_MS)));
	t.diagnostic(JSON.stringify({ processes: fixtures.map(({ id, pid, child }) => ({ id, pid, exitCode: child.exitCode, signalCode: child.signalCode })), providerRequests: { first: first.events.filter((event) => event.type === "provider-request").length, second: second.events.filter((event) => event.type === "provider-request").length, unrelated: unrelated.events.filter((event) => event.type === "provider-request").length }, claims: { published: claim?.purpose, cleared: true }, directDelivery: { operatorWake: (operatorNotice?.details as Record<string, unknown> | undefined)?.wake, modelRequests: 1 }, deadRecord: { omitted: !afterDeathPage.efforts.some((effort) => effort.id === unrelated.id), coverage: afterDeathPage.coverage.dead } }));
});
