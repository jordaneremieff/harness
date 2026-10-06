/** Current process interfaces and upstream facts, independent of source release order. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { VERSION as CODING_AGENT_VERSION } from "@earendil-works/pi-coding-agent";
import { AgentConversationSummarySchema, InspectOutputSchema, ListRowSchema, StatusOutputSchema } from "./observation-schema.ts";
import { AgentProfileSchema, ProfileUpdateSchema } from "./profile-schema.ts";
import { ProfiledListOutputSchema } from "./profile-discovery.ts";

const require = createRequire(import.meta.url);
const durableVersion: unknown = JSON.parse(readFileSync(require.resolve("@earendil-works/pi-durable/package.json"), "utf8")).version;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
if (typeof durableVersion !== "string" || !SEMVER.test(durableVersion)) throw new Error("The installed Pi Durable version is unavailable");

export interface OperationContract {
	readonly request: string;
	readonly response: string;
	/** Opaque upstream values require the same experimental Durable release. */
	readonly durable?: string;
}
export interface RuntimeContract {
	readonly format: "pi.agent.contract/1";
	readonly release: string;
	readonly upstream: { readonly codingAgent: string; readonly durable: string };
	/** Necessary public API floor, not a claim of compatibility with every future release. */
	readonly requires: { readonly codingAgent: string; readonly durable: string };
	readonly operations: Readonly<Record<string, OperationContract>>;
}

function schemaId(schema: unknown): string {
	return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}
const operations: Record<string, OperationContract> = {};
for (const method of ["close", "recovery-state", "submit", "passive-submit", "spawn", "place", "attach", "receipts", "report", "acknowledge", "inspect", "status", "list", "fork", "rewind", "abort", "compact", "configure", "command", "reset", "timer-schedule", "timer-list", "timer-cancel", "dashboard", "snapshot", "observe-open", "observe-frame", "observe-close", "changes", "collaboration-list", "collaboration-read", "collaboration-mutate"]) {
	operations[method] = { request: `${method}/1.0.0`, response: `${method}/1.0.0` };
}
for (const method of ["profile-read", "profile-update", "profile-list", "resolve-agent", "task-submit"]) operations[method] = { request: `${method}/1.0.0`, response: `${method}/1.0.0` };
operations["task-submit"] = { ...operations["task-submit"], response: "task-submit/1.1.0" };
for (const method of ["spawn", "resolve-agent"]) operations[method] = { request: `${method}/1.1.0`, response: `${method}/1.2.0` };
for (const method of ["place", "configure"]) operations[method] = { request: `${method}/1.1.0`, response: `${method}/1.1.0` };
operations.submit = { request: "submit/1.1.0", response: "submit/1.1.0" };
operations.command = { request: "command/1.1.0", response: "command/1.0.0" };
operations.receipts = { request: "receipts/1.1.0", response: "receipts/1.1.0" };
for (const method of ["await-state", "await-release"]) operations[method] = { request: `${method}/1.0.0`, response: `${method}/1.0.0` };
operations["await-state"] = { request: "await-state/1.1.0", response: "await-state/1.1.0" };
operations["profile-list"] = { ...operations["profile-list"], response: schemaId(ProfiledListOutputSchema) };
operations["profile-read"] = { ...operations["profile-read"], response: schemaId(AgentProfileSchema) };
operations["profile-update"] = { ...operations["profile-update"], response: schemaId(ProfileUpdateSchema) };
operations.status = { ...operations.status, response: schemaId(StatusOutputSchema), durable: durableVersion };
operations.inspect = { ...operations.inspect, response: schemaId(InspectOutputSchema), durable: durableVersion };
operations.list = { ...operations.list, response: schemaId(ListRowSchema) };
operations.dashboard = { ...operations.dashboard, response: schemaId(AgentConversationSummarySchema) };
for (const method of ["snapshot", "observe-open", "observe-frame", "receipts", "fork", "rewind", "compact", "command"]) operations[method] = { ...operations[method], durable: durableVersion };

operations["recovery-state"] = { ...operations["recovery-state"], response: "recovery-state/1.1.0" };

/** Release identifies source; operation identities, not release ordering, authorize calls. */
export const HOST_CONTRACT: RuntimeContract = Object.freeze({
	format: "pi.agent.contract/1",
	release: "1.0.0",
	upstream: Object.freeze({ codingAgent: CODING_AGENT_VERSION, durable: durableVersion }),
	requires: Object.freeze({ codingAgent: "1.0.0", durable: "1.0.0" }),
	operations: Object.freeze(Object.fromEntries(Object.entries(operations).map(([name, contract]) => [name, Object.freeze(contract)]))),
});

