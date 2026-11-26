import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const recipes = readFileSync(new URL("./codemode.md", import.meta.url), "utf8");

/** The script of one recipe, run as a codemode script body with the supplied tools and store. */
async function runRecipe(heading: string, tools: Record<string, unknown>, values = new Map<string, unknown>()) {
	const source = recipes.match(new RegExp(`## ${heading}\\n[\\s\\S]*?\`\`\`js\\n([\\s\\S]*?)\\n\`\`\``))?.[1];
	assert.ok(source, heading);
	return (await runInNewContext(`(async () => {\n${source}\n})()`, {
		tools,
		store: (key: string, value: unknown) => values.set(key, value),
		load: (key: string) => values.get(key),
	})) as Record<string, unknown> & unknown[];
}

test("thread recipe creates the thread in the caller's own storage before the agent and keeps its result reference", async () => {
	const calls: string[] = [];
	const values = new Map<string, unknown>();
	const result = await runRecipe(
		"Thread for delegated work",
		{
			agent_spawn: async (args: { prompt?: string }) => {
				calls.push("spawn");
				assert.equal(args.prompt, undefined);
				return { sessionId: "host", cwd: "/work" };
			},
			agent_collaborate: async (args: { action: string; sessionId?: string; title: string }) => {
				calls.push("create");
				assert.equal(args.action, "create");
				assert.equal(args.sessionId, undefined);
				assert.ok(args.title.length > 0);
				return { threadId: "thread-42" };
			},
			agent_send: async (args: { sessionId: string; message: string }) => {
				calls.push("send");
				assert.equal(args.sessionId, "host");
				assert.match(args.message, /thread-42/);
				assert.doesNotMatch(args.message, /\{\{THREAD_ID\}\}/);
				return { result: { sessionId: "host", submissionId: 1 } };
			},
		},
		values,
	);
	assert.deepEqual(calls, ["create", "spawn", "send"]);
	assert.equal(JSON.stringify(values.get("refs")), JSON.stringify([{ sessionId: "host", submissionId: 1 }]));
	assert.equal(result.threadId, "thread-42");
	assert.equal(result.agent, "host");
});

test("parallel dispatch keeps the references of admitted briefs when another brief is refused", async () => {
	const values = new Map<string, unknown>([["refs", [{ sessionId: "earlier", submissionId: 3 }]]]);
	const result = await runRecipe(
		"Parallel dispatch",
		{
			agent_brief: async (args: { name: string }) => {
				if (args.name === "Error cases") throw new Error("Source path README.md does not exist");
				return { result: { sessionId: "input-agent", submissionId: 1 } };
			},
		},
		values,
	);
	assert.equal(
		JSON.stringify(result),
		JSON.stringify([
			{ name: "Input cases", ref: { sessionId: "input-agent", submissionId: 1 } },
			{ name: "Error cases", refused: "Error: Source path README.md does not exist" },
		]),
	);
	assert.equal(
		JSON.stringify(values.get("refs")),
		JSON.stringify([
			{ sessionId: "earlier", submissionId: 3 },
			{ sessionId: "input-agent", submissionId: 1 },
		]),
	);
});

test("fleet sweep reports each agent and request on its own when a read fails", async () => {
	const refs = [
		{ sessionId: "worker", submissionId: 1 },
		{ sessionId: "worker", submissionId: 2 },
		{ sessionId: "ended", submissionId: 1 },
	];
	const result = await runRecipe(
		"Fleet sweep",
		{
			agent_status: async ({ sessionId }: { sessionId: string }) => {
				if (sessionId === "ended") throw new Error("No retained agent has the identity ended");
				return {
					format: "compact",
					conversation: {
						name: "Worker",
						busy: true,
						availability: "live",
						model: { provider: "provider", modelId: "model" },
						queue: { inbox: 1, submissions: 2 },
						unplaced: 0,
						openWorkCount: 1,
					},
				};
			},
			agent_inspect: async ({ sessionId, submissionId }: { sessionId: string; submissionId: number }) => {
				if (sessionId === "ended") throw new Error("No retained agent has the identity ended");
				return submissionId === 1
					? { view: "result", status: "placed" }
					: { view: "result", status: "unanswered", reason: "The provider refused the request" };
			},
		},
		new Map<string, unknown>([["refs", refs]]),
	);
	const agents = result.agents as Record<string, unknown>[];
	assert.equal(agents[0]?.model, "provider/model");
	assert.equal(agents[0]?.inbox, 1);
	assert.match(String(agents[1]?.unavailable), /No retained agent/u);
	assert.equal(JSON.stringify((result.out as Record<string, unknown>[]).map((row) => row.submissionId)), "[1]");
	assert.equal(
		JSON.stringify((result.failures as Record<string, unknown>[]).map((row) => `${row.sessionId}:${row.submissionId}`)),
		JSON.stringify(["worker:2", "ended:1"]),
	);
});

test("result digest follows each answer continuation unchanged and writes the joined text once", async () => {
	const calls: Record<string, unknown>[] = [];
	const writes: { path: string; content: string }[] = [];
	const source = recipes.match(/## Save a result digest to a file\n[\s\S]*?```js\n([\s\S]*?)\n```/)?.[1];
	assert.ok(source);
	const script = source
		.replace('"<agent session>"', '"worker"')
		.replace("const submissionId = 0;", "const submissionId = 4;")
		.replace('"<output path>"', '"digest.md"');
	const result = (await runInNewContext(`(async () => {\n${script}\n})()`, {
		tools: {
			agent_inspect: async (args: Record<string, unknown>) => {
				calls.push(args);
				return args.offset === undefined
					? {
							view: "result",
							status: "done",
							answer: "First é ",
							answerContinuation: {
								tool: "agent_inspect",
								view: "result",
								sessionId: "worker",
								submissionId: 4,
								offset: 8,
							},
						}
					: { view: "result", status: "done", answer: "second." };
			},
			write: async (args: { path: string; content: string }) => {
				writes.push(args);
			},
		},
	})) as { path: string; bytes: number; pages: number };
	// Values from the script's realm compare by their JSON.
	assert.equal(
		JSON.stringify(calls),
		JSON.stringify([
			{ sessionId: "worker", view: "result", submissionId: 4 },
			{ view: "result", sessionId: "worker", submissionId: 4, offset: 8 },
		]),
	);
	assert.equal(JSON.stringify(writes), JSON.stringify([{ path: "digest.md", content: "First é second." }]));
	assert.equal(JSON.stringify(result), JSON.stringify({ path: "digest.md", bytes: 16, pages: 2 }));
});
