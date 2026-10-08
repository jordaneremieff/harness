import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const DOCUMENT_MAX_BYTES = 131072;
export const PUBLICATION_MAX_BYTES = 262144;
export const SETTINGS_MAX_FIELDS = 128;
export const SETTINGS_MAX_SLICES = 64;
export const SETTINGS_PUBLISH = "harness:settings:publish";
export const SETTINGS_REQUEST = "harness:settings:request";
export const README_START = "<!-- harness:settings:start -->";
export const README_END = "<!-- harness:settings:end -->";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Environment = Readonly<Record<string, string | undefined>>;
export type Origin = "env" | "file" | "default";
export type SettingType = "string" | "path" | "integer" | "number" | "boolean" | "enum" | "json";

type DefaultContext = { agentDir: string; get: <S extends AnySetting>(setting: S) => SettingValue<S> };
const DEFAULT_FACTORY = Symbol("settings-default-factory");
export type DerivedDefault<T> = {
	readonly [DEFAULT_FACTORY]: true;
	description: string;
	dependencies: readonly AnySetting[];
	resolve: (context: DefaultContext) => T;
};
export function derivedDefault<T>(
	description: string,
	dependencies: readonly AnySetting[],
	resolver: (context: DefaultContext) => T,
): DerivedDefault<T> {
	return { [DEFAULT_FACTORY]: true, description, dependencies, resolve: resolver };
}

type Options<T> = {
	description: string;
	env?: string;
	secret?: boolean;
	default?: T | DerivedDefault<T>;
	validate?: (value: T) => boolean;
};
type TextOptions = Options<string> & { minLength?: number; maxLength?: number };
type PathOptions = TextOptions & { absolute?: boolean };
type NumericOptions = Options<number> & { min?: number; max?: number };
export type Setting<T, O = Options<T>> = {
	type: SettingType;
	options: O;
	accept: (value: unknown) => value is T;
};
// Function variance is intentionally erased only at the heterogeneous declaration boundary.
export type AnySetting = {
	type: SettingType;
	accept: (value: unknown) => boolean;
	options: {
		description: string;
		env?: string;
		secret?: boolean;
		validate?: (value: never) => boolean;
		default?: unknown;
		min?: number;
		max?: number;
		minLength?: number;
		maxLength?: number;
		absolute?: boolean;
		choices?: readonly string[];
	};
};
export type SettingValue<S> =
	S extends Setting<infer T, infer O>
		? O extends { default: infer D }
			? undefined extends D
				? T | undefined
				: T
			: T | undefined
		: never;
export type SettingsValues<F> = { [K in keyof F]: SettingValue<F[K]> };
export type Declaration<F extends Record<string, AnySetting> = Record<string, AnySetting>> = {
	slice: string;
	fields: F;
};

function textValid(value: unknown): value is string {
	return typeof value === "string" && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
}
function textSetting<const O extends TextOptions>(type: "string" | "path", options: O): Setting<string, O> {
	return { type, options, accept: textValid };
}
export function stringSetting<const O extends TextOptions>(options: O): Setting<string, O> {
	return textSetting("string", options);
}
export function pathSetting<const O extends PathOptions>(options: O): Setting<string, O> {
	return textSetting("path", options);
}
export function integerSetting<const O extends NumericOptions>(options: O): Setting<number, O> {
	return {
		type: "integer",
		options,
		accept: (value): value is number => typeof value === "number" && Number.isSafeInteger(value),
	};
}
export function numberSetting<const O extends NumericOptions>(options: O): Setting<number, O> {
	return {
		type: "number",
		options,
		accept: (value): value is number => typeof value === "number" && Number.isFinite(value),
	};
}
export function booleanSetting<const O extends Options<boolean>>(options: O): Setting<boolean, O> {
	return { type: "boolean", options, accept: (value): value is boolean => typeof value === "boolean" };
}
export function enumSetting<const C extends readonly string[], const O extends Options<C[number]>>(
	choices: C,
	options: O,
): Setting<C[number], O & { choices: C }> {
	return {
		type: "enum",
		options: { ...options, choices },
		accept: (value): value is C[number] => typeof value === "string" && choices.includes(value),
	};
}
export function jsonSetting<T>(
	validator: (value: unknown) => value is T,
): <const O extends Options<T>>(options: O) => Setting<T, O> {
	return (options) => ({ type: "json", options, accept: validator });
}

