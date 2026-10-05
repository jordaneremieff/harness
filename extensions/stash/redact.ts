/**
 * Deterministic credential redaction for the distillation path.
 *
 * Credential-shaped values are replaced before the transcript reaches the
 * distiller and again before the artifact is published, so redaction of these
 * recognized shapes does not depend on a model's discretion. Values outside these
 * patterns pass through unchanged. The policy is deliberately conservative:
 * shaped patterns (prefixed tokens, JWTs, bearer headers, private keys,
 * assignment values, URL userinfo) are redacted, while high-entropy strings
 * without a shape — git SHAs, UUIDs, hashes — are preserved because they are
 * ordinary, non-secret handover content.
 */

import { sanitizeTerminalText } from "./text.ts";

export const REDACTED = "[REDACTED]";

/**
 * PEM and PGP private-key armor. `[A-Z0-9 ]*` covers RSA, OPENSSH, EC, ENCRYPTED,
 * and PGP headers; `(?: BLOCK)?` covers the PGP secret-key form.
 */
const PRIVATE_KEY_BLOCK =
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * JWTs are three dot-separated base64url segments; the signature may be short.
 * Newline continuations require a token-only line; prose on the next line survives.
 */
const JWT =
	/\beyJ(?:[A-Za-z0-9_-]|\n(?=[A-Za-z0-9_.-]+(?:\n|$))){10,}\.(?:[A-Za-z0-9_-]|\n(?=[A-Za-z0-9_.-]+(?:\n|$))){10,}\.(?:[A-Za-z0-9_-]|\n(?=[A-Za-z0-9_.-]+(?:\n|$))){4,}\b/g;

/**
 * Prefixed provider tokens: sk-/pk-/rk- (Anthropic, DeepSeek, OpenAI), sk_live_ (Stripe),
 * gsk_ (Groq), csk- (Cerebras), xai-, AIza (Google), AKIA/ASIA (AWS), ghp_/gho_/ghu_/ghs_/ghr_
 * (GitHub), xoxb-/xoxp- (Slack), rt.1. (OpenAI refresh), AQ. (Google), ya29. (Google OAuth),
 * whsec_ (webhooks), SG. (SendGrid). The leading boundary excludes only alphanumerics, so
 * tokens glued to `_`, `=`, `:`, `/`, quotes or line starts still match (env-file, config-dump,
 * and export forms). Wrapped continuations require token-only lines, not next-line prose.
 */
const PREFIXED_TOKEN =
	/(?<![A-Za-z0-9])(?:sk|pk|rk)-(?:[A-Za-z0-9_-]|\n(?=[A-Za-z0-9_-]+(?:\n|$))){12,}\b|(?<![A-Za-z0-9])(?:sk_live_|gsk_|csk-|xai-|AIza|rt\.1\.|AQ\.|ya29\.|whsec_|SG\.)(?:[A-Za-z0-9_-]|\n(?=[A-Za-z0-9_-]+(?:\n|$))){16,}\b|(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}\b|(?<![A-Za-z0-9])ASIA[A-Z0-9]{16}\b|(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}\b|(?<![A-Za-z0-9])xox[baprs]-(?:[A-Za-z0-9-]|\n(?=[A-Za-z0-9-]+(?:\n|$))){20,}\b/g;

/**
 * Bearer tails follow the RFC 6750 b64token alphabet: a digit is not required.
 * Basic tails keep a digit requirement so ordinary prose ("Basic interoperability
 * is the goal") is never erased; base64 Basic values normally contain digits.
 * Authorization schemes are case-insensitive per RFC 7235.
 */
const BEARER_TOKEN = /\bBearer[ \t]+[A-Za-z0-9._~+/-]{16,}=*/gi;
const BASIC_TOKEN = /\bBasic[ \t]+(?=[A-Za-z0-9._~+/=]*[0-9])[A-Za-z0-9._~+/=]{16,}/gi;

