import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BLOCK_VERSION, configBlock, findConfigBlock, withConfigBlock, withoutConfigBlock } from "./config-block.ts";
import { rexCommand, type SetupDeps } from "./setup.ts";

const REGISTRY = "/agent/rex/palette.json";
const askActionBlock = () => configBlock(REGISTRY);
const findAskBlock = (source: string) => findConfigBlock(source, REGISTRY);
const withAskAction = (source: string) => withConfigBlock(source, REGISTRY);
const withoutAskAction = (source: string) => withoutConfigBlock(source, REGISTRY);
import type { CliCall, CliResult, RexTransport } from "./transport.ts";

const operatorConfig = '-- my bindings\nrex.bind("cmd+x", "pi_quit")\n';

test("setup adds and removes only its own exact block, leaving every other byte as it was", () => {
	assert.equal(findAskBlock(operatorConfig), undefined);
	const added = withAskAction(operatorConfig);
	assert.equal(added, `${operatorConfig}${askActionBlock()}\n`);
	assert.match(added, /-- pi-harness: pi actions v3 begin/);
	assert.deepEqual(
		[...added.matchAll(/^ {2}name = "([^"]+)"/gm)].map((match) => match[1]),
		["pi_ask", "pi_command"],
	);
	assert.ok(findAskBlock(added));
	const otherVersion = added.replace(`pi actions v${BLOCK_VERSION} begin`, "pi actions v2 begin");
	assert.throws(() => withAskAction(otherVersion), /differs from the version 3 block/);
	assert.throws(() => withoutAskAction(otherVersion), /differs from the version 3 block/);
	assert.equal(withAskAction(added), added, "a configuration that holds the block stays as it is");
	assert.equal(withoutAskAction(added), operatorConfig, "removal restores the text before setup");
	const spaced = "x = 1\n\n\n";
	assert.equal(withoutAskAction(withAskAction(spaced)), spaced, "blank lines of the operator stay");
	assert.equal(withAskAction(""), `${askActionBlock()}\n`);
	assert.equal(
		withAskAction("x = 1"),
		`x = 1\n${askActionBlock()}\n`,
		"a last line without a line break gets one before the block",
	);
	const crlf = `a = 1\r\n${askActionBlock().replaceAll("\n", "\r\n")}\r\nb = 2\r\n`;
	assert.equal(withoutAskAction(crlf), "a = 1\r\nb = 2\r\n", "a block saved with CRLF line ends is removed whole");
	assert.equal(
		withoutAskAction(`${askActionBlock()}`),
		"",
		"a block at the end without a final line break is removed whole",
	);
	for (const broken of [
		`-- pi-harness: pi actions v${BLOCK_VERSION} begin\nno end\n`,
		"no begin\n-- pi-harness: pi actions end\n",
		`-- pi-harness: pi actions end\n-- pi-harness: pi actions v${BLOCK_VERSION} begin\n`,
		`${askActionBlock()}\n${askActionBlock()}\n`,
	])
		assert.throws(() => withAskAction(broken), /partial or repeated/, broken);
	const inString = `local note = [[\n-- pi-harness: pi actions v${BLOCK_VERSION} begin\nkeep this text\n-- pi-harness: pi actions end\n]]\n`;
	assert.throws(
		() => withAskAction(inString),
		new RegExp(`differs from the version ${BLOCK_VERSION} block`),
		"markers around other text are never taken for the block",
	);
	assert.throws(() => withoutAskAction(inString), /differs/);
	const edited = askActionBlock().replace("Pi: Agent Question", "My question");
	assert.throws(
		() => withoutAskAction(`${edited}\n`),
		/Remove the block by hand/,
		"a changed block is left for the operator",
	);
});

