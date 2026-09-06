import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { JOB_LIMITS, JobManager } from "./manager.ts";

const cwd = process.cwd();
const native = createLocalBashOperations();
const success: BashOperations = { exec: async () => ({ exitCode: 0 }) };
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (check()) return;
		await delay(10);
	}
	assert.fail("Condition did not become true");
}

test("registers synchronously and owns a cancellation request until backend settlement", async () => {
	const manager = new JobManager();
	let finish!: (value: { exitCode: number }) => void;
	let signal: AbortSignal | undefined;
	const operations: BashOperations = {
		exec: (_command, _cwd, options) => {
			signal = options.signal;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	};
	const first = manager.start("synthetic", cwd, operations);
	assert.equal(first.status, "running");
	assert.equal(manager.list().length, 1);
	await Promise.resolve();
	assert.equal(manager.cancel(first.id).status, "running");
	assert.equal(manager.cancel(first.id).cancellationRequested, true);
	assert.equal(signal?.aborted, true);
	let disposed = false;
	const disposal = manager.dispose().then(() => {
		disposed = true;
	});
	assert.equal(manager.dispose(), manager.dispose());
	await Promise.resolve();
	assert.equal(disposed, false);
	assert.throws(() => manager.start("x", cwd, success), /closed/);
	finish({ exitCode: 0 });
	await disposal;
	assert.equal((await manager.wait(first.id)).status, "cancelled");
	assert.equal(manager.cancel(first.id).status, "cancelled");
	first.status = "failed";
	assert.equal(manager.status(first.id).status, "cancelled");
});

test("cancellation before dispatch prevents backend invocation", async () => {
	const manager = new JobManager();
	let calls = 0;
	const job = manager.start("x", cwd, {
		exec: async () => {
			calls++;
			return { exitCode: 0 };
		},
	});
	manager.cancel(job.id);
	assert.equal((await manager.wait(job.id)).status, "cancelled");
	assert.equal(calls, 0);
	await manager.dispose();
});

test("native backend completes success, nonzero, stdout and stderr while independent work completes", async (t) => {
	const manager = new JobManager();
	t.after(() => manager.dispose());
	const slow = manager.start("printf 'ready\\n'; sleep 0.3; printf 'done\\n'", cwd, native, undefined, 5);
	await until(() => manager.logs(slow.id).text.includes("ready"));
	const fast = manager.start("printf 'out\\n'; printf 'err\\n' >&2", cwd, native, undefined, 5);
	assert.equal((await manager.wait(fast.id)).status, "succeeded");
	assert.equal(manager.status(slow.id).status, "running");
	assert.match(manager.logs(fast.id).text, /out/);
	assert.match(manager.logs(fast.id).text, /err/);
	assert.equal((await manager.wait(slow.id)).exitCode, 0);
	const failed = manager.start("exit 7", cwd, native);
	assert.equal((await manager.wait(failed.id)).status, "failed");
	assert.equal(manager.status(failed.id).exitCode, 7);
	assert.ok((manager.status(failed.id).endedAt ?? 0) >= failed.startedAt);
});

test("native cancellation stops an active shell and its child", async (t) => {
	const manager = new JobManager();
	t.after(() => manager.dispose());
	const job = manager.start('sleep 30 & child=$!; printf \'%s %s\\n\' "$$" "$child"; wait', cwd, native, undefined, 5);
	await until(() => /^\d+ \d+\n/.test(manager.logs(job.id).text));
	const pids = manager.logs(job.id).text.trim().split(" ").map(Number);
	for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0));
	assert.equal(manager.cancel(job.id).status, "running");
	assert.equal((await manager.wait(job.id)).status, "cancelled");
	await until(() =>
		pids.every((pid) => {
			try {
				process.kill(pid, 0);
				return false;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "ESRCH";
			}
		}),
	);
});

test("native timeout and disposal terminate active execution", async (t) => {
	const manager = new JobManager();
	t.after(() => manager.dispose());
	const timed = manager.start("sleep 30", cwd, native, undefined, 0.05);
	assert.equal((await manager.wait(timed.id)).status, "timed_out");
	const active = manager.start("printf 'ready'; sleep 30", cwd, native);
	await until(() => manager.logs(active.id).text === "ready");
	await manager.dispose();
	assert.equal(manager.status(active.id).status, "cancelled");
	assert.equal(manager.status(timed.id).status, "timed_out");
});

