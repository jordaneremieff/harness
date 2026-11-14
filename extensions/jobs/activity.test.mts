import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ACTIVITY_LIMITS,
	createJobActivity,
	elapsedText,
	formatStatusRecord,
	recordId,
	settledMessage,
	type ActivityOutput,
} from "./activity.ts";
import type { CompletionJob } from "./completion.ts";

const JOB_ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const RECORD = "jobs/1b4e28ba2fa111d2883f0016d3cca427";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const TITLE = b64("Background job");

function job(overrides: Partial<CompletionJob> = {}): CompletionJob {
	return { id: JOB_ID, status: "running", startedAt: 0, cancellationRequested: false, ...overrides };
}

function fixture(options: { tty?: boolean; env?: Record<string, string | undefined>; mode?: string; hasUI?: boolean } = {}) {
	const writes: string[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const output: ActivityOutput = {
		write: (text) => writes.push(text),
		isTTY: () => options.tty ?? true,
		env: () => options.env ?? {},
	};
	const ctx = {
		mode: (options.mode ?? "tui") as "tui",
		hasUI: options.hasUI ?? true,
		ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
	} as unknown as Parameters<ReturnType<typeof createJobActivity>["start"]>[1];
	return { activity: createJobActivity(output), writes, statuses, ctx };
}

describe("job status records", () => {
	it("derives one protocol id segment from the job id", () => {
		assert.equal(recordId(JOB_ID), RECORD);
		assert.equal(RECORD.split("/")[1].length, 32);
		assert.equal(recordId("bad id"), undefined);
		assert.equal(recordId("a".repeat(33)), undefined);
		assert.equal(recordId("---"), undefined);
	});

	it("encodes each state as an exact sequence", () => {
		assert.equal(
			formatStatusRecord({ id: RECORD, state: "working", title: "Background job", msg: "Background job running" }),
			`\x1b]7501;state=working:id=${RECORD}:title=${TITLE}:msg=${b64("Background job running")}\x1b\\`,
		);
		assert.equal(
			formatStatusRecord({ id: RECORD, state: "done", title: "Background job", msg: "ok" }),
			`\x1b]7501;state=done:id=${RECORD}:title=${TITLE}:msg=b2s=\x1b\\`,
		);
		assert.equal(
			formatStatusRecord({ id: RECORD, state: "error", title: "Background job", msg: "no" }),
			`\x1b]7501;state=error:id=${RECORD}:title=${TITLE}:msg=bm8=\x1b\\`,
		);
		assert.equal(
			formatStatusRecord({ id: RECORD, state: "clear", title: "Background job", msg: "ignored" }),
			`\x1b]7501;state=clear:id=${RECORD}\x1b\\`,
		);
		assert.throws(() => formatStatusRecord({ id: "jobs/a:b", state: "working" }), /Invalid status record id/);
	});

	it("replaces control characters, omits empty text, and caps the message", () => {
		assert.equal(
			formatStatusRecord({ id: RECORD, state: "done", msg: "a\nb\tc\u0085d\u007f" }),
			`\x1b]7501;state=done:id=${RECORD}:msg=${b64("a b c d")}\x1b\\`,
		);
		assert.equal(formatStatusRecord({ id: RECORD, state: "done", title: "\n", msg: "" }), `\x1b]7501;state=done:id=${RECORD}\x1b\\`);
		const long = formatStatusRecord({ id: RECORD, state: "done", title: "🙂".repeat(500), msg: "🙂".repeat(5000) });
		assert.ok(Buffer.byteLength(long) < ACTIVITY_LIMITS.sequenceBytes);
		const msg = Buffer.from(long.match(/msg=([^\x1b:]*)/u)?.[1] ?? "", "base64").toString("utf8");
		assert.equal([...msg].length, ACTIVITY_LIMITS.messageChars);
		const title = Buffer.from(long.match(/title=([^\x1b:]*)/u)?.[1] ?? "", "base64").toString("utf8");
		assert.ok(Buffer.byteLength(title) <= ACTIVITY_LIMITS.titleBytes);
		assert.ok(!title.includes("\ufffd"), "the title is cut on code point boundaries");
		assert.match(long, /^\x1b\]7501;state=done:id=/u);
	});

	it("states only record facts in the settled message", () => {
		const minutes = (count: number) => count * 60_000;
		assert.equal(elapsedText(0, 59_999), "< 1 min");
		assert.equal(elapsedText(0, minutes(18) + 59_000), "18 min");
		assert.equal(
			settledMessage(job({ status: "succeeded", exitCode: 0, endedAt: minutes(18) }), "added"),
			"Background job succeeded · exit 0 · 18 min · result added to the conversation",
		);
		assert.equal(
			settledMessage(job({ status: "failed", exitCode: 1, endedAt: minutes(3) }), "added"),
			"Background job failed · exit 1 · 3 min · result added to the conversation",
		);
		assert.equal(
			settledMessage(job({ status: "timed_out", endedAt: minutes(10), timeoutSeconds: 600 }), "added"),
			"Background job timed out after 10 min · result added to the conversation",
		);
		assert.equal(settledMessage(job({ status: "failed", exitCode: null, error: "secret", endedAt: 1 })), "Background job failed · < 1 min");
		assert.equal(settledMessage(job({ status: "succeeded", exitCode: 0, endedAt: minutes(4) }), "queued"), "Background job succeeded · exit 0 · 4 min · completion queued for the conversation", "a completion behind an active run is only queued");
		assert.equal(settledMessage(job({ status: "lost", endedAt: minutes(2) }), "added"), "Background job lost · 2 min · result added to the conversation");
		assert.ok(!settledMessage(job({ status: "failed", commandPreview: "rm -rf x", cwd: "/w", endedAt: 1 }), "added").includes("rm"));
	});
});

