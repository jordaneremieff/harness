import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const peers = new Set([
	"@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core", "typebox",
]);

/** The managed launcher is under <agent-home>/bin; its sibling install owns releases. */
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
	if (!root) throw new Error("Managed Pi launcher not found. Set PI_MANAGED_INSTALL_ROOT to its install directory.");
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
		console.log("Usage: node extensions/agent/terminal.ts [--session <identity|@handle>] [--theme dark|light]\nWithout --session, resume the last target or open the dashboard.\nText input only; other slash and shell text are literal messages.\nPI_MANAGED_INSTALL_ROOT selects the managed Pi install; otherwise use its launcher on PATH.");
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