/** Separate interfaces refuse reload only when their own current contract changes. */
export const MANAGER_CONTRACT = "manager/1.9.0";
export const CONTROL_BINDING_CONTRACT = `native-controls/1.5.0;durable=${durableVersion}`;
export const PRIMARY_DELIVERY_CONTRACT = "primary-delivery/1.0.0";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
}
export function parseOperationContract(value: unknown): OperationContract {
	if (!record(value) || !identity(value.request) || !identity(value.response) || (value.durable !== undefined && (typeof value.durable !== "string" || !SEMVER.test(value.durable))) || Object.keys(value).some((key) => !["request", "response", "durable"].includes(key))) throw new Error("The agent operation contract is malformed");
	return { request: value.request, response: value.response, ...(value.durable === undefined ? {} : { durable: value.durable as string }) };
}

function release(value: unknown): value is string {
	return typeof value === "string" && value.length <= 128 && SEMVER.test(value);
}

function requiresUpstream(actual: string, minimum: string): boolean {
	const parts = (value: string) => value.split(/[+-]/u, 1)[0].split(".").map(BigInt);
	const a = parts(actual);
	const b = parts(minimum);
	for (let index = 0; index < 3; index++) {
		if (a[index] > b[index]) return true;
		if (a[index] < b[index]) return false;
	}
	return !actual.split("+", 1)[0].includes("-");
}

function upstreamReleases(value: unknown): RuntimeContract["upstream"] {
	if (!record(value) || !release(value.codingAgent) || !release(value.durable)) throw new Error("The upstream release declaration is malformed. Restart with current agent code.");
	return { codingAgent: value.codingAgent, durable: value.durable };
}

/** Bounded descriptor parsing never interprets a retired handshake or payload. */
export function parseRuntimeContract(value: unknown): RuntimeContract {
	if (!record(value) || value.format !== "pi.agent.contract/1" || !release(value.release) || !record(value.operations) || Object.keys(value.operations).length > 128) throw new Error("The agent runtime contract is missing or malformed. Restart the host with the current agent code.");
	const upstream = upstreamReleases(value.upstream);
	const requires = upstreamReleases(value.requires);
	if (requires.codingAgent.includes("-") || requires.durable.includes("-")) throw new Error("The upstream requirement floor must be a stable release");
	if (!requiresUpstream(upstream.codingAgent, requires.codingAgent) || !requiresUpstream(upstream.durable, requires.durable)) throw new Error(`The host upstream requirements are unmet: Pi >=${requires.codingAgent}, Durable >=${requires.durable}. Update the installed upstream packages and restart the host.`);
	const parsed: Record<string, OperationContract> = {};
	for (const [name, operation] of Object.entries(value.operations)) {
		if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name)) throw new Error("The agent operation name is malformed");
		parsed[name] = parseOperationContract(operation);
	}
	return { format: value.format, release: value.release, upstream, requires, operations: parsed };
}

export function operationContractMismatch(method: string, remote: OperationContract | undefined, local: RuntimeContract = HOST_CONTRACT): string | undefined {
	const expected = Object.hasOwn(local.operations, method) ? local.operations[method] : undefined;
	if (!expected) return `This caller has no current contract for ${method}.`;
	if (!remote) return `The peer does not advertise ${method}.`;
	if (remote.request !== expected.request) return `${method} request contract ${remote.request} differs from ${expected.request}.`;
	if (remote.response !== expected.response) return `${method} response contract ${remote.response} differs from ${expected.response}.`;
	if (remote.durable !== expected.durable) return `${method} requires Pi Durable ${expected.durable ?? "independent"}; the peer declares ${remote.durable ?? "independent"}.`;
	return undefined;
}

export function contractRefusal(method: string, remote: RuntimeContract): Error | undefined {
	const mismatch = operationContractMismatch(method, remote.operations[method]);
	return mismatch ? new Error(`${mismatch} This Pi uses agent release ${HOST_CONTRACT.release} (Pi ${HOST_CONTRACT.upstream.codingAgent}, Durable ${HOST_CONTRACT.upstream.durable}); the host uses ${remote.release} (Pi ${remote.upstream.codingAgent}, Durable ${remote.upstream.durable}). Restart the caller to load current agent code; let an idle host retire, then use agent_attach and retry. Active work stays intact.`) : undefined;
}
