/**
 * Deterministic credential redaction for the distillation path.
 *
 * Credential-shaped values are replaced before the transcript reaches the
 * distiller and again before the artifact is published, so no secret can pass
 * through on a model's discretion. The policy is deliberately conservative:
 * shaped patterns (prefixed tokens, JWTs, bearer headers, private keys,
 * assignment values, URL userinfo) are redacted, while high-entropy strings
 * without a shape — git SHAs, UUIDs, hashes — are preserved because they are
 * ordinary, non-secret handover content.
 */

export const REDACTED = "[REDACTED]";

/**
 * PEM and PGP private-key armor. `[A-Z0-9 ]*` covers RSA, OPENSSH, EC, ENCRYPTED,
 * and PGP headers; `(?: BLOCK)?` covers the PGP secret-key form.
 */
const PRIVATE_KEY_BLOCK =
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * JWTs are three dot-separated base64url segments; the signature may be short.
 * `\n` is allowed inside segments because long tokens wrap in terminal output.
 */
const JWT = /\beyJ[A-Za-z0-9_\n-]{10,}\.[A-Za-z0-9_\n-]{10,}\.[A-Za-z0-9_\n-]{4,}\b/g;

/**
 * Prefixed provider tokens: sk-/pk-/rk- (Anthropic, DeepSeek, OpenAI), sk_live_ (Stripe),
 * gsk_ (Groq), csk- (Cerebras), xai-, AIza (Google), AKIA/ASIA (AWS), ghp_/gho_/ghu_/ghs_/ghr_
 * (GitHub), xoxb-/xoxp- (Slack), rt.1. (OpenAI refresh), AQ. (Google), ya29. (Google OAuth),
 * whsec_ (webhooks), SG. (SendGrid). The leading boundary excludes only alphanumerics, so
 * tokens glued to `_`, `=`, `:`, `/`, quotes or line starts still match (env-file, config-dump,
 * and export forms). `\n` is allowed inside the token because long tokens wrap in terminal output.
 */
const PREFIXED_TOKEN =
	/(?<![A-Za-z0-9])(?:sk|pk|rk)-[A-Za-z0-9_\n-]{12,}\b|(?<![A-Za-z0-9])(?:sk_live_|gsk_|csk-|xai-|AIza|rt\.1\.|AQ\.|ya29\.|whsec_|SG\.)[A-Za-z0-9_\n-]{16,}\b|(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}\b|(?<![A-Za-z0-9])ASIA[A-Z0-9]{16}\b|(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}\b|(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9\n-]{20,}\b/g;

/**
 * Bearer tails follow the RFC 6750 b64token alphabet: a digit is not required.
 * Basic tails keep a digit requirement so ordinary prose ("Basic interoperability
 * is the goal") is never erased; base64 Basic values normally contain digits.
 * Authorization schemes are case-insensitive per RFC 7235.
 */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi;
const BASIC_TOKEN = /\bBasic\s+(?=[A-Za-z0-9._~+/=]*[0-9])[A-Za-z0-9._~+/=]{16,}/gi;

/** Strong labels always redact an 8+ character value. */
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
	// quoted values keep their own shapes. `[` is excluded so a redacted
	// placeholder is never re-matched by a later pass.
	const value = quoted
		? '("[^"]{8,}"|\'[^\']{8,}\')'
		: spacesInValue
			? "([^\"',;#\n\\[]{8,})"
			: "([^\"'\\s,;]{8,})";
	return new RegExp(`(?<![A-Za-z0-9])(${keyPattern})(?![A-Za-z0-9])(\\s*["']?\\s*[:=]\\s*)${value}`, "gi");
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
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):([^/\s]+)@/gi;

const HTTP_URL_VALUE = /^["']?https?:\/\//i;

function redactAssignment(match: string, key: string, separator: string, value: string): string {
	// A URL value is not a secret; URL_USERINFO redacts only its userinfo part.
	if (HTTP_URL_VALUE.test(value)) return match;
	// Weak labels need a credential-shaped value; prose survives.
	if (WEAK_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""))) {
		const inner = value.replace(/^["']|["']$/g, "");
		if (!/[0-9]/.test(inner) && inner.length < 20) return match;
	}
	// Preserve the quote style of quoted values so JSON-ish snippets stay well-formed.
	const quote = value[0];
	if (quote === '"' || quote === "'") return `${key}${separator}${quote}${REDACTED}${quote}`;
	return `${key}${separator}${REDACTED}`;
}

/** Replace every credential-shaped value in one text with the redaction marker. */
export function redactSecrets(text: string): string {
	let out = text;
	out = out.replace(PRIVATE_KEY_BLOCK, REDACTED);
	out = out.replace(JWT, REDACTED);
	out = out.replace(PREFIXED_TOKEN, REDACTED);
	out = out.replace(BEARER_TOKEN, () => REDACTED);
	out = out.replace(BASIC_TOKEN, () => REDACTED);
	out = out.replace(ASSIGNMENT_STRONG_QUOTED, redactAssignment);
	out = out.replace(ASSIGNMENT_STRONG_BARE, redactAssignment);
	out = out.replace(ASSIGNMENT_WEAK_BARE, redactAssignment);
	out = out.replace(URL_USERINFO, (_match, user: string) => `${user}:[REDACTED]@`);
	return out;
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

/** Apply the redaction policy to every string field of a distill payload. */
export function redactPayload(payload: RedactablePayload): RedactablePayload {
	const redactList = (items?: string[]): string[] | undefined => items?.map(redactSecrets);
	return {
		title: redactSecrets(payload.title),
		summary: redactSecrets(payload.summary),
		decisions: redactList(payload.decisions),
		openLoops: redactList(payload.openLoops),
		nextActions: redactList(payload.nextActions),
		files: redactList(payload.files),
		tags: redactList(payload.tags),
	};
}
