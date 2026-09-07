import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyShard, zero } from "./capacity.ts";
import { exportLocal, parseCommand } from "./export.ts";
import { createReader, type ExportDocument, validateExport } from "./readback.ts";

async function document(): Promise<ExportDocument> {
	const day = "2026-09-07",
		shard = emptyShard(day);
	shard.cells = [
		{
			day,
			observationStage: "tool_request",
			resourceClass: "entry",
			resourceId: "synthetic-entry",
			model: "synthetic/model",
			reasoning: "off",
			referenceBodyDigest: "unresolved",
			observerVersion: "1.0.0",
			piVersion: "1.0.0",
			counters: { ...zero(), readRequests: 1 },
		},
	];
	const result = await createReader(() => ({ shards: { [day]: shard } }), {
		now: () => Date.parse(`${day}T00:00:00Z`),
	}).exportCapture();
	validateExport(result);
	return result;
}
async function fixture(run: (directory: string) => Promise<void>) {
	const root = join(homedir(), "Workspace", "dump");
	await mkdir(root, { recursive: true });
	const directory = await mkdtemp(join(root, "pillars-export-test-"));
	await chmod(directory, 0o700);
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
test("command parser admits only bounded literal paths and declared flags", () => {
	assert.deepEqual(parseCommand(""), { kind: "overview", windowDays: 30 });
	assert.deepEqual(parseCommand("--days 7"), { kind: "overview", windowDays: 7 });
	assert.deepEqual(parseCommand("revisions --days 1"), { kind: "revisions", windowDays: 1 });
	assert.deepEqual(parseCommand('export "/local/a b.json" --days 30'), {
		kind: "export",
		path: "/local/a b.json",
		windowDays: 30,
	});
	assert.deepEqual(parseCommand('export "/local/a\\"b\\\\c.json"'), {
		kind: "export",
		path: '/local/a"b\\c.json',
		windowDays: 30,
	});
	for (const args of [
		"export",
		"export ./a.json",
		"export ~/a.json",
		"export https://host/a",
		"export /a/$HOME.json",
		"export /a/`id`.json",
		"export /a.json --days 0",
		"export /a.json --days 31",
		"export /a.json --format csv",
		"export /a.json extra",
		'export "/a\\nb.json"',
		'export "/a.json"suffix',
		"revisions --days 01",
		"--days 1\n",
		"export /a/../b.json",
		"export /a//b.json",
	])
		assert.throws(() => parseCommand(args), /invalid_command/);
});
test("synthetic export publishes complete private JSON and refuses overwrite", async () =>
	fixture(async (directory) => {
		const target = join(directory, "synthetic.json"),
			doc = await document();
		const result = await exportLocal(target, doc);
		assert.equal(result.code, "export_created");
		assert.equal(result.published, true);
		assert.equal(result.durability, "confirmed");
		const stats = await lstat(target);
		assert.equal(stats.mode & 0o777, 0o600);
		assert.equal(stats.nlink, 1);
		const contents = await readFile(target, "utf8");
		const parsed = JSON.parse(contents);
		validateExport(parsed);
		assert.deepEqual(parsed, doc);
		assert.deepEqual(await readdir(directory), ["synthetic.json"]);
		assert.equal((await exportLocal(target, doc)).code, "export_destination_exists");
		assert.equal(await readFile(target, "utf8"), contents);
	}));
test("untrusted parents, missing parents, existing destinations and nonliteral paths fail closed", async () =>
	fixture(async (directory) => {
		const doc = await document();
		assert.equal((await exportLocal("relative.json", doc)).code, "export_invalid_destination");
		assert.equal((await exportLocal(join(directory, "absent", "file.json"), doc)).code, "export_untrusted_destination");
		await chmod(directory, 0o777);
		assert.equal((await exportLocal(join(directory, "file.json"), doc)).code, "export_untrusted_destination");
		await chmod(directory, 0o700);
		const target = join(directory, "existing");
		await mkdir(target);
		assert.equal((await exportLocal(target, doc)).code, "export_destination_exists");
		// Existing OS aliases test rejection without creating a symbolic link.
		const alias =
			process.platform === "darwin" ? "/var/tmp/pillars-synthetic.json" : "/proc/self/root/pillars-synthetic.json";
		assert.equal((await lstat(process.platform === "darwin" ? "/var" : "/proc/self")).isSymbolicLink(), true);
		assert.equal((await exportLocal(alias, doc)).code, "export_untrusted_destination");
	}));
test("prepublication failures leave no final artifact and remove only the owned temporary name", async () =>
	fixture(async (directory) => {
		const doc = await document(),
			sentinel = join(directory, "keep.txt");
		await writeFile(sentinel, "synthetic sentinel");
		for (const stage of ["write", "file_sync", "publish"] as const) {
			const target = join(directory, `${stage}.json`);
			const result = await exportLocal(target, doc, {
				before: (step) => {
					if (step === stage) throw new Error("PRIVATE_ERROR");
				},
			});
			assert.equal(result.code, "export_write_failed");
			assert.equal(result.published, false);
			assert(!JSON.stringify(result).includes("PRIVATE_ERROR"));
			await assert.rejects(lstat(target), { code: "ENOENT" });
			assert.deepEqual(await readdir(directory), ["keep.txt"]);
		}
		const controller = new AbortController();
		controller.abort();
		assert.equal(
			(await exportLocal(join(directory, "cancelled.json"), doc, { signal: controller.signal })).published,
			false,
		);
		assert.deepEqual(await readdir(directory), ["keep.txt"]);
	}));
test("hard-link collision preserves a concurrent destination without overwrite", async () =>
	fixture(async (directory) => {
		const target = join(directory, "race.json"),
			doc = await document();
		const result = await exportLocal(target, doc, {
			before: async (step) => {
				if (step === "publish") await writeFile(target, "synthetic concurrent file", { flag: "wx" });
			},
		});
		assert.equal(result.code, "export_destination_exists");
		assert.equal(await readFile(target, "utf8"), "synthetic concurrent file");
		assert.deepEqual(await readdir(directory), ["race.json"]);
	}));
test("directory sync failure states publication and preserves the complete artifact", async () =>
	fixture(async (directory) => {
		const target = join(directory, "published.json"),
			doc = await document();
		const result = await exportLocal(target, doc, {
			before: (step) => {
				if (step === "directory_sync") throw new Error("PRIVATE_ERROR");
			},
		});
		assert.equal(result.code, "export_published_sync_failed");
		assert.equal(result.published, true);
		assert.equal(result.durability, "unconfirmed");
		assert.deepEqual(JSON.parse(await readFile(target, "utf8")), doc);
		assert.deepEqual(await readdir(directory), ["published.json"]);
	}));
test("runtime heap reserve refuses export before temporary creation", async () =>
	fixture(async (directory) => {
		const doc = await document();
		const module = new URL("./export.ts", import.meta.url).href;
		const target = join(directory, "memory.json");
		const output = execFileSync(
			process.execPath,
			[
				"--max-old-space-size=64",
				"--max-semi-space-size=1",
				"--input-type=module",
				"-e",
				`
			import { exportLocal } from ${JSON.stringify(module)};
			console.log(JSON.stringify(await exportLocal(${JSON.stringify(target)}, ${JSON.stringify(doc)})));
		`,
			],
			{ encoding: "utf8", timeout: 10_000, maxBuffer: 8192 },
		);
		assert.equal(JSON.parse(output).code, "export_too_large");
		assert.deepEqual(await readdir(directory), []);
	}));
test("export refuses temporary heap growth before filesystem writes", async (t) =>
	fixture(async (directory) => {
		const doc = await document();
		const baseline = process.memoryUsage();
		let calls = 0;
		t.mock.method(process, "memoryUsage", () => ({
			...baseline,
			heapUsed: baseline.heapUsed + (++calls > 2 ? 193 * 1024 * 1024 : 0),
		}));
		const result = await exportLocal(join(directory, "memory.json"), doc);
		assert.equal(result.code, "export_too_large");
		assert.deepEqual(await readdir(directory), []);
	}));
test("parent replacement fails closed without deletion in the replacement directory", async () =>
	fixture(async (directory) => {
		const doc = await document();
		const parent = join(directory, "parent");
		const moved = join(directory, "moved");
		await mkdir(parent, { mode: 0o700 });
		let temporary = "";
		const result = await exportLocal(join(parent, "final.json"), doc, {
			before: async (step) => {
				if (step !== "publish") return;
				temporary = (await readdir(parent))[0];
				await rename(parent, moved);
				await mkdir(parent, { mode: 0o700 });
				await writeFile(join(parent, temporary), "synthetic replacement");
			},
		});
		assert.equal(result.code, "export_write_failed");
		assert.equal(await readFile(join(parent, temporary), "utf8"), "synthetic replacement");
		await assert.rejects(lstat(join(parent, "final.json")), { code: "ENOENT" });
		assert.deepEqual(await readdir(moved), [temporary]);
	}));
test("temporary replacement fails closed and preserves a foreign hard link", async () =>
	fixture(async (directory) => {
		const doc = await document();
		const sentinel = join(directory, "sentinel");
		await writeFile(sentinel, "synthetic foreign file");
		let temporary = "";
		const result = await exportLocal(join(directory, "final.json"), doc, {
			before: async (step) => {
				if (step !== "publish") return;
				temporary = (await readdir(directory)).find((name) => name.startsWith(".pillars-export-"))!;
				await rename(join(directory, temporary), join(directory, "moved"));
				await link(sentinel, join(directory, temporary));
			},
		});
		assert.equal(result.code, "export_write_failed");
		assert.equal(await readFile(join(directory, temporary), "utf8"), "synthetic foreign file");
		assert.equal((await lstat(sentinel)).nlink, 2);
		await assert.rejects(lstat(join(directory, "final.json")), { code: "ENOENT" });
	}));
test("cancellation at the publication boundary leaves no final artifact", async () =>
	fixture(async (directory) => {
		const controller = new AbortController();
		const result = await exportLocal(join(directory, "cancelled.json"), await document(), {
			signal: controller.signal,
			before: (step) => {
				if (step === "publish") controller.abort();
			},
		});
		assert.equal(result.published, false);
		assert.deepEqual(await readdir(directory), []);
	}));
test("invalid export documents fail before temporary creation", async () =>
	fixture(async (directory) => {
		const doc = await document();
		(doc as any).privateOwner = "synthetic-private";
		const result = await exportLocal(join(directory, "invalid.json"), doc);
		assert.equal(result.code, "export_write_failed");
		assert.deepEqual(await readdir(directory), []);
	}));