/** Strong labels protect explicit assignments and credential-shaped inline values. */
const ASSIGNMENT_KEY_STRONG =
	"api[_-]?key|api key|apikey|access[_-]?key[_-]?id|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|authorization|password|passwd|secret[_-]?access[_-]?key|secret[_-]?key|secret|private[_-]?key|private key";

/**
 * Weak labels (token, cookie, session id) are common prose nouns: their values
 * redact only when they look credential-shaped (contain a digit or are long).
 */
const ASSIGNMENT_KEY_WEAK = "token|cookie|session[_-]?id";

const WEAK_KEYS = new Set(["token", "cookie", "sessionid"]);

function assignmentRegex(keyPattern: string, quoted: boolean, spacesInValue: boolean): RegExp {
	// Strong labels accept YAML plain-scalar values with spaces; weak labels and
	// quoted values keep their own shapes. Bare arrays stay out of this scalar
	// policy, but an enclosing passphrase can contain a redaction marker.
	const value = quoted
		? "(\"[^\"\r\n]{8,}\"|'[^'\r\n]{8,}')"
		: spacesInValue
			? "((?:\\[REDACTED\\]|[^\"',;#\r\n\\[]){8,})"
			: "([^\"'\\s,;]{8,})";
	return new RegExp(`(?<![A-Za-z0-9])(${keyPattern})(?![A-Za-z0-9])([ \t]*["']?[ \t]*[:=][ \t]*)${value}`, "gi");
}

const ASSIGNMENT_STRONG_QUOTED = assignmentRegex(ASSIGNMENT_KEY_STRONG, true, false);
const ASSIGNMENT_STRONG_BARE = assignmentRegex(ASSIGNMENT_KEY_STRONG, false, true);
// Weak labels (token, cookie, session id) never match quoted multi-word values:
// those are the ambiguous prose class and are deliberately preserved.
const ASSIGNMENT_WEAK_BARE = assignmentRegex(ASSIGNMENT_KEY_WEAK, false, false);

/**
 * URL userinfo passwords for any scheme (https, postgres, mongodb, redis, ftp).
 * The password may contain `@`; the greedy tail stops at the last `@` before a
 * path separator. URLs without a password (https://user@host) are preserved.
 */
