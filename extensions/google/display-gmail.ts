import {
	type CardCall,
	type CardResult,
	count,
	type Data,
	field,
	list,
	object,
	pick,
	type Presenter,
	type ResultContext,
} from "./display-data.ts";

function identifiedCall(args: Data, key: string, fallback: string, ...expanded: string[]): CardCall {
	const projection = pick(args, ...expanded);
	return { subject: field(args[key]) || fallback, ...(Object.keys(projection).length ? { args: projection } : {}) };
}

function rows(data: Data, fields: [string, string][]): string[] {
	return fields.flatMap(([key, label]) => {
		const raw = data[key];
		const value = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : field(raw);
		return value ? [`${label}: ${value}`] : [];
	});
}

function phrase(value: unknown): string {
	return list(value).map(field).filter(Boolean).join(", ");
}

function messageLine(value: unknown): string[] {
	const row = object(value);
	const subject = field(object(object(row.externalData).headers).Subject);
	const ids = [field(row.draftId), field(row.messageId)].filter(Boolean).join(" / ");
	const line = [subject, ids].filter(Boolean).join(" · ");
	return line ? [line] : [];
}

const messageFields: [string, string][] = [
	["messageId", "Message ID"],
	["threadId", "Thread ID"],
];

function messageEvidence(message: Data): string[] {
	const attachments = object(message.externalData).attachments;
	const labels = phrase(message.labelIds);
	return [
		...rows(message, messageFields),
		...(Array.isArray(attachments) ? [`Attachment entries on this page: ${attachments.length}`] : []),
		...(labels ? [`Label IDs: ${labels}`] : []),
	];
}

function bodyContinuation(message: Data): Data {
	const body = object(object(message.externalData).body);
	const partId = body.partId;
	const offset = body.nextOffset;
	return typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0
		? { ...(cursor(partId) ? { partId } : {}), offset }
		: {};
}

