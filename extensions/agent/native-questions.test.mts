import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import { nativeContinuityText } from "./continuity-facts.ts";
import { DurableHost } from "./durable-host.ts";
import { runtimeFixture, trackHost } from "./durable-runtime-fixture.mts";
import { fixtureRegistry, fixtureRuntime, hostOptions } from "./durable-host-fixture.mts";
import { acquireHost } from "./host-client.ts";
import { AgentManager } from "./manager.ts";
import {
	NATIVE_QUESTIONS_FULL,
	openNativeQuestions,
	releaseNativeQuestion,
	reserveNativeQuestion,
} from "./native-questions.ts";
import { DURABLE_TARGET_QUESTION, MAX_OPEN_QUESTIONS, noticeText } from "./peer-questions.ts";

const ROOT = ROOT_CONVERSATION_ID as ConversationId;
const context = BACKGROUND_CONTEXT;

it("keeps a Durable asker's open questions in its storage, closes them only from the asked session, and keeps them after reopen", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "native-questions-"));
	const storageId = randomUUID();
	const options = {
		...hostOptions(join(root, "host.sqlite"), await fixtureRuntime("answer"), fixtureRegistry()),
		storageId,
	};
	let host = await DurableHost.open(options, context);
	t.after(async () => {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	});
	const primary = randomUUID();
	const other = randomUUID();
	const ask = (id: string, peer = primary) =>
		host.harness.commit(
			(tx) => reserveNativeQuestion(tx, ROOT, { id, peer, message: "Are retries idempotent?", at: 1 }),
			context,
		);
	const open = () => host.harness.commit((tx) => openNativeQuestions(tx, ROOT), context);
	const arrive = (requestId: string, sender: string) =>
		host.request(
			"submit",
			{
				sessionId: storageId,
				message: `Report from ${sender}:\nAnswer`,
				requestId,
				inputClass: "report",
				inputSender: sender,
				origin: "model",
			},
			context,
		);

	assert.equal(await ask(`question:${storageId}:1`), "reserved");
	assert.equal(await ask(`question:${storageId}:1`), "known", "a replayed ask reserves nothing new");
	assert.equal(await ask(`question:${storageId}:2`), "reserved");
	assert.equal(await ask(`question:${storageId}:3`), "reserved");

	await arrive(`reply:question:${storageId}:1`, other);
	assert.equal((await open()).length, 3, "a reply from another session closes nothing");
	await arrive(`reply:question:${storageId}:1`, primary);
	await arrive(`notice:question:${storageId}:2`, primary);
	assert.deepEqual(
		(await open()).map((item) => item.id),
		[`question:${storageId}:3`],
	);
	assert.equal(await ask(`question:${storageId}:1`), "known", "a replayed ask cannot reopen an answered question");
	await host.harness.commit((tx) => releaseNativeQuestion(tx, ROOT, `question:${storageId}:3`), context);
	assert.equal((await open()).length, 0);

	for (let index = 0; index < MAX_OPEN_QUESTIONS; index++) await ask(`question:${storageId}:full-${index}`);
	await assert.rejects(ask(`question:${storageId}:one-more`), { message: NATIVE_QUESTIONS_FULL });

	await host.close();
	host = await DurableHost.open(options, context);
	const retained = await open();
	assert.equal(retained.length, MAX_OPEN_QUESTIONS, "open questions survive a reopen");
	assert.deepEqual(retained[0], {
		id: `question:${storageId}:full-0`,
		peer: primary,
		at: 1,
		excerpt: "Are retries idempotent?",
	});
	const note = nativeContinuityText(storageId, 9, [], { headId: 9, items: [] }, retained.slice(0, 1));
	assert.match(
		note,
		new RegExp(
			`no reply or non-reply notice here: \\n\\{"sessionId":"${primary}","question":"question:${storageId}:full-0"\\}`,
			"u",
		),
	);
	assert.doesNotMatch(nativeContinuityText(storageId, 9, [], { headId: 9, items: [] }, []), /Questions this session/u);
});