function ok(stdout: string): CliResult {
	return {
		outcome: "exited",
		exitCode: 0,
		signal: null,
		stdout,
		stderr: "",
		bytes: 0,
		truncated: false,
		started: true,
	};
}
class SetupTransport implements RexTransport {
	calls: string[][] = [];
	loaded = false;
	refuseCandidate = false;
	/** The registry that the loaded block reads, as its `pi_command` description names it. */
	registry: string | undefined;
	/** Runs while Rex checks the candidate, as an edit by somebody else would. */
	duringCheck?: () => Promise<void>;
	readonly path: string;
	readonly revision: number;
	constructor(path: string, revision = 18) {
		this.path = path;
		this.revision = revision;
	}
	async run(args: readonly string[], _call: CliCall): Promise<CliResult> {
		const command = args.slice(args.findIndex((arg) => !arg.startsWith("--") && !arg.startsWith("unix:")));
		this.calls.push(command);
		const [first, second, third] = command;
		if (first === "config" && second === "check" && third === undefined)
			return ok(`path: ${this.path}\nexists: yes\nactions: 1\n`);
		if (first === "config" && second === "check") {
			await this.duringCheck?.();
			return this.refuseCandidate
				? { ...ok(""), exitCode: 1, stderr: "error: init.lua:3: syntax error" }
				: ok(`path: ${third}\n`);
		}
		if (first === "config" && second === "reload") {
			const text = await readFile(this.path, "utf8");
			this.loaded = text.includes('name = "pi_ask"');
			this.registry = /registry = "([^"]+)"/.exec(text)?.[1];
			return ok("generation: 4\n");
		}
		if (first === "whoami") return ok(JSON.stringify({ rex_version: "0.1.0-test", api_revision: this.revision }));
		if (first === "actions")
			return ok(
				JSON.stringify({
					actions: this.loaded
						? ["pi_ask", "pi_command"].map((name) => ({
								name,
								kind: "lua",
								description:
									name === "pi_command"
										? `Runs one Pi command by its ID, for a key binding. Pi records its commands in ${this.registry}.`
										: "",
							}))
						: [],
				}),
			);
		if (first === "api")
			return ok(
				JSON.stringify({
					clients: [
						{ info: { kind: "app", name: "Rex Beta", version: "0.1.0 (2042)", label: "mbp" } },
						{ info: { kind: "cli", name: "rex" } },
					],
				}),
			);
		return { ...ok(""), exitCode: 1, stderr: `unexpected ${command.join(" ")}` };
	}
	dispose() {}
}
async function fixture(initial?: string, options: { confirm?: boolean; revision?: number } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "rex-setup-"));
	const path = join(dir, "init.lua");
	if (initial !== undefined) await writeFile(path, initial, { mode: 0o600 });
	const transport = new SetupTransport(path, options.revision);
	const lines: string[] = [];
	const asked: string[] = [];
	const deps: SetupDeps = {
		transport,
		server: "unix:///rex",
		cwd: dir,
		registryPath: REGISTRY,
		confirm: async (title, message) => {
			asked.push(`${title}\n${message}`);
			return options.confirm ?? true;
		},
		report: (line, level) => lines.push(`${level ?? "info"}: ${line}`),
	};
	return { dir, path, transport, lines, asked, deps, done: () => rm(dir, { recursive: true, force: true }) };
}

test("setup shows the block, checks the new text before it replaces the file, keeps the old file and reloads Rex", async () => {
	const f = await fixture(operatorConfig);
	try {
		await rexCommand("setup", f.deps);
		assert.match(f.asked[0] ?? "", /name = "pi_ask"/, "the confirmation shows the complete block");
		assert.equal(await readFile(f.path, "utf8"), withAskAction(operatorConfig));
		assert.equal(await readFile(`${f.path}.before-pi-setup`, "utf8"), operatorConfig);
		assert.equal((await stat(f.path)).mode & 0o777, 0o600, "the file keeps its mode");
		assert.deepEqual(
			(await readdir(f.dir)).sort(),
			["init.lua", "init.lua.before-pi-setup"],
			"no candidate file remains",
		);
		const checked = f.transport.calls.find((call) => call[1] === "check" && call[2] !== undefined)?.[2] ?? "";
		assert.match(
			checked,
			/\/\.init\.lua\.pi-setup-[0-9a-f-]{36}\.lua$/,
			"the new text waits in a file of this command's own",
		);
		const order = f.transport.calls.map((call) => call.slice(0, 2).join(" "));
		assert.ok(order.indexOf("config check") < order.indexOf("config reload"));
		assert.ok(f.lines.includes("info: The server has loaded every Pi action."), f.lines.join("\n"));
		assert.ok(f.lines.some((line) => line.includes("Rex Beta 0.1.0 (2042) on mbp")));
		f.asked.length = 0;
		const reloads = () => f.transport.calls.filter((call) => call[1] === "reload").length;
		const before = reloads();
		await rexCommand("setup", f.deps);
		assert.equal(f.asked.length, 0, "an unchanged configuration that the server has loaded asks nothing");
		assert.equal(reloads(), before, "and reloads nothing");
		await rexCommand("remove", f.deps);
		assert.equal(await readFile(f.path, "utf8"), operatorConfig);
	} finally {
		await f.done();
	}
});