test("native failures settle and preserve partial output", async (t) => {
	const manager = new JobManager();
	t.after(() => manager.dispose());
	const missingCwd = manager.start("true", `${cwd}/nonexistent-jobs-fixture`, native);
	assert.equal((await manager.wait(missingCwd.id)).status, "failed");
	const missingShell = manager.start(
		"true",
		cwd,
		createLocalBashOperations({ shellPath: `${cwd}/nonexistent-jobs-shell` }),
	);
	assert.equal((await manager.wait(missingShell.id)).status, "failed");
	for (const operations of [
		{
			exec: () => {
				throw new Error("sync");
			},
		},
		{
			exec: async (_command: string, _cwd: string, options: Parameters<BashOperations["exec"]>[2]) => {
				options.onData(Buffer.from("partial"));
				throw new Error("failure".repeat(1000));
			},
		},
		{
			exec: async () => {
				throw { problem: true };
			},
		},
		{ exec: async () => ({ exitCode: null }) },
		{ exec: async () => ({ exitCode: Number.NaN }) },
	] satisfies BashOperations[]) {
		const job = manager.start("x", cwd, operations);
		const result = await manager.wait(job.id);
		assert.equal(result.status, "failed");
		assert.ok(Buffer.byteLength(result.error ?? "") <= JOB_LIMITS.errorBytes);
	}
	assert.equal(manager.logs(manager.list()[3].id).text, "partial");
});

test("log ring and pages retain bounded output with explicit byte gaps", async (t) => {
	const manager = new JobManager();
	t.after(() => manager.dispose());
	const job = manager.start(
		"i=0; while [ $i -lt 18000 ]; do printf '0123456789abcdef\\n'; i=$((i+1)); done",
		cwd,
		native,
		undefined,
		10,
	);
	assert.equal((await manager.wait(job.id)).status, "succeeded");
	let page = manager.logs(job.id);
	assert.equal(page.end, 18000 * 17);
	assert.equal(page.earliest, page.end - JOB_LIMITS.logBytes);
	assert.equal(page.gap, true);
	let consumed = 0;
	for (let count = 0; count < 100; count++) {
		assert.ok(Buffer.byteLength(page.text) <= JOB_LIMITS.pageBytes);
		assert.ok(page.text.split("\n").length - Number(page.text.endsWith("\n")) <= JOB_LIMITS.pageLines);
		consumed += Buffer.byteLength(page.text);
		if (!page.more) break;
		page = manager.logs(job.id, page.next);
		assert.equal(page.gap, false);
	}
	assert.equal(consumed, JOB_LIMITS.logBytes);
	assert.equal(page.next, page.end);
	assert.equal(manager.logs(job.id, page.end).text, "");
});

test("oversized chunks, invalid UTF-8, and late output remain bounded", async () => {
	const manager = new JobManager();
	let emit!: (data: Buffer) => void;
	const job = manager.start("x", cwd, {
		exec: async (_c, _d, { onData }) => {
			emit = onData;
			onData(Buffer.alloc(JOB_LIMITS.logBytes * 2, 255));
			return { exitCode: 0 };
		},
	});
	await manager.wait(job.id);
	const page = manager.logs(job.id);
	assert.ok(Buffer.byteLength(page.text) <= JOB_LIMITS.pageBytes);
	assert.equal(page.earliest, JOB_LIMITS.logBytes);
	assert.ok(page.next > page.earliest);
	emit(Buffer.from("late"));
	assert.equal(manager.logs(job.id).end, page.end);
	await manager.dispose();
});

test("UTF-8 pages preserve complete characters and error messages respect the byte limit", async () => {
	const manager = new JobManager();
	const text = "€".repeat(10000);
	const job = manager.start("x", cwd, {
		exec: async (_c, _d, { onData }) => {
			onData(Buffer.from(text));
			throw new Error(text);
		},
	});
	const result = await manager.wait(job.id);
	assert.ok(Buffer.byteLength(result.error ?? "") <= JOB_LIMITS.errorBytes);
	const first = manager.logs(job.id);
	const second = manager.logs(job.id, first.next);
	assert.equal(first.text + second.text, text);
	assert.equal(second.more, false);
	await manager.dispose();
});

test("decoded-byte reductions preserve valid characters after invalid prefix bytes", async () => {
	const manager = new JobManager();
	const bytes = Buffer.concat([Buffer.alloc(3, 255), Buffer.from("😀".repeat(10000))]);
	const job = manager.start("fixture", cwd, {
		exec: async (_command, _cwd, { onData }) => {
			onData(bytes);
			return { exitCode: 0 };
		},
	});
	await manager.wait(job.id);
	let page = manager.logs(job.id);
	let text = page.text;
	for (let count = 0; page.more && count < 10; count++) {
		page = manager.logs(job.id, page.next);
		assert.ok(Buffer.byteLength(page.text) <= JOB_LIMITS.pageBytes);
		text += page.text;
	}
	assert.equal(text, bytes.toString("utf8"));
	assert.equal(page.more, false);
	await manager.dispose();
});

