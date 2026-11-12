import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { initTheme, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { AgentCatalog } from "./catalog.ts";
import { startDurableDelivery } from "./durable-delivery.ts";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureModelId, fixtureProvider, fixtureRegistry, hostOptions, scriptedRuntime } from "./durable-host-fixture.mts";
import { modelFailureText, PROVIDER_BLOCK_ERROR, ProviderBlockFactSchema, providerBlockText, type ProviderBlockFact } from "./provider-block-facts.ts";
import { matchesSchema } from "./schema-check.ts";
import { eventLog } from "./host-fixture.mts";
import { parseHostMetadata } from "./host-protocol.ts";
import { createPrimaryChannel, type PrimaryDelivery } from "./primary-channel.ts";
import { safeProviderError } from "./primary-observation.ts";
import { renderAgentResult, renderInspectResult } from "./tool-cards.ts";

const timestamp = Date.parse("2026-10-11T01:02:03.000Z");
const target = "fixture-storage:2";
function fact(overrides: Partial<ProviderBlockFact> = {}): ProviderBlockFact {
	return { blockId: "retained-block", conversationId: 2, providerSessionId: "internal-provider-session", epoch: 0,
		model: { provider: "fixture-provider", modelId: "fixture-model" }, error: "usage limit reached; reset 2026-10-11 00:00",
		errorRedacted: false, errorTruncated: false, source: "provider", timestamp,
		originalResults: [{ sessionId: target, submissionId: 7, requestId: "original-request" }], omittedOriginalResults: 0, ...overrides };
}

it("presents content refusal with explicit recovery and leaves unknown wording as model_error", () => {
	const refusal = "This content was flagged for possible cybersecurity risk";
	assert.equal(modelFailureText("model_error", refusal), `content_refusal: ${refusal} The provider refused this content. Repeating the same task on this provider fails. Choose another explicit provider/model under your existing authority, or change the form of the task. No automatic substitution or host retry.`);
	assert.equal(modelFailureText("model_error", "Unknown request rejection"), "model_error: Unknown request rejection");
	assert.equal(modelFailureText("aborted", refusal), "aborted");
	assert.equal(modelFailureText("model_error", "usage limit reached", fact()), "model_error");
	assert.equal(modelFailureText("model_error", { message: refusal }), "model_error");
	assert.equal(modelFailureText("model_error", undefined), "model_error");
	assert.equal(modelFailureText("model_error", " \n"), "model_error");
});

it("fits long redacted failure text and recovery into the result communication reason bound", () => {
	for (const prefix of ["This content was flagged for possible cybersecurity risk", "Unknown request rejection"]) {
		const text = modelFailureText("model_error", `${prefix}; api_key=sk-abcdefghijklmnopqrstuv; ${"😀".repeat(1500)}`);
		assert.ok(Buffer.byteLength(text, "utf8") <= 1024);
		assert.ok(text.startsWith(prefix.startsWith("This content") ? "content_refusal: " : "model_error: "));
		assert.ok(text.includes("[credential redacted]")); assert.ok(text.includes("[truncated]"));
		assert.doesNotMatch(text, /abcdefghijkl/u);
		if (prefix.startsWith("This content")) assert.ok(text.endsWith("No automatic substitution or host retry."));
	}
	assert.equal(modelFailureText("model_error", "x".repeat(40000)), "model_error: [text unavailable: scan budget exceeded] [truncated]");
});

it("quotes zoneless and zoned provider times without conversion and uses the retained UTC receive time", () => {
	for (const time of ["2026-10-11 00:00", "2026-10-11T00:00:00+05:30", "2026-10-11 00:00 UTC"]) {
		const block = fact({ error: `usage limit reached; reset ${time}` });
		const before = structuredClone(block);
		const text = providerBlockText(block);
		assert.ok(text.includes(`Provider evidence: ${block.error}`));
		assert.ok(text.includes("Received at: 2026-10-11T01:02:03.000Z."));
		assert.ok(text.includes("A provider time without a stated zone has an unspecified zone."));
		assert.equal(providerBlockText(block), text);
		assert.equal(providerBlockText(structuredClone(block)), text);
		assert.deepEqual(block, before);
	}
});

