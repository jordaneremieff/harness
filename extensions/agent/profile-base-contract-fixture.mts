import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { VERSION as CODING_AGENT_VERSION } from "@earendil-works/pi-coding-agent";
import { ServerError, type ServerHost } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { connectHost } from "./host-client.ts";
import { hostPaths, parseHostMetadata } from "./host-protocol.ts";
import { parseOperationContract, type OperationContract, type RuntimeContract } from "./version-contract.ts";

const require = createRequire(import.meta.url);
const DURABLE_VERSION: string = JSON.parse(readFileSync(require.resolve("@earendil-works/pi-durable/package.json"), "utf8")).version;

/** Fixed operation identities isolate feature additions from upstream release changes. */
export const BASE_OPERATIONS: Readonly<Record<string, OperationContract>> = {
	status: { request: "status/1.0.0", response: "04082e4c23cf4ca78ca4529658060f615a4bfdeeb4d019cf3ed6c409e7fa84ae", durable: DURABLE_VERSION },
	submit: { request: "submit/1.0.0", response: "submit/1.0.0" },
	configure: { request: "configure/1.0.0", response: "configure/1.0.0" },
	reset: { request: "reset/1.0.0", response: "reset/1.0.0" },
	list: { request: "list/1.0.0", response: "3dd4ce5e2b550ef084b274c8a434f06775ea56ed287ceb226aa470f5df80f833" },
	dashboard: { request: "dashboard/1.0.0", response: "9b3b0eba7308aa7d031cf8bf86d1ad5cbfdecf0e2d9b8971186b842f8feea8f8" },
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
	const host: ServerHost = {
		serverServices: { attachClient: () => ({
			invokeService: async (call) => {
				if (call.member === "runtime-contract") return baseContract as unknown as JsonValue;
				const expected = BASE_OPERATIONS[call.member];
				const supplied = parseOperationContract(call.args[2]);
				if (!expected || supplied.request !== expected.request || supplied.response !== expected.response || supplied.durable !== expected.durable) throw new ServerError("service_invalid_value", `Unavailable base operation: ${call.member}`);
				process.send?.({ event: "forwarded", method: call.member });
				return await connection.request(call.member, call.args[0]) as JsonValue;
			},
			release: () => {},
		}) },
		resolveSession: async () => { throw new ServerError("session_not_found", "No session routing in the contract fixture"); },
		openSession: async () => { throw new ServerError("session_not_found", "No session routing in the contract fixture"); },
	};
	const server = createUnixServer(host, { serverId: paths.serverId, path: paths.socket, mode: 0o600 });
	await server.start();
	process.once("disconnect", () => {
		void server.close().finally(async () => { await connection.close(); rmSync(paths.claim, { force: true }); process.exit(0); });
	});
	process.send?.({ event: "ready" });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
}
