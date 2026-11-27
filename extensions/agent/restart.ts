import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getPackageDir, parseArgs, type ExtensionContext } from "@earendil-works/pi-coding-agent";

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

interface RestartGuard {
	pending: boolean;
}
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
	if (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		/^E[A-Z0-9_]{1,40}$/u.test(error.code)
	)
		return error.code;
	return "restart operation unavailable";
}

function resumeFlags(argv: string[]): string[] {
	const args: string[] = [];
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === "--") {
			args.push(...argv.slice(i));
			break;
		}
		// Pi consumes its profile selector before parseArgs and carries it in the environment.
		if (argv[i] === "--agent-dir") i++;
		else args.push(argv[i]);
	}
	return parseArgs(args).resumeFlags;
}

const tokenVariable = "OSC7577_TOKEN";
const procArgsProgram = String.raw`
ObjC.import('Foundation');
ObjC.bindFunction('sysctl', ['int', ['void *', 'unsigned int', 'void *', 'void *', 'void *', 'unsigned long']]);
function run(argv) {
  const mib = $.NSData.alloc.initWithBase64EncodedStringOptions(argv[0], 0);
  const size = $.NSMutableData.alloc.initWithBase64EncodedStringOptions(argv[1], 0);
  const buffer = $.NSMutableData.dataWithLength(Number(argv[2]));
  if ($.sysctl(mib.bytes, 3, buffer.mutableBytes, size.mutableBytes, null, 0) !== 0) return '';
  const text = $.NSString.alloc.initWithDataEncoding(buffer, $.NSISOLatin1StringEncoding).js;
  const prefix = '\0' + argv[3] + '=';
  const start = text.lastIndexOf(prefix);
  if (start < 0) return '';
  const valueStart = start + prefix.length;
  const end = text.indexOf('\0', valueStart);
  if (end < 0) return '';
  const value = text.slice(valueStart, end);
  return /^[A-Za-z0-9_-]{22,64}(?![\s\S])/.test(value) ? value : '';
}
`;

export function readInitialResumeToken(pid: number, name: string, run = execFileSync): string | undefined {
	try {
		// KERN_PROCARGS2 retains the initial environment even if Pi replaces its process title.
		const mib = Buffer.alloc(12);
		mib.writeInt32LE(1, 0); // CTL_KERN
		mib.writeInt32LE(49, 4); // KERN_PROCARGS2
		mib.writeInt32LE(pid, 8);
		const capacity = 1024 * 1024;
		const size = Buffer.alloc(8);
		size.writeBigUInt64LE(BigInt(capacity));
		const out = run(
			"/usr/bin/osascript",
			[
				"-l",
				"JavaScript",
				"-e",
				procArgsProgram,
				mib.toString("base64"),
				size.toString("base64"),
				String(capacity),
				name,
			],
			{
				encoding: "utf8",
				env: {},
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 2000,
				killSignal: "SIGKILL",
				maxBuffer: 1024,
			},
		);
		const value = out.replace(/\n$/u, "");
		return /^[A-Za-z0-9_-]{22,64}(?![\s\S])/u.test(value) ? value : undefined;
	} catch {
		// Child process errors may retain stdout. Never expose them.
		return undefined;
	}
}

/** Pi owns graceful cleanup. This listener runs only at its final successful exit. */
export function armRestart(
	launch: RestartLaunch,
	host: RestartProcess = process,
	write: (fd: number, text: string) => unknown = writeSync,
	token?: string,
): () => void {
	const listener = (code: number): void => {
		if (code !== 0) return;
		try {
			write(1, `Restarting Pi. If it does not return, run: ${launch.args.map(shellQuote).join(" ")}\n`);
			if (!host.execve) throw new Error("execve unavailable");
			const env = token ? { ...host.env, [tokenVariable]: token } : host.env;
			host.execve(launch.executable, launch.args, env);
		} catch (error) {
			host.exitCode = 1;
			try {
				write(2, `Restart failed after shutdown: ${safeCause(error)}. Use the recovery command above.\n`);
			} catch {
				/* The terminal is already unavailable. */
			}
		}
	};
	host.once("exit", listener);
	return () => {
		host.removeListener("exit", listener);
	};
}

interface RestartOptions {
	hosts: () => RestartHosts;
	managedChild: (ctx: ExtensionContext) => boolean;
	process?: RestartProcess;
	packageDir?: () => string;
	guard?: RestartGuard;
	write?: (fd: number, text: string) => unknown;
	readToken?: () => string | undefined;
}

class RestartRefusal extends Error {}
const cliRefusal = "Pi restart requires an interactive Pi CLI process.";

