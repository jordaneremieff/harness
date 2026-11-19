import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { createEventBus, getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostError } from "./host-protocol.ts";
import register from "./index.ts";
import { AgentManager } from "./manager.ts";
import { runAgentPaletteStep } from "./palette-commands.ts";
import type { PalettePaths } from "./palette-publication.ts";
import type { AgentPrioritySummary } from "./dashboard-types.ts";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "palette-")));
	const paths: PalettePaths = {
		PI_AGENT_DIR: join(root, "agent dir"), PI_AGENT_SESSIONS_DIR: join(root, "sessions dir"),
		PI_CODING_AGENT_DIR: join(root, "coding dir"), PI_MANAGED_INSTALL_ROOT: join(root, "install dir"),
		PI_HARNESS_FILE: join(root, "agent dir", "harness.json"), TMPDIR: root,
	};
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, paths };
}

function request(command: string, ...answers: unknown[]) {
	return { version: 1 as const, command, context: {}, answers };
}

function row(id: string = randomUUID(), modifiedAt = 1): AgentPrioritySummary {
	return { id, storageId: id.split(":")[0], cwd: "/work/review", state: "idle", modifiedAt, owner: "unknown", partial: false, cost: 0,
		rosterOrder: { priority: false, modifiedAt } };
}

function fakeRoster(rows: AgentPrioritySummary[]) {
	return async () => ({ rows });
}

function profile(identity: string) {
	return { identity, handle: "@review", role: "", revision: "0", hasExpertise: false, updatedAt: null };
}

const noSubmit = async () => { assert.fail("Only a nonblank final message answer may send"); };

test("both commands pick the same bounded roster in activity order without sending", async (t) => {
	const { paths } = fixture(t);
	const rows = Array.from({ length: 201 }, (_, modifiedAt) => row(undefined, modifiedAt));
	rows[200] = { ...rows[200], name: "Newest\nReview", state: "working" };
	rows[199] = { ...rows[199], profile: profile(rows[199].id) };
	const manager = { dashboardPage: fakeRoster(rows), control: noSubmit };
	for (const [command, title] of [["agent.open", "Open an Agent…"], ["agent.message", "Message an Agent…"]]) {
		const reply = await runAgentPaletteStep(request(command), paths, manager);
		assert.ok("ask" in reply);
		assert.equal(reply.ask.kind, "pick");
		assert.equal(reply.ask.prompt.title, title);
		const items = reply.ask.prompt.items as Array<{ id: string; title: string }>;
		assert.deepEqual(items.map(({ id }) => id), rows.slice(1).reverse().map(({ id }) => id));
		assert.deepEqual(items[0], { id: rows[200].id, title: "Newest Review", subtitle: "working · review", detail: "working", icon: "person" });
		assert.equal(items[1].title, "@review");
	}
});

test("open and message prompts use the exact selected conversation", async (t) => {
	const { paths } = fixture(t);
	const target = { ...row(`${randomUUID()}:4`), name: "A".repeat(40) };
	const manager = { dashboardPage: fakeRoster([target]), control: noSubmit };
	assert.deepEqual(await runAgentPaletteStep(request("agent.open", target.id), paths, manager), { show: {
		argv: ["/usr/bin/env", ...Object.entries(paths).map(([key, value]) => `${key}=${value}`), process.execPath,
			resolve("extensions/agent/terminal.ts"), "--session", target.id], label: `agent ${"A".repeat(26)}`, cwd: process.cwd(), placement: "right",
	} });
	assert.deepEqual(await runAgentPaletteStep(request("agent.message", target.id), paths, manager), {
		ask: { kind: "input", prompt: { title: `Message ${target.name}`, placeholder: "Type a message" } },
	});
	const unknown = { error: "The selected agent is not in the retained roster." };
	assert.deepEqual(await runAgentPaletteStep(request("agent.open", "unknown"), paths, manager), unknown);
	assert.deepEqual(await runAgentPaletteStep(request("agent.message", "unknown"), paths, manager), unknown);
	assert.deepEqual(await runAgentPaletteStep(request("agent.message", "unknown", "do not send"), paths, manager), unknown);
	for (const blank of ["", " \n\t "])
		assert.deepEqual(await runAgentPaletteStep(request("agent.message", target.id, blank), paths, manager), { error: "Enter a message before sending." });
});

