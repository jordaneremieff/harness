import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPolicy from "./index.ts";
import type { PolicyRecord } from "./record.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

interface Notification {
	message: string;
	type?: string;
}

function harness(
	overrides: { systemPrompt?: string; sessionId?: string; policyMode?: string; ctxMode?: string } = {},
) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	const notifications: Notification[] = [];
	const ctx = {
		mode: overrides.ctxMode ?? "tui",
		cwd: "/work",
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		sessionManager: { getSessionId: () => overrides.sessionId ?? "session-1" },
		getSystemPrompt: () => overrides.systemPrompt ?? "base prompt\n\n<project_context>\n\n",
	};
	if (overrides.policyMode === undefined) delete process.env.PI_POLICY_MODE;
	else process.env.PI_POLICY_MODE = overrides.policyMode;
	// The fake supplies only the surface the slice uses.
	registerPolicy(pi as unknown as ExtensionAPI);
	return { handlers, ctx, notifications };
}

/** One completed bash call through the tool_call and tool_result pair. */
async function runBash(
	harnessed: { handlers: Map<string, Handler>; ctx: unknown },
	callId: string,
	command: string,
	result: { content?: unknown[]; isError?: boolean } = {},
): Promise<unknown> {
	const { handlers, ctx } = harnessed;
	await handlers.get("tool_call")!({ toolName: "bash", toolCallId: callId, input: { command } }, ctx);
	return handlers.get("tool_result")!(
		{
			toolName: "bash",
			toolCallId: callId,
			input: { command },
			content: result.content ?? [{ type: "text", text: "out" }],
			isError: result.isError ?? false,
		},
		ctx,
	);
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
const previousDir = process.env.PI_POLICY_DIR;
const previousMode = process.env.PI_POLICY_MODE;

beforeEach(async () => {
	dir = join(await mkdtemp(join(tmpdir(), "policy-index-")), "store");
	process.env.PI_POLICY_DIR = dir;
	delete process.env.PI_POLICY_MODE;
});

afterEach(() => {
	if (previousDir === undefined) delete process.env.PI_POLICY_DIR;
	else process.env.PI_POLICY_DIR = previousDir;
	if (previousMode === undefined) delete process.env.PI_POLICY_MODE;
	else process.env.PI_POLICY_MODE = previousMode;
});

describe("policy extension", () => {
	it("registers the tool and session handlers", () => {
		const { handlers } = harness();
		assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "tool_call", "tool_execution_end", "tool_result"]);
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
		await handlers.get("session_shutdown")!({}, ctx);

		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].tool, "bash");
		assert.equal(written[0].session, "session-1");
		assert.equal(written[0].projectContext, true);
		assert.deepEqual(written[0].classes, ["routing.cat-read"]);
		assert.equal(written[0].captured, "cat notes.md");
		assert.equal(written[0].outputBytes, 5);
		assert.equal(written[0].truncated, true);
		assert.equal(written[0].tokens, 7);
		assert.ok(written[0].durationMs >= 0);
	});

	it("records a worker session as carrying no project context", async () => {
		const { handlers, ctx } = harness({ systemPrompt: "worker prompt without context files" });
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "ls -R ." } }, ctx);
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "c1", content: [], isError: false }, ctx);
		await handlers.get("session_shutdown")!({}, ctx);
		const written = await records(dir);
		assert.equal(written[0].projectContext, false);
		assert.deepEqual(written[0].classes, ["bounds.ls-recursive-uncapped", "form.ls-recursive"]);
	});

	it("binds session facts to each call when the live context changes", async () => {
		const { handlers, ctx } = harness({ sessionId: "session-1" });
		const next = {
			...ctx,
			cwd: "/other",
			sessionManager: { getSessionId: () => "session-2" },
			getSystemPrompt: () => "prompt without project context",
		};
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "ls" } }, ctx);
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "c1", content: [], isError: false }, next);
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c2", input: { command: "ls" } }, next);
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "c2", content: [], isError: false }, next);
		await handlers.get("session_shutdown")!({}, next);
		const written = await records(dir);
		assert.deepEqual(
			written.map((entry) => [entry.session, entry.cwd, entry.projectContext]),
			[
				["session-1", "/work", true],
				["session-2", "/other", false],
			],
		);
	});

	it("stores no input for a tool without a declared capture", async () => {
		const { handlers, ctx } = harness();
		await handlers.get("tool_call")!({ toolName: "read", toolCallId: "c9", input: { path: "/secret/file" } }, ctx);
		await handlers.get("tool_result")!({ toolName: "read", toolCallId: "c9", content: [], isError: false }, ctx);
		await handlers.get("session_shutdown")!({}, ctx);
		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].captured, undefined);
		assert.equal(JSON.stringify(written[0]).includes("/secret/file"), false);
	});

	it("records a blocked call from its execution-end outcome", async () => {
		const { handlers, ctx } = harness();
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "blocked", input: { command: "cat notes.md" } }, ctx);
		await handlers.get("tool_execution_end")!(
			{
				toolName: "bash",
				toolCallId: "blocked",
				result: { content: [{ type: "text", text: "blocked by policy" }] },
				isError: true,
			},
			ctx,
		);
		await handlers.get("session_shutdown")!({}, ctx);
		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].callId, "blocked");
		assert.equal(written[0].error, true);
		assert.equal(written[0].outputBytes, 17);
		assert.equal(JSON.stringify(written[0]).includes("blocked by policy"), false);
	});

	it("accepts no calls after session shutdown closes observation", async () => {
		const { handlers, ctx } = harness();
		await handlers.get("session_shutdown")!({}, ctx);
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "late", input: { command: "cat notes.md" } }, ctx);
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "late", content: [], isError: false }, ctx);
		await assert.rejects(() => readdir(dir));
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

	it("contains a thrown value and a warning channel that both throw", async () => {
		const { handlers, ctx } = harness();
		const hostile = Object.create(null);
		Object.defineProperty(hostile, Symbol.toPrimitive, { value: () => { throw new Error("conversion failed"); } });
		const broken = { ...ctx, sessionManager: { getSessionId: () => { throw hostile; } } };
		const original = console.warn;
		console.warn = () => { throw new Error("warning failed"); };
		try {
			assert.equal(
				await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "ls" } }, broken),
				undefined,
			);
		} finally {
			console.warn = original;
		}
	});
});

