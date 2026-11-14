export type RecordValue = Record<string, unknown>;
export const LIMITS = {
	visits: 128,
	slots: 512,
	scanBytes: 65536,
	matches: 20,
	readBytes: 8192,
	outputBytes: 24576,
	items: 32,
	pointerUnits: 1024,
	argumentNodes: 1024,
	argumentDepth: 16,
} as const;

export function object(value: unknown): value is RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function own(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) return undefined;
	if (!("value" in descriptor)) throw new Error("Accessor fields are not supported.");
	return descriptor.value;
}
export function input(value: unknown): RecordValue {
	if (!object(value)) throw new Error("Arguments must be an object.");
	return value;
}
export function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error(`${name} is outside its integer bounds.`);
	return value;
}
export function shortString(value: unknown, name: string, required = false, max = 256): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > max)
		throw new Error(`${name} must be a nonempty bounded string.`);
	return value;
}
export function check(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}
export function boundary(text: string, offset: number): boolean {
	return !(
		offset > 0 &&
		offset < text.length &&
		text.charCodeAt(offset) >= 0xdc00 &&
		text.charCodeAt(offset) <= 0xdfff &&
		text.charCodeAt(offset - 1) >= 0xd800 &&
		text.charCodeAt(offset - 1) <= 0xdbff
	);
}
/** UTF-8 byte cost of one code point. */
function utf8Bytes(codePoint: number): number {
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

export function page(text: string, offset: number, bytes: number, signal?: AbortSignal) {
	if (offset > text.length || !boundary(text, offset))
		throw new Error("Offset must be within the string at a Unicode boundary; offsets use UTF-16 code units.");
	let end = offset;
	let used = 0;
	while (end < text.length) {
		if ((end - offset) % 256 === 0) check(signal);
		const cp = text.codePointAt(end) ?? 0;
		const cost = utf8Bytes(cp);
		if (used + cost > bytes) break;
		used += cost;
		end += cp > 0xffff ? 2 : 1;
	}
	return {
		text: text.slice(offset, end),
		offset,
		endOffset: end,
		bytes: used,
		totalCodeUnits: text.length,
		nextOffset: end < text.length ? end : null,
	};
}
function escapeJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-\u009f\u2028\u2029]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
export function toolResult(value: unknown) {
	return { content: [{ type: "text" as const, text: escapeJson(value) }], details: {} };
}
export function fits(value: unknown, cap: number): boolean {
	return Buffer.byteLength(JSON.stringify(toolResult(value)), "utf8") <= cap;
}
export function finish(value: RecordValue, cap: number) {
	if (!fits(value, cap)) throw new Error("Output metadata exceeds the byte limit. Select a smaller field or page.");
	return value;
}
/** Copy the bounded metadata fields a record exposes at `prefix`. */
export function copyMetadataFields(result: RecordValue, value: unknown, prefix: string, keys: readonly string[]): void {
	for (const key of keys) {
		const field = own(value, key);
		if (typeof field === "string") {
			result[key] =
				field.length <= 256 ? field : { omitted: true, pointer: `${prefix}/${key}`, totalCodeUnits: field.length };
		} else if (typeof field === "boolean" || typeof field === "number") {
			result[key] = field;
		}
	}
}
export function pointerParts(pointer: string): string[] {
	if (pointer === "") return [];
	if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer))
		throw new Error("Use a JSON pointer: /field/child; escape ~ as ~0 and / as ~1.");
	const parts = pointer.slice(1).split("/");
	if (parts.length > 32) throw new Error("JSON pointer depth exceeds 32.");
	return parts.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}
export function select(value: unknown, parts: string[]): unknown {
	let selected: unknown = value;
	for (const part of parts) selected = own(selected, part);
	return selected;
}
export function descriptor(value: unknown, pointer: string): RecordValue {
	if (typeof value === "string")
		return {
			pointer,
			kind: "string",
			totalCodeUnits: value.length,
			omitted: true,
			action: "Read this pointer with offset and maxBytes.",
		};
	if (Array.isArray(value))
		return {
			pointer,
			kind: "array",
			length: value.length,
			omitted: true,
			action: "Read this pointer with offset and maxItems.",
		};
	if (object(value))
		return {
			pointer,
			kind: "object",
			omitted: true,
			action:
				"Read this pointer, or append a known child key as a JSON pointer. Opaque object keys are not enumerated.",
		};
	if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
		return { pointer, kind: "scalar", value };
	return { pointer, kind: "unsupported", omitted: true };
}
export type SearchMode = "text" | "arguments";

export function searchMode(value: unknown): SearchMode {
	if (value === undefined || value === "text") return "text";
	if (value === "arguments") return "arguments";
	throw new Error('mode must be "text" or "arguments".');
}

/** Validate an argument-search index path from a continuation position. */
export function argumentPath(value: unknown): number[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > LIMITS.argumentDepth)
		throw new Error(`position.path must be an array of at most ${LIMITS.argumentDepth} indexes.`);
	const path: number[] = [];
	for (let index = 0; index < value.length; index++) {
		const item = own(value, String(index));
		if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)
			throw new Error("position.path must contain nonnegative integer indexes.");
		path.push(item);
	}
	return path;
}

/**
 * One value reached by the tool-argument walk. `path` holds the child index at each level below the
 * arguments root (object keys in stored key order); `pointer` is a JSON pointer that history_read accepts.
 */
