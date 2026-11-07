import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createFake, methodCalls } from "./fake-gws.test-support.mts";

const MAIL = { to: ["friend@example.org"], subject: "Plan", text: "Hello" };
const SEND = "gmail users messages send";

test("an accepted send records the Gmail message and repeats return the same receipt", async () => {
	const fake = await createFake({ responses: { [SEND]: { stdout: { id: "g1", threadId: "t1" } } } });
	try {
		const first = await fake.tool("gmail_send", { operationId: "op-1", mail: MAIL });
		assert.equal(first.status, "ok");
		assert.equal((first.data as { outcome?: string; state?: string; gmailMessageId?: string }).gmailMessageId, "g1");
		const again = await fake.tool("gmail_send", { operationId: "op-1", mail: MAIL });
		assert.equal((again.data as { gmailMessageId?: string }).gmailMessageId, "g1");
		assert.equal(methodCalls(await fake.calls(), SEND).length, 1);
		const conflict = await fake.tool("gmail_send", { operationId: "op-1", mail: { ...MAIL, text: "Changed" } });
		assert.equal((conflict.error as { code: string }).code, "OPERATION_CONFLICT");
	} finally {
		await fake.cleanup();
	}
});

test("a definite Google rejection is recorded as rejected", async () => {
	const fake = await createFake({
		responses: { [SEND]: { exit: 1, stdout: { error: { code: 400, message: "invalid to" } } } },
	});
	try {
		const result = await fake.tool("gmail_send", { operationId: "op-r", mail: MAIL });
		assert.equal((result.error as { code: string }).code, "API_ERROR");
		const record = await fake.tool("gmail_operation_status", { operationId: "op-r" });
		assert.match(JSON.stringify(record), /rejected/);
	} finally {
		await fake.cleanup();
	}
});

test("an unknown send outcome never dispatches again, and reconciliation reads Sent", async () => {
	const fake = await createFake({ responses: { [SEND]: { exit: 5, stderr: "connection reset" } } });
	try {
		const first = await fake.tool("gmail_send", { operationId: "op-u", mail: MAIL });
		assert.match(JSON.stringify(first), /unknown/);
		await fake.scenario({
			responses: { [SEND]: { stdout: { id: "g2" } }, "gmail users messages list": { stdout: {} } },
		});
		await fake.tool("gmail_send", { operationId: "op-u", mail: MAIL });
		const fresh = await fake.tool("gmail_send", { operationId: "op-fresh", mail: MAIL });
		assert.match(JSON.stringify(fresh), /unknown/);
		assert.equal(methodCalls(await fake.calls(), SEND).length, 1);
		await fake.scenario({
			responses: {
				[SEND]: { stdout: { id: "g3" } },
				"gmail users messages list": { stdout: { messages: [{ id: "sent-1" }] } },
				"gmail users messages get sent-1": { sentCopy: true },
			},
		});
		const reconciled = await fake.tool("gmail_operation_status", { operationId: "op-u", reconcile: true });
		assert.equal(reconciled.status, "ok");
		assert.match(JSON.stringify(reconciled.data), /accepted/);
		assert.equal(methodCalls(await fake.calls(), SEND).length, 1);
	} finally {
		await fake.cleanup();
	}
});

test("an unknown send survives expired credentials and sign-in again without a second send", async () => {
	const fake = await createFake({ responses: { [SEND]: { exit: 5, stderr: "connection reset" } } });
	try {
		assert.match(JSON.stringify(await fake.tool("gmail_send", { operationId: "op-a", mail: MAIL })), /unknown/);
		await fake.scenario({ responses: { "gmail users messages list": { exit: 2, stderr: "token expired" } } });
		const expired = await fake.tool("gmail_operation_status", { operationId: "op-a", reconcile: true });
		assert.equal((expired.error as { code: string }).code, "AUTH_REQUIRED");
		const local = await fake.tool("gmail_operation_status", { operationId: "op-a" });
		assert.match(JSON.stringify(local), /unknown/, JSON.stringify(local));
		await writeFile(join(fake.configDir, "credentials.enc"), "encrypted after sign-in");
		await fake.scenario({
			responses: {
				"gmail users messages list": { stdout: { messages: [{ id: "sent-1" }] } },
				"gmail users messages get sent-1": { sentCopy: true },
			},
		});
		const reconciled = await fake.tool("gmail_operation_status", { operationId: "op-a", reconcile: true });
		assert.match(JSON.stringify(reconciled.data), /accepted/);
		assert.equal(methodCalls(await fake.calls(), SEND).length, 1);
	} finally {
		await fake.cleanup();
	}
});

test("composed mail reaches gws as RFC 822 bytes with reply threading", async () => {
	const fake = await createFake({
		responses: {
			"gmail users messages get parent": {
				stdout: {
					id: "parent",
					threadId: "thread-9",
					payload: {
						headers: [
							{ name: "Subject", value: "Budget" },
							{ name: "Message-Id", value: "<p2@example.net>" },
							{ name: "References", value: "<p1@example.net>" },
						],
					},
				},
			},
			[SEND]: { stdout: { id: "g4", threadId: "thread-9" } },
		},
	});
	try {
		const result = await fake.tool("gmail_send", {
			operationId: "op-reply",
			mail: { to: ["friend@example.org"], text: "Agreed\nThanks", replyToMessageId: "parent" },
		});
		assert.equal(result.status, "ok");
		const [call] = methodCalls(await fake.calls(), SEND);
		assert.ok(call?.upload);
		assert.ok(call.args.includes("--upload-content-type"));
		assert.equal(call.args[call.args.indexOf("--json") + 1], '{"threadId":"thread-9"}');
		assert.match(call.upload, /\r\nIn-Reply-To: <p2@example\.net>\r\n/);
		assert.match(call.upload, /\r\nReferences: <p1@example\.net> <p2@example\.net>\r\n/);
		assert.match(call.upload, /\r\nSubject: Re: Budget\r\n/);
		assert.ok(!/[^\r]\n/.test(call.upload));
	} finally {
		await fake.cleanup();
	}
});
