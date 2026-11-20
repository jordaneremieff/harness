import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { CONFIG_DIR_NAME, getPackageDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type { ConfigHost, ToolInfoLike } from "./catalogue.ts";
import { ConfigBackend } from "./operations.ts";
import { loadPiSchema } from "./pi-schema.ts";
import type { Change, EditRequest, Json } from "./protocol.ts";
import { publishSettings } from "./settings.ts";

type Handler = (data: unknown) => void;
function fakeBus() {
	const handlers = new Map<string, Set<Handler>>();
	return {
		emit(channel: string, data: unknown) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel: string, handler: Handler) {
			if (!handlers.has(channel)) handlers.set(channel, new Set());
			handlers.get(channel)?.add(handler);
			return () => handlers.get(channel)?.delete(handler);
		},
	};
}
type Bus = ReturnType<typeof fakeBus>;

type SyntheticOwnerOptions = {
	env?: Record<string, string | undefined>;
	check?: (key: string, value: unknown) => boolean;
	relation?: (values: Record<string, unknown>) => string[];
};

/** Reads one declared field for the synthetic owner, per the version 2 contract. */
function syntheticRecord(
	declaration: { slice: string; fields: Record<string, Record<string, unknown>> },
	options: SyntheticOwnerOptions,
	own: Record<string, unknown>,
	env: Record<string, string | undefined>,
	key: string,
	field: Record<string, unknown>,
	diagnostics: { field: string; source: string; code: string; message: string }[],
): { record: Record<string, unknown>; value: unknown } {
	const name = `${declaration.slice}.${key}`;
	const raw = env[field.env as string];
	let origin = raw !== undefined ? "env" : Object.hasOwn(own, key) ? "file" : "default";
	let value = origin === "env" ? JSON.parse(raw as string) : origin === "file" ? own[key] : field.default;
	let status = "valid";
	if (origin !== "default" && !(options.check?.(key, value) ?? true)) {
		diagnostics.push({ field: name, source: origin, code: "invalid", message: "x" });
		origin = "default";
		value = field.default;
		status = "invalid";
	}
	return {
		record: {
			name,
			key,
			type: field.type,
			description: field.description,
			env: field.env,
			secret: false,
			origin,
			status,
			value,
		},
		value,
	};
}

/** Diagnostics for stored keys the owner does not declare and for violated relations. */
function extraDiagnostics(
	declaration: { slice: string; fields: Record<string, Record<string, unknown>> },
	options: SyntheticOwnerOptions,
	own: Record<string, unknown>,
	values: Record<string, unknown>,
): { field: string; source: string; code: string; message: string }[] {
	const diagnostics: { field: string; source: string; code: string; message: string }[] = [];
	for (const key of Object.keys(own))
		if (!Object.hasOwn(declaration.fields, key))
			diagnostics.push({ field: `${declaration.slice}.${key}`, source: "file", code: "unknown", message: "x" });
	for (const key of options.relation?.(values) ?? [])
		diagnostics.push({ field: `${declaration.slice}.${key}`, source: "default", code: "relation", message: "x" });
	return diagnostics;
}

/**
 * A synthetic owner that follows the version 2 contract with its own rules: like real
 * owners, it reads the document that the environment names at each request.
 */
