import { createHash, randomUUID } from "node:crypto";
import type { Snapshot } from "./files.ts";
import { GoogleError } from "./result.ts";

export const COMPOSE_LIMITS = {
	recipients: 50,
	textBytes: 64 * 1024,
	forwardTextBytes: 1024 * 1024,
	attachments: 10,
	attachmentBytes: 10 * 1024 * 1024,
	mimeBytes: 15 * 1024 * 1024,
} as const;

export type Compose = {
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject?: string;
	text: string;
	replyToMessageId?: string;
	attachments?: { path: string; filename?: string; mimeType?: string }[];
};

export type PreparedAttachment = Snapshot & { filename: string; mimeType: string };
export type ReplyContext = {
	gmailId: string;
	rfcMessageId: string;
	references?: string;
	subject: string;
	threadId?: string;
};
export type PreparedMime = { bytes: Buffer; rfcMessageId: string; fingerprint: string; threadId?: string };

function headerValue(value: string): void {
	if (/[\r\n\0]/.test(value))
		throw new GoogleError("INVALID_ARGUMENT", "Header values must not contain CR, LF or NUL.");
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if ((code < 32 && code !== 9) || code === 127)
			throw new GoogleError("INVALID_ARGUMENT", "Header values must not contain control characters.");
	}
}

function base64Lines(bytes: Buffer): string {
	return bytes
		.toString("base64")
		.replace(/.{1,76}/g, "$&\r\n")
		.trimEnd();
}

function encodedWords(value: string): string {
	const words: string[] = [];
	let current = "";
	for (const char of value) {
		const candidate = current + char;
		if (Buffer.from(candidate, "utf8").toString("base64").length > 60 && current) {
			words.push(current);
			current = char;
		} else current = candidate;
	}
	if (current) words.push(current);
	return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

function foldAscii(name: string, value: string): string {
	const prefix = `${name}: `;
	const lines: string[] = [];
	let line = prefix;
	for (const word of value.split(/(\s+)/)) {
		if (line.length + word.length > 78 && line.trim() !== prefix.trim()) {
			lines.push(line.trimEnd());
			line = ` ${word.trimStart()}`;
		} else line += word;
	}
	lines.push(line.trimEnd());
	return lines.join("\r\n");
}

function header(name: string, value: string): string {
	headerValue(value);
	return /^[\x20-\x7e]*$/.test(value) ? foldAscii(name, value) : `${name}: ${encodedWords(value)}`;
}

function addresses(values: string[] | undefined, field: string): string[] {
	if (!values) return [];
	for (const value of values) {
		headerValue(value);
		if (!value.trim()) throw new GoogleError("INVALID_ARGUMENT", `${field} contains an empty recipient.`);
	}
	return values;
}

function filenameParameters(filename: string): string {
	headerValue(filename);
	if (!filename || /[/\\]/.test(filename))
		throw new GoogleError("INVALID_ARGUMENT", "Attachment filenames must be nonempty base names.");
	const fallback = filename.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "attachment";
	return `filename="${fallback.replaceAll('"', "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function fingerprintValue(
	mail: Compose,
	account: string,
	attachments: PreparedAttachment[],
	reply?: ReplyContext,
	subject?: string,
): string {
	const value = {
		account: account.toLowerCase(),
		to: [...mail.to].sort(),
		cc: [...(mail.cc ?? [])].sort(),
		bcc: [...(mail.bcc ?? [])].sort(),
		subject,
		text: mail.text,
		reply: reply
			? {
					gmailId: reply.gmailId,
					rfcMessageId: reply.rfcMessageId,
					references: reply.references ?? "",
					threadId: reply.threadId ?? "",
				}
			: undefined,
		attachments: attachments.map((attachment) => ({
			filename: attachment.filename,
			mimeType: attachment.mimeType,
			sha256: attachment.sha256,
		})),
	};
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function newRfcMessageId(): string {
	return `<${randomUUID()}@pi.local>`;
}

function checkLimits(
	mail: Compose,
	attachments: PreparedAttachment[],
	reply: ReplyContext | undefined,
	textBytes: number,
) {
	const to = addresses(mail.to, "to");
	const cc = addresses(mail.cc, "cc");
	const bcc = addresses(mail.bcc, "bcc");
	const total = to.length + cc.length + bcc.length;
	if (!to.length || total > COMPOSE_LIMITS.recipients)
		throw new GoogleError(
			"INVALID_ARGUMENT",
			`Mail requires at least one To recipient and at most ${COMPOSE_LIMITS.recipients} recipients.`,
		);
	if (Buffer.byteLength(mail.text) > textBytes)
		throw new GoogleError("SIZE_LIMIT", `Mail text exceeds ${textBytes} bytes.`);
	const attachmentBytes = attachments.reduce((sum, item) => sum + item.size, 0);
	if (attachments.length > COMPOSE_LIMITS.attachments || attachmentBytes > COMPOSE_LIMITS.attachmentBytes) {
		throw new GoogleError("SIZE_LIMIT", "Mail exceeds the attachment count or byte limit.");
	}
	if (reply && !to.length) throw new GoogleError("INVALID_ARGUMENT", "Replies require explicit recipients.");
	return { to, cc, bcc };
}

function stripReplyPrefix(subject: string): string {
	return subject.replace(/^(?:re:\s*)+/i, "");
}

function resolveSubject(mail: Compose, reply: ReplyContext | undefined): string {
	let subject = mail.subject;
	if (reply) {
		if (subject && stripReplyPrefix(subject) !== stripReplyPrefix(reply.subject))
			throw new GoogleError("INVALID_ARGUMENT", "A reply subject must match the original thread subject.");
		subject ??= /^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`;
	}
	if (!subject) throw new GoogleError("INVALID_ARGUMENT", "A new message requires a subject.");
	headerValue(subject);
	return subject;
}