it("distinguishes provider dispatch from a retained host refusal and gives the exact public recovery target", () => {
	const block = fact();
	const first = providerBlockText(block);
	const repeated = providerBlockText({ ...block, source: "host-block" });
	assert.equal(first, 'Agent host: quota exceeded; explicit recovery required. This call reached the provider. Received at: 2026-10-11T01:02:03.000Z. Provider evidence: usage limit reached; reset 2026-10-11 00:00 A provider time without a stated zone has an unspecified zone. Block retained-block. Target: fixture-storage:2. Choose an explicit provider/model under your existing authority, then call agent_configure({sessionId:"fixture-storage:2",model:<explicit provider/model>}). After successful configuration, send a new agent_send follow-up. Replaying the original request keeps its original settled result.');
	assert.equal(repeated, 'Agent host: quota exceeded; explicit recovery required. This call did not reach the provider; the host reused a retained block. Received at: 2026-10-11T01:02:03.000Z. Provider evidence: usage limit reached; reset 2026-10-11 00:00 A provider time without a stated zone has an unspecified zone. Block retained-block. Target: fixture-storage:2. Choose an explicit provider/model under your existing authority, then call agent_configure({sessionId:"fixture-storage:2",model:<explicit provider/model>}). After successful configuration, send a new agent_send follow-up. Replaying the original request keeps its original settled result.');
	assert.ok(first.startsWith(PROVIDER_BLOCK_ERROR)); assert.ok(repeated.startsWith(PROVIDER_BLOCK_ERROR));
	assert.ok(first.includes("This call reached the provider."));
	assert.ok(repeated.includes("This call did not reach the provider; the host reused a retained block."));
	for (const text of [first, repeated]) {
		assert.ok(text.includes(`Target: ${target}.`));
		assert.ok(text.includes(`agent_configure({sessionId:"${target}",model:<explicit provider/model>})`));
		assert.ok(text.includes("Choose an explicit provider/model under your existing authority"));
		assert.ok(text.includes("After successful configuration, send a new agent_send follow-up."));
		assert.ok(text.includes("Replaying the original request keeps its original settled result."));
		assert.doesNotMatch(text, /internal-provider-session/u);
	}
});

