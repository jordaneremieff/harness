/** Production host regressions through the native OpenAI-compatible HTTP adapter. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { acquireHost, waitForHostRelease, type HostConnection } from "./host-client.ts";
import { hostPaths } from "./host-protocol.ts";
import { observeClaim, readClaimFile } from "./claims.ts";
import { eventLog } from "./host-fixture.mts";
import { createPrimaryChannel, type PrimaryDelivery } from "./primary-channel.ts";
import type { ProviderBlockFact } from "./provider-block-facts.ts";
import { runtimeFixture, trackHost, waitForReceipt, type RuntimeFixture } from "./durable-runtime-fixture.mts";

interface Submission { submissionId: number; deduped: boolean }
interface Result { status: string; reason?: string; entryId?: number; answerEntryId?: number; answer?: string; providerBlock?: ProviderBlockFact }
interface WireRequest { response: ServerResponse; at: number; body: { model?: string; stream?: boolean }; }

async function endpoint(t: TestContext) {
	const requests = eventLog<WireRequest>();
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			assert.equal(request.url, "/chat/completions");
			assert.equal(request.headers.authorization, "Bearer synthetic-runtime-fixture");
			requests.push({ response, at: Date.now(), body: JSON.parse(body) as WireRequest["body"] });
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
	const address = server.address(); assert.ok(address && typeof address === "object");
	return { requests, url: `http://127.0.0.1:${address.port}` };
}

function fail(request: WireRequest, error: object): number {
	request.response.writeHead(429, { "content-type": "application/json", "retry-after": "300" });
	request.response.end(JSON.stringify({ error }));
	return Date.now();
}
function succeed(request: WireRequest): void {
	request.response.writeHead(200, { "content-type": "text/event-stream" });
	request.response.end(`data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture-http-model", choices: [{ index: 0, delta: { role: "assistant", content: "RECOVERED_HTTP_ANSWER" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture-response", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}

function fixture(t: TestContext, url: string, retryDelayMs?: number): RuntimeFixture {
	return runtimeFixture(t, { withAgentExtension: true, retry: true, httpEndpoint: url, retryDelayMs, ...(process.env.DURABLE_TEST_PACKAGE_DIR === undefined ? {} : { packageDir: process.env.DURABLE_TEST_PACKAGE_DIR }) });
}
function loadProof(t: TestContext, f: RuntimeFixture, pid: number): { httpIdleTimeoutMs: number } {
	const proof = JSON.parse(readFileSync(join(f.testDir, `load-proof-${pid}.json`), "utf8"));
	assert.equal(proof.modelRuntime, true, "the host loaded the selected installation's ModelRuntime");
	assert.equal(proof.packageDir, f.metadata.packageDir);
	assert.equal(proof.providerRetry.maxRetries, undefined, "provider retries remain optional, not overridden");
	assert.equal(proof.providerRetry.timeoutMs, undefined, "the fixture introduces no transport timeout");
	assert.match(proof.piAiEntry, /pi-ai\/dist\/[a-z-]+\.js$/u);
	assert.equal(proof.piAi, proof.codingAgent);
	assert.match(proof.durableEntry, /pi-durable\/dist\/index\.js$/u);
	t.diagnostic(`runtime load proof ${JSON.stringify(proof)}`);
	return proof as { httpIdleTimeoutMs: number };
}
function exposed(f: RuntimeFixture): { at: number; error: string } {
	const rows = readFileSync(join(f.testDir, "exposed-errors.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { at: number; error: string; provider: string });
	const found = rows.find((row) => row.provider === "durable-runtime-http"); assert.ok(found); return found;
}
interface Checkpoint { at: number; type: string; submission?: { id: number; status: string; reason?: string }; generation?: { attempt: number; retry: { error: string } }; entry?: unknown }
function checkpoints(f: RuntimeFixture): Checkpoint[] {
	return readFileSync(join(f.testDir, "native-checkpoints.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Checkpoint);
}
async function result(host: HostConnection, submissionId: number): Promise<Result> {
	return await host.request("inspect", { view: "result", submissionId }) as Result;
}
/** Read only in response to public committed-change events, including the initial snapshot. */
async function committed<T>(t: TestContext, host: HostConnection, read: () => Promise<T>, predicate: (value: T) => boolean): Promise<{ at: number; value: T }> {
	const events = eventLog<{ at: number; value: T }>();
	assert.ok(host.subscribeChanges);
	const signal = AbortSignal.timeout(15000);
	const capture = () => { void read().then((value) => events.push({ at: Date.now(), value }), () => {}); };
	const unsubscribe = await host.subscribeChanges(capture, signal); t.after(unsubscribe);
	capture();
	await events.waitFor((rows) => rows.some((row) => predicate(row.value)), 15000).catch((error: unknown) => { throw new Error(`${String(error)}; latest committed value=${JSON.stringify(events.at(-1)?.value ?? null).slice(0, 8000)}`); });
	unsubscribe();
	const found = events.find((row) => predicate(row.value)); assert.ok(found); return found;
}
/** The committed provider retry of a conversation, read from its status. */
function retrying(t: TestContext, host: HostConnection, sessionId: string) {
	return committed(t, host, () => host.request("status", { sessionId }), (value) => (value as { conversation?: { live?: { generation?: { retry?: unknown } } | null } }).conversation?.live?.generation?.retry !== undefined);
}
/**
 * The settled result of an input. The delivery driver acknowledges a receipt whose owner is a live primary in the
 * commit round of the run end, so an unacknowledged receipt is not a stable event to wait for.
 */
