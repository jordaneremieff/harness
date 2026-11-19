import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ASK_ACTION, ASK_API_REVISION } from "./ask.ts";
import { CliTransport, type RexTransport } from "./transport.ts";

/** The version of the configuration block below. Setup recognises only the exact block of this version. */
export const ASK_BLOCK_VERSION = 1;
const BEGIN = /^-- pi-harness: pi_ask v(\d+) begin\r?$/gm;
const END = /^-- pi-harness: pi_ask end\r?$/gm;

/**
 * The Rex configuration block that lets Pi agents ask the operator questions. Rex lets only an action of the server
 * configuration show a prompt, so `rex_ask` runs this action. It forwards the question to `rex.ui` unchanged and
 * returns the answer or Rex's reason for none.
 */
export function askActionBlock(): string {
	return `-- pi-harness: pi_ask v${ASK_BLOCK_VERSION} begin
-- Lets Pi agents ask you a question in the command palette of every connected
-- Rex app. Pi's rex_ask tool runs this action; run by hand, it does nothing.
-- Pi's /rex setup wrote this block and /rex remove deletes it.
rex.action{
  name = "${ASK_ACTION}",
  title = "Pi: Agent Question",
  description = "Shows a question from a Pi agent. Pi runs this action; running it by hand does nothing.",
  category = "Pi",
  args = { kind = "string?", prompt = "object?" },
  run = function(ctx, args)
    if args.prompt == nil then return nil end
    if rex.ui == nil then
      return { why = "unsupported", detail = "This Rex server has no rex.ui.", version = ${ASK_BLOCK_VERSION} }
    end
    local ask = rex.ui.input
    if args.kind == "pick" then ask = rex.ui.pick end
    local answer, why, detail = ask(args.prompt)
    return { answer = answer, why = why, detail = detail, version = ${ASK_BLOCK_VERSION} }
  end,
}
-- pi-harness: pi_ask end`;
}

interface Block { start: number; end: number }

/**
 * The block that setup wrote, if the configuration holds one. Only the exact text of the current block counts, so
 * marker lines around other text, such as inside a Lua string, are never taken for it. A partial, repeated or changed
 * block is refused and stays for the operator to correct.
 */
export function findAskBlock(source: string): Block | undefined {
	const begins = [...source.matchAll(BEGIN)];
	const ends = [...source.matchAll(END)];
	if (begins.length === 0 && ends.length === 0) return undefined;
	const begin = begins[0];
	const end = ends[0];
	if (begins.length !== 1 || ends.length !== 1 || !begin || !end || end.index < begin.index)
		throw new Error("The Rex configuration has a partial or repeated pi_ask block. Correct it by hand, then run /rex setup again.");
	const stop = end.index + end[0].length;
	const region = { start: begin.index, end: source[stop] === "\n" ? stop + 1 : stop };
	const text = source.slice(region.start, region.end).replaceAll("\r\n", "\n");
	if (text !== `${askActionBlock()}\n` && text !== askActionBlock())
		throw new Error(`The pi_ask block in the Rex configuration differs from the version ${ASK_BLOCK_VERSION} block that Pi writes. Remove the block by hand, then run /rex setup again.`);
	return region;
}

/**
 * The configuration with the block added at the end, after a line break when the last line has none. A configuration
 * that already holds the block stays as it is.
 */
export function withAskAction(source: string): string {
	if (findAskBlock(source)) return source;
	return `${source}${source.length > 0 && !source.endsWith("\n") ? "\n" : ""}${askActionBlock()}\n`;
}

/** The configuration without the block. Every other byte stays as it is. */
export function withoutAskAction(source: string): string {
	const found = findAskBlock(source);
	return found ? source.slice(0, found.start) + source.slice(found.end) : source;
}

export interface SetupDeps {
	transport: RexTransport;
	/** The server that the launch environment selects; absent means Rex's home server. */
	server?: string;
	cwd: string;
	confirm(title: string, message: string): Promise<boolean>;
	report(line: string, level?: "info" | "warning" | "error"): void;
}

