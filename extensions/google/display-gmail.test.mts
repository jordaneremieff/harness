import assert from "node:assert/strict";
import { test } from "node:test";
import type { Data, ResultContext } from "./display-data.ts";
import { gmailPresenters } from "./display-gmail.ts";

function result(name: string, data: Data, context: Partial<ResultContext> = {}) {
	return gmailPresenters[name].result({ args: {}, data, error: {}, status: "ok", isError: false, ...context });
}

const privateDm = {
	messageId: "message-1",
	threadId: "thread-1",
	labelIds: ["INBOX"],
	externalData: {
		source: "gmail",
		trust: "untrusted",
		headers: {
			Subject: "Field notes",
			From: "hidden-from@example.org",
			To: "hidden-to@example.org",
			Cc: "hidden-cc@example.org",
		},
		snippet: "hidden-snippet",
		body: {
			partId: "1",
			mimeType: "text/plain",
			text: "hidden-body",
			truncated: true,
			nextOffset: 32,
			totalCodePoints: 80,
		},
		attachments: [{ partId: "2", attachmentId: "hidden-attachment-id", externalData: { filename: "hidden-filename" } }],
		attachmentTruncated: true,
		nextAttachmentCursor: "25",
	},
};

test("search presents returned rows and metadata misses, with the exact next page", () => {
	const cursor = " A+ß/=? \t";
	const card = result(
		"gmail_search",
		{
			messages: [privateDm],
			nextCursor: cursor,
			estimatedCount: 28,
			fetchFailures: [{ messageId: "message-2", code: "API_ERROR" }],
		},
		{ status: "partial", args: { query: "is:unread", limit: 3, cursor: "old", includeSpamTrash: false } },
	);
	assert.match(card?.outcome ?? "", /1 message and 1 metadata read failure.*next page/);
	assert.deepEqual(card?.next, { args: { query: "is:unread", limit: 3, includeSpamTrash: false, cursor } });
	assert.deepEqual(card?.body, ["Field notes · message-1"]);
	assert.ok(card?.details?.includes("Estimated matches: 28"));
	assert.ok(card?.details?.includes("Metadata unavailable for message: message-2"));
	assert.doesNotMatch(JSON.stringify(card), /hidden-/);
});

test("message continuation advances both ranges without disclosure of body or attachment contents", () => {
	const args = { messageId: "message-1", limit: 32, offset: 0, attachmentCursor: "0" };
	const card = result("gmail_message_get", privateDm, { args });
	assert.match(card?.outcome ?? "", /next page.*message text and attachment entries/);
	assert.deepEqual(card?.next, {
		args: { messageId: "message-1", partId: "1", offset: 32, limit: 32, attachmentCursor: "25" },
	});
	assert.ok(card?.details?.includes("Characters in body: 80"));
	assert.ok(card?.details?.includes("Attachment entries on this page: 1"));
	assert.doesNotMatch(JSON.stringify(card), /hidden-/);
});

test("draft continuation preserves numeric zero and omits an empty root part ID and an unsupported attachment cursor", () => {
	const card = result(
		"gmail_draft_get",
		{
			draftId: "draft-1",
			messageRevision: "message-1",
			message: { ...privateDm, externalData: { ...privateDm.externalData, body: { partId: "", nextOffset: 0 } } },
		},
		{ args: { draftId: "draft-1", limit: 32 } },
	);
	assert.deepEqual(card?.next, { args: { draftId: "draft-1", limit: 32, offset: 0 } });
	assert.ok(card?.details?.includes("Draft revision: message-1"));
	assert.doesNotMatch(JSON.stringify(card), /hidden-/);
});

test("dispatch discloses one primary recipient and only payload sizes", () => {
	const mail = {
		to: ["visible@example.org", "hidden-to@example.org"],
		cc: ["hidden-cc@example.org"],
		bcc: ["hidden-bcc@example.org"],
		subject: "Field notes",
		text: "hidden-body",
		attachments: [{ path: "/example/hidden-attachment.pdf" }],
	};
	const send = gmailPresenters.gmail_send.call({ operationId: "op-1", mail });
	assert.equal(send.subject, "visible@example.org +1");
	assert.deepEqual(send.args, { operationId: "op-1", text: "11 characters", attachments: "1 attachment" });
	const draft = gmailPresenters.gmail_draft_create.call({ mail });
	assert.equal(draft.subject, "Field notes");
	const forward = gmailPresenters.gmail_forward.call({
		...mail,
		messageId: "message-1",
		attachmentPartIds: ["hidden-part"],
	});
	assert.equal(forward.subject, send.subject);
	assert.doesNotMatch(JSON.stringify([send, draft, forward]), /hidden-/);
	assert.doesNotMatch(JSON.stringify(draft), /example\.org/);
});

