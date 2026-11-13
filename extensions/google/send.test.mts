import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { base64url, createFake, errorCode, type FakeCall, methodCalls } from "./fake-gws.test-support.mts";
import { SCOPES } from "./gws.ts";

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

const SOURCE = {
	id: "src",
	threadId: "thread-5",
	payload: {
		mimeType: "multipart/mixed",
		headers: [
			{ name: "From", value: "Ann <ann@example.org>" },
			{ name: "To", value: "person@example.com" },
			{ name: "Subject", value: "Report" },
			{ name: "Date", value: "Mon, 9 Nov 2026 10:00:00 +0000" },
		],
		parts: [
			{
				partId: "0",
				mimeType: "multipart/alternative",
				parts: [
					{
						partId: "0.0",
						mimeType: "text/plain",
						filename: "",
						body: { size: 17, data: base64url("Line one\nLine two") },
					},
					{
						partId: "0.1",
						mimeType: "text/html",
						filename: "",
						body: { size: 15, data: base64url("<p>Line one</p>") },
					},
				],
			},
			{
				partId: "1",
				mimeType: "application/pdf",
				filename: "report.pdf",
				headers: [{ name: "Content-Disposition", value: "attachment; filename=report.pdf" }],
				body: { size: 4, data: base64url("%PDF") },
			},
			{
				partId: "2",
				mimeType: "image/png",
				filename: "logo.png",
				headers: [
					{ name: "Content-ID", value: "<logo>" },
					{ name: "Content-Disposition", value: "inline" },
				],
				body: { size: 3, data: base64url("png") },
			},
		],
	},
};
const FORWARD = { messageId: "src", to: ["friend@example.org"] };

function forwardFake(source: unknown = SOURCE) {
	return createFake({
		responses: { "gmail users messages get src": { stdout: source }, [SEND]: { stdout: { id: "g7", threadId: "t7" } } },
	});
}

/** The decoded text/plain body of an uploaded message. */
function bodyText(upload: string): string {
	const encoded = /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n(?:--|$)/.exec(upload)?.[1] ?? "";
	return Buffer.from(encoded.replaceAll("\r\n", ""), "base64").toString("utf8");
}

test("gmail_forward sends the quoted plain text with the original attachments once", async () => {
	const fake = await forwardFake();
	try {
		const args = { operationId: "fw-1", ...FORWARD, text: "FYI" };
		const first = await fake.tool("gmail_forward", args);
		assert.equal(first.status, "ok", JSON.stringify(first));
		assert.equal((first.data as { gmailMessageId?: string }).gmailMessageId, "g7");
		const again = await fake.tool("gmail_forward", args);
		assert.equal((again.data as { gmailMessageId?: string }).gmailMessageId, "g7");
		const sends = methodCalls(await fake.calls(), SEND);
		assert.equal(sends.length, 1);
		const upload = sends[0].upload ?? "";
		assert.match(upload, /\r\nSubject: Fwd: Report\r\n/);
		assert.match(upload, /\r\nTo: friend@example\.org\r\n/);
		assert.equal(
			bodyText(upload),
			[
				"FYI",
				"",
				"---------- Forwarded message ---------",
				"From: Ann <ann@example.org>",
				"Date: Mon, 9 Nov 2026 10:00:00 +0000",
				"Subject: Report",
				"To: person@example.com",
				"",
				"Line one",
				"Line two",
			].join("\r\n"),
		);
		assert.match(upload, /filename="report\.pdf"/);
		assert.doesNotMatch(upload, /logo\.png/);
		assert.equal(sends[0].args[sends[0].args.indexOf("--json") + 1], "{}");
		const conflict = await fake.tool("gmail_forward", { ...args, text: "Changed" });
		assert.equal(errorCode(conflict), "OPERATION_CONFLICT");
	} finally {
		await fake.cleanup();
	}
});

