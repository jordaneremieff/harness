import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	booleanSetting,
	checkSettingsReadme,
	collectSettings,
	defineSettings,
	derivedDefault,
	DOCUMENT_MAX_BYTES,
	enumSetting,
	integerSetting,
	jsonSetting,
	numberSetting,
	parseSettingsPublication,
	pathSetting,
	publishSettings,
	readSettings,
	README_END,
	README_START,
	SETTINGS_MAX_FIELDS,
	SETTINGS_MAX_SLICES,
	SETTINGS_PUBLISH,
	SETTINGS_REQUEST,
	settingsPath,
	settingsPublication,
	settingsReadme,
	stringSetting,
	type SettingsBus,
} from "./index.ts";

function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "harness-settings-"));
	return {
		agentDir,
		env: {},
		write: (value: unknown) => writeFileSync(join(agentDir, "harness.json"), JSON.stringify(value)),
		dispose: () => rmSync(agentDir, { recursive: true, force: true }),
	};
}
const dir = pathSetting({
	description: "Store directory.",
	default: derivedDefault("<agentDir>/store", [], ({ agentDir }) => join(agentDir, "store")),
});
const example = defineSettings("example", {
	name: stringSetting({ description: "Name.", default: "safe", maxLength: 16 }),
	dir,
	checkpoint: pathSetting({
		description: "Checkpoint directory.",
		default: derivedDefault("<dir>/checkpoints", [dir], ({ get }) => join(get(dir), "checkpoints")),
	}),
	root: pathSetting({ description: "Optional absolute root.", absolute: true, maxLength: 1024 }),
	count: integerSetting({ description: "Count.", default: 3, min: 1, max: 10 }),
	interval: numberSetting({ description: "Fractional interval.", default: 0.5, min: 0, max: 35791 }),
	enabled: booleanSetting({ description: "Enabled.", default: true }),
	mode: enumSetting(["observe", "enforce"], { description: "Mode.", default: "observe" }),
	token: stringSetting({ description: "Service token.", secret: true, env: "PI_SERVICE_TOKEN" }),
});

test("typed values have required scalar defaults and optional absent values", () => {
	const f = fixture();
	try {
		const snapshot = readSettings(example, f);
		const name: string = snapshot.values.name;
		const count: number = snapshot.values.count;
		const enabled: boolean = snapshot.values.enabled;
		const root: string | undefined = snapshot.values.root;
		const mode: "observe" | "enforce" = snapshot.values.mode;
		assert.deepEqual([name, count, enabled, root, mode], ["safe", 3, true, undefined, "observe"]);
		assert.equal(snapshot.source.status, "missing");
		assert.equal(snapshot.source.digest, null);
		assert.equal(snapshot.values.dir, join(f.agentDir, "store"));
		assert.equal(snapshot.values.checkpoint, join(f.agentDir, "store", "checkpoints"));
		assert.equal(snapshot.records.find((record) => record.key === "root")?.status, "unset");
	} finally {
		f.dispose();
	}
});

test("present environment wins; invalid environment does not reveal the file value", () => {
	const f = fixture();
	try {
		f.write({ version: 1, example: { name: "file", count: 8, dir: "different" }, unrelated: { unknown: false } });
		const snapshot = readSettings(example, { ...f, env: { PI_EXAMPLE_NAME: "env", PI_EXAMPLE_COUNT: "wrong" } });
		assert.equal(snapshot.values.name, "env");
		assert.equal(snapshot.values.count, 3);
		assert.equal(snapshot.values.dir, join(f.agentDir, "different"));
		assert.equal(snapshot.values.checkpoint, join(f.agentDir, "different", "checkpoints"));
		assert.deepEqual(
			snapshot.diagnostics.map(({ field, source }) => ({ field, source })),
			[{ field: "example.count", source: "env" }],
		);
		assert.equal(snapshot.records.find((record) => record.key === "count")?.origin, "default");
		assert.equal(snapshot.records.find((record) => record.key === "count")?.status, "invalid");
		assert.equal(snapshot.records.find((record) => record.key === "dir")?.origin, "file");
		assert.match(snapshot.source.digest ?? "", /^[a-f0-9]{64}$/);
		assert.match(snapshot.source.observedAt, /^\d{4}-/);
		assert.deepEqual(readSettings(example, { ...f, env: { PI_EXAMPLE_NAME: "" } }).values.name, "");
	} finally {
		f.dispose();
	}
});

