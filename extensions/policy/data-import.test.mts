import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { DATA_LIMITS, lookupData, type NamedData, snapshotData, validateNamedData } from "./data.ts";
import {
	dataFileApprovalText,
	dataReview,
	MAX_DATA_APPROVAL_OUTPUT_BYTES,
	MAX_DATA_REVIEW_BYTES,
	MAX_DATA_SOURCE_BYTES,
	normalizeDataArtifact,
	readDataArtifact,
} from "./data-import.ts";
import {
	MAX_DATA_EVENT_BYTES,
	MAX_REGISTRY_BYTES,
	MAX_RULE_EVENT_BYTES,
	namedDataRevision,
	RuleRegistry,
} from "./local-rules.ts";
import { PolicyApprovalPanel, terminalSafe } from "./panel.ts";
import { contentRevision } from "./rule.ts";
import { policyDataCommand } from "./tools.ts";

const audit = { surface: "command" as const, at: "2026-09-14T00:00:00.000Z", session: "data-import", model: null };
const reject = async () => false;
function source(count = 1800) {
	return {
		data: {
			name: "aliases",
			kind: "table" as const,
			source: "operator-source",
			capturedAt: 1000,
			collation: "ascii-case-insensitive" as const,
			rows: Array.from({ length: count }, (_, i) => ({
				key: `Alias${i}`,
				value: `destination-${i}-${"x".repeat(32)}`,
			})),
		},
		expectedRevision: null as string | null,
	};
}
async function setup(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "policy-data-import-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const store = join(dir, "store");
	const registry = new RuleRegistry(store, { catalog: [], onNotice() {} });
	const path = join(dir, "source.json");
	const input = source();
	await writeFile(path, JSON.stringify(input));
	return {
		dir,
		path,
		input,
		registry,
		command: (args: object, confirm = reject) =>
			policyDataCommand(registry, `set-file ${JSON.stringify(args)}`, audit, confirm, dir),
	};
}
function approval(output: string) {
	const command = output.split("Exact approval command:\n")[1];
	assert.ok(command?.startsWith("/policy data set-file "), output);
	return JSON.parse(command.slice("/policy data set-file ".length)) as { path: string; approveRevision: string };
}
function sizedData(bytes: number): NamedData {
	const raw = source(64).data;
	raw.rows = raw.rows.map((row) => ({ ...row, value: "" }));
	let remaining = bytes - Buffer.byteLength(JSON.stringify({ ...raw, revision: "000000000000" }));
	for (const row of raw.rows) {
		const controls = Math.min(700, Math.floor(remaining / 6));
		row.value = "\0".repeat(controls);
		remaining -= controls * 6;
	}
	assert.ok(remaining < 6);
	raw.rows[0].value += "x".repeat(remaining);
	return { ...raw, revision: namedDataRevision(raw) };
}

