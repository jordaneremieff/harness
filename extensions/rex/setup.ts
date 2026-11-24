import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showCommandReport, type ReportLine } from "./command-report.ts";
import { configBlock, findConfigBlock, withConfigBlock, withoutConfigBlock } from "./config-block.ts";
import { readPaletteRegistry } from "./palette.ts";
import { CliTransport, type RexTransport } from "./transport.ts";

/** The first control API revision whose apps receive prompts, which the steps of palette commands use. */
const PROMPT_API_REVISION = 17;

export interface SetupDeps {
	transport: RexTransport;
	/** The server that the launch environment selects; absent means Rex's home server. */
	server?: string;
	cwd: string;
	/** The palette registry that the block's runtime reads. */
	registryPath: string;
	confirm(title: string, message: string): Promise<boolean>;
	report(line: string, level?: "info" | "warning" | "error"): void;
}

async function rex(deps: SetupDeps, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const result = await deps.transport.run(
		["--autostart=false", "--color=never", "--timeout=10s", ...(deps.server ? ["--server", deps.server] : []), ...args],
		{ cwd: deps.cwd, timeoutMs: 15000, maxOutputBytes: 1048576 },
	);
	return {
		ok: result.outcome === "exited" && result.exitCode === 0,
		stdout: result.stdout,
		stderr: (result.stderr || result.outcome).trim(),
	};
}
async function rexJson(deps: SetupDeps, args: string[]): Promise<Record<string, unknown> | undefined> {
	const result = await rex(deps, args);
	if (!result.ok) return undefined;
	try {
		const value = JSON.parse(result.stdout) as unknown;
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
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
interface Config {
	text: string;
	file: string;
	mode?: number;
}
async function readConfig(path: string): Promise<Config> {
	try {
		const file = await realpath(path);
		const info = await stat(file);
		// A replacement is a new file: it would turn a special file into a plain one and separate hard links.
		if (!info.isFile()) throw new Error(`The Rex configuration ${file} is not a regular file. Add the block by hand.`);
		if (info.nlink > 1)
			throw new Error(
				`The Rex configuration ${file} has ${info.nlink} hard links, which a replacement would separate. Add the block by hand.`,
			);
		return { text: await readFile(file, "utf8"), file, mode: info.mode & 0o777 };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const link = await lstat(path).catch(() => undefined);
		if (link?.isSymbolicLink())
			throw new Error(
				`The Rex configuration ${path} links to a missing file. Correct the link, then run /rex setup again.`,
			);
		return { text: "", file: path };
	}
}

interface ServerFacts {
	version?: string;
	revision?: number;
	actions?: Map<string, string>;
	apps?: string[];
}
async function serverFacts(deps: SetupDeps): Promise<ServerFacts | undefined> {
	const identity = await rexJson(deps, ["whoami", "--json"]);
	if (!identity) return undefined;
	const actions = await rexJson(deps, ["actions", "--json"]);
	const clients = await rexJson(deps, ["api", "call", "client.list", "{}"]);
	const listed = Array.isArray(actions?.actions) ? (actions.actions as Array<Record<string, unknown>>) : undefined;
	const apps = (Array.isArray(clients?.clients) ? (clients.clients as Array<Record<string, unknown>>) : undefined)
		?.map((client) => (client?.info ?? {}) as Record<string, unknown>)
		.filter((info) => info.kind === "app")
		.map((info) =>
			[info.name, info.version, info.label ? `on ${info.label}` : undefined]
				.filter((part) => typeof part === "string" && part)
				.join(" "),
		);
	return {
		version: typeof identity.rex_version === "string" ? identity.rex_version : undefined,
		revision: Number.isInteger(identity.api_revision) ? (identity.api_revision as number) : undefined,
		actions:
			listed &&
			new Map(
				listed
					.filter((action) => action?.kind === "lua" && typeof action.name === "string")
					.map((action) => [action.name as string, typeof action.description === "string" ? action.description : ""]),
			),
		apps,
	};
}

/** The Rex action of each recorded palette command, as the block's runtime names it. */
function commandActions(deps: SetupDeps): Array<{ action: string; title: string }> {
	return (readPaletteRegistry(deps.registryPath)?.commands ?? []).map((command) => ({
		action: `pi_${command.id.replaceAll(".", "_")}`,
		title: command.title,
	}));
}

/**
 * Actions of the block that the server has not loaded: `pi_command` and each recorded command. `pi_command` names the
 * registry that its block reads, so a loaded block of another agent directory counts as not loaded.
 */
function missingActions(deps: SetupDeps, actions: Map<string, string>): string[] {
	const stale = !actions.get("pi_command")?.endsWith(`Pi records its commands in ${deps.registryPath}.`);
	return ["pi_command", ...commandActions(deps).map((command) => command.action)].filter(
		(action) => !actions.has(action) || (action === "pi_command" && stale),
	);
}

type ServerLine = [string, "info" | "warning"];

/** The commands behind missing actions, in words: every command when the block's runtime itself is missing. */
function missingNames(deps: SetupDeps, missing: string[]): string {
	if (missing.includes("pi_command")) return "Pi's palette commands";
	const titles = commandActions(deps)
		.filter((command) => missing.includes(command.action))
		.map((command) => `"${command.title}"`);
	return titles.length > 1 ? `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}` : (titles[0] ?? "");
}

/** Each problem that keeps the palette from offering Pi's commands, with the act that fixes it. */
function paletteProblems(
	deps: SetupDeps,
	facts: ServerFacts,
	configured: boolean,
	missing: string[] | undefined,
): string[] {
	const ready = facts.revision !== undefined && facts.revision >= PROMPT_API_REVISION;
	const problems: string[] = [];
	if (!configured) problems.push("Run /rex setup to add Pi's commands to the Rex palette.");
	if (facts.revision === undefined)
		problems.push("Rex did not report its version, so Pi cannot tell whether Rex runs Pi commands.");
	else if (!ready)
		problems.push(
			`Rex${facts.version ? ` ${facts.version}` : ""} is too old for Pi commands. Update Rex, then restart it.`,
		);
	if (!commandActions(deps).length)
		problems.push(
			"No Pi extension has offered a palette command yet. Start an interactive Pi session, then run /rex status again.",
		);
	if (!missing) problems.push("Rex did not list its loaded actions, so Pi cannot confirm its commands.");
	else if (configured && ready && missing.length)
		problems.push(`Rex has not loaded ${missingNames(deps, missing)}. Run /rex setup to reload the Rex configuration.`);
	if (!facts.apps) problems.push("Rex did not list its connected apps.");
	else if (!facts.apps.length) problems.push("No Rex app is connected. Open Rex to use the palette.");
	return problems;
}

/**
 * What the Rex palette offers now, then each problem with the act that fixes it. A check that passes adds no line:
 * versions, paths and connected apps appear only when they explain a problem.
 */
function paletteSummary(deps: SetupDeps, facts: ServerFacts | undefined, configured: boolean): ServerLine[] {
	if (!facts) return [["Pi cannot reach the Rex server. Start Rex, then run /rex status again.", "warning"]];
	const commands = commandActions(deps);
	const missing = facts.actions && missingActions(deps, facts.actions);
	const ready = facts.revision !== undefined && facts.revision >= PROMPT_API_REVISION;
	const problems = paletteProblems(deps, facts, configured, missing);
	const offered =
		configured && ready && missing && !missing.includes("pi_command")
			? commands.filter((command) => !missing.includes(command.action))
			: [];
	const headline: ServerLine[] = offered.length
		? [
				[`The Rex palette offers ${offered.length === 1 ? "this Pi command" : "these Pi commands"}:`, "info"],
				...offered.map((command): ServerLine => [`  ${command.title}`, "info"]),
			]
		: [
				[
					facts.revision === undefined || !missing
						? "Pi cannot tell whether the Rex palette offers its commands."
						: "The Rex palette offers no Pi commands.",
					"warning",
				],
			];
	return [...headline, ...problems.map((problem): ServerLine => [problem, "warning"])];
}

/** The same configuration as before the confirmation: an edit made meanwhile must not be overwritten. */
function unchangedNow(path: string, before: Config): boolean {
	try {
		return (
			realpathSync(path) === before.file &&
			readFileSync(before.file, "utf8") === before.text &&
			before.mode !== undefined
		);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" && before.mode === undefined;
	}
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
			deps.report(
				`Rex refused the new configuration, so ${path} is unchanged: ${checked.stderr || checked.stdout.trim()}`,
				"error",
			);
			return false;
		}
		const changed = () => {
			deps.report(
				`${path} changed while Pi waited for your confirmation, so Pi left it as it is. Run the command again.`,
				"error",
			);
			return false;
		};
		if (!unchangedNow(path, before)) return changed();
		if (before.mode !== undefined) await copyFile(before.file, `${path}.before-pi-setup`);
		// The last check and the rename run back to back, so an edit can only land in the time of two system calls.
		if (!unchangedNow(path, before)) return changed();
		renameSync(candidate, before.file);
		if (before.mode !== undefined) deps.report(`The previous configuration is in ${path}.before-pi-setup.`);
	} finally {
		await rm(candidate, { force: true });
	}
	const reloaded = await rex(deps, ["config", "reload"]);
	if (!reloaded.ok)
		deps.report(
			`The configuration changed and passed "rex config check", but the server did not reload it: ${reloaded.stderr || reloaded.stdout.trim()}. Run "rex config reload" when the server runs${before.mode === undefined ? "" : `, or restore ${path}.before-pi-setup`}.`,
			"warning",
		);
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
	let configured = true;
	if (verb === "status") configured = findConfigBlock(current.text, deps.registryPath) !== undefined;
	else if (!(await change(verb, deps, path, current)) || verb === "remove") return;
	for (const [line, level] of paletteSummary(deps, await serverFacts(deps), configured)) deps.report(line, level);
}

