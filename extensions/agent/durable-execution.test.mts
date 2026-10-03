import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createDurableExecution, checkClassifierContext, checkImagesContext, loadMcpConfig } from "./durable-execution.ts";
import { reconcileDeliveries } from "./durable-controls.ts";
import { answerRuntime, CRASH_STORAGE_ID, declaredTool, declaredTools, executionFixture, fixtureModelId, fixtureProvider, fixtureServerPath, httpMcpServer, messageText, resourceListStream, toolResultBody, toolResultText, toolSearchStream, writeExecutionExtension } from "./durable-execution-fixture.mts";
import { createDurableServices } from "./durable-services.ts";
import { DurableHost } from "./durable-host.ts";

const fixturePath = fileURLToPath(new URL("./durable-execution-fixture.mts", import.meta.url));
const READY = Buffer.from("READY\n");

/** Byte bound for captured child output; oldest bytes drop first. */
const CAPTURE_LIMIT = 64 * 1024;

function appendBounded(buffer: Buffer, chunk: Buffer): Buffer {
	const next = Buffer.concat([buffer, chunk]);
	return next.length > CAPTURE_LIMIT ? next.subarray(next.length - CAPTURE_LIMIT) : next;
}

/** Resolve with the captured output once the child prints its readiness line. */
function readyFrom(child: ReturnType<typeof spawn>, timeoutMs = 20000): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout: Buffer = Buffer.alloc(0);
		let stderr: Buffer = Buffer.alloc(0);
		let settled = false;
		const detail = (message: string) => `${message}\nstdout=${stdout.toString("utf8")}\nstderr=${stderr.toString("utf8")}`;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(detail("fixture did not reach readiness")));
		}, timeoutMs);
		const onStdout = (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk);
			if (settled || !stdout.includes(READY)) return;
			settled = true;
			clearTimeout(timer);
			resolve(stdout.toString("utf8"));
		};
		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk);
		});
		child.once("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(detail(`fixture exited before readiness: ${String(code)}`)));
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
	});
}

/** A promise that settles once the child has already exited or does so next. */
function childDeath(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

it("blocks a nested codemode call through the ToolTask hooks and never executes it", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `try {
			const out = await tools.guarded({ marker: "blocked" });
			return { out };
		} catch (error) {
			return { error: String(error.message ?? error) };
		}`,
	});
	const guardedPath = join(f.root, "guarded.txt");
	(globalThis as Record<string, unknown>).__execFixture = { guardedPath };
	try {
		const result = await f.submit("call the guarded tool");
		const text = result.toolResults.map(toolResultText).join("\n");
		assert.match(text, /Tool call blocked: denied by policy/u);
		assert.equal(existsSync(guardedPath), false, "the policy hook prevented the tool from running");
	} finally {
		delete (globalThis as Record<string, unknown>).__execFixture;
	}
});

it("hands a structured result to the script through details.structuredContent", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `const value = await tools.structured({});\nreturn value;` });
	const result = await f.submit("call the structured tool");
	const text = result.toolResults.map(toolResultText).join("\n");
	assert.match(text, /"answer":"42"/u);
});

it("applies an afterTool ToolTask hook to a nested codemode result", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `const value = await tools.structured({});\nreturn value;` });
	(globalThis as Record<string, unknown>).__execFixture = { rewriteStructured: true };
	try {
		const result = await f.submit("call the structured tool");
		const text = toolResultBody(result.toolResults.at(-1));
		assert.match(text, /"answer":"rewritten"/u);
		assert.doesNotMatch(text, /"answer":"42"/u);
	} finally {
		delete (globalThis as Record<string, unknown>).__execFixture;
	}
});

