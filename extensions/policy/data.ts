/** Approved structured data and bounded, noncoercing JSON operations. */
import { createHash } from "node:crypto";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Type } from "typebox";
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
export const NamedDataSchema = Type.Union([
	Type.Object(
		{
			...metadata,
			kind: Type.Literal("table"),
			rows: Type.Array(Type.Object({ key: ScalarSchema, value: ScalarSchema }, { additionalProperties: false }), {
				maxItems: DATA_LIMITS.rows,
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...metadata, kind: Type.Literal("schema"), schema: Type.Record(Type.String(), Type.Unknown()) },
		{ additionalProperties: false },
	),
]);
interface DataMetadata {
	name: string;
	revision: string;
	source: string;
	capturedAt: number;
	maxAgeMs?: number;
}
export type NamedData = DataMetadata &
	({ kind: "table"; rows: { key: Scalar; value: Scalar }[] } | { kind: "schema"; schema: Record<string, unknown> });
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

/** Reject accessors and non-JSON objects before a private copy reads values. */
export function cloneJson<T>(value: T): T {
	let nodes = 0;
	let bytes = 0;
	const seen = new Set<object>();
	const visit = (entry: unknown, depth: number): unknown => {
		if (++nodes > DATA_LIMITS.nodes || depth > DATA_LIMITS.depth)
			throw new Error("JSON structure exceeds policy bounds");
		if (entry === null || typeof entry === "boolean") {
			bytes += 5;
			return entry;
		}
		if (typeof entry === "number" && Number.isFinite(entry)) {
			bytes += 32;
			return entry;
		}
		if (typeof entry === "string") {
			bytes += Buffer.byteLength(entry, "utf8") + 2;
			if (bytes > DATA_LIMITS.bytes) throw new Error("JSON exceeds policy byte bound");
			return entry;
		}
		if (typeof entry !== "object" || entry === null || seen.has(entry))
			throw new Error("Policy requires acyclic JSON values");
		const prototype = Object.getPrototypeOf(entry);
		if (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null)
			throw new Error("Policy requires plain JSON objects");
		seen.add(entry);
		const result: unknown[] | Record<string, unknown> = Array.isArray(entry) ? [] : {};
		for (const key in entry) {
			if (!Object.hasOwn(entry, key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(entry, key)!;
			if (!("value" in descriptor) || !safeKey(key)) throw new Error("Unsafe JSON property");
			if (Array.isArray(entry) && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("Non-JSON array property");
			bytes += Buffer.byteLength(key, "utf8") + 3;
			if (bytes > DATA_LIMITS.bytes) throw new Error("JSON exceeds policy byte bound");
			Object.defineProperty(result, key, {
				value: visit(descriptor.value, depth + 1),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		if (Array.isArray(entry) && Object.keys(result).length !== entry.length) throw new Error("Sparse JSON array");
		seen.delete(entry);
		return result;
	};
	const result = visit(value, 0);
	if (bytes > DATA_LIMITS.bytes) throw new Error("JSON exceeds policy byte bound");
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
const schemaValidators = new Map<string, ValidateFunction | undefined>();

function compileSchema(schema: unknown): ValidateFunction | undefined {
	const copied = cloneJson(schema) as Record<string, unknown> | boolean;
	const declared = typeof copied === "object" ? copied.$schema : undefined;
	let dialect: "draft-07" | "2019-09" | "2020-12";
	if (
		declared === undefined ||
		declared === "http://json-schema.org/draft-07/schema#" ||
		declared === "http://json-schema.org/draft-07/schema" ||
		declared === "https://json-schema.org/draft-07/schema#" ||
		declared === "https://json-schema.org/draft-07/schema"
	)
		dialect = "draft-07";
	else if (
		declared === "https://json-schema.org/draft/2019-09/schema" ||
		declared === "https://json-schema.org/draft/2019-09/schema#"
	)
		dialect = "2019-09";
	else if (
		declared === "https://json-schema.org/draft/2020-12/schema" ||
		declared === "https://json-schema.org/draft/2020-12/schema#"
	)
		dialect = "2020-12";
	else return undefined;
	if (typeof copied === "object" && declared !== undefined)
		copied.$schema =
			dialect === "draft-07"
				? "http://json-schema.org/draft-07/schema#"
				: `https://json-schema.org/draft/${dialect}/schema`;
	const options = {
		strictSchema: true,
		strictNumbers: true,
		strictTypes: false,
		strictTuples: false,
		strictRequired: false,
		allowUnionTypes: true,
		allowMatchingProperties: true,
		allErrors: false,
		validateSchema: true,
		validateFormats: true,
		coerceTypes: false,
		useDefaults: false,
		removeAdditional: false,
		ownProperties: true,
		logger: false as const,
		addUsedSchema: false,
	};
	const validator =
		dialect === "2020-12" ? new Ajv2020(options) : dialect === "2019-09" ? new Ajv2019(options) : new Ajv(options);
	addFormats.default(validator);
	const compiled = validator.compile(copied as AnySchema);
	return "$async" in compiled && compiled.$async ? undefined : (compiled as ValidateFunction);
}

/** Validate the schema itself, then check values without conversion, removal, or defaults. */
export function checkSchema(schema: unknown, value: unknown): Truth {
	if (typeof schema !== "boolean" && (typeof schema !== "object" || schema === null || Array.isArray(schema)))
		return "unknown";
	try {
		const copied = cloneJson(schema);
		const key = createHash("sha256").update(JSON.stringify(copied)).digest("hex");
		if (!schemaValidators.has(key)) {
			let validator: ValidateFunction | undefined;
			try {
				validator = compileSchema(copied);
			} catch {
				validator = undefined;
			}
			if (schemaValidators.size >= SCHEMA_CACHE_LIMIT) schemaValidators.delete(schemaValidators.keys().next().value!);
			schemaValidators.set(key, validator);
		}
		const validator = schemaValidators.get(key);
		return validator ? validator(cloneJson(value)) === true : "unknown";
	} catch {
		return "unknown";
	}
}

export function validateNamedData(value: unknown): string | undefined {
	try {
		const copied = cloneJson(value);
		if (!dataValidator.Check(copied)) return "Invalid named data definition";
		const data = copied as NamedData;
		if (data.kind === "schema" && checkSchema(data.schema, null) === "unknown") return "Unavailable schema validator";
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
	const choices = snapshot.data.rows.filter((row) => row.key === key).map((row) => row.value);
	if (!choices.length) return { status: "missing" };
	if (choices.some((choice) => choice !== choices[0])) return { status: "ambiguous" };
	return { status: "unique", value: choices[0] };
}