describe("job activity presenter", () => {
	it("reports a running job and its settlement to the terminal and the footer", () => {
		const { activity, writes, statuses, ctx } = fixture();
		activity.start(job(), ctx);
		activity.start(job({ id: "2b4e28ba-2fa1-11d2-883f-0016d3cca427" }), ctx);
		assert.deepEqual(statuses, [["jobs", "jobs: 1 running"], ["jobs", "jobs: 2 running"]]);
		assert.equal(writes[0], formatStatusRecord({ id: RECORD, state: "working", title: "Background job", msg: "Background job running" }));
		activity.settle(job({ status: "succeeded", exitCode: 0, endedAt: 120_000 }), "added");
		assert.equal(
			writes[2],
			formatStatusRecord({ id: RECORD, state: "done", title: "Background job", msg: "Background job succeeded · exit 0 · 2 min · result added to the conversation" }),
		);
		activity.settle(job({ id: "2b4e28ba-2fa1-11d2-883f-0016d3cca427", status: "failed", exitCode: 2, endedAt: 1 }), "added");
		assert.match(writes[3], /^\x1b\]7501;state=error:id=jobs\/2b4e28ba/u);
		assert.deepEqual(statuses.slice(2), [["jobs", "jobs: 1 running"], ["jobs", undefined]]);
		activity.settle(job({ status: "succeeded", endedAt: 1 }), "added");
		assert.equal(writes.length, 4, "a second settlement of one job writes nothing");
	});

	it("keeps at most eight settled records and clears the oldest", () => {
		const { activity, writes, ctx } = fixture();
		const ids = Array.from({ length: ACTIVITY_LIMITS.settledRecords + 2 }, (_, index) => `job-${index}`);
		for (const id of ids) {
			activity.start(job({ id }), ctx);
			activity.settle(job({ id, status: "succeeded", exitCode: 0, endedAt: 1 }), "added");
		}
		const clears = writes.filter((text) => text.includes("state=clear"));
		assert.deepEqual(clears, [
			formatStatusRecord({ id: "jobs/job0", state: "clear" }),
			formatStatusRecord({ id: "jobs/job1", state: "clear" }),
		]);
		assert.equal(writes.at(-1), clears[1], "the clear follows the newer settlement");
	});

	it("clears the record of a cancelled job and of jobs still running at shutdown", () => {
		const { activity, writes, statuses, ctx } = fixture();
		activity.start(job(), ctx);
		activity.cancel(job({ status: "cancelled", endedAt: 1 }));
		assert.equal(writes.at(-1), formatStatusRecord({ id: RECORD, state: "clear" }));
		assert.deepEqual(statuses.at(-1), ["jobs", undefined]);
		activity.start(job({ id: "settled" }), ctx);
		activity.settle(job({ id: "settled", status: "succeeded", exitCode: 0, endedAt: 1 }), "added");
		activity.start(job({ id: "still-running" }), ctx);
		const before = writes.length;
		activity.shutdown(ctx);
		assert.deepEqual(writes.slice(before), [formatStatusRecord({ id: "jobs/stillrunning", state: "clear" })]);
		assert.deepEqual(statuses.at(-1), ["jobs", undefined]);
		activity.cancel(job({ id: "still-running", status: "cancelled", endedAt: 2 }));
		activity.start(job({ id: "late" }), ctx);
		assert.equal(writes.length, before + 1, "nothing is written after shutdown");
	});

	for (const [name, options] of [
		["not in the TUI", { mode: "print", hasUI: false }],
		["in RPC mode", { mode: "rpc" }],
		["when stdout is not a terminal", { tty: false }],
		["when PI_PROGRAM_STATUS=0", { env: { PI_PROGRAM_STATUS: "0" } }],
	] as const) {
		it(`writes no terminal records ${name}`, () => {
			const { activity, writes, ctx } = fixture(options);
			activity.start(job(), ctx);
			activity.settle(job({ status: "succeeded", exitCode: 0, endedAt: 1 }), "added");
			activity.start(job({ id: "b" }), ctx);
			activity.cancel(job({ id: "b", status: "cancelled" }));
			activity.start(job({ id: "c" }), ctx);
			activity.shutdown(ctx);
			assert.deepEqual(writes, []);
		});
	}

	it("updates the footer only where a UI exists", () => {
		const { activity, statuses, ctx } = fixture({ mode: "print", hasUI: false });
		activity.start(job(), ctx);
		activity.settle(job({ status: "succeeded", endedAt: 1 }), "added");
		assert.deepEqual(statuses, []);
		const rpc = fixture({ mode: "rpc", hasUI: true });
		rpc.activity.start(job(), rpc.ctx);
		assert.deepEqual(rpc.statuses, [["jobs", "jobs: 1 running"]]);
	});
});