test("admission uses terminal operator semantics and never resends an uncertain message", async (t) => {
	const { paths } = fixture(t);
	const id = randomUUID();
	const input = request("agent.message", id, " /literal\nKeep spacing. ");
	const cases = [
		{ result: { submissionId: 42 }, reply: { done: { notice: "Sent to Review." } } },
		{ refusal: new HostError("The conversation is closed.", "invalid"), reply: { error: "Message refused: The conversation is closed." } },
		{ refusal: new Error("The connection closed."), reply: { error: "Delivery was not confirmed. Your message may have arrived. Check the conversation before sending again. The connection closed." } },
	];
	for (const scenario of cases) {
		const control = t.mock.fn<AgentManager["control"]>(async (method, params, caller) => {
			assert.equal(method, "submit");
			assert.deepEqual(params, { sessionId: id, message: input.answers[1], whenBusy: "steer", origin: "operator", replyTo: id });
			assert.match(caller.id, /^terminal:/);
			if (scenario.refusal) throw scenario.refusal;
			return scenario.result;
		});
		const manager = { dashboardPage: fakeRoster([{ ...row(id), name: "Review" }]), control };
		assert.deepEqual(await runAgentPaletteStep(input, paths, manager), scenario.reply);
		assert.equal(control.mock.callCount(), 1);
	}
});

test("the ordinary factory publishes at setup and on request, then unsubscribes at shutdown", async (t) => {
	const { root, paths } = fixture(t);
	const old = new Map(Object.keys(paths).map((key) => [key, process.env[key]]));
	t.after(() => { for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	Object.assign(process.env, paths);
	const events = createEventBus();
	const publications: unknown[] = [];
	events.on("harness:palette:publish", (publication) => publications.push(publication));
	let shutdown: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
	await register({ events, on: (name: string, handler: typeof shutdown) => { if (name === "session_shutdown") shutdown = handler; }, registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, getThinkingLevel: () => "off", appendEntry() {} } as unknown as ExtensionAPI);
	assert.deepEqual(readdirSync(root), [], "publication opens no store and creates no files");
	assert.equal(publications.length, 1);
	const published = publications[0] as { version: number; source: string; commands: { id: string; title: string; argv: string[] }[] };
	assert.equal(published.version, 1);
	assert.equal(published.source, "agent");
	assert.deepEqual(published.commands.map(({ id, title }) => [id, title]), [["agent.open", "Open an Agent…"], ["agent.message", "Message an Agent…"]]);
	for (const { argv } of published.commands) assert.deepEqual(argv, [process.execPath, resolve("extensions/agent/palette-commands.ts"), ...Object.values(paths)]);
	events.emit("harness:palette:request", { version: 2 });
	assert.equal(publications.length, 1);
	events.emit("harness:palette:request", { version: 1 });
	assert.deepEqual(publications, [published, published]);
	assert.ok(shutdown);
	await shutdown({}, { sessionManager: { getSessionId: randomUUID } } as unknown as ExtensionContext);
	events.emit("harness:palette:request", { version: 1 });
	assert.equal(publications.length, 2);
});

test("the standalone process uses the supplied paths for passive catalogue reads", async (t) => {
	const { root, paths } = fixture(t);
	const release = join(paths.PI_MANAGED_INSTALL_ROOT, "releases", "fixture");
	mkdirSync(release, { recursive: true });
	writeFileSync(join(paths.PI_MANAGED_INSTALL_ROOT, "current-version"), "fixture\n");
	symlinkSync(resolve(getPackageDir(), "../.."), join(release, "node_modules"), "dir");
	const run = (value: ReturnType<typeof request>) => JSON.parse(execFileSync(process.execPath, [resolve("extensions/agent/palette-commands.ts"), ...Object.values(paths), JSON.stringify(value)], {
		env: { HOME: root }, encoding: "utf8", timeout: 20_000,
	}));
	assert.deepEqual(run(request("agent.open")), { ask: { kind: "pick", prompt: { title: "Open an Agent…", items: [] } } });
	assert.deepEqual(run(request("agent.open", "unknown")), { error: "The selected agent is not in the retained roster." });
	assert.deepEqual(readdirSync(root), ["install dir"], "reading the empty catalogue leaves it absent");
	const manager = new AgentManager({ root: paths.PI_AGENT_SESSIONS_DIR, agentDir: paths.PI_AGENT_DIR, packageDir: getPackageDir() });
	t.after(() => manager.close());
	const record = manager.catalog.createHandled({ cwd: root, agentDir: paths.PI_AGENT_DIR, packageDir: getPackageDir(), model: { provider: "test", modelId: "test" }, thinkingLevel: "off" }, "review", "").record;
	manager.catalog.updateView(record.storageId, { storageId: record.storageId, updatedAt: new Date().toISOString(), rows: [{
		id: record.storageId, storageId: record.storageId, cwd: root, owner: "unknown", state: "idle", modifiedAt: 1, cost: 0, partial: false,
	}], profiles: { rows: [profile(record.storageId)], coverage: { complete: true, omitted: 0 } }, coverage: { complete: true, omitted: 0 } });
	const pick = run(request("agent.message"));
	assert.equal(pick.ask.prompt.items[0].id, record.storageId);
	assert.equal(pick.ask.prompt.items[0].title, "@review");
	const opened = run(request("agent.open", record.storageId));
	assert.deepEqual(opened.show.argv.slice(-2), ["--session", record.storageId]);
	assert.deepEqual(readdirSync(join(paths.PI_AGENT_SESSIONS_DIR, "durable")), [`${record.storageId}.json`]);
});
