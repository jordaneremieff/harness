/*
 * Best-effort secret removal for recorded command text.
 *
 * Command text is the only tool input this slice stores. Redaction is bounded,
 * runs before persistence, and favors removal when a recognized credential
 * shape is ambiguous. It cannot identify an arbitrary unlabelled secret.
 */

const PLACEHOLDER = "[redacted]";
const MAX_COMMAND_CHARS = 4096;

const SENSITIVE_WORDS = new Set([
	"auth",
	"authorization",
	"cookie",
	"credential",
	"credentials",
	"key",
	"pass",
	"passphrase",
	"passwd",
	"password",
	"sas",
	"secret",
	"session",
	"sessionid",
	"sig",
	"signature",
	"token",
]);
const SENSITIVE_NAMES = new Set([
	"accesskeyid",
	"accesstoken",
	"accountkey",
	"apikey",
	"awssecretaccesskey",
	"awssessiontoken",
	"clientsecret",
	"consumersecret",
	"idtoken",
	"privatekey",
	"refreshtoken",
	"sharedaccesssignature",
	"signingkey",
]);

function isSensitiveName(name: string): boolean {
	const separated = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	const words = separated
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (words.some((word) => SENSITIVE_WORDS.has(word))) return true;
	return SENSITIVE_NAMES.has(words.join(""));
}

const VALUE = `("[^"\\n]*"|'[^'\\n]*'|[^\\s;&|"']+)`;

function redactNamedAssignments(text: string): string {
	const pattern = new RegExp(`\\b([A-Za-z_][A-Za-z0-9_.-]*)(\\s*=\\s*)${VALUE}`, "g");
	return text.replace(pattern, (match, name: string, separator: string) =>
		isSensitiveName(name) ? `${name}${separator}${PLACEHOLDER}` : match,
	);
}

function redactJsonValues(text: string): string {
	const pattern = new RegExp(`(["'])([A-Za-z_][A-Za-z0-9_.-]*)\\1(\\s*:\\s*)${VALUE}`, "g");
	return text.replace(pattern, (match, quote: string, name: string, separator: string) =>
		isSensitiveName(name) ? `${quote}${name}${quote}${separator}${PLACEHOLDER}` : match,
	);
}

function redactHeaders(text: string): string {
	const pattern = /(\b([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*)((?:[^"'\n]*)(?=["'])|[^\s"';&|]+)/g;
	return text.replace(pattern, (match, label: string, name: string) =>
		isSensitiveName(name) ? `${label}${PLACEHOLDER}` : match,
	);
}

function redactLongFlags(text: string): string {
	const pattern = new RegExp(`(--[A-Za-z0-9][A-Za-z0-9-]*)(=|\\s+)${VALUE}`, "g");
	return text.replace(pattern, (match, flag: string, separator: string) =>
		isSensitiveName(flag.slice(2)) ? `${flag}${separator}${PLACEHOLDER}` : match,
	);
}

function redactToolFlag(text: string, tool: string, flags: string): string {
	const pattern = new RegExp(`(\\b${tool}\\b[^;|&\\n]*?(?:${flags})(?:=|\\s+))${VALUE}`, "gi");
	let result = text;
	for (;;) {
		const next = result.replace(pattern, (_match, prefix: string) => `${prefix}${PLACEHOLDER}`);
		if (next === result) return result;
		result = next;
	}
}

function redactKnownToolFlags(text: string): string {
	let result = text;
	result = redactToolFlag(result, "curl", "-u|--user");
	result = redactToolFlag(result, "sshpass", "-p");
	result = redactToolFlag(result, "redis-cli", "-a");
	result = redactToolFlag(result, "docker\\s+login", "-p");
	result = redactToolFlag(result, "openssl", "-k|-pass");
	result = redactToolFlag(result, "mysql", "-p");
	result = result.replace(/(\bmysql\b[^;|&\n]*?\s-p)([^\s;|&"']+)/gi, `$1${PLACEHOLDER}`);
	return result;
}

function redactOpaqueBase64(text: string): string {
	return text.replace(/\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, (candidate) => {
		if (/^[A-Fa-f0-9]+$/.test(candidate)) return candidate;
		return /[+/=]/.test(candidate) || (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate) && /\d/.test(candidate))
			? PLACEHOLDER
			: candidate;
	});
}

/** Remove recognized credential shapes from command text and bound its length. */
export function redactCommand(command: string): string {
	const truncated = command.length > MAX_COMMAND_CHARS;
	let text = command.slice(0, MAX_COMMAND_CHARS);
	text = text.replace(
		/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
		PLACEHOLDER,
	);
	text = redactJsonValues(text);
	text = redactHeaders(text);
	text = redactNamedAssignments(text);
	text = redactLongFlags(text);
	text = redactKnownToolFlags(text);
	text = text.replace(
		/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
		(_match, scheme: string) => `${scheme} ${PLACEHOLDER}`,
	);
	text = text.replace(
		/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@"']*):([^\s@"']+)@/gi,
		(_match, scheme: string, user: string) => `${scheme}${user}:${PLACEHOLDER}@`,
	);
	text = text.replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]{12,}/g, PLACEHOLDER);
	text = text.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, PLACEHOLDER);
	text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, PLACEHOLDER);
	text = text.replace(/\bxox(?:[abposrc]-|e\.xoxp-)[A-Za-z0-9-]{8,}/g, PLACEHOLDER);
	text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, PLACEHOLDER);
	text = text.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, PLACEHOLDER);
	text = text.replace(/\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, PLACEHOLDER);
	text = redactOpaqueBase64(text);
	return truncated ? `${text}…` : text;
}