test("bad file fields fall back independently and unknown owned keys stay visible", () => {
	const f = fixture();
	try {
		f.write({
			version: 1,
			example: { count: 1.5, interval: 0.25, root: "relative", enabled: "1", mode: "other", surprise: "private-input" },
			other: [],
		});
		const snapshot = readSettings(example, f);
		assert.equal(snapshot.values.interval, 0.25);
		assert.equal(snapshot.values.count, 3);
		assert.equal(snapshot.values.root, undefined);
		assert.equal(snapshot.diagnostics.length, 5);
		assert.equal(snapshot.diagnostics[0].field, "example.surprise");
		assert.doesNotMatch(JSON.stringify(snapshot.diagnostics), /private-input|relative|other/);
		assert.equal(snapshot.records.find((record) => record.key === "root")?.status, "invalid");
	} finally {
		f.dispose();
	}
});

test("numeric inputs, boolean spellings, enum values and bounds are strict", () => {
	const f = fixture();
	try {
		for (const bad of ["", " ", "0x10", "NaN", "Infinity", "1.5", "0", "11", "9007199254740992"]) {
			const snapshot = readSettings(example, { ...f, env: { PI_EXAMPLE_COUNT: bad } });
			assert.equal(snapshot.values.count, 3, bad);
			assert.equal(snapshot.diagnostics[0].source, "env");
		}
		for (const [raw, value] of [
			["0", false],
			["1", true],
			["true", true],
			["false", false],
		] as const)
			assert.equal(readSettings(example, { ...f, env: { PI_EXAMPLE_ENABLED: raw } }).values.enabled, value);
		assert.equal(readSettings(example, { ...f, env: { PI_EXAMPLE_ENABLED: "yes" } }).diagnostics[0].code, "invalid");
		assert.equal(
			readSettings(example, { ...f, env: { PI_EXAMPLE_MODE: "enforce", PI_EXAMPLE_INTERVAL: "2.5e-1" } }).values
				.interval,
			0.25,
		);
	} finally {
		f.dispose();
	}
});

test("secret input is env-only; all public projections omit its bytes", () => {
	const f = fixture();
	try {
		f.write({ version: 1, example: { token: "file-private-bytes" } });
		const snapshot = readSettings(example, { ...f, env: { PI_SERVICE_TOKEN: "env-private-bytes" } });
		assert.equal(snapshot.values.token, "env-private-bytes");
		const record = snapshot.records.find((item) => item.key === "token");
		assert.equal(record?.secretState, "set");
		assert.equal(record?.origin, "env");
		assert.equal(record?.status, "invalid");
		assert.doesNotMatch(JSON.stringify(settingsPublication(snapshot)), /private-bytes|values/);
		assert.doesNotMatch(settingsReadme(example), /private-bytes/);
		assert.equal(readSettings(example, f).values.token, undefined);
		assert.equal(readSettings(example, { ...f, env: { PI_SERVICE_TOKEN: "" } }).values.token, undefined);
		assert.equal(readSettings(example, { ...f, env: { PI_SERVICE_TOKEN: "\nprivate-bytes" } }).values.token, undefined);
		assert.equal(record && Object.hasOwn(record, "value"), false);
	} finally {
		f.dispose();
	}
});

test("malformed, unsupported, oversized and invalid UTF-8 documents retain env/default values", () => {
	const f = fixture();
	try {
		for (const content of [
			"{private-json",
			'{"version":2}',
			'{"version":1,}',
			"[]",
			Buffer.from([0xff]),
			`\ufeff{"version":1}`,
			" ".repeat(DOCUMENT_MAX_BYTES + 1),
		]) {
			writeFileSync(join(f.agentDir, "harness.json"), content);
			const snapshot = readSettings(example, { ...f, env: { PI_EXAMPLE_COUNT: "5" } });
			assert.equal(snapshot.source.status, "invalid");
			assert.equal(snapshot.values.count, 5);
			assert.equal(snapshot.values.name, "safe");
			assert.equal(snapshot.diagnostics.length, 1);
			assert.equal(snapshot.diagnostics[0].field, "document");
			assert.doesNotMatch(JSON.stringify(snapshot.diagnostics), /private-json/);
		}
		writeFileSync(join(f.agentDir, "harness.json"), '{"version":1}'.padEnd(DOCUMENT_MAX_BYTES, " "));
		assert.equal(readSettings(example, f).source.status, "loaded");
	} finally {
		f.dispose();
	}
});