export type ArgumentNode =
	| { kind: "string"; path: number[]; pointer: string; value: string }
	| { kind: "container" | "value"; path: number[]; pointer: string }
	| { kind: "skipped"; reason: "depth" | "pointerLength"; path: number[] };

interface ArgumentFrame {
	readonly container: object;
	readonly keys: readonly string[] | undefined;
	readonly length: number;
	readonly pointer: string;
	index: number;
}

function argumentFrame(value: unknown, pointer: string): ArgumentFrame | undefined {
	if (Array.isArray(value)) return { container: value, keys: undefined, length: value.length, pointer, index: 0 };
	if (!object(value)) return undefined;
	const keys = Object.keys(value);
	return { container: value, keys, length: keys.length, pointer, index: 0 };
}

type ArgumentValue = { value: unknown; pointer: string | undefined };

/** The frame's current child; a child whose pointer history_read would refuse has no pointer and is not read. */
function argumentChild(frame: ArgumentFrame): ArgumentValue {
	const key = frame.keys ? frame.keys[frame.index] : String(frame.index);
	if (frame.pointer.length + 1 + key.length > LIMITS.pointerUnits) return { value: undefined, pointer: undefined };
	const pointer = `${frame.pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
	if (pointer.length > LIMITS.pointerUnits) return { value: undefined, pointer: undefined };
	return { value: own(frame.container, key), pointer };
}

/** Descend directly to the node that `start` names, opening one frame per level. */
function argumentResume(root: unknown, rootPointer: string, start: readonly number[]) {
	const frames: ArgumentFrame[] = [];
	let current: ArgumentValue = { value: root, pointer: rootPointer };
	for (const index of start) {
		const frame =
			current.pointer === undefined || frames.length >= LIMITS.argumentDepth
				? undefined
				: argumentFrame(current.value, current.pointer);
		if (!frame || index >= frame.length) throw new Error("Position does not select an argument value.");
		frame.index = index;
		frames.push(frame);
		current = argumentChild(frame);
	}
	return { frames, current };
}

function argumentNode({ value, pointer }: ArgumentValue, path: number[], depth: number): ArgumentNode {
	if (pointer === undefined) return { kind: "skipped", reason: "pointerLength", path };
	if (typeof value === "string") return { kind: "string", path, pointer, value };
	if (!Array.isArray(value) && !object(value)) return { kind: "value", path, pointer };
	if (depth >= LIMITS.argumentDepth) return { kind: "skipped", reason: "depth", path };
	return { kind: "container", path, pointer };
}

/** The next sibling of the deepest unfinished frame, closing finished frames; undefined after the last value. */
function argumentSibling(frames: ArgumentFrame[]): ArgumentValue | undefined {
	let top = frames.at(-1);
	while (top && ++top.index >= top.length) {
		frames.pop();
		top = frames.at(-1);
	}
	return top ? argumentChild(top) : undefined;
}

/**
 * Walk one tool call's arguments in pre-order, starting at the node that `start` names. Containers
 * `LIMITS.argumentDepth` levels below the root and values whose pointer exceeds the reader's limit are
 * yielded as skipped and never entered. The consumer owns the per-call node budget and stops early.
 */
export function* argumentNodes(root: unknown, rootPointer: string, start: readonly number[]): Generator<ArgumentNode> {
	const resumed = argumentResume(root, rootPointer, start);
	const frames = resumed.frames;
	let current: ArgumentValue | undefined = resumed.current;
	while (current) {
		const node = argumentNode(
			current,
			frames.map((frame) => frame.index),
			frames.length,
		);
		yield node;
		const frame = node.kind === "container" ? argumentFrame(current.value, node.pointer) : undefined;
		if (frame && frame.length > 0) {
			frames.push(frame);
			current = argumentChild(frame);
		} else current = argumentSibling(frames);
	}
}

/** A tool-call content block other than the executing call, which argument search leaves out. */
export function searchedCall(block: unknown, callId: string | undefined): boolean {
	return own(block, "type") === "toolCall" && (callId === undefined || own(block, "id") !== callId);
}

/** Argument search needs a literal query and selects tool calls, which no source filter selects. */
export function checkArgumentSearch(query: string | undefined, filter: SearchFilter | undefined): void {
	if (query === undefined) throw new Error("Argument search requires a query.");
	if (filter) throw new Error("Argument search selects tool calls; omit filter.");
}

export type SearchFilter =
	| { source: "user" }
	| { source: "summary" }
	| { source: "toolResult"; toolName?: string; errorsOnly?: boolean };

export function searchFilter(value: unknown): SearchFilter | undefined {
	if (value === undefined) return undefined;
	if (!object(value)) throw new Error("filter must be an object.");
	const source = own(value, "source");
	if (source !== "user" && source !== "toolResult" && source !== "summary")
		throw new Error("filter.source must be user, toolResult, or summary.");
	const toolName = shortString(own(value, "toolName"), "filter.toolName");
	const errorsOnly = own(value, "errorsOnly");
	if (errorsOnly !== undefined && typeof errorsOnly !== "boolean")
		throw new Error("filter.errorsOnly must be a boolean.");
	if (source !== "toolResult") {
		if (toolName !== undefined || errorsOnly !== undefined)
			throw new Error("filter.toolName and filter.errorsOnly require source toolResult.");
		return { source };
	}
	return {
		source,
		...(toolName !== undefined ? { toolName } : {}),
		...(errorsOnly !== undefined ? { errorsOnly } : {}),
	};
}
