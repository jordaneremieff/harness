import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { NamedData } from "./data.ts";
import registerPolicy from "./index.ts";
import { MAX_RULE_EVENT_BYTES, namedDataRevision, RuleRegistry } from "./local-rules.ts";
import { terminalSafe } from "./panel.ts";
import { contentRevision } from "./rule.ts";

const approvalPrefix = "/policy data set ";
const presentationLimit = 24 * 1024;
type DataRequest = {
	data:
		| Omit<Extract<NamedData, { kind: "table" }>, "revision">
		| Omit<Extract<NamedData, { kind: "schema" }>, "revision">;
	expectedRevision: string | null;
};
type Approval = { data: NamedData; expectedRevision: string | null; approveRevision: string };
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

async function setup(t: TestContext, mode: "tui" | "json" = "tui") {
	const dir = await mkdtemp(join(tmpdir(), "policy-approval-command-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const commands = new Map<string, Command>();
	const messages: Array<{ text: string; type?: string }> = [];
	let confirmations = 0;
	const pi = {
		registerFlag() {},
		getFlag: () => "observe",
		registerTool() {},
		on() {},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: { text: string }) {
			assert.equal(customType, "policy_command");
			messages.push(data);
		},
	} as unknown as ExtensionAPI;
	const previous = process.env.PI_POLICY_DIR;
	try {
		process.env.PI_POLICY_DIR = dir;
		registerPolicy(pi);
	} finally {
		if (previous === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = previous;
	}
	const ctx = {
		mode,
		hasUI: mode === "tui",
		cwd: "/work/project",
		sessionManager: { getSessionId: () => "approval-command-test" },
		ui: {
			notify(text: string, type?: string) {
				messages.push({ text, type });
			},
			async custom() {
				confirmations++;
				return false;
			},
			async confirm() {
				confirmations++;
				return false;
			},
		},
	} as unknown as ExtensionCommandContext;
	const registry = new RuleRegistry(dir);
	return {
		registry,
		confirmations: () => confirmations,
		async run(command: string) {
			assert.ok(command.startsWith("/policy "));
			messages.length = 0;
			await commands.get("policy")!.handler(command.slice("/policy ".length), ctx);
			assert.equal(messages.length, 1);
			return messages[0];
		},
	};
}

function request(value: string): DataRequest {
	return {
		data: {
			name: "sample",
			kind: "table",
			source: "operator",
			capturedAt: 1000,
			rows: [{ key: "alias", value }],
		},
		expectedRevision: null,
	};
}

function displayedApproval(message: { text: string; type?: string }): { command: string; artifact: Approval } {
	assert.notEqual(message.type, "error", message.text);
	const prefix = "Policy data change canceled. No data changed.\nExact approval command:\n";
	assert.ok(message.text.startsWith(prefix), message.text);
	const command = message.text.slice(prefix.length);
	assert.ok(command.startsWith(approvalPrefix));
	assert.equal(terminalSafe(message.text), message.text);
	assert.doesNotMatch(command, /[\u0000-\u001f\u007f-\u009f]/);
	assert.ok(Buffer.byteLength(command, "utf8") <= presentationLimit);
	const artifact = JSON.parse(command.slice(approvalPrefix.length)) as Approval;
	assert.equal(artifact.data.revision, namedDataRevision(artifact.data));
	assert.equal(
		artifact.approveRevision,
		contentRevision({ data: artifact.data, expectedRevision: artifact.expectedRevision }),
	);
	return { command, artifact };
}

const controls = String.fromCharCode(
	...Array.from({ length: 32 }, (_, code) => code),
	...Array.from({ length: 33 }, (_, index) => 0x7f + index),
);
const printable = ' boundary: ~\u00a0 café 😀 "quote" \\u0085 \\x85 \\n ';

describe("displayed exact data approval commands", () => {
	for (const mode of ["tui", "json"] as const) {
		it(`round-trips all C0, DEL, and C1 controls after ${mode} command output formatting`, async (t) => {
			const host = await setup(t, mode);
			const input = request(`${controls}${printable}`);
			input.data.source = `source${controls}`;
			const { command, artifact } = displayedApproval(await host.run(`${approvalPrefix}${JSON.stringify(input)}`));
			assert.deepEqual(artifact.data, { ...input.data, revision: namedDataRevision(input.data) });
			assert.equal(artifact.expectedRevision, null);
			for (let code = 0x7f; code <= 0x9f; code++) {
				assert.ok(command.includes(`\\u${code.toString(16).padStart(4, "0")}`));
			}
			assert.equal((await host.registry.snapshot()).data.size, 0);
			const confirmations = host.confirmations();
			const approved = await host.run(command);
			assert.match(approved.text, /uses revision [a-f0-9]{12}\.$/);
			assert.equal(host.confirmations(), confirmations);
			assert.deepEqual((await host.registry.snapshot()).data.get("sample"), artifact.data);
		});
	}

	it("preserves controls in nested schema keys and values", async (t) => {
		const host = await setup(t);
		const input: DataRequest = {
			data: {
				name: "schema",
				kind: "schema",
				source: "operator",
				capturedAt: 1000,
				schema: {
					type: "object",
					properties: { "field\u0085name": { type: "string", enum: [controls, printable] } },
					required: ["field\u0085name"],
				},
			},
			expectedRevision: null,
		};
		const { command, artifact } = displayedApproval(await host.run(`${approvalPrefix}${JSON.stringify(input)}`));
		assert.deepEqual(artifact.data, { ...input.data, revision: namedDataRevision(input.data) });
		assert.match((await host.run(command)).text, /uses revision/);
		assert.deepEqual((await host.registry.snapshot()).data.get("schema"), artifact.data);
	});

	it("binds the displayed command to complete metadata, data, approval, and expected revisions", async (t) => {
		const host = await setup(t);
		const raw = {
			data: { name: "sample", kind: "table", rows: [{ key: "alias", value: "\u0085" }] },
			expectedRevision: null,
		};
		const first = displayedApproval(await host.run(`${approvalPrefix}${JSON.stringify(raw)}`));
		assert.equal(first.artifact.data.source, "operator");
		assert.equal(typeof first.artifact.data.capturedAt, "number");
		assert.ok(first.artifact.data.capturedAt > 0);
		const changedData = { ...first.artifact.data, source: "different source" };
		for (const [artifact, error] of [
			[{ ...first.artifact, approveRevision: "000000000000" }, /exact complete artifact revision/],
			[{ ...first.artifact, data: changedData }, /data revision does not describe its contract/],
			[
				{ ...first.artifact, data: { ...changedData, revision: namedDataRevision(changedData) } },
				/exact complete artifact revision/,
			],
			[{ ...first.artifact, expectedRevision: "000000000000" }, /exact complete artifact revision/],
		] as const) {
			assert.match((await host.run(`${approvalPrefix}${JSON.stringify(artifact)}`)).text, error);
			assert.equal((await host.registry.snapshot()).data.size, 0);
		}
		assert.match((await host.run(first.command)).text, /uses revision/);
		assert.deepEqual((await host.registry.snapshot()).data.get("sample"), first.artifact.data);
		const replacement = { ...request("replacement\u009f"), expectedRevision: first.artifact.data.revision };
		const second = displayedApproval(await host.run(`${approvalPrefix}${JSON.stringify(replacement)}`));
		assert.equal(second.artifact.expectedRevision, first.artifact.data.revision);
		assert.notEqual(second.artifact.approveRevision, first.artifact.approveRevision);
		assert.match((await host.run(second.command)).text, /uses revision/);
		assert.match((await host.run(first.command)).text, /revision changed/);
		assert.match((await host.run(second.command)).text, /revision changed/);
		assert.deepEqual((await host.registry.snapshot()).data.get("sample"), second.artifact.data);
	});

	for (const [label, unit, encodedBytes] of [
		["C1 controls", "\u0085", 6],
		["printable Unicode", "😀", 4],
	] as const) {
		it(`measures the displayed UTF-8 command at its exact size bound for ${label}`, async (t) => {
			const host = await setup(t);
			const input = request("");
			assert.equal(input.data.kind, "table");
			if (input.data.kind !== "table") throw new Error("Expected a table fixture");
			input.data.rows = Array.from({ length: 7 }, (_, index) => ({ key: index, value: "" }));
			const empty = displayedApproval(await host.run(`${approvalPrefix}${JSON.stringify(input)}`));
			const overhead = Buffer.byteLength(empty.command, "utf8");
			let exact: ReturnType<typeof displayedApproval> | undefined;
			for (const delta of [-1, 0, 1]) {
				const payloadBytes = presentationLimit - overhead + delta;
				let units = Math.floor(payloadBytes / encodedBytes);
				for (let index = 0; index < 6; index++) {
					const count = Math.min(units, 1024);
					input.data.rows[index].value = unit.repeat(count);
					units -= count;
				}
				assert.equal(units, 0);
				input.data.rows[6].value = "x".repeat(payloadBytes % encodedBytes);
				const confirmations = host.confirmations();
				const output = await host.run(`${approvalPrefix}${JSON.stringify(input)}`);
				if (delta > 0) {
					assert.equal(output.type, "error");
					assert.match(output.text, /approval artifact exceeds the command presentation bound/);
					assert.doesNotMatch(output.text, /Exact approval command/);
					assert.equal(host.confirmations(), confirmations);
				} else {
					const shown = displayedApproval(output);
					assert.equal(Buffer.byteLength(shown.command, "utf8"), presentationLimit + delta);
					assert.deepEqual(shown.artifact.data, { ...input.data, revision: namedDataRevision(input.data) });
					if (delta === 0) exact = shown;
				}
				assert.equal((await host.registry.snapshot()).data.size, 0);
			}
			assert.ok(exact);
			assert.match((await host.run(exact.command)).text, /uses revision/);
			assert.deepEqual((await host.registry.snapshot()).data.get("sample"), exact.artifact.data);
		});
	}

	it("rejects an oversized input command before confirmation or data mutation", async (t) => {
		const host = await setup(t);
		const output = await host.run(`${approvalPrefix}${JSON.stringify(request("x".repeat(MAX_RULE_EVENT_BYTES)))}`);
		assert.equal(output.type, "error");
		assert.match(output.text, /data command exceeds byte bound/);
		assert.equal(host.confirmations(), 0);
		assert.equal((await host.registry.snapshot()).data.size, 0);
	});
});
