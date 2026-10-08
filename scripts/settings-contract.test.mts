import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Declaration, type Field, validateSettingsDeclaration } from "./check-slices.mts";

type Diagnostic = { field: string; source: string; code: string; message: string };
type SettingRecord = {
	name: string;
	key: string;
	type: string;
	env: string;
	description: string;
	secret: boolean;
	origin: string;
	status: string;
	value?: unknown;
	secretState?: string;
};
type Snapshot = {
	version: number;
	slice: string;
	source: { path: string; status: string; digest: string | null; observedAt: string };
	records: SettingRecord[];
	diagnostics: Diagnostic[];
	values: Record<string, unknown>;
};
type Options = { agentDir: string; env?: Record<string, string | undefined> };
type SettingsModule = {
	settings: Declaration;
	readSettings(options: Options): Snapshot;
	publishSettings(bus: Bus, options: Options): () => void;
};
const messages: Record<string, string> = {
	document: "Configuration document is invalid or unavailable.",
	unknown: "Unknown setting in this section.",
	secret: "Secret settings are environment-only; document input was rejected.",
	invalid: "Selected input is invalid; the safe default is in effect.",
	coverage: "Additional diagnostics were omitted at the diagnostic limit.",
	relation: "Effective settings violate an owning cross-field constraint; values are unchanged.",
};
const PUBLISH = "harness:settings:publish";
const REQUEST = "harness:settings:request";
class Bus {
	listeners = new Map<string, Set<(data: unknown) => void>>();
	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.listeners.get(event) ?? new Set();
		this.listeners.set(event, handlers);
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
		};
	}
	emit(event: string, data: unknown): void {
		for (const handler of this.listeners.get(event) ?? []) handler(data);
	}
}

test("publication bus unsubscribes the exact request handler", () => {
	const bus = new Bus();
	let count = 0;
	const off = bus.on(REQUEST, () => {
		count += 1;
	});
	bus.emit(REQUEST, {});
	off();
	bus.emit(REQUEST, {});
	assert.equal(count, 1);
});

function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "settings-contract-"));
	const path = join(agentDir, "harness.json");
	return {
		agentDir,
		path,
		options: { agentDir, env: {} } as Options,
		close: () => rmSync(agentDir, { recursive: true, force: true }),
	};
}
function record(snapshot: Snapshot, key: string): SettingRecord {
	const result = snapshot.records.find((entry) => entry.key === key);
	assert.ok(result, key);
	return result;
}
function stable(snapshot: Snapshot): unknown {
	return { ...snapshot, source: { ...snapshot.source, observedAt: "<time>" } };
}
function assertDiagnostics(snapshot: Snapshot): void {
	for (const diagnostic of snapshot.diagnostics) {
		assert.equal(diagnostic.message, messages[diagnostic.code]);
		assert.ok(["file", "env", "default"].includes(diagnostic.source));
	}
	assert.ok(snapshot.diagnostics.length <= 257);
}
function assertDefault(snapshot: Snapshot, key: string, field: Field, agentDir: string): void {
	const entry = record(snapshot, key);
	if (field.secret) {
		assert.equal(entry.secretState, "unset");
		assert.ok(!Object.hasOwn(entry, "value"));
	} else if (field.defaultText !== undefined) assert.notEqual(snapshot.values[key], undefined);
	else if (Object.hasOwn(field, "default"))
		assert.deepEqual(
			snapshot.values[key],
			field.type === "path" ? resolve(agentDir, field.default as string) : field.default,
		);
	else assert.equal(snapshot.values[key], undefined);
}

function assertRelativePaths(module: SettingsModule, agentDir: string): void {
	for (const [key, field] of Object.entries(module.settings.fields)) {
		if (field.type !== "path") continue;
		const relative = module.readSettings({ agentDir: agentDir, env: { [field.env]: "relative" } });
		if (field.absolute) assert.equal(record(relative, key).status, "invalid");
		else {
			assert.equal(relative.values[key], join(agentDir, "relative"));
			assert.ok(isAbsolute(relative.values[key] as string));
		}
	}
}

