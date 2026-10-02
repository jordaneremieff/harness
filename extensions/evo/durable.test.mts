import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MAX_DIRECTION_CODE_POINTS } from "./command.ts";
import {
	createEvoContribution,
	type DurableContribution,
	type DurableContributionHost,
	type DurableInventory,
} from "./durable.ts";
import { buildEvoKickoff } from "./kickoff.ts";
import { readPiReleaseIntake } from "./release.ts";

const HARNESS_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ENTRYPOINT = fileURLToPath(new URL("./index.ts", import.meta.url));

function inventoryFor(contribution: DurableContribution): DurableInventory {
	return {
		contributions: [
			{
				name: contribution.name,
				source: contribution.source,
				commands: (contribution.commands ?? []).map((command) => ({
					name: command.name,
					description: command.description,
				})),
			},
		],
		ordinaryOnly: [],
	};
}

function testHost(contribution: DurableContribution, cwd = "/workspace/current-project"): DurableContributionHost {
	return {
		durable: Durable,
		// The evo contribution reads no services fields.
		services: {} as AgentSessionServices,
		cwd,
		agentDir: "/workspace/agent",
		storageId: "evo-durable-test",
		signal: new AbortController().signal,
		inventory: inventoryFor(contribution),
	};
}

interface OpenHarness {
	harness: Durable.Harness;
	conversation: Durable.Conversation;
	host: DurableContributionHost;
}

async function openHarness(
	contribution: DurableContribution,
	conversationCwd: string | undefined,
	hostCwd = "/workspace/current-project",
): Promise<OpenHarness> {
	const host = testHost(contribution, hostCwd);
	const extension = await contribution.create(host);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("First answer."), fauxAssistantMessage("Second answer.")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	registry.install(extension);
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	const conversation = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: conversationCwd },
	});
	return { harness, conversation, host };
}

async function userTexts(conversation: Durable.Conversation): Promise<string[]> {
	const { messages } = await conversation.context(BACKGROUND_CONTEXT);
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return [message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")];
	});
}

test("the contribution offers the evo command and no model tools", async () => {
	const contribution = createEvoContribution({ source: ENTRYPOINT });
	assert.equal(contribution.name, "evo");
	assert.equal(contribution.source, ENTRYPOINT);
	assert.deepEqual(
		contribution.commands?.map((command) => command.name),
		["evo"],
	);
	const extension = await contribution.create(testHost(contribution));
	assert.equal(extension.name, "evo");
	assert.equal(extension.tools, undefined);
	assert.equal(extension.sections, undefined);
});

test("identical invocations submit separately and a retried invocation submits once", async () => {
	const contribution = createEvoContribution({ source: ENTRYPOINT });
	const command = contribution.commands?.find((entry) => entry.name === "evo");
	assert.ok(command);
	const { harness, conversation, host } = await openHarness(contribution, "/workspace/current-project");
	try {
		const release = await readPiReleaseIntake({ harnessRoot: HARNESS_ROOT });
		const expected = buildEvoKickoff({
			harnessRoot: HARNESS_ROOT,
			invocationCwd: "/workspace/current-project",
			direction: "Improve document explanations",
			release,
		});
		const first = await command.run({
			args: "Improve document explanations",
			conversation,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "evo-invocation-1",
		});
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.deepEqual(await userTexts(conversation), [expected]);

		const retry = await command.run({
			args: "Improve document explanations",
			conversation,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "evo-invocation-1",
		});
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(retry, first);
		assert.deepEqual(await userTexts(conversation), [expected]);

		const second = await command.run({
			args: "Improve document explanations",
			conversation,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "evo-invocation-2",
		});
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.notEqual(second, first);
		assert.deepEqual(await userTexts(conversation), [expected, expected]);

		const answers = (await conversation.context(BACKGROUND_CONTEXT)).messages.filter(
			(message) => message.role === "assistant",
		);
		assert.equal(answers.length, 2);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("the invocation workspace comes from the host, not the conversation agent cwd", async () => {
	const contribution = createEvoContribution({ source: ENTRYPOINT });
	const command = contribution.commands?.[0];
	assert.ok(command);
	const { harness, conversation, host } = await openHarness(
		contribution,
		"/workspace/conversation-project",
		"/workspace/host-project",
	);
	try {
		const release = await readPiReleaseIntake({ harnessRoot: HARNESS_ROOT });
		await command.run({
			args: "",
			conversation,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "evo-invocation-cwd",
		});
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.deepEqual(
			await userTexts(conversation),
			[buildEvoKickoff({ harnessRoot: HARNESS_ROOT, invocationCwd: "/workspace/host-project", release })],
		);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("an invalid direction is refused before any submission", async () => {
	const contribution = createEvoContribution({ source: ENTRYPOINT });
	const command = contribution.commands?.[0];
	assert.ok(command);
	const { harness, conversation, host } = await openHarness(contribution, "/workspace/current-project");
	try {
		await assert.rejects(
			command.run({
				args: "x".repeat(MAX_DIRECTION_CODE_POINTS + 1),
				conversation,
				context: BACKGROUND_CONTEXT,
				host,
				invocationId: "evo-invocation-invalid",
			}),
			/Unicode code points or fewer/,
		);
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.deepEqual(await userTexts(conversation), []);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});