test("nonregular sources are rejected without blocking", () => {
	const f = fixture();
	try {
		mkdirSync(join(f.agentDir, "directory"));
		assert.equal(readSettings(example, { ...f, env: { PI_HARNESS_FILE: "directory" } }).source.status, "unavailable");
		const fifo = join(f.agentDir, "fifo");
		execFileSync("mkfifo", [fifo]);
		const snapshot = readSettings(example, { ...f, env: { PI_HARNESS_FILE: fifo } });
		assert.equal(snapshot.source.status, "unavailable");
		assert.equal(snapshot.diagnostics.length, 1);
	} finally {
		f.dispose();
	}
});

test("path policy is explicit, relative to agentDir, and never expands home notation", () => {
	const f = fixture();
	try {
		assert.equal(
			settingsPath({ ...f, env: { PI_HARNESS_FILE: "nested/settings.json" } }),
			join(f.agentDir, "nested/settings.json"),
		);
		assert.equal(
			settingsPath({ ...f, env: { PI_HARNESS_FILE: "/portable/settings.json" } }),
			"/portable/settings.json",
		);
		assert.equal(
			readSettings(example, { ...f, env: { PI_EXAMPLE_DIR: "~/store" } }).values.dir,
			join(f.agentDir, "~/store"),
		);
		assert.throws(() => settingsPath({ agentDir: "relative" }), /absolute/);
		assert.throws(() => settingsPath({ ...f, env: { PI_HARNESS_FILE: "" } }), /nonempty/);
		f.write({ version: 1, example: { name: "file" } });
		const invalidOverride = readSettings(example, { ...f, env: { PI_HARNESS_FILE: "", PI_EXAMPLE_COUNT: "7" } });
		assert.equal(invalidOverride.values.name, "safe");
		assert.equal(invalidOverride.values.count, 7);
		assert.equal(invalidOverride.diagnostics[0].field, "PI_HARNESS_FILE");
		assert.equal(invalidOverride.diagnostics[0].source, "env");
	} finally {
		f.dispose();
	}
});

type Presets = { presets: { [name: string]: { model: string; checkInMinutes: number } } };
const presets = jsonSetting<Presets>((value): value is Presets => {
	if (
		!value ||
		typeof value !== "object" ||
		!("presets" in value) ||
		!value.presets ||
		typeof value.presets !== "object"
	)
		return false;
	return Object.values(value.presets).every(
		(entry) =>
			entry && typeof entry.model === "string" && typeof entry.checkInMinutes === "number" && entry.checkInMinutes >= 0,
	);
})({ description: "Execution presets." });
const structured = defineSettings("example", { presets });

test("structured values preserve typing and use extension-owned pure validation", () => {
	const f = fixture();
	try {
		const document = { presets: { helper: { model: "acme/model-x", checkInMinutes: 0.25 } } };
		f.write({ version: 1, example: { presets: document } });
		const typed: Presets | undefined = readSettings(structured, f).values.presets;
		assert.equal(typed?.presets.helper.model, "acme/model-x");
		assert.deepEqual(
			readSettings(structured, { ...f, env: { PI_EXAMPLE_PRESETS: JSON.stringify(document) } }).values.presets,
			document,
		);
		for (const raw of [
			"{bad-json",
			'{"presets":{"helper":{"model":"acme/model-x","checkInMinutes":-1}}}',
			" ".repeat(DOCUMENT_MAX_BYTES + 1),
		]) {
			const snapshot = readSettings(structured, { ...f, env: { PI_EXAMPLE_PRESETS: raw } });
			assert.equal(snapshot.values.presets, undefined);
			assert.equal(snapshot.records[0].origin, "default");
			assert.equal(snapshot.records[0].status, "invalid");
		}
	} finally {
		f.dispose();
	}
});