function assertInvalidEnvironment(
	module: SettingsModule,
	agentDir: string,
	key: string,
	field: Field,
	baseline: Snapshot,
): void {
	for (const bad of ["", "\u0000invalid"]) {
		// Empty ordinary text is valid unless its declaration sets a minimum.
		if (bad === "" && field.type === "string" && !field.secret && !field.minLength) continue;
		const invalid = module.readSettings({ agentDir: agentDir, env: { [field.env]: bad } });
		assert.deepEqual(invalid.values[key], baseline.values[key], key);
		assert.equal(record(invalid, key).origin, "default");
		assert.equal(record(invalid, key).status, "invalid");
		assert.ok(invalid.diagnostics.some((d) => d.code === "invalid" && d.source === "env"));
		assertDiagnostics(invalid);
	}
}

function validValue(field: Field, baseline: unknown, agentDir: string): unknown {
	switch (field.type) {
		case "boolean":
			return !baseline;
		case "enum":
			return field.choices?.find((value) => value !== baseline) ?? field.choices?.[0];
		case "integer":
		case "number":
			return field.min ?? Math.min(1, field.max ?? 1);
		case "path":
			return join(agentDir, "configured");
		case "string":
			return "s".repeat(Math.max(field.minLength ?? 1, Math.min(12, field.maxLength ?? 12)));
		case "json":
			return baseline ?? {};
	}
}
function invalidValue(field: Field): unknown {
	if (field.type === "json") {
		let value: unknown = null;
		for (let depth = 0; depth < 34; depth += 1) value = [value];
		return value;
	}
	return field.type === "string" || field.type === "path" || field.type === "enum" ? "\u0000rejected" : {};
}
function environmentValue(field: Field, value: unknown): string {
	return field.type === "json" ? JSON.stringify(value) : String(value);
}

function outsideBounds(field: Field): Array<{ bound: string; value: unknown }> {
	const cases: Array<{ bound: string; value: unknown }> = [];
	if (field.min !== undefined) cases.push({ bound: "min", value: field.min - 1 });
	if (field.max !== undefined) cases.push({ bound: "max", value: field.max + 1 });
	if (field.minLength !== undefined && field.minLength > 0)
		cases.push({ bound: "minLength", value: "s".repeat(field.minLength - 1) });
	if (field.maxLength !== undefined)
		cases.push({
			bound: "maxLength",
			value: field.type === "path" ? `/${"s".repeat(field.maxLength)}` : "s".repeat(field.maxLength + 1),
		});
	if (field.absolute) cases.push({ bound: "absolute", value: "relative" });
	return cases;
}

function assertRejectedBound(module: SettingsModule, key: string, field: Field, value: unknown, source: string): void {
	const f = fixture();
	try {
		const baseline = module.readSettings(f.options);
		if (source === "file")
			writeFileSync(f.path, JSON.stringify({ version: 1, [module.settings.slice]: { [key]: value } }));
		else f.options.env = { [field.env]: environmentValue(field, value) };
		const snapshot = module.readSettings(f.options);
		assert.deepEqual(snapshot.values[key], baseline.values[key]);
		assert.equal(record(snapshot, key).origin, "default");
		assert.equal(record(snapshot, key).status, "invalid");
		assert.deepEqual(snapshot.diagnostics, [
			{ field: `${module.settings.slice}.${key}`, source, code: "invalid", message: messages.invalid },
		]);
	} finally {
		f.close();
	}
}

const extensionsRoot = fileURLToPath(new URL("../extensions/", import.meta.url));
const declarations = readdirSync(extensionsRoot, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(join(extensionsRoot, entry.name, "settings.ts")))
	.map((entry) => ({ slice: entry.name, path: join(extensionsRoot, entry.name, "settings.ts") }));

test("configuration declarations are discovered", () => {
	assert.ok(declarations.length > 0);
});

