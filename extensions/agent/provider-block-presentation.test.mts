import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import { PROVIDER_BLOCK_ERROR, providerBlockText, type ProviderBlockFact } from "./provider-block-facts.ts";
import { eventLog } from "./host-fixture.mts";
import { parseHostMetadata } from "./host-protocol.ts";
import { createPrimaryChannel, type PrimaryDelivery } from "./primary-channel.ts";
import { safeProviderError } from "./primary-observation.ts";
import { renderAgentResult } from "./tool-cards.ts";

const timestamp = Date.parse("2026-10-11T01:02:03.000Z");
const target = "fixture-storage:2";
function fact(overrides: Partial<ProviderBlockFact> = {}): ProviderBlockFact {
	return { blockId: "retained-block", conversationId: 2, providerSessionId: "internal-provider-session", epoch: 0,
		model: { provider: "fixture-provider", modelId: "fixture-model" }, error: "usage limit reached; reset 2026-10-11 00:00",
		errorRedacted: false, errorTruncated: false, source: "provider", timestamp,
		originalResults: [{ sessionId: target, submissionId: 7, requestId: "original-request" }], omittedOriginalResults: 0, ...overrides };
}

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

it("renders readable retained recovery facts in status output", () => {
	initTheme("dark", false);
	const theme = { fg: (_colour: string, value: string) => value, bg: (_colour: string, value: string) => value, getBgAnsi: () => "", bold: (value: string) => value } as unknown as Theme;
	const block = fact();
	const details = { conversation: { conversationId: 2, identity: target, busy: false, providerBlock: block, agent: {}, usage: {}, submissions: [] } };
	const rendered = renderAgentResult({ content: [{ type: "text", text: JSON.stringify(details) }], details }, { expanded: true, isPartial: false }, theme, { keyText, args: {}, expanded: true, argsComplete: true, isError: false });
	const text = rendered.render(1200).map((line) => stripVTControlCharacters(line)).join("\n");
	assert.ok(text.includes("quota exceeded")); assert.ok(text.includes("2026-10-11T01:02:03.000Z"));
	assert.ok(text.includes(`agent_configure({sessionId:"${target}",model:<explicit provider/model>})`));
});

it("delivers separate recovery facts while terminal errors stay classification-safe without another provider call", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "provider-block-presentation-"));
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
	const host = await DurableHost.open({ ...hostOptions(storagePath, models, fixtureRegistry()), storageId, cwd: root, settings: { retry: { enabled: false } } }, BACKGROUND_CONTEXT);
	let channel: Awaited<ReturnType<typeof createPrimaryChannel>> | undefined;
	let delivery: ReturnType<typeof startDurableDelivery> | undefined;
	t.after(async () => { await delivery?.close(); await channel?.close(); await host.close(); await rm(root, { recursive: true, force: true }); });
	const received = eventLog<PrimaryDelivery>();
	channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot, deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	delivery = startDurableDelivery({ host, metadata, catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal });
	const first = await host.submit({ message: "original task", requestId: "first-blocked", ownerId: owner, origin: "model" });
	const original = await host.wait(first.submissionId);
	assert.equal(original.status, "unanswered"); assert.ok(original.providerBlock);
	const firstText = providerBlockText(original.providerBlock);
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
