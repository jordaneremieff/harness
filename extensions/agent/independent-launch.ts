/** Independent contributed work, with creator provenance but no answer route. */
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { JsonValue } from "@earendil-works/chord";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { acquireHost } from "./host-client.ts";
import { hostRequestVersionError, type HostMetadata } from "./host-protocol.ts";
import { resolveConfiguredAgent } from "./durable-services.ts";
import { connectPrimaryChannel } from "./primary-channel.ts";
import type { ProjectTrustDecision } from "./trust-support.ts";

export interface IndependentCommandInput {
	readonly invocationId: string;
	readonly creatorId: string;
	readonly cwd: string;
	readonly name?: string;
	readonly command: { readonly name: string; readonly args?: string; readonly data?: JsonValue };
}
export interface IndependentCommandReceipt {
	readonly sessionId: string;
	readonly cwd: string;
	readonly admission: { readonly name: string; readonly conversationId: number; readonly identity: string; readonly text: string };
}
export type IndependentCommandLaunch = (input: IndependentCommandInput) => Promise<IndependentCommandReceipt>;
export interface IndependentLaunchOptions {
	readonly root: string;
	readonly agentDir: string;
	readonly packageDir: string;
	readonly askPrimary?: (cwd: string) => Promise<ProjectTrustDecision | undefined>;
	readonly acquire?: typeof acquireHost;
	readonly resolveDefaults?: typeof resolveConfiguredAgent;
}

function identity(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error(`${field} must be a bounded identity`);
}

/** Resolve an unresolved trust ask through the creator's existing primary route. */
export async function askCreatorTrust(root: string, creatorId: string, cwd: string): Promise<ProjectTrustDecision | undefined> {
	const catalog = new AgentCatalog(root);
	let owner: string | undefined = creatorId;
	for (let depth = 0; owner !== undefined && depth < 32; depth++) {
		const target: string = owner;
		try { owner = catalog.read(target).ownerId; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const channel = await connectPrimaryChannel({ id: target, sessionsRoot: root });
			try { return await channel.trustPrompt(cwd); } finally { await channel.close(); }
		}
	}
	return undefined;
}

/** Validate and capture the exact wire input before asynchronous setup. */
function snapshotCommand(input: IndependentCommandInput) {
	identity(input.invocationId, "invocationId");
	identity(input.creatorId, "creatorId");
	identity(input.command?.name, "command.name");
	if (input.command.args !== undefined && typeof input.command.args !== "string") throw new Error("command.args must be a string");
	if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 256)) throw new Error("name must be bounded text");
	const cwd = realpathSync(input.cwd);
	if (!statSync(cwd).isDirectory()) throw new Error("Independent work requires a directory");
	// The wire snapshot is JSON, not references that the caller can mutate during setup.
	const data = input.command.data === undefined ? undefined : JSON.parse(JSON.stringify(input.command.data, (_key, value) => {
		if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) throw new Error("command.data must be JSON");
		return value;
	})) as JsonValue;
	const command = { name: input.command.name, args: input.command.args ?? "", ...(data === undefined ? {} : { data }) };
	const digest = createHash("sha256").update(JSON.stringify([cwd, input.name ?? null, command])).digest("hex");
	return { cwd, command, digest };
}

/** Create or recover one root, commit its command admission, and close only the caller's link. */
export async function launchIndependentCommand(input: IndependentCommandInput, options: IndependentLaunchOptions): Promise<IndependentCommandReceipt> {
	const { cwd, command, digest } = snapshotCommand(input);
	const requestId = `independent:${input.invocationId}`;
	const catalog = new AgentCatalog(options.root);
	let record = catalog.readRequest(input.creatorId, requestId);
	let created = false;
	if (record === undefined) {
		const selected = await (options.resolveDefaults ?? resolveConfiguredAgent)({
			cwd, agentDir: options.agentDir, packageDir: options.packageDir,
			command: command.name,
			askPrimary: options.askPrimary ?? ((target) => askCreatorTrust(options.root, input.creatorId, target)),
		});
		const metadata: Omit<HostMetadata, "storageId" | "storagePath"> = {
			cwd, agentDir: options.agentDir, packageDir: options.packageDir,
			model: selected.model, thinkingLevel: selected.thinkingLevel,
			...(input.name === undefined ? {} : { name: input.name }), ownerId: input.creatorId,
			independent: { inputDigest: digest, projectTrusted: selected.projectTrusted },
		};
		({ record, created } = catalog.createTracked(metadata, requestId));
	}
	if (record.independent?.inputDigest !== digest) throw new Error("Independent invocation already belongs to different command input");
	let client: Awaited<ReturnType<typeof acquireHost>>;
	try { client = await (options.acquire ?? acquireHost)(hostMetadata(record, options.packageDir), { retryAttempts: 0 }); }
	catch (error) { if (created) catalog.discardUnopened(record); throw error; }
	try {
		const versionError = hostRequestVersionError("command", client.runtimeContract);
		if (versionError) throw versionError;
		const admission = await client.request("command", {
			sessionId: record.storageId, invocationId: input.invocationId, ...command,
		}) as IndependentCommandReceipt["admission"];
		if (admission?.identity !== record.storageId || admission.name !== command.name || typeof admission.text !== "string" || !Number.isSafeInteger(admission.conversationId)) throw new Error("The host returned no independent command admission");
		return { sessionId: record.storageId, cwd, admission };
	} finally { await client.close(); }
}
