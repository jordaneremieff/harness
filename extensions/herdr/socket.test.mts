import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HerdrClient, HerdrError, socketEndpoint } from "./socket.ts";

function ok(result: unknown): string {
	return `${JSON.stringify({ id: "x", result })}\n`;
}

function fail(code: string, message: string): string {
	return `${JSON.stringify({ id: "x", error: { code, message } })}\n`;
}

describe("socketEndpoint", () => {
	it("passes unix paths through", () => {
		assert.equal(socketEndpoint("/tmp/herdr.sock", "linux"), "/tmp/herdr.sock");
	});
	it("maps windows paths to named pipes", () => {
		assert.equal(socketEndpoint("herdr.sock", "win32"), "\\\\.\\pipe\\herdr.sock");
	});
});

describe("HerdrClient.request", () => {
	it("sends one JSONL request and parses the result", async () => {
		const payloads: string[] = [];
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async (_endpoint, payload) => {
				payloads.push(payload);
				return ok({ type: "tab_list", tabs: [] });
			},
		});
		const result = (await client.request("tab.list", { workspace_id: "w1" })) as { type: string };
		assert.equal(result.type, "tab_list");
		assert.equal(payloads.length, 1);
		const sent = JSON.parse(payloads[0]);
		assert.equal(sent.method, "tab.list");
		assert.deepEqual(sent.params, { workspace_id: "w1" });
		assert.ok(sent.id.startsWith("custom:test:tab.list:"));
	});

	it("retries once after a transport failure", async () => {
		let calls = 0;
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async () => {
				calls += 1;
				if (calls === 1) throw new Error("boom");
				return ok({ type: "tab_list", tabs: [] });
			},
		});
		await client.request("tab.list", {});
		assert.equal(calls, 2);
	});

	it("rejects with HerdrError on an error response", async () => {
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async () => fail("tab_not_found", "no such tab"),
		});
		await assert.rejects(client.request("tab.get", {}), (err) => {
			assert.ok(err instanceof HerdrError);
			assert.equal(err.code, "tab_not_found");
			return true;
		});
	});

	it("rejects on an empty response", async () => {
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async () => "\n",
		});
		await assert.rejects(client.request("tab.list", {}), /empty response/);
	});

	it("increments the report sequence", () => {
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async () => ok({}),
			now: () => 1000,
		});
		const first = client.nextSeq();
		const second = client.nextSeq();
		assert.equal(second, first + 1);
	});
});

describe("HerdrClient.send", () => {
	it("retries once after a transport failure", async () => {
		let calls = 0;
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async () => {
				calls += 1;
				if (calls === 1) throw new Error("boom");
				return ok({});
			},
		});
		await client.send("pane.report_metadata", { seq: 1 });
		assert.equal(calls, 2);
	});

	it("drops the report when both attempts fail", async () => {
		let calls = 0;
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async () => {
				calls += 1;
				throw new Error("down");
			},
		});
		await client.send("pane.report_metadata", { seq: 1 });
		assert.equal(calls, 2);
	});
});
