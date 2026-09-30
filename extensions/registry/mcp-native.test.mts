/**
 * Runs `registry` inside an ordinary Pi session that loads Pi's public MCP and
 * codemode factories and connects to a dependency-free stdio MCP server, so the
 * `ToolInfo` records under test are the ones Pi itself produces.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type McpExtensionOptions,
} from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import registerRegistry from "./index.ts";
import { RegistryOutputSchema } from "./output.ts";

const SERVER_NAME = "dev-docs";
const NAMESPACE = "mcp__dev_docs";
const SENTENCE = "Use lookup-doc with a topic string.";
const RESULT_BOUND_BYTES = 50 * 1024;

// Newline-delimited JSON-RPC over stdio; answers only what the MCP extension asks at connect time.
const SERVER_SOURCE = `
import { createInterface } from "node:readline";
const instructions = "Docs server. " + ${JSON.stringify(`${SENTENCE} `)}.repeat(Number(process.argv[2]));
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const tool = (name, description) => ({ name, description, inputSchema: { type: "object", properties: {} } });
const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
	if (!line.trim()) return;
	const request = JSON.parse(line);
	if (request.method === "initialize") {
		send({ id: request.id, result: { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} },
			serverInfo: { name: "dev-docs-fixture", version: "1.0.0" }, instructions } });
	} else if (request.method === "tools/list") {
		send({ id: request.id, result: { tools: [tool("lookup-doc", "Look up one documentation topic"),
			tool("list-topics", "List documentation topics"), tool("search-docs", "Search documentation text")] } });
	} else if (request.id !== undefined) {
		send({ id: request.id, error: { code: -32601, message: "method not found" } });
	}
});
`;

function toolResult(messages: readonly { role: string }[], id: string): ToolResultMessage {
	const found = messages.find((message): message is ToolResultMessage => message.role === "toolResult" && (message as ToolResultMessage).toolCallId === id);
	assert.ok(found, `missing tool result ${id}`);
	return found;
}

function textOf(result: ToolResultMessage): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function envelopeBytes(result: ToolResultMessage): number {
	return Buffer.byteLength(JSON.stringify({ content: result.content, details: result.details }));
}

function assertBounded(result: ToolResultMessage) {
	assert.equal(result.isError, false, textOf(result));
	assert.ok(Check(RegistryOutputSchema, result.details), JSON.stringify([...Errors(RegistryOutputSchema, result.details)]));
	assert.ok(!JSON.stringify(result).includes(SENTENCE), "the server instructions reached the registry result");
	assert.equal((result.details as { pageBlocked?: boolean }).pageBlocked, undefined);
}

/** One session against a server whose instructions repeat a sentence `repeat` times. */
async function observe(repeat: number): Promise<{ instructionsLength: number; listBytes: number; detailBytes: number }> {
	const root = await mkdtemp(join(tmpdir(), "registry-mcp-native-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = join(root, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
	try {
		const serverPath = join(root, "server.mjs");
		await writeFile(serverPath, SERVER_SOURCE);
		const loadConfig: NonNullable<McpExtensionOptions["loadConfig"]> = () => ({
			servers: [{ name: SERVER_NAME, source: "test", scope: "global",
				config: { command: process.execPath, args: [serverPath, String(repeat)], description: "Search the product docs" } }],
			errors: [],
		});
		const faux = fauxProvider({ provider: "registry-mcp-test", models: [{ id: "reader", contextWindow: 100000 }], tokensPerSecond: 0 });
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const errors: string[] = [];
		runtime = await createAgentSessionRuntime(async ({ cwd, agentDir: dir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd, agentDir: dir, modelRuntime,
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
				resourceLoaderOptions: {
					noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
					extensionFactories: [
						registerRegistry,
						createCodemodeExtension({ models: false }),
						createMcpExtension({ loadConfig, logPath: join(root, "mcp.log") }),
					],
				},
			});
			assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel(), thinkingLevel: "off" })),
				services, diagnostics: services.diagnostics,
			};
		}, { cwd: root, agentDir, sessionManager: SessionManager.inMemory(root) });
		const session = runtime.session;
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
		// The command handler awaits every startup connection, so the tools are registered afterwards.
		await session.prompt("/mcp");
		const mcpTools = session.getAllTools().filter((tool) => tool.name.startsWith("mcp__"));
		assert.equal(mcpTools.length, 3);
		const nativeInstructions = mcpTools[0].namespace?.instructions;
		assert.ok(nativeInstructions !== undefined, "Pi supplies the server instructions on the tool");
		assert.ok(nativeInstructions.includes(SENTENCE));

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("registry", { kind: "tool", search: "mcp__dev", match: "substring" }, { id: "list" })]),
			fauxAssistantMessage("Listed."),
		]);
		await session.prompt("Find the dev-docs tools.");
		const list = toolResult(session.messages, "list");
		assertBounded(list);
		const listed = list.details as { records: Array<{ name: string; namespace?: unknown }> };
		assert.deepEqual(listed.records.map((record) => record.name), [`${NAMESPACE}__list_topics`, `${NAMESPACE}__lookup_doc`, `${NAMESPACE}__search_docs`]);
		for (const record of listed.records) {
			assert.deepEqual(record.namespace, { name: NAMESPACE, description: "Search the product docs", instructionsOmitted: true });
		}
		assert.match(textOf(list), /describeNamespace\(name\)/);

		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("registry", { kind: "tool", name: `${NAMESPACE}__lookup_doc`, detail: true }, { id: "detail" }),
				fauxToolCall("codemode", { code: `const ns = await describeNamespace(${JSON.stringify(SERVER_NAME)}); return { instructions: ns.instructions.length, tools: ns.tools.length };` }, { id: "describe" }),
			]),
			fauxAssistantMessage("Described."),
		]);
		await session.prompt("Read the lookup-doc tool and the server guidance.");
		const detail = toolResult(session.messages, "detail");
		assertBounded(detail);
		assert.equal((detail.details as { records: unknown[] }).records.length, 1);

		// The guidance the records point to is readable where they say it is.
		const described = toolResult(session.messages, "describe");
		assert.equal(described.isError, false, textOf(described));
		assert.match(textOf(described), new RegExp(`"instructions":\\s*${nativeInstructions.length}`));
		assert.deepEqual(errors, []);
		return { instructionsLength: nativeInstructions.length, listBytes: envelopeBytes(list), detailBytes: envelopeBytes(detail) };
	} finally {
		try { await runtime?.dispose(); }
		finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(root, { recursive: true, force: true });
		}
	}
}

test("registry lists a real MCP server's tools without its instructions, whatever their length", { timeout: 120000 }, async () => {
	const short = await observe(40);
	const long = await observe(2000);
	assert.ok(short.instructionsLength < 4 * 1024);
	assert.ok(long.instructionsLength > RESULT_BOUND_BYTES);
	assert.equal(long.listBytes, short.listBytes);
	assert.equal(long.detailBytes, short.detailBytes);
	assert.ok(long.listBytes < 16 * 1024);
});
