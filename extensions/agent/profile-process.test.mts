import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { existsSync, writeFileSync } from "node:fs";
import { it } from "node:test";
import type { AgentProfile } from "./profile-schema.ts";
import { HOST_SERVICE_ID, hostPaths, type HostMetadata } from "./host-protocol.ts";
import { connectHost } from "./host-client.ts";
import { eventLog, waitForProcessExit } from "./host-fixture.mts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { BASE_OPERATIONS } from "./profile-base-contract-fixture.mts";
import { guarded, instructions, lastTool, profileFixture, type ProviderRequest, type Requester } from "./profile-process-fixture.mts";

it("uses the OS temporary directory by default and preserves the scratch-root override", async (t) => {
	const saved = process.env.PROFILE_TEST_ROOT;
	try {
		delete process.env.PROFILE_TEST_ROOT;
		const portable = await profileFixture(t);
		assert.equal(dirname(portable.root), tmpdir());
		process.env.PROFILE_TEST_ROOT = join(portable.root, "custom-scratch");
		const configured = await profileFixture(t);
		assert.equal(dirname(configured.root), process.env.PROFILE_TEST_ROOT);
	} finally {
		if (saved === undefined) delete process.env.PROFILE_TEST_ROOT;
		else process.env.PROFILE_TEST_ROOT = saved;
	}
});

type Updated = { outcome: "applied" | "conflict"; deduped: boolean; profile: AgentProfile };
type Spawned = { sessionId: string; created: boolean; handle: string; profile: AgentProfile | null; availability?: string; creation?: { name: string; role: string } };
type Admitted = { submissionId: number | string; deduped: boolean; identity: string };

function toolData<T>(request: ProviderRequest, name: string): T {
	const result = lastTool(request, name);
	assert.equal(result.isError, false, result.text);
	const details = result.details as { structuredContent?: T } | undefined;
	assert.ok(details?.structuredContent, `${name} supplies its declared structured result`);
	return details.structuredContent;
}

async function send(requester: Requester, sessionId: string, requestId: string, replyTo = requester.identity): Promise<Admitted> {
	return requester.control<Admitted>("task-submit", {
		sessionId, message: `Question ${requestId}`, requestId, requester: requester.identity, replyTo,
		origin: "model", whenBusy: "followUp", checkInMinutes: 0,
	});
}
async function notice(requester: Requester, text: string): Promise<void> {
	await requester.notices.waitFor((items) => items.some((item) => item.text.includes(text)), 60000);
}
function occurrences(requester: Requester, text: string): number { return requester.notices.filter((item) => item.text.includes(text)).length; }

