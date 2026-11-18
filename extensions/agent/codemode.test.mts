import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("thread-hosting recipe creates the thread in the new agent's storage and keeps its result reference", async () => {
	const recipes = readFileSync(new URL("./codemode.md", import.meta.url), "utf8");
	const source = recipes.match(/## Thread hosted by a new agent\n[\s\S]*?```js\n([\s\S]*?)\n```/)?.[1];
	assert.ok(source);
	for (const identified of [true, false]) {
		const calls: string[] = [];
		const values = new Map<string, unknown>();
		const result = await runInNewContext(`(async () => {\n${source}\n})()`, {
			tools: {
				agent_spawn: async (args: { prompt?: string }) => {
					calls.push("spawn");
					assert.equal(args.prompt, undefined);
					return identified ? { sessionId: "host" } : {};
				},
				agent_collaborate: async (args: { action: string; sessionId: string; title: string }) => {
					calls.push("create");
					assert.equal(args.action, "create");
					assert.equal(args.sessionId, "host");
					assert.ok(args.title.length > 0);
					return JSON.stringify({ threadId: "thread-42" });
				},
				agent_send: async (args: { sessionId: string; message: string }) => {
					calls.push("send");
					assert.equal(args.sessionId, "host");
					assert.match(args.message, /thread-42/);
					assert.doesNotMatch(args.message, /\{\{THREAD_ID\}\}/);
					return { result: { sessionId: "host", submissionId: 1 } };
				},
			},
			store: (key: string, value: unknown) => values.set(key, value),
			load: (key: string) => values.get(key),
		});
		if (identified) {
			assert.deepEqual(calls, ["spawn", "create", "send"]);
			assert.equal(JSON.stringify(values.get("refs")), JSON.stringify([{ sessionId: "host", submissionId: 1 }]));
			assert.equal(result.threadId, "thread-42");
		} else {
			assert.equal(result.stop, "spawn receipt names no identity");
			assert.deepEqual(calls, ["spawn"]);
			assert.equal(values.has("refs"), false);
		}
	}
});