function derived(value: unknown): value is DerivedDefault<unknown> {
	return object(value) && DEFAULT_FACTORY in value && value[DEFAULT_FACTORY] === true;
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[a-z][a-zA-Z0-9]*$/.test(value) && value.length <= 64;
}
function snake(value: string): string {
	return value
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toUpperCase();
}
export function envName(slice: string, key: string, setting: AnySetting): string {
	return setting.options.env ?? `PI_${snake(slice)}_${snake(key)}`;
}
function validateBounds(options: AnySetting["options"]): void {
	for (const bound of [options.min, options.max]) {
		if (bound !== undefined && !Number.isFinite(bound)) throw new Error("Invalid setting bound");
	}
	for (const bound of [options.minLength, options.maxLength]) {
		if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0))
			throw new Error("Invalid setting length bound");
	}
	if (
		(options.min ?? -Infinity) > (options.max ?? Infinity) ||
		(options.minLength ?? 0) > (options.maxLength ?? Infinity)
	)
		throw new Error("Inverted setting bounds");
}
function validateDefaultDependencies(setting: AnySetting, fields: Record<string, AnySetting>): void {
	const fallback = setting.options.default;
	if (!derived(fallback)) return;
	if (!boundedText(fallback.description, 2048)) throw new Error("Invalid derived default description");
	for (const dependency of fallback.dependencies) {
		if (!Object.values(fields).includes(dependency) || dependency.options.secret)
			throw new Error("Default dependency must be a declared nonsecret setting");
	}
}
function validateDeclarationField(key: string, setting: AnySetting, fields: Record<string, AnySetting>): void {
	if (!identifier(key) || !boundedText(setting.options.description, 2048) || !setting.options.description.length)
		throw new Error("Invalid setting declaration");
	if (setting.options.secret && (setting.type !== "string" || Object.hasOwn(setting.options, "default")))
		throw new Error("Secrets are strings without defaults");
	validateBounds(setting.options);
	validateDefaultDependencies(setting, fields);
}
export function defineSettings<const F extends Record<string, AnySetting>>(slice: string, fields: F): Declaration<F> {
	if (!identifier(slice) || slice === "version") throw new Error("Invalid settings slice name");
	if (Object.keys(fields).length > SETTINGS_MAX_FIELDS) throw new Error("Too many declared settings");
	if (new Set(Object.values(fields)).size !== Object.keys(fields).length)
		throw new Error("Each setting reference must identify one field");
	const names = new Set<string>();
	for (const [key, setting] of Object.entries(fields)) {
		validateDeclarationField(key, setting, fields);
		const name = envName(slice, key, setting);
		if (!/^PI_[A-Z][A-Z0-9_]*$/.test(name) || name.length > 128 || names.has(name))
			throw new Error("Invalid or duplicate setting environment name");
		names.add(name);
	}
	return { slice, fields };
}

export type Diagnostic = {
	field: string;
	source: Origin;
	code: "document" | "unknown" | "secret" | "invalid" | "coverage" | "relation";
	message: string;
};
export type Source = {
	path: string;
	status: "loaded" | "missing" | "invalid" | "unavailable";
	digest: string | null;
	observedAt: string;
};
export type SettingRecord = {
	name: string;
	key: string;
	type: SettingType;
	description: string;
	env: string;
	secret: boolean;
	origin: Origin;
	status: "valid" | "unset" | "invalid";
	value?: Json;
	secretState?: "set" | "unset";
};
export type SettingsPublication = {
	version: 1;
	slice: string;
	source: Source;
	records: SettingRecord[];
	diagnostics: Diagnostic[];
};
export type Snapshot<F extends Record<string, AnySetting>> = SettingsPublication & { values: SettingsValues<F> };
export type ReadOptions = { agentDir: string; env?: Environment };
export type PublishOptions<F extends Record<string, AnySetting>> = ReadOptions & {
	validate?: (snapshot: Readonly<Snapshot<F>>) => readonly (keyof F & string)[];
};

