/**
 * testdata/mcp-server: durable test fixture. A stdio MCP server that speaks
 * newline-delimited JSON-RPC and exits when its stdin closes.
 *
 * MCP_FIXTURE_EVENTS_PORT names a loopback TCP port. When set, the server
 * connects to it and writes one line per event ("started <pid>", "initialize"),
 * so a test observes start, handshake, and exit through socket events instead
 * of polling. The kernel closes the socket when the process exits.
 *
 * MCP_FIXTURE_EVENTS_FILE records the same events in a fixture-owned file for startup checks.
 *
 * MCP_FIXTURE_MODE=silent reads every request and never answers. Any other
 * value answers `initialize` (with instructions), `tools/list`, and `tools/call`.
 *
 * The tool list holds two names that differ only by `-` versus `_`, so they
 * collide after normalization, and one name that does not.
 */

import { appendFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";

const silent = process.env.MCP_FIXTURE_MODE === "silent";
const port = Number(process.env.MCP_FIXTURE_EVENTS_PORT);
const events = Number.isInteger(port) && port > 0 ? connect(port, "127.0.0.1") : undefined;
events?.on("error", () => undefined);
const eventsFile = process.env.MCP_FIXTURE_EVENTS_FILE;
const report = (line: string) => {
	events?.write(`${line}\n`);
	if (eventsFile !== undefined) appendFileSync(eventsFile, `${line}\n`);
};
report(`started ${process.pid}`);

const send = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const emptyInput = { type: "object", properties: {} };
const tools = [
	{ name: "lookup-doc", description: "Look up one documentation topic", inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } },
	{ name: "lookup_doc", description: "Second tool whose name differs only by - and _", inputSchema: emptyInput },
	{ name: "list-topics", description: "List documentation topics", inputSchema: emptyInput },
];

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	if (!line.trim()) return;
	const request = JSON.parse(line) as { id?: number; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } };
	if (request.method === "initialize") report("initialize");
	if (silent) return;
	if (request.method === "initialize") {
		send({ id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "dev-docs-fixture", version: "1.0.0" }, instructions: "Documentation fixture server. Use lookup-doc with a topic string." } });
	} else if (request.method === "tools/list") {
		send({ id: request.id, result: { tools } });
	} else if (request.method === "tools/call") {
		send({ id: request.id, result: { content: [{ type: "text", text: `called ${request.params?.name} ${JSON.stringify(request.params?.arguments ?? {})}` }] } });
	} else if (request.id !== undefined) {
		send({ id: request.id, error: { code: -32601, message: "method not found" } });
	}
});
input.on("close", () => process.exit(0));
