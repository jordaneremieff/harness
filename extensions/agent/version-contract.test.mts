import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { StatusOutputSchema, StatusToolOutputSchema, structuredObservation } from "./observation-schema.ts";
import { page as rosterPage } from "./dashboard-test-fixture.mts";
import { buildStatusOverview } from "./status-overview.ts";
import { HOST_CONTRACT, contractRefusal, operationContractMismatch, parseOperationContract, parseRuntimeContract, type RuntimeContract } from "./version-contract.ts";

it("implements the operation identities and schema hashes published in the host contract", () => {
	const docs = readFileSync(new URL("../../docs/agent-host-contract.md", import.meta.url), "utf8");
	assert.ok(Buffer.byteLength(docs) <= 512 * 1024, "Documented contract byte bound");
	const common = docs.slice(docs.indexOf("For every member in the following set"), docs.indexOf("Overrides and remaining members:"));
	const defaults = /```text\n([\s\S]*?)\n```/.exec(common);
	assert.ok(defaults);
	const documented: Record<string, RuntimeContract["operations"][string]> = {};
	for (const member of defaults[1].trim().split(/\s+/u)) documented[member] = { request: `${member}/1.0.0`, response: `${member}/1.0.0` };
	const table = docs.slice(docs.indexOf("| Member | Request | Response | Durable |"), docs.indexOf("Each `H-*`"));
	for (const row of table.split("\n").filter(line => /^\| [a-z-]+ \|/u.test(line))) {
		const cells = row.split("|").map(cell => cell.trim());
		const response = cells[3];
		const hash = response.startsWith("H-") ? docs.split("\n").find(line => line.startsWith(`${response} `))?.trim().split(/\s+/u)[1] : response;
		assert.ok(hash, `Missing documented response: ${response}`);
		if (response.startsWith("H-")) assert.match(hash, /^[a-f0-9]{64}$/u);
		assert.ok(cells[4] === "D" || cells[4] === "absent");
		documented[cells[1]] = { request: cells[2], response: hash, ...(cells[4] === "D" ? { durable: HOST_CONTRACT.upstream.durable } : {}) };
	}
	assert.deepEqual(HOST_CONTRACT.operations, documented);
});

it("keeps roster coverage local without changing the published host status identity", () => {
	const docs = readFileSync(new URL("../../docs/agent-host-contract.md", import.meta.url), "utf8");
	const published = /^H-status\s+([a-f0-9]{64})$/mu.exec(docs)?.[1];
	assert.ok(published);
	const hash = (schema: unknown) => createHash("sha256").update(JSON.stringify(schema)).digest("hex");
	assert.equal(hash(StatusOutputSchema), published);
	assert.equal(HOST_CONTRACT.operations.status.response, hash(StatusOutputSchema));
	const overview = buildStatusOverview(rosterPage([]), [], []);
	const inventory = { candidates: 3, inspected: 3, unreadable: 0, unknownClaims: 0, returned: 2, remaining: 1, priorityRemaining: 1,
		remainingRows: 2, priorityRemainingRows: 2, recordByteLimit: 32768, claimByteLimit: 16384, outputLimit: 2 };
	const local = { ...overview, coverage: { ...overview.coverage, inventory, omittedPriorityRows: 2, omittedPriorityRecords: 1 } };
	assert.deepEqual(structuredObservation(StatusToolOutputSchema, local), local);
	const { inventory: _inventory, omittedPriorityRows: _rows, omittedPriorityRecords: _records, ...wireCoverage } = overview.coverage;
	const wire = { ...overview, coverage: wireCoverage };
	assert.deepEqual(structuredObservation(StatusOutputSchema, wire), wire);
	for (const [field, value] of Object.entries({ inventory, omittedPriorityRows: 2, omittedPriorityRecords: 1 })) {
		assert.throws(() => structuredObservation(StatusOutputSchema, { ...wire, coverage: { ...wireCoverage, [field]: value } }), /does not match its schema/u);
		assert.throws(() => structuredObservation(StatusToolOutputSchema, { ...local, coverage: { ...local.coverage, [field]: "invalid" } }), /does not match its schema/u);
	}
	assert.throws(() => structuredObservation(StatusToolOutputSchema, { ...local, coverage: { ...local.coverage, inventory: { ...inventory, inspected: -1 } } }), /does not match its schema/u);
	assert.throws(() => structuredObservation(StatusToolOutputSchema, { ...local, coverage: { ...local.coverage, unexpected: true } }), /does not match its schema/u);
	assert.equal(hash(StatusOutputSchema), published, "local output validation does not alter the wire schema");
	assert.equal(contractRefusal("status", { ...HOST_CONTRACT, operations: { ...HOST_CONTRACT.operations, status: { ...HOST_CONTRACT.operations.status, response: published } } }), undefined);
});

it("refuses self-owned rewind and timer requests in both contract directions without changing responses", () => {
	for (const method of ["rewind", "timer-schedule"]) {
		const current = HOST_CONTRACT.operations[method];
		assert.equal(current.request, `${method}/1.1.0`);
		assert.equal(current.response, `${method}/1.0.0`);
		const old = { ...current, request: `${method}/1.0.0` };
		const oldRuntime = { ...HOST_CONTRACT, operations: { ...HOST_CONTRACT.operations, [method]: old } };
		assert.match(contractRefusal(method, oldRuntime)?.message ?? "", /request contract/u);
		assert.match(operationContractMismatch(method, current, oldRuntime) ?? "", /request contract/u);
		for (const [name, operation] of Object.entries(HOST_CONTRACT.operations)) {
			if (name !== method) assert.equal(operationContractMismatch(name, oldRuntime.operations[name]), undefined);
			assert.equal(oldRuntime.operations[name].response, operation.response);
		}
	}
});