export function settingsPath({ agentDir, env = process.env }: ReadOptions): string {
	if (!isAbsolute(agentDir) || !textValid(agentDir) || agentDir.length > 4096)
		throw new Error("agentDir must be an absolute directory path");
	const override = env.PI_HARNESS_FILE;
	if (override !== undefined && (!textValid(override) || !override.length || override.length > 4096))
		throw new Error("PI_HARNESS_FILE must be a nonempty path");
	const path = resolve(agentDir, override ?? "harness.json");
	if (path.length > 4096) throw new Error("Configuration path exceeds length limit");
	return path;
}
function diagnostic(field: string, source: Origin, code: Diagnostic["code"]): Diagnostic {
	const messages = {
		document: "Configuration document is invalid or unavailable.",
		unknown: "Unknown setting in this section.",
		secret: "Secret settings are environment-only; document input was rejected.",
		invalid: "Selected input is invalid; the safe default is in effect.",
		coverage: "Additional diagnostics were omitted at the diagnostic limit.",
		relation: "Effective settings violate an owning cross-field constraint; values are unchanged.",
	};
	return { field, source, code, message: messages[code] };
}
function boundedRead(fd: number): Buffer {
	const bytes = Buffer.alloc(DOCUMENT_MAX_BYTES + 1);
	let length = 0;
	while (length < bytes.length) {
		const count = readSync(fd, bytes, length, bytes.length - length, length);
		if (!count) break;
		length += count;
	}
	return bytes.subarray(0, length);
}
function readDocument(options: ReadOptions): {
	source: Source;
	document?: Record<string, unknown>;
	diagnostics: Diagnostic[];
} {
	const source: Source = {
		path: settingsPath({ agentDir: options.agentDir, env: {} }),
		status: "unavailable",
		digest: null,
		observedAt: new Date().toISOString(),
	};
	try {
		source.path = settingsPath(options);
	} catch {
		return { source, diagnostics: [diagnostic("PI_HARNESS_FILE", "env", "document")] };
	}
	let fd: number | undefined;
	let readComplete = false;
	try {
		fd = openSync(source.path, constants.O_RDONLY | constants.O_NONBLOCK);
		if (!fstatSync(fd).isFile()) throw new Error("Nonregular source");
		const content = boundedRead(fd);
		readComplete = true;
		if (content.length > DOCUMENT_MAX_BYTES) throw new Error("Oversized document");
		source.digest = createHash("sha256").update(content).digest("hex");
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content));
		if (!object(value) || value.version !== 1) throw new Error("Invalid document envelope");
		source.status = "loaded";
		return { source, document: value, diagnostics: [] };
	} catch (error) {
		if (object(error) && error.code === "ENOENT") return { source: { ...source, status: "missing" }, diagnostics: [] };
		source.status = readComplete ? "invalid" : "unavailable";
		return { source, diagnostics: [diagnostic("document", "file", "document")] };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function plainObject(value: unknown): value is Record<string, unknown> {
	if (!object(value)) return false;
	return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}
function jsonValue(value: unknown): value is Json {
	let nodes = 0;
	function visit(item: unknown, depth: number): boolean {
		if (++nodes > 10000 || depth > 32) return false;
		if (item === null || typeof item === "boolean") return true;
		if (typeof item === "number") return Number.isFinite(item);
		if (typeof item === "string") return item.length <= DOCUMENT_MAX_BYTES && !/[\u0000\ud800-\udfff]/u.test(item);
		if (Array.isArray(item)) return item.every((child) => visit(child, depth + 1));
		if (!plainObject(item)) return false;
		return Object.entries(item).every(
			([key, child]) => textValid(key) && key.length <= 4096 && visit(child, depth + 1),
		);
	}
	try {
		return visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= DOCUMENT_MAX_BYTES;
	} catch {
		return false;
	}
}
function parseEnv(setting: AnySetting, raw: string): unknown {
	if (Buffer.byteLength(raw) > DOCUMENT_MAX_BYTES) throw new Error("Oversized environment input");
	if (setting.type === "json") return JSON.parse(raw);
	if (setting.type === "boolean") {
		if (raw === "1" || raw === "true") return true;
		if (raw === "0" || raw === "false") return false;
		return undefined;
	}
	if (setting.type === "number" || setting.type === "integer") {
		if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return undefined;
		return Number(raw);
	}
	return raw;
}
function validateValueBounds(setting: AnySetting, value: unknown): void {
	const options = setting.options;
	if (typeof value === "number" && (value < (options.min ?? -Infinity) || value > (options.max ?? Infinity)))
		throw new Error("Out of bounds");
	if (typeof value !== "string") return;
	const minLength = options.minLength ?? (setting.type === "path" || options.secret ? 1 : 0);
	if (value.length < minLength || value.length > (options.maxLength ?? 4096)) throw new Error("Out of bounds");
}
function resolveSettingPath(setting: AnySetting, value: unknown, agentDir: string): unknown {
	if (setting.type !== "path") return value;
	if (typeof value !== "string" || (setting.options.absolute && !isAbsolute(value)))
		throw new Error("Absolute path required");
	const path = resolve(agentDir, value);
	if (path.length > (setting.options.maxLength ?? 4096)) throw new Error("Resolved path exceeds length bound");
	return path;
}
function checked(setting: AnySetting, value: unknown, agentDir: string): unknown {
	if (!jsonValue(value) || !setting.accept(value)) throw new Error("Invalid setting value");
	validateValueBounds(setting, value);
	const resolved = resolveSettingPath(setting, value, agentDir);
	if (setting.options.validate && !setting.options.validate(resolved as never))
		throw new Error("Validator rejected setting");
	return resolved;
}

type Selection = { value: unknown; origin: Origin; invalid: boolean };
type SelectionContext = {
	env: Environment;
	section: Record<string, unknown>;
	agentDir: string;
	add: (fact: Diagnostic) => void;
};
function inputOrigin(name: string, key: string, setting: AnySetting, context: SelectionContext): Origin | undefined {
	if (context.env[name] !== undefined) return "env";
	if (!setting.options.secret && Object.hasOwn(context.section, key)) return "file";
	return undefined;
}
function selectSetting(
	slice: string,
	key: string,
	setting: AnySetting,
	fallback: unknown,
	context: SelectionContext,
): Selection {
	const field = `${slice}.${key}`;
	const name = envName(slice, key, setting);
	const invalid = !!setting.options.secret && Object.hasOwn(context.section, key);
	if (invalid) context.add(diagnostic(field, "file", "secret"));
	const origin = inputOrigin(name, key, setting, context);
	if (origin === undefined) return { value: fallback, origin: "default", invalid };
	try {
		const input = origin === "env" ? parseEnv(setting, context.env[name] as string) : context.section[key];
		return { value: checked(setting, input, context.agentDir), origin, invalid };
	} catch {
		context.add(diagnostic(field, origin, "invalid"));
		return { value: fallback, origin: "default", invalid: true };
	}
}
function settingRecord(slice: string, key: string, setting: AnySetting, selected: Selection): SettingRecord {
	const record: SettingRecord = {
		name: `${slice}.${key}`,
		key,
		type: setting.type,
		description: setting.options.description,
		env: envName(slice, key, setting),
		secret: !!setting.options.secret,
		origin: selected.origin,
		status: selected.invalid ? "invalid" : selected.value === undefined ? "unset" : "valid",
	};
	if (record.secret) record.secretState = selected.value === undefined ? "unset" : "set";
	else if (selected.value !== undefined) record.value = structuredClone(selected.value) as Json;
	return record;
}

export function readSettings<F extends Record<string, AnySetting>>(
	declaration: Declaration<F>,
	options: ReadOptions,
): Snapshot<F> {
	const { source, document, diagnostics } = readDocument(options);
	const env = options.env ?? process.env;
	const values: Record<string, unknown> = Object.create(null);
	const records = new Map<string, SettingRecord>();
	const sectionValue = document && Object.hasOwn(document, declaration.slice) ? document[declaration.slice] : undefined;
	let section: Record<string, unknown> = {};
	if (sectionValue !== undefined) {
		if (object(sectionValue)) section = sectionValue;
		else diagnostics.push(diagnostic(declaration.slice, "file", "invalid"));
	}
	const add = (fact: Diagnostic) => {
		if (diagnostics.length < SETTINGS_MAX_FIELDS * 2) diagnostics.push(fact);
		else if (!diagnostics.some((item) => item.code === "coverage"))
			diagnostics.push(diagnostic("coverage", "file", "coverage"));
	};
	for (const key of Object.keys(section)) {
		if (!Object.hasOwn(declaration.fields, key))
			add(diagnostic(`${declaration.slice}.${textValid(key) ? key.slice(0, 64) : "<invalid-key>"}`, "file", "unknown"));
	}
	const resolving = new Set<string>();
	function resolveFallback(setting: AnySetting, field: string): unknown {
		let fallback: unknown = setting.options.default;
		if (derived(fallback)) {
			const derivation = fallback;
			try {
				fallback = derivation.resolve({
					agentDir: options.agentDir,
					get: (dependency) => {
						if (!derivation.dependencies.includes(dependency)) throw new Error("Undeclared default dependency");
						const key = Object.keys(declaration.fields).find(
							(candidate) => declaration.fields[candidate] === dependency,
						);
						if (key === undefined) throw new Error("Unknown default dependency");
						return resolveField(key) as SettingValue<typeof dependency>;
					},
				});
			} catch {
				throw new Error(`Invalid default derivation for ${field}`);
			}
		}
		if (fallback === undefined) return;
		try {
			return checked(setting, fallback, options.agentDir);
		} catch {
			throw new Error(`Invalid default for ${field}`);
		}
	}
	function resolveField(key: string): unknown {
		if (records.has(key)) return values[key];
		if (resolving.has(key)) throw new Error("Cyclic setting default dependencies");
		resolving.add(key);
		const setting = declaration.fields[key];
		const field = `${declaration.slice}.${key}`;
		const fallback = resolveFallback(setting, field);
		const selected = selectSetting(declaration.slice, key, setting, fallback, {
			env,
			section,
			agentDir: options.agentDir,
			add,
		});
		values[key] = selected.value;
		records.set(key, settingRecord(declaration.slice, key, setting, selected));
		resolving.delete(key);
		return selected.value;
	}
	for (const key of Object.keys(declaration.fields)) resolveField(key);
	return {
		version: 1,
		slice: declaration.slice,
		source,
		values: values as SettingsValues<F>,
		records: Object.keys(declaration.fields).map((key) => records.get(key) as SettingRecord),
		diagnostics,
	};
}

export function settingsPublication(snapshot: SettingsPublication): SettingsPublication {
	const publication: SettingsPublication = {
		version: 1,
		slice: snapshot.slice,
		source: {
			path: snapshot.source.path,
			status: snapshot.source.status,
			digest: snapshot.source.digest,
			observedAt: snapshot.source.observedAt,
		},
		records: snapshot.records.map((record) => ({
			name: record.name,
			key: record.key,
			type: record.type,
			description: record.description,
			env: record.env,
			secret: record.secret,
			origin: record.origin,
			status: record.status,
			...(record.secret
				? { secretState: record.secretState }
				: record.value === undefined
					? {}
					: { value: record.value }),
		})),
		diagnostics: snapshot.diagnostics.map((fact) => diagnostic(fact.field, fact.source, fact.code)),
	};
	if (Buffer.byteLength(JSON.stringify(publication)) > PUBLICATION_MAX_BYTES)
		throw new Error("Settings publication exceeds byte limit");
	return structuredClone(publication);
}
export type SettingsBus = {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
};
function request(value: unknown): boolean {
	return object(value) && value.version === 1;
}
export function publishSettings<F extends Record<string, AnySetting>>(
	bus: SettingsBus,
	declaration: Declaration<F>,
	options: PublishOptions<F>,
): () => void {
	const publish = () => {
		const snapshot = readSettings(declaration, options);
		const fields = options.validate ? options.validate(structuredClone(snapshot)) : [];
		if (
			!Array.isArray(fields) ||
			fields.length > snapshot.records.length ||
			fields.some((key) => typeof key !== "string" || !Object.hasOwn(declaration.fields, key))
		)
			throw new Error("Publication validation must return declared field keys");
		for (const key of new Set(fields)) {
			const record = snapshot.records.find((item) => item.key === key);
			if (!record) throw new Error("Publication validation field is unavailable");
			record.status = "invalid";
			snapshot.diagnostics.push(diagnostic(record.name, record.origin, "relation"));
		}
		bus.emit(SETTINGS_PUBLISH, settingsPublication(snapshot));
	};
	const unsubscribe = bus.on(SETTINGS_REQUEST, (value) => {
		if (request(value)) publish();
	});
	try {
		publish();
	} catch (error) {
		unsubscribe();
		throw error;
	}
	return unsubscribe;
}

function boundedText(value: unknown, max: number): value is string {
	return textValid(value) && value.length <= max;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
	return typeof value === "string" && choices.includes(value as T);
}
function publicationSource(input: unknown): Source {
	if (!object(input) || !boundedText(input.path, 4096) || !isAbsolute(input.path))
		throw new Error("Invalid source path");
	if (!oneOf(input.status, ["loaded", "missing", "invalid", "unavailable"]) || !boundedText(input.observedAt, 64))
		throw new Error("Invalid source state");
	if (input.digest !== null && (typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest)))
		throw new Error("Invalid source digest");
	return { path: input.path, status: input.status, observedAt: input.observedAt, digest: input.digest };
}
function recordHeader(input: unknown, slice: string): SettingRecord {
	if (!object(input) || !identifier(input.key) || input.name !== `${slice}.${input.key}`)
		throw new Error("Invalid record identity");
	if (
		!oneOf(input.type, ["string", "path", "integer", "number", "boolean", "enum", "json"]) ||
		!boundedText(input.description, 2048)
	)
		throw new Error("Invalid record metadata");
	if (!boundedText(input.env, 128) || !/^PI_[A-Z][A-Z0-9_]*$/.test(input.env) || typeof input.secret !== "boolean")
		throw new Error("Invalid record environment");
	if (!oneOf(input.origin, ["env", "file", "default"]) || !oneOf(input.status, ["valid", "unset", "invalid"]))
		throw new Error("Invalid record status");
	return {
		name: input.name as string,
		key: input.key,
		type: input.type,
		description: input.description,
		env: input.env,
		secret: input.secret,
		origin: input.origin,
		status: input.status,
	};
}
function validSecretRecord(input: Record<string, unknown>, record: SettingRecord): boolean {
	if (record.type !== "string" || Object.hasOwn(input, "value") || !oneOf(input.secretState, ["set", "unset"]))
		return false;
	if (input.secretState === "set" && record.origin !== "env") return false;
	if (record.status === "valid" && input.secretState !== "set") return false;
	return record.status !== "unset" || input.secretState === "unset";
}
function validPublishedValue(type: SettingType, value: Json): boolean {
	switch (type) {
		case "string":
		case "enum":
			return textValid(value);
		case "path":
			return textValid(value) && isAbsolute(value);
		case "integer":
			return typeof value === "number" && Number.isSafeInteger(value);
		case "number":
			return typeof value === "number";
		case "boolean":
			return typeof value === "boolean";
		case "json":
			return true;
	}
}
function recordValue(input: Record<string, unknown>, record: SettingRecord): void {
	if (Object.hasOwn(input, "secretState")) throw new Error("Nonsecret record has secret state");
	const hasValue = Object.hasOwn(input, "value");
	if ((record.status === "valid" && !hasValue) || (record.status === "unset" && hasValue))
		throw new Error("Value/status mismatch");
	if (!hasValue) return;
	if (!jsonValue(input.value) || !validPublishedValue(record.type, input.value))
		throw new Error("Invalid published value");
	record.value = structuredClone(input.value);
}
function publicationRecord(input: unknown, slice: string): SettingRecord {
	const record = recordHeader(input, slice);
	if (!object(input)) throw new Error("Invalid record");
	if (record.secret) {
		if (!validSecretRecord(input, record)) throw new Error("Invalid secret record");
		record.secretState = input.secretState as "set" | "unset";
	} else recordValue(input, record);
	return record;
}
function publicationDiagnostic(input: unknown): Diagnostic {
	if (
		!object(input) ||
		!boundedText(input.field, 256) ||
		!oneOf(input.source, ["env", "file", "default"]) ||
		!oneOf(input.code, ["document", "unknown", "secret", "invalid", "coverage", "relation"])
	)
		throw new Error("Invalid diagnostic");
	// Messages come from this contract, not from untrusted exception text.
	return diagnostic(input.field, input.source, input.code);
}
export function parseSettingsPublication(input: unknown): SettingsPublication | undefined {
	try {
		if (!object(input) || input.version !== 1 || !identifier(input.slice)) return;
		if (!Array.isArray(input.records) || !Array.isArray(input.diagnostics)) return;
		if (input.records.length > SETTINGS_MAX_FIELDS || input.diagnostics.length > SETTINGS_MAX_FIELDS * 3 + 1) return;
		const source = publicationSource(input.source);
		const slice = input.slice;
		const records = input.records.map((record) => publicationRecord(record, slice));
		if (new Set(records.map((record) => record.key)).size !== records.length) return;
		const diagnostics = input.diagnostics.map(publicationDiagnostic);
		return settingsPublication({ version: 1, slice, source, records, diagnostics });
	} catch {
		return;
	}
}

