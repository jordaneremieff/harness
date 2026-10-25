import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseExistingSources, installSourceRoutes, type ExistingSource } from "./source-route.ts";
import type { HostConnection } from "./host-client.ts";
import { bindInstallationPackages } from "./installation-binding.ts";

export interface ConversationCreation {
	protocol: 1;
	root: string;
	agentDir: string;
	packageDir: string;
	cwd: string;
	requestId: string;
	name?: string;
	model?: string;
	thinkingLevel?: string;
	preset?: string;
	existingSources?: ExistingSource[];
}
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
function assertCreationPaths(input: Record<string, unknown>): void {
	for (const key of ["root", "agentDir", "packageDir", "cwd"]) if (!text(input[key], 4096) || !isAbsolute(input[key])) throw new Error(`Invalid creation ${key}`);
}
function assertCreationLabels(input: Record<string, unknown>): void {
	for (const key of ["name", "model", "thinkingLevel", "preset"]) if (input[key] !== undefined && !text(input[key], key === "name" ? 256 : 512)) throw new Error(`Invalid creation ${key}`);
}
function creationArguments(input: ConversationCreation) {
	return { name: input.name, requestId: input.requestId,
		...(input.model === undefined ? {} : { model: input.model }),
		...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
		...(input.preset === undefined ? {} : { preset: input.preset }) };
}
export function parseConversationCreation(value: unknown): ConversationCreation {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid conversation creation");
	const input = value as Record<string, unknown>;
	if (input.protocol !== 1 || Object.keys(input).some(key => !["protocol", "root", "agentDir", "packageDir", "cwd", "requestId", "name", "model", "thinkingLevel", "preset", "existingSources"].includes(key))) throw new Error("Unsupported conversation creation protocol");
	assertCreationPaths(input);
	if (!text(input.requestId, 1024)) throw new Error("Invalid creation request ID");
	assertCreationLabels(input);
	if (input.existingSources !== undefined) input.existingSources = parseExistingSources(input.existingSources);
	return input as unknown as ConversationCreation;
}

/** Create an empty native root through the same manager, defaults and exclusive host admission as other clients. */
export async function createConversation(metadataText: string, options: { acquire?: typeof import("./host-client.ts").acquireHost; models?: Pick<import("@earendil-works/pi-coding-agent").ModelRuntime, "getModel" | "getModels"> } = {}): Promise<Record<string, unknown>> {
	let client: HostConnection | undefined;
	let identity: string | undefined;
	let name: string | undefined;
	let root: string | undefined, packageDir: string | undefined;
	const sourceRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
	try {
		const input = parseConversationCreation(JSON.parse(metadataText));
		name = input.name; root = input.root; packageDir = input.packageDir;
		bindInstallationPackages(input.packageDir, new URL("./", import.meta.url));
		if (input.existingSources !== undefined) await installSourceRoutes(input.root, input.existingSources);
		const [{ AgentManager }, { acquireHost }, { ModelRuntime }, { clampThinkingLevel }, { isThinkingLevel }] = await Promise.all([
			import("./manager.ts"), import("./host-client.ts"), import("@earendil-works/pi-coding-agent"), import("@earendil-works/pi-ai"), import("./configuration.ts"),
		]);
		const models = options.models ?? await ModelRuntime.create({ authPath: join(input.agentDir, "auth.json"), modelsPath: join(input.agentDir, "models.json"), allowModelNetwork: false });
		const manager = new AgentManager({ root: input.root, agentDir: input.agentDir, packageDir: input.packageDir,
			acquire: async (metadata, connectionOptions) => { client = await (options.acquire ?? acquireHost)(metadata, connectionOptions); return client; },
			validateModel: (model, level) => {
				const selected = models.getModel(model.provider, model.modelId);
				if (!selected || !isThinkingLevel(level)) throw new Error("The configured creation model or thinking level is unavailable");
				return clampThinkingLevel(selected, level);
			} });
		const requester = `operator:${createHash("sha256").update(input.root).digest("hex")}`;
		const result = await manager.spawn(creationArguments(input), {
			id: requester, cwd: input.cwd,
			preferenceCatalog: { getModel: (provider, id) => models.getModel(provider, id), getModels: () => [...models.getModels()] },
		}, row => { identity = row.id; }) as { sessionId?: string };
		identity = result.sessionId ?? identity;
		if (!identity) throw new Error("The native creation identity is unavailable");
		return { protocol: 1, state: "completed", identity, name: name ?? null, root, sourceRoot, packageDir };
	} catch {
		return { protocol: 1, state: identity === undefined ? "rejected" : "uncertain", identity: identity ?? null, name: name ?? null, root: root ?? null, sourceRoot, packageDir: packageDir ?? null };
	} finally { await client?.close().catch(() => {}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void createConversation(process.argv[2] ?? "").then(value => new Promise<void>((done, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : done()))).catch(() => { process.exitCode = 1; });
}