it("reaches a stdio MCP server from codemode with normalized names and structured results", { timeout: 60000 }, async (t) => {
	const code = `const info = await describeNamespace("dev-docs");
		const listed = await tools.mcp__dev_docs__list_topics({});
		const routed = {};
		for (const name of info.tools.filter((tool) => tool.startsWith("mcp__dev_docs__lookup_doc"))) {
			routed[name] = (await tools[name]({ topic: "x" })).content[0].text;
		}
		return { info, listed: listed.content[0].text, result: listed, routed };`;
	const f = await executionFixture(t, {
		code,
		mcpServers: {
			"dev-docs": {
				command: process.execPath,
				args: [fixtureServerPath],
				description: "Search the product docs",
				env: { MCP_FIXTURE_MODE: "respond" },
			},
		},
	});
	const result = await f.submit("look up the docs");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as {
		info: { name: string; description: string; instructions: string; tools: string[] };
		listed: string;
		result: { content: { type: string; text: string }[]; isError?: boolean };
		routed: Record<string, string>;
	};
	assert.equal(output.info.name, "mcp__dev_docs");
	assert.equal(output.info.description, "Search the product docs");
	assert.equal(output.info.instructions, "Documentation fixture server. Use lookup-doc with a topic string.");
	assert.equal(output.listed, "called list-topics {}", "the call reached the server process");
	assert.equal(output.result.content[0]?.text, "called list-topics {}", "the script received the CallToolResult");
	const colliding = Object.keys(output.routed);
	assert.equal(colliding.length, 2, "both tools that normalize to one name stay reachable");
	for (const name of colliding) assert.match(name, /^mcp__dev_docs__lookup_doc_\w+$/u, "colliding names carry a suffix");
	assert.deepEqual(Object.values(output.routed).sort(), ['called lookup-doc {"topic":"x"}', 'called lookup_doc {"topic":"x"}']);
	assert.ok(declaredTools(f.requests[0]).includes("codemode"), "the configured server activates codemode");
	assert.deepEqual(declaredTools(f.requests[0]).filter((name) => name.startsWith("mcp__")), [], "server tools stay out of the model's declarations");
});

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** One named prompt section of the request's system message. */
function systemSection(request: { messages: readonly { role?: string; content?: unknown; sections?: unknown }[] }, name: string): string | undefined {
	const system = request.messages.find((message) => message.role === "system");
	const sections = system?.sections;
	if (sections === null || typeof sections !== "object") return undefined;
	return (sections as Record<string, string>)[name];
}

it("activates tool_search for a deferred server and loads matching tools for the next request", { timeout: 60000 }, async (t) => {
	const f = await executionFixture(t, {
		settings: { defaultTools: [] },
		mcpServers: {
			"dev-docs": {
				command: process.execPath,
				args: [fixtureServerPath],
				description: "Search the product docs",
				env: { MCP_FIXTURE_MODE: "respond" },
				exposure: "deferred",
			},
		},
		stream: toolSearchStream("list topics"),
	});
	const result = await f.submit("find the docs tools");
	assert.match(toolResultText(result.toolResults[0]), /mcp__dev_docs__list_topics/u);
	assert.ok(declaredTools(f.requests[0]).includes("tool_search"), "the deferred server activates tool_search");
	assert.ok(!declaredTools(f.requests[0]).includes("codemode"), "codemode stays inactive without codemode exposure or settings");
	assert.match(systemSection(f.requests[0], "mcp_servers") ?? "", /^- mcp__dev_docs \(tool_search\): Search the product docs$/mu);
	assert.ok(declaredTools(f.requests[1]).includes("mcp__dev_docs__list_topics"), "the loaded tool is declared on the next request");
});

it("hides direct tool declarations in codemode only mode while scripts still reach them", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `const value = await tools.structured({});\nreturn value;`,
		settings: { defaultTools: ["+codemode", "+tool_search"], codemode: { mode: "only" } },
	});
	const result = await f.submit("call the structured tool");
	assert.match(toolResultBody(result.toolResults.at(-1)), /"answer":"42"/u);
	assert.deepEqual(declaredTools(f.requests[0]).sort(), ["codemode", "tool_search"]);
	const description = declaredTool(f.requests[0], "codemode")?.description ?? "";
	assert.match(description, /### `structured`/u);
	assert.match(description, /### `read`/u);
});

it("sends stored OAuth tokens to an HTTP server and reads its resources", { timeout: 60000 }, async (t) => {
	const token = `token-${randomUUID()}`;
	const server = await httpMcpServer(token);
	t.after(() => server.close());
	const f = await executionFixture(t, {
		code: `const tool = await tools.mcp__remote_docs__echo({ value: "hi" });
			const listed = await tools.list_mcp_resources({});
			const read = await tools.read_mcp_resource({ server: "remote-docs", uri: "docs://readme" });
			return { tool, listed, read };`,
		mcpServers: { "remote-docs": { url: server.url, description: "Remote docs" } },
		mcpAuth: { [`mcp__remote_docs|${server.url}`]: { serverUrl: server.url, tokens: { access_token: token, token_type: "Bearer" } } },
	});
	const result = await f.submit("call the remote server");
	const body = toolResultBody(result.toolResults.at(-1));
	assert.ok(body.startsWith("{"), body);
	const output = JSON.parse(body) as {
		tool: { content: { text: string }[] };
		listed: { resources: { server: string; uri: string }[] };
		read: { contents: { uri: string; text: string }[] };
	};
	assert.equal(output.tool.content[0]?.text, "echo hi");
	assert.equal(output.listed.resources[0]?.server, "remote-docs");
	assert.equal(output.listed.resources[0]?.uri, "docs://readme");
	assert.equal(output.read.contents[0]?.text, "hello resource");
});