export type SettingsCoverage = {
	status: "available" | "unavailable" | "disposed";
	slices: string[];
	malformed: number;
	omitted: number;
};
export function collectSettings(bus: SettingsBus): {
	snapshots: () => SettingsPublication[];
	coverage: () => SettingsCoverage;
	refresh: () => void;
	dispose: () => void;
} {
	const publications = new Map<string, SettingsPublication>();
	let disposed = false;
	let status: SettingsCoverage["status"] = "available";
	let malformed = 0;
	let omitted = 0;
	const unsubscribe = bus.on(SETTINGS_PUBLISH, (input) => {
		if (disposed) return;
		const publication = parseSettingsPublication(input);
		if (!publication) {
			malformed = Math.min(Number.MAX_SAFE_INTEGER, malformed + 1);
			return;
		}
		if (!publications.has(publication.slice) && publications.size >= SETTINGS_MAX_SLICES) {
			omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
			return;
		}
		publications.set(publication.slice, publication);
	});
	const refresh = () => {
		if (!disposed) {
			publications.clear();
			malformed = 0;
			omitted = 0;
			status = "available";
			try {
				bus.emit(SETTINGS_REQUEST, { version: 1 });
			} catch (error) {
				status = "unavailable";
				throw error;
			}
		}
	};
	try {
		refresh();
	} catch (error) {
		unsubscribe();
		throw error;
	}
	return {
		snapshots: () => structuredClone([...publications.values()].sort((a, b) => a.slice.localeCompare(b.slice))),
		coverage: () => ({ status, slices: [...publications.keys()].sort(), malformed, omitted }),
		refresh,
		dispose: () => {
			if (!disposed) {
				disposed = true;
				status = "disposed";
				unsubscribe();
				publications.clear();
			}
		},
	};
}