it("delivers a Durable agent's question to an ordinary primary and returns its reply and non-reply notice as reports", {
	timeout: 180000,
}, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const manager = new AgentManager({
		root: f.root,
		agentDir: f.agentDir,
		packageDir: f.metadata.packageDir,
		acquire: async (metadata, options) => {
			const client = await acquireHost(metadata, { ...options, env: f.env("question") });
			trackHost(t, client.pid);
			return client;
		},
	});
	t.after(() => manager.close());
	const primary = randomUUID();
	const controller = new AbortController();
	t.after(() => controller.abort());
	const questions: Array<{ text: string; details: Record<string, unknown> }> = [];
	let delivered: () => void = () => {};
	await manager.registerPrimary(primary, {
		cwd: f.cwd,
		signal: controller.signal,
		send(text, details) {
			const value = details as Record<string, unknown>;
			if (value.kind === "report" && String(value.requestId).startsWith("question:")) {
				questions.push({ text, details: value });
				delivered();
			}
		},
	});
	const nextQuestion = () =>
		new Promise<void>((resolve) => {
			delivered = resolve;
		});
	const asker = f.metadata.storageId;
	const caller = { id: primary, cwd: f.cwd, name: "Docs" };

	let arrived = nextQuestion();
	const asked = f.marker("question-asked");
	await manager.control(
		"submit",
		{ sessionId: asker, message: `QUESTION_TO:${primary}`, requestId: "ask-1", origin: "model" },
		caller,
	);
	await asked;
	await arrived;
	const first = questions[0];
	const id = String(first.details.requestId);
	assert.match(id, new RegExp(`^question:${asker}:`, "u"));
	assert.equal(first.details.senderIdentity, asker);
	assert.match(
		String(first.details.message),
		new RegExp(
			`^Are retries idempotent\\?\\n\\nReply expected\\. Session ${asker} asked this question \\(${id}\\)`,
			"u",
		),
	);
	const receipt = JSON.parse(readFileSync(join(f.testDir, "question-returns.jsonl"), "utf8").trim()) as {
		content: Array<{ text: string }>;
	};
	assert.match(receipt.content[0].text, /agent_work continue with that request and an empty results list/u);

	const replied = f.marker("question-reply");
	await manager.control(
		"submit",
		{ sessionId: asker, message: "Yes, they reuse the key.", inReplyTo: id, origin: "model" },
		caller,
	);
	await replied;

	arrived = nextQuestion();
	const askedAgain = f.marker("question-asked");
	await manager.control(
		"submit",
		{ sessionId: asker, message: `QUESTION_TO:${primary}`, requestId: "ask-2", origin: "model" },
		caller,
	);
	await askedAgain;
	await arrived;
	const second = String(questions[1].details.requestId);
	assert.notEqual(second, id);
	const noticed = f.marker("question-notice");
	await manager.control(
		"report",
		{
			sessionId: asker,
			requestId: `notice:${second}`,
			message: noticeText({ id: second, peer: asker, at: 0, excerpt: "Are retries idempotent?" }, primary, "Docs"),
			questionNotice: second,
			origin: "model",
		},
		caller,
	);
	await noticed;
	const arrivals = readFileSync(join(f.testDir, "question-arrivals.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { arrival: string; text: string });
	assert.deepEqual(
		arrivals.map((item) => item.arrival),
		["question-reply", "question-notice"],
	);
	assert.match(
		arrivals[0].text,
		new RegExp(
			`Reply from session ${primary} \\("Docs"\\) to the question you asked \\(${id}\\):\\n\\nYes, they reuse the key\\.`,
			"u",
		),
	);

	await assert.rejects(
		manager.control("submit", { sessionId: asker, message: "Ready?", expectReply: true, origin: "model" }, caller),
		{ message: DURABLE_TARGET_QUESTION },
	);
});