function syntheticOwner(
	bus: Bus,
	agentDir: string,
	declaration: { slice: string; fields: Record<string, Record<string, unknown>> },
	options: SyntheticOwnerOptions = {},
) {
	const schema = createHash("sha256").update(JSON.stringify(declaration)).digest("hex");
	const env = options.env ?? {};
	const read = () => {
		const path = resolve(agentDir, env.PI_HARNESS_FILE ?? "harness.json");
		let document: Record<string, unknown> | undefined;
		try {
			document = JSON.parse(readFileSync(path, "utf8"));
		} catch {}
		const own = (document?.[declaration.slice] as Record<string, unknown>) || {};
		const diagnostics: { field: string; source: string; code: string; message: string }[] = [];
		const records = [];
		const values: Record<string, unknown> = {};
		for (const [key, field] of Object.entries(declaration.fields)) {
			const outcome = syntheticRecord(declaration, options, own, env, key, field, diagnostics);
			values[key] = outcome.value;
			records.push(outcome.record);
		}
		diagnostics.push(...extraDiagnostics(declaration, options, own, values));
		return { path, records, diagnostics };
	};
	const off = bus.on("harness:settings:request", (input) => {
		if ((input as { version?: number }).version !== 2) return;
		const { path, records, diagnostics } = read();
		bus.emit("harness:settings:publish", {
			version: 2,
			slice: declaration.slice,
			declaration,
			source: { path, status: "loaded", digest: null, observedAt: new Date().toISOString() },
			records,
			diagnostics,
		});
	});
	return { schema, off };
}

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function fixture(options: { trusted?: boolean; env?: Record<string, string | undefined>; tools?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "config-backend-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const bus = fakeBus();
	const env = options.env ?? {};
	const stopOwn = publishSettings(bus, { agentDir, env });
	let active = ["read", "bash"];
	const toolList: ToolInfoLike[] = [
		{ name: "read", exposure: "direct" },
		{ name: "bash", exposure: "direct" },
		{ name: "grep", exposure: "deferred" },
		{ name: "secret_tool", exposure: "hidden" },
	];
	let session: unknown = {};
	const host = (): ConfigHost => ({
		kind: "ordinary",
		agentDir,
		cwd,
		projectTrusted: options.trusted ?? true,
		bus,
		env,
		pi: { version: VERSION, packageDir: getPackageDir(), configDir: CONFIG_DIR_NAME, SettingsManager },
		sessionSettings: () => session,
		...(options.tools === false
			? {}
			: {
					tools: {
						all: () => toolList,
						active: () => [...active],
						setActive: (names: string[]) => {
							active = names.filter((name) =>
								toolList.some((tool) => tool.name === name && tool.exposure !== "hidden"),
							);
						},
					},
				}),
	});
	const backend = new ConfigBackend(host);
	return {
		root,
		agentDir,
		cwd,
		bus,
		env,
		backend,
		stopOwn,
		globalPath: join(agentDir, "settings.json"),
		projectPath: join(cwd, CONFIG_DIR_NAME, "settings.json"),
		harnessPath: join(agentDir, "harness.json"),
		setSession: (value: unknown) => {
			session = value;
		},
		revision: (document: "harness" | "pi-global" | "pi-project") =>
			backend.catalogue().context.documents.find((item) => item.document === document)?.revision ?? null,
	};
}
function json(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8"));
}
async function commit(backend: ConfigBackend, changes: Change[], revisions?: EditRequest["revisions"]) {
	return backend.edit({ mode: "commit", changes, ...(revisions ? { revisions } : {}) });
}

describe("Pi settings", () => {
	it("lists every leaf of the installed schema with its section", () => {
		const { backend } = fixture();
		const schema = loadPiSchema(getPackageDir());
		const catalogue = backend.catalogue();
		const pi = catalogue.entries.filter((entry) => entry.group === "pi");
		assert.equal(pi.length, schema.leaves.length);
		const enabled = catalogue.entries.find((entry) => entry.id === "pi:/compaction/enabled");
		assert.equal(enabled?.category, "Compaction");
		assert.deepEqual(enabled?.resolved, { value: true, source: "default" });
		const thinking = catalogue.entries.find((entry) => entry.id === "pi:/modelThinkingLevels");
		assert.equal(thinking?.value.type, "map");
		assert.deepEqual(catalogue.entries.find((entry) => entry.id === "pi:/defaultProjectTrust")?.scopes, ["global"]);
		assert.equal(catalogue.entries.find((entry) => entry.id === "pi:/deviceId")?.kind, "internal");
		assert.equal(catalogue.entries.find((entry) => entry.id === "pi:/queueMode")?.kind, "deprecated");
		assert.equal(catalogue.entries.find((entry) => entry.id === "pi:/packages")?.value.type, "array");
	});

	it("patches only the requested path and reads it back", async () => {
		const { backend, globalPath, revision } = fixture();
		writeFileSync(
			globalPath,
			`${JSON.stringify({ theme: "dark", extraKey: { kept: [1, 2] }, compaction: { reserveTokens: 1000 } }, null, "\t")}\n`,
		);
		const before = revision("pi-global");
		const result = await commit(backend, [
			{ id: "pi:/compaction/enabled", scope: "global", action: "set", value: false, base: { present: false } },
		]);
		assert.equal(result.outcome, "committed", result.summary);
		const saved = json(globalPath);
		assert.deepEqual(saved, {
			theme: "dark",
			extraKey: { kept: [1, 2] },
			compaction: { reserveTokens: 1000, enabled: false },
		});
		assert.match(readFileSync(globalPath, "utf8"), /^\{\n\t"theme"/);
		assert.equal(result.documents[0].before, before);
		assert.notEqual(result.documents[0].after, before);
		assert.equal(result.documents[0].changes[0].resolved?.source, "global");
		assert.equal(result.documents[0].changes[0].apply?.state, "pending-reload");
	});

	it("resets by removing the stored override, never by writing the default", async () => {
		const { backend, globalPath } = fixture();
		writeFileSync(globalPath, JSON.stringify({ hideThinkingBlock: true }));
		const result = await commit(backend, [
			{ id: "pi:/hideThinkingBlock", scope: "global", action: "unset", base: { present: true, value: true } },
		]);
		assert.equal(result.outcome, "committed");
		assert.deepEqual(json(globalPath), {});
		assert.deepEqual(result.documents[0].changes[0].resolved, { value: false, source: "default" });
	});

	it("rejects values that the installed schema refuses and writes nothing", async () => {
		const { backend, globalPath } = fixture();
		writeFileSync(globalPath, "{}");
		const result = await commit(backend, [
			{ id: "pi:/compaction/reserveTokens", scope: "global", action: "set", value: -5, base: { present: false } },
			{ id: "pi:/transport", scope: "global", action: "set", value: "pigeon", base: { present: false } },
		]);
		assert.equal(result.outcome, "rejected");
		assert.equal(readFileSync(globalPath, "utf8"), "{}");
		assert.match(result.documents[0].changes[0].problems.join(" "), /at least 0/);
		assert.match(result.documents[0].changes[1].problems.join(" "), /one of/);
	});

	it("keeps project writes behind the host's trust and global-only settings global", async () => {
		const untrusted = fixture({ trusted: false });
		const refused = await commit(untrusted.backend, [
			{ id: "pi:/theme", scope: "project", action: "set", value: "light", base: { present: false } },
		]);
		assert.equal(refused.outcome, "rejected");
		assert.match(refused.documents[0].changes[0].problems.join(" "), /does not trust the project/);
		assert.throws(() => statSync(untrusted.projectPath));

		const trusted = fixture({ trusted: true });
		const written = await commit(trusted.backend, [
			{ id: "pi:/theme", scope: "project", action: "set", value: "light", base: { present: false } },
		]);
		assert.equal(written.outcome, "committed", written.summary);
		assert.deepEqual(json(trusted.projectPath), { theme: "light" });
		const global = await commit(trusted.backend, [
			{ id: "pi:/defaultProjectTrust", scope: "project", action: "set", value: "always", base: { present: false } },
		]);
		assert.equal(global.outcome, "rejected");
		assert.match(global.documents[0].changes[0].problems.join(" "), /agent-directory/);
	});

	it("reports a conflict for a competing change and keeps unrelated external changes", async () => {
		const { backend, globalPath } = fixture();
		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		const base = { present: true as const, value: "dark" as Json };
		writeFileSync(globalPath, JSON.stringify({ theme: "light", quietStartup: true }));
		const conflict = await commit(backend, [{ id: "pi:/theme", scope: "global", action: "set", value: "solar", base }]);
		assert.equal(conflict.outcome, "conflict");
		assert.deepEqual(conflict.documents[0].changes[0].current, { present: true, value: "light" });
		assert.deepEqual(json(globalPath), { theme: "light", quietStartup: true });

		const merged = await commit(backend, [
			{ id: "pi:/hideThinkingBlock", scope: "global", action: "set", value: true, base: { present: false } },
		]);
		assert.equal(merged.outcome, "committed");
		assert.deepEqual(json(globalPath), { theme: "light", quietStartup: true, hideThinkingBlock: true });
	});

	it("treats a retried commit as a desired value, not a toggle", async () => {
		const { backend, globalPath } = fixture();
		writeFileSync(globalPath, "{}");
		const change: Change = {
			id: "pi:/hideThinkingBlock",
			scope: "global",
			action: "set",
			value: true,
			base: { present: false },
		};
		assert.equal((await commit(backend, [change])).outcome, "committed");
		const again = await commit(backend, [change]);
		assert.equal(again.outcome, "unchanged");
		assert.deepEqual(json(globalPath), { hideThinkingBlock: true });
		const request: EditRequest = {
			mode: "commit",
			requestId: "same-request",
			changes: [{ ...change, value: false, base: { present: true, value: true } }],
		};
		const first = await backend.edit(request);
		const replay = await backend.edit(request);
		assert.deepEqual(replay, first);
		await assert.rejects(backend.edit({ ...request, changes: [{ ...change, value: true }] }), /different changes/);
	});

	it("requires a revision or base for a commit and accepts a matching revision", async () => {
		const { backend, globalPath, revision } = fixture();
		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		const missing = await commit(backend, [{ id: "pi:/theme", scope: "global", action: "set", value: "light" }]);
		assert.equal(missing.outcome, "rejected");
		const ok = await commit(backend, [{ id: "pi:/theme", scope: "global", action: "set", value: "light" }], {
			"pi-global": revision("pi-global"),
		});
		assert.equal(ok.outcome, "committed");
		const stale = await commit(backend, [{ id: "pi:/theme", scope: "global", action: "set", value: "dark" }], {
			"pi-global": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		});
		assert.equal(stale.outcome, "conflict");
	});

	it("never replaces a malformed file", async () => {
		const { backend, globalPath } = fixture();
		writeFileSync(globalPath, "{ not json");
		const result = await commit(backend, [
			{ id: "pi:/theme", scope: "global", action: "set", value: "dark", base: { present: false } },
		]);
		assert.equal(result.outcome, "rejected");
		assert.equal(readFileSync(globalPath, "utf8"), "{ not json");
	});

	it("writes through a symbolic link and keeps the file mode", async () => {
		const { backend, globalPath, root } = fixture();
		const target = join(root, "dotfiles-settings.json");
		writeFileSync(target, JSON.stringify({ theme: "dark" }));
		chmodSync(target, 0o640);
		symlinkSync(target, globalPath);
		const result = await commit(backend, [
			{ id: "pi:/theme", scope: "global", action: "set", value: "light", base: { present: true, value: "dark" } },
		]);
		assert.equal(result.outcome, "committed", result.summary);
		assert.ok(lstatSync(globalPath).isSymbolicLink());
		assert.deepEqual(json(target), { theme: "light" });
		assert.equal(statSync(target).mode & 0o777, 0o640);
	});

	it("waits for Pi's lock and keeps a cooperating Pi writer's change", async () => {
		const { backend, globalPath, agentDir, cwd } = fixture();
		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		const pi = SettingsManager.create(cwd, agentDir);
		const release = lockfile.lockSync(globalPath, { realpath: false });
		const pending = commit(backend, [
			{ id: "pi:/hideThinkingBlock", scope: "global", action: "set", value: true, base: { present: false } },
		]);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(json(globalPath), { theme: "dark" });
		release();
		const result = await pending;
		assert.equal(result.outcome, "committed", result.summary);
		pi.setDefaultThinkingLevel("high");
		await pi.flush();
		assert.deepEqual(pi.drainErrors(), []);
		assert.deepEqual(json(globalPath), { theme: "dark", hideThinkingBlock: true, defaultThinkingLevel: "high" });
	});

	it("reports the running session's loaded value against the saved one", async () => {
		const { backend, globalPath, setSession } = fixture();
		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		setSession({ theme: "dark" });
		const result = await commit(backend, [
			{ id: "pi:/theme", scope: "global", action: "set", value: "light", base: { present: true, value: "dark" } },
		]);
		assert.equal(result.documents[0].changes[0].apply?.state, "pending-reload");
		setSession({ theme: "light" });
		const entry = backend.get(["pi:/theme"]).entries[0];
		assert.equal(entry.session?.differs, false);
		assert.equal(entry.applyState.state, "applied");
	});

	it("creates and deletes unregistered keys only on request", async () => {
		const { backend, globalPath } = fixture();
		writeFileSync(globalPath, "{}");
		const refused = await commit(backend, [
			{ id: "pi:/myExtension", scope: "global", action: "set", value: 1, base: { present: false } },
		]);
		assert.equal(refused.outcome, "rejected");
		const created = await commit(backend, [
			{ id: "pi:/my.extension~1key", scope: "global", action: "create", value: { a: 1 }, base: { present: false } },
		]);
		assert.equal(created.outcome, "committed", created.summary);
		assert.deepEqual(json(globalPath), { "my.extension/key": { a: 1 } });
		const entry = backend.get(["pi:/my.extension~1key"]).entries[0];
		assert.equal(entry.kind, "unregistered");
		const deleted = await commit(backend, [
			{ id: "pi:/my.extension~1key", scope: "global", action: "delete", base: { present: true, value: { a: 1 } } },
		]);
		assert.equal(deleted.outcome, "committed");
		assert.deepEqual(json(globalPath), {});
	});
});

describe("harness settings", () => {
	const declaration = {
		slice: "sample",
		fields: {
			limit: {
				type: "integer",
				env: "PI_SAMPLE_LIMIT",
				description: "A bounded number.",
				default: 5,
				min: 1,
				max: 10,
				apply: "use",
			},
			low: {
				type: "integer",
				env: "PI_SAMPLE_LOW",
				description: "Must stay below limit.",
				default: 1,
				apply: "reload",
			},
		},
	};
	const rules = {
		check: (_key: string, value: unknown) =>
			Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 10,
		relation: (values: Record<string, unknown>) => ((values.low as number) >= (values.limit as number) ? ["low"] : []),
	};

	it("writes a valid owner value and preserves other sections", async () => {
		const { backend, bus, agentDir, harnessPath, env } = fixture();
		writeFileSync(harnessPath, JSON.stringify({ version: 1, other: { keep: true }, sample: { unknownKey: 1 } }));
		const owner = syntheticOwner(bus, agentDir, declaration, { ...rules, env });
		const entry = backend.get(["harness:/sample/limit"]).entries[0];
		assert.equal(entry.ownerState, "available");
		assert.equal(entry.apply.timing, "use");
		const result = await commit(backend, [
			{ id: "harness:/sample/limit", action: "set", value: 8, base: { present: false }, schema: owner.schema },
		]);
		assert.equal(result.outcome, "committed", result.summary);
		assert.deepEqual(json(harnessPath), { version: 1, other: { keep: true }, sample: { unknownKey: 1, limit: 8 } });
		assert.equal(result.documents[0].changes[0].apply?.state, "next-use");
	});

	it("lets the owner reject a candidate even when an environment value masks it", async () => {
		const { backend, bus, agentDir, harnessPath, env } = fixture({ env: { PI_SAMPLE_LIMIT: "7" } });
		writeFileSync(harnessPath, JSON.stringify({ version: 1 }));
		syntheticOwner(bus, agentDir, declaration, { ...rules, env });
		const invalid = await commit(backend, [
			{ id: "harness:/sample/limit", action: "set", value: 99, base: { present: false } },
		]);
		assert.equal(invalid.outcome, "rejected");
		assert.match(invalid.documents[0].changes[0].problems.join(" "), /rejects this value/);
		const valid = await commit(backend, [
			{ id: "harness:/sample/limit", action: "set", value: 9, base: { present: false } },
		]);
		assert.equal(valid.outcome, "committed");
		assert.equal(valid.documents[0].changes[0].apply?.state, "masked");
	});

	it("shapes a structured value from its declared schema and keeps member order", async () => {
		const { backend, bus, agentDir, harnessPath, env } = fixture();
		writeFileSync(harnessPath, JSON.stringify({ version: 1 }));
		const structured = {
			slice: "team",
			fields: {
				profiles: {
					type: "json",
					env: "PI_TEAM_PROFILES",
					description: "Named profiles.",
					default: {},
					apply: "use",
					schema: {
						type: "object",
						propertyNames: { type: "string", title: "Name", pattern: "^[a-z]+$" },
						additionalProperties: {
							type: "object",
							title: "Profile",
							properties: { model: { type: "string", title: "Model", format: "model" }, depth: { type: "integer" } },
							required: ["model"],
							additionalProperties: false,
						},
					},
				},
			},
		};
		let judged = 0;
		syntheticOwner(bus, agentDir, structured, {
			env,
			check: () => {
				judged++;
				return true;
			},
		});
		const entry = backend.get(["harness:/team/profiles"]).entries[0];
		assert.equal(entry.value.type, "map");
		assert.deepEqual(entry.value.type === "map" && entry.value.keys, {
			type: "string",
			pattern: "^[a-z]+$",
			label: "Name",
		});
		assert.equal(entry.value.type === "map" && entry.value.values.label, "Profile");
		judged = 0;
		const invalid = await commit(backend, [
			{ id: "harness:/team/profiles", action: "set", value: { Main: { model: "a/b" } }, base: { present: false } },
		]);
		assert.equal(invalid.outcome, "rejected");
		assert.match(
			invalid.documents[0].changes[0].problems.join(" "),
			/team.profiles has a name that is not allowed: "Main"/,
		);
		assert.equal(judged, 0);
		assert.deepEqual(json(harnessPath), { version: 1 });
		const value = { zed: { model: "a/b", depth: 2 }, alpha: { depth: 1, model: "c/d" } };
		const saved = await commit(backend, [
			{ id: "harness:/team/profiles", action: "set", value, base: { present: false } },
		]);
		assert.equal(saved.outcome, "committed", saved.summary);
		assert.equal(JSON.stringify(json(harnessPath)), JSON.stringify({ version: 1, team: { profiles: value } }));
	});

	it("refuses a change that creates a cross-field conflict", async () => {
		const { backend, bus, agentDir, harnessPath, env } = fixture();
		writeFileSync(harnessPath, JSON.stringify({ version: 1, sample: { limit: 3 } }));
		syntheticOwner(bus, agentDir, declaration, { ...rules, env });
		const result = await commit(backend, [
			{ id: "harness:/sample/low", action: "set", value: 4, base: { present: false } },
		]);
		assert.equal(result.outcome, "rejected");
		assert.match(result.documents[0].changes[0].problems.join(" "), /conflict between its settings/);
	});

	it("keeps unknown owner keys unregistered and lets them be removed", async () => {
		const { backend, bus, agentDir, harnessPath, env } = fixture();
		writeFileSync(harnessPath, JSON.stringify({ version: 1, sample: { stray: 1 } }));
		syntheticOwner(bus, agentDir, declaration, { ...rules, env });
		const set = await commit(backend, [
			{ id: "harness:/sample/stray", action: "set", value: 2, base: { present: true, value: 1 } },
		]);
		assert.equal(set.outcome, "rejected");
		const removed = await commit(backend, [
			{ id: "harness:/sample/stray", action: "unset", base: { present: true, value: 1 } },
		]);
		assert.equal(removed.outcome, "committed", removed.summary);
		assert.deepEqual(json(harnessPath), { version: 1, sample: {} });
	});

	it("keeps an absent owner's values and edits them only as raw JSON", async () => {
		const { backend, harnessPath } = fixture();
		writeFileSync(harnessPath, JSON.stringify({ version: 1, gone: { flag: true } }));
		const entry = backend.get(["harness:/gone/flag"]).entries[0];
		assert.equal(entry.ownerState, "absent");
		assert.equal(entry.kind, "unregistered");
		const refused = await commit(backend, [
			{ id: "harness:/gone/flag", action: "set", value: false, base: { present: true, value: true } },
		]);
		assert.equal(refused.outcome, "rejected");
		const raw = await commit(backend, [
			{ id: "harness:/gone/flag", action: "set", value: false, base: { present: true, value: true }, raw: true },
		]);
		assert.equal(raw.outcome, "committed");
		assert.match(raw.documents[0].changes[0].notes.join(" "), /No loaded extension validated/);
		assert.deepEqual(json(harnessPath), { version: 1, gone: { flag: false } });
	});

	it("follows an owner that adds, changes and removes settings without losing values", async () => {
		const { backend, bus, agentDir, harnessPath, env } = fixture();
		writeFileSync(harnessPath, JSON.stringify({ version: 1, sample: { limit: 4, low: 2 } }));
		const first = syntheticOwner(bus, agentDir, declaration, { ...rules, env });
		assert.ok(backend.get(["harness:/sample/low"]).entries[0]);
		first.off();
		const second = syntheticOwner(
			bus,
			agentDir,
			{
				slice: "sample",
				fields: {
					limit: declaration.fields.limit,
					added: { type: "boolean", env: "PI_SAMPLE_ADDED", description: "New.", default: false, apply: "restart" },
				},
			},
			{ env },
		);
		const catalogue = backend.catalogue();
		assert.equal(catalogue.entries.find((entry) => entry.id === "harness:/sample/added")?.apply.timing, "restart");
		assert.equal(catalogue.entries.find((entry) => entry.id === "harness:/sample/low")?.kind, "unregistered");
		const stale = await commit(backend, [
			{ id: "harness:/sample/limit", action: "set", value: 6, base: { present: true, value: 4 }, schema: first.schema },
		]);
		assert.equal(stale.outcome, "rejected");
		assert.equal(stale.documents[0].changes[0].status, "conflict");
		second.off();
		const absent = backend.catalogue();
		assert.equal(absent.owners.find((owner) => owner.owner === "sample")?.state, "absent");
		assert.deepEqual(json(harnessPath), { version: 1, sample: { limit: 4, low: 2 } });
	});

	it("refuses when the owner does not read the proposed document", async () => {
		const { backend, bus, agentDir, harnessPath, env } = fixture();
		writeFileSync(harnessPath, JSON.stringify({ version: 1 }));
		const owner = syntheticOwner(bus, agentDir, declaration, { ...rules, env });
		owner.off();
		// An owner that ignores the environment cannot judge a candidate document.
		const fixedPath = bus.on("harness:settings:request", () => {
			bus.emit("harness:settings:publish", {
				version: 2,
				slice: "sample",
				declaration,
				source: { path: harnessPath, status: "loaded", digest: null, observedAt: new Date().toISOString() },
				records: [],
				diagnostics: [],
			});
		});
		const result = await commit(backend, [
			{ id: "harness:/sample/limit", action: "set", value: 3, base: { present: false } },
		]);
		fixedPath();
		assert.equal(result.outcome, "rejected");
		assert.match(result.documents[0].changes[0].problems.join(" "), /did not read the proposed settings/);
		assert.deepEqual(json(harnessPath), { version: 1 });
	});

	it("leaves the environment and every consumer's view as they were", async () => {
		const { backend, bus, agentDir, harnessPath, env } = fixture({ env: { PI_SAMPLE_LIMIT: "7" } });
		writeFileSync(harnessPath, JSON.stringify({ version: 1, sample: { limit: 4 } }));
		syntheticOwner(bus, agentDir, declaration, { ...rules, env });
		const seen: { path: string; limit: unknown }[] = [];
		bus.on("harness:settings:publish", (input) => {
			const publication = input as {
				slice: string;
				source: { path: string };
				records: { key: string; value: unknown }[];
			};
			if (publication.slice === "sample")
				seen.push({
					path: publication.source.path,
					limit: publication.records.find((record) => record.key === "limit")?.value,
				});
		});
		const result = await commit(backend, [
			{ id: "harness:/sample/limit", action: "set", value: 3, base: { present: true, value: 4 } },
		]);
		assert.equal(result.outcome, "committed", result.summary);
		assert.deepEqual(env, { PI_SAMPLE_LIMIT: "7" });
		const last = seen[seen.length - 1];
		assert.deepEqual(last, { path: harnessPath, limit: 7 });
		assert.ok(seen.some((item) => item.path !== harnessPath && item.limit === 3));
	});

	it("creates the machine document when it is missing and never replaces an invalid one", async () => {
		const { backend, bus, agentDir, harnessPath, env } = fixture();
		syntheticOwner(bus, agentDir, declaration, { ...rules, env });
		const created = await commit(backend, [
			{ id: "harness:/sample/limit", action: "set", value: 2, base: { present: false } },
		]);
		assert.equal(created.outcome, "committed", created.summary);
		assert.deepEqual(json(harnessPath), { version: 1, sample: { limit: 2 } });
		assert.equal(statSync(harnessPath).mode & 0o777, 0o600);
		writeFileSync(harnessPath, JSON.stringify({ sample: { limit: 2 } }));
		const refused = await commit(backend, [
			{ id: "harness:/sample/limit", action: "set", value: 3, base: { present: true, value: 2 } },
		]);
		assert.equal(refused.outcome, "rejected");
		assert.deepEqual(json(harnessPath), { sample: { limit: 2 } });
	});
});

describe("custom settings", () => {
	it("creates, reads, updates, resets and deletes entries with unambiguous names", async () => {
		const { backend, harnessPath, revision } = fixture();
		const dotted = "team.color/primary";
		const id = `custom:/${dotted.replace(/\//g, "~1")}`;
		const created = await commit(
			backend,
			[
				{ id, action: "create", value: "teal", type: "string", description: "Accent colour." },
				{ id: "custom:/team", action: "create", value: { color: { primary: "red" } }, type: "object" },
			],
			{ harness: revision("harness") },
		);
		assert.equal(created.outcome, "committed", created.summary);
		const entries = backend.get([id, "custom:/team"]).entries;
		assert.deepEqual(
			entries.map((entry) => entry.resolved.value),
			["teal", { color: { primary: "red" } }],
		);
		assert.equal(entries[0].description, "Accent colour.");
		const wrongType = await commit(backend, [{ id, action: "set", value: 3, base: { present: true, value: "teal" } }]);
		assert.equal(wrongType.outcome, "rejected");
		const updated = await commit(backend, [
			{ id, action: "set", value: "navy", base: { present: true, value: "teal" } },
		]);
		assert.equal(updated.outcome, "committed", updated.summary);
		const reset = await commit(backend, [{ id, action: "unset", base: { present: true, value: "navy" } }]);
		assert.equal(reset.outcome, "committed");
		const document = json(harnessPath) as { config: { custom: Record<string, unknown> } };
		assert.deepEqual(document.config.custom[dotted], { type: "string", description: "Accent colour." });
		const deleted = await commit(backend, [{ id, action: "delete", base: { present: false } }]);
		assert.equal(deleted.outcome, "committed");
		assert.deepEqual(Object.keys((json(harnessPath) as { config: { custom: object } }).config.custom), ["team"]);
		assert.equal(backend.get([id]).missing[0], id);
	});
});

describe("tools", () => {
	it("changes only the current session's active tools and reports rejected names", () => {
		const { backend } = fixture();
		const view = backend.tools();
		assert.equal(view.session, true);
		assert.deepEqual(view.defaults.resolved, ["read", "bash", "edit", "write"]);
		const result = backend.applyTools({ activate: ["grep", "secret_tool", "missing"], deactivate: ["bash"] });
		assert.deepEqual(result.active, ["read", "grep"]);
		assert.deepEqual(result.activated, ["grep"]);
		assert.deepEqual(result.deactivated, ["bash"]);
		assert.deepEqual(
			result.rejected.map((item) => item.name),
			["secret_tool", "missing"],
		);
		assert.equal(result.applied, true);
	});

	it("reads tools without session controls in a host that lacks them", () => {
		const { backend } = fixture({ tools: false });
		assert.equal(backend.tools().session, false);
		assert.equal(backend.applyTools({ activate: ["grep"] }).applied, false);
	});
});