const CHANGES = {
	setup: {
		title: "Add Pi's actions to Rex?",
		message: (path: string, registryPath: string) =>
			`The Rex command palette then offers the commands of your Pi extensions under "Pi:". Pi writes this block to ${path}, keeps the previous file beside it, and reloads the Rex configuration:\n\n${configBlock(registryPath)}`,
		done: (path: string) => `Added Pi's commands to ${path}.`,
		unchanged: undefined,
	},
	remove: {
		title: "Remove Pi's actions from Rex?",
		message: (path: string) =>
			`Pi removes its block from ${path}, keeps the previous file beside it, and reloads the Rex configuration. The palette then no longer offers Pi commands.`,
		done: (path: string) => `Removed Pi's commands from ${path}. The Rex palette no longer offers them.`,
		unchanged: (_path: string) => "The Rex palette has no Pi commands to remove.",
	},
};

/**
 * The file can hold the block while the server has not read it, for example after a reload that failed. A reload
 * reads the whole file, including other edits, so it is a separate step that the operator confirms.
 */
async function reloadWhenMissing(deps: SetupDeps, path: string): Promise<void> {
	const facts = await serverFacts(deps);
	if (facts?.revision === undefined || facts.revision < PROMPT_API_REVISION) return;
	const missing = facts.actions && missingActions(deps, facts.actions);
	if (!missing?.length) return;
	const reload = await deps.confirm(
		"Reload the Rex configuration?",
		`${path} holds Pi's commands, but the Rex server has not loaded ${missingNames(deps, missing)}. Pi runs "rex config reload", which makes the server read the whole file again, including any other change in it.`,
	);
	if (!reload) return;
	const reloaded = await rex(deps, ["config", "reload"]);
	if (!reloaded.ok)
		deps.report(
			`The server did not reload the configuration: ${reloaded.stderr || reloaded.stdout.trim()}.`,
			"warning",
		);
}

