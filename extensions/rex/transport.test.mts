import assert from "node:assert/strict";
import test from "node:test";
import { CliTransport } from "./transport.ts";

test("CLI transport bounds combined output and terminates only its owned subprocess", async () => {
	const transport = new CliTransport(process.execPath);
	try {
		const result = await transport.run(["-e", "process.stdout.write('x'.repeat(20000));setInterval(()=>{},10000)"], {
			timeoutMs: 3000,
			maxOutputBytes: 1024,
		});
		assert.equal(result.outcome, "output_limit");
		assert.equal(result.truncated, true);
		assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 1024);
	} finally {
		transport.dispose();
	}
});

test("call cancellation reaches an active observer and settles after process termination", async () => {
	const controller = new AbortController();
	const transport = new CliTransport(process.execPath);
	try {
		const result = await transport.run(["-e", "console.log('ready');setInterval(()=>{},10000)"], {
			signal: controller.signal,
			timeoutMs: 3000,
			maxOutputBytes: 1024,
			onLine: (line) => {
				if (line === "ready") controller.abort();
			},
		});
		assert.equal(result.outcome, "cancelled");
		assert.equal(result.started, true);
		assert.match(result.stdout, /ready/);
	} finally {
		transport.dispose();
	}
});

test("ambient Rex selectors do not leak into explicit CLI requests", async () => {
	const transport = new CliTransport(process.execPath, {
		...process.env,
		REX_SERVER: "wrong-server",
		REX_SESSION: "wrong-session",
		REX_BLOCK: "wrong-block",
		REX_CLIENT: "wrong-client",
	});
	try {
		const result = await transport.run(
			[
				"-e",
				"console.log(JSON.stringify([process.env.REX_SERVER,process.env.REX_SESSION,process.env.REX_BLOCK,process.env.REX_CLIENT]))",
			],
			{ timeoutMs: 3000, maxOutputBytes: 1024 },
		);
		assert.equal(result.outcome, "exited");
		assert.deepEqual(JSON.parse(result.stdout), [null, null, null, null]);
	} finally {
		transport.dispose();
	}
});

test("observer deadline and disposal do not leave live call timers", async () => {
	const transport = new CliTransport(process.execPath);
	const result = await transport.run(["-e", "setInterval(()=>{},10000)"], { timeoutMs: 50, maxOutputBytes: 1024 });
	assert.equal(result.outcome, "timeout");
	transport.dispose();
	const after = await transport.run(["-e", "throw new Error('must not start')"], {
		timeoutMs: 1000,
		maxOutputBytes: 1024,
	});
	assert.equal(after.outcome, "cancelled");
	assert.equal(after.started, false);
});
