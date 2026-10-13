import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION as CODING_AGENT_VERSION } from "@earendil-works/pi-coding-agent";
import { createTransportServer } from "../../transport/index.ts";
import { connectHost } from "./host-client.ts";
import { hostPaths, parseHostMetadata } from "./host-protocol.ts";
import { parseOperationContract, type OperationContract, type RuntimeContract } from "./version-contract.ts";

const require = createRequire(import.meta.url);
const DURABLE_VERSION: string = JSON.parse(readFileSync(require.resolve("@earendil-works/pi-durable/package.json"), "utf8")).version;

/** Fixed operation identities isolate feature additions from upstream release changes. */
export const BASE_OPERATIONS: Readonly<Record<string, OperationContract>> = {
	status: { request: "status/1.0.0", response: "5df139e808900bee9bf561760b4f7da690df743f336609ec26ab0a7a11957dc1", durable: DURABLE_VERSION },
	submit: { request: "submit/1.1.0", response: "submit/1.1.0" },
	reset: { request: "reset/1.0.0", response: "reset/1.0.0" },
	list: { request: "list/1.0.0", response: "76e932a0749fd72c9aef6b90635d061e455f84fb57f7f9bd102034cf28887600" },
	dashboard: { request: "dashboard/1.0.0", response: "46dd1bdd919bd3093ad6a3c0a316b35fa05d491490a37c9879ef9a9cffc4f241" },
};
const baseContract: RuntimeContract = {
	format: "pi.agent.contract/1", release: "1.0.0", upstream: { codingAgent: CODING_AGENT_VERSION, durable: DURABLE_VERSION },
	requires: { codingAgent: "1.0.0", durable: "1.0.0" }, operations: BASE_OPERATIONS,
};

/** A base-only process forwards unchanged operations to real storage, with no profile capability. */
async function main(): Promise<void> {
	const metadata = parseHostMetadata(JSON.parse(process.argv[2]));
	const target = parseHostMetadata(JSON.parse(process.argv[3]));
	const connection = await connectHost(target, { retryAttempts: 0 });
	const paths = hostPaths(metadata);
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	mkdirSync(dirname(paths.claim), { recursive: true, mode: 0o700 });
	writeFileSync(paths.claim, JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname(), sessionId: metadata.storageId, cwd: metadata.cwd, createdAt: new Date().toISOString() }), { mode: 0o600 });
	const server = createTransportServer({
		serverId: paths.serverId, path: paths.socket,
		request: async (request) => {
			if (request.method === "runtime-contract") return baseContract;
			const expected = BASE_OPERATIONS[request.method];
			const supplied = parseOperationContract(request.contract);
			if (!expected || supplied.request !== expected.request || supplied.response !== expected.response || supplied.durable !== expected.durable) throw new Error(`Unavailable base operation: ${request.method}`);
			process.send?.({ event: "forwarded", method: request.method });
			return connection.request(request.method, request.params);
		},
	});
	await server.start();
	process.once("disconnect", () => {
		void server.close().finally(async () => { await connection.close(); rmSync(paths.claim, { force: true }); process.exit(0); });
	});
	process.send?.({ event: "ready" });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
}