it("validates model contexts against the public contract", () => {
	assert.throws(() => checkClassifierContext({ state: {}, questions: {} }), /context\.questions/u);
	assert.throws(() => checkClassifierContext({ state: {}, questions: { q: { type: "choice", instructions: "x", criteria: "nope" } } }), /criteria/u);
	assert.throws(() => checkImagesContext({ prompt: "x" }), /context\.input/u);
	assert.throws(() => checkImagesContext({ input: [{ type: "image", data: 1 }] }), /context\.input\[0\]/u);
});

it("rejects invalid model arguments with the public contract's error text", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `try { await models.classify({}, {}); return "no error"; } catch (error) { return String(error.message ?? error); }` });
	const result = await f.submit("call classify badly");
	assert.match(toolResultBody(result.toolResults.at(-1)), /needs a classifier model/u);
});

it("declares direct resource tools and serves a model-issued resource listing", { timeout: 60000 }, async (t) => {
	const token = `token-${randomUUID()}`;
	const server = await httpMcpServer(token);
	t.after(() => server.close());
	const f = await executionFixture(t, {
		stream: resourceListStream(),
		mcpServers: { "remote-docs": { url: server.url, description: "Remote docs", exposure: "direct" } },
		mcpAuth: { [`mcp__remote_docs|${server.url}`]: { serverUrl: server.url, tokens: { access_token: token, token_type: "Bearer" } } },
	});
	assert.ok(f.services.registry.snapshot().tools().some(({ tool }) => tool.name === "list_mcp_resources"), "fixture installation completes direct resource registration");
	const result = await f.submit("list the resources");
	assert.ok(declaredTools(f.requests[0]).includes("list_mcp_resources"));
	assert.match(toolResultText(result.toolResults.at(-1)), /docs:\/\/readme/u);
});

it("keeps fixture registration pending until the server supplies its tools", { timeout: 30000 }, async (t) => {
	const token = `token-${randomUUID()}`;
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const server = await httpMcpServer(token, { beforeResponse: async (method) => {
		if (method === "tools/list") { entered.resolve(); await release.promise; }
	} });
	t.after(() => server.close());
	let registered = false;
	const completion = executionFixture(t, {
		mcpServers: { "held-docs": { url: server.url, exposure: "direct" } },
		mcpAuth: { [`mcp__held_docs|${server.url}`]: { serverUrl: server.url, tokens: { access_token: token, token_type: "Bearer" } } },
	}).then((fixture) => { registered = true; return fixture; });
	await entered.promise;
	assert.equal(registered, false, "the server still holds its tool list");
	release.resolve();
	const f = await completion;
	assert.equal(registered, true);
	assert.ok(f.services.registry.snapshot().tools().some(({ tool }) => tool.name === "mcp__held_docs__echo"));
});

it("rejects auth in a trusted project's mcp.json", () => {
	const root = mkdtempSync(join(tmpdir(), "durable-execution-auth-"));
	try {
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp", auth: { provider: "example" } } } }));
		const config = loadMcpConfig({ agentDir: join(root, "agent"), cwd: root, projectTrusted: true });
		assert.equal(config.servers.length, 0);
		assert.match(config.errors.join("\n"), /auth is only allowed in the global mcp.json/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("bounds ready for a direct server that never answers", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `return "ok";`,
		readyTimeoutMs: 150,
		awaitReady: true,
		mcpServers: { "silent-docs": { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_MODE: "silent" }, exposure: "direct" } },
	});
	assert.ok(f.readyElapsedMs !== undefined && f.readyElapsedMs < 5000, `ready took ${String(f.readyElapsedMs)}ms`);
	const result = await f.submit("say hi");
	assert.equal(result.answer, "durable answer");
});

it("waits for a late direct server before the first request", { timeout: 30000 }, async (t) => {
	const token = `token-${randomUUID()}`;
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const server = await httpMcpServer(token, { beforeResponse: async (method) => {
		if (method === "tools/list") { entered.resolve(); await release.promise; }
	} });
	t.after(() => server.close());
	let ready = false;
	const completion = executionFixture(t, {
		code: `const out = await tools.mcp__remote_docs__echo({ value: "ready" });\nreturn out.content[0].text;`,
		readyTimeoutMs: 5000,
		awaitReady: true,
		mcpServers: { "remote-docs": { url: server.url, description: "Remote docs", exposure: "direct" } },
		mcpAuth: { [`mcp__remote_docs|${server.url}`]: { serverUrl: server.url, tokens: { access_token: token, token_type: "Bearer" } } },
	}).then((fixture) => { ready = true; return fixture; });
	await entered.promise;
	assert.equal(ready, false, "the server still holds registration before the first model request");
	release.resolve();
	const f = await completion;
	assert.ok(f.readyElapsedMs !== undefined && f.readyElapsedMs < 5000, `ready took ${String(f.readyElapsedMs)}ms`);
	const result = await f.submit("use the late server");
	assert.ok(declaredTools(f.requests[0]).includes("mcp__remote_docs__echo"));
	assert.match(toolResultBody(result.toolResults.at(-1)), /echo ready/u);
});