// Start once per scheme-character run, retaining any nonletter prefix. This
// avoids quadratic retries on long non-URL words while preserving embedded URLs.
const URL_USERINFO = /(?<![a-z0-9+.-])([0-9+.-]*)([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):([^/\s]+)@/gi;

const HTTP_URL_VALUE = /^["']?https?:\/\//i;

interface RedactionReplacement {
	text: string;
	start: number;
	end: number;
	marker: number;
}

function explicitAssignment(separator: string, offset: number, end: number, source: string): boolean {
	const before = source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset);
	const lineEnd = source.indexOf("\n", end);
	const after = source.slice(end, lineEnd < 0 ? source.length : lineEnd);
	const wholeLine =
		/^[ \t]*(?:export[ \t]+)?(?:[A-Za-z_][A-Za-z0-9_-]*[_-])?["']?$/.test(before) &&
		/^[ \t\r]*(?:#[^\n]*|;)?$/.test(after);
	const jsonMember = /(?:^|[,{])[ \t]*"$/.test(before) && /^[ \t]*[,}]/.test(after) && separator.includes('"');
	return wholeLine || jsonMember;
}

function inlineTokenLength(value: string, inner: string, quoted: boolean, weak: boolean): number | undefined {
	if (quoted && /\s/.test(inner)) return;
	const token = quoted ? inner : (/^\S+/.exec(value)?.[0] ?? "");
	if (token.length < 8) return;
	if ((weak || !quoted) && !/[0-9]/.test(token) && token.length < 20) return;
	return token.length;
}

function redactAssignment(
	match: string,
	key: string,
	separator: string,
	value: string,
	offset: number,
	source: string,
): RedactionReplacement | undefined {
	const start = key.length + separator.length;
	const replacement = (text: string, length = value.length, marker = start): RedactionReplacement => ({
		text,
		start,
		end: start + length,
		marker,
	});
	// A URL value is not a secret; URL_USERINFO redacts only its userinfo part.
	if (HTTP_URL_VALUE.test(value)) return;
	const inner = value.replace(/^["']|["']$/g, "").trim();
	if (inner === REDACTED) return;
	const weak = WEAK_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""));
	if (weak || !explicitAssignment(separator, offset, offset + match.length, source)) {
		const quoted = value[0] === '"' || value[0] === "'";
		const length = inlineTokenLength(value, inner, quoted, weak);
		if (length === undefined) return;
		if (!quoted) return replacement(`${key}${separator}${REDACTED}${value.slice(length)}`, length);
	}
	// Preserve the quote style of quoted values so JSON-ish snippets stay well-formed.
	const quote = value[0];
	if (quote === '"' || quote === "'")
		return replacement(`${key}${separator}${quote}${REDACTED}${quote}`, value.length, start + 1);
	return replacement(`${key}${separator}${REDACTED}${/[ \t]+$/.exec(value)?.[0] ?? ""}`);
}

export type RedactionReport = {
	count: number;
	classes: Record<string, number>;
	contexts: string[];
};

/** Validate captured reports at the independent-command boundary. */
export function readRedactionReport(value: unknown): RedactionReport {
	const invalid = () => new Error("Invalid stash redaction report.");
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	const data = value as Record<string, unknown>;
	if (
		!Number.isSafeInteger(data.count) ||
		(data.count as number) < 0 ||
		!data.classes ||
		typeof data.classes !== "object" ||
		Array.isArray(data.classes) ||
		!Array.isArray(data.contexts) ||
		data.contexts.length > 5
	)
		throw invalid();
	const allowed = new Set([
		"private key",
		"JWT",
		"provider token",
		"Bearer",
		"Basic",
		"labeled credential",
		"URL password",
	]);
	const classes: Record<string, number> = {};
	let count = 0;
	for (const [kind, amount] of Object.entries(data.classes)) {
		if (!allowed.has(kind) || !Number.isSafeInteger(amount) || amount <= 0) throw invalid();
		classes[kind] = amount;
		count += amount;
	}
	if (count !== data.count || data.contexts.length > count) throw invalid();
	const contexts: string[] = [];
	for (const context of data.contexts) {
		if (typeof context !== "string" || context.length > 1024 || sanitizeTerminalText(context).text !== context)
			throw invalid();
		contexts.push(redactSecrets(context));
	}
	return { count, classes, contexts };
}

/** Merge safe reports without retaining source text or removed values. */
export function mergeRedactionReports(...reports: RedactionReport[]): RedactionReport {
	const result: RedactionReport = { count: 0, classes: {}, contexts: [] };
	for (const report of reports) {
		result.count += report.count;
		for (const [kind, count] of Object.entries(report.classes))
			result.classes[kind] = (result.classes[kind] ?? 0) + count;
		result.contexts.push(...report.contexts.slice(0, 5 - result.contexts.length));
	}
	return result;
}

export function redactionNotice(report: RedactionReport): string {
	if (!report.count) return "";
	const classes = Object.entries(report.classes)
		.map(([kind, count]) => `${kind}: ${count}`)
		.join(", ");
	return `Redaction notice: ${report.count} credential value(s) removed (${classes}).\n${report.contexts.map((context) => `  ${context}`).join("\n")}${report.count > report.contexts.length ? `\n  Context shown for ${report.contexts.length} of ${report.count} replacements.` : ""}`;
}

/** Count actual replacements, then take context only after every credential pass. */
export function redactSecretsWithReport(text: string): { text: string; report: RedactionReport } {
	let out = text;
	let events: { offset: number; kind: string }[] = [];
	const apply = (
		pattern: RegExp,
		kind: string,
		replace: (match: string, captures: string[], offset: number, source: string) => RedactionReplacement | undefined = (
			match,
		) => ({ text: REDACTED, start: 0, end: match.length, marker: 0 }),
	) => {
		const changes: { start: number; end: number; delta: number; marker: number }[] = [];
		let delta = 0;
		const added: typeof events = [];
		out = out.replace(pattern, (...args) => {
			const match = args[0] as string;
			const start = args[args.length - 2] as number;
			const value = replace(match, args.slice(1, -2) as string[], start, args[args.length - 1] as string);
			if (!value || value.text === match) return match;
			changes.push({ start: start + value.start, end: start + value.end, delta, marker: value.marker });
			added.push({ offset: start + delta + value.marker, kind });
			delta += value.text.length - match.length;
			return value.text;
		});
		// Events and replacements are ordered, so offset repair stays linear per pass.
		let index = 0;
		const retained: typeof events = [];
		for (const event of events) {
			while (index < changes.length && changes[index].end <= event.offset) index++;
			const change = changes[index];
			if (change && change.start <= event.offset) continue;
			event.offset += change?.delta ?? delta;
			retained.push(event);
		}
		events = [...retained, ...added].sort((left, right) => left.offset - right.offset);
	};
	apply(PRIVATE_KEY_BLOCK, "private key");
	apply(JWT, "JWT");
	apply(PREFIXED_TOKEN, "provider token");
	apply(BEARER_TOKEN, "Bearer");
	apply(BASIC_TOKEN, "Basic");
	const assignment = (match: string, captures: string[], offset: number, source: string) =>
		redactAssignment(match, captures[0], captures[1], captures[2], offset, source);
	apply(ASSIGNMENT_STRONG_QUOTED, "labeled credential", assignment);
	apply(ASSIGNMENT_STRONG_BARE, "labeled credential", assignment);
	apply(ASSIGNMENT_WEAK_BARE, "labeled credential", assignment);
	apply(URL_USERINFO, "URL password", (match, [prefix, user]) => {
		const start = prefix.length + user.length + 1;
		return { text: `${prefix}${user}:${REDACTED}@`, start, end: match.length - 1, marker: start };
	});
	const report: RedactionReport = { count: events.length, classes: {}, contexts: [] };
	for (const event of events) report.classes[event.kind] = (report.classes[event.kind] ?? 0) + 1;
	for (const event of events.slice(0, 5)) {
		const context = out.slice(Math.max(0, event.offset - 48), event.offset + REDACTED.length + 48);
		report.contexts.push(sanitizeTerminalText(context).text.replace(/\n/g, "\\n"));
	}
	return { text: out, report };
}

/** Replace every recognized credential value without changing ordinary unlabelled hashes. */
export function redactSecrets(text: string): string {
	return redactSecretsWithReport(text).text;
}

export interface RedactablePayload {
	title: string;
	summary: string;
	decisions?: string[];
	openLoops?: string[];
	nextActions?: string[];
	files?: string[];
	tags?: string[];
}

/** Scan payload and metadata strings with safe field names in notice context. */
export function redactPayloadWithReport<T extends RedactablePayload>(
	payload: T,
): { payload: T; report: RedactionReport } {
	const reports: RedactionReport[] = [];
	const output = { ...payload };
	const scan = (value: string, field: string): string => {
		const result = redactSecretsWithReport(value);
		reports.push({ ...result.report, contexts: result.report.contexts.map((context) => `${field}: ${context}`) });
		return result.text;
	};
	for (const field of [
		"title",
		"summary",
		"decisions",
		"openLoops",
		"nextActions",
		"files",
		"tags",
		"project",
		"branch",
		"sessionId",
	] as const) {
		const value = (output as Record<string, unknown>)[field];
		if (typeof value === "string") (output as Record<string, unknown>)[field] = scan(value, field);
		else if (Array.isArray(value))
			(output as Record<string, unknown>)[field] = value.map((item, index) => scan(item, `${field}[${index}]`));
	}
	return { payload: output, report: mergeRedactionReports(...reports) };
}

/** Apply the same redaction policy when a caller does not need a notice. */
export function redactPayload(payload: RedactablePayload): RedactablePayload {
	return redactPayloadWithReport(payload).payload;
}
