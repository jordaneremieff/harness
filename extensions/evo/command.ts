/** Parse and sanitize the optional `/evo` hint. */

import { Buffer } from "node:buffer";

export const MAX_HINT_CODE_POINTS = 20_000;
export const MAX_RAW_HINT_BYTES = 80_000;

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\x1b\r\n\u0085\u2028\u2029]*(?:\u0007|\x1b\\))/g;
const LINE_SEPARATOR = /\r\n?|[\u0085\u2028\u2029]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const HIDDEN = /(?:\p{Cf}|\u{E0000}|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]|[\u1160\u2800\u3164\uFFA0])/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export type EvoInvocation = { ok: true; hint: string | undefined } | { ok: false; error: string };

/** The complete argument contract is one optional, variable-length hint. */
export function parseEvoInvocation(raw: string): EvoInvocation {
	if (Buffer.byteLength(raw, "utf8") > MAX_RAW_HINT_BYTES) {
		return {
			ok: false,
			error: `The raw evo hint must be ${MAX_RAW_HINT_BYTES} bytes or fewer.`,
		};
	}
	const hint = raw
		.replace(LONE_SURROGATE, "\uFFFD")
		.replace(ANSI, "")
		.replace(LINE_SEPARATOR, "\n")
		.replace(CONTROL, "")
		.replace(HIDDEN, "")
		.trim();
	if (!hint) return { ok: true, hint: undefined };
	if (Array.from(hint).length > MAX_HINT_CODE_POINTS) {
		return {
			ok: false,
			error: `The evo hint must be ${MAX_HINT_CODE_POINTS} Unicode code points or fewer.`,
		};
	}
	return { ok: true, hint };
}