async function rex(deps: SetupDeps, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const result = await deps.transport.run(["--autostart=false", "--color=never", "--timeout=10s", ...(deps.server ? ["--server", deps.server] : []), ...args], { cwd: deps.cwd, timeoutMs: 15000, maxOutputBytes: 1048576 });
	return { ok: result.outcome === "exited" && result.exitCode === 0, stdout: result.stdout, stderr: (result.stderr || result.outcome).trim() };
}
async function rexJson(deps: SetupDeps, args: string[]): Promise<Record<string, unknown> | undefined> {
	const result = await rex(deps, args);
	if (!result.ok) return undefined;
	try {
		const value = JSON.parse(result.stdout) as unknown;
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch { return undefined; }
}

/** The configuration file Rex reads: `rex config check` names it from REX_CONFIG or the configuration directory. */
async function configPath(deps: SetupDeps): Promise<string> {
	const checked = await rex(deps, ["config", "check"]);
	const path = /^path: (.+)$/m.exec(checked.stdout)?.[1]?.trim();
	if (!path) throw new Error(`Rex did not name its configuration file: ${checked.stderr || "no path"}.`);
	return path;
}

/**
 * The configuration as it is now. `file` is the file that holds it: a configuration that links to a file elsewhere,
 * such as a dotfiles checkout, is changed in that file, so the link stays.
 */
interface Config { text: string; file: string; mode?: number }
async function readConfig(path: string): Promise<Config> {
	try {
		const file = await realpath(path);
		const info = await stat(file);
		// A replacement is a new file: it would turn a special file into a plain one and separate hard links.
		if (!info.isFile()) throw new Error(`The Rex configuration ${file} is not a regular file. Add the block by hand.`);
		if (info.nlink > 1) throw new Error(`The Rex configuration ${file} has ${info.nlink} hard links, which a replacement would separate. Add the block by hand.`);
		return { text: await readFile(file, "utf8"), file, mode: info.mode & 0o777 };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const link = await lstat(path).catch(() => undefined);
		if (link?.isSymbolicLink()) throw new Error(`The Rex configuration ${path} links to a missing file. Correct the link, then run /rex setup again.`);
		return { text: "", file: path };
	}
}

interface ServerFacts { version: string; revision: number; loaded: boolean; apps: string[] }
async function serverFacts(deps: SetupDeps): Promise<ServerFacts | undefined> {
	const identity = await rexJson(deps, ["whoami", "--json"]);
	if (!identity) return undefined;
	const actions = await rexJson(deps, ["actions", "--json"]);
	const clients = await rexJson(deps, ["api", "call", "client.list", "{}"]);
	const listed = Array.isArray(actions?.actions) ? actions.actions as Array<Record<string, unknown>> : [];
	const apps = (Array.isArray(clients?.clients) ? clients.clients as Array<Record<string, unknown>> : [])
		.map((client) => (client.info ?? {}) as Record<string, unknown>)
		.filter((info) => info.kind === "app")
		.map((info) => [info.name, info.version, info.label ? `on ${info.label}` : undefined].filter((part) => typeof part === "string" && part).join(" "));
	return {
		version: typeof identity.rex_version === "string" ? identity.rex_version : "unknown version",
		revision: typeof identity.api_revision === "number" ? identity.api_revision : 0,
		loaded: listed.some((action) => action.name === ASK_ACTION && action.kind === "lua"),
		apps,
	};
}

function serverLines(facts: ServerFacts | undefined): Array<[string, "info" | "warning"]> {
	if (!facts) return [["The Rex server did not answer. Start Rex, then run /rex status again.", "warning"]];
	const ready = facts.revision >= ASK_API_REVISION;
	return [
		[`Rex server ${facts.version}, API revision ${facts.revision}: ${ready ? "it can ask questions" : `questions need API revision ${ASK_API_REVISION} or later; update Rex and restart its server`}.`, ready ? "info" : "warning"],
		[facts.loaded ? `The server has loaded the ${ASK_ACTION} action.` : `The server has not loaded the ${ASK_ACTION} action.`, facts.loaded ? "info" : "warning"],
		[facts.apps.length ? `Connected Rex apps: ${facts.apps.join("; ")}. Each app must be as new as the server to show questions.` : "No Rex app is connected.", facts.apps.length ? "info" : "warning"],
	];
}

/** The same configuration: an edit made while the operator read the confirmation must not be overwritten. */
function unchanged(before: Config, now: Config): boolean {
	return now.text === before.text && now.file === before.file && (now.mode === undefined) === (before.mode === undefined);
}

/**
 * Replace the configuration in one step after Rex accepts the new text, keep the previous file, and reload the server.
 * The new text waits in a file of this command's own, created exclusively beside the configuration so that the rename
 * stays on one file system and no other command can write into it.
 */
async function install(deps: SetupDeps, path: string, before: Config, after: string): Promise<boolean> {
	const candidate = join(dirname(before.file), `.${basename(before.file)}.pi-setup-${randomUUID()}.lua`);
	await mkdir(dirname(before.file), { recursive: true });
	await writeFile(candidate, after, { encoding: "utf8", mode: before.mode ?? 0o644, flag: "wx" });
	try {
		if (before.mode !== undefined) await chmod(candidate, before.mode);
		const checked = await rex(deps, ["config", "check", candidate]);
		if (!checked.ok) {
			deps.report(`Rex refused the new configuration, so ${path} is unchanged: ${checked.stderr || checked.stdout.trim()}`, "error");
			return false;
		}
		if (!unchanged(before, await readConfig(path))) {
			deps.report(`${path} changed while Pi waited for your confirmation, so Pi left it as it is. Run the command again.`, "error");
			return false;
		}
		if (before.mode !== undefined) {
			await copyFile(before.file, `${path}.before-pi-setup`);
			deps.report(`The previous configuration is in ${path}.before-pi-setup.`);
		}
		await rename(candidate, before.file);
	} finally {
		await rm(candidate, { force: true });
	}
	const reloaded = await rex(deps, ["config", "reload"]);
	if (!reloaded.ok) deps.report(`The configuration changed and passed "rex config check", but the server did not reload it: ${reloaded.stderr || reloaded.stdout.trim()}. Run "rex config reload" when the server runs${before.mode === undefined ? "" : `, or restore ${path}.before-pi-setup`}.`, "warning");
	return true;
}

export async function rexCommand(args: string, deps: SetupDeps): Promise<void> {
	const verb = args.trim() || "status";
	if (verb !== "setup" && verb !== "status" && verb !== "remove") {
		deps.report("Usage: /rex setup | status | remove", "warning");
		return;
	}
	const path = await configPath(deps);
	const current = await readConfig(path);
	if (verb === "status") {
		const found = findAskBlock(current.text);
		deps.report(found ? `${path} holds the version ${ASK_BLOCK_VERSION} ${ASK_ACTION} block.` : `${path} has no ${ASK_ACTION} block. /rex setup adds it.`, found ? "info" : "warning");
	} else if (!(await change(verb, deps, path, current))) return;
	for (const [line, level] of serverLines(await serverFacts(deps))) deps.report(line, level);
}

const CHANGES = {
	setup: {
		title: "Add the Rex action for agent questions?",
		message: (path: string) => `Agents then ask you questions in the command palette of every connected Rex app. Pi writes this block to ${path}, keeps the previous file beside it, and reloads the Rex configuration:\n\n${askActionBlock()}`,
		done: (path: string) => `Added the ${ASK_ACTION} action to ${path}.`,
		unchanged: (path: string) => `${path} already holds the current ${ASK_ACTION} block.`,
	},
	remove: {
		title: "Remove the Rex action for agent questions?",
		message: (path: string) => `Pi removes the ${ASK_ACTION} block from ${path}, keeps the previous file beside it, and reloads the Rex configuration. Agents then ask in their own sessions only.`,
		done: (path: string) => `Removed the ${ASK_ACTION} action from ${path}.`,
		unchanged: (path: string) => `${path} has no ${ASK_ACTION} block.`,
	},
};

/**
 * The file can hold the block while the server has not read it, for example after a reload that failed. A reload
 * reads the whole file, including other edits, so it is a separate step that the operator confirms.
 */
async function reloadWhenMissing(deps: SetupDeps, path: string): Promise<void> {
	const facts = await serverFacts(deps);
	if (!facts || facts.loaded || facts.revision < ASK_API_REVISION) return;
	const reload = await deps.confirm("Reload the Rex configuration?", `${path} holds the ${ASK_ACTION} action, but the Rex server has not loaded it. Pi runs "rex config reload", which makes the server read the whole file again, including any other change in it.`);
	if (!reload) return;
	const reloaded = await rex(deps, ["config", "reload"]);
	if (!reloaded.ok) deps.report(`The server did not reload the configuration: ${reloaded.stderr || reloaded.stdout.trim()}.`, "warning");
}

/** Add or remove the block after the operator confirms it. Returns false when the command ends here. */
async function change(verb: "setup" | "remove", deps: SetupDeps, path: string, current: Config): Promise<boolean> {
	const words = CHANGES[verb];
	const next = verb === "setup" ? withAskAction(current.text) : withoutAskAction(current.text);
	if (next === current.text) {
		deps.report(words.unchanged(path));
		if (verb === "setup") await reloadWhenMissing(deps, path);
		return true;
	}
	if (!(await deps.confirm(words.title, words.message(path)))) {
		deps.report("Nothing changed.");
		return false;
	}
	if (!(await install(deps, path, current, next))) return false;
	deps.report(words.done(path));
	return true;
}

export function registerRexCommand(pi: Pick<ExtensionAPI, "registerCommand">, options: { executable: string; transport?: RexTransport }): void {
	pi.registerCommand("rex", {
		description: "Set up, check or remove the Rex action that lets agents ask you questions in Rex: /rex setup | status | remove",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const transport = options.transport ?? new CliTransport(options.executable, process.env);
			try {
				await rexCommand(args, {
					transport,
					server: process.env.REX_SERVER,
					cwd: ctx.cwd,
					confirm: (title, message) => ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false),
					report: (line, level) => ctx.ui.notify(line, level ?? "info"),
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally { if (!options.transport) transport.dispose(); }
		},
	});
}
