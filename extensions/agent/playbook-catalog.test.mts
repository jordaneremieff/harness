import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { it, type TestContext } from "node:test";
import { bundledPlaybooks, readPlaybookCatalog } from "./playbook-catalog.ts";
import { applyPlaybookImport, previewPlaybookImport } from "./playbook-import.ts";

const starterNames = ["architect", "maker", "orchestrator"];
function fixture(t: TestContext, section: Record<string, unknown> = {}) {
	const agentDir = fs.mkdtempSync(join(tmpdir(), "playbook-catalog-"));
	const config = join(agentDir, "harness.json");
	const prev = [process.env.PI_HARNESS_FILE, process.env.PI_AGENT_PLAYBOOKS_DIR, process.env.PI_AGENT_PRESETS];
	process.env.PI_HARNESS_FILE = config;
	delete process.env.PI_AGENT_PLAYBOOKS_DIR;
	delete process.env.PI_AGENT_PRESETS;
	t.after(() => {
		for (const [index, key] of ["PI_HARNESS_FILE", "PI_AGENT_PLAYBOOKS_DIR", "PI_AGENT_PRESETS"].entries()) {
			const value = prev[index];
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
	const dir = join(agentDir, "playbooks");
	const backing = join(agentDir, "playbooks-data");
	fs.writeFileSync(config, JSON.stringify({ version: 1, agent: section }));
	return { agentDir, dir, backing, config };
}
const text = (name: string, body = "Operator text.") => `# ${name}\n\nOne summary\n\n${body}\n`;

it("seeds only on explicit first use, publishes all three files in a stable backing directory, and then leaves edits alone", (t) => {
	const { agentDir, dir, backing } = fixture(t);
	assert.deepEqual(bundledPlaybooks().map(({ name }) => name), starterNames);
	assert.equal(readPlaybookCatalog(agentDir).state, "missing");
	assert.ok(!fs.existsSync(dir) && !fs.existsSync(backing));
	const catalog = readPlaybookCatalog(agentDir, { initialize: true });
	assert.deepEqual(catalog.diagnostics, []);
	assert.equal(catalog.state, "ready");
	assert.equal(catalog.backingDir, fs.realpathSync(backing));
	assert.equal(fs.readlinkSync(dir), basename(backing));
	assert.equal(fs.statSync(backing).mode & 0o777, 0o700);
	assert.deepEqual(catalog.entries, bundledPlaybooks());
	assert.equal(fs.statSync(join(dir, "maker.md")).mode & 0o777, 0o600);
	fs.writeFileSync(join(dir, "maker.md"), text("maker", "New instruction."));
	assert.equal(readPlaybookCatalog(agentDir, { initialize: true }).entries.find(({ name }) => name === "maker")?.body, "New instruction.");
	for (const name of starterNames) fs.unlinkSync(join(dir, `${name}.md`));
	assert.deepEqual(readPlaybookCatalog(agentDir, { initialize: true }).entries, []);
});

it("does not seed an empty real directory, an unsafe link, a dangling data link, or an interrupted backing directory", (t) => {
	const { agentDir, dir, backing } = fixture(t);
	fs.mkdirSync(dir, 0o700);
	assert.equal(readPlaybookCatalog(agentDir, { initialize: true }).state, "ready");
	assert.deepEqual(fs.readdirSync(dir), []);
	fs.rmdirSync(dir);
	fs.symlinkSync(agentDir, dir);
	assert.equal(readPlaybookCatalog(agentDir, { initialize: true }).state, "unavailable");
	fs.unlinkSync(dir);
	fs.symlinkSync(basename(backing), dir);
	assert.equal(readPlaybookCatalog(agentDir, { initialize: true }).state, "unavailable");
	assert.equal(fs.readlinkSync(dir), basename(backing));
	fs.unlinkSync(dir);
	fs.mkdirSync(backing, 0o700);
	fs.writeFileSync(join(backing, "draft.md"), "unpublished content");
	const catalog = readPlaybookCatalog(agentDir, { initialize: true });
	assert.equal(catalog.state, "unavailable");
	assert.match(catalog.diagnostics.join("\n"), /playbooks-data.*already present/u);
	assert.deepEqual(fs.readdirSync(backing), ["draft.md"]);
	assert.ok(!fs.existsSync(dir));
});

it("leaves an operator directory created just before seed publication intact", (t) => {
	const { agentDir, dir, backing } = fixture(t);
	const symlink = fs.symlinkSync;
	let winner: number | undefined;
	const hook = t.mock.method(fs, "symlinkSync", (source: PathLike, destination: PathLike, type?: fs.symlink.Type | null) => {
		assert.equal(String(source), basename(backing));
		assert.equal(String(destination), join(fs.realpathSync(agentDir), "playbooks"));
		assert.deepEqual(fs.readdirSync(backing).sort(), starterNames.map((name) => `${name}.md`));
		fs.mkdirSync(destination, 0o700);
		winner = fs.statSync(destination).ino;
		return symlink(source, destination, type);
	});
	syncBuiltinESMExports();
	try {
		assert.equal(readPlaybookCatalog(agentDir, { initialize: true }).state, "ready");
		assert.equal(hook.mock.callCount(), 1);
		assert.equal(fs.statSync(dir).ino, winner);
		assert.deepEqual(fs.readdirSync(dir), []);
		assert.ok(!fs.existsSync(backing));
	} finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

it("keeps valid neighbours and warns rather than rejecting a name shared with a preset", (t) => {
	const { agentDir, dir } = fixture(t, { presets: { maker: { model: "acme/example" } } });
	fs.mkdirSync(dir, 0o700);
	fs.writeFileSync(join(dir, "maker.md"), text("maker").replaceAll("\n", "\r\n"));
	fs.writeFileSync(join(dir, "other.md"), text("other"));
	fs.writeFileSync(join(dir, "invalid.md"), text("wrong"));
	fs.writeFileSync(join(dir, "Too-Much.MD"), text("too-much"));
	fs.writeFileSync(join(dir, "off.md"), text("off"));
	fs.writeFileSync(join(dir, "huge.md"), Buffer.alloc(16 * 1024 + 1, 97));
	fs.writeFileSync(join(dir, "utf.md"), Buffer.from([255]));
	fs.writeFileSync(join(dir, "bom.md"), `\uFEFF${text("bom")}`);
	fs.symlinkSync("maker.md", join(dir, "alias.md"));
	const catalog = readPlaybookCatalog(agentDir);
	assert.equal(catalog.state, "ready");
	assert.deepEqual(catalog.entries.map(({ name }) => name), ["maker", "other"]);
	assert.match(catalog.diagnostics.join("\n"), /maker\.md.*also used by an execution preset/u);
	for (const name of ["invalid", "Too-Much", "off", "huge", "utf", "bom", "alias"]) assert.ok(catalog.diagnostics.some((fact) => fact.includes(name)));
});

it("marks an over-limit inventory incomplete and ignores invalid configured locations for writes", (t) => {
	const { agentDir, dir, backing } = fixture(t, { playbooksDir: 5 });
	assert.equal(readPlaybookCatalog(agentDir, { initialize: true }).state, "unavailable");
	assert.ok(!fs.existsSync(dir) && !fs.existsSync(backing));
	fs.mkdirSync(dir, 0o700);
	for (let i = 0; i < 129; i++) fs.writeFileSync(join(dir, `p${i}.md`), text(`p${i}`));
	const count = readPlaybookCatalog(agentDir);
	assert.equal(count.state, "incomplete");
	assert.equal(count.entries.length, 0);
	assert.match(count.diagnostics.join("\n"), /128 Markdown candidates/u);
});

it("previews exact text without writes, imports a single reviewed starter and keeps the actual displaced inode", (t) => {
	const { agentDir, dir } = fixture(t);
	assert.throws(() => previewPlaybookImport(agentDir, "maker"), /missing/u);
	assert.ok(!fs.existsSync(dir));
	fs.mkdirSync(dir, 0o700);
	const create = previewPlaybookImport(agentDir, "maker");
	assert.equal(create.action, "add");
	assert.deepEqual(fs.readdirSync(dir), []);
	assert.match(applyPlaybookImport(agentDir, create), /Added maker/u);
	const unchanged = previewPlaybookImport(agentDir, "maker");
	assert.equal(unchanged.action, "unchanged");
	assert.match(applyPlaybookImport(agentDir, unchanged), /No file changed/u);
	const path = join(dir, "maker.md");
	const old = "Heading needs repair.\r\n";
	fs.writeFileSync(path, old);
	fs.writeFileSync(join(dir, "other.md"), text("other"));
	const inode = fs.statSync(path).ino;
	const preview = previewPlaybookImport(agentDir, "maker");
	assert.equal(preview.currentText, old);
	assert.equal(preview.action, "replace");
	assert.match(applyPlaybookImport(agentDir, preview), /Previous file retained/u);
	const recovery = fs.readdirSync(dir).find((name) => name.startsWith(".playbook-import-maker-"));
	assert.ok(recovery);
	assert.equal(fs.statSync(join(dir, recovery, "previous")).ino, inode);
	assert.equal(fs.readFileSync(join(dir, recovery, "previous"), "utf8"), old);
	assert.equal(fs.readFileSync(path, "utf8"), create.starterText);
	assert.equal(fs.readFileSync(join(dir, "other.md"), "utf8"), text("other"));
	assert.match(readPlaybookCatalog(agentDir).diagnostics.join("\n"), /retained import recovery data/u);
});

it("refuses a stale review, changed root, and an unreviewed add", (t) => {
	const { agentDir, dir } = fixture(t);
	fs.mkdirSync(dir, 0o700);
	const path = join(dir, "maker.md");
	fs.writeFileSync(path, text("maker"));
	const first = previewPlaybookImport(agentDir, "maker");
	fs.writeFileSync(path, text("maker", "Changed."));
	assert.throws(() => applyPlaybookImport(agentDir, first), /changed.*Preview again/u);
	assert.equal(fs.readFileSync(path, "utf8"), text("maker", "Changed."));
	const second = previewPlaybookImport(agentDir, "maker");
	fs.renameSync(dir, `${dir}-former`);
	fs.mkdirSync(dir, 0o700);
	assert.throws(() => applyPlaybookImport(agentDir, second), /changed/u);
	const third = previewPlaybookImport(agentDir, "maker");
	assert.throws(() => applyPlaybookImport(agentDir, { ...third }), /fresh import preview/u);
	fs.writeFileSync(path, text("maker", "Won the name."));
	assert.throws(() => applyPlaybookImport(agentDir, third), /changed/u);
});

it("retains a late editor's public file and the displaced previous file if publication loses the name", (t) => {
	const { agentDir, dir } = fixture(t);
	fs.mkdirSync(dir, 0o700);
	const path = join(dir, "maker.md");
	fs.writeFileSync(path, text("maker"));
	const preview = previewPlaybookImport(agentDir, "maker");
	const link = fs.linkSync;
	const hook = t.mock.method(fs, "linkSync", (source: PathLike, destination: PathLike) => {
		if (basename(String(source)) === "starter") fs.writeFileSync(destination, text("maker", "Concurrent save."), { flag: "wx" });
		return link(source, destination);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => applyPlaybookImport(agentDir, preview), /did not publish.*occupies.*Recovery data/u);
		assert.equal(fs.readFileSync(path, "utf8"), text("maker", "Concurrent save."));
		const recovery = fs.readdirSync(dir).find((name) => name.startsWith(".playbook-import-maker-"));
		assert.ok(recovery);
		assert.equal(fs.readFileSync(join(dir, recovery, "previous"), "utf8"), text("maker"));
	} finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

it("captures a replacement made at the move boundary and restores that actual file", (t) => {
	const { agentDir, dir } = fixture(t);
	fs.mkdirSync(dir, 0o700);
	const path = join(dir, "maker.md");
	fs.writeFileSync(path, text("maker"));
	const preview = previewPlaybookImport(agentDir, "maker");
	const late = text("maker", "Changed before capture.");
	const rename = fs.renameSync;
	const hook = t.mock.method(fs, "renameSync", (source: PathLike, destination: PathLike) => {
		if (basename(String(destination)) === "previous") {
			const temporary = join(dir, "editor-draft");
			fs.writeFileSync(temporary, late);
			rename(temporary, String(source));
		}
		return rename(source, destination);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => applyPlaybookImport(agentDir, preview), /changed at the import boundary.*restored/u);
		assert.equal(fs.readFileSync(path, "utf8"), late);
		const recovery = fs.readdirSync(dir).find((name) => name.startsWith(".playbook-import-maker-"));
		assert.ok(recovery);
		assert.equal(fs.statSync(join(dir, recovery, "previous")).ino, fs.statSync(path).ino);
	} finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

it("reports an import interrupted after capture and does not silently apply it on reopen", (t) => {
	const { agentDir, dir } = fixture(t);
	fs.mkdirSync(dir, 0o700);
	const path = join(dir, "maker.md");
	fs.writeFileSync(path, text("maker"));
	fs.writeFileSync(join(dir, "other.md"), text("other"));
	const moduleUrl = new URL("./playbook-import.ts", import.meta.url).href;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		const original = fs.renameSync;
		fs.renameSync = (...args) => { original(...args); process.exit(23); };
		syncBuiltinESMExports();
		const { previewPlaybookImport, applyPlaybookImport } = await import(${JSON.stringify(moduleUrl)});
		const agentDir = process.argv[1];
		applyPlaybookImport(agentDir, previewPlaybookImport(agentDir, "maker"));
	`, agentDir], { encoding: "utf8", timeout: 5000 });
	assert.equal(child.status, 23, child.error?.message ?? child.stderr);
	assert.ok(!fs.existsSync(path));
	const catalog = readPlaybookCatalog(agentDir, { initialize: true });
	assert.deepEqual(catalog.entries.map(({ name }) => name), ["other"]);
	assert.match(catalog.diagnostics.join("\n"), /import is active or interrupted/u);
	const recovery = fs.readdirSync(dir).find((name) => name.startsWith(".playbook-import-maker-"));
	assert.ok(recovery);
	assert.equal(fs.readFileSync(join(dir, recovery, "previous"), "utf8"), text("maker"));
	assert.throws(() => applyPlaybookImport(agentDir, previewPlaybookImport(agentDir, "maker")), /active or interrupted/u);
	assert.ok(!fs.existsSync(path));
});