it("retains a standing profile across native boundaries and routes reused work by request", { timeout: 240000 }, async (t) => {
	const f = await profileFixture(t);
	const [a, b, c] = await Promise.all([f.requester(), f.requester(), f.requester()]);
	assert.notEqual(a.process.pid, b.process.pid);
	const created = await a.call<Spawned>("spawn", { handle: "archive-guide", name: "Archive guide", role: "Explain archive evidence with sources.", trust: true });
	assert.equal(created.created, true);
	assert.equal(created.handle, "@archive-guide");
	assert.ok(created.profile);
	const identity = created.sessionId;
	const metadata = await a.call<HostMetadata>("metadata", { sessionId: identity });
	const observation = await a.raw<{ token: string }>(identity, "observe-open", { scope: "conversation", token: randomUUID() });
	const first = await send(a, "@archive-guide", "first-question");
	let request = await f.next();
	assert.ok(request.context.messages.some((message) => message.role === "user" && message.content === "Question first-question"), "native task content remains the caller's words");
	const self = instructions(request);
	for (const value of [identity, "@archive-guide", "Archive guide", "Explain archive evidence with sources.", "agent_profile"]) assert.ok(self.includes(value), value);
	assert.ok(JSON.stringify(request.context).includes(a.identity), "host-authored request names its requester");
	request.tool("agent_profile", { action: "read" });
	request = await f.next();
	const initial = toolData<AgentProfile>(request, "agent_profile");
	assert.equal(initial.identity, identity);
	assert.equal(initial.creator, a.identity);
	const stale = `Observation 2026-01-01: archive region is east. Source: ${f.source}. Recheck the current source before reuse.`;
	request.tool("agent_profile", { action: "update", expectedRevision: initial.revision, role: "Verify current archive evidence.", expertise: stale });
	request = await f.next();
	const saved = toolData<Updated>(request, "agent_profile");
	assert.equal(saved.outcome, "applied");
	assert.equal(saved.profile.expertise, stale);
	assert.notEqual(saved.profile.revision, initial.revision);
	assert.ok(instructions(request).includes("Verify current archive evidence."));
	const active = await a.raw<AgentProfile>(identity, "profile-read");
	assert.ok(active.requests.some((route) => route.requester === a.identity && route.replyTo === a.identity && route.status === "placed"));
	request.answer("FIRST_RESULT");
	await notice(a, "FIRST_RESULT");
	const duplicate = await send(a, "@archive-guide", "first-question");
	assert.equal(duplicate.deduped, true);
	assert.equal(duplicate.submissionId, first.submissionId);

	const compacting = a.raw(identity, "compact", { instructions: "Keep only: archive task complete. Omit the original task text and archive claim.", wait: true });
	request = await f.next();
	request.answer("Archive task complete. Read the saved profile before the next archive question.");
	const compacted = await compacting;
	assert.equal(compacted.status, "completed");
	const afterCompact = await a.raw<AgentProfile>(identity, "profile-read");
	assert.equal(afterCompact.revision, saved.profile.revision);
	assert.equal(afterCompact.expertise, stale);

	writeFileSync(f.source, "The current archive region is west. Verified 2026-01-02.\n");
	await send(a, identity, "source-correction");
	request = await f.next();
	assert.ok(instructions(request).includes(identity));
	assert.ok(!request.context.messages.some((item) => item.role === "user" && JSON.stringify(item).includes("Question first-question")), "compaction removes the earlier task text");
	request.tool("agent_compact", { instructions: "Retain only: check current archive evidence. Omit the original task text." });
	request = await f.next();
	request.answer("Check current archive evidence and retrieve the saved profile.");
	request = await f.next();
	assert.ok(!request.context.messages.some((item) => item.role === "user" && JSON.stringify(item).includes("Question source-correction")), "self-compaction removes the active task text");
	assert.ok(instructions(request).includes("source-correction"), "the current request ID survives outside the compacted input");
	request.tool("agent_profile", { action: "read" });
	request = await f.next();
	const retrieved = toolData<AgentProfile>(request, "agent_profile");
	assert.equal(retrieved.expertise, stale, "native profile retrieval survives compaction");
	assert.ok(retrieved.requests.some((route) => route.requestId.includes("source-correction") && route.requester === a.identity && route.replyTo === a.identity && route.status === "placed"));
	request.tool("read", { path: f.source });
	request = await f.next();
	assert.match(lastTool(request, "read").text, /region is west/u);
	const corrected = `Verified 2026-01-02: archive region is west. Source: ${f.source}. The earlier east claim is superseded.`;
	request.tool("agent_profile", { action: "update", expectedRevision: retrieved.revision, expertise: corrected });
	request = await f.next();
	const correctedProfile = toolData<Updated>(request, "agent_profile").profile;
	assert.equal(correctedProfile.expertise, corrected);
	request.answer("CORRECTED_RESULT: west, not the saved east claim.");
	await notice(a, "CORRECTED_RESULT");

	const requestsBeforeReset = f.requests.length;
	await a.raw(identity, "reset", { requestId: "empty-context" });
	const afterReset = await a.raw<AgentProfile>(identity, "profile-read");
	assert.equal(afterReset.identity, identity);
	assert.equal(afterReset.revision, correctedProfile.revision);
	assert.equal(afterReset.expertise, corrected);
	assert.deepEqual(afterReset.requests, [], "settled and reset routes are not current requests");
	assert.equal(f.requests.length, requestsBeforeReset, "reset and profile reads start no model request");
	await a.raw(identity, "observe-close", { token: observation.token });
	await a.call("release", { sessionId: identity });
	assert.equal(existsSync(hostPaths(metadata).claim), false);
	const cold = await a.control<AgentProfile>("profile-read", { sessionId: "@archive-guide" });
	assert.equal(cold.live, false);
	assert.equal(cold.revision, correctedProfile.revision);
	assert.equal(existsSync(hostPaths(metadata).claim), false, "cold profile read acquires no writer");
	assert.equal(f.requests.length, requestsBeforeReset);
	await a.close();
	const aRestarted = await f.requester(a.identity);
	assert.notEqual(aRestarted.process.pid, a.process.pid);

	const reused = await b.call<Spawned>("spawn", { handle: "archive-guide", name: "Do not rename", role: "Do not replace", model: "missing-provider/missing-model", thinkingLevel: "high", trust: true });
	assert.equal(reused.created, false);
	assert.equal(reused.sessionId, identity);
	assert.ok(reused.profile);
	assert.equal(reused.profile.name, "Archive guide");
	assert.equal(reused.profile.role, "Verify current archive evidence.");
	assert.equal(reused.profile.creator, a.identity);
	assert.deepEqual(reused.profile.model, created.profile.model);
	assert.equal(reused.profile.thinkingLevel, created.profile.thinkingLevel);
	assert.equal(reused.profile.revision, correctedProfile.revision);

	for (const [recipient, key] of [[b, "second-requester"], [c, "distinct-reply-recipient"]] as const) {
		await send(b, "@archive-guide", key, recipient.identity);
		request = await f.next();
		const prompt = JSON.stringify(request.context);
		assert.ok(instructions(request).includes(identity));
		assert.ok(instructions(request).includes("agent_profile"));
		assert.ok(!instructions(request).includes("first-question"));
		assert.ok(prompt.includes(b.identity));
		assert.ok(prompt.includes(recipient.identity));
		request.tool("agent_profile", { action: "read" });
		request = await f.next();
		const current = toolData<AgentProfile>(request, "agent_profile");
		assert.equal(current.expertise, corrected);
		assert.equal(current.requests.length, 1, "only the current request remains active");
		assert.ok(current.requests.some((route) => route.requestId.includes(key) && route.requester === b.identity && route.replyTo === recipient.identity));
		assert.ok(current.requests.every((route) => route.requester !== a.identity));
		request.tool("agent_send", { sessionId: recipient.identity, message: `INTERIM_${key}`, mode: "report" });
		request = await f.next();
		assert.equal(lastTool(request, "agent_send").isError, false, lastTool(request, "agent_send").text);
		request.answer(`FINAL_${key}`);
		await Promise.all([notice(recipient, `INTERIM_${key}`), notice(recipient, `FINAL_${key}`)]);
		await b.call("release", { sessionId: identity });
		assert.equal(occurrences(recipient, `INTERIM_${key}`), 1);
		assert.equal(occurrences(recipient, `FINAL_${key}`), 1);
		assert.equal(occurrences(a, key), 0);
		assert.equal(occurrences(aRestarted, key), 0, "the live creator receives neither report nor result");
		if (recipient === c) assert.equal(occurrences(b, key), 0, "requester and explicit reply recipient are different routes");
	}

	const persisted = await b.control<AgentProfile>("profile-read", { sessionId: identity });
	const update = { expectedRevision: persisted.revision, expertise: `${corrected}\nCommitted continuity checkpoint.`, requestId: "committed-profile-edit", senderIdentity: b.identity };
	await b.raw(identity, "observe-open", { scope: "conversation", token: randomUUID() });
	const committed = await b.raw<Updated>(identity, "profile-update", update);
	assert.equal(committed.outcome, "applied");
	const host = b.hosts.at(-1);
	assert.ok(host);
	await b.close();
	assert.equal(process.kill(host.pid, "SIGKILL"), true, "kill a live host after the update response confirms commit");
	const restarted = await f.requester(b.identity);
	await restarted.call("release", { sessionId: identity });
	const reopened = await restarted.raw<Updated>(identity, "profile-update", update);
	assert.equal(reopened.outcome, "applied");
	assert.equal(reopened.deduped, true);
	assert.equal(reopened.profile.revision, committed.profile.revision);
	assert.equal(reopened.profile.expertise, committed.profile.expertise);
	assert.notEqual(restarted.hosts.at(-1)?.pid, host.pid);
	const conflict = await restarted.raw<Updated>(identity, "profile-update", { expectedRevision: persisted.revision, role: "Stale overwrite", requestId: "stale-profile-edit", senderIdentity: b.identity });
	assert.equal(conflict.outcome, "conflict");
	assert.equal(conflict.profile.revision, committed.profile.revision);
	await assert.rejects(restarted.raw(identity, "profile-update", { ...update, expertise: "Changed retry payload" }), /request|payload|reuse|different/iu);
	await restarted.call("release", { sessionId: identity });
	assert.equal(occurrences(a, "FIRST_RESULT"), 1);
});