for (const declaration of declarations) {
	test(`settings contract: ${declaration.slice}`, async (t) => {
		const module = (await import(pathToFileURL(declaration.path).href)) as SettingsModule;
		validateSettingsDeclaration(module.settings, declaration.slice);
		assert.equal(typeof module.readSettings, "function");
		assert.equal(typeof module.publishSettings, "function");
		const { settings } = module;
		for (const [key, field] of Object.entries(settings.fields)) {
			for (const { bound, value } of outsideBounds(field)) {
				for (const source of field.secret ? ["env"] : ["env", "file"]) {
					await t.test(`declared bound: ${key} ${bound} ${source}`, () => {
						assertRejectedBound(module, key, field, value, source);
					});
				}
			}
		}
		await t.test("unknown diagnostics stop at the exact limit with coverage", () => {
			const f = fixture();
			try {
				const baseline = module.readSettings(f.options);
				for (const count of [256, 257, 400]) {
					const keys = Array.from({ length: count }, (_, index) => `unknown${index}`);
					writeFileSync(
						f.path,
						JSON.stringify({ version: 1, [settings.slice]: Object.fromEntries(keys.map((key) => [key, true])) }),
					);
					const snapshot = module.readSettings(f.options);
					assert.deepEqual(snapshot.values, baseline.values);
					assert.deepEqual(snapshot.records, baseline.records);
					assert.deepEqual(snapshot.diagnostics, [
						...keys.slice(0, 256).map((key) => ({
							field: `${settings.slice}.${key}`,
							source: "file",
							code: "unknown",
							message: messages.unknown,
						})),
						...(count > 256
							? [{ field: "coverage", source: "file", code: "coverage", message: messages.coverage }]
							: []),
					]);
				}
			} finally {
				f.close();
			}
		});
		await t.test("Unicode unknown key preserves publication records and diagnostics", () => {
			const f = fixture();
			try {
				const field = Object.values(settings.fields)[0];
				if (field) f.options.env = { [field.env]: "\u0000invalid" };
				const section = { contractUnknown: true };
				writeFileSync(f.path, JSON.stringify({ version: 1, [settings.slice]: section }));
				const baseline = module.readSettings(f.options);
				const prefix = "a".repeat(63);
				writeFileSync(f.path, JSON.stringify({ version: 1, [settings.slice]: { ...section, [`${prefix}😀`]: true } }));
				const snapshot = module.readSettings(f.options);
				const bus = new Bus();
				const publications: Snapshot[] = [];
				bus.on(PUBLISH, (data) => publications.push(data as Snapshot));
				const off = module.publishSettings(bus, f.options);
				try {
					assert.equal(publications.length, 1);
					for (const result of [snapshot, publications[0]]) {
						assert.deepEqual(result.records, baseline.records);
						const unknown = result.diagnostics.find((diagnostic) =>
							diagnostic.field.startsWith(`${settings.slice}.${prefix}`),
						);
						assert.ok(unknown);
						assert.equal(unknown.field, `${settings.slice}.${prefix}`);
						assert.doesNotMatch(unknown.field, /[\p{Cc}\p{Cf}\ud800-\udfff]/u);
						assert.deepEqual(unknown, {
							field: `${settings.slice}.${prefix}`,
							source: "file",
							code: "unknown",
							message: messages.unknown,
						});
						assert.deepEqual(
							result.diagnostics.filter((diagnostic) => diagnostic !== unknown),
							baseline.diagnostics,
						);
					}
				} finally {
					off();
				}
			} finally {
				f.close();
			}
		});
		await t.test("defaults and metadata", () => {
			const f = fixture();
			try {
				const snapshot = module.readSettings(f.options);
				assert.equal(snapshot.version, 1);
				assert.equal(snapshot.slice, settings.slice);
				assert.equal(snapshot.source.status, "missing");
				assert.equal(snapshot.source.path, f.path);
				assert.equal(snapshot.source.digest, null);
				assert.ok(Number.isFinite(Date.parse(snapshot.source.observedAt)));
				assert.deepEqual(snapshot.diagnostics, []);
				assert.deepEqual(
					snapshot.records.map((entry) => entry.key),
					Object.keys(settings.fields),
				);
				for (const [key, field] of Object.entries(settings.fields)) {
					const entry = record(snapshot, key);
					assert.equal(entry.name, `${settings.slice}.${key}`);
					assert.equal(entry.env, field.env);
					assert.equal(entry.type, field.type);
					assert.equal(entry.description, field.description);
					assert.equal(entry.secret, field.secret ?? false);
					assert.equal(entry.origin, "default");
					assertDefault(snapshot, key, field, f.agentDir);
				}
			} finally {
				f.close();
			}
		});
		await t.test("omitted env reads the current process environment", () => {
			const f = fixture();
			const original = process.env;
			try {
				const baseline = module.readSettings(f.options);
				for (const [key, field] of Object.entries(settings.fields)) {
					const value = validValue(field, baseline.values[key], f.agentDir);
					process.env = { PI_HARNESS_FILE: f.path, [field.env]: environmentValue(field, value) };
					const snapshot = module.readSettings({ agentDir: f.agentDir });
					assert.equal(record(snapshot, key).origin, "env");
					assert.deepEqual(snapshot.values[key], value);
					process.env = { PI_HARNESS_FILE: f.path };
					assert.equal(record(module.readSettings({ agentDir: f.agentDir }), key).origin, "default");
				}
			} finally {
				process.env = original;
				f.close();
			}
		});
		await t.test("document fields, environment precedence, invalid selections, and secrets", () => {
			const f = fixture();
			try {
				const baseline = module.readSettings(f.options);
				for (const [key, field] of Object.entries(settings.fields)) {
					const value = validValue(field, baseline.values[key], f.agentDir);
					writeFileSync(f.path, JSON.stringify({ version: 1, [settings.slice]: { [key]: value } }));
					const fromFile = module.readSettings(f.options);
					if (field.secret) {
						assert.equal(fromFile.values[key], undefined);
						assert.ok(fromFile.diagnostics.some((d) => d.code === "secret" && d.field === `${settings.slice}.${key}`));
					} else {
						assert.deepEqual(fromFile.values[key], value, key);
						assert.equal(record(fromFile, key).origin, "file");
						assert.equal(record(fromFile, key).status, "valid");
					}
					const env = { [field.env]: environmentValue(field, value) };
					const fromEnv = module.readSettings({ agentDir: f.agentDir, env });
					assert.deepEqual(fromEnv.values[key], value, key);
					assert.equal(record(fromEnv, key).origin, "env");
					if (field.secret) {
						assert.equal(record(fromEnv, key).secretState, "set");
						assert.ok(!Object.hasOwn(record(fromEnv, key), "value"));
						assert.ok(fromEnv.diagnostics.some((d) => d.code === "secret"));
					}
					assertInvalidEnvironment(module, f.agentDir, key, field, baseline);
					if (!field.secret) {
						writeFileSync(f.path, JSON.stringify({ version: 1, [settings.slice]: { [key]: invalidValue(field) } }));
						const invalid = module.readSettings(f.options);
						assert.deepEqual(invalid.values[key], baseline.values[key]);
						assert.ok(
							invalid.diagnostics.some((d) => d.code === "invalid" && d.source === "file"),
							key,
						);
						const override = module.readSettings({ agentDir: f.agentDir, env });
						assert.equal(record(override, key).status, "valid");
						assert.deepEqual(override.values[key], value);
					}
				}
			} finally {
				f.close();
			}
		});
		await t.test("own section isolation, malformed documents, paths, and source digest", () => {
			const f = fixture();
			try {
				const baseline = module.readSettings(f.options);
				for (const content of [
					"",
					"{",
					"[]",
					'{"version":2}',
					'\ufeff{"version":1}',
					Buffer.from([0xff]),
					" ".repeat(131073),
				]) {
					writeFileSync(f.path, content);
					const snapshot = module.readSettings(f.options);
					assert.deepEqual(snapshot.values, baseline.values);
					assert.equal(snapshot.diagnostics.length, 1);
					assert.equal(snapshot.diagnostics[0].code, "document");
					assertDiagnostics(snapshot);
				}
				writeFileSync(f.path, JSON.stringify({ version: 1, foreign: { unknown: true } }));
				assert.deepEqual(module.readSettings(f.options).diagnostics, []);
				for (const section of [null, [], 1, "text"]) {
					writeFileSync(f.path, JSON.stringify({ version: 1, [settings.slice]: section }));
					const snapshot = module.readSettings(f.options);
					assert.deepEqual(snapshot.values, baseline.values);
					assert.deepEqual(snapshot.diagnostics, [
						{ field: settings.slice, source: "file", code: "invalid", message: messages.invalid },
					]);
				}
				const content = JSON.stringify({ version: 1, [settings.slice]: { contractUnknown: "private-input" } });
				writeFileSync(f.path, content);
				const snapshot = module.readSettings(f.options);
				assert.deepEqual(snapshot.diagnostics, [
					{ field: `${settings.slice}.contractUnknown`, source: "file", code: "unknown", message: messages.unknown },
				]);
				assert.equal(snapshot.source.digest, createHash("sha256").update(content).digest("hex"));
				assert.equal(snapshot.source.status, "loaded");
				const alternate = join(f.agentDir, "alternate.json");
				writeFileSync(alternate, content);
				for (const path of [alternate, "alternate.json"]) {
					const selected = module.readSettings({ agentDir: f.agentDir, env: { PI_HARNESS_FILE: path } });
					assert.equal(selected.source.path, alternate);
					assert.deepEqual(selected.values, snapshot.values);
				}
				mkdirSync(join(f.agentDir, "directory"));
				for (const path of ["", "\u0000invalid", "directory"]) {
					const invalid = module.readSettings({ agentDir: f.agentDir, env: { PI_HARNESS_FILE: path } });
					assert.equal(invalid.diagnostics[0].code, "document");
				}
				assertRelativePaths(module, f.agentDir);
			} finally {
				f.close();
			}
		});
		await t.test("publication handshake is fresh, redacted, and disposable", () => {
			const f = fixture();
			try {
				const bus = new Bus();
				const secretMarker = "contract-private-marker";
				f.options.env = Object.fromEntries(
					Object.values(settings.fields)
						.filter((field) => field.secret)
						.map((field) => [field.env, secretMarker]),
				);
				const publications: Snapshot[] = [];
				bus.on(PUBLISH, (data) => publications.push(data as Snapshot));
				const off = module.publishSettings(bus, f.options);
				assert.equal(typeof off, "function");
				assert.equal(publications.length, 1);
				assert.ok(!Object.hasOwn(publications[0], "values"));
				const { values: _values, ...snapshot } = module.readSettings(f.options);
				assert.deepEqual(stable(publications[0]), stable(snapshot as Snapshot));
				bus.emit(REQUEST, { version: 2 });
				bus.emit(REQUEST, null);
				assert.equal(publications.length, 1);
				writeFileSync(f.path, JSON.stringify({ version: 1, [settings.slice]: { contractUnknown: true } }));
				bus.emit(REQUEST, { version: 1 });
				assert.equal(publications.length, 2);
				assert.equal(publications[1].source.status, "loaded");
				assert.equal(publications[1].diagnostics[0].code, "unknown");
				assert.ok(Buffer.byteLength(JSON.stringify(publications[1])) <= 262144);
				assert.ok(!JSON.stringify(publications).includes(secretMarker));
				assert.ok(!Object.hasOwn(publications[1], "values"));
				off();
				bus.emit(REQUEST, { version: 1 });
				assert.equal(publications.length, 2);
				assert.equal(bus.listeners.get(REQUEST)?.size ?? 0, 0);
			} finally {
				f.close();
			}
		});
	});
}
