import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./reply-hint.mjs", import.meta.url));
const piId = "00000000-0000-4000-8000-000000000001";
const rexId = "00000000-0000-4000-8000-000000000002";
const baseline = "00000001";
const user = "00000002";
const assistant = "00000003";
const pid = 12345;
const secretText = "Text from a different conversation must not enter the hint.";
const timestamp = (s: number) => new Date(s * 1000).toISOString();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function exchange(options: { stop?: string; custom?: boolean; secondUser?: boolean; wrongPane?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "reply-hint-"));
	try {
		const rex = join(dir, "rex.mjs");
		const file = join(dir, "session.jsonl");
		const log = join(dir, "calls");
		const header = line({ type: "session", version: 3, id: piId });
		const source = header + line({ type: "session_info", id: baseline, parentId: null });
		const rows = [
			line({
				type: "message",
				id: user,
				parentId: baseline,
				timestamp: timestamp(1),
				message: { role: "user", content: secretText },
			}),
		];
		const parentId = options.custom ? "00000004" : user;
		if (options.custom) rows.push(line({ type: "custom_message", id: parentId, parentId: user, content: secretText }));
		rows.push(
			line({
				type: "message",
				id: assistant,
				parentId,
				timestamp: timestamp(2),
				message: {
					role: "assistant",
					stopReason: options.stop || "stop",
					content: [{ type: "text", text: secretText }],
				},
			}),
		);
		if (options.secondUser)
			rows.push(
				line({
					type: "message",
					id: "00000005",
					parentId: assistant,
					timestamp: timestamp(3),
					message: { role: "user", content: "New topic." },
				}),
			);
		writeFileSync(file, source + rows.join(""));
		const { dev, ino } = statSync(file, { bigint: true });
		const spec = {
			sessionId: piId,
			file,
			head: { id: baseline, offset: Buffer.byteLength(header) },
			pin: { dev: String(dev), ino: String(ino), size: Buffer.byteLength(source) },
			rex: {
				server: `unix://${dir}/rex.sock`,
				host: rexId,
				instance: rexId,
				session: `session:${rexId}`,
				block: `block:${rexId}`,
				pid,
			},
		};
		writeFileSync(
			rex,
			`#!/usr/bin/env node\nimport { appendFileSync, watch } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] !== '-S' || args[1] !== ${JSON.stringify(spec.rex.server)} || !args.includes('--autostart=false')) process.exit(2);
const out = x => console.log(JSON.stringify(x));
if (args.includes('whoami')) out({host_id:${JSON.stringify(rexId)},instance_id:${JSON.stringify(rexId)}});
else if (args.includes('com.superlogical.terminal.process')) out({foreground:{pid:${options.wrongPane ? pid + 1 : pid}}});
else if (args.includes('com.superlogical.terminal.program_status')) out({records:[{owner:{pid:${pid}},app:'pi',state:'done',updated_at:${JSON.stringify(timestamp(4))}}]});
else if (args.includes('events')) watch(${JSON.stringify(file)}, () => {});
else process.exit(2);\n`,
			{ mode: 0o700 },
		);
		const result = spawnSync(process.execPath, [script, "--timeout-ms", "3500"], {
			input: JSON.stringify(spec),
			encoding: "utf8",
			timeout: 5500,
			env: { ...process.env, PI_REX_EXECUTABLE: rex },
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.ok(Buffer.byteLength(result.stdout) < 1000);
		assert.ok(!result.stdout.includes(secretText));
		assert.ok(!readFileSync(log, "utf8").includes(secretText));
		const receipt = JSON.parse(result.stdout);
		assert.equal(receipt.sessionId, piId);
		assert.equal(receipt.headId, baseline);
		assert.equal(receipt.attribution, "not-established");
		return receipt;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("--help explains the input and interpretation without a session or Rex process", () => {
	const result = spawnSync(process.execPath, [script, "--help"], {
		encoding: "utf8",
		timeout: 2500,
		env: { ...process.env, PI_REX_EXECUTABLE: "/not-a-rex-executable" },
	});
	assert.equal(result.status, 0);
	assert.match(result.stdout, /one JSON object on stdin/);
	assert.match(result.stdout, /NOT compared with a draft/);
});

test("a hint identifies retained entries without comparing or disclosing the user text", () => {
	const r = exchange({ custom: true });
	assert.equal(r.state, "hint");
	assert.equal(r.userId, user);
	assert.equal(r.assistantId, assistant);
	assert.equal(r.contextChanged, true);
});

test("an aborted answer and an intervening user entry are not reply hints", () => {
	assert.equal(exchange({ stop: "aborted" }).state, "incomplete");
	assert.equal(exchange({ secondUser: true }).state, "ambiguous");
});

test("the pane must still belong to the expected foreground process", () => {
	const r = exchange({ wrongPane: true });
	assert.equal(r.state, "unavailable");
	assert.equal(r.reason, "pane-identity-changed");
});

test("unsupported input fields fail without echoing their values", () => {
	const result = spawnSync(process.execPath, [script], {
		input: JSON.stringify({ draft: secretText }),
		encoding: "utf8",
		timeout: 2500,
	});
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).reason, "unexpected-input-fields");
	assert.ok(!result.stdout.includes(secretText));
});