test("an accepted receipt reports Gmail acceptance, not another dispatch or delivery", () => {
	const data = {
		outcome: "accepted",
		operationId: "original-op",
		gmailMessageId: "sent-1",
		rfcMessageId: "<m@example.org>",
	};
	for (const name of ["gmail_send", "gmail_forward", "gmail_draft_send", "gmail_operation_status"]) {
		const card = result(name, data, { args: { operationId: "different-op" } });
		assert.equal(card?.outcome, "Gmail accepted the send.");
		assert.ok(card?.details?.includes("Operation ID: original-op"));
		assert.ok(card?.details?.includes("Gmail message ID: sent-1"));
		assert.equal(card?.next, undefined);
		assert.equal(card?.body, undefined);
	}
	assert.match(result("gmail_send", {})?.outcome ?? "", /did not confirm/);
});

test("an unknown send follows the causal receipt, not the request's operation ID", () => {
	const data = { outcome: "unknown", operationId: "original-op", rfcMessageId: "<m@example.org>" };
	const error = { code: "SEND_OUTCOME_UNKNOWN", retryable: true, operationId: "original-op" };
	const card = result("gmail_send", data, {
		args: { operationId: "different-op" },
		error,
		status: "error",
		isError: true,
	});
	assert.match(card?.outcome ?? "", /outcome is unknown.*Do not resend/);
	assert.deepEqual(card?.next, {
		name: "gmail_operation_status",
		args: { operationId: "original-op", reconcile: true },
	});
	assert.ok(card?.details?.includes("RFC Message-ID: <m@example.org>"));
});

test("ambiguous reconciliation has only an error operation ID and never suggests a resend", () => {
	const error = { code: "SEND_RECONCILIATION_AMBIGUOUS", operationId: "previous-op", retryable: false };
	const failure = { status: "error", isError: true, error } as const;
	const card = result("gmail_forward", {}, { ...failure, args: { operationId: "different-op" } });
	assert.match(card?.outcome ?? "", /Multiple messages in Sent.*Do not resend/);
	assert.ok(card?.details?.includes("Operation ID: previous-op"));
	assert.deepEqual(card?.next, {
		name: "gmail_operation_status",
		args: { operationId: "previous-op", reconcile: true },
	});
	const reconciled = result(
		"gmail_operation_status",
		{},
		{ ...failure, args: { operationId: "previous-op", reconcile: true } },
	);
	assert.equal(reconciled?.next, undefined);
});

test("a definite rejection and a conflicting operation ID do not offer reconciliation", () => {
	const card = result(
		"gmail_operation_status",
		{ outcome: "rejected", operationId: "op-1" },
		{
			status: "error",
			isError: true,
			error: { code: "API_ERROR", operationId: "op-1", message: "hidden-message" },
		},
	);
	assert.equal(card?.outcome, "Gmail rejected the send.");
	assert.equal(card?.next, undefined);
	assert.doesNotMatch(JSON.stringify(card), /hidden-/);
	assert.equal(
		result(
			"gmail_send",
			{},
			{ status: "error", isError: true, error: { code: "OPERATION_CONFLICT", operationId: "op-1" } },
		),
		undefined,
	);
});

test("a mutation needs evidence of its effect", () => {
	assert.match(result("gmail_draft_update", { draftId: "draft-1" })?.outcome ?? "", /did not confirm/);
	assert.match(result("gmail_draft_delete", { draftId: "draft-1", deleted: false })?.outcome ?? "", /did not confirm/);
	assert.match(
		result("gmail_trash", { messageId: "message-1", labelIds: ["INBOX"] })?.outcome ?? "",
		/without the Trash label/,
	);
	assert.match(result("gmail_untrash", { messageId: "message-1", labelIds: [] })?.outcome ?? "", /removed.*from Trash/);
});