test("a refused check, a declined confirmation or a broken block leaves the configuration unchanged", async () => {
	const refused = await fixture(operatorConfig);
	try {
		refused.transport.refuseCandidate = true;
		await rexCommand("setup", refused.deps);
		assert.equal(await readFile(refused.path, "utf8"), operatorConfig);
		assert.ok(refused.lines.some((line) => /^error: Rex refused the new configuration/.test(line)));
		assert.deepEqual(await readdir(refused.dir), ["init.lua"]);
		assert.equal(
			refused.transport.calls.some((call) => call[1] === "reload"),
			false,
		);
	} finally {
		await refused.done();
	}
	const declined = await fixture(operatorConfig, { confirm: false });
	try {
		await rexCommand("setup", declined.deps);
		assert.equal(await readFile(declined.path, "utf8"), operatorConfig);
		assert.ok(declined.lines.includes("info: Nothing changed."));
	} finally {
		await declined.done();
	}
	const partial = `-- pi-harness: pi actions v${BLOCK_VERSION} begin\n`;
	const broken = await fixture(partial);
	try {
		await assert.rejects(rexCommand("setup", broken.deps), /partial or repeated/);
		assert.equal(await readFile(broken.path, "utf8"), partial);
	} finally {
		await broken.done();
	}
});

test("setup creates a missing configuration, and status names what an old server still needs", async () => {
	const f = await fixture(undefined, { revision: 13 });
	try {
		await rexCommand("status", f.deps);
		assert.ok(
			f.lines.some((line) => /^warning: .*has no Pi block/.test(line)),
			f.lines.join("\n"),
		);
		assert.ok(
			f.lines.some((line) =>
				/^warning: Rex server 0\.1\.0-test, API revision 13: questions and Pi commands need API revision 17/.test(line),
			),
			f.lines.join("\n"),
		);
		assert.ok(f.lines.some((line) => /^warning: No Pi command is recorded for the palette yet/.test(line)));
		await rexCommand("setup", f.deps);
		assert.equal(await readFile(f.path, "utf8"), `${askActionBlock()}\n`);
		assert.deepEqual(await readdir(f.dir), ["init.lua"], "no backup of a file that did not exist");
		f.lines.length = 0;
		await rexCommand("unknown", f.deps);
		assert.deepEqual(f.lines, ["warning: Usage: /rex setup | status | remove"]);
	} finally {
		await f.done();
	}
});

test("setup keeps a linked configuration linked and never overwrites an edit made while the confirmation was open", async () => {
	const f = await fixture();
	try {
		const dotfiles = join(f.dir, "dotfiles");
		await mkdir(dotfiles);
		const real = join(dotfiles, "init.lua");
		await writeFile(real, operatorConfig, { mode: 0o640 });
		await symlink(real, f.path);
		await rexCommand("setup", f.deps);
		assert.ok((await lstat(f.path)).isSymbolicLink(), "the configured path is still a link");
		assert.equal(await readFile(real, "utf8"), withAskAction(operatorConfig), "the linked file holds the block");
		assert.equal((await stat(real)).mode & 0o777, 0o640);
		assert.equal(await readFile(`${f.path}.before-pi-setup`, "utf8"), operatorConfig);
		assert.deepEqual(
			(await readdir(dotfiles)).sort(),
			["init.lua"],
			"no candidate file remains beside the linked file",
		);
	} finally {
		await f.done();
	}
	const raced = await fixture(operatorConfig);
	try {
		const edited = `${operatorConfig}rex.bind("cmd+y", "pi_quit")\n`;
		raced.transport.duringCheck = () => writeFile(raced.path, edited);
		await rexCommand("setup", raced.deps);
		assert.equal(await readFile(raced.path, "utf8"), edited, "the operator's edit stays");
		assert.ok(
			raced.lines.some((line) => /^error: .*changed while Pi waited for your confirmation/.test(line)),
			raced.lines.join("\n"),
		);
		assert.equal(
			raced.transport.calls.some((call) => call[1] === "reload"),
			false,
		);
		assert.deepEqual(await readdir(raced.dir), ["init.lua"]);
	} finally {
		await raced.done();
	}
	const dangling = await fixture();
	try {
		await symlink(join(dangling.dir, "missing.lua"), dangling.path);
		await assert.rejects(rexCommand("setup", dangling.deps), /links to a missing file/);
		assert.ok((await lstat(dangling.path)).isSymbolicLink(), "a broken link is left for the operator to correct");
	} finally {
		await dangling.done();
	}
});