describe("notice mode", () => {
	it("shows one flag per flagged call, records it, and returns nothing", async () => {
		const run = harness({ policyMode: "notice" });
		const result = await runBash(run, "c1", "cat notes.md");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.equal(result, undefined, "notice mode must not patch the tool result");
		assert.equal(run.notifications.length, 1);
		assert.match(run.notifications[0].message, /^\[policy\] routing\.cat-read$/);
		assert.equal(run.notifications[0].type, "warning");
		const written = await records(dir);
		assert.equal(written[0].policyMode, "notice");
		assert.equal(written[0].notified, true);
		assert.equal(written[0].annotated, undefined);
	});

	it("shows nothing for a call that matched no rule", async () => {
		const run = harness({ policyMode: "notice" });
		await runBash(run, "c1", "rg -n pattern src/");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.deepEqual(run.notifications, []);
		assert.equal((await records(dir))[0].notified, undefined);
	});

	it("shows nothing outside the terminal, where the notice reaches nobody", async () => {
		const run = harness({ policyMode: "notice", ctxMode: "print" });
		await runBash(run, "c1", "cat notes.md");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.deepEqual(run.notifications, []);
		const written = await records(dir);
		assert.equal(written[0].policyMode, "notice");
		assert.equal(written[0].notified, undefined);
	});
});

