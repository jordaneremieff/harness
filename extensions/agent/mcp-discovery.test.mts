import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { it, type TestContext } from "node:test";
import {
	answerMessage,
	codemodeStream,
	executionFixture,
	fixtureServerPath,
	toolResultText,
} from "./durable-execution-fixture.mts";
import { eventLog } from "./host-fixture.mts";
import { McpDiscoveryPool, scriptDiscoveryServers } from "./mcp-discovery.ts";

it("narrows only complete literal MCP requests", () => {
	const servers = ["one", "one_more", "dev-docs", "other", "1numbered"];
	const select = (code: string) => scriptDiscoveryServers(code, servers, (name) => name);
	assert.deepEqual(select('return await describeNamespace("dev_docs");'), ["dev-docs"]);
	assert.deepEqual(select('return await describeNamespace("_numbered");'), ["1numbered"]);
	assert.deepEqual(select("return await describeTool('mcp__one_more__lookup_doc');"), ["one_more"]);
	assert.deepEqual(select('return await tools.list_mcp_resources({"server":"other"});'), ["other"]);
	assert.deepEqual(select('return await tools.mcp__one_more__lookup_doc({"topic":"ALL_TOOLS"});'), ["one_more"]);
	assert.deepEqual(select('return "ALL_TOOLS";'), []);
	assert.deepEqual(select('const n = "one"; return describeNamespace(n);'), servers);
	assert.deepEqual(select('return [describeNamespace("one"), ALL_TOOLS];'), servers);
	assert.deepEqual(
		select('return await tools.mcp__one__lookup_doc({"topic": await describeNamespace("other")});'),
		servers,
	);
	assert.deepEqual(
		select('return await describeNamespace("one"); // a complete literal form excludes trailing code'),
		servers,
	);
	const overlapping = ["one", "one__other"];
	assert.equal(scriptDiscoveryServers('return describeTool("mcp__one__other__x");', overlapping, String), overlapping);
});

it("starts no discovery after its caller or the host stopped it, and runs the others at once", async (t) => {
	const pool = new McpDiscoveryPool();
	t.after(() => pool.close());
	let finish = () => {};
	const hold = new Promise<void>((resolve) => {
		finish = resolve;
	});
	t.after(finish);
	const started = eventLog<number>();
	const running = Array.from({ length: 12 }, (_, index) =>
		pool.run(async () => {
			started.push(index);
			await hold;
		}),
	);
	await started.waitForCount(12);
	const abort = new AbortController();
	abort.abort(new Error("model stopped"));
	let cancelledStarted = false;
	await assert.rejects(
		pool.run(async () => {
			cancelledStarted = true;
		}, abort.signal),
		/model stopped/u,
	);
	finish();
	await Promise.all(running);
	pool.close();
	await assert.rejects(
		pool.run(async () => {
			cancelledStarted = true;
		}),
		/shut down/u,
	);
	assert.equal(cancelledStarted, false);
});

async function processEvents(t: TestContext) {
	const live = new Map<number, Socket>();
	const sockets = new Set<Socket>();
	const started = eventLog<number>();
	const exited = eventLog<number>();
	let peak = 0;
	const listener = createServer((socket) => {
		sockets.add(socket);
		let pid: number | undefined;
		let prefix = "";
		socket.on("data", (value: Buffer) => {
			if (pid !== undefined) return;
			prefix += value.toString("utf8");
			const match = /^started ([0-9]+)\n/u.exec(prefix);
			if (match === null) return;
			pid = Number(match[1]);
			live.set(pid, socket);
			peak = Math.max(peak, live.size);
			started.push(pid);
		});
		socket.once("close", () => {
			sockets.delete(socket);
			if (pid !== undefined) {
				live.delete(pid);
				exited.push(pid);
			}
		});
	});
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	t.after(() => {
		for (const socket of sockets) socket.destroy();
		listener.close();
	});
	const address = listener.address();
	assert.ok(address && typeof address !== "string");
	return {
		started,
		exited,
		live,
		port: String(address.port),
		get peak() {
			return peak;
		},
	};
}

function stdio(port: string, env: Record<string, string> = {}) {
	return { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_EVENTS_PORT: port, ...env } };
}

for (const [form, expected] of [
	['return await describeNamespace("one_more");', /mcp__one_more__list_topics/u],
	['return await describeTool("mcp__one_more__list_topics");', /List documentation topics/u],
] as const)
	it(`limits literal discovery to the named server: ${form}`, { timeout: 10000 }, async (t) => {
		const processes = await processEvents(t);
		const fixture = await executionFixture(t, {
			code: form,
			mcpServers: {
				one: { ...stdio(processes.port, { MCP_FIXTURE_MODE: "silent" }), timeout: 0.25 },
				one_more: stdio(processes.port),
			},
		});
		const result = await fixture.submit("discover the named server only");
		assert.match(toolResultText(result.toolResults.at(-1)), expected);
		assert.equal(processes.started.length, 1);
	});

