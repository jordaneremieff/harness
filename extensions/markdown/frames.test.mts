import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FrameClient, frameAppStatus, validFrame, type Frame } from "./frame-client.ts";
import { cellReply, frameScale, frameSequence, graphicsFallback, graphicsReply } from "./show-graphics.ts";
import { keyAction } from "./show-screen.ts";

const digest = `sha256:${"a".repeat(64)}`;
function frame(directory: string): Frame {
	return { id: 1, ok: true, path: join(directory, "tty-graphics-protocol-frame.rgba"), width: 10, height: 20, scrollY: 0, documentHeight: 12000, scale: 2, revision: 1, digest, milliseconds: 15 };
}

test("graphics replies and cell size require complete bounded protocol answers", () => {
	assert.deepEqual(cellReply("\x1b[6;44;23t"), { width: 23, height: 44 });
	for (const value of ["\x1b[6;0;23t", "\x1b[6;44;9000t", "\x1b[6;44;23", "text"]) assert.equal(cellReply(value), undefined);
	assert.deepEqual(graphicsReply("\x1b_Gi=42,p=1;OK\x1b\\"), { id: 42, message: "OK" });
	assert.deepEqual(graphicsReply("\x1b_Gi=42;EINVAL: bad data\x1b\\"), { id: 42, message: "EINVAL: bad data" });
	assert.equal(graphicsReply("\x1b_Gi=42;OK"), undefined);
	assert.match(graphicsFallback(false, { width: 8, height: 16 }) ?? "", /graphics/);
	assert.match(graphicsFallback(true) ?? "", /pixel size/);
	assert.equal(graphicsFallback(true, { width: 8, height: 16 }), undefined);
	assert.equal(keyAction("\x1b[5~"), "page-up");
	assert.equal(keyAction("\x1b[6~"), "page-down");
});

test("the frame scale follows the current cell size", () => {
	assert.equal(frameScale({ width: 8, height: 16 }, 2), 1);
	assert.equal(frameScale({ width: 23, height: 44 }, 2), 2);
	assert.equal(frameScale({ width: 12, height: 24 }, 2), 2);
	assert.equal(frameScale({ width: 23, height: 44 }, 1), 1);
});

test("frames use whole raw RGBA temporary files and fixed body placement", () => {
	const f = frame("/private/frames");
	const sequence = frameSequence(f, 103, 34);
	assert.ok(sequence.includes("a=t,f=32,s=10,v=20,t=t,"));
	assert.ok(sequence.includes(Buffer.from(f.path).toString("base64")));
	assert.ok(sequence.includes("\x1b[3;1H"));
	assert.ok(sequence.includes("c=103,r=34,C=1,q=0"));
	assert.equal(sequence.includes("f=100"), false);
	assert.equal(sequence.includes(",x="), false);
});

test("frame validation rejects wrong correlation, escaping paths and unbounded dimensions", () => {
	const f = frame("/private/frames");
	assert.equal(validFrame(f, 1, "/private/frames"), true);
	for (const changed of [{ id: 2 }, { path: "/elsewhere/tty-graphics-protocol.rgba" }, { width: 0 }, { height: 8193 }, { width: 8192, height: 8192 }, { scrollY: -1 }, { digest: "invalid" }, { scale: 0 }, { milliseconds: NaN }])
		assert.equal(validFrame({ ...f, ...changed }, 1, "/private/frames"), false);
});

test("app fallback distinguishes platform, missing files, the build contract and the frame protocol", async () => {
	const app = await mkdtemp(join(tmpdir(), "markdown-app-"));
	try {
		assert.match(await frameAppStatus(app, "linux") ?? "", /macOS/);
		assert.match(await frameAppStatus(app, "darwin") ?? "", /unavailable/);
		await mkdir(join(app, "Contents/Resources"), { recursive: true });
		await mkdir(join(app, "Contents/MacOS"), { recursive: true });
		await writeFile(join(app, "Contents/MacOS/MarkdownReader"), "");
		await writeFile(join(app, "Contents/Resources/build.json"), JSON.stringify({ contract: 2, frames: 1 }));
		assert.match(await frameAppStatus(app, "darwin") ?? "", /incompatible/);
		await writeFile(join(app, "Contents/Resources/build.json"), JSON.stringify({ contract: 1 }));
		assert.match(await frameAppStatus(app, "darwin") ?? "", /cannot render pages/);
		await writeFile(join(app, "Contents/Resources/build.json"), JSON.stringify({ contract: 1, frames: 2 }));
		assert.match(await frameAppStatus(app, "darwin") ?? "", /cannot render pages/);
		await writeFile(join(app, "Contents/Resources/build.json"), JSON.stringify({ contract: 1, frames: 1 }));
		assert.equal(await frameAppStatus(app, "darwin"), undefined);
	} finally { await rm(app, { recursive: true, force: true }); }
});

test("the frame client correlates split pipe replies and cleans up on EOF", { timeout: 5000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "markdown-frames-"));
	const f = frame(directory);
	await writeFile(f.path, Buffer.alloc(800));
	const source = `
		const ready = ${JSON.stringify({ event: "ready", directory, scale: 2, pid: 1, activationPolicy: "prohibited", visibleWindows: 0 })};
		process.stdout.write(JSON.stringify(ready) + '\\n');
		process.stdin.once('data', data => {
			const request = JSON.parse(data);
			const reply = JSON.stringify({ ...${JSON.stringify(f)}, id: request.id });
			process.stdout.write(reply.slice(0, 20));
			setImmediate(() => process.stdout.write(reply.slice(20) + '\\n'));
		});
		process.stdin.on('end', () => process.exit(0));
	`;
	const child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "pipe"] });
	const client = new FrameClient("unused", child);
	try {
		assert.equal((await client.ready).scale, 2);
		assert.deepEqual(await client.request({ op: "frame" }), f);
	} finally { await client.close(); }
	assert.equal(child.exitCode, 0);
	await assert.rejects(readFile(f.path), { code: "ENOENT" });
});

test("closing the client cancels an active request and waits for child exit", { timeout: 5000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "markdown-frames-"));
	const ready = { event: "ready", directory, scale: 1, pid: 1, activationPolicy: "prohibited", visibleWindows: 0 };
	const child = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(`${JSON.stringify(ready)}\n`)}); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`], { stdio: ["pipe", "pipe", "pipe"] });
	const client = new FrameClient("unused", child);
	await client.ready;
	const rejected = assert.rejects(client.request({ op: "frame" }), /closed/);
	await client.close();
	await rejected;
	assert.equal(child.exitCode, 0);
	await client.close();
});

test("the frame client refuses a service error without treating it as a frame", { timeout: 5000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "markdown-frames-"));
	const ready = { event: "ready", directory, scale: 1, pid: 1, activationPolicy: "accessory", visibleWindows: 0 };
	const child = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(`${JSON.stringify(ready)}\n`)}); process.stdin.once('data', () => process.stdout.write('{"id":1,"ok":false,"error":"failed"}\\n')); process.stdin.on('end', () => process.exit(0));`], { stdio: ["pipe", "pipe", "pipe"] });
	const client = new FrameClient("unused", child);
	try { await assert.rejects(client.request({ op: "frame" }), /could not render/); }
	finally { await client.close(); }
});