describe("annotate mode", () => {
	const MANY = [
		"cat a.txt",
		"cat b.json | jq .",
		"sed -n '1,2p' f.ts",
		'python3 -c "open(\'x\').read()"',
		"ls | grep x",
		"grep -n p f.ts",
		"find .",
		"ls -R .",
		"du -sh x",
		"env | grep P",
		"find . | sort | head -2",
	].join("; ");

	it("appends one guidance line after the tool output", async () => {
		const run = harness({ policyMode: "annotate" });
		const patch = (await runBash(run, "c1", "cat notes.md", {
			content: [{ type: "text", text: "file body" }],
		})) as { content: { type: string; text: string }[] };
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.equal(patch.content.length, 2);
		assert.deepEqual(patch.content[0], { type: "text", text: "file body" });
		assert.equal(patch.content[1].text, "[policy] Use the read tool for file contents.");
		const written = await records(dir);
		assert.equal(written[0].policyMode, "annotate");
		assert.equal(written[0].annotated, true);
		assert.equal(written[0].annotationBytes, patch.content[1].text.length);
		assert.equal(written[0].notified, undefined);
		assert.equal(written[0].outputBytes, 9, "the appended line is not tool output");
	});

	it("annotates one rule id once per session", async () => {
		const run = harness({ policyMode: "annotate" });
		assert.notEqual(await runBash(run, "c1", "cat notes.md"), undefined);
		assert.equal(await runBash(run, "c2", "cat other.md"), undefined);
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		const written = await records(dir);
		assert.deepEqual(
			written.map((entry) => entry.annotated),
			[true, undefined],
		);
	});

	it("annotates the same rule id again in a later session", async () => {
		const run = harness({ policyMode: "annotate" });
		const next = { ...run.ctx, sessionManager: { getSessionId: () => "session-2" } };
		assert.notEqual(await runBash(run, "c1", "cat notes.md"), undefined);
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c2", input: { command: "cat notes.md" } },
			next,
		);
		const patch = await run.handlers.get("tool_result")!(
			{ toolName: "bash", toolCallId: "c2", content: [], isError: false },
			next,
		);
		assert.notEqual(patch, undefined);
	});

	it("keeps annotation history when a session returns after another session", async () => {
		const run = harness({ policyMode: "annotate" });
		const first = run.ctx;
		const second = { ...run.ctx, sessionManager: { getSessionId: () => "session-2" } };
		assert.notEqual(await runBash(run, "c1", "cat notes.md"), undefined);
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c2", input: { command: "cat notes.md" } },
			second,
		);
		assert.notEqual(
			await run.handlers.get("tool_result")!(
				{ toolName: "bash", toolCallId: "c2", content: [], isError: false },
				second,
			),
			undefined,
		);
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c3", input: { command: "cat notes.md" } },
			first,
		);
		assert.equal(
			await run.handlers.get("tool_result")!(
				{ toolName: "bash", toolCallId: "c3", content: [], isError: false },
				first,
			),
			undefined,
			"session-1 history survives the session-2 visit",
		);
	});

	it("withholds the mechanism effect when record admission fails", async () => {
		await writeFile(dir, "");
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			const run = harness({ policyMode: "annotate" });
			assert.notEqual(
				await runBash(run, "c1", "cat notes.md"),
				undefined,
				"the first patch is decided before the async store failure",
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(await runBash(run, "c2", "cat notes.md"), undefined, "no effect without its record");
			assert.deepEqual(run.notifications, []);
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /recording stopped for this session/);
	});

	it("leaves a failed call unchanged", async () => {
		const run = harness({ policyMode: "annotate" });
		const patch = await runBash(run, "c1", "cat missing.md", {
			content: [{ type: "text", text: "No such file" }],
			isError: true,
		});
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.equal(patch, undefined);
		const written = await records(dir);
		assert.equal(written[0].error, true);
		assert.equal(written[0].annotated, undefined);
	});

	it("leaves a call that matched no rule unchanged", async () => {
		const run = harness({ policyMode: "annotate" });
		assert.equal(await runBash(run, "c1", "rg -n pattern src/"), undefined);
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.equal((await records(dir))[0].annotated, undefined);
	});

	it("keeps one annotation inside the byte cap and defers the rest", async () => {
		const run = harness({ policyMode: "annotate" });
		const first = (await runBash(run, "c1", MANY)) as { content: { text: string }[] };
		const text = first.content.at(-1)!.text;
		assert.ok(Buffer.byteLength(text, "utf8") <= 512, `annotation was ${text.length} bytes`);
		const second = await runBash(run, "c2", MANY);
		assert.notEqual(second, undefined, "ids left outside the cap stay available");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
	});

	it("shows the operator nothing", async () => {
		const run = harness({ policyMode: "annotate" });
		await runBash(run, "c1", "cat notes.md");
		assert.deepEqual(run.notifications, []);
	});
});

