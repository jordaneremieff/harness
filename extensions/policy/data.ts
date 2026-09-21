/** Approved structured data and bounded, noncoercing JSON operations. */
import { createHash } from "node:crypto";
import { type Static, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";

export type Scalar = string | number | boolean | null;
export type Truth = true | false | "unknown";
export const UNKNOWN = Symbol("policy-unavailable");
export const DATA_LIMITS = { bindings: 64, rows: 2048, bytes: 262144, depth: 32, nodes: 16384 } as const;
export const ScalarSchema = Type.Union([Type.String({ maxLength: 4096 }), Type.Number(), Type.Boolean(), Type.Null()]);
export const DataNameSchema = Type.String({
	minLength: 1,
	maxLength: 80,
	pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$",
});
const metadata = {
	name: DataNameSchema,
	revision: Type.String({ pattern: "^[a-f0-9]{12}$" }),
	source: Type.String({ minLength: 1, maxLength: 256 }),
	capturedAt: Type.Number({ minimum: 0 }),
	maxAgeMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2592000000 })),
};
export const NamedDataSchema = Type.Object(
	{
		...metadata,
		kind: Type.Literal("table"),
		collation: Type.Optional(Type.Union([Type.Literal("exact"), Type.Literal("ascii-case-insensitive")])),
		rows: Type.Array(Type.Object({ key: ScalarSchema, value: ScalarSchema }, { additionalProperties: false }), {
			maxItems: DATA_LIMITS.rows,
		}),
	},
	{ additionalProperties: false },
);
export type NamedData = Static<typeof NamedDataSchema>;
export interface DataSnapshot {
	name: string;
	status: "ready" | "missing" | "stale" | "invalid";
	revision?: string;
	source?: string;
	capturedAt?: number;
	ageMs?: number;
	data?: NamedData;
}
export type LookupResult = { status: "unique"; value: Scalar } | { status: "missing" | "ambiguous" | "unavailable" };
const dataValidator = Compile(NamedDataSchema);
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

export function safeKey(key: string): boolean {
	return key.length > 0 && key.length <= 128 && !unsafeKeys.has(key) && !/[\u0000-\u001f\u007f]/.test(key);
}
export function validPath(path: unknown, allowEmpty = false): path is string[] {
	return (
		Array.isArray(path) &&
		path.length >= (allowEmpty ? 0 : 1) &&
		path.length <= 16 &&
		path.every((part) => typeof part === "string" && safeKey(part))
	);
}

/** One descriptor read keeps the checked property and the copied value identical. */
function jsonPropertyValue(entry: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(entry, key);
	if (!descriptor || !("value" in descriptor) || !safeKey(key)) throw new Error("Unsafe JSON property");
	return descriptor.value;
}

