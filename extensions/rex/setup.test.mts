import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ASK_ACTION_DESCRIPTION } from "./ask.ts";
import { BLOCK_VERSION, configBlock, findConfigBlock, withConfigBlock, withoutConfigBlock } from "./config-block.ts";
import { registerRexCommand, rexCommand, type SetupDeps } from "./setup.ts";

const REGISTRY = "/agent/rex/palette.json";
const piBlock = () => configBlock(REGISTRY);
const findBlock = (source: string) => findConfigBlock(source, REGISTRY);
const withBlock = (source: string) => withConfigBlock(source, REGISTRY);
const withoutBlock = (source: string) => withoutConfigBlock(source, REGISTRY);
import type { CliCall, CliResult, RexTransport } from "./transport.ts";

const operatorConfig = '-- my bindings\nrex.bind("cmd+x", "pi_quit")\n';

test("setup adds and removes only its own exact block, leaving every other byte as it was", () => {
	assert.equal(findBlock(operatorConfig), undefined);
	const added = withBlock(operatorConfig);
	assert.equal(added, `${operatorConfig}${piBlock()}\n`);
	assert.match(added, new RegExp(`-- pi-harness: pi actions v${BLOCK_VERSION} begin`));
	assert.deepEqual(
		[...added.matchAll(/^ {2}name = "([^"]+)"/gm)].map((match) => match[1]),
		["pi_ask", "pi_command"],
	);
	assert.ok(findBlock(added));
	const earlier = `-- pi-harness: pi actions v${BLOCK_VERSION - 1} begin\n-- an earlier runtime\n-- pi-harness: pi actions end\n`;
	assert.ok(findBlock(`${operatorConfig}${earlier}`)?.earlier);
	assert.equal(
		withBlock(`${operatorConfig}${earlier}x = 2\n`),
		`${operatorConfig}${piBlock()}\nx = 2\n`,
		"setup replaces Pi's earlier block where it stands",
	);
	assert.equal(withoutBlock(`${operatorConfig}${earlier}`), operatorConfig, "remove deletes an earlier block");
	const later = added.replace(`pi actions v${BLOCK_VERSION} begin`, `pi actions v${BLOCK_VERSION + 1} begin`);
	assert.throws(() => withBlock(later), /A later Pi wrote/);
	assert.throws(() => withoutBlock(later), /A later Pi wrote/);
	assert.equal(withBlock(added), added, "a configuration that holds the block stays as it is");
	assert.equal(withoutBlock(added), operatorConfig, "removal restores the text before setup");
	const spaced = "x = 1\n\n\n";
	assert.equal(withoutBlock(withBlock(spaced)), spaced, "blank lines of the operator stay");
	assert.equal(withBlock(""), `${piBlock()}\n`);
	assert.equal(
		withBlock("x = 1"),
		`x = 1\n${piBlock()}\n`,
		"a last line without a line break gets one before the block",
	);
	const crlf = `a = 1\r\n${piBlock().replaceAll("\n", "\r\n")}\r\nb = 2\r\n`;
	assert.equal(withoutBlock(crlf), "a = 1\r\nb = 2\r\n", "a block saved with CRLF line ends is removed whole");
	assert.equal(withoutBlock(`${piBlock()}`), "", "a block at the end without a final line break is removed whole");
	for (const broken of [
		`-- pi-harness: pi actions v${BLOCK_VERSION} begin\nno end\n`,
		"no begin\n-- pi-harness: pi actions end\n",
		`-- pi-harness: pi actions end\n-- pi-harness: pi actions v${BLOCK_VERSION} begin\n`,
		`${piBlock()}\n${piBlock()}\n`,
	])
		assert.throws(() => withBlock(broken), /partial or repeated/, broken);
	const inString = `local note = [[\n-- pi-harness: pi actions v${BLOCK_VERSION} begin\nkeep this text\n-- pi-harness: pi actions end\n]]\n`;
	assert.throws(
		() => withBlock(inString),
		new RegExp(`differs from the version ${BLOCK_VERSION} block`),
		"markers around other text are never taken for the block",
	);
	assert.throws(() => withoutBlock(inString), /differs/);
	const edited = piBlock().replace("Pi: Run Command", "My command");
	assert.throws(
		() => withoutBlock(`${edited}\n`),
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
	/** Actions of recorded palette commands that the server lists besides `pi_command`. */
	commandActions: string[] = [];
	refuseCandidate = false;
	/** The registry that the loaded block reads, as its `pi_command` description names it. */
	registry: string | undefined;
	/** The description of the loaded question action, or undefined when the server has none. */
	askDescription: string | undefined;
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
			this.loaded = text.includes('name = "pi_command"');
			this.registry = /registry = "([^"]+)"/.exec(text)?.[1];
			this.askDescription = /name = "pi_ask",\n.*\n {2}description = "([^"]+)"/.exec(text)?.[1];
			return ok("generation: 4\n");
		}
		if (first === "whoami") return ok(JSON.stringify({ rex_version: "0.1.0-test", api_revision: this.revision }));
		if (first === "actions") return ok(JSON.stringify({ actions: this.loaded ? this.loadedActions() : [] }));
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
	/** The actions of the loaded block, as `rex actions --json` lists them. */
	loadedActions() {
		return [
			...(this.askDescription === undefined ? [] : [{ name: "pi_ask", kind: "lua", description: this.askDescription }]),
			{
				name: "pi_command",
				kind: "lua",
				description: `Runs one Pi command by its ID, for a key binding. Pi records its commands in ${this.registry}.`,
			},
			...this.commandActions.map((name) => ({ name, kind: "lua", description: "" })),
		];
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
		assert.match(f.asked[0] ?? "", /name = "pi_command"/, "the confirmation shows the complete block");
		assert.equal(await readFile(f.path, "utf8"), withBlock(operatorConfig));
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
		assert.deepEqual(
			f.lines,
			["warning: Pi has no commands for Rex yet. Start an interactive Pi session, then run /rex status again."],
			"setup reports one notice, and a check that passes adds nothing",
		);
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
		assert.ok(declined.lines.includes("info: The Rex configuration did not change."));
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
		assert.deepEqual(f.lines, ["warning: Rex 0.1.0-test is too old for Pi's commands. Update Rex, then restart it."]);
		await rexCommand("setup", f.deps);
		assert.equal(await readFile(f.path, "utf8"), `${piBlock()}\n`);
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
		assert.equal(await readFile(real, "utf8"), withBlock(operatorConfig), "the linked file holds the block");
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
	const f = await fixture(withBlock(operatorConfig), { confirm: false });
	try {
		await rexCommand("setup", f.deps);
		assert.match(f.asked[0] ?? "", /has not loaded Pi's commands\./);
		assert.match(f.asked[0] ?? "", /^Reload the Rex configuration\?\n.*including any other change in it/s);
		assert.equal(
			f.transport.calls.some((call) => call[1] === "reload"),
			false,
			"a declined reload runs nothing",
		);
		f.deps.confirm = async () => true;
		f.lines.length = 0;
		await rexCommand("setup", f.deps);
		assert.equal(f.transport.calls.filter((call) => call[1] === "reload").length, 1);
		assert.ok(
			f.lines.every((line) => !/has not loaded/.test(line)),
			f.lines.join("\n"),
		);
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

test("status leads with the commands that the palette offers and names a command that the server has not loaded", async () => {
	const f = await fixture(withBlock(operatorConfig));
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
		f.transport.askDescription = ASK_ACTION_DESCRIPTION;
		await rexCommand("status", f.deps);
		assert.deepEqual(f.lines, [
			'warning: The Rex palette does not list "Browse Files…" yet. Run /rex setup to reload the Rex configuration.',
		]);
		f.lines.length = 0;
		f.transport.commandActions = ["pi_files_browse"];
		await rexCommand("status", f.deps);
		assert.deepEqual(f.lines, ["info: Rex offers these Pi commands: Browse Files."]);
		f.lines.length = 0;
		let chosen = 0;
		f.deps.choose = () => {
			chosen++;
		};
		await rexCommand("status", f.deps);
		assert.equal(chosen, 1, "status shows the commands in Rex's own picker");
		assert.deepEqual(f.lines, [], "and adds no notice when every command works");
	} finally {
		await f.done();
	}
});

test("status and setup name /rex setup when the server has not loaded the current question action", async () => {
	const f = await fixture(withBlock(operatorConfig));
	try {
		f.transport.loaded = true;
		f.transport.registry = REGISTRY;
		for (const description of [undefined, "Shows a question from a Pi agent. Pi runs this action."]) {
			f.transport.askDescription = description;
			f.lines.length = 0;
			await rexCommand("status", f.deps);
			assert.deepEqual(f.lines, [
				"warning: Rex has not loaded the current agent questions, so agents cannot ask you through Rex. Run /rex setup to reload the Rex configuration.",
			]);
		}
		await rexCommand("setup", f.deps);
		assert.match(f.asked.at(-1) ?? "", /^Reload the Rex configuration\?\n.*has not loaded agent questions\./);
		assert.equal(f.transport.askDescription, ASK_ACTION_DESCRIPTION, "the reload loads the current question action");
	} finally {
		await f.done();
	}
});

test("the question action shows the choices, then the note field, within one wait", () => {
	const lua = piBlock();
	assert.match(lua, /description = "Shows a question from a Pi agent, then a field for an optional note\./);
	assert.match(lua, /args = \{ title = "string\?", items = "array\?", wait = "integer\?" \}/);
	assert.match(lua, /rex\.ui\.pick\{ title = args\.title, items = args\.items, timeout = wait \}/);
	assert.match(
		lua,
		/title = "Add a note", placeholder = "Optional", confirm = "Send", timeout = math\.min\(3600, left\)/,
	);
	assert.match(lua, /if note ~= nil then return \{ choice = choice, note = note \} end/);
});

test("an earlier format of Pi block is refused, and a loaded block of another agent directory counts as not loaded", async () => {
	const earlier = '-- pi-harness: pi_ask v1 begin\nrex.action{ name = "pi_ask" }\n-- pi-harness: pi_ask end\n';
	assert.throws(() => withBlock(`${operatorConfig}${earlier}`), /earlier Pi block/);
	assert.throws(() => withoutBlock(`${operatorConfig}${earlier}`), /earlier Pi block/);
	assert.throws(() => withBlock(`${withBlock(operatorConfig)}${earlier}`), /earlier Pi block/);
	const f = await fixture(withBlock(operatorConfig));
	try {
		f.transport.loaded = true;
		f.transport.registry = "/another/agent/rex/palette.json";
		await rexCommand("status", f.deps);
		assert.ok(
			f.lines.includes("warning: Rex has not loaded Pi's commands. Run /rex setup to reload the Rex configuration."),
			f.lines.join("\n"),
		);
		await rexCommand("setup", f.deps);
		assert.match(f.asked.at(-1) ?? "", /^Reload the Rex configuration\?/);
		assert.equal(f.transport.registry, REGISTRY, "the reload loads the block of this agent directory");
	} finally {
		await f.done();
	}
});

test("the managed native dialog separates command errors from notices without putting process answers in its diagnostic", () => {
	const lua = piBlock();
	assert.match(
		lua,
		/rex\.ui\.pick\{ title = title, items = \{ \{ id = "ok", title = "OK", subtitle = pi_harness\.one_line\(text\)/,
	);
	assert.match(lua, /pi_harness\.feedback\("Pi command failed", text\)/);
	assert.match(lua, /pi_harness\.feedback\("Pi command notice", text\)/);
	assert.match(lua, /if reply\.error ~= nil then return pi_harness\.problem\(reply\.error\) end/);
	assert.match(lua, /if type\(reply\.done\.notice\) == "string" then pi_harness\.say\(reply\.done\.notice\) end/);
	assert.match(lua, /#answers == 0 and (?:\(tostring\(result\.stderr|": " \.\. tostring\(err\))/);
});

test("the registered Rex command reports one notice and opens no view", async () => {
	const f = await fixture(operatorConfig);
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const notices: Array<[string, string]> = [];
	let views = 0;
	try {
		registerRexCommand(
			{
				registerCommand: (_name, command) => {
					handler = command.handler;
				},
			} as Pick<ExtensionAPI, "registerCommand">,
			{ executable: "unused", registryPath: REGISTRY, transport: f.transport },
		);
		assert.ok(handler);
		const ui = {
			notify: (text: string, level: string) => notices.push([text, level]),
			async custom() {
				views++;
			},
			confirm: async () => false,
		};
		for (const mode of ["tui", "print"])
			await handler("status", { cwd: f.dir, hasUI: mode === "tui", mode, ui } as unknown as ExtensionCommandContext);
		assert.deepEqual(notices, [
			["Rex has no Pi commands yet. Run /rex setup to add them.", "warning"],
			["Rex has no Pi commands yet. Run /rex setup to add them.", "warning"],
		]);
		assert.equal(views, 0);
		await handler("wrong-verb", { cwd: f.dir, hasUI: true, mode: "tui", ui } as unknown as ExtensionCommandContext);
		assert.deepEqual(notices.at(-1), ["Usage: /rex setup | status | remove", "warning"]);
	} finally {
		await f.done();
	}
});

test("an absent action or client read is not a negative observation", async () => {
	const f = await fixture(withBlock(operatorConfig));
	try {
		const run = f.transport.run.bind(f.transport);
		f.transport.run = async (args, call) => {
			if (args.includes("whoami")) return ok('{"rex_version":"0.1.0-test"}');
			if (args.includes("actions") || args.includes("api")) return { ...ok(""), exitCode: 1 };
			return run(args, call);
		};
		await rexCommand("status", f.deps);
		const report = f.lines.join("\n");
		assert.equal(
			report,
			"warning: Rex did not report its version, so Pi cannot tell whether Rex runs Pi's commands.",
			"an absent revision is not reported as an old server",
		);
	} finally {
		await f.done();
	}
});
