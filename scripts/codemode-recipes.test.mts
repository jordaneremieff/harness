import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCodemodeSource } from "@earendil-works/pi-codemode";

const root = fileURLToPath(new URL("..", import.meta.url));

type ThreadEvent = { sequence: number; kind: string; sender: string; message: string; source: string; replyTo: number | null; revision: number };
type Digest = {
	frameRevision: number; frame?: { purpose: string }; through: number; newest: number;
	next: Record<string, unknown> | null;
	events: { seq: number; kind: string; text: string; source?: string; cut?: { shown: number; of: number; read: Record<string, unknown> } }[];
};

/** The thread digest recipe of the Agent extension, run against a forward-read double of `agent_collaborate`. */
function digestFixture(events: ThreadEvent[]) {
	const content = readFileSync(join(root, "extensions/agent/delegation/codemode.md"), "utf8");
	const recipe = /```js\n([\s\S]*?)\n```/.exec(content.slice(content.indexOf("\n## Thread digest")))?.[1];
	assert.ok(recipe, "thread digest recipe");
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...parameters: string[]) => (...values: unknown[]) => Promise<Digest>;
	const run = new AsyncFunction("tools", "load", "store", parseCodemodeSource(recipe.replace('"<thread id>"', '"t1"')).code);
	const thread = { id: "t1", title: "Title", purpose: "Purpose", authority: "Authority", source: "Source", restrictions: "Restrictions", acceptance: "Acceptance", integrator: "integrator", revision: 1, closed: false, members: [] };
	const saved = new Map<string, unknown>();
	const calls: Record<string, unknown>[] = [];
	let failAt = 0;
	const read = (input: Record<string, unknown>) => {
		calls.push(input);
		if (failAt > 0 && calls.length === failAt) throw new Error("thread read failed");
		assert.deepEqual(Object.keys(input).filter((key) => !["action", "threadId", "after", "knownFrameRevision", "limit"].includes(key)), []);
		assert.equal(input.action, "read");
		const after = input.after as number;
		const limit = input.limit as number;
		const page = events.filter((event) => event.sequence > after).slice(0, limit);
		const through = page.at(-1)?.sequence ?? after;
		return {
			direction: "forward", threadId: "t1", frameRevision: thread.revision, sequence: events.length, closed: false,
			...(input.knownFrameRevision === thread.revision ? {} : { thread: { ...thread } }),
			events: page,
			next: through < events.length ? { tool: "agent_collaborate", action: "read", threadId: "t1", after: through, knownFrameRevision: thread.revision, limit } : null,
			pending: 0, coverage: { complete: through === events.length, bytes: 0, after, through },
		};
	};
	return {
		thread, calls, saved, read,
		failOnCall(call: number) { failAt = call; },
		digest: () => run({ agent_collaborate: async (input: Record<string, unknown>) => JSON.stringify(read(input)) }, (key: string) => saved.get(key), (key: string, value: unknown) => { saved.set(key, value); }),
	};
}
const threadEvent = (sequence: number, message: string, kind = "contribution", source = ""): ThreadEvent => ({ sequence, kind, sender: "agent-a", message, source, replyTo: null, revision: 1 });

test("the thread digest returns every event once and saves no position past an unread event", async () => {
	const f = digestFixture(Array.from({ length: 70 }, (_, index) => threadEvent(index + 1, `note ${index + 1}`)));
	const first = await f.digest();
	assert.deepEqual(first.events.map((event) => event.seq), Array.from({ length: 60 }, (_, index) => index + 1));
	assert.equal(first.through, 60);
	assert.equal(first.newest, 70);
	assert.deepEqual(first.next, { action: "read", threadId: "t1", after: 60, knownFrameRevision: 1, limit: 20 });
	assert.deepEqual(f.saved.get("digest:t1"), { after: 60, frameRevision: 1 });
	const second = await f.digest();
	assert.deepEqual(second.events.map((event) => event.seq), Array.from({ length: 10 }, (_, index) => index + 61));
	assert.equal(second.next, null);
	assert.deepEqual((await f.digest()).events, []);
});

test("the thread digest marks each cut, names the exact read for it, and keeps carried authority whole", async () => {
	const long = "x".repeat(5000);
	const f = digestFixture([
		...Array.from({ length: 59 }, (_, index) => threadEvent(index + 1, `${index + 1}:${long}`)),
		threadEvent(60, `operator correction ${long}`, "carried-authority", "primary session, message 12"),
	]);
	const seen: number[] = [];
	for (let run = 0; run < 6; run++) {
		const digest = await f.digest();
		assert.ok(JSON.stringify(digest.events).length <= 24000 + 12000, "one digest stays near its row budget");
		assert.equal((f.saved.get("digest:t1") as { after: number }).after, digest.through);
		assert.equal(digest.through, digest.events.at(-1)?.seq, "the saved position is the last returned event");
		for (const event of digest.events) {
			seen.push(event.seq);
			if (event.kind === "carried-authority") {
				assert.equal(event.text, `operator correction ${long}`);
				assert.equal(event.source, "primary session, message 12");
				assert.equal(event.cut, undefined);
				continue;
			}
			assert.ok(event.text.endsWith(" [cut]") && event.text.length === 606);
			assert.deepEqual({ shown: event.cut?.shown, of: event.cut?.of }, { shown: 600, of: `${event.seq}:${long}`.length });
			const complete = f.read(event.cut?.read ?? {}).events;
			assert.deepEqual(complete.map((entry) => entry.message), [`${event.seq}:${long}`]);
		}
		if (digest.next === null) break;
		assert.equal(digest.next.after, digest.through);
	}
	assert.deepEqual(seen, Array.from({ length: 60 }, (_, index) => index + 1));
});