it("keeps safe evidence and its redaction and truncation markers without constructing unavailable evidence", () => {
	const safe = safeProviderError(`usage limit reached; api_key=sk-abcdefghijklmnopqrstuv; ${"x".repeat(5000)}`, 4096);
	const block = fact({ error: safe.text, errorRedacted: safe.redacted, errorTruncated: safe.truncated });
	const text = providerBlockText(block);
	assert.ok(text.includes(block.error)); assert.ok(text.includes("[credential redacted]")); assert.ok(text.includes("[truncated]"));
	assert.doesNotMatch(text, /abcdefghijkl/u);
	const unavailable = safeProviderError("x".repeat(40000));
	const missing = providerBlockText(fact({ error: unavailable.text, originalResults: [] }));
	assert.ok(missing.includes("Provider evidence: [text unavailable: scan budget exceeded]"));
	assert.ok(missing.includes("Recovery target unavailable: no retained original result identity."));
	assert.doesNotMatch(missing, /agent_configure\(/u);
});

it("renders the Date boundary and unavailable receive times without changing retained evidence", () => {
	const maximum = 8_640_000_000_000_000;
	assert.ok(providerBlockText(fact({ timestamp: maximum })).includes("Received at: +275760-09-13T00:00:00.000Z."));
	for (const value of [maximum + 1, Number.MAX_SAFE_INTEGER]) {
		const block = fact({ timestamp: value }); const before = structuredClone(block);
		assert.equal(matchesSchema(ProviderBlockFactSchema, block), true);
		assert.doesNotThrow(() => providerBlockText(block));
		assert.ok(providerBlockText(block).includes("This call reached the provider. Receive time unavailable. Provider evidence:"));
		assert.deepEqual(block, before);
	}
});

it("renders readable retained recovery facts in status output", () => {
	initTheme("dark", false);
	const theme = { fg: (_colour: string, value: string) => value, bg: (_colour: string, value: string) => value, getBgAnsi: () => "", bold: (value: string) => value } as unknown as Theme;
	for (const value of [timestamp, 8_640_000_000_000_000, 8_640_000_000_000_001, Number.MAX_SAFE_INTEGER]) {
		const block = fact({ timestamp: value }); const before = structuredClone(block);
		const details = { conversation: { conversationId: 2, identity: target, busy: false, providerBlock: block, agent: {}, usage: {}, submissions: [] } };
		const rendered = renderAgentResult({ content: [{ type: "text", text: JSON.stringify(details) }], details }, { expanded: true, isPartial: false }, theme, { keyText, args: {}, expanded: true, argsComplete: true, isError: false });
		const text = rendered.render(1200).map((line) => stripVTControlCharacters(line)).join("\n");
		assert.ok(text.includes("quota exceeded"));
		assert.ok(text.includes(value > 8_640_000_000_000_000 ? "Receive time unavailable." : new Date(value).toISOString()));
		assert.ok(text.includes(`agent_configure({sessionId:"${target}",model:<explicit provider/model>})`));
		assert.deepEqual(block, before);
	}
});

it("keeps saved-result recovery facts visible without changing inspection JSON", () => {
	initTheme("dark", false);
	const theme = { fg: (_colour: string, value: string) => value, bg: (_colour: string, value: string) => value, getBgAnsi: () => "", bold: (value: string) => value } as unknown as Theme;
	for (const source of ["provider", "host-block"] as const) for (const expanded of [false, true]) {
		const block = fact({ source, errorRedacted: true, errorTruncated: true });
		const details = { view: "result", sessionId: target, conversationId: 2, submissionId: 7, status: "unanswered", reason: "model_error", providerBlock: block };
		const result = { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		const before = structuredClone(result);
		const rendered = renderInspectResult(result, { expanded, isPartial: false }, theme, { keyText, args: { view: "result", submissionId: 7 }, expanded, argsComplete: true, isError: false });
		const text = rendered.render(expanded ? 1600 : 100).map(line => stripVTControlCharacters(line)).join("\n");
		assert.ok(text.includes("Received at: 2026-10-11T01:02:03.000Z."));
		assert.ok(text.includes("agent_configure"));
		assert.ok(text.includes("agent_send"));
		if (expanded) {
			assert.ok(text.includes(providerBlockText(block)));
			assert.ok(text.indexOf(providerBlockText(block)) < text.indexOf('{"view":'));
			assert.ok(text.includes("[credential redacted] [truncated]"));
		} else {
			assert.ok(text.includes(source === "provider" ? "Provider call refused." : "Retained host refusal."));
			assert.ok(text.includes("Recovery: explicit model"));
		}
		assert.deepEqual(result, before);
	}
});

it("shows unavailable receive time and recovery target in both saved-result card views", () => {
	initTheme("dark", false);
	const theme = { fg: (_colour: string, value: string) => value, bg: (_colour: string, value: string) => value, getBgAnsi: () => "", bold: (value: string) => value } as unknown as Theme;
	const block = fact({ timestamp: Number.MAX_SAFE_INTEGER, originalResults: [] });
	const details = { view: "result", status: "unanswered", providerBlock: block };
	for (const expanded of [false, true]) {
		const rendered = renderInspectResult({ content: [{ type: "text", text: JSON.stringify(details) }], details }, { expanded, isPartial: false }, theme, { keyText, args: {}, expanded, argsComplete: true, isError: false });
		const text = rendered.render(expanded ? 1600 : 100).map(line => stripVTControlCharacters(line)).join("\n");
		assert.ok(text.includes("Receive time unavailable."));
		assert.ok(text.includes("Recovery target unavailable"));
		assert.doesNotMatch(text, /agent_configure/u);
	}
});

it("does not construct recovery facts from an invalid saved-result provider block", () => {
	initTheme("dark", false);
	const theme = { fg: (_colour: string, value: string) => value, bg: (_colour: string, value: string) => value, getBgAnsi: () => "", bold: (value: string) => value } as unknown as Theme;
	const details = { view: "result", status: "unanswered", providerBlock: fact({ timestamp: -1 }) };
	for (const expanded of [false, true]) {
		const rendered = renderInspectResult({ content: [{ type: "text", text: JSON.stringify(details) }], details }, { expanded, isPartial: false }, theme, { keyText, args: {}, expanded, argsComplete: true, isError: false });
		const text = rendered.render(1600).map(line => stripVTControlCharacters(line)).join("\n");
		assert.ok(text.includes("Provider block unavailable: invalid native fact"));
		assert.doesNotMatch(text, /agent_configure/u);
	}
});

for (const receiveTime of [timestamp, 8_640_000_000_000_001, Number.MAX_SAFE_INTEGER]) it(`delivers separate recovery facts with ${receiveTime > 8_640_000_000_000_000 ? "unavailable" : "UTC"} receive time ${receiveTime} while terminal errors stay classification-safe`, async (t) => {
	const parent = await realpath(tmpdir());
	// A 28-byte canonical parent leaves 10 bytes for the root and 62 for the private primary socket.
	const root = await mkdtemp(join(Buffer.byteLength(parent) <= 28 ? parent : await realpath("/tmp"), "pb-"));
	const models = await scriptedRuntime([]);
	let calls = 0;
	models.streamSimple = () => {
		calls++;
		const stream = createAssistantMessageEventStream();
		const message = { ...answerMessage(), stopReason: "error" as const, errorMessage: "Weekly usage limit reached: token limit exceeded; reset 2026-10-11 00:00" };
		stream.push({ type: "error", reason: "error", error: message }); stream.end(); return stream;
	};
	const storagePath = join(root, "storage.sqlite"); const storageId = randomUUID(); const owner = randomUUID(); const sessionsRoot = join(root, "sessions");
	const metadata = parseHostMetadata({ storageId, storagePath, cwd: root, agentDir: join(root, "agent"), packageDir: root, model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
	const primaryDirectory = join(sessionsRoot, ".primaries");
	assert.ok(Buffer.byteLength(join(primaryDirectory, `${owner}.sock`)) <= 100, "fixture primary socket must remain in its private root");
	const host = await DurableHost.open({ ...hostOptions(storagePath, models, fixtureRegistry()), storageId, cwd: root, now: () => receiveTime, settings: { retry: { enabled: false } } }, BACKGROUND_CONTEXT);
	let channel: Awaited<ReturnType<typeof createPrimaryChannel>> | undefined;
	let delivery: ReturnType<typeof startDurableDelivery> | undefined;
	t.after(async () => { await delivery?.close(); await channel?.close(); await host.close(); await rm(root, { recursive: true, force: true }); });
	const received = eventLog<PrimaryDelivery>();
	channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot, deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	assert.ok(channel.socketPath.startsWith(`${primaryDirectory}/`));
	t.diagnostic(`Private primary socket: ${channel.socketPath}; storage: ${storagePath}`);
	delivery = startDurableDelivery({ host, metadata, catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal });
	const first = await host.submit({ message: "original task", requestId: "first-blocked", ownerId: owner, origin: "model" });
	const original = await host.wait(first.submissionId);
	assert.equal(original.status, "unanswered"); assert.ok(original.providerBlock);
	assert.equal(original.providerBlock.timestamp, receiveTime);
	const firstText = providerBlockText(original.providerBlock);
	if (receiveTime > 8_640_000_000_000_000) assert.ok(firstText.includes("Receive time unavailable."));
	const entry = (await host.root().entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0];
	const firstError = entry?.model?.[0]; assert.equal(firstError?.role, "assistant");
	assert.ok(firstError?.role === "assistant"); assert.equal(firstError.errorMessage, PROVIDER_BLOCK_ERROR);
	assert.equal(isContextOverflow(firstError), false); assert.equal(isRetryableAssistantError(firstError), false);
	await received.waitForCount(1); assert.ok(received[0].text.includes(firstText));
	const repeated = await host.submit({ message: "new blocked task", requestId: "repeated-blocked", ownerId: owner, origin: "model" });
	const refusal = await host.wait(repeated.submissionId);
	assert.equal(refusal.status, "unanswered"); assert.ok(refusal.providerBlock);
	assert.equal(refusal.providerBlock.source, "host-block"); assert.equal(original.providerBlock.source, "provider");
	assert.equal(refusal.providerBlock.timestamp, original.providerBlock.timestamp);
	assert.equal(refusal.providerBlock.error, original.providerBlock.error);
	const last = (await host.root().entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.model?.[0];
	assert.ok(last?.role === "assistant"); assert.equal(last.errorMessage, PROVIDER_BLOCK_ERROR);
	assert.equal(isContextOverflow(last), false); assert.equal(isRetryableAssistantError(last), false);
	await received.waitForCount(2); assert.ok(received[1].text.includes(providerBlockText(refusal.providerBlock)));
	assert.equal(calls, 1);
	assert.deepEqual(await host.wait(first.submissionId), original);
	assert.equal(providerBlockText(original.providerBlock), firstText);
});