test("a file that holds the block while the server has not loaded it reloads only after confirmation", async () => {
	const f = await fixture(withAskAction(operatorConfig), { confirm: false });
	try {
		await rexCommand("setup", f.deps);
		assert.match(f.asked[0] ?? "", /has not loaded pi_ask, pi_command/);
		assert.match(f.asked[0] ?? "", /^Reload the Rex configuration\?\n.*including any other change in it/s);
		assert.equal(
			f.transport.calls.some((call) => call[1] === "reload"),
			false,
			"a declined reload runs nothing",
		);
		f.deps.confirm = async () => true;
		await rexCommand("setup", f.deps);
		assert.equal(f.transport.calls.filter((call) => call[1] === "reload").length, 1);
		assert.ok(f.lines.includes("info: The server has loaded every Pi action."));
	} finally {
		await f.done();
	}
});

test("setup refuses files that a replacement would change in other ways", async () => {
	const linked = await fixture(operatorConfig);
	try {
		await import("node:fs/promises").then(({ link }) => link(linked.path, join(linked.dir, "second-name.lua")));
		await assert.rejects(rexCommand("setup", linked.deps), /2 hard links/);
		assert.equal(await readFile(linked.path, "utf8"), operatorConfig);
	} finally {
		await linked.done();
	}
	const directory = await fixture();
	try {
		await mkdir(directory.path);
		await assert.rejects(rexCommand("setup", directory.deps), /not a regular file/);
	} finally {
		await directory.done();
	}
});

test("status names the recorded palette commands and the actions that the server has not loaded", async () => {
	const f = await fixture(withAskAction(operatorConfig));
	try {
		const registry = join(f.dir, "palette.json");
		await writeFile(
			registry,
			JSON.stringify({
				version: 1,
				commands: [
					{
						id: "files.browse",
						title: "Browse Files…",
						argv: [process.execPath, "/x/palette-command.ts"],
						source: "files",
					},
				],
			}),
		);
		f.deps.registryPath = registry;
		await writeFile(f.path, withConfigBlock(operatorConfig, registry));
		f.transport.loaded = true;
		f.transport.registry = registry;
		await rexCommand("status", f.deps);
		assert.ok(f.lines.includes("info: Pi commands for the palette: Browse Files…."), f.lines.join("\n"));
		assert.ok(
			f.lines.includes(
				"warning: The server has not loaded these actions: pi_files_browse. /rex setup reloads the configuration after you confirm.",
			),
			f.lines.join("\n"),
		);
	} finally {
		await f.done();
	}
});

test("an earlier Pi block is refused, and a loaded block of another agent directory counts as not loaded", async () => {
	const earlier = '-- pi-harness: pi_ask v1 begin\nrex.action{ name = "pi_ask" }\n-- pi-harness: pi_ask end\n';
	assert.throws(() => withAskAction(`${operatorConfig}${earlier}`), /earlier Pi block/);
	assert.throws(() => withoutAskAction(`${operatorConfig}${earlier}`), /earlier Pi block/);
	assert.throws(() => withAskAction(`${withAskAction(operatorConfig)}${earlier}`), /earlier Pi block/);
	const f = await fixture(withAskAction(operatorConfig));
	try {
		f.transport.loaded = true;
		f.transport.registry = "/another/agent/rex/palette.json";
		await rexCommand("status", f.deps);
		assert.ok(
			f.lines.includes(
				"warning: The server has not loaded these actions: pi_command. /rex setup reloads the configuration after you confirm.",
			),
			f.lines.join("\n"),
		);
		await rexCommand("setup", f.deps);
		assert.match(f.asked.at(-1) ?? "", /^Reload the Rex configuration\?/);
		assert.equal(f.transport.registry, REGISTRY, "the reload loads the block of this agent directory");
	} finally {
		await f.done();
	}
});
