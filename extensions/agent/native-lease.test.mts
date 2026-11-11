import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { tryNativeWriterLease } from "./native-lease.ts";

const native = { skip: process.platform !== "darwin" };
function fixture(t: { after(fn: () => void): void }): string {
	const base = process.env.PI_CODING_AGENT_DIR ?? tmpdir();
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "writer-lease-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return join(root, "writer.lock");
}

it("independent descriptors exclude each other and release preserves the inode", native, (t) => {
	const path = fixture(t);
	const first = tryNativeWriterLease(path);
	assert.equal(first.kind, "held");
	if (first.kind !== "held") return;
	t.after(() => first.lease.release());
	assert.deepEqual(tryNativeWriterLease(path), { kind: "busy" });
	const original = lstatSync(path);
	first.lease.release();
	first.lease.release();
	assert.throws(() => first.lease.assertNamed(), /closed/u);
	assert.equal(existsSync(path), true);
	const second = tryNativeWriterLease(path);
	assert.equal(second.kind, "held");
	if (second.kind !== "held") return;
	t.after(() => second.lease.release());
	assert.equal(second.lease.dev, original.dev);
	assert.equal(second.lease.ino, original.ino);
});

it("diagnostic bytes and an unrelated PID do not establish possession", native, (t) => {
	const path = fixture(t);
	writeFileSync(path, JSON.stringify({ pid: process.pid, host: "diagnostic-only" }), { mode: 0o600 });
	const inode = lstatSync(path).ino;
	const attempt = tryNativeWriterLease(path);
	assert.equal(attempt.kind, "held");
	if (attempt.kind !== "held") return;
	attempt.lease.release();
	assert.equal(lstatSync(path).ino, inode);
});

it("unsafe mode and hard-link aliases refuse without retaining exclusion", native, (t) => {
	const path = fixture(t);
	writeFileSync(path, "", { mode: 0o644 });
	chmodSync(path, 0o644);
	assert.throws(() => tryNativeWriterLease(path), /private regular file/u);
	chmodSync(path, 0o600);
	linkSync(path, `${path}.alias`);
	assert.throws(() => tryNativeWriterLease(path), /private regular file/u);
	rmSync(`${path}.alias`);
	const attempt = tryNativeWriterLease(path);
	assert.equal(attempt.kind, "held");
	if (attempt.kind === "held") attempt.lease.release();
});

it("a symlink is never followed", native, (t) => {
	const path = fixture(t);
	writeFileSync(`${path}.target`, "", { mode: 0o600 });
	symlinkSync(`${path}.target`, path);
	assert.throws(() => tryNativeWriterLease(path));
});

it("the held descriptor detects replacement without unlinking or fencing it", native, (t) => {
	const path = fixture(t);
	const attempt = tryNativeWriterLease(path);
	assert.equal(attempt.kind, "held");
	if (attempt.kind !== "held") return;
	t.after(() => attempt.lease.release());
	renameSync(path, `${path}.original`);
	writeFileSync(path, "replacement", { mode: 0o600 });
	assert.throws(() => attempt.lease.assertNamed(), /pathname changed/u);
	attempt.lease.release();
	assert.equal(existsSync(path), true);
	assert.equal(existsSync(`${path}.original`), true);
});

it("cancellation before acquisition creates no inode", native, (t) => {
	const path = fixture(t);
	const controller = new AbortController();
	controller.abort(new Error("withdrawn"));
	assert.throws(() => tryNativeWriterLease(path, controller.signal), /withdrawn/u);
	assert.equal(existsSync(path), false);
});

it("an owned child exit releases the same stable inode", { ...native, timeout: 10000 }, async (t) => {
	const path = fixture(t);
	const code = `
		import { tryNativeWriterLease } from ${JSON.stringify(new URL("./native-lease.ts", import.meta.url).href)};
		const attempt = tryNativeWriterLease(process.argv[1]);
		if (attempt.kind !== "held") throw new Error("lease unavailable");
		process.send({ ready: true });
		process.on("message", () => {});
	`;
	const child = spawn(process.execPath, ["--input-type=module", "--eval", code, path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	let stderr = "";
	child.stderr?.on("data", (value: Buffer) => { stderr = `${stderr}${value.toString()}`.slice(-4096); });
	const exited = once(child, "exit");
	t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
	await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Lease holder exited before readiness: ${stderr}`); })]);
	const inode = lstatSync(path).ino;
	assert.deepEqual(tryNativeWriterLease(path), { kind: "busy" });
	child.kill("SIGKILL");
	await exited;
	const next = tryNativeWriterLease(path);
	assert.equal(next.kind, "held");
	if (next.kind === "held") { assert.equal(next.lease.ino, inode); next.lease.release(); }
});

it("unsupported platforms refuse before touching a path", { skip: process.platform === "darwin" }, (t) => {
	const path = fixture(t);
	assert.throws(() => tryNativeWriterLease(path), /Darwin/u);
	assert.equal(existsSync(path), false);
});