/** Add or remove the block after the operator confirms it. Returns false when the command ends here. */
async function change(verb: "setup" | "remove", deps: SetupDeps, path: string, current: Config): Promise<boolean> {
	const words = CHANGES[verb];
	const next =
		verb === "setup"
			? withConfigBlock(current.text, deps.registryPath)
			: withoutConfigBlock(current.text, deps.registryPath);
	if (next === current.text) {
		if (words.unchanged) deps.report(words.unchanged(path));
		if (verb === "setup") await reloadWhenMissing(deps, path);
		return true;
	}
	if (!(await deps.confirm(words.title, words.message(path, deps.registryPath)))) {
		deps.report("The Rex configuration did not change.");
		return false;
	}
	if (!(await install(deps, path, current, next))) return false;
	deps.report(words.done(path));
	return true;
}

export function registerRexCommand(
	pi: Pick<ExtensionAPI, "registerCommand">,
	options: { executable: string; registryPath: string; transport?: RexTransport },
): void {
	pi.registerCommand("rex", {
		description: "Set up, check or remove Pi's actions in Rex (palette commands): /rex setup | status | remove",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const transport = options.transport ?? new CliTransport(options.executable, process.env);
			const lines: ReportLine[] = [];
			try {
				await rexCommand(args, {
					transport,
					server: process.env.REX_SERVER,
					cwd: ctx.cwd,
					registryPath: options.registryPath,
					confirm: (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
					report: (text, level = "info") => lines.push({ text, level }),
				});
			} catch (error) {
				lines.push({ text: error instanceof Error ? error.message : String(error), level: "error" });
			} finally {
				if (!options.transport) transport.dispose();
			}
			const title =
				args.trim() === "setup"
					? "Rex palette setup"
					: args.trim() === "remove"
						? "Rex palette removal"
						: "Rex palette status";
			await showCommandReport(ctx, title, lines);
		},
	});
}