test("live log reads retain incomplete UTF-8 until later chunks complete it", async () => {
	for (const text of ["é", "€", "😀"]) {
		const manager = new JobManager();
		let emit!: (data: Buffer) => void;
		let finish!: (value: { exitCode: number }) => void;
		const job = manager.start("fixture", cwd, {
			exec: (_command, _cwd, options) => {
				emit = options.onData;
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
		});
		await Promise.resolve();
		const bytes = Buffer.from(text);
		for (let index = 0; index < bytes.length - 1; index++) {
			emit(bytes.subarray(index, index + 1));
			const pending = manager.logs(job.id);
			assert.equal(pending.text, "");
			assert.equal(pending.next, 0);
			assert.equal(pending.more, false);
			assert.equal(pending.pendingBytes, index + 1);
		}
		emit(bytes.subarray(bytes.length - 1));
		const complete = manager.logs(job.id);
		assert.equal(complete.text, text);
		assert.equal(complete.next, bytes.length);
		assert.equal(complete.pendingBytes, 0);
		finish({ exitCode: 0 });
		await manager.dispose();
	}
});

test("terminal incomplete UTF-8 and invalid live sequences remain readable", async () => {
	const manager = new JobManager();
	let emit!: (data: Buffer) => void;
	let finish!: (value: { exitCode: number }) => void;
	const job = manager.start("fixture", cwd, {
		exec: (_command, _cwd, options) => {
			emit = options.onData;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	await Promise.resolve();
	emit(Buffer.from([0xe0, 0x80]));
	const invalid = manager.logs(job.id);
	assert.equal(invalid.text, "��");
	assert.equal(invalid.pendingBytes, 0);
	emit(Buffer.from([0xf0, 0x90]));
	assert.equal(manager.logs(job.id, invalid.next).text, "");
	finish({ exitCode: 0 });
	await manager.wait(job.id);
	const terminal = manager.logs(job.id, invalid.next);
	assert.equal(terminal.text, "�");
	assert.equal(terminal.pendingBytes, 0);
	assert.equal(terminal.next, terminal.end);
	await manager.dispose();
});

test("timeout remains a request until rejection and a later cancel does not replace it", async () => {
	const manager = new JobManager();
	let reject!: (error: Error) => void;
	const job = manager.start(
		"x",
		cwd,
		{
			exec: () =>
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
		},
		undefined,
		0.01,
	);
	await until(() => manager.status(job.id).cancellationRequested);
	assert.equal(manager.status(job.id).status, "running");
	manager.cancel(job.id);
	reject(new Error("aborted"));
	assert.equal((await manager.wait(job.id)).status, "timed_out");
	await manager.dispose();
});

test("active and retention limits preserve active jobs and evict oldest terminal records", async () => {
	const manager = new JobManager();
	const holds: Array<(value: { exitCode: number }) => void> = [];
	const held: BashOperations = {
		exec: () =>
			new Promise((resolve) => {
				holds.push(resolve);
			}),
	};
	const active = Array.from({ length: JOB_LIMITS.active }, () => manager.start("x", cwd, held));
	assert.throws(() => manager.start("x", cwd, success), /Active job limit/);
	await Promise.resolve();
	for (const finish of holds.slice(1)) finish({ exitCode: 0 });
	await Promise.all(active.slice(1).map((job) => manager.wait(job.id)));
	for (let index = 0; index < JOB_LIMITS.retained; index++) {
		const job = manager.start("x", cwd, success);
		await manager.wait(job.id);
	}
	assert.equal(manager.list().length, JOB_LIMITS.retained);
	assert.equal(manager.status(active[0].id).status, "running");
	assert.throws(() => manager.status(active[1].id), /Unknown/);
	holds[0]({ exitCode: 0 });
	await manager.dispose();
});

test("invalid input leaves no registered work and caller environment mutations do not affect execution", async () => {
	const manager = new JobManager();
	for (const command of ["", " ", "x\0y", "x".repeat(JOB_LIMITS.commandBytes + 1)])
		assert.throws(() => manager.start(command, cwd, success));
	for (const timeout of [0, -1, NaN, Infinity, 3_000_000])
		assert.throws(() => manager.start("x", cwd, success, undefined, timeout));
	assert.throws(() => manager.start("x", "", success));
	assert.throws(() => manager.start("x", cwd, null as unknown as BashOperations));
	assert.throws(() => manager.start("x", cwd, success, { BAD: "\0" }));
	assert.equal(manager.list().length, 0);
	assert.throws(() => manager.status("missing"));
	assert.throws(() => manager.logs("missing"));
	assert.throws(() => manager.cancel("missing"));
	const env = { FIXTURE: "before" };
	const job = manager.start(
		"x",
		cwd,
		{
			exec: async (_c, _d, options) => {
				assert.equal(options.env?.FIXTURE, "before");
				return { exitCode: 0 };
			},
		},
		env,
	);
	env.FIXTURE = "after";
	await manager.wait(job.id);
	for (const cursor of [-1, 1, 0.5, NaN]) assert.throws(() => manager.logs(job.id, cursor));
	await manager.dispose();
});