function cliPath(host: RestartProcess, packageDir: () => string): string {
	let cli: string;
	try {
		const root = packageDir();
		const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (metadata.name !== "@earendil-works/pi-coding-agent" || typeof metadata.bin?.pi !== "string" || !host.argv[1])
			throw new Error("not Pi CLI");
		cli = realpathSync(resolve(root, metadata.bin.pi));
		if (realpathSync(host.argv[1]) !== cli) throw new Error("not Pi CLI");
	} catch {
		throw new RestartRefusal(cliRefusal);
	}
	if (typeof host.execve !== "function") throw new RestartRefusal("Pi restart requires a runtime with process.execve.");
	try {
		accessSync(host.execPath, constants.X_OK);
	} catch {
		throw new RestartRefusal("Pi restart requires an executable Node binary.");
	}
	try {
		accessSync(cli, constants.R_OK);
	} catch {
		throw new RestartRefusal("Pi restart requires a readable Pi CLI file.");
	}
	return cli;
}

function savedFile(ctx: ExtensionContext) {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile || !isAbsolute(sessionFile))
		throw new RestartRefusal("Pi restart requires a saved session file with an absolute path.");
	let file: ReturnType<typeof statSync>;
	try {
		file = statSync(sessionFile);
	} catch {
		throw new RestartRefusal("Pi restart requires a saved session file.");
	}
	if (!file.isFile() || file.size === 0) throw new RestartRefusal("Pi restart requires a non-empty session file.");
	return { sessionFile, file };
}

function notifyFailure(ctx: ExtensionContext, error: unknown): void {
	ctx.ui.notify(
		error instanceof RestartRefusal
			? error.message
			: `Pi remains open because restart did not reach shutdown: ${safeCause(error)}.`,
		error instanceof RestartRefusal ? "warning" : "error",
	);
}

export function createRestartCommand(options: RestartOptions) {
	const host = options.process ?? process;
	shared[guardKey] ??= { pending: false };
	const guard = options.guard ?? shared[guardKey];
	const readToken = options.readToken ?? (() => readInitialResumeToken(process.pid, tokenVariable));
	const preflight = (ctx: ExtensionContext): { identity: string; launch: RestartLaunch } => {
		if (!ctx.hasUI || ctx.mode !== "tui" || options.managedChild(ctx)) throw new RestartRefusal(cliRefusal);
		const cli = cliPath(host, options.packageDir ?? getPackageDir);
		const { sessionFile, file } = savedFile(ctx);
		const native = ctx.sessionManager;
		// Pi omits primary Bash and retained TUI compaction messages from these accessors; confirmation covers their loss.
		if (!ctx.isIdle() || ctx.hasPendingMessages())
			throw new RestartRefusal("Pi restart requires an idle session without queued work.");
		const hosts = options.hosts();
		if (hosts.refusal) throw new RestartRefusal(`Pi restart is unavailable: ${hosts.refusal}`);
		const sessionDir = native.getSessionDir();
		const launch = {
			executable: host.execPath,
			args: [
				host.execPath,
				...host.execArgv,
				cli,
				"--session-dir",
				sessionDir,
				"--session",
				sessionFile,
				...resumeFlags(host.argv),
			],
		};
		if (launch.args.some((arg) => /[\x00-\x1f\x7f-\x9f]/u.test(arg)))
			throw new RestartRefusal("Pi restart requires launch arguments without terminal control characters.");
		return {
			launch,
			identity: JSON.stringify([
				native.getSessionId(),
				sessionFile,
				sessionDir,
				ctx.cwd,
				file.dev,
				file.ino,
				hosts.identity,
				launch,
			]),
		};
	};
	return {
		description: "Restart this Pi process and resume the saved session",
		handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
			if (args.trim()) {
				ctx.ui.notify("Use /restart without arguments to restart Pi.", "warning");
				return;
			}
			if (guard.pending) {
				ctx.ui.notify("Pi already has a restart pending.", "warning");
				return;
			}
			let before: ReturnType<typeof preflight>;
			try {
				before = preflight(ctx);
			} catch (error) {
				notifyFailure(ctx, error);
				return;
			}
			let disarm: (() => void) | undefined;
			let committed = false;
			guard.pending = true;
			try {
				if (
					!(await ctx.ui.confirm(
						"Restart this Pi session?",
						"Other extensions' work in this process stops. A running ! command also stops. Pi's private compaction queue and other unsaved state are lost. Continue?",
					))
				)
					return;
				const after = preflight(ctx);
				if (before.identity !== after.identity)
					throw new RestartRefusal("Pi restart requires fresh confirmation after the session or agent hosts change.");
				disarm = armRestart(after.launch, host, options.write, readToken());
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
