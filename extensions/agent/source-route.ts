import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync, mkdirSync, writeFileSync, fsyncSync, renameSync, unlinkSync, realpathSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindInstallationPackages } from "./installation-binding.ts";
import type { OperationContract } from "./version-contract.ts";
import { UNIX_FRAME_BYTES } from "../../transport/index.ts";

/** Complete private source-call JSON, including routing metadata and operation contracts. */
export const SOURCE_CALL_BYTES = UNIX_FRAME_BYTES;

export type ExistingSource = { root: string; sourceRoot: string; packageDir: string };
export function parseExistingSource(value: unknown): ExistingSource {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid existing source route");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some(key => !["root", "sourceRoot", "packageDir"].includes(key))) throw new Error("Unsupported existing source route");
	for (const key of ["root", "sourceRoot", "packageDir"]) if (typeof input[key] !== "string" || !isAbsolute(input[key]) || input[key].length > 4096 || /[\u0000-\u001f\u007f]/u.test(input[key])) throw new Error(`Invalid existing source ${key}`);
	return { root: input.root as string, sourceRoot: input.sourceRoot as string, packageDir: input.packageDir as string };
}
export function parseExistingSources(value: unknown): ExistingSource[] {
	if (!Array.isArray(value) || value.length > 256 || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new Error("Existing sources exceed their bound");
	const routes = value.map(parseExistingSource);
	if (new Set(routes.map(route => route.root)).size !== routes.length) throw new Error("Existing source roots must be unique");
	return routes;
}
export function readExistingSources(root: string): ExistingSource[] {
	let fd: number;
	try { fd = openSync(join(root, "native-sources.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	try {
		const size = fstatSync(fd);
		if (!size.isFile() || size.size > 1048576) throw new Error("The native source inventory exceeds its bound");
		const bytes = Buffer.alloc(size.size + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		if (length !== size.size) throw new Error("The native source inventory changed during its read");
		return parseExistingSources(JSON.parse(bytes.toString("utf8", 0, length)));
	} finally { closeSync(fd); }
}
export async function installSourceRoutes(root: string, value: unknown): Promise<void> {
	const selected = parseExistingSources(value);
	if (selected.some(route => route.root === root)) throw new Error("A namespace must not route back to itself");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const { processLock } = await import("@earendil-works/chord/node");
	const unlock = await processLock(`agent.source-routes:${root}`);
	let temporary: string | undefined;
	try {
		const merged = new Map(readExistingSources(root).map(route => [route.root, route]));
		for (const route of selected) {
			const prior = merged.get(route.root);
			if (prior && (prior.sourceRoot !== route.sourceRoot || prior.packageDir !== route.packageDir)) throw new Error("An existing namespace source binding is immutable");
			merged.set(route.root, route);
		}
		const routes = parseExistingSources([...merged.values()]);
		temporary = join(root, `.native-sources-${randomUUID()}`);
		const fd = openSync(temporary, "wx", 0o600);
		try { writeFileSync(fd, `${JSON.stringify(routes)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(temporary, join(root, "native-sources.json")); temporary = undefined;
	} finally { if (temporary) unlinkSync(temporary); await unlock(); }
}
/** Public transport stays local; a cold writer loads only the target's retained runner and installation. */
export function sourceHostOptions(value: ExistingSource): import("./host-client.ts").HostLaunchOptions {
	const route = parseExistingSource(value);
	for (const path of [route.sourceRoot, route.packageDir]) {
		if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error("An existing source directory is not canonical");
	}
	const runner = join(route.sourceRoot, "extensions", "agent", "durable-runner.ts");
	if (realpathSync(runner) !== runner || !lstatSync(runner).isFile()) throw new Error("The retained native runner is not a canonical regular file");
	return { runner, retryAttempts: 0, env: { PI_AGENT_SESSIONS_DIR: route.root } };
}

export type RouteCall = { route: ExistingSource; agentDir: string; action: "control" | "spawn" | "resolve"; method?: string; input: Record<string, unknown>; caller: { id: string; cwd: string }; expected: Record<string, OperationContract> };

/** Retained roots execute through their recorded source and installation, in a separate process. */
export function callExistingSource(call: RouteCall): Promise<unknown> {
	const payload = JSON.stringify(call);
	if (Buffer.byteLength(payload, "utf8") > SOURCE_CALL_BYTES) return Promise.reject(new Error("The complete source call exceeds its byte limit; no operation was started"));
	return new Promise((resolve, reject) => {
		const child = execFile(process.execPath, [fileURLToPath(import.meta.url)], { cwd: call.caller.cwd, encoding: "utf8", timeout: 60000, maxBuffer: 262144 }, (error, stdout) => {
			if (error) { reject(new Error("The existing source did not confirm the operation; inspect its state before retrying")); return; }
			try {
				const receipt = JSON.parse(stdout) as { ok: boolean; value?: unknown; error?: string };
				if (!receipt.ok) throw new Error(receipt.error ?? "The existing source refused the operation");
				resolve(receipt.value);
			} catch (failure) { reject(failure); }
		});
		// A lost pipe does not establish whether the child admitted an operation.
		child.stdin?.on("error", () => {});
		child.stdin?.end(payload, "utf8");
	});
}

export async function readSourceCall(input: AsyncIterable<Uint8Array>): Promise<RouteCall> {
	const chunks: Buffer[] = []; let size = 0;
	for await (const chunk of input) {
		size += chunk.byteLength;
		if (size > SOURCE_CALL_BYTES) throw new Error("The complete source call exceeds its byte limit; no operation was started");
		chunks.push(Buffer.from(chunk));
	}
	try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as RouteCall; }
	catch { throw new Error("The source call is not valid UTF-8 JSON; no operation was started"); }
}
async function execute(call: RouteCall): Promise<unknown> {
	const route = parseExistingSource(call.route);
	sourceHostOptions(route);
	const directory = pathToFileURL(`${join(route.sourceRoot, "extensions", "agent")}/`);
	bindInstallationPackages(route.packageDir, directory);
	const [{ AgentManager }, { acquireHost, connectHost }, producer] = await Promise.all([import(new URL("manager.ts", directory).href), import(new URL("host-client.ts", directory).href), import(new URL("version-contract.ts", directory).href)]);
	if (call.action === "control" && typeof call.method !== "string") throw new Error("A source control method is required");
	const names = call.action === "spawn" ? ["spawn", "profile-read", ...(call.input.prompt === undefined ? [] : ["task-submit"])] : call.action === "resolve" ? ["profile-read"] : [String(call.method)];
	const check = (contract: { operations: Record<string, OperationContract> }) => {
		for (const name of names) {
			const actual = contract.operations[name], expected = call.expected[name];
			if (!actual || !expected || actual.request !== expected.request || actual.response !== expected.response || actual.durable !== expected.durable) throw new Error(`The existing source does not support the current ${name} contract`);
		}
	};
	check(producer.HOST_CONTRACT);
	const validate = async (client: import("./host-client.ts").HostConnection) => {
		try { check(client.runtimeContract); return client; } catch (error) { await client.close(); throw error; }
	};
	const manager = new AgentManager({ root: route.root, agentDir: call.agentDir, packageDir: route.packageDir,
		acquire: async (metadata: unknown, options: unknown) => validate(await acquireHost(metadata, options)),
		connect: async (metadata: unknown, options: unknown) => validate(await connectHost(metadata, options)),
	});
	try {
		if (call.action === "resolve") return await manager.resolveTarget(String(call.input.sessionId));
		if (call.action === "spawn") return await manager.spawn(call.input, call.caller);
		return await manager.control(call.method, call.input, call.caller);
	} finally { manager.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const call = process.argv.length === 2 ? readSourceCall(process.stdin) : Promise.reject(new Error("Source calls require private stdin"));
	void call.then(execute).then(value => { process.stdout.write(`${JSON.stringify({ ok: true, value })}\n`); }).catch(error => { process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message.slice(0, 512) : "Existing source operation failed" })}\n`); });
}
