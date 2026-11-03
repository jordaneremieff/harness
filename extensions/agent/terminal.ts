import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const peers = new Set([
	"@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
]);

/** Pi's agent directory: `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`, as Pi's own configuration resolves it. */
function agentDirectory(env: NodeJS.ProcessEnv): string {
	const home = env.HOME || homedir();
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(home, ".pi", "agent");
	return configured === "~" || configured.startsWith("~/") ? join(home, configured.slice(1)) : configured;
}

/**
 * The managed launcher is under <agent-home>/bin; its sibling install owns releases.
 * Resolution order: `PI_MANAGED_INSTALL_ROOT`, the launcher on `PATH`, then the
 * install under Pi's agent directory. The last step serves terminals started
 * without an interactive shell, such as multiplexer panes and launchers, whose
 * `PATH` lacks the launcher.
 */
export function managedRelease(env: NodeJS.ProcessEnv = process.env): { root: string; anchor: string } {
	let root = env.PI_MANAGED_INSTALL_ROOT;
	if (!root) {
		for (const directory of (env.PATH ?? "").split(delimiter)) {
			const launcher = join(directory, "pi");
			try {
				accessSync(launcher, constants.X_OK);
				const candidate = join(dirname(dirname(realpathSync(launcher))), "install");
				accessSync(join(candidate, "current-version"), constants.R_OK);
				root = candidate;
				break;
			} catch { /* Continue through PATH to the managed launcher. */ }
		}
	}
	if (!root) {
		const candidate = join(agentDirectory(env), "install");
		try { accessSync(join(candidate, "current-version"), constants.R_OK); root = candidate; } catch { /* No managed install under the agent directory. */ }
	}
	if (!root) throw new Error("Managed Pi install not found. Set PI_MANAGED_INSTALL_ROOT to its install directory, put the managed pi launcher on PATH, or keep the install under Pi's agent directory.");
	root = realpathSync(resolve(root));
	const version = readFileSync(join(root, "current-version"), "utf8").trim();
	if (!/^[a-zA-Z0-9_+.-]+$/.test(version) || version === "." || version === "..")
		throw new Error("Managed Pi current-version is invalid");
	const release = join(root, "releases", version);
	accessSync(join(release, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), constants.R_OK);
	return { root, anchor: pathToFileURL(join(release, "entry.mjs")).href };
}

export function installPeerResolver(anchor: string): { deregister(): void } {
	return registerHooks({ resolve(specifier, context, nextResolve) {
		if ([...peers].some((peer) => specifier === peer || specifier.startsWith(`${peer}/`)))
			return nextResolve(specifier, { ...context, parentURL: anchor });
		return nextResolve(specifier, context);
	} });
}

export async function terminalMain(args = process.argv.slice(2)): Promise<void> {
	if (args.includes("--help")) {
		console.log("Usage: node extensions/agent/terminal.ts [--session <identity|@handle>] [--theme dark|light]\nWithout --session, resume the last target or open the dashboard.\nText input only; other slash and shell text are literal messages.\nPI_MANAGED_INSTALL_ROOT selects the managed Pi install; otherwise the managed pi launcher on PATH, then the install under Pi's agent directory (PI_CODING_AGENT_DIR or ~/.pi/agent).");
		return;
	}
	const release = managedRelease();
	const hook = installPeerResolver(release.anchor);
	try {
		// Install the resolver before any local module imports Pi peers.
		const { runTerminal } = await import("./terminal-client.ts");
		await runTerminal(args);
	} finally { hook.deregister(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await terminalMain().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