function cell(value: string): string {
	return value
		.replace(/\|/g, "\\|")
		.replace(/[\r\n]/g, " ")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
function defaultDescription(setting: AnySetting): string {
	if (setting.options.secret) return "env-only";
	if (derived(setting.options.default)) return setting.options.default.description;
	return setting.options.default === undefined ? "unset" : JSON.stringify(setting.options.default);
}
function constraintsDescription(options: AnySetting["options"]): string {
	const bounds = ["min", "max", "minLength", "maxLength"] as const;
	const parts = bounds.filter((key) => options[key] !== undefined).map((key) => `${key} ${options[key]}`);
	if (options.absolute) parts.push("absolute input");
	if (options.choices) parts.push(options.choices.join(", "));
	return parts.join("; ") || "none";
}
export function settingsReadme(declaration: Declaration): string {
	const rows = Object.entries(declaration.fields).map(([key, setting]) => {
		const fallback = cell(defaultDescription(setting));
		const bounds = cell(constraintsDescription(setting.options));
		return `| ${key} | \`${envName(declaration.slice, key, setting)}\` | ${setting.type} | ${fallback} | ${bounds} | ${cell(setting.options.description)} |`;
	});
	return [
		README_START,
		"| Key | Environment | Type | Default | Constraints | Description |",
		"|---|---|---|---|---|---|",
		...rows,
		README_END,
	].join("\n");
}

export function checkSettingsReadme(declaration: Declaration, readme: string): boolean {
	const start = readme.indexOf(README_START);
	const end = readme.indexOf(README_END, start);
	return (
		start >= 0 &&
		end >= start &&
		readme.indexOf(README_START, start + README_START.length) < 0 &&
		readme.indexOf(README_END, end + README_END.length) < 0 &&
		readme.slice(start, end + README_END.length) === settingsReadme(declaration)
	);
}