it("advertises actual upstream releases separately from current operation contracts", () => {
	const parsed = parseRuntimeContract(JSON.parse(JSON.stringify(HOST_CONTRACT)));
	assert.deepEqual(parsed, HOST_CONTRACT);
	assert.match(parsed.release, /^\d+\.\d+\.\d+$/u);
	assert.match(parsed.upstream.codingAgent, /^\d+\.\d+\.\d+/u);
	assert.match(parsed.upstream.durable, /^\d+\.\d+\.\d+/u);
	assert.match(parsed.operations.status.response, /^[a-f0-9]{64}$/u);
	assert.equal(parsed.operations.status.durable, parsed.upstream.durable);
	assert.equal(parsed.operations.submit.durable, undefined);
	assert.deepEqual(parsed.requires, { codingAgent: "1.3.0", durable: "1.4.0" });
});

it("refuses only recovery-state for a peer without the active-delivery response", () => {
	assert.deepEqual(HOST_CONTRACT.operations["recovery-state"], { request: "recovery-state/1.0.0", response: "recovery-state/1.1.0" });
	const peer = { ...HOST_CONTRACT, operations: { ...HOST_CONTRACT.operations, "recovery-state": { request: "recovery-state/1.0.0", response: "recovery-state/1.0.0" } } };
	assert.match(contractRefusal("recovery-state", peer)?.message ?? "", /response contract/u);
	assert.equal(contractRefusal("submit", peer), undefined);
	assert.equal(contractRefusal("receipts", peer), undefined);
});

it("accepts unchanged operations despite added operations and different source releases", () => {
	const peer: RuntimeContract = { ...HOST_CONTRACT, release: "8.0.0", operations: { ...HOST_CONTRACT.operations, extra: { request: "extra/1.0.0", response: "extra/1.0.0" } } };
	assert.equal(contractRefusal("submit", peer), undefined);
	assert.equal(contractRefusal("status", peer), undefined);
	assert.equal(operationContractMismatch("close", peer.operations.close), undefined);
});

it("isolates missing operations, changed requests, changed responses, and native upstream mismatches", () => {
	assert.match(operationContractMismatch("submit", undefined) ?? "", /does not advertise submit/u);
	for (const method of ["constructor", "__proto__", "unknown"]) assert.match(contractRefusal(method, HOST_CONTRACT)?.message ?? "", /no current contract/u);
	assert.match(operationContractMismatch("submit", { ...HOST_CONTRACT.operations.submit, request: "submit/2.0.0" }) ?? "", /request contract/u);
	assert.match(operationContractMismatch("status", { ...HOST_CONTRACT.operations.status, response: "other" }) ?? "", /response contract/u);
	assert.match(operationContractMismatch("status", { ...HOST_CONTRACT.operations.status, durable: "9.0.0" }) ?? "", /requires Pi Durable/u);
	const peer = { ...HOST_CONTRACT, upstream: { codingAgent: "9.0.0", durable: "9.0.0" }, operations: { ...HOST_CONTRACT.operations, status: { ...HOST_CONTRACT.operations.status, durable: "9.0.0" } } };
	assert.equal(contractRefusal("submit", peer), undefined, "a normalized harness operation does not assume a native ABI");
	const refusal = contractRefusal("status", peer);
	assert.match(refusal?.message ?? "", /Pi Durable.*Restart.*Active work stays intact/u);
});

it("requires ordinary validation and native durable sleeps without pinning newer releases", () => {
	assert.deepEqual(HOST_CONTRACT.requires, { codingAgent: "1.3.0", durable: "1.4.0" });
	for (const upstream of ["codingAgent", "durable"] as const) {
		for (const version of ["0.99.9", "1.0.0", "1.0.4", "1.1.0", "1.1.99", "1.2.0-alpha", "1.2.0-rc.1+build", "1.2.0", "1.2.99", "1.3.0-alpha", "1.3.0-rc.1+build", ...(upstream === "durable" ? ["1.3.0", "1.3.1", "1.4.0-alpha"] : [])]) {
			assert.throws(() => parseRuntimeContract({ ...HOST_CONTRACT, upstream: { ...HOST_CONTRACT.upstream, [upstream]: version } }), /requirements are unmet: Pi >=1\.3\.0, Durable >=1\.4\.0.*Update/u, `${upstream} ${version}`);
		}
		for (const version of [...(upstream === "codingAgent" ? ["1.3.0", "1.3.0+build", "1.3.1"] : []), "1.4.0", "1.4.0+build", "1.10.0", "2.0.0"]) {
			const peer = { ...HOST_CONTRACT, upstream: { ...HOST_CONTRACT.upstream, [upstream]: version } };
			const parsed = parseRuntimeContract(peer);
			assert.equal(parsed.upstream[upstream], version);
			assert.deepEqual(parsed.operations, HOST_CONTRACT.operations);
			for (const method of Object.keys(HOST_CONTRACT.operations)) assert.equal(contractRefusal(method, parsed), undefined);
		}
	}
});

it("keeps necessary upstream API floors separate from wildcard package declarations", () => {
	const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.dependencies["@earendil-works/pi-durable"], "*");
});

it("refuses malformed descriptors instead of assuming a retired contract", () => {
	for (const value of [undefined, 4, { version: 4 }, { ...HOST_CONTRACT, format: "unknown" }, { ...HOST_CONTRACT, operations: { "bad name": HOST_CONTRACT.operations.submit } }]) assert.throws(() => parseRuntimeContract(value));
	assert.throws(() => parseOperationContract({ request: "submit/1.0.0", response: "submit/1.0.0", alias: "old" }));
	assert.throws(() => parseOperationContract({ request: "", response: "x" }));
	assert.throws(() => parseOperationContract({ request: "x", response: "y", durable: "*" }));
});
