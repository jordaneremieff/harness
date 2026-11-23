const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const CREDENTIAL_TOKEN =
	/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/i;

export function credentialFamily(payload: string): string | undefined {
	return PRIVATE_KEY_MARKER.test(payload)
		? "private-key marker"
		: CREDENTIAL_TOKEN.test(payload)
			? "recognized token prefix"
			: undefined;
}

/** Error text shares the writer's recognised credential formats, before any output clipping. */
export function redactCredentials(value: string): string {
	if (PRIVATE_KEY_MARKER.test(value)) return "[redacted credential material]";
	return value.replace(new RegExp(CREDENTIAL_TOKEN.source, "gi"), "[redacted]");
}