it("reports incomplete global discovery rather than returning only the available tools", {
	timeout: 10000,
}, async (t) => {
	const processes = await processEvents(t);
	const fixture = await executionFixture(t, {
		code: "return ALL_TOOLS;",
		mcpServers: {
			available: stdio(processes.port),
			silent: { ...stdio(processes.port, { MCP_FIXTURE_MODE: "silent" }), timeout: 0.25 },
		},
	});
	const result = (await fixture.submit("enumerate every tool")).toolResults.at(-1);
	assert.equal(result?.isError, true);
	assert.match(toolResultText(result), /MCP discovery could not finish: silent:/u);
	assert.doesNotMatch(toolResultText(result), /mcp__available__list_topics/u);
	assert.equal(processes.started.length, 2);
});

it("starts every server of a global discovery at once and returns every advertised namespace", {
	timeout: 30000,
}, async (t) => {
	const processes = await processEvents(t);
	const names = Array.from({ length: 12 }, (_, index) => `docs_${index}`);
	const fixture = await executionFixture(t, {
		code: "const all = ALL_TOOLS; return all;",
		mcpServers: Object.fromEntries(names.map((name) => [name, stdio(processes.port)])),
	});
	const result = await fixture.submit("enumerate all tools");
	const output = toolResultText(result.toolResults.at(-1));
	for (const name of names) assert.match(output, new RegExp(`mcp__${name}__list_topics\\b`, "u"));
	await processes.started.waitForCount(names.length);
	assert.equal(processes.peak, names.length, "no server waits for another server's discovery");
});

it("reclaims discovery-only stdio, preserves used state and refuses stale calls without replay", {
	timeout: 30000,
}, async (t) => {
	const processes = await processEvents(t);
	let script = "";
	const root = process.env.TMPDIR ?? ".";
	const stem = join(root, `mcp-lifetime-${randomUUID()}`);
	const change = `${stem}-descriptor`;
	const effects = `${stem}-effects`;
	const mutableEvents = `${stem}-mutable`;
	const { unlinkSync } = await import("node:fs");
	t.after(() => {
		for (const path of [change, effects, mutableEvents]) {
			try {
				unlinkSync(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	});
	const fixture = await executionFixture(t, {
		stream: (context) => {
			const message = context.messages.at(-1);
			if (message?.role !== "user") return answerMessage();
			const response = codemodeStream(script)({ ...context, messages: [message] }, []);
			return {
				...response,
				content: response.content.map((part) => (part.type === "toolCall" ? { ...part, id: randomUUID() } : part)),
			};
		},
		mcpServers: {
			stateful: stdio(processes.port, { MCP_FIXTURE_MODE: "stateful" }),
			mutable: stdio(processes.port, { MCP_FIXTURE_DESCRIPTOR_CHANGE: change, MCP_FIXTURE_EVENTS_FILE: mutableEvents }),
			lost: stdio(processes.port, { MCP_FIXTURE_MODE: "drop-after-effect", MCP_FIXTURE_EVENTS_FILE: effects }),
		},
	});
	const call = async (source: string) => {
		script = source;
		return toolResultText((await fixture.submit("use the MCP server")).toolResults.at(-1));
	};
	assert.match(await call("return await tools.mcp__stateful__list_topics({});"), /count 1/u);
	await processes.started.waitForCount(1);
	const [stateful] = processes.started;
	assert.match(await call('return await describeNamespace("mutable");'), /mcp__mutable__list_topics/u);
	await processes.started.waitForCount(2);
	const mutable = processes.started[1];
	await processes.exited.waitFor((items) => items.includes(mutable), 15000);
	assert.equal(processes.live.has(stateful), true, "used server survives the discovery idle interval");
	writeFileSync(change, "new schema");
	assert.match(await call("return await tools.mcp__mutable__list_topics({});"), /changed; discover it again/u);
	assert.doesNotMatch(readFileSync(mutableEvents, "utf8"), /^call /mu, "the stale call never reached the server");
	assert.match(await call('return await tools.mcp__mutable__list_topics({"category":"main"});'), /called list-topics/u);
	assert.match(await call("return await tools.mcp__lost__list_topics({});"), /closed|disconnected|exited/iu);
	const lost = readFileSync(effects, "utf8");
	assert.equal(lost.match(/^started /gmu)?.length, 1);
	assert.equal(lost.match(/^call /gmu)?.length, 1);
	assert.match(await call("return await tools.mcp__stateful__list_topics({});"), /count 2/u);
});
