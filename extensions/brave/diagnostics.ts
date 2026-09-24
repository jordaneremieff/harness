import { STATUS_CODES } from "node:http";

/** Emit only the media type, never arbitrary parameters from a remote header. */
export function diagnosticContentType(value: string | null | undefined): string {
	if (!value) return "(not supplied)";
	const type = value.split(";", 1)[0].trim().toLowerCase();
	return type.length <= 200 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "(invalid media type)";
}

/** Retry advice is server evidence, not a locally guessed reset time. */
export function diagnosticRetryAfter(value: string | null | undefined): string | undefined {
	if (!value || value.length > 64) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) return trimmed;
	if (
		/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
			trimmed,
		)
	) {
		const date = new Date(trimmed);
		if (Number.isFinite(date.getTime()) && date.toUTCString() === trimmed) return trimmed;
	}
	return undefined;
}

/** URLs come from the validated request, not remote status text or error bodies. */
export function responseDiagnostic(
	url: string,
	status?: number,
	contentType?: string | null,
	retryAfter?: string | null,
): string {
	const lines = [`Final URL: ${url}`];
	if (status !== undefined) lines.push(`HTTP ${status} ${STATUS_CODES[status] ?? "Unknown Status"}`);
	if (status !== undefined || contentType !== undefined)
		lines.push(`Content type: ${diagnosticContentType(contentType)}`);
	const retry = diagnosticRetryAfter(retryAfter);
	if (retry !== undefined) lines.push(`Retry-After: ${retry}`);
	return lines.join("\n");
}

/** Error messages and arbitrary codes can contain credentials; retain known codes only. */
export function diagnosticNetworkCode(error: unknown): string {
	const allowed = new Set([
		"ENOTFOUND",
		"ENODATA",
		"EAI_AGAIN",
		"ETIMEOUT",
		"ETIMEDOUT",
		"ECONNREFUSED",
		"ECONNRESET",
		"ENETUNREACH",
		"EHOSTUNREACH",
		"EPIPE",
		"ERR_TLS_CERT_ALTNAME_INVALID",
		"CERT_HAS_EXPIRED",
		"DEPTH_ZERO_SELF_SIGNED_CERT",
		"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		"HPE_HEADER_OVERFLOW",
	]);
	const cause = error instanceof Error ? error.cause : undefined;
	for (const candidate of [error, cause]) {
		const code =
			typeof candidate === "object" && candidate !== null && "code" in candidate ? candidate.code : undefined;
		if (typeof code === "string" && allowed.has(code)) return ` (${code})`;
	}
	return "";
}
