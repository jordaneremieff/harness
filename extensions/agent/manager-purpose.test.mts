import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./manager.ts";
import { retainedPurpose } from "./effort-purpose.ts";

it("does not promote a later remark after a complete resumed history scan", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "primary-resume-purpose-"));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const session = SessionManager.inMemory(root);
	session.appendMessage({ role: "user", content: "Implement the parser", timestamp: 0 });
	const purpose = retainedPurpose(session, "resume");
	assert.equal(purpose.complete, true);
	const id = randomUUID();
	await manager.registerPrimary(id, {
		signal: new AbortController().signal,
		cwd: root,
		send: () => {},
		observedInput: purpose.text,
		observedInputComplete: purpose.complete,
		observedInputCanCapture: purpose.canCapture,
	});
	assert.equal(manager.recordPrimaryInput(id, "this task is taking awhile mate.", "interactive"), false);
	assert.equal(manager.recordPrimaryInput(id, "continue", "interactive"), false);
	const unknown = await manager.awareness(id);
	assert.equal(unknown.self.observedPurpose, undefined);
	assert.equal(unknown.self.omitted, true);
	await manager.publishIntent(id, {
		purpose: "Implement the parser",
		integration: "Review before integration",
		authority: "Operator request",
		scope: { paths: ["parser.ts"], branches: [] },
	});
	const declared = await manager.awareness(id);
	assert.equal(declared.self.intentClaim?.purpose, "Implement the parser");
	assert.equal(declared.self.observedPurpose, undefined);
	assert.equal(declared.self.omitted, undefined);
});

it("captures a first input only when it is interactive and closes capture at any first input", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "primary-first-purpose-"));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const id = randomUUID(),
		emptyId = randomUUID(),
		injectedId = randomUUID();
	for (const sessionId of [id, emptyId, injectedId])
		await manager.registerPrimary(sessionId, {
			signal: new AbortController().signal,
			cwd: root,
			send: () => {},
			observedInputComplete: true,
			observedInputCanCapture: true,
		});
	assert.equal(manager.recordPrimaryInput(id, "Build the parser", "interactive"), true);
	assert.equal(manager.recordPrimaryInput(id, "continue", "interactive"), false);
	assert.equal((await manager.awareness(id)).self.observedPurpose?.text, "Build the parser");
	assert.equal(manager.recordPrimaryInput(emptyId, "", "interactive"), false);
	assert.equal(manager.recordPrimaryInput(emptyId, "A later remark", "interactive"), false);
	assert.equal((await manager.awareness(emptyId)).self.observedPurpose, undefined);
	// A handover pickup or a command's kickoff is the first input, so a later typed message is not the first request.
	assert.equal(manager.recordPrimaryInput(injectedId, "Injected text", "extension"), false);
	assert.equal(manager.recordPrimaryInput(injectedId, "did you get my note", "interactive"), false);
	assert.equal((await manager.awareness(injectedId)).self.observedPurpose, undefined);
});

it("names collaboration selectors before routing malformed identities", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "collaboration-selector-fields-"));
	const noHost = async (): Promise<never> => {
		throw new Error("Malformed selectors must not contact a host");
	};
	const manager = new AgentManager({ root, agentDir: root, packageDir: root, acquire: noHost, connect: noHost });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const caller = { id: randomUUID(), cwd: root };
	const create = {
		action: "create",
		title: "Review",
		purpose: "Test",
		authority: "Task",
		source: "Test",
		restrictions: "Local",
		acceptance: "Verified",
	};
	await assert.rejects(manager.collaborate({ ...create, sessionId: "bad" }, caller), /sessionId.*canonical/u);
	await assert.rejects(
		manager.collaborate({ ...create, sessionId: randomUUID(), integrator: "bad" }, caller),
		/integrator.*canonical/u,
	);
	await assert.rejects(
		manager.collaborate(
			{
				action: "post",
				threadId: `${randomUUID()}/${"a".repeat(32)}`,
				message: "Update",
				notify: [randomUUID(), "bad"],
			},
			caller,
		),
		/notify\[1\].*canonical/u,
	);
	await assert.rejects(
		manager.collaborate({ ...create, sessionId: randomUUID(), integrator: "@missing" }, caller),
		/integrator: handle resolution failed/u,
	);
});
