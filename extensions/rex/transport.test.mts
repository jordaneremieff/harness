import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import test from "node:test";
import { CliTransport } from "./transport.ts";

interface LineReader {
	next(expected: string): Promise<void>;
}

function lineReader(stream: NodeJS.ReadableStream): LineReader {
	let text = "";
	const lines: string[] = [];
	const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
	const flush = () => {
		while (waiters.length > 0 && lines.length > 0) {
			const waiter = waiters.shift();
			const line = lines.shift();
			if (!waiter || line === undefined) return;
			waiter.resolve(line);
		}
	};
	stream.on("data", (chunk: Buffer) => {
		text += chunk.toString("utf8");
		for (;;) {
			const newline = text.indexOf("\n");
			if (newline < 0) break;
			lines.push(text.slice(0, newline));
			text = text.slice(newline + 1);
		}
		flush();
	});
	stream.once("close", () => {
		for (const waiter of waiters.splice(0)) waiter.reject(new Error("Stream closed before the next line arrived."));
	});
	return {
		next(expected: string): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				waiters.push({
					resolve: (line) => (line === expected ? resolve() : reject(new Error(`Expected ${expected}, received ${line}`))),
					reject,
				});
				flush();
			});
		},
	};
}

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

test("a completing child settles as exited with its captured output", async () => {
	const transport = new CliTransport(process.execPath);
	try {
		const result = await transport.run(["-e", "console.log('finished')"], { timeoutMs: 2000, maxOutputBytes: 1024 });
		assert.equal(result.outcome, "exited");
		assert.equal(result.exitCode, 0);
		assert.equal(result.signal, null);
		assert.equal(result.started, true);
		assert.match(result.stdout, /finished/);
	} finally {
		transport.dispose();
	}
});

test("a cooperative child ends from the timeout term signal inside the caller budget", async () => {
	const transport = new CliTransport(process.execPath);
	try {
		const result = await transport.run(
			["-e", "process.on('SIGTERM',()=>{console.log('term');process.exit(0)});console.log('ready');setInterval(()=>{},10000)"],
			{ timeoutMs: 1000, maxOutputBytes: 1024 },
		);
		assert.equal(result.outcome, "timeout");
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /ready/);
		assert.match(result.stdout, /term/);
	} finally {
		transport.dispose();
	}
});

test("a child that ignores the term signal is killed within its total allowance", async () => {
	const transport = new CliTransport(process.execPath);
	const startedAt = performance.now();
	try {
		const result = await transport.run(
			["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},10000)"],
			{ timeoutMs: 1000, maxOutputBytes: 1024 },
		);
		assert.equal(result.outcome, "timeout");
		assert.equal(result.signal, "SIGKILL");
		assert.match(result.stdout, /ready/);
		assert.ok(performance.now() - startedAt < 1200, "termination adds no separate grace interval; scheduler tolerance is 200 ms");
	} finally {
		transport.dispose();
	}
});

test("a finalise signal shortens a long timeout and settles as killed", async () => {
	const finalise = new AbortController();
	const transport = new CliTransport(process.execPath);
	const startedAt = performance.now();
	try {
		const result = await transport.run(
			["-e", "console.log('ready');setInterval(()=>{},10000)"],
			{
				finaliseSignal: finalise.signal,
				timeoutMs: 5000,
				maxOutputBytes: 1024,
				onLine: (line) => {
					if (line === "ready") finalise.abort();
				},
			},
		);
		const elapsed = performance.now() - startedAt;
		assert.equal(result.outcome, "cancelled");
		assert.equal(result.signal, "SIGKILL");
		assert.equal(result.started, true);
		assert.match(result.stdout, /ready/);
		assert.ok(elapsed < 2000, `finalised after ${elapsed.toFixed(0)}ms`);
	} finally {
		transport.dispose();
	}
});

test("a pre-aborted finalise signal spawns no child", async () => {
	const finalise = new AbortController();
	finalise.abort();
	const transport = new CliTransport(process.execPath);
	try {
		const result = await transport.run(["-e", "console.log('must not run')"], {
			finaliseSignal: finalise.signal,
			timeoutMs: 1000,
			maxOutputBytes: 1024,
		});
		assert.equal(result.outcome, "cancelled");
		assert.equal(result.started, false);
		assert.equal(result.stdout, "");
	} finally {
		transport.dispose();
	}
});

test("terminating an owned child leaves a separate stand-in child responsive", async (t) => {
	const standin = spawn(
		process.execPath,
		[
			"-e",
			"const readline=require('node:readline');console.log('standin-ready');readline.createInterface({input:process.stdin}).on('line',(line)=>{if(line==='ping')console.log('pong')});setInterval(()=>{},10000)",
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	) as ChildProcessWithoutNullStreams;
	const lines = lineReader(standin.stdout);
	t.after(() => standin.kill("SIGKILL"));
	await lines.next("standin-ready");

	const transport = new CliTransport(process.execPath);
	try {
		const result = await transport.run(["-e", "setInterval(()=>{},10000)"], { timeoutMs: 500, maxOutputBytes: 1024 });
		assert.equal(result.outcome, "timeout");
		assert.equal(standin.exitCode, null);

		standin.stdin.write("ping\n");
		await lines.next("pong");
		assert.equal(standin.exitCode, null);
	} finally {
		transport.dispose();
	}
});
