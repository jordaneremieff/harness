import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerJobs from "./index.ts";
import type { JobLogs, JobSnapshot } from "./manager.ts";

interface Result {
	content: Array<{ type: string; text?: string }>;
	details?: { job?: JobSnapshot; jobs?: JobSnapshot[] } & Partial<JobLogs>;
}
interface Tool {
	name: string;
	parameters: { properties: Record<string, unknown>; additionalProperties?: boolean };
	execute(
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<Result>;
}
class TestPi {
	tools = new Map<string, Tool>();
	shutdown: (() => Promise<void>) | undefined;
	registerTool(tool: Tool) {
		this.tools.set(tool.name, tool);
	}
	on(name: string, handler: () => Promise<void>) {
		assert.equal(name, "session_shutdown");
		this.shutdown = handler;
	}
}
let root: string;
let oldAgentDir: string | undefined;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "jobs-adapter-"));
	oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	await mkdir(join(root, "agent"));
});
after(async () => {
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	await rm(root, { recursive: true, force: true });
});

function setup(cwd = root, trusted = false) {
	const pi = new TestPi();
	registerJobs(pi as unknown as ExtensionAPI);
	const ctx = {
		cwd,
		isProjectTrusted: () => trusted,
		mode: "print",
		hasUI: false,
		model: { provider: "fixture", id: "deterministic" },
		thinkingLevel: "low",
		sessionManager: { getSessionId: () => "job-session", getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	const call = (name: string, params: unknown, signal?: AbortSignal) =>
		pi.tools.get(name)!.execute("call", params, signal, undefined, ctx);
	return { pi, call };
}
async function settled(call: ReturnType<typeof setup>["call"], id: string) {
	const deadline = Date.now() + 5000;
	for (;;) {
		const result = await call("jobs", { action: "status", id });
		if (result.details!.job!.status !== "running") return result.details!.job!;
		assert.ok(Date.now() < deadline, "job settles within deadline");
		await delay(10);
	}
}

describe("Command Jobs adapter", () => {
	it("registers bash admission and a management-only tool without an alternate launch schema", async () => {
		const { pi, call } = setup();
		try {
			assert.deepEqual([...pi.tools.keys()], ["bash", "jobs"]);
			assert.deepEqual(Object.keys(pi.tools.get("jobs")!.parameters.properties), ["action", "id", "cursor"]);
			assert.equal(pi.tools.get("jobs")!.parameters.additionalProperties, false);
			assert.deepEqual((await call("jobs", { action: "list" })).details, { jobs: [] });
			await assert.rejects(call("jobs", { action: "status" }), /requires a job id/);
			await assert.rejects(call("jobs", { action: "list", id: "x" }), /no id or cursor/);
			await assert.rejects(call("jobs", { action: "status", id: "x", cursor: 0 }), /Only logs/);
			await assert.rejects(call("jobs", { action: "status", id: "unknown" }), /Unknown job/);
		} finally {
			await pi.shutdown!();
		}
	});

	it("preserves foreground success and failure plus current session environment", async () => {
		const { pi, call } = setup();
		try {
			const result = await call("bash", { command: 'printf "%s/%s/%s" "$PI_SESSION_ID" "$PI_PROVIDER" "$PI_MODEL"' });
			assert.equal(result.content[0].text, "job-session/fixture/deterministic");
			await assert.rejects(call("bash", { command: "printf failure >&2; exit 7" }), /failure[\s\S]*code 7/);
			assert.deepEqual((await call("jobs", { action: "list" })).details, { jobs: [] });
		} finally {
			await pi.shutdown!();
		}
	});

	it("returns before completion, survives turn abort, and retrieves bounded safe logs and exit status", async () => {
		const { pi, call } = setup();
		try {
			const controller = new AbortController();
			const started = await call(
				"bash",
				{
					command: 'sleep 0.1; printf "\\033[31m%s\\033[0m\\n" "$PI_SESSION_ID"; printf stderr >&2; exit 4',
					background: true,
				},
				controller.signal,
			);
			const id = started.details!.job!.id;
			assert.equal(started.details!.job!.status, "running");
			controller.abort();
			assert.equal((await call("bash", { command: "printf independent" })).content[0].text, "independent");
			const final = await settled(call, id);
			assert.equal(final.status, "failed");
			assert.equal(final.exitCode, 4);
			const logs = await call("jobs", { action: "logs", id });
			assert.match(logs.content[0].text!, /job-session[\s\S]*stderr/);
			assert.ok(!logs.content[0].text!.includes("\u001b"));
			assert.ok(Buffer.byteLength(logs.content[0].text!) < 50 * 1024);
			const next = await call("jobs", { action: "logs", id, cursor: logs.details!.next });
			assert.equal(next.details!.text, "");
		} finally {
			await pi.shutdown!();
		}
	});

	it("rejects an aborted start and cancels owned jobs on repeat shutdown", async (t) => {
		const { pi, call } = setup();
		t.after(() => pi.shutdown!());
		await assert.rejects(call("bash", { command: "printf never", background: true }, AbortSignal.abort()));
		assert.deepEqual((await call("jobs", { action: "list" })).details, { jobs: [] });
		const first = await call("bash", { command: "sleep 30", background: true });
		const second = await call("bash", { command: "sleep 30", background: true });
		const firstId = first.details!.job!.id;
		await call("jobs", { action: "cancel", id: firstId });
		await call("jobs", { action: "cancel", id: firstId });
		assert.equal((await settled(call, firstId)).status, "cancelled");
		await pi.shutdown!();
		await pi.shutdown!();
		assert.equal(
			(await call("jobs", { action: "status", id: second.details!.job!.id })).details!.job!.status,
			"cancelled",
		);
		await assert.rejects(call("bash", { command: "printf never", background: true }), /closed/);
	});

	it("rejects invalid shell setting types before either execution path", async () => {
		const cwd = join(root, "invalid-shell-settings");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		const { pi, call } = setup(cwd, true);
		try {
			for (const settings of [
				[],
				{ shellPath: false },
				{ shellPath: 3 },
				{ shellCommandPrefix: false },
				{ shellCommandPrefix: [] },
				{ shellCommandPrefix: null },
			]) {
				await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
				for (const background of [false, true]) {
					await assert.rejects(call("bash", { command: "printf never", background }), /shell settings/i);
				}
			}
			assert.deepEqual((await call("jobs", { action: "list" })).details, { jobs: [] });
		} finally {
			await pi.shutdown!();
		}
	});

	it("honors trusted shell settings in both paths and ignores untrusted project settings", async () => {
		const cwd = join(root, "project");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ shellCommandPrefix: "export JOB_FIXTURE=trusted", shellPath: "/bin/bash" }),
		);
		const trusted = setup(cwd, true);
		const untrusted = setup(cwd, false);
		try {
			assert.equal((await trusted.call("bash", { command: 'printf "%s" "$JOB_FIXTURE"' })).content[0].text, "trusted");
			const started = await trusted.call("bash", { command: 'printf "%s" "$JOB_FIXTURE"', background: true });
			const id = started.details!.job!.id;
			await settled(trusted.call, id);
			assert.equal((await trusted.call("jobs", { action: "logs", id })).details!.text, "trusted");
			assert.equal(
				(await untrusted.call("bash", { command: `printf "%s" "\${JOB_FIXTURE-unset}"` })).content[0].text,
				"unset",
			);
			await writeFile(join(cwd, ".pi", "settings.json"), "invalid json");
			await assert.rejects(
				trusted.call("bash", { command: "printf never", background: true }),
				/Cannot read shell settings/,
			);
		} finally {
			await trusted.pi.shutdown!();
			await untrusted.pi.shutdown!();
		}
	});
});