test("gmail_forward carries only the selected original parts", async () => {
	const fake = await forwardFake();
	try {
		const inline = await fake.tool("gmail_forward", { operationId: "fw-2", ...FORWARD, attachmentPartIds: ["2"] });
		assert.equal(inline.status, "ok", JSON.stringify(inline));
		const bare = await fake.tool("gmail_forward", { operationId: "fw-3", ...FORWARD, attachmentPartIds: [] });
		assert.equal(bare.status, "ok", JSON.stringify(bare));
		const [first, second] = methodCalls(await fake.calls(), SEND);
		assert.match(first.upload ?? "", /filename="logo\.png"/);
		assert.doesNotMatch(first.upload ?? "", /report\.pdf/);
		assert.match(second.upload ?? "", /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
		assert.doesNotMatch(second.upload ?? "", /multipart/);
		const absent = await fake.tool("gmail_forward", { operationId: "fw-4", ...FORWARD, attachmentPartIds: ["9"] });
		assert.equal(errorCode(absent), "INVALID_ARGUMENT");
		assert.equal(methodCalls(await fake.calls(), SEND).length, 2);
	} finally {
		await fake.cleanup();
	}
});

const HTML_ONLY = {
	id: "src",
	sizeEstimate: 400,
	payload: {
		mimeType: "text/html",
		headers: SOURCE.payload.headers,
		body: { size: 23, data: base64url("<p>Café total: 12</p>") },
	},
};
/** The stored original, with LF line endings, a folded Bcc header and an 8-bit body. */
const RAW_ORIGINAL = [
	"From: Ann <ann@example.org>",
	"To: person@example.com",
	"Bcc: hidden@example.org,",
	" other@example.org",
	"Subject: Report",
	"MIME-Version: 1.0",
	"Content-Type: text/html; charset=utf-8",
	"",
	"<p>Café total: 12</p>",
	"",
].join("\n");
const RAW = { stdout: { id: "src", raw: base64url(RAW_ORIGINAL) } };

function rawCalls(calls: FakeCall[]): FakeCall[] {
	return methodCalls(calls, "gmail users messages get").filter(
		(call) => JSON.parse(call.args[call.args.indexOf("--params") + 1]).format === "raw",
	);
}

test("gmail_forward attaches the complete original once when the message has no plain-text body", async () => {
	const fake = await createFake({
		responses: {
			"gmail users messages get src": [{ stdout: HTML_ONLY }, { stdout: HTML_ONLY }, RAW, { stdout: HTML_ONLY }, RAW],
			[SEND]: { stdout: { id: "g9", threadId: "t9" } },
		},
	});
	try {
		const selected = await fake.tool("gmail_forward", { operationId: "fw-5", ...FORWARD, attachmentPartIds: [] });
		assert.equal(errorCode(selected), "INVALID_ARGUMENT");
		assert.equal(rawCalls(await fake.calls()).length, 0);
		const args = { operationId: "fw-6", ...FORWARD, text: "See the receipt" };
		const first = await fake.tool("gmail_forward", args);
		assert.equal(first.status, "ok", JSON.stringify(first));
		const again = await fake.tool("gmail_forward", args);
		assert.equal((again.data as { gmailMessageId?: string }).gmailMessageId, "g9");
		const sends = methodCalls(await fake.calls(), SEND);
		assert.equal(sends.length, 1);
		const upload = sends[0].upload ?? "";
		assert.match(upload, /\r\nSubject: Fwd: Report\r\n/);
		assert.match(bodyText(upload), /^See the receipt\r\n\r\n---------- Forwarded message ---------\r\n/);
		assert.match(bodyText(upload), /\r\nThe original message is attached as original-message\.eml\.$/);
		assert.match(
			upload,
			/\r\nContent-Type: message\/rfc822\r\nContent-Transfer-Encoding: 8bit\r\nContent-Disposition: attachment; filename="original-message\.eml"/,
		);
		assert.ok(
			upload.includes("\r\nTo: person@example.com\r\nSubject: Report\r\n"),
			"the Bcc header and its folded line are kept",
		);
		assert.ok(upload.includes("\r\n\r\n<p>Café total: 12</p>\r\n"));
		assert.doesNotMatch(upload, /hidden@example\.org|other@example\.org/);
		assert.ok(!/[^\r]\n/.test(upload));
	} finally {
		await fake.cleanup();
	}
});

test("gmail_forward refuses an original over the size limit and a grant that cannot read the message", async () => {
	const fake = await forwardFake({ ...HTML_ONLY, sizeEstimate: 11 * 1024 * 1024 });
	const sendOnly = await createFake({ scopes: [SCOPES.gmailSend], responses: { [SEND]: { stdout: { id: "g8" } } } });
	try {
		const large = await fake.tool("gmail_forward", { operationId: "fw-7", ...FORWARD });
		assert.equal(errorCode(large), "SIZE_LIMIT");
		assert.equal(errorCode(await fake.tool("gmail_operation_status", { operationId: "fw-7" })), "OPERATION_NOT_FOUND");
		assert.equal(rawCalls(await fake.calls()).length, 0);
		assert.equal(methodCalls(await fake.calls(), SEND).length, 0);
		const unreadable = await sendOnly.tool("gmail_forward", { operationId: "fw-8", ...FORWARD });
		assert.equal(errorCode(unreadable), "SCOPE_REQUIRED");
		assert.ok((unreadable.error as { requiredAnyOf?: string[] }).requiredAnyOf?.includes(SCOPES.gmailRead));
		assert.equal(methodCalls(await sendOnly.calls(), SEND).length, 0);
	} finally {
		await fake.cleanup();
		await sendOnly.cleanup();
	}
});
