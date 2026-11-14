import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentSessionServices, getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
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
import { distTagsUrl, PI_HOST_PACKAGE, PI_PUBLICATION_DEADLINE_MS, readPiReleaseIntake } from "./release.ts";
import { controlledRegistry, nextPatch, observedTimes, withoutObservedTimes } from "./release-fixture.mts";

const HARNESS_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ENTRYPOINT = fileURLToPath(new URL("./index.ts", import.meta.url));

// The command reads published versions; offline mode keeps tests without a controlled registry off the network.
process.env.PI_OFFLINE = "1";

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

async function normalizedUserTexts(conversation: Durable.Conversation): Promise<string[]> {
	return (await userTexts(conversation)).map(withoutObservedTimes);
}

function gitShow(revision: string): string {
	return execFileSync("git", ["-C", HARNESS_ROOT, "show", revision], { encoding: "utf8", maxBuffer: 4_000_000 });
}

/** The declared Pi packages and their resolved versions, read independently from local main. */
function mainCheckout() {
	const commit = execFileSync("git", ["-C", HARNESS_ROOT, "rev-parse", "refs/heads/main^{commit}"], { encoding: "utf8" }).trim();
	const manifest = JSON.parse(gitShow(`${commit}:package.json`));
	const lockfile = JSON.parse(gitShow(`${commit}:package-lock.json`));
	const marker = /<!-- pi-release-reviewed-through: (\S+) -->/.exec(gitShow(`${commit}:docs/pi-durable-harness.md`))?.[1];
	const declared = [
		...Object.entries(manifest.dependencies ?? {}).map(([name, range]) => ({ name, relation: "dependency", range })),
		...Object.entries(manifest.peerDependencies ?? {}).map(([name, range]) => ({ name, relation: "peer", range })),
	]
		.filter((entry) => entry.name.startsWith("@earendil-works/"))
		.map((entry) => ({ ...entry, version: lockfile.packages[`node_modules/${entry.name}`]?.version as string }));
	return { commit, marker, declared };
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
			origin: "operator",
			direction: "Improve document explanations",
			release,
		});
		const first = await command.run({
			args: "Improve document explanations",
			origin: "operator",
			conversation,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "evo-invocation-1",
		});
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.deepEqual(await normalizedUserTexts(conversation), [withoutObservedTimes(expected)]);

		const retry = await command.run({
			args: "Improve document explanations",
			origin: "operator",
			conversation,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "evo-invocation-1",
		});
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(retry, first);
		assert.deepEqual(await normalizedUserTexts(conversation), [withoutObservedTimes(expected)]);

		const second = await command.run({
			args: "Improve document explanations",
			origin: "operator",
			conversation,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "evo-invocation-2",
		});
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.notEqual(second, first);
		assert.deepEqual(await normalizedUserTexts(conversation), [expected, expected].map(withoutObservedTimes));

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
			origin: "operator",
			conversation,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "evo-invocation-cwd",
		});
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.deepEqual(await normalizedUserTexts(conversation), [
			withoutObservedTimes(
				buildEvoKickoff({ harnessRoot: HARNESS_ROOT, invocationCwd: "/workspace/host-project", origin: "operator", release }),
			),
		]);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("only a stated operator invocation admits the command's grant", async () => {
	const contribution = createEvoContribution({ source: ENTRYPOINT });
	const command = contribution.commands?.[0];
	assert.ok(command);
	const { harness, conversation, host } = await openHarness(contribution, "/workspace/current-project");
	try {
		const release = await readPiReleaseIntake({ harnessRoot: HARNESS_ROOT });
		const direction = "Push the docs fix to main";
		const base = { harnessRoot: HARNESS_ROOT, invocationCwd: "/workspace/current-project", direction, release };
		const run = (invocationId: string, origin?: "operator" | "model") =>
			command.run({ args: direction, ...(origin === undefined ? {} : { origin }), conversation, context: BACKGROUND_CONTEXT, host, invocationId });

		const byModel = await run("task:41", "model");
		const unstated = await run("evo-invocation-unstated");
		const byOperator = await run("evo-invocation-operator", "operator");
		await harness.waitForIdle(BACKGROUND_CONTEXT);

		const texts = await userTexts(conversation);
		assert.deepEqual(
			texts.map(withoutObservedTimes),
			[
				buildEvoKickoff({ ...base, origin: "model", invocation: "task:41" }),
				buildEvoKickoff({ ...base, origin: "unknown", invocation: "evo-invocation-unstated" }),
				buildEvoKickoff({ ...base, origin: "operator" }),
			].map(withoutObservedTimes),
		);
		for (const text of texts.slice(0, 2)) {
			assert.doesNotMatch(text, /This invocation (?:also )?authorizes/);
			assert.match(text, /This invocation is not an operator grant/);
		}
		assert.match(texts[0], /Invocation origin: an agent, through a tool call/);
		assert.match(texts[1], /Invocation origin: not established/);
		assert.match(texts[2], /This invocation also authorizes integration on main, required activation, and push/);
		assert.match(String(byModel), /^Admitted the evo kickoff as submission \d+\. The kickoff records that an agent invoked it: it carries no operator grant of its own/);
		assert.match(String(unstated), /^Admitted the evo kickoff as submission \d+\. The kickoff records that its origin is not established: it carries no operator grant of its own/);
		assert.match(String(byOperator), /^Admitted the evo kickoff as submission \d+\.$/);
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

test("the native kickoff carries the four version facts from their own sources", { timeout: 20_000 }, async (t) => {
	const newer = nextPatch(VERSION);
	const registry = controlledRegistry(t, (name) => ({ latest: name === PI_HOST_PACKAGE ? newer : VERSION }));
	const contribution = createEvoContribution({ source: ENTRYPOINT });
	const command = contribution.commands?.[0];
	assert.ok(command);
	const { harness, conversation, host } = await openHarness(contribution, "/workspace/current-project");
	try {
		const main = mainCheckout();
		const started = Date.now();
		await command.run({
			args: "",
			origin: "operator",
			conversation,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "evo-invocation-facts",
		});
		const finished = Date.now();
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		const [text] = await userTexts(conversation);
		const times = observedTimes(text);
		assert.equal(times.length, 2);
		for (const time of times) {
			assert.ok(Date.parse(time) >= Math.floor(started / 1_000) * 1_000 && Date.parse(time) <= finished, time);
		}
		const lines = text.split("\n");
		for (const line of [
			`- Published versions: the "latest" dist-tag on https://registry.npmjs.org, observed ${times[0]}.`,
			`- Running host: Pi ${JSON.stringify(VERSION)}, reported by the coding-agent module that the process running this command loaded from ${JSON.stringify(getPackageDir())}. Other Pi processes, including retained agent hosts, can run other versions.`,
			`- Checkout graph: "package-lock.json" at ${main.commit}, the tip of local main, observed ${times[1]}. It records what the checkout resolves, not what a running or retained process loaded.`,
			`- Review coverage: reviewed-through ${main.marker} in "docs/pi-durable-harness.md" at ${main.commit}, the tip of local main.`,
			`- Published coding-agent ${newer} is newer than the running host ${VERSION}: a Pi upgrade and a fresh process are pending.`,
			...main.declared.map(
				(entry) =>
					`- ${entry.name} (${entry.relation} ${JSON.stringify(entry.range)}): published ${entry.name === PI_HOST_PACKAGE ? newer : VERSION}; checkout ${entry.version}.`,
			),
		]) {
			assert.ok(lines.includes(line), `missing kickoff line: ${line}`);
		}
		assert.deepEqual(
			registry.requests.map((request) => request.url).sort(),
			[...new Set([PI_HOST_PACKAGE, ...main.declared.map((entry) => entry.name)])].map(distTagsUrl).sort(),
		);
		assert.ok(registry.requests.every((request) => request.method === "GET"));
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("a silent registry delays the native kickoff by no more than the publication deadline", { timeout: 20_000 }, async (t) => {
	controlledRegistry(t, () => "hang");
	const contribution = createEvoContribution({ source: ENTRYPOINT });
	const command = contribution.commands?.[0];
	assert.ok(command);
	const { harness, conversation, host } = await openHarness(contribution, "/workspace/current-project");
	try {
		const started = performance.now();
		await command.run({
			args: "Improve document explanations",
			origin: "operator",
			conversation,
			context: BACKGROUND_CONTEXT,
			host,
			invocationId: "evo-invocation-silent-registry",
		});
		const elapsed = performance.now() - started;
		assert.ok(elapsed >= PI_PUBLICATION_DEADLINE_MS - 20 && elapsed < PI_PUBLICATION_DEADLINE_MS + 2_000, `${elapsed} ms`);
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		const [text] = await userTexts(conversation);
		assert.match(text, new RegExp(`^- Published versions: unavailable at \\S+: "No registry answer within ${PI_PUBLICATION_DEADLINE_MS} ms\\."$`, "m"));
		assert.match(text, /^- Checkout graph: "package-lock\.json" at [a-f0-9]{40}, the tip of local main/m);
		assert.match(text, /A registry failure is not a gate\./);
		assert.match(text, /<evo-direction-json>\n"Improve document explanations"/);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});