it("concurrent independent requesters resolve one handle without replacing creation defaults", { timeout: 120000 }, async (t) => {
	const f = await profileFixture(t);
	const [a, b] = await Promise.all([f.requester(), f.requester()]);
	const settled = await Promise.allSettled([a, b].map((requester, index) => requester.call<Spawned>("spawn", { handle: "shared-expert", name: `Expert ${index}`, role: `Charter ${index}`, trust: true })));
	const results = settled.map((result) => { assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : ""); return (result as PromiseFulfilledResult<Spawned>).value; });
	assert.equal(results[0].sessionId, results[1].sessionId);
	assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
	const winner = results.find((result) => result.created);
	assert.ok(winner?.profile);
	for (const result of results) {
		if (result.profile) {
			assert.equal(result.profile.name, winner.profile.name);
			assert.equal(result.profile.role, winner.profile.role);
			assert.equal(result.profile.creator, winner.profile.creator);
		} else {
			assert.equal(result.created, false);
			assert.equal(result.availability, "initializing");
			assert.equal(result.creation?.name, winner.profile.name);
			assert.equal(result.creation?.role, winner.profile.role);
		}
	}
	const retained = await b.control<AgentProfile>("profile-read", { sessionId: "@shared-expert" });
	assert.equal(retained.revision, winner.profile.revision);
	assert.equal(retained.creator, winner.profile.creator);
	assert.equal(new Set([...a.hosts, ...b.hosts].map((host) => host.pid)).size, 1, "concurrent resolve starts one writer");
	assert.equal(f.requests.length, 0, "resolve without prompt starts no model turn");
	const creator = winner.profile.creator === a.identity ? a : b;
	await creator.call("release", { sessionId: winner.sessionId });
});

