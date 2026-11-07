/** Native codemode source preparation: a finite default budget without changing the script. */
import { CODEMODE_OPTIONS_PREFIX, CodemodeSourceError, parseCodemodeSource } from "@earendil-works/pi-codemode";

/** Execution budget of a native script that names no `timeout_ms` in its options line. */
export const DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS = 300_000;

/** Arguments the native codemode registration accepts after preparation. */
export interface PreparedNativeCodemode {
	readonly code: string;
}

/** Largest `timeout_ms` the public source parser accepts. */
const MAX_TIMEOUT_MS = 2_147_483_647;

function validTimeout(timeoutMs: number): void {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
		throw new CodemodeSourceError(`A codemode timeout must be a positive integer up to ${MAX_TIMEOUT_MS}.`);
	}
}

/**
 * The first line of an options source, retaining its indentation and line ending.
 * `undefined` when the source has no options line.
 */
function optionsLineBounds(source: string): { readonly end: number; readonly ending: string } | undefined {
	const newline = source.indexOf("\n");
	const firstLine = newline === -1 ? source : source.slice(0, newline);
	if (!firstLine.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX)) return undefined;
	return { end: newline, ending: firstLine.endsWith("\r") ? "\r" : "" };
}

/**
 * Set the script's `timeout_ms` while preserving its other options and its source text.
 * The returned source is accepted by the public source parser.
 */
export function replaceCodemodeTimeout(source: string, timeoutMs: number): string {
	const parsed = parseCodemodeSource(source);
	validTimeout(timeoutMs);
	const options = {
		...(parsed.options.maxOutputTokens === undefined ? {} : { max_output_tokens: parsed.options.maxOutputTokens }),
		timeout_ms: timeoutMs,
	};
	const line = `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify(options)}`;
	const bounds = optionsLineBounds(source);
	if (bounds === undefined) return `${line}\n${source}`;
	const leading = source.slice(0, source.length - source.trimStart().length);
	return `${leading}${line}${bounds.ending}${source.slice(bounds.end)}`;
}

/**
 * Native codemode argument preparation. Every script gets a finite, persisted
 * execution budget; an explicitly supplied valid timeout stays as written.
 * Other argument fields pass through to normal schema validation.
 */
export function prepareNativeCodemodeArguments(args: unknown): PreparedNativeCodemode {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		throw new Error("The codemode arguments must be an object with a `code` string.");
	}
	const code = (args as { readonly code?: unknown }).code;
	if (typeof code !== "string") throw new Error("The codemode `code` argument must be a string.");
	const parsed = parseCodemodeSource(code);
	return { ...args, code: parsed.options.timeoutMs === undefined ? replaceCodemodeTimeout(code, DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS) : code };
}
