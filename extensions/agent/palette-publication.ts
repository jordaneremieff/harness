import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PaletteCommand = { id: string; title: string; description?: string; argv: string[] };
type PalettePublication = { version: 1; source: string; commands: PaletteCommand[] };
type PaletteRequestEvent = { version: 1 };

const commandFile = fileURLToPath(new URL("./palette-commands.ts", import.meta.url));
export const agentPaletteCommands = [
	{ id: "agent.open", title: "Open an Agent…", description: "Open a Durable conversation in the agent work view." },
	{ id: "agent.message", title: "Message an Agent…", description: "Send operator input to a Durable conversation." },
] as const;
export const paletteEnvironmentKeys = ["PI_AGENT_DIR", "PI_AGENT_SESSIONS_DIR", "PI_CODING_AGENT_DIR", "PI_MANAGED_INSTALL_ROOT", "PI_HARNESS_FILE", "TMPDIR"] as const;
export type PalettePaths = Record<typeof paletteEnvironmentKeys[number], string>;

/** Capture paths without opening the store or resolving the managed release on disk. */
export function publishAgentPalette(events: ExtensionAPI["events"], codingAgentDir: string): () => void {
	const agentDir = resolve(process.env.PI_AGENT_DIR ?? codingAgentDir);
	const paths: PalettePaths = {
		PI_AGENT_DIR: agentDir,
		PI_AGENT_SESSIONS_DIR: resolve(process.env.PI_AGENT_SESSIONS_DIR ?? join(agentDir, "agent-sessions")),
		PI_CODING_AGENT_DIR: resolve(codingAgentDir),
		PI_MANAGED_INSTALL_ROOT: resolve(process.env.PI_MANAGED_INSTALL_ROOT || join(codingAgentDir, "install")),
		PI_HARNESS_FILE: resolve(agentDir, process.env.PI_HARNESS_FILE ?? "harness.json"),
		TMPDIR: resolve(tmpdir()),
	};
	const publish = () => {
		const publication: PalettePublication = { version: 1, source: "agent", commands: agentPaletteCommands.map((command) => ({
			...command, argv: [process.execPath, commandFile, ...paletteEnvironmentKeys.map((key) => paths[key])],
		})) };
		events.emit("harness:palette:publish", publication);
	};
	const off = events.on("harness:palette:request", (event) => {
		if ((event as Partial<PaletteRequestEvent> | null)?.version === 1) publish();
	});
	publish();
	return off;
}
