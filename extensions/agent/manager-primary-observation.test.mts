import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentManager } from "./manager.ts";
import { createPrimaryChannel, readPrimaryEndpointDescriptor } from "./primary-channel.ts";
import { InspectToolOutputSchema, StatusToolOutputSchema, structuredObservation } from "./observation-schema.ts";
import type { OrdinaryPrimaryObservation } from "./primary-observation.ts";

it("reads ordinary status and ancestry without host acquisition or message delivery", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "ordinary-observation-route-"));
	const id = randomUUID();
	const sessionFile = join(root, "session.jsonl");
	const timestamp = "2026-01-01T00:00:00.000Z";
	writeFileSync(sessionFile, `${[
		{ type: "session", version: 3, id, timestamp, cwd: root },
		{ type: "message", id: "11111111", parentId: null, timestamp, message: { role: "user", content: "Check the parser", timestamp: 0 } },
		{ type: "message", id: "22222222", parentId: "11111111", timestamp, message: { role: "toolResult", content: [{ type: "text", text: "Parser test failed: unexpected token" }], toolName: "bash", toolCallId: "call-1", isError: true, timestamp: 1 } },
	].map(value => JSON.stringify(value)).join("\n")}\n`);
	let deliveries = 0, prompts = 0;
	const channel = await createPrimaryChannel({ id, cwd: root, sessionFile, sessionsRoot: root, deliver: () => { deliveries++; }, promptTrust: async () => { prompts++; return undefined; } });
	const noHost = async (): Promise<never> => { throw new Error("Ordinary observation must not contact a host"); };
	const manager = new AgentManager({ root, agentDir: root, packageDir: root, acquire: noHost, connect: noHost, observe: noHost });
	t.after(async () => { manager.close(); await channel.close(); rmSync(root, { recursive: true, force: true }); });
	const before = readFileSync(sessionFile, "utf8");
	assert.equal(readPrimaryEndpointDescriptor(root, id).info?.sessionFile, sessionFile);
	const status = await manager.status(id) as OrdinaryPrimaryObservation;
	structuredObservation(StatusToolOutputSchema, status);
	assert.equal(status.kind, "ordinary-primary");
	assert.equal(status.view, "status");
	assert.equal(status.unknown.selectedLeaf, "unknown");
	assert.equal(status.unknown.idle, "unknown");
	assert.equal(status.source.ancestry, "latest-retained-ancestry");
	for (const view of ["activity", "history"]) {
		const result = await manager.control("inspect", { sessionId: id, view }, { id: randomUUID(), cwd: root }) as OrdinaryPrimaryObservation;
		structuredObservation(InspectToolOutputSchema, result);
		assert.ok(result.entries.some(entry => entry.isError && entry.text?.includes("Parser test failed")));
	}
	await assert.rejects(manager.control("inspect", { sessionId: id, view: "exact", entryId: 1 }, { id: randomUUID(), cwd: root }), /supports activity and history only/u);
	assert.equal(deliveries, 0);
	assert.equal(prompts, 0);
	assert.equal(readFileSync(sessionFile, "utf8"), before);
	await manager.control("submit", { sessionId: id, message: "Separate message", origin: "operator" }, { id: randomUUID(), cwd: root });
	assert.equal(deliveries, 1, "observation does not disrupt the separate delivery path");
});

it("publishes an ordinary session file at primary registration", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "ordinary-file-publication-"));
	const id = randomUUID(), sessionFile = join(root, "retained.jsonl");
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
	await manager.registerPrimary(id, { signal: new AbortController().signal, cwd: root, sessionFile, send: () => {} });
	assert.equal(readPrimaryEndpointDescriptor(root, id).info?.sessionFile, sessionFile);
	const result = await manager.status(id) as OrdinaryPrimaryObservation;
	assert.equal(result.kind, "ordinary-primary");
	assert.equal(result.coverage.complete, false);
	assert.equal(result.entries.length, 0);
});
