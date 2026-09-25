import { accessSync, constants, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getPackageDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface RestartHosts {
	/** A stable snapshot of this extension's process-local owners, not sibling work. */
	identity: string;
	refusal?: string;
}

export interface RestartProcess {
	argv: string[];
	execArgv: string[];
	execPath: string;
	env: NodeJS.ProcessEnv;
	execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never;
	once(event: "exit", listener: (code: number) => void): unknown;
	removeListener(event: "exit", listener: (code: number) => void): unknown;
	exitCode?: string | number | null;
}

interface RestartGuard { pending: boolean }
const guardKey = Symbol.for("pi.extension.agent.restart");
const shared = globalThis as typeof globalThis & { [guardKey]?: RestartGuard };

export interface RestartLaunch {
	executable: string;
	args: string[];
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/** Only fixed categories reach the terminal; thrown messages can contain secrets. */
function safeCause(error: unknown): string {
	if (error instanceof TypeError) return "invalid restart arguments";
	if (error instanceof Error && "code" in error && typeof error.code === "string" && /^E[A-Z0-9_]{1,40}$/u.test(error.code)) return error.code;
	return "restart operation unavailable";
}

/** Pi owns graceful cleanup. This listener runs only at its final successful exit. */
export function armRestart(launch: RestartLaunch, host: RestartProcess = process, write: (fd: number, text: string) => unknown = writeSync): () => void {
	const listener = (code: number): void => {
		if (code !== 0) return;
		try {
			write(1, `Restarting Pi. If it does not return, run: ${launch.args.map(shellQuote).join(" ")}\n`);
			if (!host.execve) throw new Error("execve unavailable");
			host.execve(launch.executable, launch.args, host.env);
		} catch (error) {
			host.exitCode = 1;
			try { write(2, `Restart failed after shutdown: ${safeCause(error)}. Use the recovery command above.\n`); } catch { /* The terminal is already unavailable. */ }
		}
	};
	host.once("exit", listener);
	return () => { host.removeListener("exit", listener); };
}

interface RestartOptions {
	hosts: () => RestartHosts;
	managedChild: (ctx: ExtensionContext) => boolean;
	process?: RestartProcess;
	packageDir?: () => string;
	guard?: RestartGuard;
	write?: (fd: number, text: string) => unknown;
}

class RestartRefusal extends Error {}
const cliRefusal = "Restart refused. This command requires an interactive Pi CLI process.";

function cliPath(host: RestartProcess, packageDir: () => string): string {
	let cli: string;
	try {
		const root = packageDir();
		const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (metadata.name !== "@earendil-works/pi-coding-agent" || typeof metadata.bin?.pi !== "string" || !host.argv[1]) throw new Error("not Pi CLI");
		cli = realpathSync(resolve(root, metadata.bin.pi));
		if (realpathSync(host.argv[1]) !== cli) throw new Error("not Pi CLI");
	} catch { throw new RestartRefusal(cliRefusal); }
	if (typeof host.execve !== "function") throw new RestartRefusal("Restart refused. This runtime does not support process.execve.");
	try { accessSync(host.execPath, constants.X_OK); }
	catch { throw new RestartRefusal("Restart refused. The Node executable is unavailable or not executable."); }
	try { accessSync(cli, constants.R_OK); }
	catch { throw new RestartRefusal("Restart refused. The Pi CLI file is not readable."); }
	return cli;
}

function savedFile(ctx: ExtensionContext) {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile || !isAbsolute(sessionFile)) throw new RestartRefusal("Restart refused. Pi has not saved this session to an absolute file yet.");
	let file: ReturnType<typeof statSync>;
	try { file = statSync(sessionFile); }
	catch { throw new RestartRefusal("Restart refused. Pi has not saved this session to a file yet."); }
	if (!file.isFile() || file.size === 0) throw new RestartRefusal("Restart refused. Pi has not saved this session to a non-empty file yet.");
	return { sessionFile, file };
}

function notifyFailure(ctx: ExtensionContext, error: unknown): void {
	ctx.ui.notify(error instanceof RestartRefusal ? error.message : `Restart failed before shutdown: ${safeCause(error)}. This session remains open.`, "warning");
}

export function createRestartCommand(options: RestartOptions) {
	const host = options.process ?? process;
	shared[guardKey] ??= { pending: false };
	const guard = options.guard ?? shared[guardKey];
	const preflight = (ctx: ExtensionContext): { identity: string; launch: RestartLaunch } => {
		if (!ctx.hasUI || ctx.mode !== "tui" || options.managedChild(ctx)) throw new RestartRefusal(cliRefusal);
		const cli = cliPath(host, options.packageDir ?? getPackageDir);
		const { sessionFile, file } = savedFile(ctx);
		const native = ctx.sessionManager;
		// Pi omits primary Bash and retained TUI compaction messages from these accessors; confirmation covers their loss.
		if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new RestartRefusal("Restart refused. This session has active or queued work. Stop or finish that work, then use /restart.");
		const hosts = options.hosts();
		if (hosts.refusal) throw new RestartRefusal(hosts.refusal);
		const sessionDir = native.getSessionDir();
		const launch = { executable: host.execPath, args: [host.execPath, ...host.execArgv, cli, "--session-dir", sessionDir, "--session", sessionFile] };
		if (launch.args.some((arg) => /[\x00-\x1f\x7f-\x9f]/u.test(arg))) throw new RestartRefusal("Restart refused. A launch argument contains terminal control characters.");
		return { launch, identity: JSON.stringify([native.getSessionId(), sessionFile, sessionDir, native.getLeafId(), ctx.cwd, file.dev, file.ino, file.size, file.mtimeMs, hosts.identity, launch]) };
	};
	return {
		description: "Restart this Pi process and resume the saved session",
		handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
			if (args.trim()) { ctx.ui.notify("Usage: /restart", "warning"); return; }
			if (guard.pending) { ctx.ui.notify("Restart refused. A restart is already pending.", "warning"); return; }
			let before: ReturnType<typeof preflight>;
			try { before = preflight(ctx); } catch (error) { notifyFailure(ctx, error); return; }
			let disarm: (() => void) | undefined;
			let committed = false;
			guard.pending = true;
			try {
				if (!await ctx.ui.confirm("Restart this Pi session?", "Subagent workers and other extensions' work in this process stop. A running ! command also stops. Pi's private compaction queue and other unsaved state are lost. Continue?")) return;
				const after = preflight(ctx);
				if (before.identity !== after.identity) throw new RestartRefusal("Restart refused. The session or agent hosts changed during confirmation. Use /restart again.");
				disarm = armRestart(after.launch, host, options.write);
				ctx.shutdown();
				committed = true;
			} catch (error) {
				disarm?.();
				notifyFailure(ctx, error);
			} finally {
				if (!committed) guard.pending = false;
			}
		},
	};
}
