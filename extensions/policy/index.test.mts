import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPolicy from "./index.ts";
import type { PolicyRecord } from "./record.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

function harness(overrides: { systemPrompt?: string; sessionId?: string } = {}) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	const ctx = {
		mode: "tui",
		cwd: "/work",
		sessionManager: { getSessionId: () => overrides.sessionId ?? "session-1" },
		getSystemPrompt: () => overrides.systemPrompt ?? "base prompt\n\n<project_context>\n\n",
	};
	// The fake supplies only the surface the slice uses.
	registerPolicy(pi as unknown as ExtensionAPI);
	return { handlers, ctx };
}

async function records(dir: string): Promise<PolicyRecord[]> {
	const files = await readdir(dir);
	const lines: PolicyRecord[] = [];
	for (const file of files.sort()) {
		const text = await readFile(join(dir, file), "utf8");
		for (const line of text.trim().split("\n")) {
			if (line) lines.push(JSON.parse(line) as PolicyRecord);
		}
	}
	return lines;
}

let dir: string;
const previous = process.env.PI_POLICY_DIR;

beforeEach(async () => {
	dir = join(await mkdtemp(join(tmpdir(), "policy-index-")), "store");
	process.env.PI_POLICY_DIR = dir;
});

afterEach(() => {
	if (previous === undefined) delete process.env.PI_POLICY_DIR;
	else process.env.PI_POLICY_DIR = previous;
});

describe("policy extension", () => {
	it("registers only observing handlers", () => {
		const { handlers } = harness();
		assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "tool_call", "tool_result"]);
	});

	it("writes one record per completed call and returns nothing", async () => {
		const { handlers, ctx } = harness();
		const call = await handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } },
			ctx,
		);
		const result = await handlers.get("tool_result")!(
			{
				toolName: "bash",
				toolCallId: "c1",
				input: { command: "cat notes.md" },
				content: [{ type: "text", text: "hello" }],
				isError: false,
				details: { truncation: { truncated: true } },
				usage: { totalTokens: 7 },
			},
			ctx,
		);
		assert.equal(call, undefined, "tool_call must not return a result object");
		assert.equal(result, undefined, "tool_result must not return a result object");

		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].tool, "bash");
		assert.equal(written[0].session, "session-1");
		assert.equal(written[0].projectContext, true);
		assert.deepEqual(written[0].classes, ["routing.cat-read"]);
		assert.equal(written[0].command, "cat notes.md");
		assert.equal(written[0].outputBytes, 5);
		assert.equal(written[0].truncated, true);
		assert.equal(written[0].tokens, 7);
		assert.ok(written[0].durationMs >= 0);
	});

	it("records a worker session as carrying no project context", async () => {
		const { handlers, ctx } = harness({ systemPrompt: "worker prompt without context files" });
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "ls -R ." } }, ctx);
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "c1", content: [], isError: false }, ctx);
		const written = await records(dir);
		assert.equal(written[0].projectContext, false);
		assert.deepEqual(written[0].classes, ["form.ls-recursive"]);
	});

	it("stores no input for a tool without a declared capture", async () => {
		const { handlers, ctx } = harness();
		await handlers.get("tool_call")!({ toolName: "read", toolCallId: "c9", input: { path: "/secret/file" } }, ctx);
		await handlers.get("tool_result")!({ toolName: "read", toolCallId: "c9", content: [], isError: false }, ctx);
		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].command, undefined);
		assert.equal(JSON.stringify(written[0]).includes("/secret/file"), false);
	});

	it("ignores a result whose call was never seen", async () => {
		const { handlers, ctx } = harness();
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "unknown", content: [] }, ctx);
		await assert.rejects(() => readdir(dir));
	});

	it("stops recording after a failure and never throws into the call", async () => {
		const { handlers, ctx } = harness();
		const broken = { ...ctx, sessionManager: { getSessionId: () => { throw new Error("session gone"); } } };
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			assert.equal(
				await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "ls" } }, broken),
				undefined,
			);
			await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c2", input: { command: "ls" } }, ctx);
			await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "c2", content: [] }, ctx);
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /\[policy\] recording stopped/);
		await assert.rejects(() => readdir(dir));
	});
});