function copyOwnProperties(
	entry: object,
	result: unknown[] | Record<string, unknown>,
	visit: (value: unknown, depth: number) => unknown,
	depth: number,
	track: (bytes: number) => void,
): void {
	for (const key in entry) {
		if (!Object.hasOwn(entry, key)) continue;
		const value = jsonPropertyValue(entry, key);
		if (Array.isArray(entry) && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("Non-JSON array property");
		track(Buffer.byteLength(key, "utf8") + 3);
		Object.defineProperty(result, key, {
			value: visit(value, depth + 1),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
}

/** Copy one scalar JSON value, or report that the entry needs object handling. */
function copyScalar(entry: unknown, track: (bytes: number) => void): { value: unknown; done: boolean } {
	if (entry === null || typeof entry === "boolean") {
		track(5);
		return { value: entry, done: true };
	}
	if (typeof entry === "number" && Number.isFinite(entry)) {
		track(32);
		return { value: entry, done: true };
	}
	if (typeof entry === "string") {
		track(Buffer.byteLength(entry, "utf8") + 2);
		return { value: entry, done: true };
	}
	return { value: entry, done: false };
}

/** Copy one plain object or array after its prototype and cycle checks pass. */
function copyJsonObject(
	entry: object,
	depth: number,
	track: (bytes: number) => void,
	seen: Set<object>,
	visit: (value: unknown, depth: number) => unknown,
): unknown {
	const prototype = Object.getPrototypeOf(entry);
	if (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null)
		throw new Error("Policy requires plain JSON objects");
	seen.add(entry);
	const result: unknown[] | Record<string, unknown> = Array.isArray(entry) ? [] : {};
	copyOwnProperties(entry, result, visit, depth, track);
	if (Array.isArray(entry) && Object.keys(result).length !== entry.length) throw new Error("Sparse JSON array");
	seen.delete(entry);
	return result;
}

/** Reject accessors and non-JSON objects before a private copy reads values. */
export function cloneJson<T>(value: T): T {
	let nodes = 0;
	let bytes = 0;
	const seen = new Set<object>();
	const track = (entry: number) => {
		bytes += entry;
		if (bytes > DATA_LIMITS.bytes) throw new Error("JSON exceeds policy byte bound");
	};
	const visit = (entry: unknown, depth: number): unknown => {
		if (++nodes > DATA_LIMITS.nodes || depth > DATA_LIMITS.depth)
			throw new Error("JSON structure exceeds policy bounds");
		const scalar = copyScalar(entry, track);
		if (scalar.done) return scalar.value;
		if (typeof entry !== "object" || entry === null || seen.has(entry))
			throw new Error("Policy requires acyclic JSON values");
		return copyJsonObject(entry, depth, track, seen, visit);
	};
	const result = visit(value, 0);
	track(0);
	return result as T;
}

/** Missing own properties differ from a declared unavailable value. */
export function readPath(value: unknown, path: readonly string[]): { exists: boolean; value: unknown } {
	if (!validPath(path, true)) return { exists: false, value: UNKNOWN };
	let current = value;
	for (const key of path) {
		if (current === UNKNOWN) return { exists: false, value: UNKNOWN };
		if (current === null || typeof current !== "object") return { exists: false, value: undefined };
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (!descriptor) return { exists: false, value: undefined };
		if (!("value" in descriptor)) return { exists: false, value: UNKNOWN };
		current = descriptor.value;
	}
	return { exists: true, value: current };
}

export const SCHEMA_CACHE_LIMIT = 64;
const schemaValidators = new Map<string, ReturnType<typeof Compile>>();

/** Check a registered tool contract without conversion, property removal, or defaults. */
export function checkToolSchema(schema: TSchema | undefined, value: unknown): Truth {
	if (schema === undefined) return "unknown";
	try {
		const copied = cloneJson(schema);
		const key = createHash("sha256").update(JSON.stringify(copied)).digest("hex");
		if (!schemaValidators.has(key)) {
			const validator = Compile(copied);
			const oldest = schemaValidators.keys().next().value;
			if (schemaValidators.size >= SCHEMA_CACHE_LIMIT && oldest !== undefined) schemaValidators.delete(oldest);
			schemaValidators.set(key, validator);
		}
		const validator = schemaValidators.get(key);
		return validator ? validator.Check(cloneJson(value)) : "unknown";
	} catch {
		return "unknown";
	}
}

export function validateNamedData(value: unknown): string | undefined {
	try {
		const copied = cloneJson(value);
		if (!dataValidator.Check(copied)) return "Invalid named data definition";
		if (Buffer.byteLength(JSON.stringify(copied), "utf8") > DATA_LIMITS.bytes)
			return "Named data exceeds serialized byte bound";
		return undefined;
	} catch {
		return "Named data exceeds bounds or contains unsafe JSON";
	}
}

/** Data copies belong to this evaluation, not to the mutable control store. */
export function snapshotData(bindings: readonly NamedData[], now: number): Record<string, DataSnapshot> {
	const result: Record<string, DataSnapshot> = Object.create(null);
	if (bindings.length > DATA_LIMITS.bindings) throw new Error("Too many named data bindings");
	for (const binding of bindings) {
		if (!binding || typeof binding.name !== "string" || !safeKey(binding.name)) continue;
		const name = binding.name;
		if (Object.hasOwn(result, name)) {
			result[name] = { name, status: "invalid" };
			continue;
		}
		if (validateNamedData(binding) || !Number.isFinite(now) || binding.capturedAt > now) {
			result[name] = { name, status: "invalid" };
			continue;
		}
		const ageMs = now - binding.capturedAt;
		result[name] = {
			name,
			revision: binding.revision,
			source: binding.source,
			capturedAt: binding.capturedAt,
			ageMs,
			status: binding.maxAgeMs !== undefined && ageMs >= binding.maxAgeMs ? "stale" : "ready",
			data: cloneJson(binding),
		};
	}
	return result;
}

export function lookupData(snapshot: DataSnapshot | undefined, key: unknown): LookupResult {
	if (snapshot?.status !== "ready" || snapshot.data?.kind !== "table") return { status: "unavailable" };
	const fold = (value: unknown): unknown =>
		snapshot.data?.kind === "table" && snapshot.data.collation === "ascii-case-insensitive" && typeof value === "string"
			? value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
			: value;
	const query = fold(key);
	const choices = snapshot.data.rows.filter((row) => fold(row.key) === query).map((row) => row.value);
	if (!choices.length) return { status: "missing" };
	if (choices.some((choice) => choice !== choices[0])) return { status: "ambiguous" };
	return { status: "unique", value: choices[0] };
}