test("validator exceptions and malformed structured text never echo rejected input", () => {
	const f = fixture();
	try {
		const throwing = defineSettings("example", {
			data: jsonSetting((value): value is string => {
				throw new Error(String(value));
			})({ description: "Data." }),
		});
		const snapshot = readSettings(throwing, { ...f, env: { PI_EXAMPLE_DATA: '"private-exception"' } });
		assert.doesNotMatch(JSON.stringify(snapshot.diagnostics), /private-exception/);
		assert.equal(snapshot.values.data, undefined);
		const broad = defineSettings("example", {
			data: jsonSetting((value): value is object => typeof value === "object")({ description: "Data." }),
		});
		for (const raw of ['{"bad":"\\ud800"}', '{"bad":"\\u0000"}', `${"[".repeat(40)}0${"]".repeat(40)}`])
			assert.equal(readSettings(broad, { ...f, env: { PI_EXAMPLE_DATA: raw } }).records[0].status, "invalid");
	} finally {
		f.dispose();
	}
});

test("semantic scalar validation uses safe defaults without leaking exceptions", () => {
	const f = fixture();
	try {
		const declaration = defineSettings("example", {
			threshold: numberSetting({
				description: "Threshold.",
				default: 85,
				min: 1,
				max: 100,
				validate: (value) => value < 90,
			}),
		});
		assert.equal(readSettings(declaration, { ...f, env: { PI_EXAMPLE_THRESHOLD: "95" } }).values.threshold, 85);
		assert.equal(readSettings(declaration, { ...f, env: { PI_EXAMPLE_THRESHOLD: "60" } }).values.threshold, 60);
	} finally {
		f.dispose();
	}
});

test("default declarations reject unsafe bounds, names, secrets and dependencies", () => {
	assert.throws(() => defineSettings("version", {}));
	assert.throws(() => defineSettings("example", { "bad-key": dir }));
	assert.throws(() =>
		defineSettings("example", {
			token: stringSetting({ description: "Token.", secret: true, default: "private-default" }),
		}),
	);
	assert.throws(() => defineSettings("example", { count: numberSetting({ description: "Count.", min: 10, max: 1 }) }));
	assert.throws(() => defineSettings("example", { count: numberSetting({ description: "Count.", min: NaN }) }));
	assert.throws(() =>
		defineSettings("example", {
			a: stringSetting({ description: "A.", env: "PI_DUPLICATE" }),
			b: stringSetting({ description: "B.", env: "PI_DUPLICATE" }),
		}),
	);
	assert.throws(() =>
		defineSettings("example", {
			other: pathSetting({ description: "Other.", default: derivedDefault("Other", [dir], () => "other") }),
		}),
	);
	const token = stringSetting({ description: "Token.", secret: true });
	assert.throws(() =>
		defineSettings("example", {
			token,
			other: stringSetting({ description: "Other.", default: derivedDefault("Other", [token], () => "other") }),
		}),
	);
	const f = fixture();
	try {
		assert.throws(
			() =>
				readSettings(defineSettings("example", { count: integerSetting({ description: "Count.", default: 1.5 }) }), f),
			/Invalid default/,
		);
		assert.throws(
			() =>
				readSettings(
					defineSettings("example", {
						other: pathSetting({
							description: "Other.",
							default: derivedDefault("Other", [], () => {
								throw new Error("private-error");
							}),
						}),
					}),
					f,
				),
			(error: Error) => !error.message.includes("private-error"),
		);
	} finally {
		f.dispose();
	}
});

test("diagnostic volume is bounded with explicit omitted coverage", () => {
	const f = fixture();
	try {
		f.write({
			version: 1,
			example: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`unknown${index}`, false])),
		});
		const snapshot = readSettings(example, f);
		assert.equal(snapshot.diagnostics.length, SETTINGS_MAX_FIELDS * 2 + 1);
		assert.equal(snapshot.diagnostics.at(-1)?.code, "coverage");
	} finally {
		f.dispose();
	}
});

function fakeBus() {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(0);
	const bus: SettingsBus = {
		emit: (channel, payload) => {
			emitter.emit(channel, payload);
		},
		on: (channel, handler) => {
			emitter.on(channel, handler);
			return () => {
				emitter.off(channel, handler);
			};
		},
	};
	return { ...bus, emitter };
}

