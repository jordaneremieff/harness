import assert from "node:assert/strict";
import { it } from "node:test";
import { HOST_CONTRACT, contractRefusal, operationContractMismatch, parseOperationContract, parseRuntimeContract, type RuntimeContract } from "./version-contract.ts";

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
	assert.deepEqual(parsed.requires, { codingAgent: "1.0.0", durable: "1.0.0" });
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

it("checks necessary upstream floors without pinning newer package releases", () => {
	const newer = { ...HOST_CONTRACT, upstream: { codingAgent: "2.0.0", durable: "2.0.0" } };
	assert.equal(parseRuntimeContract(newer).upstream.codingAgent, "2.0.0");
	for (const version of ["0.99.9", "1.0.0-alpha", "0.1.0+build"]) {
		assert.throws(() => parseRuntimeContract({ ...HOST_CONTRACT, upstream: { ...HOST_CONTRACT.upstream, codingAgent: version } }), /requirements are unmet.*Update/u);
	}
});

it("refuses malformed descriptors instead of assuming a retired contract", () => {
	for (const value of [undefined, 4, { version: 4 }, { ...HOST_CONTRACT, format: "unknown" }, { ...HOST_CONTRACT, operations: { "bad name": HOST_CONTRACT.operations.submit } }]) assert.throws(() => parseRuntimeContract(value));
	assert.throws(() => parseOperationContract({ request: "submit/1.0.0", response: "submit/1.0.0", alias: "old" }));
	assert.throws(() => parseOperationContract({ request: "", response: "x" }));
	assert.throws(() => parseOperationContract({ request: "x", response: "y", durable: "*" }));
});