function replyHeaders(reply: ReplyContext | undefined): string[] {
	if (!reply) return [];
	const references = [...(reply.references ? [reply.references] : []), reply.rfcMessageId].join(" ");
	return [header("In-Reply-To", reply.rfcMessageId), header("References", references)];
}

function mimeBody(headers: string[], text: string, attachments: PreparedAttachment[]): string {
	const encodedText = base64Lines(Buffer.from(text.replaceAll(/\r?\n/g, "\r\n"), "utf8"));
	if (!attachments.length) {
		return `${[...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"].join("\r\n")}\r\n\r\n${encodedText}\r\n`;
	}
	const boundary = `pi-${randomUUID()}`;
	const parts = [
		`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodedText}\r\n`,
		...attachments.map(
			(attachment) =>
				`--${boundary}\r\nContent-Type: ${attachment.mimeType}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; ${filenameParameters(attachment.filename)}\r\n\r\n${base64Lines(attachment.bytes)}\r\n`,
		),
	];
	return `${[...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`].join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--\r\n`;
}

export function buildMime(
	mail: Compose,
	account: string,
	attachments: PreparedAttachment[],
	reply?: ReplyContext,
	forcedMessageId?: string,
	textBytes: number = COMPOSE_LIMITS.textBytes,
): PreparedMime {
	const { to, cc, bcc } = checkLimits(mail, attachments, reply, textBytes);
	const subject = resolveSubject(mail, reply);
	const rfcMessageId = forcedMessageId ?? newRfcMessageId();
	if (!/^<[^<>\s]+@[^<>\s]+>$/.test(rfcMessageId))
		throw new GoogleError("ADAPTER_ERROR", "Invalid generated RFC Message-ID.");
	const headers = [
		header("From", account),
		header("To", to.join(", ")),
		...(cc.length ? [header("Cc", cc.join(", "))] : []),
		...(bcc.length ? [header("Bcc", bcc.join(", "))] : []),
		header("Subject", subject),
		header("Date", new Date().toUTCString().replace("GMT", "+0000")),
		header("Message-ID", rfcMessageId),
		"MIME-Version: 1.0",
		...replyHeaders(reply),
	];
	const bytes = Buffer.from(mimeBody(headers, mail.text, attachments), "utf8");
	if (bytes.length > COMPOSE_LIMITS.mimeBytes)
		throw new GoogleError("SIZE_LIMIT", `Complete MIME exceeds ${COMPOSE_LIMITS.mimeBytes} bytes.`);
	return {
		bytes,
		rfcMessageId,
		fingerprint: fingerprintValue(mail, account, attachments, reply, subject),
		threadId: reply?.threadId,
	};
}

export function replyContext(message: Record<string, unknown>, gmailId: string): ReplyContext {
	const payload = message.payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		throw new GoogleError("BACKEND_SCHEMA_ERROR", "The original Gmail message has no payload.");
	const headers = (payload as Record<string, unknown>).headers;
	if (!Array.isArray(headers))
		throw new GoogleError("BACKEND_SCHEMA_ERROR", "The original Gmail message has no headers.");
	const get = (name: string) => {
		const wanted = name.toLowerCase();
		const item = headers.find(
			(header) =>
				typeof header === "object" &&
				header !== null &&
				String((header as Record<string, unknown>).name).toLowerCase() === wanted,
		) as Record<string, unknown> | undefined;
		return typeof item?.value === "string" ? item.value : undefined;
	};
	const rfcMessageId = get("Message-ID");
	if (!rfcMessageId)
		throw new GoogleError(
			"INVALID_ARGUMENT",
			"The original message has no RFC Message-ID, so a threaded reply cannot be composed.",
		);
	return {
		gmailId,
		rfcMessageId,
		references: get("References") ?? get("In-Reply-To"),
		subject: get("Subject") ?? "",
		threadId: typeof message.threadId === "string" ? message.threadId : undefined,
	};
}

/** Replace only a strictly parsed Message-ID header and preserve every body byte. */
export function rewriteRawMessage(raw: Buffer, rfcMessageId: string): Buffer {
	const crlf = raw.indexOf("\r\n\r\n");
	const lf = raw.indexOf("\n\n");
	const useCrlf = crlf >= 0 && (lf < 0 || crlf <= lf);
	const separator = useCrlf ? crlf : lf;
	if (separator < 0) throw new GoogleError("INVALID_ARGUMENT", "The stored draft has no MIME header terminator.");
	const headerText = new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, separator));
	if (headerText.includes("\0"))
		throw new GoogleError("INVALID_ARGUMENT", "The stored draft has invalid MIME headers.");
	const lines = headerText.split(useCrlf ? "\r\n" : "\n");
	for (const line of lines) {
		if (!line) throw new GoogleError("INVALID_ARGUMENT", "The stored draft has an empty MIME header line.");
		if (/^[ \t]/.test(line)) continue;
		if (!/^[!-9;-~]+:/.test(line))
			throw new GoogleError("INVALID_ARGUMENT", "The stored draft has a malformed MIME header line.");
	}
	const kept = lines.filter((line, index) => {
		if (/^Message-ID:/i.test(line)) return false;
		if (index > 0 && /^[ \t]/.test(line) && /^Message-ID:/i.test(lines[index - 1])) return false;
		return true;
	});
	kept.push(`Message-ID: ${rfcMessageId}`);
	const ending = useCrlf ? "\r\n" : "\n";
	return Buffer.concat([Buffer.from(kept.join(ending), "utf8"), raw.subarray(separator)]);
}

export function bareMessageId(rfcMessageId: string): string {
	return rfcMessageId.replace(/^<|>$/g, "");
}