test("publication handshake handles both load orders and rereads on request", () => {
	for (const publisherFirst of [true, false]) {
		const f = fixture();
		try {
			const bus = fakeBus();
			let release: (() => void) | undefined;
			if (publisherFirst) release = publishSettings(bus, example, f);
			const collector = collectSettings(bus);
			if (!publisherFirst) release = publishSettings(bus, example, f);
			assert.equal(collector.snapshots()[0].records[0].value, "safe");
			f.write({ version: 1, example: { name: "fresh" } });
			assert.equal(collector.snapshots()[0].records[0].value, "safe");
			collector.refresh();
			assert.equal(collector.snapshots()[0].records[0].value, "fresh");
			const copy = collector.snapshots();
			copy[0].records[0].value = "mutated";
			assert.equal(collector.snapshots()[0].records[0].value, "fresh");
			bus.emit(SETTINGS_REQUEST, { version: 2 });
			assert.equal(collector.snapshots()[0].records[0].value, "fresh");
			assert.ok(release);
			release();
			collector.refresh();
			assert.deepEqual(collector.snapshots(), []);
			collector.dispose();
			collector.dispose();
			collector.refresh();
			assert.equal(bus.emitter.listenerCount(SETTINGS_PUBLISH), 0);
			assert.equal(bus.emitter.listenerCount(SETTINGS_REQUEST), 0);
		} finally {
			f.dispose();
		}
	}
});

test("the installed public Pi bus delivers the synchronous handshake", () => {
	const f = fixture();
	const bus = createEventBus();
	try {
		const release = publishSettings(bus, example, f);
		const collector = collectSettings(bus);
		assert.equal(collector.snapshots()[0].slice, "example");
		collector.dispose();
		release();
	} finally {
		bus.clear();
		f.dispose();
	}
});

test("malformed publications are contained, secret values rejected and capabilities omitted", () => {
	const f = fixture();
	try {
		const publication = settingsPublication(readSettings(example, f));
		assert.deepEqual(parseSettingsPublication(publication), publication);
		for (const input of [
			null,
			{},
			{ ...publication, version: 2 },
			{ ...publication, records: [...publication.records, publication.records[0]] },
			{ ...publication, source: { ...publication.source, digest: "bad" } },
		])
			assert.equal(parseSettingsPublication(input), undefined);
		const secret = structuredClone(publication);
		const secretRecord = secret.records.at(-1);
		assert.ok(secretRecord);
		secretRecord.value = "private-value";
		assert.equal(parseSettingsPublication(secret), undefined);
		assert.doesNotMatch(JSON.stringify(settingsPublication(secret)), /private-value/);
		const withCapabilities = {
			...publication,
			execute: () => {},
			values: { token: "private-value" },
			records: publication.records.map((record) => ({ ...record, execute: () => {} })),
		};
		assert.doesNotMatch(JSON.stringify(parseSettingsPublication(withCapabilities)), /private-value|execute|values/);
		const poisoned = {
			...publication,
			diagnostics: publication.diagnostics.concat({
				field: "example.name",
				source: "env",
				code: "invalid",
				message: "private-value",
			}),
		};
		assert.doesNotMatch(JSON.stringify(parseSettingsPublication(poisoned)), /private-value/);
	} finally {
		f.dispose();
	}
});

test("collector bounds publishers and cleanup after startup errors", () => {
	const bus = fakeBus();
	const collector = collectSettings(bus);
	const f = fixture();
	try {
		const snapshot = readSettings(defineSettings("example", {}), f);
		for (let index = 0; index < SETTINGS_MAX_SLICES + 4; index++)
			bus.emit(SETTINGS_PUBLISH, { ...snapshot, slice: `slice${index}` });
		assert.equal(collector.snapshots().length, SETTINGS_MAX_SLICES);
		collector.dispose();
		bus.emit(SETTINGS_PUBLISH, snapshot);
		assert.deepEqual(collector.snapshots(), []);
		const failing = fakeBus();
		failing.emit = () => {
			throw new Error("bus unavailable");
		};
		assert.throws(() => collectSettings(failing));
		assert.equal(failing.emitter.listenerCount(SETTINGS_PUBLISH), 0);
		assert.throws(() => publishSettings(failing, example, f));
		assert.equal(failing.emitter.listenerCount(SETTINGS_REQUEST), 0);
	} finally {
		f.dispose();
	}
});

