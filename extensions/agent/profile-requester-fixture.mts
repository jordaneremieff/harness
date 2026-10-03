import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { hostMetadata } from "./catalog.ts";
import { acquireHost, waitForHostRelease, type HostConnection } from "./host-client.ts";
import { AgentManager } from "./manager.ts";

const root = process.env.PI_AGENT_SESSIONS_DIR;
const agentDir = process.env.PI_AGENT_DIR;
const cwd = process.env.PROFILE_TEST_CWD;
const id = process.env.PROFILE_TEST_REQUESTER;
if (!root || !agentDir || !cwd || !id || !process.send) throw new Error("The requester fixture requires isolated paths and an IPC parent");
const connections = new Map<string, HostConnection>();
const controller = new AbortController();
const caller = { id, cwd, model: { provider: "profile-process-fixture", modelId: "expert" }, thinkingLevel: "off" };
const manager = new AgentManager({
	root, agentDir, packageDir: getPackageDir(),
	validateModel: (value) => {
		if (value.provider !== caller.model.provider || value.modelId !== caller.model.modelId) throw new Error("Fixture has no such model");
	},
	acquire: async (metadata, options) => {
		const connection = await acquireHost(metadata, options);
		connections.set(metadata.storageId, connection);
		process.send?.({ event: "host", storageId: metadata.storageId, pid: connection.pid });
		return connection;
	},
});
await manager.registerPrimary(id, {
	signal: controller.signal, ...caller,
	send: (text, details) => process.send?.({ event: "notice", text, details }),
});

interface Command { id: number; method: string; params: Record<string, unknown> }
async function dispatch({ method, params }: Command): Promise<unknown> {
	if (method === "spawn") return manager.spawn(params, caller);
	if (method === "control") return manager.control(String(params.method), params.input as Record<string, unknown>, caller);
	if (method === "metadata") return hostMetadata(manager.catalog.read(String(params.sessionId)));
	if (method === "release") {
		await waitForHostRelease(hostMetadata(manager.catalog.read(String(params.sessionId))), { signal: AbortSignal.timeout(30000) });
		return { released: true };
	}
	if (method === "raw") {
		const sessionId = String(params.sessionId);
		const metadata = hostMetadata(manager.catalog.read(sessionId));
		let connection = connections.get(metadata.storageId);
		if (!connection || connection.closed) {
			connection = await acquireHost(metadata);
			connections.set(metadata.storageId, connection);
			process.send?.({ event: "host", storageId: metadata.storageId, pid: connection.pid });
		}
		return connection.request(String(params.method), params.input, { signal: AbortSignal.timeout(60000) });
	}
	if (method === "disconnect") {
		controller.abort();
		manager.close();
		await Promise.all([...connections.values()].map((connection) => connection.close()));
		return { disconnected: true };
	}
	throw new Error(`Unknown fixture command: ${method}`);
}
process.on("message", (input: Command) => {
	void dispatch(input).then(
		(value) => process.send?.({ id: input.id, value }),
		(error: unknown) => process.send?.({ id: input.id, error: error instanceof Error ? error.message : String(error) }),
	);
});
process.once("disconnect", () => { controller.abort(); manager.close(); process.exit(0); });
process.send({ event: "ready", pid: process.pid, identity: id });
