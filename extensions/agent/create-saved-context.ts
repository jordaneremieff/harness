import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HostConnection } from "./host-client.ts";
import { bindInstallationPackages } from "./installation-binding.ts";
import { readInitialContext } from "./initial-context.ts";

function creationMetadata(text: string) {
	const input = JSON.parse(text);
	if (input.protocol !== 1) throw new Error("Unsupported saved context creation protocol");
	for (const key of ["root", "agentDir", "cwd", "packageDir"]) {
		if (typeof input[key] !== "string" || !isAbsolute(input[key])) throw new Error(`Invalid creation ${key}`);
	}
	if (typeof input.sourceId !== "string" || !input.sourceId || typeof input.requestId !== "string" || !input.requestId || (input.name !== undefined && typeof input.name !== "string")) throw new Error("Invalid saved context identity");
	return input;
}
/** Internal UI creation process. Only projected messages arrive on stdin. */
async function createSavedContext(metadataText: string): Promise<void> {
	let client: HostConnection | undefined;
	let identity: string | undefined;
	let name: string | undefined;
	try {
		const input = creationMetadata(metadataText);
		name = input.name;
		bindInstallationPackages(input.packageDir, new URL("./", import.meta.url));
		const [{ AgentManager }, { acquireHost }, { ModelRuntime, VERSION }, { clampThinkingLevel }, { isThinkingLevel }] = await Promise.all([
			import("./manager.ts"), import("./host-client.ts"), import("@earendil-works/pi-coding-agent"), import("@earendil-works/pi-ai"), import("./configuration.ts"),
		]);
		const [major, minor] = VERSION.split(".").map(Number);
		if (!(major > 1 || (major === 1 && minor >= 3))) throw new Error("Saved context creation requires Pi 1.3 or later");
		const messages = await readInitialContext();
		const models = await ModelRuntime.create({ authPath: join(input.agentDir, "auth.json"), modelsPath: join(input.agentDir, "models.json"), allowModelNetwork: false });
		const manager = new AgentManager({ root: input.root, agentDir: input.agentDir, packageDir: input.packageDir,
			acquire: async (metadata, options) => { client = await acquireHost(metadata, { ...options, initialMessages: messages }); return client; },
			validateModel: (model, level) => {
				const selected = models.getModel(model.provider, model.modelId);
				if (!selected) throw new Error("The configured creation model is unavailable");
				if (!isThinkingLevel(level)) throw new Error("Unknown creation thinking level");
				return clampThinkingLevel(selected, level);
			} });
		await manager.spawn({ name, requestId: input.requestId, trust: false }, {
			id: input.sourceId, cwd: input.cwd,
			preferenceCatalog: { getModel: (provider, id) => models.getModel(provider, id), getModels: () => [...models.getModels()] },
		}, row => { identity = row.id; });
		if (!identity) throw new Error("The native creation identity is unavailable");
		await output({ state: "completed", identity, name: name ?? null, messages: messages.length });
	} catch {
		await output({ state: identity === undefined ? "rejected" : "uncertain", identity: identity ?? null, name: name ?? null });
	} finally { await client?.close().catch(() => {}); }
}
function output(value: Record<string, unknown>): Promise<void> { return new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify({ protocol: 1, ...value })}\n`, error => error ? reject(error) : resolve())); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void createSavedContext(process.argv[2] ?? "").catch(() => { process.stderr.write("Saved context creation ended without a receipt\n"); process.exitCode = 1; });
}