function cursor(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function page(
	{ args, data, isError, status }: ResultContext,
	key: string,
	noun: string,
	line: (row: unknown) => string[],
	keys: string[],
	search = false,
): CardResult | undefined {
	if (isError || status === "error") return undefined;
	if (!Array.isArray(data[key])) return { outcome: "The result did not include the requested list." };
	const entries = list(data[key]);
	const next = cursor(data.nextCursor) ? { args: { ...pick(args, ...keys), cursor: data.nextCursor } } : undefined;
	const failed = search ? list(data.fetchFailures) : [];
	const details = search
		? [
				...rows(data, [["estimatedCount", "Estimated matches"]]),
				...failed.flatMap((failure) =>
					rows(object(failure), [
						["messageId", "Metadata unavailable for message"],
						["code", "Error code"],
					]),
				),
			]
		: [];
	const scope = `This page returned ${count(entries.length, noun)}${failed.length ? ` and ${count(failed.length, "metadata read failure")}` : ""}.`;
	return {
		outcome: `${scope}${next ? " A next page is available." : ""}`,
		body: entries.flatMap(line),
		details,
		...(next ? { next } : {}),
	};
}

function messagePage(message: Data, external: Data, args: Data, draft: boolean) {
	const bodyNext = bodyContinuation(message);
	const hasBodyNext = Object.hasOwn(bodyNext, "offset");
	const hasAttachmentNext = !draft && cursor(external.nextAttachmentCursor);
	const next =
		hasBodyNext || hasAttachmentNext
			? {
					args: {
						...pick(
							args,
							draft ? "draftId" : "messageId",
							"partId",
							"offset",
							"limit",
							...(!draft ? ["attachmentCursor"] : []),
						),
						...bodyNext,
						...(hasAttachmentNext ? { attachmentCursor: external.nextAttachmentCursor } : {}),
					},
				}
			: undefined;
	const sections = [hasBodyNext && "message text", hasAttachmentNext && "attachment entries"].filter(Boolean);
	const continuation = sections.length ? ` A next page is available for ${sections.join(" and ")}.` : "";
	return { next, continuation };
}

function readMessage({ args, data, isError, status }: ResultContext, draft: boolean): CardResult | undefined {
	if (isError || status === "error") return undefined;
	const message = draft ? object(data.message) : data;
	if (!field(message.messageId))
		return { outcome: `The result did not identify the ${draft ? "draft message" : "message"}.` };
	const external = object(message.externalData);
	const body = object(external.body);
	const { next, continuation } = messagePage(message, external, args, draft);
	return {
		outcome: `${draft ? "Read the draft revision." : "Read the message."}${continuation}`,
		body: messageLine(message),
		details: [
			...(draft
				? rows(data, [
						["draftId", "Draft ID"],
						["messageRevision", "Draft revision"],
					])
				: []),
			...messageEvidence(message),
			...rows(body, [["totalCodePoints", "Characters in body"]]),
		],
		...(next ? { next } : {}),
	};
}

function composeEvidence(mail: Data): Data {
	return {
		...pick(mail, "replyToMessageId"),
		...(typeof mail.text === "string" ? { text: count([...mail.text].length, "character") } : {}),
		...(Array.isArray(mail.attachments) ? { attachments: count(mail.attachments.length, "attachment") } : {}),
	};
}

function primaryRecipient(mail: Data): string {
	const recipients = list(mail.to);
	const name = field(recipients[0]);
	return name ? `${name}${recipients.length > 1 ? ` +${recipients.length - 1}` : ""}` : "";
}

function draftResult({ data, isError, status }: ResultContext, action: "created" | "updated"): CardResult | undefined {
	if (isError || status === "error") return undefined;
	return {
		outcome:
			field(data.draftId) && field(data.messageId)
				? `Gmail ${action} the draft.`
				: `The result did not confirm the ${action === "created" ? "new" : "updated"} draft revision.`,
		details: [...rows(data, [["draftId", "Draft ID"]]), ...rows(data, messageFields)],
	};
}

function sendResult({ args, data, error, status, isError }: ResultContext): CardResult | undefined {
	const failed = isError || status === "error";
	const operationId = error.operationId ?? data.operationId;
	const details = [
		...rows({ operationId, ...pick(data, "gmailMessageId", "rfcMessageId", "threadId", "draftId", "draftMessageId") }, [
			["operationId", "Operation ID"],
			["gmailMessageId", "Gmail message ID"],
			["rfcMessageId", "RFC Message-ID"],
			["threadId", "Thread ID"],
			["draftId", "Draft ID"],
			["draftMessageId", "Draft revision"],
		]),
		...rows(error, [["code", "Error code"]]),
	];
	if (!failed) {
		return data.outcome === "accepted" && field(data.gmailMessageId)
			? { outcome: "Gmail accepted the send.", details }
			: { outcome: "The result did not confirm that Gmail accepted the send.", details };
	}
	if (data.outcome === "rejected") return { outcome: "Gmail rejected the send.", details };
	const ambiguous = error.code === "SEND_RECONCILIATION_AMBIGUOUS";
	if (!ambiguous && error.code !== "SEND_OUTCOME_UNKNOWN" && data.outcome !== "unknown") return undefined;
	const next =
		cursor(operationId) && !(args.reconcile === true && args.operationId === operationId)
			? { name: "gmail_operation_status", args: { operationId, reconcile: true } }
			: undefined;
	return {
		outcome: ambiguous
			? "Multiple messages in Sent match the operation. Do not resend."
			: "The send outcome is unknown. Do not resend.",
		details,
		...(next ? { next } : {}),
	};
}

function labelResult(
	{ data, isError, status }: ResultContext,
	action: "modify" | "trash" | "untrash",
): CardResult | undefined {
	if (isError || status === "error") return undefined;
	const details = rows(data, messageFields);
	if (!field(data.messageId) || !Array.isArray(data.labelIds)) {
		return { outcome: "The result did not confirm the message labels.", details };
	}
	const labels = phrase(data.labelIds);
	if (labels) details.push(`Label IDs: ${labels}`);
	const trashed = data.labelIds.includes("TRASH");
	if (action === "modify")
		return { outcome: `Gmail returned ${count(data.labelIds.length, "label")} for the message.`, details };
	if (action === "trash" && trashed) return { outcome: "Gmail moved the message to Trash.", details };
	if (action === "untrash" && !trashed) return { outcome: "Gmail removed the message from Trash.", details };
	return { outcome: `Gmail returned the message ${trashed ? "with" : "without"} the Trash label.`, details };
}

export const gmailPresenters: Record<string, Presenter> = {
	gmail_search: {
		call: (args) => identifiedCall(args, "query", "All mail", "limit", "includeSpamTrash"),
		result: (context) =>
			page(context, "messages", "message", messageLine, ["query", "limit", "includeSpamTrash"], true),
	},
	gmail_message_get: {
		call: (args) => identifiedCall(args, "messageId", "Message", "partId", "offset", "limit", "attachmentCursor"),
		result: (context) => readMessage(context, false),
	},
	gmail_thread_get: {
		call: (args) => identifiedCall(args, "threadId", "Thread", "limit"),
		result: (context) => page(context, "messages", "message", messageLine, ["threadId", "limit"]),
	},
	gmail_attachment_download: {
		call: (args) => identifiedCall(args, "path", "Destination file", "messageId", "partId"),
		result: ({ data, isError, status }) => {
			if (isError || status === "error") return undefined;
			return {
				outcome:
					field(data.path) && typeof data.bytes === "number" && Number.isFinite(data.bytes) && data.bytes >= 0
						? `Saved ${count(data.bytes, "byte")} to the destination file.`
						: "The result did not confirm the file download.",
				details: rows(data, [["sha256", "SHA-256"]]),
			};
		},
	},
	gmail_labels_list: {
		call: (args) => identifiedCall(args, "", "Labels", "limit"),
		result: (context) =>
			page(
				context,
				"labels",
				"label",
				(value) => {
					const label = object(value);
					const name = field(object(label.externalData).name);
					const id = field(label.id);
					const line = [...new Set([name, id].filter(Boolean)), field(label.type)].filter(Boolean).join(" · ");
					return line ? [line] : [];
				},
				["limit"],
			),
	},
	gmail_drafts_list: {
		call: (args) => identifiedCall(args, "", "Drafts", "limit"),
		result: (context) => page(context, "drafts", "draft", messageLine, ["limit"]),
	},
	gmail_draft_get: {
		call: (args) => identifiedCall(args, "draftId", "Draft", "partId", "offset", "limit"),
		result: (context) => readMessage(context, true),
	},
	gmail_operation_status: {
		call: (args) => ({
			subject: field(args.operationId) || "Send operation",
			...(args.reconcile === true ? { facts: ["check against Sent"] } : {}),
		}),
		result: sendResult,
	},
	gmail_draft_create: {
		call: (args) => {
			const mail = object(args.mail);
			return { subject: field(mail.subject) || "New draft", args: composeEvidence(mail) };
		},
		result: (context) => draftResult(context, "created"),
	},
	gmail_draft_update: {
		call: (args) => ({
			subject: field(args.draftId) || "Draft",
			args: { ...pick(args, "expectedMessageId"), ...composeEvidence(object(args.mail)) },
		}),
		result: (context) => draftResult(context, "updated"),
	},
	gmail_draft_delete: {
		call: (args) => identifiedCall(args, "draftId", "Draft", "expectedMessageId"),
		result: ({ data, isError, status }) =>
			isError || status === "error"
				? undefined
				: {
						outcome:
							data.deleted === true && field(data.draftId)
								? "Gmail deleted the draft."
								: "The result did not confirm draft deletion.",
					},
	},
	gmail_send: {
		call: (args) => {
			const mail = object(args.mail);
			return {
				subject: primaryRecipient(mail) || "Email",
				args: { ...pick(args, "operationId"), ...composeEvidence(mail) },
			};
		},
		result: sendResult,
	},
	gmail_forward: {
		call: (args) => ({
			subject: primaryRecipient(args) || "Forwarded email",
			args: {
				...pick(args, "operationId", "messageId"),
				...(typeof args.text === "string" ? { text: count([...args.text].length, "character") } : {}),
				...(Array.isArray(args.attachmentPartIds)
					? { attachmentPartIds: count(args.attachmentPartIds.length, "selected part") }
					: {}),
			},
		}),
		result: sendResult,
	},
	gmail_draft_send: {
		call: (args) => identifiedCall(args, "draftId", "Draft", "operationId", "expectedMessageId"),
		result: sendResult,
	},
	gmail_labels_modify: {
		call: (args) => identifiedCall(args, "messageId", "Message", "addLabelIds", "removeLabelIds"),
		result: (context) => labelResult(context, "modify"),
	},
	gmail_trash: {
		call: (args) => identifiedCall(args, "messageId", "Message"),
		result: (context) => labelResult(context, "trash"),
	},
	gmail_untrash: {
		call: (args) => identifiedCall(args, "messageId", "Message"),
		result: (context) => labelResult(context, "untrash"),
	},
};
