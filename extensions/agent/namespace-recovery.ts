import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseExistingSources, installSourceRoutes, type ExistingSource } from "./source-route.ts";
import { bindInstallationPackages } from "./installation-binding.ts";

export type NamespaceRecoveryInput = { protocol: 1; root: string; agentDir: string; packageDir: string; cwd: string; existingSources?: ExistingSource[] };
export function parseNamespaceRecovery(value: unknown): NamespaceRecoveryInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid namespace recovery input");
	const input = value as Record<string, unknown>;
	if (input.protocol !== 1 || Object.keys(input).some(key => !["protocol", "root", "agentDir", "packageDir", "cwd", "existingSources"].includes(key))) throw new Error("Unsupported namespace recovery protocol");
	for (const key of ["root", "agentDir", "packageDir", "cwd"]) if (typeof input[key] !== "string" || input[key].length > 4096 || !isAbsolute(input[key]) || /[\u0000-\u001f\u007f]/u.test(input[key])) throw new Error(`Invalid namespace ${key}`);
	if (input.existingSources !== undefined) input.existingSources = parseExistingSources(input.existingSources);
	return input as NamespaceRecoveryInput;
}

/** The source selected by the supervisor owns recovery; no ordinary primary is registered. */
export async function runNamespaceRecovery(metadata: string): Promise<void> {
	const input = parseNamespaceRecovery(JSON.parse(metadata));
	bindInstallationPackages(input.packageDir, new URL("./", import.meta.url));
	const [{ childControl }, { AgentManager }] = await Promise.all([import("@earendil-works/chord/node"), import("./manager.ts")]);
	const control = childControl();
	await control.lock();
	if (input.existingSources !== undefined) await installSourceRoutes(input.root, input.existingSources);
	const controller = new AbortController();
	const manager = new AgentManager(input);
	let done!: () => void;
	const ended = new Promise<void>(resolve => { done = resolve; });
	const stop = () => { controller.abort(); manager.close(); control.report({ durableTasks: 0 }); done(); };
	control.onShutdown(stop);
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	process.once("disconnect", stop);
	control.ready();
	control.report({ durableTasks: 1 });
	void manager.recoverNamespace(controller.signal).then(report => { process.stdout.write(`${JSON.stringify({ protocol: 1, type: "namespace-recovery", ...report })}\n`); }).catch(() => { process.stderr.write("Namespace recovery did not complete; runtime recovery remains available.\n"); });
	try { await ended; }
	finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("disconnect", stop); if (process.connected) process.disconnect?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void runNamespaceRecovery(process.argv[2] ?? "").then(() => process.exit(0)).catch(() => { process.stderr.write("Namespace recovery could not start.\n"); process.exit(1); });
}