test("generated README projection is exact, secret-free and marker-checked", () => {
	const projection = settingsReadme(example);
	assert.ok(checkSettingsReadme(example, `# Example\n\n${projection}\n`));
	assert.ok(!checkSettingsReadme(example, projection.replace("Name.", "Old name.")));
	assert.ok(!checkSettingsReadme(example, projection + README_START));
	assert.ok(!checkSettingsReadme(example, projection + README_END));
	assert.ok(!checkSettingsReadme(example, ""));
	assert.match(projection, /env-only/);
	assert.match(projection, /PI_EXAMPLE_CHECKPOINT/);
	assert.match(projection, /&lt;dir&gt;\/checkpoints/);
	const escaped = settingsReadme(
		defineSettings("example", { a: stringSetting({ description: "A | B.", default: "<safe>" }) }),
	);
	assert.match(escaped, /A \\| B/);
	assert.match(escaped, /&lt;safe&gt;/);
});

test("derived defaults support reversed field order and reject undeclared reads or cycles", () => {
	const f = fixture();
	try {
		const base = pathSetting({ description: "Base.", default: "base" });
		const dependent = pathSetting({
			description: "Dependent.",
			default: derivedDefault("<base>/child", [base], ({ get }) => join(get(base), "child")),
		});
		assert.equal(
			readSettings(defineSettings("example", { dependent, base }), f).values.dependent,
			join(f.agentDir, "base", "child"),
		);
		const undeclared = pathSetting({
			description: "Undeclared.",
			default: derivedDefault("<base>/child", [], ({ get }) => get(base)),
		});
		assert.throws(() => readSettings(defineSettings("example", { base, undeclared }), f), /Invalid default derivation/);
		const firstOptions = { description: "First.", default: derivedDefault("First", [], () => "first") };
		const first = pathSetting(firstOptions);
		const second = pathSetting({
			description: "Second.",
			default: derivedDefault("Second", [first], ({ get }) => get(first)),
		});
		firstOptions.default = derivedDefault("First", [second], ({ get }) => get(second));
		assert.throws(() => readSettings(defineSettings("example", { first, second }), f), /Invalid default derivation/);
	} finally {
		f.dispose();
	}
});

test("defensive publication validation rejects type and state mismatches and bounds output", () => {
	const f = fixture();
	try {
		const publication = settingsPublication(readSettings(example, f));
		for (const value of [false, 1, null, {}]) {
			const wrong = structuredClone(publication);
			wrong.records[0].value = value;
			assert.equal(parseSettingsPublication(wrong), undefined);
		}
		const missing = structuredClone(publication);
		delete missing.records[0].value;
		assert.equal(parseSettingsPublication(missing), undefined);
		const wrongState = structuredClone(publication);
		wrongState.records[0].status = "unset";
		assert.equal(parseSettingsPublication(wrongState), undefined);
		const huge = structuredClone(publication);
		huge.records = Array.from({ length: SETTINGS_MAX_FIELDS + 1 }, () => publication.records[0]);
		assert.equal(parseSettingsPublication(huge), undefined);
		const oversized = structuredClone(publication);
		oversized.records[0].value = "x".repeat(DOCUMENT_MAX_BYTES * 3);
		assert.equal(parseSettingsPublication(oversized), undefined);
		assert.throws(() => settingsPublication(oversized), /byte limit/);
		const exoticStatus = { ...publication, source: { ...publication.source, status: { toString: () => "loaded" } } };
		assert.equal(parseSettingsPublication(exoticStatus), undefined);
	} finally {
		f.dispose();
	}
});

test("explicit undefined defaults keep optional types and prototype-named absent sections stay absent", () => {
	const f = fixture();
	try {
		const optional = defineSettings("constructor", {
			name: stringSetting({ description: "Optional name.", default: undefined }),
		});
		f.write({ version: 1 });
		const snapshot = readSettings(optional, f);
		const value: string | undefined = snapshot.values.name;
		assert.equal(value, undefined);
		assert.deepEqual(snapshot.diagnostics, []);
		assert.throws(() => defineSettings("example", { first: dir, second: dir }), /one field/);
	} finally {
		f.dispose();
	}
});

test("structured defaults do not collide with derivation metadata", () => {
	const f = fixture();
	try {
		const declaration = defineSettings("example", {
			data: jsonSetting(
				(value): value is { kind: string } =>
					value !== null && typeof value === "object" && "kind" in value && typeof value.kind === "string",
			)({ description: "Structured data.", default: { kind: "derived" } }),
		});
		assert.deepEqual(readSettings(declaration, f).values.data, { kind: "derived" });
	} finally {
		f.dispose();
	}
});
