import { createHash } from "node:crypto";
import { join } from "node:path";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import {
	ATTACHMENT_MAX_BYTES,
	decodeBase64Url,
	readSnapshot,
	removeQuietly,
	stageBytes,
	writeNewFile,
} from "./files.ts";
import { BackendError, type Operation, SCOPES, STDOUT_LIMITS } from "./gws.ts";
import {
	bareMessageId,
	buildMime,
	COMPOSE_LIMITS,
	type Compose,
	newRfcMessageId,
	type PreparedAttachment,
	replyContext,
	rewriteRawMessage,
} from "./mime.ts";
import {
	cleanText,
	external,
	failure,
	GoogleError,
	ok,
	partial,
	type Result,
	TextBudget,
} from "./result.ts";
import { receipt, recordResult, SendLedger, type SendRecord } from "./send-ledger.ts";
import type { ToolSpec } from "./tools.ts";

const OperationId = str({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" });
const Limit = (maximum: number, fallback: number) => opt(int({ minimum: 1, maximum, default: fallback }));
const ComposeSchema = obj({
	to: arr(str({ minLength: 1, maxLength: 320 }), { minItems: 1, maxItems: COMPOSE_LIMITS.recipients }),
	cc: opt(arr(str({ minLength: 1, maxLength: 320 }), { maxItems: COMPOSE_LIMITS.recipients })),
	bcc: opt(arr(str({ minLength: 1, maxLength: 320 }), { maxItems: COMPOSE_LIMITS.recipients })),
	subject: opt(str({ maxLength: 4096 })),
	text: str({ maxLength: COMPOSE_LIMITS.textBytes }),
	replyToMessageId: opt(str({ minLength: 1, maxLength: 200 })),
	attachments: opt(
		arr(
			obj({
				path: str({ minLength: 1, maxLength: 4096 }),
				filename: opt(str({ minLength: 1, maxLength: 512 })),
				mimeType: opt(str({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$" })),
			}),
			{ maxItems: COMPOSE_LIMITS.attachments },
		),
	),
});
const MailParam = { mail: ComposeSchema };

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function payloadOf(message: Record<string, unknown>): Record<string, unknown> {
	if (!object(message.payload)) throw new GoogleError("BACKEND_SCHEMA_ERROR", "Gmail message payload is absent.");
	return message.payload;
}
function headersOf(message: Record<string, unknown>): Record<string, string> {
	const result: Record<string, string> = {};
	const headers = payloadOf(message).headers;
	if (!Array.isArray(headers)) return result;
	for (const item of headers) {
		if (object(item) && typeof item.name === "string" && typeof item.value === "string")
			result[item.name.toLowerCase()] = item.value;
	}
	return result;
}
function summary(message: Record<string, unknown>, budget: TextBudget): Record<string, unknown> {
	const headers = headersOf(message);
	const selected: Record<string, unknown> = {};
	for (const name of ["From", "To", "Cc", "Subject", "Date", "Reply-To", "Message-ID", "In-Reply-To", "References"]) {
		const clipped = budget.clip(headers[name.toLowerCase()], 1024);
		if (clipped.text) selected[name] = clipped.text;
	}
	const snippet = budget.clip(message.snippet, 2048);
	return {
		messageId: text(message.id),
		threadId: text(message.threadId),
		labelIds: strings(message.labelIds),
		internalDate: text(message.internalDate),
		externalData: external("gmail", { headers: selected, snippet: snippet.text, truncated: snippet.truncated }),
	};
}

export function parseCursor(value: string | undefined, max: number, label: string): number {
	const raw = value ?? "0";
	const cursor = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > max || String(cursor) !== raw)
		throw new GoogleError("INVALID_ARGUMENT", `Invalid ${label} cursor.`);
	return cursor;
}

type Part = {
	partId: string;
	mimeType: string;
	filename: string;
	attachmentId?: string;
	data?: string;
	size: number;
	part: Record<string, unknown>;
};
function partRecord(part: Record<string, unknown>, fallbackId: string): Part {
	const body = object(part.body) ? part.body : {};
	return {
		partId: text(part.partId, fallbackId),
		mimeType: text(part.mimeType, "application/octet-stream"),
		filename: text(part.filename),
		attachmentId: typeof body.attachmentId === "string" ? body.attachmentId : undefined,
		data: typeof body.data === "string" ? body.data : undefined,
		size: typeof body.size === "number" ? body.size : 0,
		part,
	};
}
function partsOf(message: Record<string, unknown>): Part[] {
	const parts: Part[] = [];
	const visit = (part: Record<string, unknown>, depth: number, fallbackId: string) => {
		if (depth > 16 || parts.length >= 256)
			throw new GoogleError("SIZE_LIMIT", "The Gmail MIME tree exceeds the traversal limit.");
		parts.push(partRecord(part, fallbackId));
		const children = Array.isArray(part.parts) ? part.parts : [];
		children.forEach((child, index) => {
			if (object(child)) visit(child, depth + 1, `${fallbackId}.${index}`);
		});
	};
	visit(payloadOf(message), 0, "root");
	return parts;
}
async function partBytes(operation: Operation, messageId: string, part: Part): Promise<Buffer> {
	if (part.data !== undefined) return decodeBase64Url(part.data, STDOUT_LIMITS.message);
	if (part.attachmentId) {
		const response = await operation.call<Record<string, unknown>>(
			"gmail",
			["users", "messages", "attachments", "get"],
			{
				params: { userId: "me", messageId, id: part.attachmentId },
				stdoutLimit: STDOUT_LIMITS.attachment,
			},
		);
		return decodeBase64Url(text(response.data), ATTACHMENT_MAX_BYTES);
	}
	return Buffer.alloc(0);
}
function selectBodyPart(parts: Part[], partId: string | undefined, messageId: string): Part | undefined {
	if (!partId)
		return (
			parts.find((part) => part.mimeType === "text/plain" && !part.filename) ??
			parts.find((part) => part.mimeType === "text/html" && !part.filename)
		);
	const selected = parts.find((part) => part.partId === partId);
	if (!selected) throw new GoogleError("INVALID_ARGUMENT", `MIME part ${partId} is absent from message ${messageId}.`);
	return selected;
}
async function readBody(
	operation: Operation,
	messageId: string,
	part: Part,
	range: { offset?: number; limit?: number },
	budget: TextBudget,
) {
	const decoded = new TextDecoder("utf-8", { fatal: false }).decode(await partBytes(operation, messageId, part));
	const page = budget.page(decoded, range.offset ?? 0, range.limit ?? 4096, 8192);
	return {
		partId: part.partId,
		mimeType: part.mimeType,
		text: page.text,
		truncated: page.nextOffset !== undefined,
		...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
		totalCodePoints: page.total,
	};
}
function attachmentManifest(parts: Part[], cursorText: string | undefined, budget: TextBudget) {
	const attachments = parts.filter((part) => part.filename || part.attachmentId);
	const cursor = parseCursor(cursorText, attachments.length, "attachment");
	const more = cursor + 25 < attachments.length;
	const manifest = attachments.slice(cursor, cursor + 25).map((part) => {
		const filename = budget.clip(part.filename, 1024);
		return {
			partId: part.partId,
			attachmentId: part.attachmentId,
			size: part.size,
			externalData: external("gmail", {
				filename: filename.text,
				mimeType: cleanText(part.mimeType, 200),
				truncated: filename.truncated,
			}),
		};
	});
	return {
		attachments: manifest,
		attachmentTruncated: more,
		...(more ? { nextAttachmentCursor: String(cursor + 25) } : {}),
	};
}
async function messageRead(
	operation: Operation,
	message: Record<string, unknown>,
	args: { partId?: string; offset?: number; limit?: number; attachmentCursor?: string },
) {
	const messageId = text(message.id);
	const budget = new TextBudget();
	const parts = partsOf(message);
	const selected = selectBodyPart(parts, args.partId, messageId);
	const body = selected ? await readBody(operation, messageId, selected, args, budget) : undefined;
	const head = summary(message, budget);
	return {
		...head,
		externalData: external("gmail", {
			...(head.externalData as Record<string, unknown>),
			...(body ? { body } : {}),
			...attachmentManifest(parts, args.attachmentCursor, budget),
		}),
	};
}
async function getMessage(
	operation: Operation,
	messageId: string,
	format: "full" | "metadata" = "full",
	stdoutLimit = STDOUT_LIMITS.message,
) {
	return operation.call<Record<string, unknown>>("gmail", ["users", "messages", "get"], {
		params: { userId: "me", id: messageId, format },
		stdoutLimit,
	});
}

async function prepareAttachments(mail: Compose): Promise<PreparedAttachment[]> {
	const result: PreparedAttachment[] = [];
	let total = 0;
	for (const input of mail.attachments ?? []) {
		const snapshot = await readSnapshot(input.path, COMPOSE_LIMITS.attachmentBytes);
		total += snapshot.size;
		if (total > COMPOSE_LIMITS.attachmentBytes)
			throw new GoogleError("SIZE_LIMIT", "Combined attachment bytes exceed the limit.");
		result.push({
			...snapshot,
			filename: input.filename ?? snapshot.name,
			mimeType: input.mimeType ?? "application/octet-stream",
		});
	}
	return result;
}
async function prepareMail(operation: Operation, mail: Compose, forcedMessageId?: string) {
	const attachments = await prepareAttachments(mail);
	const reply = mail.replyToMessageId
		? replyContext(await getMessage(operation, mail.replyToMessageId), mail.replyToMessageId)
		: undefined;
	return buildMime(mail, operation.auth.account, attachments, reply, forcedMessageId);
}
async function staged(operation: Operation, bytes: Buffer): Promise<string> {
	return stageBytes(join(operation.stateDir, "mime"), bytes, ".eml");
}

async function reconcile(operation: Operation, record: SendRecord): Promise<Result<unknown>> {
	const ledger = new SendLedger(operation.stateDir, operation.auth.account);
	const list = await operation.call<Record<string, unknown>>("gmail", ["users", "messages", "list"], {
		params: {
			userId: "me",
			labelIds: ["SENT"],
			q: `rfc822msgid:<${bareMessageId(record.rfcMessageId)}>`,
			includeSpamTrash: true,
			maxResults: 2,
		},
	});
	const matches: SendRecord[] = [];
	for (const candidate of Array.isArray(list.messages) ? list.messages : []) {
		if (!object(candidate) || typeof candidate.id !== "string") continue;
		const message = await getMessage(operation, candidate.id, "metadata", STDOUT_LIMITS.metadata);
		const messageId = headersOf(message)["message-id"]?.replaceAll(/\s+/g, "");
		if (messageId === record.rfcMessageId && strings(message.labelIds).includes("SENT")) {
			matches.push({ ...record, state: "accepted", gmailMessageId: candidate.id, threadId: text(message.threadId) });
		}
	}
	if (matches.length === 1) {
		await ledger.update(matches[0]);
		return ok(receipt(matches[0]));
	}
	if (matches.length > 1)
		return failure(
			new GoogleError(
				"SEND_RECONCILIATION_AMBIGUOUS",
				"Multiple exact Sent messages match the outgoing RFC Message-ID. Do not resend.",
				false,
				undefined,
				record.operationId,
			),
		);
	return recordResult(record);
}

async function existingSend(
	operation: Operation,
	record: SendRecord,
	tool: SendRecord["tool"],
	fingerprint: string,
): Promise<Result<unknown>> {
	if (
		record.tool !== tool ||
		record.requestFingerprint !== fingerprint ||
		record.account.toLowerCase() !== operation.auth.account.toLowerCase()
	) {
		return failure(
			new GoogleError(
				"OPERATION_CONFLICT",
				"The operation ID belongs to different send arguments.",
				false,
				undefined,
				record.operationId,
			),
		);
	}
	if (record.state === "accepted" || record.state === "rejected") return recordResult(record);
	return reconcile(operation, record);
}

function sendCall(operation: Operation, record: SendRecord, stagedPath: string, draft: boolean) {
	const message = record.threadId ? { threadId: record.threadId } : {};
	return operation.call<Record<string, unknown>>(
		"gmail",
		draft ? ["users", "drafts", "send"] : ["users", "messages", "send"],
		{
			params: { userId: "me" },
			body: draft ? { id: record.draftId, message } : message,
			upload: stagedPath,
			uploadContentType: "message/rfc822",
		},
	);
}
function failedRecord(record: SendRecord, error: unknown): SendRecord {
	if (error instanceof BackendError && error.unknownOutcome) return { ...record, state: "unknown" };
	const code = error instanceof GoogleError ? error.code : "BACKEND_ERROR";
	return {
		...record,
		state: "rejected",
		error: { code, message: error instanceof Error ? error.message : String(error), retryable: false },
	};
}
/** One dispatch per record: the in_flight record is durable before gws starts, and no path sends again. */
async function dispatch(
	operation: Operation,
	ledger: SendLedger,
	record: SendRecord,
	bytes: Buffer,
	draft: boolean,
): Promise<Result<unknown>> {
	await ledger.insert(record);
	const stagedPath = await staged(operation, bytes);
	let settled: SendRecord;
	try {
		const response = await sendCall(operation, record, stagedPath, draft);
		if (typeof response.id !== "string" || !response.id)
			throw new BackendError("BACKEND_SCHEMA_ERROR", "Gmail send returned no validated message ID.", false, true);
		settled = {
			...record,
			state: "accepted",
			gmailMessageId: response.id,
			threadId: text(response.threadId, record.threadId),
		};
	} catch (error) {
		settled = failedRecord(record, error);
	} finally {
		await removeQuietly(stagedPath);
	}
	const stored = await ledger.update(settled).then(
		() => true,
		() => false,
	);
	const warnings = stored
		? undefined
		: ["The send ledger could not record this outcome; the operation stays unresolved locally."];
	return settled.state === "accepted" ? ok(receipt(settled), warnings) : recordResult(settled);
}

async function send(args: { operationId: string; mail: Compose }, operation: Operation): Promise<Result<unknown>> {
	const ledger = new SendLedger(operation.stateDir, operation.auth.account);
	const previous = await ledger.get(args.operationId);
	const prepared = await prepareMail(operation, args.mail, previous?.rfcMessageId);
	const fingerprint = createHash("sha256").update(`gmail_send:${prepared.fingerprint}`).digest("hex");
	if (previous) return existingSend(operation, previous, "gmail_send", fingerprint);
	const unresolved = await ledger.unresolved(fingerprint, "gmail_send");
	if (unresolved) return reconcile(operation, unresolved);
	const now = new Date().toISOString();
	return dispatch(
		operation,
		ledger,
		{
			operationId: args.operationId,
			account: operation.auth.account,
			tool: "gmail_send",
			requestFingerprint: fingerprint,
			rfcMessageId: prepared.rfcMessageId,
			threadId: prepared.threadId,
			state: "in_flight",
			createdAt: now,
			updatedAt: now,
		},
		prepared.bytes,
		false,
	);
}

async function draftSend(
	args: { operationId: string; draftId: string; expectedMessageId: string },
	operation: Operation,
): Promise<Result<unknown>> {
	const ledger = new SendLedger(operation.stateDir, operation.auth.account);
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				tool: "gmail_draft_send",
				account: operation.auth.account.toLowerCase(),
				draftId: args.draftId,
				expectedMessageId: args.expectedMessageId,
			}),
		)
		.digest("hex");
	const previous = await ledger.get(args.operationId);
	if (previous) return existingSend(operation, previous, "gmail_draft_send", fingerprint);
	const unresolved = await ledger.unresolved(fingerprint, "gmail_draft_send");
	if (unresolved) return reconcile(operation, unresolved);
	const draft = await operation.call<Record<string, unknown>>("gmail", ["users", "drafts", "get"], {
		params: { userId: "me", id: args.draftId, format: "raw" },
		stdoutLimit: STDOUT_LIMITS.rawDraft,
	});
	if (!object(draft.message) || draft.message.id !== args.expectedMessageId)
		return failure(new GoogleError("DRAFT_CHANGED", "The draft revision differs from expectedMessageId."));
	const raw = decodeBase64Url(text(draft.message.raw), STDOUT_LIMITS.rawDraft);
	const rfcMessageId = newRfcMessageId();
	const bytes = rewriteRawMessage(raw, rfcMessageId);
	const now = new Date().toISOString();
	return dispatch(
		operation,
		ledger,
		{
			operationId: args.operationId,
			account: operation.auth.account,
			tool: "gmail_draft_send",
			requestFingerprint: fingerprint,
			rfcMessageId,
			draftId: args.draftId,
			draftMessageId: args.expectedMessageId,
			threadId: text(draft.message.threadId) || undefined,
			state: "in_flight",
			createdAt: now,
			updatedAt: now,
		},
		bytes,
		true,
	);
}

async function searchSummaries(operation: Operation, listed: unknown) {
	const budget = new TextBudget();
	const messages: Record<string, unknown>[] = [];
	const failures: Record<string, unknown>[] = [];
	const ids = (Array.isArray(listed) ? listed : [])
		.filter(object)
		.map((item) => item.id)
		.filter((id): id is string => typeof id === "string");
	for (const id of ids) {
		try {
			messages.push(summary(await getMessage(operation, id, "metadata", STDOUT_LIMITS.metadata), budget));
		} catch (error) {
			failures.push({ messageId: id, code: error instanceof GoogleError ? error.code : "BACKEND_ERROR" });
		}
	}
	return { messages, failures };
}

async function draftSummaries(operation: Operation, listed: unknown) {
	const budget = new TextBudget();
	const ids = (Array.isArray(listed) ? listed : [])
		.filter(object)
		.map((item) => item.id)
		.filter((id): id is string => typeof id === "string");
	const drafts = [];
	for (const id of ids) {
		const draft = await operation.call<Record<string, unknown>>("gmail", ["users", "drafts", "get"], {
			params: { userId: "me", id, format: "metadata" },
		});
		drafts.push({ draftId: id, ...(object(draft.message) ? summary(draft.message, budget) : {}) });
	}
	return drafts;
}

const gmailRead = [SCOPES.gmailRead, SCOPES.gmailModify];
const gmailSend = [SCOPES.gmailSend, SCOPES.gmailCompose, SCOPES.gmailModify];
const gmailCompose = [SCOPES.gmailCompose, SCOPES.gmailModify];

export const gmailTools: ToolSpec[] = [
	{
		name: "google_status",
		label: "Google status",
		description: "Inspect the pinned backend, expected account, observed grants and service capabilities.",
		parameters: obj({}),
		replay: "unsafe",
		execute: async (_args, runtime, signal) => runtime.status(signal),
	},
	{
		name: "gmail_search",
		label: "Gmail search",
		description: "Search Gmail with bounded metadata summaries and finite pagination.",
		parameters: obj({
			query: str({ maxLength: 4096 }),
			limit: Limit(25, 10),
			cursor: opt(str({ minLength: 1, maxLength: 4096 })),
			includeSpamTrash: opt(bool({ default: false })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailRead, profile: true }, signal, async (operation) => {
				const args = value as { query: string; limit?: number; cursor?: string; includeSpamTrash?: boolean };
				const list = await operation.call<Record<string, unknown>>("gmail", ["users", "messages", "list"], {
					params: {
						userId: "me",
						q: args.query,
						maxResults: args.limit ?? 10,
						...(args.cursor ? { pageToken: args.cursor } : {}),
						includeSpamTrash: args.includeSpamTrash ?? false,
					},
				});
				const { messages, failures } = await searchSummaries(operation, list.messages);
				const data = {
					messages,
					nextCursor: text(list.nextPageToken) || undefined,
					estimatedCount: typeof list.resultSizeEstimate === "number" ? list.resultSizeEstimate : undefined,
					fetchFailures: failures,
				};
				return failures.length ? partial(data, ["Some message metadata reads failed."]) : ok(data);
			}),
	},
	{
		name: "gmail_message_get",
		label: "Gmail message",
		description: "Read one Gmail message as a bounded body slice and attachment manifest.",
		parameters: obj({
			messageId: str({ minLength: 1, maxLength: 200 }),
			partId: opt(str({ minLength: 1, maxLength: 200 })),
			offset: opt(int({ minimum: 0, default: 0 })),
			limit: Limit(8192, 4096),
			attachmentCursor: opt(str({ pattern: "^\\d+$", maxLength: 20 })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailRead, profile: true }, signal, async (operation) => {
				const args = value as {
					messageId: string;
					partId?: string;
					offset?: number;
					limit?: number;
					attachmentCursor?: string;
				};
				return ok(await messageRead(operation, await getMessage(operation, args.messageId), args));
			}),
	},
	{
		name: "gmail_thread_get",
		label: "Gmail thread",
		description: "Read a bounded selection of full messages from one Gmail thread.",
		parameters: obj({
			threadId: str({ minLength: 1, maxLength: 200 }),
			limit: Limit(5, 3),
			cursor: opt(str({ pattern: "^\\d+$", maxLength: 20 })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailRead, profile: true }, signal, async (operation) => {
				const args = value as { threadId: string; limit?: number; cursor?: string };
				const thread = await operation.call<Record<string, unknown>>("gmail", ["users", "threads", "get"], {
					params: { userId: "me", id: args.threadId, format: "metadata" },
					stdoutLimit: STDOUT_LIMITS.message,
				});
				const all = Array.isArray(thread.messages) ? thread.messages.filter(object) : [];
				const cursor = parseCursor(args.cursor, all.length, "thread");
				const limit = args.limit ?? 3;
				const messages = [];
				for (const item of all.slice(cursor, cursor + limit))
					if (typeof item.id === "string")
						messages.push(await messageRead(operation, await getMessage(operation, item.id), { limit: 4096 }));
				return ok({
					threadId: text(thread.id, args.threadId),
					messages,
					nextCursor: cursor + limit < all.length ? String(cursor + limit) : undefined,
				});
			}),
	},
	{
		name: "gmail_attachment_download",
		label: "Gmail attachment download",
		description: "Download one Gmail attachment to an explicit new absolute file.",
		parameters: obj({
			messageId: str({ minLength: 1, maxLength: 200 }),
			partId: str({ minLength: 1, maxLength: 200 }),
			path: str({ minLength: 1, maxLength: 4096 }),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailRead, profile: true }, signal, async (operation) => {
				const args = value as { messageId: string; partId: string; path: string };
				const message = await getMessage(operation, args.messageId);
				const part = partsOf(message).find((item) => item.partId === args.partId);
				if (!part) throw new GoogleError("INVALID_ARGUMENT", `MIME part ${args.partId} is absent.`);
				const bytes = await partBytes(operation, args.messageId, part);
				if (bytes.length > ATTACHMENT_MAX_BYTES) throw new GoogleError("SIZE_LIMIT", "The attachment exceeds 25 MiB.");
				return ok({
					...(await writeNewFile(args.path, bytes)),
					source: { messageId: args.messageId, partId: args.partId },
				});
			}),
	},
	{
		name: "gmail_labels_list",
		label: "Gmail labels",
		description: "List Gmail labels with a wrapper-owned finite cursor.",
		parameters: obj({ limit: Limit(100, 50), cursor: opt(str({ pattern: "^\\d+$", maxLength: 20 })) }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailRead, profile: true }, signal, async (operation) => {
				const args = value as { limit?: number; cursor?: string };
				const response = await operation.call<Record<string, unknown>>("gmail", ["users", "labels", "list"], {
					params: { userId: "me" },
				});
				const all = Array.isArray(response.labels) ? response.labels.filter(object) : [];
				const cursor = parseCursor(args.cursor, all.length, "label");
				const limit = args.limit ?? 50;
				const budget = new TextBudget();
				return ok({
					labels: all.slice(cursor, cursor + limit).map((label) => ({
						id: text(label.id),
						type: text(label.type),
						externalData: external("gmail", { name: budget.clip(label.name, 1024).text }),
					})),
					nextCursor: cursor + limit < all.length ? String(cursor + limit) : undefined,
				});
			}),
	},
	{
		name: "gmail_drafts_list",
		label: "Gmail drafts",
		description: "List Gmail drafts with bounded message metadata.",
		parameters: obj({ limit: Limit(25, 10), cursor: opt(str({ minLength: 1, maxLength: 4096 })) }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailRead, profile: true }, signal, async (operation) => {
				const args = value as { limit?: number; cursor?: string };
				const response = await operation.call<Record<string, unknown>>("gmail", ["users", "drafts", "list"], {
					params: { userId: "me", maxResults: args.limit ?? 10, ...(args.cursor ? { pageToken: args.cursor } : {}) },
				});
				return ok({
					drafts: await draftSummaries(operation, response.drafts),
					nextCursor: text(response.nextPageToken) || undefined,
				});
			}),
	},
	{
		name: "gmail_draft_get",
		label: "Gmail draft",
		description: "Read one Gmail draft and its contained message revision.",
		parameters: obj({
			draftId: str({ minLength: 1, maxLength: 200 }),
			partId: opt(str({ minLength: 1, maxLength: 200 })),
			offset: opt(int({ minimum: 0, default: 0 })),
			limit: Limit(8192, 4096),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailRead, profile: true }, signal, async (operation) => {
				const args = value as { draftId: string; partId?: string; offset?: number; limit?: number };
				const draft = await operation.call<Record<string, unknown>>("gmail", ["users", "drafts", "get"], {
					params: { userId: "me", id: args.draftId, format: "full" },
					stdoutLimit: STDOUT_LIMITS.message,
				});
				if (!object(draft.message)) throw new GoogleError("BACKEND_SCHEMA_ERROR", "Gmail draft has no message.");
				return ok({
					draftId: text(draft.id, args.draftId),
					messageRevision: text(draft.message.id),
					message: await messageRead(operation, draft.message, args),
				});
			}),
	},
	{
		name: "gmail_operation_status",
		label: "Gmail send status",
		description: "Read a send operation record, or reconcile it against Sent without retransmission.",
		parameters: obj({ operationId: OperationId, reconcile: opt(bool({ default: false })) }),
		replay: "unsafe",
		execute: async (value, runtime, signal) => {
			const args = value as { operationId: string; reconcile?: boolean };
			return runtime.run(
				args.reconcile ? { scopes: gmailRead, profile: true } : { local: true },
				signal,
				async (operation) => {
					const record = await new SendLedger(operation.stateDir, operation.auth.account).get(args.operationId);
					if (!record)
						throw new GoogleError("OPERATION_NOT_FOUND", `No send operation exists for ${args.operationId}.`);
					return args.reconcile && record.state !== "accepted" && record.state !== "rejected"
						? reconcile(operation, record)
						: recordResult(record);
				},
			);
		},
	},
	{
		name: "gmail_draft_create",
		label: "Gmail draft create",
		description: "Create a Gmail draft from plaintext and optional local attachments.",
		parameters: obj(MailParam),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailCompose, profile: true }, signal, async (operation) => {
				const args = value as { mail: Compose };
				const prepared = await prepareMail(operation, args.mail);
				const path = await staged(operation, prepared.bytes);
				try {
					const response = await operation.call<Record<string, unknown>>("gmail", ["users", "drafts", "create"], {
						params: { userId: "me" },
						body: { message: prepared.threadId ? { threadId: prepared.threadId } : {} },
						upload: path,
						uploadContentType: "message/rfc822",
					});
					return ok({
						draftId: text(response.id),
						messageId: object(response.message) ? text(response.message.id) : "",
						threadId: object(response.message) ? text(response.message.threadId) : "",
					});
				} finally {
					await removeQuietly(path);
				}
			}),
	},
	{
		name: "gmail_draft_update",
		label: "Gmail draft update",
		description: "Replace a Gmail draft at an expected contained message revision.",
		parameters: obj({
			draftId: str({ minLength: 1, maxLength: 200 }),
			expectedMessageId: str({ minLength: 1, maxLength: 200 }),
			mail: ComposeSchema,
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailCompose, profile: true }, signal, async (operation) => {
				const args = value as { draftId: string; expectedMessageId: string; mail: Compose };
				const current = await operation.call<Record<string, unknown>>("gmail", ["users", "drafts", "get"], {
					params: { userId: "me", id: args.draftId, format: "metadata" },
				});
				if (!object(current.message) || current.message.id !== args.expectedMessageId)
					throw new GoogleError("DRAFT_CHANGED", "The draft revision differs from expectedMessageId.");
				const prepared = await prepareMail(operation, args.mail);
				const path = await staged(operation, prepared.bytes);
				try {
					const response = await operation.call<Record<string, unknown>>("gmail", ["users", "drafts", "update"], {
						params: { userId: "me", id: args.draftId },
						body: { id: args.draftId, message: prepared.threadId ? { threadId: prepared.threadId } : {} },
						upload: path,
						uploadContentType: "message/rfc822",
					});
					return ok({
						draftId: text(response.id, args.draftId),
						messageId: object(response.message) ? text(response.message.id) : "",
						threadId: object(response.message) ? text(response.message.threadId) : "",
					});
				} finally {
					await removeQuietly(path);
				}
			}),
	},
	{
		name: "gmail_draft_delete",
		label: "Gmail draft delete",
		description: "Delete a Gmail draft at an expected contained message revision.",
		parameters: obj({
			draftId: str({ minLength: 1, maxLength: 200 }),
			expectedMessageId: str({ minLength: 1, maxLength: 200 }),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailCompose, profile: true }, signal, async (operation) => {
				const args = value as { draftId: string; expectedMessageId: string };
				const current = await operation.call<Record<string, unknown>>("gmail", ["users", "drafts", "get"], {
					params: { userId: "me", id: args.draftId, format: "metadata" },
				});
				if (!object(current.message) || current.message.id !== args.expectedMessageId)
					throw new GoogleError("DRAFT_CHANGED", "The draft revision differs from expectedMessageId.");
				await operation.call("gmail", ["users", "drafts", "delete"], {
					params: { userId: "me", id: args.draftId },
					allowEmpty: true,
				});
				return ok({ draftId: args.draftId, deleted: true });
			}),
	},
	{
		name: "gmail_send",
		label: "Gmail send",
		description: "Send composed mail once under a caller operation ID, with unknown-outcome reconciliation.",
		parameters: obj({ operationId: OperationId, mail: ComposeSchema }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailSend, profile: true }, signal, async (operation) =>
				send(value as { operationId: string; mail: Compose }, operation),
			),
	},
	{
		name: "gmail_draft_send",
		label: "Gmail draft send",
		description: "Send a frozen raw draft snapshot once under a caller operation ID.",
		parameters: obj({
			operationId: OperationId,
			draftId: str({ minLength: 1, maxLength: 200 }),
			expectedMessageId: str({ minLength: 1, maxLength: 200 }),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: gmailCompose, profile: true }, signal, async (operation) =>
				draftSend(value as { operationId: string; draftId: string; expectedMessageId: string }, operation),
			),
	},
	{
		name: "gmail_labels_modify",
		label: "Gmail labels modify",
		description: "Add or remove allowed labels on one Gmail message.",
		parameters: obj({
			messageId: str({ minLength: 1, maxLength: 200 }),
			addLabelIds: opt(arr(str({ minLength: 1, maxLength: 200 }), { maxItems: 20 })),
			removeLabelIds: opt(arr(str({ minLength: 1, maxLength: 200 }), { maxItems: 20 })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: [SCOPES.gmailModify], profile: true }, signal, async (operation) => {
				const args = value as { messageId: string; addLabelIds?: string[]; removeLabelIds?: string[] };
				const add = args.addLabelIds ?? [],
					remove = args.removeLabelIds ?? [];
				if (add.length + remove.length > 20)
					throw new GoogleError("INVALID_ARGUMENT", "At most 20 label changes are allowed.");
				for (const id of [...add, ...remove])
					if (/^[A-Z][A-Z0-9_]*$/.test(id) && !["INBOX", "UNREAD", "STARRED", "IMPORTANT"].includes(id))
						throw new GoogleError("INVALID_ARGUMENT", `System label ${id} requires its separate tool or is forbidden.`);
				const response = await operation.call<Record<string, unknown>>("gmail", ["users", "messages", "modify"], {
					params: { userId: "me", id: args.messageId },
					body: { addLabelIds: add, removeLabelIds: remove },
				});
				return ok({ messageId: text(response.id, args.messageId), labelIds: strings(response.labelIds) });
			}),
	},
	...(["trash", "untrash"] as const).map(
		(action): ToolSpec => ({
			name: `gmail_${action}`,
			label: `Gmail ${action}`,
			description: `${action === "trash" ? "Move one Gmail message to Trash" : "Restore one Gmail message from Trash"}.`,
			parameters: obj({ messageId: str({ minLength: 1, maxLength: 200 }) }),
			replay: "unsafe",
			execute: async (value, runtime, signal) =>
				runtime.run({ scopes: [SCOPES.gmailModify], profile: true }, signal, async (operation) => {
					const args = value as { messageId: string };
					const response = await operation.call<Record<string, unknown>>("gmail", ["users", "messages", action], {
						params: { userId: "me", id: args.messageId },
					});
					return ok({ messageId: text(response.id, args.messageId), labelIds: strings(response.labelIds) });
				}),
		}),
	),
];