it("does not wait for an indirect server that never answers", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `return "ok";`,
		readyTimeoutMs: 10000,
		awaitReady: true,
		mcpServers: { "silent-docs": { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_MODE: "silent" }, exposure: "codemode" } },
	});
	assert.ok(f.readyElapsedMs !== undefined && f.readyElapsedMs < 1000, `ready took ${String(f.readyElapsedMs)}ms`);
	const result = await f.submit("say hi");
	assert.equal(result.answer, "durable answer");
});

it("aborts an owned nested call with the conversation and reaches idle", { timeout: 30000 }, async (t) => {	const entered = deferred();
	const f = await executionFixture(t, { code: `try { await tools.hanging({}); return "ok"; } catch (error) { return { error: String(error.message ?? error) }; }` });
	(globalThis as Record<string, unknown>).__execFixture = { onEnter: () => entered.resolve(), aborted: false };
	try {
		const submission = await f.conversation.submit({ type: "input", content: "hang the tool" }, BACKGROUND_CONTEXT);
		await entered.promise;
		await f.conversation.abort(BACKGROUND_CONTEXT);
		await f.conversation.waitForIdle(BACKGROUND_CONTEXT);
		await submission.wait(BACKGROUND_CONTEXT);
		const view = await f.conversation.context(BACKGROUND_CONTEXT);
		const toolResults = view.messages.filter((message) => message.role === "toolResult");
		assert.ok(toolResults.length >= 1, "the codemode call retained a result");
		assert.ok(toolResults.some((result) => messageText(result).length > 0), "the result reports the aborted call");
		const inspection = await f.harness.inspect(BACKGROUND_CONTEXT);
		assert.equal(inspection.tasks.length, 0, "the owned nested task settled with its owner");
		const fixtureState = (globalThis as Record<string, unknown>).__execFixture as { aborted?: boolean };
		assert.equal(fixtureState.aborted, true, "the nested tool observed its cancellation");
	} finally {
		delete (globalThis as Record<string, unknown>).__execFixture;
	}
});

it("does not repeat an interrupted unsafe nested call after a crash", { timeout: 60000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "durable-execution-crash-"));
	const storagePath = join(root, "run.sqlite");
	const effectPath = join(root, "effect.txt");
	const rerunPath = join(root, "rerun.txt");
	const runId = "crash-unsafe-nested";
	const child = spawn(process.execPath, [fixturePath, storagePath, runId, "do the task"], { stdio: ["ignore", "pipe", "pipe"] });
	let services: Awaited<ReturnType<typeof createDurableServices>> | undefined;
	let host: DurableHost | undefined;
	try {
		await readyFrom(child);
		const death = childDeath(child);
		child.kill("SIGKILL");
		await death;
		const extensionPath = writeExecutionExtension(join(root, "parent-extension"));
		(globalThis as Record<string, unknown>).__execFixture = { rerunPath, hang: false };
		const runtime = await answerRuntime();
		services = await createDurableServices({
			cwd: root,
			agentDir: join(root, "agent"),
			storageId: CRASH_STORAGE_ID,
			extensionPaths: [extensionPath],
			trusted: true,
			buildBuiltin: createDurableExecution,
			modelRuntime: runtime,
		});
		host = await DurableHost.open({
			storagePath,
			storageId: CRASH_STORAGE_ID,
			cwd: root,
			models: runtime,
			registry: services.registry,
			settings: services.settings,
			env: services.env,
			agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } },
			resume: false,
		});
		await services.install(host.harness);
		host.harness.resume();
		await reconcileDeliveries(host.harness, BACKGROUND_CONTEXT);
		const submission = await host.submit({ message: "do the task", requestId: runId });
		const outcome = await host.wait(submission.submissionId);
		assert.equal(outcome.status, "done");
		assert.equal(outcome.answer, "durable answer");
		assert.equal(readFileSync(effectPath, "utf8").trim().split("\n").length, 1, "the unsafe effect ran exactly once");
		assert.equal(existsSync(rerunPath), false, "the interrupted nested call did not rerun");
		const transcript = await host.transcript();
		assert.match(transcript, /interrupted/iu);
	} finally {
		if (host) await host.close().catch(() => undefined);
		if (services) await services.close().catch(() => undefined);
		if (child.exitCode === null && child.signalCode === null) {
			const death = childDeath(child);
			child.kill("SIGKILL");
			await death;
		}
		delete (globalThis as Record<string, unknown>).__execFixture;
		rmSync(root, { recursive: true, force: true });
	}
});