test("the thread digest returns a changed frame and stores nothing when a read fails", async () => {
	const f = digestFixture(Array.from({ length: 45 }, (_, index) => threadEvent(index + 1, `note ${index + 1}`)));
	f.failOnCall(2);
	await assert.rejects(f.digest(), /thread read failed/);
	assert.equal(f.saved.size, 0);
	f.failOnCall(0);
	const first = await f.digest();
	assert.equal(first.frame?.purpose, "Purpose");
	assert.equal(first.events.length, 45);
	assert.equal((await f.digest()).frame, undefined);
	f.thread.revision = 2;
	f.thread.purpose = "Revised purpose";
	const revised = await f.digest();
	assert.equal(revised.frameRevision, 2);
	assert.equal(revised.frame?.purpose, "Revised purpose");
});

function resultDigest(path: string, finalReport: boolean) {
	const recipes = readFileSync(join(root, "extensions/agent/delegation/codemode.md"), "utf8");
	const recipe = /\n## Save a result digest to a file\n[\s\S]*?```js\n([\s\S]*?)\n```/.exec(recipes)?.[1];
	assert.ok(recipe, "file digest recipe");
	const source = recipe.replace('"<output path>"', JSON.stringify(path)).replace("const finalReport = false;", `const finalReport = ${finalReport};`);
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...parameters: string[]) => (tools: object) => Promise<unknown>;
	return new AsyncFunction("tools", parseCodemodeSource(source).code);
}

test("the file digest writes the exact requested result once and returns only its path and UTF-8 size", async () => {
	for (const finalReport of [false, true]) {
		const path = finalReport ? "out/final.md" : "out/answer.txt";
		const parts = ["line 1\n", "é点🦜\n"];
		const writes: unknown[] = [];
		const offsets: number[] = [];
		const receipt = await resultDigest(path, finalReport)({
			agent_inspect: async (input: { view: string; finalReport?: boolean; offset?: number }) => {
				assert.equal(input.view, "result");
				assert.equal(input.finalReport, finalReport || undefined);
				offsets.push(input.offset ?? 0);
				const first = input.offset === undefined;
				const text = parts[first ? 0 : 1], nextOffset = first ? parts[0].length : null;
				return JSON.stringify(finalReport ? { status: "unanswered", finalReport: { text, nextOffset } } : { status: "done", answer: text, nextOffset });
			},
			write: async (input: unknown) => { writes.push(input); return "Saved"; },
		});
		const content = parts.join("");
		assert.deepEqual(offsets, [0, parts[0].length]);
		assert.deepEqual(writes, [{ path, content }]);
		assert.deepEqual(receipt, { path, bytes: Buffer.byteLength(content, "utf8") });
	}
});

test("the file digest never writes a partial or unavailable result", async () => {
	const run = resultDigest("out/result.txt", false);
	for (const incomplete of [{ status: "placed" }, { status: "done", answer: "part", nextOffset: 0 }]) {
		const writes: unknown[] = [];
		await assert.rejects(run({ agent_inspect: async () => incomplete, write: async (input: unknown) => { writes.push(input); } }), /not available|did not advance/);
		assert.deepEqual(writes, []);
	}
	await assert.rejects(run({ agent_inspect: async () => ({ status: "done", answer: "" }), write: async () => { throw new Error("write failed"); } }), /write failed/);
});

test("maintained codemode recipes parse their options before their source", () => {
	for (const path of ["docs/codemode.md", "extensions/agent/delegation/codemode.md"]) {
		const content = readFileSync(join(root, path), "utf8");
		const recipes = [...content.matchAll(/```(?:javascript|js)\n([\s\S]*?)\n```/g)];
		assert.ok(recipes.length > 0, path);
		for (const recipe of recipes) {
			const parsed = parseCodemodeSource(recipe[1]);
			assert.ok(parsed.code.trim(), path);
			if (recipe[1].startsWith("// @options:")) {
				assert.ok(parsed.options.timeoutMs && parsed.options.timeoutMs > 0, path);
				assert.throws(() => parseCodemodeSource(`\n${recipe[1]}`), /must be the first line/);
			}
		}
	}
});
