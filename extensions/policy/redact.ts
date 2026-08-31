/**
 * Secret removal for recorded command text.
 *
 * Command text is the only tool input this slice stores, and a command can
 * carry a credential. Redaction runs before every write, replaces the secret
 * span rather than the whole command, and is deliberately eager: a redacted
 * command that loses a harmless value is correct, and a stored credential is
 * not.
 */

const PLACEHOLDER = "[redacted]";
const MAX_COMMAND_CHARS = 4096;

const SENSITIVE_NAME = /(pass|passwd|password|secret|token|api[-_]?key|apikey|credential|auth|cookie|session)/i;

const PATTERNS: { pattern: RegExp; replace: (match: string, ...groups: string[]) => string }[] = [
	// NAME=value and --name=value where the name reads as a credential.
	{
		pattern: /\b([A-Za-z_][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|\S+)/g,
		replace: (match, name) => (SENSITIVE_NAME.test(name) ? `${name}=${PLACEHOLDER}` : match),
	},
	{
		pattern: /(--[A-Za-z0-9-]*(?:pass|password|secret|token|key|credential|auth)[A-Za-z0-9-]*)(\s+)(\S+)/gi,
		replace: (_match, flag, gap) => `${flag}${gap}${PLACEHOLDER}`,
	},
	// Authorization headers and bearer tokens.
	{
		pattern: /((?:authorization|proxy-authorization)\s*:\s*)([^\s"']+(?:\s+[^\s"']+)?)/gi,
		replace: (_match, label) => `${label}${PLACEHOLDER}`,
	},
	{ pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_match, scheme) => `${scheme} ${PLACEHOLDER}` },
	// Credentials inside a URL.
	{
		pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@]+)@/gi,
		replace: (_match, scheme, user) => `${scheme}${user}:${PLACEHOLDER}@`,
	},
	// Vendor-prefixed key shapes.
	{ pattern: /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, replace: () => PLACEHOLDER },
	{ pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: () => PLACEHOLDER },
	{ pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: () => PLACEHOLDER },
	{ pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: () => PLACEHOLDER },
	// Long opaque runs that no ordinary path or flag produces.
	{ pattern: /\b[A-Fa-f0-9]{40,}\b/g, replace: () => PLACEHOLDER },
];

/** Remove credential shapes from command text and bound its length. */
export function redactCommand(command: string): string {
	let text = command;
	for (const { pattern, replace } of PATTERNS) {
		text = text.replace(pattern, replace as (substring: string, ...args: unknown[]) => string);
	}
	if (text.length > MAX_COMMAND_CHARS) {
		return `${text.slice(0, MAX_COMMAND_CHARS)}…`;
	}
	return text;
}