describe("complete named-data file import", () => {
	it("keeps safely escaped long source paths inside one complete approval command", () => {
		const path = `/${"\u0085\u202e".repeat(2047)}x`;
		assert.equal(path.length, 4096);
		const output = dataFileApprovalText(path, "0123456789ab");
		assert.equal(terminalSafe(output), output);
		assert.ok(Buffer.byteLength(output) <= MAX_DATA_APPROVAL_OUTPUT_BYTES);
		assert.equal(approval(output).path, path);
		const overhead = Buffer.byteLength(dataFileApprovalText("", "0123456789ab"));
		for (const delta of [-1, 0, 1]) {
			const boundary = "x".repeat(MAX_DATA_APPROVAL_OUTPUT_BYTES - overhead + delta);
			if (delta > 0) assert.throws(() => dataFileApprovalText(boundary, "0123456789ab"), /output byte bound/);
			else
				assert.equal(
					Buffer.byteLength(dataFileApprovalText(boundary, "0123456789ab")),
					MAX_DATA_APPROVAL_OUTPUT_BYTES + delta,
				);
		}
	});
	it("captures all rows in one event, replays them, and preserves data identity and freshness", async (t) => {
		const { path, input, registry, command } = await setup(t);
		let reviewed = "";
		const preview = await command({ path: "source.json" }, async (_title?: string, message?: string) => {
			reviewed = message!;
			return false;
		});
		assert.equal(reviewed, terminalSafe(reviewed));
		assert.ok(Buffer.byteLength(reviewed) <= MAX_DATA_REVIEW_BYTES);
		for (const row of input.data.rows) assert.ok(reviewed.includes(JSON.stringify(row)));
		assert.equal((await registry.snapshot()).data.size, 0);
		const token = approval(preview);
		assert.equal(token.path, path);
		const artifact = await readDataArtifact(path);
		assert.equal(token.approveRevision, contentRevision(artifact));
		assert.match(
			await command(token, async () => {
				throw new Error("approved token does not open UI");
			}),
			/uses revision/,
		);
		const lines = (await readFile(registry.path, "utf8")).trim().split("\n");
		const dataLines = lines.filter((line) => JSON.parse(line).kind === "data");
		assert.equal(dataLines.length, 1);
		assert.ok(Buffer.byteLength(dataLines[0]) > MAX_RULE_EVENT_BYTES);
		assert.ok(Buffer.byteLength(dataLines[0]) < MAX_DATA_EVENT_BYTES);
		const reloaded = new RuleRegistry(dirname(registry.path), { catalog: [] });
		const persisted = (await reloaded.snapshot()).data.get("aliases")!;
		assert.deepEqual(persisted, artifact.data);
		assert.equal(persisted.capturedAt, 1000);
		const captured = snapshotData([persisted], 1001);
		assert.deepEqual(lookupData(captured.aliases, "ALIAS1799"), {
			status: "unique",
			value: input.data.rows[1799].value,
		});
		const replacement = source(1);
		replacement.expectedRevision = persisted.revision;
		replacement.data.rows[0].value = "replacement";
		await writeFile(path, JSON.stringify(replacement));
		await command(approval(await command({ path })));
		assert.deepEqual(lookupData(captured.aliases, "alias0"), { status: "unique", value: input.data.rows[0].value });
		assert.equal((await reloaded.snapshot()).data.get("aliases")?.capturedAt, 1000);
		await assert.rejects(command(token), /exact complete artifact revision/);
	});

	it("rejects changed rows, metadata, expected revision, and unknown fields before UI or append", async (t) => {
		const { path, input, registry, command } = await setup(t);
		const token = approval(await command({ path }));
		const changes = [
			{ ...input, data: { ...input.data, source: "changed" } },
			{ ...input, data: { ...input.data, capturedAt: 1001 } },
			{ ...input, data: { ...input.data, collation: "exact" } },
			{ ...input, data: { ...input.data, rows: [{ key: "new", value: "new" }] } },
			{ ...input, expectedRevision: "0123456789ab" },
			{ ...input, ignored: true },
		];
		for (const changed of changes) {
			await writeFile(path, JSON.stringify(changed));
			await assert.rejects(
				command(token, async () => {
					throw new Error("unexpected review");
				}),
				/artifact revision|requires data and expectedRevision/,
			);
			assert.equal((await registry.snapshot()).data.size, 0);
		}
	});

	it("captures bytes before UI and appends that copy even if the source changes during review", async (t) => {
		const { path, input, registry, command } = await setup(t);
		await command({ path }, async () => {
			await writeFile(path, JSON.stringify(source(1)));
			return true;
		});
		const persisted = (await registry.snapshot()).data.get("aliases")!;
		assert.equal(persisted.kind === "table" && persisted.rows.length, input.data.rows.length);
	});

	it("requires explicit file metadata and validates optional deterministic revision", () => {
		const input = source(1);
		for (const field of ["source", "capturedAt"]) {
			const data = { ...input.data } as Record<string, unknown>;
			delete data[field];
			assert.throws(() => normalizeDataArtifact({ ...input, data }), /explicit source and capturedAt/);
		}
		assert.throws(
			() => normalizeDataArtifact({ ...input, data: { ...input.data, revision: "0123456789ab" } }),
			/revision does not describe/,
		);
		const artifact = normalizeDataArtifact(input);
		assert.deepEqual(normalizeDataArtifact(artifact), artifact);
		assert.deepEqual(normalizeDataArtifact(JSON.parse(JSON.stringify(input))), artifact);
	});

	it("rejects nonregular files, symlinks, URLs, oversize files and malformed UTF-8", async (t) => {
		const { dir, path, command } = await setup(t);
		const linked = join(dir, "linked.json");
		await symlink(path, linked);
		const directory = join(dir, "directory");
		await mkdir(directory);
		for (const file of [linked, directory]) await assert.rejects(readDataArtifact(file), /regular non-symlink/);
		await assert.rejects(command({ path: "https://example.com/table.json" }), /local file/);
		await writeFile(path, Buffer.alloc(MAX_DATA_SOURCE_BYTES + 1));
		await assert.rejects(readDataArtifact(path), /file byte bound/);
		await writeFile(path, Buffer.from([0xff]));
		await assert.rejects(readDataArtifact(path), /encoded data/);
	});

	it("accepts the exact source bound and rejects an additional byte", async (t) => {
		const { path } = await setup(t);
		const json = JSON.stringify(source(1));
		await writeFile(path, json + " ".repeat(MAX_DATA_SOURCE_BYTES - Buffer.byteLength(json)));
		assert.equal((await readDataArtifact(path)).data.name, "aliases");
		await appendFile(path, " ");
		await assert.rejects(readDataArtifact(path), /file byte bound/);
	});

	it("uses serialized normalized bytes including JSON escaping at the exact bound", async (t) => {
		const { path, registry, command } = await setup(t);
		for (const delta of [-1, 0, 1]) {
			const data = sizedData(DATA_LIMITS.bytes + delta);
			assert.equal(Buffer.byteLength(JSON.stringify(data)), DATA_LIMITS.bytes + delta);
			if (delta <= 0) assert.equal(validateNamedData(data), undefined);
			else assert.match(validateNamedData(data)!, /serialized byte bound/);
		}
		const data = sizedData(DATA_LIMITS.bytes);
		await writeFile(path, JSON.stringify({ data, expectedRevision: null }));
		await command(approval(await command({ path })));
		assert.deepEqual((await registry.snapshot()).data.get(data.name), data);
	});

	it("applies the same inclusive data and ordinary event bounds during replay", async (t) => {
		for (const kind of ["data", "proposal"] as const) {
			const { registry, dir } = await setup(t);
			const event =
				kind === "data"
					? await registry.setData(normalizeDataArtifact(source(1)).data, null, audit)
					: await registry.proposeAdd(
							{
								id: "sample.rule",
								purpose: "Protect output.",
								authority: "steer-or-block",
								matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "sample" } },
								note: "Use bounded output.",
							},
							"Protect output.",
							{ ...audit, surface: "agent-tool" },
						);
			const json = JSON.stringify(event);
			const limit = kind === "data" ? MAX_DATA_EVENT_BYTES : MAX_RULE_EVENT_BYTES;
			for (const delta of [-1, 0, 1]) {
				const target = join(dir, `${kind}-${delta}`);
				await mkdir(target, { mode: 0o700 });
				await writeFile(
					join(target, "rules.jsonl"),
					`${json}${" ".repeat(limit - Buffer.byteLength(json) - 1 + delta)}\n`,
					{ mode: 0o600 },
				);
				const snapshot = await new RuleRegistry(target, { catalog: [], onNotice() {} }).snapshot();
				assert.equal(snapshot.health.status, delta > 0 ? "degraded" : "ok");
				if (delta <= 0) assert.equal(kind === "data" ? snapshot.data.size : snapshot.pending.length, 1);
			}
		}
	});

	it("escapes terminal controls without changing the complete review fields", () => {
		const input = source(1);
		input.data.rows[0] = { key: "A\u0085\u202e", value: "B\u009f\u2066" };
		const artifact = normalizeDataArtifact(input);
		const review = dataReview(artifact, contentRevision(artifact));
		assert.equal(terminalSafe(review), review);
		assert.doesNotMatch(review, /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/);
		assert.deepEqual(JSON.parse(review.split("\n").at(-1)!), input.data.rows[0]);
	});

	it("preflights capacity before review and rechecks capacity after approval", async (t) => {
		const { registry, path, command } = await setup(t);
		const data = sizedData(DATA_LIMITS.bytes);
		await registry.setData(data, null, audit);
		const other = new RuleRegistry(dirname(registry.path), { catalog: [] });
		const fill = async () => {
			while ((await readFile(registry.path)).length + DATA_LIMITS.bytes + 1000 <= MAX_REGISTRY_BYTES)
				await other.setData(data, data.revision, audit);
		};
		const next = { ...data, source: "replacement", revision: "" };
		next.revision = namedDataRevision(next);
		await writeFile(path, JSON.stringify({ data: next, expectedRevision: data.revision }));
		await assert.rejects(
			command({ path }, async () => {
				await fill();
				return true;
			}),
			/store would exceed/,
		);
		const size = (await readFile(registry.path)).length;
		await assert.rejects(
			command({ path }, async () => {
				throw new Error("unexpected UI");
			}),
			/store would exceed/,
		);
		assert.equal((await readFile(registry.path)).length, size);
		assert.deepEqual((await registry.snapshot()).data.get(data.name), data);
	});

	it("rejects stale revision before review and preserves the approved copy while setData waits", async (t) => {
		const { registry, path, command } = await setup(t);
		const artifact = await readDataArtifact(path);
		await registry.setData(artifact.data, null, audit);
		await assert.rejects(
			command({ path }, async () => {
				throw new Error("unexpected UI");
			}),
			/revision changed/,
		);
		const replacement = normalizeDataArtifact(source(1)).data;
		const pending = registry.setData(replacement, artifact.data.revision, audit);
		if (replacement.kind === "table") replacement.rows[0].value = "unapproved";
		await pending;
		const stored = (await registry.snapshot()).data.get("aliases")!;
		assert.notEqual(stored.kind === "table" && stored.rows[0].value, "unapproved");
	});

	it("shows every complete row in the approval panel and refuses early approval", () => {
		const artifact = normalizeDataArtifact(source(DATA_LIMITS.rows));
		const review = dataReview(artifact, contentRevision(artifact));
		const decisions: boolean[] = [];
		const panel = new PolicyApprovalPanel({
			title: "Data review",
			artifact: review,
			tui: { requestRender() {} },
			getMaxRows: () => 40,
			done: (value) => decisions.push(value),
		});
		const seen = new Set<number>();
		for (let page = 0; page < 400; page++) {
			const rendered = panel.render(180).join("\n");
			for (const match of rendered.matchAll(/Alias(\d+)/g)) seen.add(Number(match[1]));
			panel.handleInput("a");
			if (decisions.length) break;
			panel.handleInput(" ");
		}
		assert.deepEqual(decisions, [true]);
		assert.equal(seen.size, DATA_LIMITS.rows);
	});
});