describe("mode configuration", () => {
	it("stops recording once on an unrecognized mode and never throws", async () => {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		let run: ReturnType<typeof harness>;
		try {
			run = harness({ policyMode: "block" });
			assert.equal(await runBash(run, "c1", "cat notes.md"), undefined);
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /PI_POLICY_MODE must be one of observe, notice, annotate/);
		await assert.rejects(() => readdir(dir));
	});
});

describe("enforce mode", () => {
	it("blocks a flagged call with a reason that names the preferred form", async () => {
		const run = harness({ policyMode: "enforce" });
		const result = await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "find . -name '*.ts'" } },
			run.ctx,
		);
		assert.deepEqual(Object.keys(result as Record<string, unknown>).sort(), ["block", "reason"]);
		assert.equal((result as { block: boolean }).block, true);
		assert.match((result as { reason: string }).reason, /^\[policy\] /);
		assert.match((result as { reason: string }).reason, /rg --files or fd/);
	});

	it("blocks with deduplicated guidance for a multi-class command", async () => {
		const run = harness({ policyMode: "enforce" });
		const result = (await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "find . -name '*.ts'" } },
			run.ctx,
		)) as { reason: string };
		const reason = result.reason;
		assert.equal(reason.split("Bound the output").length - 1, 1, "the shared bound note appears once");
		assert.ok(Buffer.byteLength(reason, "utf8") <= 512, "the reason respects the byte cap");
	});

	it("records the block from the execution-end outcome", async () => {
		const run = harness({ policyMode: "enforce" });
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "grep -rn tarnvel-417 ." } },
			run.ctx,
		);
		await run.handlers.get("tool_execution_end")!(
			{
				toolName: "bash",
				toolCallId: "c1",
				result: { content: [{ type: "text", text: "[policy] Use rg for text search." }] },
				isError: true,
			},
			run.ctx,
		);
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].blocked, true);
		assert.equal(written[0].error, true);
		assert.equal(written[0].policyMode, "enforce");
		assert.deepEqual(written[0].classes, ["bounds.grep-recursive-uncapped", "form.grep-file"]);
	});

	it("does not block an unflagged call", async () => {
		const run = harness({ policyMode: "enforce" });
		assert.equal(
			await run.handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "rg -n x src/" } }, run.ctx),
			undefined,
		);
		assert.equal(
			await run.handlers.get("tool_call")!({ toolName: "read", toolCallId: "c2", input: { path: "/tmp/x" } }, run.ctx),
			undefined,
		);
	});

	it("blocks no call outside enforce mode", async () => {
		for (const policyMode of ["observe", "notice", "annotate"]) {
			const run = harness({ policyMode });
			assert.equal(
				await run.handlers.get("tool_call")!(
					{ toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } },
					run.ctx,
				),
				undefined,
				`${policyMode} must not block`,
			);
		}
	});

	it("shows the operator nothing", async () => {
		const run = harness({ policyMode: "enforce" });
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } },
			run.ctx,
		);
		assert.deepEqual(run.notifications, []);
	});
});