it("keeps base operations usable across a feature-capability process boundary", { timeout: 120000 }, async (t) => {
	const f = await profileFixture(t);
	const a = await f.requester();
	const expert = await a.call<Spawned>("spawn", { handle: "contract-expert", name: "Contract expert", role: "Preserve base controls.", trust: true });
	const metadata = await a.call<HostMetadata>("metadata", { sessionId: expert.sessionId });
	const paths = hostPaths(metadata);
	const observation = await a.raw<{ token: string }>(expert.sessionId, "observe-open", { scope: "conversation", token: randomUUID() });
	assert.deepEqual(Object.keys(BASE_OPERATIONS), ["status", "submit", "reset", "list", "dashboard"]);
	for (const [method, contract] of Object.entries(BASE_OPERATIONS)) assert.deepEqual(HOST_CONTRACT.operations[method], contract, `${method} keeps its declared base contract`);
	const oldClient = await Client.connect({ serverId: paths.serverId, transportFactory: createUnixTransportFactory({ path: paths.socket }) });
	t.after(() => oldClient.dispose());
	const base = async (member: string, params: Record<string, unknown> = {}, contract = BASE_OPERATIONS[member]) => oldClient.request({ serverId: paths.serverId }, {
		serviceId: HOST_SERVICE_ID, member, args: [{ sessionId: expert.sessionId, ...params } as JsonValue, randomUUID(), contract as unknown as JsonValue],
	});
	await assert.rejects(base("configure", { name: "Rejected base rename" }, { request: "configure/1.0.0", response: "configure/1.0.0" }), /configure request contract configure\/1\.0\.0 differs from configure\/1\.2\.0.*no operation was admitted/u);
	const unchanged = await a.control<AgentProfile>("profile-read", { sessionId: expert.sessionId });
	assert.equal(unchanged.name, "Contract expert", "the refused base configure never changes native storage");
	const status = await base("status") as { conversation: { identity: string } };
	assert.equal(status.conversation.identity, expert.sessionId);
	await base("submit", { message: "Base task", requestId: "base-admission", ownerId: a.identity, origin: "operator" });
	let request = await f.next();
	assert.ok(instructions(request).includes(`"requester":"${a.identity}"`));
	assert.ok(instructions(request).includes(`"replyTo":"${a.identity}"`));
	assert.ok(request.context.messages.some((message) => message.role === "user" && message.content === "Base task"));
	request.tool("agent_send", { sessionId: a.identity, message: "BASE_PROGRESS", mode: "report" });
	request = await f.next();
	assert.equal(lastTool(request, "agent_send").isError, false);
	request.answer("BASE_RESULT");
	await Promise.all([notice(a, "BASE_RESULT"), notice(a, "BASE_PROGRESS")]);
	await a.control("configure", { sessionId: expert.sessionId, name: "Renamed contract expert" });
	await base("reset", { requestId: "base-reset" });
	await base("list");
	await base("dashboard");
	const after = await a.control<AgentProfile>("profile-read", { sessionId: expert.sessionId });
	assert.equal(after.name, "Renamed contract expert");
	assert.equal(after.handle, "@contract-expert");

	const proxyMetadata = { ...metadata, storageId: randomUUID(), storagePath: join(f.root, "base-contract.sqlite") };
	const proxy = fork(fileURLToPath(new URL("./profile-base-contract-fixture.mts", import.meta.url)), [JSON.stringify(proxyMetadata), JSON.stringify(metadata)], {
		cwd: f.cwd, env: { ...process.env, PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: join(f.root, "sessions") }, stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const forwarded = eventLog<string>();
	let stderr = "";
	proxy.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	t.after(async () => { if (proxy.connected) proxy.disconnect(); await waitForProcessExit(proxy); });
	await guarded(new Promise<void>((resolve, reject) => {
		proxy.on("message", (message: { event: string; method?: string }) => { if (message.event === "ready") resolve(); else if (message.method) forwarded.push(message.method); });
		proxy.once("error", reject);
		proxy.once("exit", () => reject(new Error(`Base contract fixture exited: ${stderr}`)));
	}), "base contract process readiness");
	const newClient = await connectHost(proxyMetadata, { retryAttempts: 0 });
	t.after(() => newClient.close());
	await newClient.request("status", { sessionId: expert.sessionId });
	for (const method of ["profile-read", "profile-update", "task-submit"]) await assert.rejects(newClient.request(method, { sessionId: expert.sessionId }), new RegExp(`does not advertise ${method}`, "u"));
	await assert.rejects(newClient.request("configure", { sessionId: expert.sessionId, name: "Rejected proxy rename" }), /does not advertise configure/u);
	assert.deepEqual(forwarded, ["status"], "unavailable feature requests, including configure, never dispatch to storage");
	await newClient.request("submit", { sessionId: expert.sessionId, message: "Unchanged client task", requestId: "base-only-admission", ownerId: a.identity, origin: "operator" });
	request = await f.next();
	assert.ok(instructions(request).includes("Renamed contract expert"), "current configure refreshes the next native self instructions across the base submit path");
	request.answer("BASE_ONLY_RESULT");
	await notice(a, "BASE_ONLY_RESULT");
	await newClient.request("reset", { sessionId: expert.sessionId, requestId: "base-only-reset" });
	await newClient.request("list");
	await newClient.request("dashboard");
	await newClient.request("status", { sessionId: expert.sessionId });
	await newClient.close();
	proxy.disconnect();
	await waitForProcessExit(proxy);
	await a.raw(expert.sessionId, "observe-close", { token: observation.token });
	await a.call("release", { sessionId: expert.sessionId });
});