async function settled(t: TestContext, host: HostConnection, submissionId: number): Promise<Result> {
	return (await committed(t, host, () => result(host, submissionId), (row) => row.status === "done" || row.status === "unanswered")).value;
}
async function requester(t: TestContext, f: RuntimeFixture) {
	const owner = randomUUID();
	const notices = eventLog<{ at: number; message: PrimaryDelivery }>();
	const channel = await createPrimaryChannel({ id: owner, cwd: f.cwd, sessionsRoot: f.root, deliver: (message) => { notices.push({ at: Date.now(), message }); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	return { owner, notices };
}
const limits = [
	{ name: "1308 usage", error: { code: "1308", message: "Usage limit reached for 5 hour. Your limit will reset at 2030-01-01 19:35:19" } },
	{ name: "1310 subscription", error: { code: "1310", message: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2030-01-01 20:14:57" } },
	{ name: "generic account", error: { code: "account_limit", message: "Account balance exhausted; billing credits depleted" } },
	{ name: "insufficient quota", error: { code: "insufficient_quota", message: "You exceeded your current quota; check billing" } },
];
for (const limit of limits) it(`stops ${limit.name} through the real adapter and notifies the requester`, { timeout: 60000 }, async (t) => {
	const http = await endpoint(t); const f = fixture(t, http.url); const { owner, notices } = await requester(t, f);
	const host = await acquireHost(f.metadata, { env: f.env("answer") }); trackHost(t, host.pid);
	try {
		const proof = loadProof(t, f, host.pid);
		const admitted = await host.request("submit", { message: "Synthetic exhausted request", requestId: "quota-request", ownerId: owner, origin: "model" }) as Submission;
		await http.requests.waitForCount(1);
		const terminal = committed(t, host, () => result(host, admitted.submissionId), (row) => row.status === "unanswered");
		const sentAt = fail(http.requests[0], limit.error);
		const settled = await terminal;
		await f.marker("error-exposed");
		await notices.waitForCount(1);
		await host.request("acknowledge", { ownerId: owner, submissionIds: [admitted.submissionId] });
		const undelivered = await host.request("receipts", { ownerId: owner, wait: false }) as { receipts: { submissionId: number }[] };
		assert.equal(undelivered.receipts.some((row) => row.submissionId === admitted.submissionId), false, "accepted delivery is no longer in the undelivered stream");
		const selected = await host.request("receipts", { ownerId: owner, result: { sessionId: f.metadata.storageId, submissionId: admitted.submissionId, requestId: "quota-request" } }) as { outcome: Result };
		const outcome = selected.outcome;
		assert.equal(outcome.status, "unanswered"); assert.equal(outcome.reason, "model_error"); assert.equal(outcome.answerEntryId, undefined);
		assert.ok(outcome.providerBlock); assert.equal(outcome.providerBlock.source, "provider");
		assert.ok(outcome.providerBlock.error.includes(limit.error.message), "the block retains provider evidence, including a reset with no assumed timezone");
		assert.equal(outcome.providerBlock.errorRedacted, false); assert.equal(outcome.providerBlock.errorTruncated, false);
		assert.equal(outcome.providerBlock.originalResults[0].submissionId, admitted.submissionId);
		assert.equal(settled.value.reason, "model_error"); assert.equal(settled.value.answerEntryId, undefined); assert.equal(settled.value.answer, undefined);
		assert.equal(http.requests.length, 1, "quota and long Retry-After never enter another HTTP attempt");
		assert.equal(http.requests[0].body.model, "fixture-http-model"); assert.equal(http.requests[0].body.stream, true);
		const forwarded = JSON.parse(readFileSync(join(f.testDir, "http-options.jsonl"), "utf8").trim().split("\n")[0]);
		assert.deepEqual(forwarded, { transport: "auto", maxRetries: null, timeoutMs: proof.httpIdleTimeoutMs === 0 ? 2147483647 : proof.httpIdleTimeoutMs, maxRetryDelayMs: 60000 }, "the actual ModelRuntime boundary preserves optional transport settings");
		const error = exposed(f); assert.match(error.error, new RegExp(limit.error.code, "u"));
		const terminalCommit = checkpoints(f).find((row) => row.type === "terminal" && row.submission?.id === admitted.submissionId); assert.ok(terminalCommit);
		const assistant = checkpoints(f).find((row) => row.type === "assistant"); assert.ok(assistant);
		assert.match(JSON.stringify(assistant.entry), /Agent host: quota exceeded; explicit recovery required/u, "native classification receives the canonical nonretryable error");
		assert.equal(checkpoints(f).some((row) => row.type === "retry"), false);
		assert.ok(terminalCommit.at - error.at < 5000); assert.ok(notices[0].at - error.at < 5000);
		t.diagnostic(`latency ms ${JSON.stringify({ wireResponseToExposure: error.at - sentAt, exposureToTerminalCommit: terminalCommit.at - error.at, exposureToTerminalObservation: settled.at - error.at, exposureToRequesterNotification: notices[0].at - error.at })}`);
	} finally { await host.close().catch(() => {}); }
});

it("keeps a requester silent during an active unknown native retry", { timeout: 60000 }, async (t) => {
	const http = await endpoint(t); const f = fixture(t, http.url); const { owner, notices } = await requester(t, f);
	const host = await acquireHost(f.metadata, { env: f.env("answer") }); trackHost(t, host.pid);
	try {
		const admitted = await host.request("submit", { message: "No-await unknown transient request", requestId: "no-await-retry", ownerId: owner, origin: "model" }) as Submission;
		await http.requests.waitForCount(1);
		const retry = retrying(t, host, f.metadata.storageId);
		fail(http.requests[0], { code: "unfamiliar_overload", message: "Temporary request throttling; retry this request" });
		await retry;
		assert.equal(notices.length, 0, "an active retry burst does not send a preterminal report");
		assert.equal((await result(host, admitted.submissionId)).status, "placed");
		const status = await host.request("status", { sessionId: f.metadata.storageId }) as { conversation: { providerBlock?: ProviderBlockFact } };
		assert.equal(status.conversation.providerBlock, undefined, "unrecognized throttling is not exhaustion");
		assert.equal(http.requests.length, 1);
		await host.request("abort", {});
	} finally { await host.close().catch(() => {}); }
});

it("keeps ordinary transient 429 recovery in Durable, outside the HTTP adapter", { timeout: 60000 }, async (t) => {
	const http = await endpoint(t); const f = fixture(t, http.url, 2000);
	const host = await acquireHost(f.metadata, { env: f.env("answer") }); trackHost(t, host.pid);
	try {
		const admitted = await host.request("submit", { message: "Transient then success", requestId: "transient-success", ownerId: f.ownerId, origin: "operator" }) as Submission;
		await http.requests.waitForCount(1);
		const retry = retrying(t, host, f.metadata.storageId);
		fail(http.requests[0], { code: "rate_limit_exceeded", message: "Too many requests; try again" });
		const retried = await retry;
		await http.requests.waitForCount(2, 10000);
		assert.ok(retried.at <= http.requests[1].at, "the native retry commit precedes the second HTTP attempt");
		succeed(http.requests[1]);
		const receipt = await waitForReceipt(host, f.ownerId, admitted.submissionId, 10000); assert.equal(receipt.status, "done"); assert.equal(receipt.answer, "RECOVERED_HTTP_ANSWER");
		assert.equal(http.requests.length, 2);
	} finally { await host.close().catch(() => {}); }
});

it("retains immutable blocked results across restart, deduplicates notices, and recovers with a new same-model reference", { timeout: 120000 }, async (t) => {
	const http = await endpoint(t); const f = fixture(t, http.url); const { owner, notices } = await requester(t, f);
	let host = await acquireHost(f.metadata, { env: f.env("answer") }); trackHost(t, host.pid);
	try {
		const admitted = await host.request("submit", { message: "Preserve original quota result", requestId: "retained-block", ownerId: owner, origin: "model" }) as Submission;
		await http.requests.waitForCount(1); fail(http.requests[0], limits[0].error);
		await settled(t, host, admitted.submissionId); await notices.waitForCount(1);
		await committed(t, host, () => host.request("receipts", { ownerId: owner }), (value) => (value as { receipts: unknown[] }).receipts.length === 0);
		const before = await result(host, admitted.submissionId); assert.equal(before.status, "unanswered");
		assert.ok(before.providerBlock);
		const blockId = before.providerBlock.blockId;
		const blockedAgain = await host.request("submit", { message: "Do not bypass the retained provider block", requestId: "before-explicit-recovery", ownerId: owner, origin: "model" }) as Submission;
		const blockedReceipt = await settled(t, host, blockedAgain.submissionId);
		assert.equal(blockedReceipt.status, "unanswered"); assert.equal(blockedReceipt.reason, "model_error");
		assert.equal(blockedReceipt.providerBlock?.source, "host-block"); assert.equal(blockedReceipt.providerBlock?.blockId, blockId);
		assert.equal(http.requests.length, 1, "a new input cannot bypass the retained provider block");
		await notices.waitForCount(2);
		await committed(t, host, () => host.request("receipts", { ownerId: owner }), (value) => (value as { receipts: unknown[] }).receipts.length === 0);
		const originalNotifications = notices.map((item) => item.message.sourceId);
		const previousPid = host.pid;
		const paths = hostPaths(f.metadata);
		const initialClaim = readClaimFile(paths.claim);
		const initialRecord = initialClaim.claim as { token: string; endedAt?: string };
		assert.equal(typeof initialRecord.token, "string");
		assert.equal(initialRecord.endedAt, undefined);
		await waitForHostRelease(f.metadata, { after: host.request("close"), signal: AbortSignal.timeout(10000) });
		await host.close();
		const ended = observeClaim(paths.claim, paths.identity);
		assert.ok(ended.kind === "dead");
		assert.equal(ended.writerId, initialRecord.token);
		assert.ok(ended.endedAt);
		const endedClaim = readClaimFile(paths.claim);
		assert.equal(endedClaim.dev, initialClaim.dev);
		assert.equal(endedClaim.ino, initialClaim.ino);
		host = await acquireHost(f.metadata, { env: f.env("answer") }); trackHost(t, host.pid);
		assert.notEqual(host.pid, previousPid);
		const reopenedClaim = readClaimFile(paths.claim);
		const reopenedRecord = reopenedClaim.claim as { token: string; endedAt?: string };
		assert.equal(reopenedClaim.dev, initialClaim.dev);
		assert.equal(reopenedClaim.ino, initialClaim.ino);
		assert.equal(typeof reopenedRecord.token, "string");
		assert.notEqual(reopenedRecord.token, initialRecord.token);
		assert.equal(reopenedRecord.endedAt, undefined);
		assert.equal((await result(host, admitted.submissionId)).entryId, before.entryId);
		const duplicate = await host.request("submit", { message: "Preserve original quota result", requestId: "retained-block", ownerId: owner, origin: "model" }) as Submission;
		assert.equal(duplicate.submissionId, admitted.submissionId); assert.equal(duplicate.deduped, true);
		const unavailable = await host.request("configure", { model: "unconfigured-fixture/missing" }) as { outcome: string };
		assert.equal(unavailable.outcome, "failed", "unavailable configuration does not clear the block");
		assert.equal((await result(host, admitted.submissionId)).status, "unanswered");
		const afterFailure = await host.request("status", { sessionId: f.metadata.storageId }) as { conversation: { providerBlock?: ProviderBlockFact } };
		assert.equal(afterFailure.conversation.providerBlock?.blockId, blockId);
		await host.request("configure", { name: "Retained block name" });
		const afterName = await host.request("status", { sessionId: f.metadata.storageId }) as { conversation: { providerBlock?: ProviderBlockFact } };
		assert.equal(afterName.conversation.providerBlock?.blockId, blockId, "a name change is not recovery");
		const configured = await host.request("configure", { model: "durable-runtime-http/fixture-http-model", requestId: "deliberate-same-model" }) as { outcome?: string };
		assert.notEqual(configured.outcome, "failed");
		const recovered = await host.request("submit", { message: "Deliberate recovery request", requestId: "new-recovery-reference", ownerId: owner, origin: "model" }) as Submission;
		assert.notEqual(recovered.submissionId, admitted.submissionId);
		await http.requests.waitForCount(2, 10000); succeed(http.requests[1]);
		const receipt = await settled(t, host, recovered.submissionId); assert.equal(receipt.status, "done"); assert.equal(receipt.answer, "RECOVERED_HTTP_ANSWER");
		const retained = await result(host, admitted.submissionId); assert.equal(retained.status, "unanswered"); assert.equal(retained.reason, "model_error"); assert.equal(retained.answerEntryId, undefined); assert.equal(retained.providerBlock?.blockId, blockId);
		assert.equal(http.requests.length, 2);
		await notices.waitForCount(originalNotifications.length + 1);
		assert.equal(new Set(notices.map((item) => item.message.sourceId)).size, notices.length, "acknowledged source IDs never produce duplicate notices after restart");
		for (const sourceId of originalNotifications) assert.equal(notices.filter((item) => item.message.sourceId === sourceId).length, 1);
		assert.ok(readdirSync(f.testDir).filter((name) => name.startsWith("load-proof-")).length >= 2);
	} catch (error) {
		let receipts: unknown;
		try { receipts = await host.request("receipts", { ownerId: owner }); }
		catch (diagnosticError) {
			t.diagnostic(`Receipt diagnostics unavailable: ${String(diagnosticError)}`);
			throw error;
		}
		throw new Error(`${String(error)}; notices=${JSON.stringify(notices).slice(0, 12000)}; receipts=${JSON.stringify(receipts).slice(0, 12000)}`, { cause: error });
	} finally { await host.close().catch(() => {}); }
});
