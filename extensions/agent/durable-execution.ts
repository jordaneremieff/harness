/** Native code mode and tool search with configured MCP transports and resource tools. */
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord";
import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import { CodemodeSandbox, parseCodemodeSource } from "@earendil-works/pi-codemode";
import { createCodemodeExtension, createCodemodeTool, type CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import type { AuthProvider, CallToolResult, ContentBlock, ListResourcesResult, ReadResourceResult, Resource, ResourceTemplate, Tool as McpTool } from "@earendil-works/pi-mcp";
import { JSON_RPC_ERROR_CODES, McpClient, McpError, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import type { McpOAuthState, McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { adaptOAuthProvider, McpOAuthAuthorizationRequiredError, McpOAuthProvider } from "@earendil-works/pi-mcp/oauth";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type * as Durable from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import { QueuedCodemodeSandbox } from "./codemode-admission.ts";

// ─── Public contract ────────────────────────────────────────────────────────

/** The host object the services bootstrap passes to `createDurableExecution`. */
export interface DurableExecutionHost {
	/** The host's pi-durable module. Every runtime value comes from here. */
	readonly durable: typeof Durable;
	/** Pi's cwd-bound services: settings, model access, and the host diagnostics. Read-only use. */
	readonly services: Pick<AgentSessionServices, "settingsManager" | "modelRuntime" | "diagnostics">;
	readonly cwd: string;
	readonly agentDir: string;
	readonly storageId: string;
	/** Resolve the live catalog after asynchronous MCP discovery. */
	readonly harness: Durable.Harness;
	/** Aborted when the host shuts down. */
	readonly signal: AbortSignal;
	readonly inventory: unknown;
}

/** Native extensions to install plus the cleanup for everything they keep alive. */
export interface DurableExecution {
	readonly extensions: readonly Durable.Extension[];
	/**
	 * Settles when the initially configured servers with direct exposure connected or failed, or
	 * after `readyTimeoutMs`. Servers with only indirect exposure are not awaited, and a late server
	 * still registers when it connects.
	 */
	readonly ready: Promise<void>;
	close(): Promise<void>;
}

/** Options of `createDurableExecution`. */
export interface DurableExecutionOptions {
	/** Deadline for `ready`; default 10000 ms, the ordinary first-prompt wait for direct servers. */
	readonly readyTimeoutMs?: number;
}

const EXTENSION_NAME = "pi.durable-execution";
const CODEMODE_TOOL_NAME = "codemode";
const TOOL_SEARCH_TOOL_NAME = "tool_search";
const MCP_SERVERS_SECTION = "mcp_servers";
const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const CODEMODE_WORKER_WAIT_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SERVERS_SECTION_CHARS = 4096;
const MAX_SERVER_DESCRIPTION_CHARS = 250;
const MAX_TOOL_NAME_LENGTH = 64;

type NestedTool = Durable.ToolRegistration;

type ToolResultContent = readonly (TextContent | ImageContent)[];


// ─── MCP configuration ──────────────────────────────────────────────────────

export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

export interface McpServerConfig {
	readonly type?: "stdio" | "http" | "streamable-http";
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly enabled?: boolean;
	readonly exposure?: McpExposure;
	readonly toolExposure?: Readonly<Record<string, McpExposure>>;
	readonly timeout?: number;
	readonly description?: string;
	/** Send the token of a configured Pi login provider. Global config only. */
	readonly auth?: { readonly provider: string };
	readonly oauth?: {
		readonly clientId?: string;
		readonly clientSecret?: string;
		readonly callbackPort?: number;
		readonly callbackUrl?: string;
		readonly scope?: string;
		readonly clientName?: string;
		readonly authServerMetadataUrl?: string;
	};
}

export interface McpServerEntry {
	readonly name: string;
	readonly config: McpServerConfig;
	/** File that defined the connection and authentication. */
	readonly source: string;
	/** Trusted project file that overrides tool selection, without replacing the connection. */
	readonly override?: string;
}

export interface LoadedMcpConfig {
	readonly servers: readonly McpServerEntry[];
	readonly autoEnableCodemode?: boolean;
	readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isExposure(value: unknown): value is McpExposure {
	return value === "codemode" || value === "deferred" || value === "direct" || value === "hidden" || value === "codemode-deferred";
}

/** Validate one `mcpServers` entry, returning a copy or an error message. */
function validateServerConfig(name: string, raw: unknown, scope: "global" | "project"): McpServerConfig | string {
	if (!SERVER_NAME_PATTERN.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const value: Record<string, unknown> = { ...raw };
	if (value.exposure === "codemode-deferred") value.exposure = "codemode";
	if (value.toolExposure !== undefined) {
		if (!isRecord(value.toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		value.toolExposure = Object.fromEntries(Object.entries(value.toolExposure).map(([tool, exposure]) => [tool, exposure === "codemode-deferred" ? "codemode" : exposure]));
	}
	const structural = validateServerShape(name, value);
	if (typeof structural === "string") return structural;
	const auth = validateAuthFields(name, value, scope);
	if (typeof auth === "string") return auth;
	return value as unknown as McpServerConfig;
}

function validateAuthFields(name: string, value: Record<string, unknown>, scope: "global" | "project"): true | string {
	const auth = value.auth;
	if (auth !== undefined) {
		if (scope === "project") return `server "${name}": auth is only allowed in the global mcp.json`;
		if (!isRecord(auth) || typeof auth.provider !== "string" || auth.provider === "") return `server "${name}": auth.provider must be a provider name`;
	}
	const oauth = value.oauth;
	if (oauth === undefined) return true;
	if (!isRecord(oauth)) return `server "${name}": oauth must be an object`;
	return validateOAuthFields(name, oauth);
}

function validateOAuthFields(name: string, oauth: Record<string, unknown>): true | string {
	for (const key of ["clientId", "clientSecret", "scope", "clientName"] as const) {
		if (oauth[key] !== undefined && typeof oauth[key] !== "string") return `server "${name}": oauth.${key} must be a string`;
	}
	const port = oauth.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		return `server "${name}": oauth.callbackPort must be a port number`;
	}
	if (oauth.callbackUrl !== undefined && (typeof oauth.callbackUrl !== "string" || !isLoopbackUrl(oauth.callbackUrl, false))) {
		return `server "${name}": oauth.callbackUrl must be an http loopback URL`;
	}
	if (oauth.authServerMetadataUrl !== undefined && (typeof oauth.authServerMetadataUrl !== "string" || !isLoopbackUrl(oauth.authServerMetadataUrl, true))) {
		return `server "${name}": oauth.authServerMetadataUrl must be an https URL, or http on loopback`;
	}
	return true;
}

function isLoopbackUrl(value: string, allowHttps: boolean): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	if (url.protocol === "https:") return allowHttps;
	if (url.protocol !== "http:") return false;
	return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function validateServerShape(name: string, value: Record<string, unknown>): true | string {
	const common = validateCommonFields(name, value);
	if (typeof common === "string") return common;
	const http = validateHttpFields(name, value);
	if (http !== undefined) return http;
	const stdio = validateStdioFields(name, value);
	if (stdio !== undefined) return stdio;
	return `server "${name}": set "command" for a stdio server or "url" for an HTTP server`;
}

function validateCommonFields(name: string, value: Record<string, unknown>): true | string {
	if (value.exposure !== undefined && !isExposure(value.exposure)) return `server "${name}": invalid exposure`;
	if (isRecord(value.toolExposure) && !Object.values(value.toolExposure).every((entry) => isExposure(entry))) {
		return `server "${name}": invalid toolExposure`;
	}
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (value.description !== undefined && typeof value.description !== "string") return `server "${name}": description must be a string`;
	if (value.timeout !== undefined && (typeof value.timeout !== "number" || !(value.timeout > 0))) return `server "${name}": timeout must be positive seconds`;
	if (value.type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
	return true;
}

/** True or an error when the entry selects HTTP; undefined when it does not. */
function validateHttpFields(name: string, value: Record<string, unknown>): true | string | undefined {
	if (typeof value.url !== "string" || (value.type !== undefined && value.type !== "http" && value.type !== "streamable-http")) return undefined;
	if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) return `server "${name}": url must be an http or https URL`;
	if (value.headers !== undefined && !isStringRecord(value.headers)) return `server "${name}": headers must map names to strings`;
	return true;
}

/** True or an error when the entry selects stdio; undefined when it does not. */
function validateStdioFields(name: string, value: Record<string, unknown>): true | string | undefined {
	if (typeof value.command !== "string" || (value.type !== undefined && value.type !== "stdio")) return undefined;
	if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))) {
		return `server "${name}": args must be an array of strings`;
	}
	if (value.env !== undefined && !isStringRecord(value.env)) return `server "${name}": env must map names to strings`;
	if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
	return true;
}

interface McpConfigState {
	readonly servers: Map<string, McpServerEntry>;
	readonly errors: string[];
	autoEnableCodemode?: boolean;
}

const PROJECT_MCP_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

function isMcpSelectionOverride(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && value.command === undefined && value.url === undefined && value.type === undefined;
}

function applyProjectMcpOverride(name: string, patch: Record<string, unknown>, path: string, state: McpConfigState): void {
	const base = state.servers.get(name);
	if (base === undefined) {
		state.errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
		return;
	}
	if (Object.keys(patch).some((key) => !PROJECT_MCP_OVERRIDE_KEYS.includes(key))) {
		state.errors.push(`${path}: server "${name}": an override can only set ${PROJECT_MCP_OVERRIDE_KEYS.join(", ")}`);
		return;
	}
	// The project changes only selection. Connection and provider auth keep their global authority.
	const config = validateServerConfig(name, { ...base.config, ...patch }, "global");
	if (typeof config === "string") state.errors.push(`${path}: ${config}`);
	else state.servers.set(name, { ...base, config, override: path });
}

function readMcpConfigServers(servers: Record<string, unknown>, path: string, scope: "global" | "project", state: McpConfigState): void {
	for (const [name, raw] of Object.entries(servers)) {
		if (scope === "project" && isMcpSelectionOverride(raw)) {
			applyProjectMcpOverride(name, raw, path, state);
			continue;
		}
		const config = validateServerConfig(name, raw, scope);
		if (typeof config === "string") {
			state.errors.push(`${path}: ${config}`);
			continue;
		}
		const clash = [...state.servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
		if (clash !== undefined) {
			state.errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		state.servers.set(name, { name, config, source: path });
	}
}

function readConfigFile(path: string, scope: "global" | "project", state: McpConfigState): void {
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
	} catch (error) {
		state.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		state.errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	if (typeof parsed.autoEnableCodemode === "boolean") state.autoEnableCodemode = parsed.autoEnableCodemode;
	else if (parsed.autoEnableCodemode !== undefined) state.errors.push(`${path}: autoEnableCodemode must be a boolean`);
	readMcpConfigServers(parsed.mcpServers ?? {}, path, scope, state);
}

/** Read the user `mcp.json` and, for a trusted project, the project `mcp.json`. */
export function loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig {
	const state: McpConfigState = { servers: new Map(), errors: [] };
	readConfigFile(join(options.agentDir, "mcp.json"), "global", state);
	if (options.projectTrusted) readConfigFile(join(options.cwd, ".pi", "mcp.json"), "project", state);
	return {
		servers: [...state.servers.values()],
		...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
		errors: state.errors,
	};
}

/** `mcp__<server>` with invalid characters replaced by `_`. */
function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** The effective exposure of one server tool, honoring exact overrides and then `*` patterns. */
export function getToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	const overrides = config.toolExposure;
	if (overrides !== undefined) {
		const exact = overrides[toolName];
		if (exact !== undefined) return exact;
		for (const [pattern, exposure] of Object.entries(overrides)) {
			if (pattern.includes("*") && wildcardMatch(pattern, toolName)) return exposure;
		}
	}
	return config.exposure ?? "codemode";
}

function wildcardMatch(pattern: string, value: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

/** Every exposure a configured server may hand out, including per-tool overrides. */
function configuredExposures(config: McpServerConfig): ReadonlySet<McpExposure> {
	const exposures = new Set<McpExposure>([config.exposure ?? "codemode"]);
	for (const exposure of Object.values(config.toolExposure ?? {})) exposures.add(exposure);
	return exposures;
}

/** Resolve `$NAME`/`${NAME}`, `$$` and `$!` escapes, or a leading `!command`. */
function resolveConfigValue(config: string, env: Record<string, string | undefined> = process.env): string | undefined {
	if (config.startsWith("!")) return resolveCommandValue(config);
	return resolveTemplateValue(config, env);
}

function resolveCommandValue(config: string): string | undefined {
	try {
		const output = execSync(config.slice(1), { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

function resolveTemplateValue(config: string, env: Record<string, string | undefined>): string | undefined {
	let resolved = "";
	let index = 0;
	while (index < config.length) {
		const dollar = config.indexOf("$", index);
		if (dollar < 0) return resolved + config.slice(index);
		resolved += config.slice(index, dollar);
		const step = templateStep(config, dollar, env);
		if (step === undefined) return undefined;
		resolved += step.text;
		index = step.next;
	}
	return resolved;
}

/** One `$...` reference: its replacement text and the index after it. */
function templateStep(config: string, dollar: number, env: Record<string, string | undefined>): { text: string; next: number } | undefined {
	const next = config[dollar + 1];
	if (next === "$" || next === "!") return { text: next, next: dollar + 2 };
	const braced = next === "{" ? /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(config.slice(dollar + 1)) : null;
	const bare = braced === null ? /^[A-Za-z_][A-Za-z0-9_]*/.exec(config.slice(dollar + 1)) : null;
	const name = braced?.[1] ?? bare?.[0];
	if (name === undefined) return { text: "$", next: dollar + 1 };
	const value = env[name] ?? process.env[name];
	if (value === undefined) return undefined;
	return { text: value, next: dollar + 1 + (braced === null ? name.length : braced[0].length) };
}

// ─── MCP tool names and results ─────────────────────────────────────────────

/** `mcp__<server>__<tool>`, sanitized; too-long or colliding names get a stable hash suffix. */
export function createMcpToolName(server: string, tool: string, isTaken: (name: string) => boolean = () => false): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** The `CallToolResult` output schema every MCP tool declares to scripts. */
function createMcpResultSchema(structuredContentSchema: CodemodeJsonSchema | undefined): CodemodeJsonSchema {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: { type: "object" } },
			structuredContent: structuredContentSchema ?? {},
			isError: { type: "boolean" },
			_meta: { type: "object" },
		},
		required: ["content"],
	};
}

function textOf(content: readonly { type?: string; text?: string }[] | undefined): string {
	return (content ?? []).flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
}

/** Model-facing text of an MCP result over the byte cap keeps its ends and spills the full text. */
async function limitMcpContent(content: ToolResultContent): Promise<{ content: ToolResultContent; fullOutputPath?: string }> {
	const combined = textOf(content);
	const bytes = Buffer.byteLength(combined, "utf8");
	if (bytes <= MCP_OUTPUT_MAX_BYTES) return { content };
	const text = middleTruncate(combined, MCP_OUTPUT_MAX_BYTES);
	let fullOutputPath: string | undefined;
	let where: string;
	try {
		fullOutputPath = await saveToTempFile(combined, ".txt");
		where = `[Complete output: ${fullOutputPath} (read it with offset/limit)]`;
	} catch (error) {
		where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	const tokens = Math.ceil(bytes / 4);
	return {
		content: [
			{
				type: "text",
				text: `Output was truncated (about ${tokens} tokens originally, ${combined.split("\n").length} lines):\n\n${text}\n\n${where}`,
			},
			...content.filter((block) => block.type === "image"),
		],
		...(fullOutputPath === undefined ? {} : { fullOutputPath }),
	};
}

/** Keep the start and end of `text` within `maxBytes`, with an omission marker in the middle. */
function middleTruncate(text: string, maxBytes: number): string {
	const half = Math.max(0, Math.floor(maxBytes / 2));
	const head = utf8Prefix(text, half);
	const tail = utf8Suffix(text, Math.max(0, maxBytes - Buffer.byteLength(head, "utf8")));
	const omitted = Buffer.byteLength(text, "utf8") - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
	return `${head}\n…${omitted} bytes truncated…\n${tail}`;
}

function utf8Prefix(text: string, maxBytes: number): string {
	let bytes = 0;
	for (let index = 0; index < text.length; index++) {
		bytes += Buffer.byteLength(text[index] ?? "", "utf8");
		if (bytes > maxBytes) return text.slice(0, index);
	}
	return text;
}

function utf8Suffix(text: string, maxBytes: number): string {
	let bytes = 0;
	for (let index = text.length - 1; index >= 0; index--) {
		bytes += Buffer.byteLength(text[index] ?? "", "utf8");
		if (bytes > maxBytes) return text.slice(index + 1);
	}
	return text;
}

async function saveToTempFile(data: string | Buffer, extension: string): Promise<string> {
	const path = join(tmpdir(), `pi-durable-execution-${randomBytes(8).toString("hex")}${extension}`);
	await writeFile(path, data, { mode: 0o600 });
	return path;
}

function extensionOf(uri: string): string {
	const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

function isTextMimeType(mimeType: string | undefined): boolean {
	const type = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
	return type !== undefined && (type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml"));
}

type ResourceLinkBlock = Extract<ContentBlock, { type: "resource_link" }>;

/** Model-facing content of one MCP content block. */
async function blockToContent(block: ContentBlock): Promise<ToolResultContent> {
	if (block.type === "resource_link") return [{ type: "text", text: resourceLinkText(block) }];
	if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
		return await blobResourceContent(block.resource);
	}
	return toLlmContent({ content: [block] }) as ToolResultContent;
}

function resourceLinkText(block: ResourceLinkBlock): string {
	const details = [block.mimeType, block.size === undefined ? undefined : `${block.size} bytes`].filter(Boolean);
	const description = block.description === undefined ? "" : `: ${block.description}`;
	return `[MCP resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}]`;
}

async function blobResourceContent(resource: { uri: string; mimeType?: string; blob: string }): Promise<ToolResultContent> {
	const data = Buffer.from(resource.blob, "base64");
	if (isTextMimeType(resource.mimeType)) return [{ type: "text", text: data.toString("utf8") }];
	const kind = `${resource.mimeType ?? "unknown type"}, ${data.length} bytes`;
	try {
		const path = await saveToTempFile(data, extensionOf(resource.uri));
		return [{ type: "text", text: `[MCP resource ${resource.uri} (${kind}) written to ${path}]` }];
	} catch (error) {
		return [{ type: "text", text: `[MCP resource ${resource.uri} (${kind}) could not be written: ${error instanceof Error ? error.message : String(error)}]` }];
	}
}

/** Convert one MCP result into a Durable tool result. Scripts read `structuredOutput`. */
export async function convertMcpResult(server: string, tool: string, result: CallToolResult): Promise<Durable.ToolExecutionResult<JsonValue>> {
	const limited = await limitMcpContent(await mcpModelContent(result));
	const { _meta: _ignored, ...scriptResult } = result;
	return {
		output: [...limited.content],
		structuredOutput: scriptResult as unknown as JsonValue,
		details: { server, tool, ...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }) },
		...(result.isError ? { isError: true } : {}),
	};
}

async function mcpModelContent(result: CallToolResult): Promise<ToolResultContent> {
	const converted = result.content.length > 0 ? (await Promise.all(result.content.map((block) => blockToContent(block)))).flat() : (toLlmContent(result) as ToolResultContent);
	const content = [...converted];
	if (result.isError && textOf(content) === "") content.push({ type: "text", text: "MCP tool returned an error" });
	return content;
}

/** MCP input schemas must be objects; some providers reject object schemas without properties. */
function toParameters(schema: unknown): TSchema {
	const object = isRecord(schema) ? schema : {};
	return { ...object, type: object.type ?? "object", ...(object.properties === undefined ? { properties: {} } : {}) } as TSchema;
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function resolveHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
	if (headers === undefined) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue !== undefined) resolved[key] = resolvedValue;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

const MCP_AUTH_LOCK_STALE_MS = 20_000;
const MCP_AUTH_LOCK_WAIT_MS = 25_000;
const MCP_AUTH_LOCK_RETRY_MS = 100;

/** Per-server OAuth state in `mcp-auth.json`, shared with the ordinary MCP commands and `/mcp`. */
class McpAuthFileStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	/** State of one server, keyed like the ordinary store so sign-ins are shared in both directions. */
	forServer(name: string, serverUrl: string): McpOAuthStateStore {
		const key = `${mcpNamespace(name)}|${serverUrl}`;
		return {
			load: () => this.withLock(async () => this.readStates()[key]),
			save: (state) => this.withLock(async () => {
				const states = this.readStates();
				states[key] = state;
				this.writeStates(states);
			}),
		};
	}

	private lockPath(): string {
		return `${this.path}.lock`;
	}

	private readStates(): Record<string, McpOAuthState> {
		if (!existsSync(this.path)) return {};
		const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
		return isRecord(parsed) ? (parsed as Record<string, McpOAuthState>) : {};
	}

	private writeStates(states: Record<string, McpOAuthState>): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(states, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, this.path);
	}

	/** Serialize read-modify-write across processes; a stale lock from a killed process is reclaimed. */
	private async withLock<T>(run: () => T | Promise<T>): Promise<T> {
		const started = Date.now();
		let held = this.tryAcquireLock();
		while (!held) {
			if (Date.now() - started > MCP_AUTH_LOCK_WAIT_MS) break;
			await new Promise((resolve) => setTimeout(resolve, MCP_AUTH_LOCK_RETRY_MS));
			held = this.tryAcquireLock();
		}
		try {
			return await run();
		} finally {
			if (held) this.releaseLock();
		}
	}

	private tryAcquireLock(): boolean {
		try {
			mkdirSync(this.lockPath());
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(this.lockPath()).mtimeMs > MCP_AUTH_LOCK_STALE_MS) rmdirSync(this.lockPath());
			} catch {
				// Another process already released it.
			}
			return false;
		}
	}

	private releaseLock(): void {
		try {
			rmdirSync(this.lockPath());
		} catch {
			// Another process reclaimed the stale lock first.
		}
	}
}

/** Build the transport auth for one server from its configured provider or stored OAuth tokens. */
function createServerAuthProvider(entry: McpServerEntry, store: McpAuthFileStore, modelRuntime: DurableExecutionHost["services"]["modelRuntime"]): AuthProvider | undefined {
	const { config, name } = entry;
	if (config.auth !== undefined) {
		const provider = config.auth.provider;
		return { token: async () => (await modelRuntime.getAuth(provider))?.auth.apiKey };
	}
	if (typeof config.url !== "string") return undefined;
	const headers = resolveHeaders(config.headers);
	if (headers !== undefined && Object.keys(headers).some((header) => header.toLowerCase() === "authorization")) return undefined;
	const serverUrl = new URL(config.url).href;
	const oauth = config.oauth;
	const clientSecret = oauth?.clientSecret === undefined ? undefined : resolveConfigValue(oauth.clientSecret);
	// Sign-in runs through `pi mcp login` or `/mcp`; this provider sends stored tokens and refreshes them.
	return adaptOAuthProvider(
		new McpOAuthProvider({
			serverUrl,
			redirectUrl: oauth?.callbackUrl ?? "http://127.0.0.1/callback",
			clientMetadata: { client_name: oauth?.clientName ?? "pi" },
			...(oauth?.clientId === undefined ? {} : { clientId: oauth.clientId }),
			...(clientSecret === undefined ? {} : { clientSecret }),
			store: store.forServer(name, serverUrl),
			onRedirect: () => undefined,
		}),
	);
}

/** A transport error the model can act on, naming the server and how to sign in. */
function mcpTransportError(server: McpServerEntry, error: unknown): Error {
	if (error instanceof McpOAuthAuthorizationRequiredError) {
		return new Error(`MCP server "${server.name}" requires sign-in. Run pi mcp login ${server.name} or /mcp login ${server.name} in an interactive session.`);
	}
	return error instanceof Error ? error : new Error(String(error));
}

function createTransport(entry: McpServerEntry, cwd: string, authProvider: AuthProvider | undefined) {
	const { config, name } = entry;
	if (typeof config.url === "string") {
		return new StreamableHttpTransport({ url: config.url, headers: resolveHeaders(config.headers), ...(authProvider === undefined ? {} : { authProvider }) });
	}
	if (typeof config.command !== "string") throw new Error(`MCP server "${name}" defines neither url nor command`);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env ?? {})) {
		const resolved = resolveConfigValue(value);
		if (resolved === undefined) throw new Error(`MCP server "${name}" env "${key}" did not resolve`);
		env[key] = resolved;
	}
	return new StdioTransport({
		command: expandHome(config.command),
		args: config.args?.map(expandHome),
		cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
		env,
		stderr: "pipe",
	});
}

type ServerState = "connecting" | "connected" | "failed" | "disconnected" | "closed";

/** One configured MCP server: connection, reconnection, and tool refresh. */
class McpServerConnection {
	readonly entry: McpServerEntry;
	readonly timeoutMs: number;
	readonly ready: Promise<void>;
	state: ServerState = "connecting";
	error: string | undefined;
	tools: McpTool[] = [];
	hasResources = false;
	instructions: string | undefined;
	private readonly cwd: string;
	private client: McpClient | undefined;
	private connecting: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	private closed = false;

	readonly onTools: () => void;
	readonly authProvider: AuthProvider | undefined;

	constructor(entry: McpServerEntry, cwd: string, onTools: () => void, authProvider: AuthProvider | undefined) {
		this.entry = entry;
		this.cwd = cwd;
		this.onTools = onTools;
		this.authProvider = authProvider;
		this.timeoutMs = (entry.config.timeout ?? 60) * 1000;
		this.ready = this.open().then(
			() => undefined,
			(error: unknown) => {
				if (!this.closed) {
					this.state = "failed";
					this.error = error instanceof Error ? error.message : String(error);
				}
			},
		);
	}

	getClient(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
		if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal }): Promise<CallToolResult> {
		return this.withClient((client) => client.callTool(name, args, { signal: options.signal, timeoutMs: this.timeoutMs }));
	}

	/** Every resource, following `nextCursor` through all pages. */
	allResources(options: { signal?: AbortSignal } = {}): Promise<Resource[]> {
		return this.withClient((client) => client.listResources({ signal: options.signal, timeoutMs: this.timeoutMs }), true);
	}

	resourcesPage(cursor: string | undefined, options: { signal?: AbortSignal } = {}): Promise<ListResourcesResult> {
		return this.withClient((client) => client.listResourcesPage(cursor, { signal: options.signal, timeoutMs: this.timeoutMs }), true);
	}

	/** Every resource template, following `nextCursor` through all pages. */
	allResourceTemplates(options: { signal?: AbortSignal } = {}): Promise<ResourceTemplate[]> {
		return this.withClient((client) => client.listResourceTemplates({ signal: options.signal, timeoutMs: this.timeoutMs }), true);
	}

	resourceTemplatesPage(cursor: string | undefined, options: { signal?: AbortSignal } = {}): Promise<{ resourceTemplates: ResourceTemplate[]; nextCursor?: string }> {
		return this.withClient(async (client) => {
			try {
				return await client.listResourceTemplatesPage(cursor, { signal: options.signal, timeoutMs: this.timeoutMs });
			} catch (error) {
				// Servers that do not implement templates list have none.
				if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return { resourceTemplates: [] };
				throw error;
			}
		}, true);
	}

	readResource(uri: string, options: { signal?: AbortSignal } = {}): Promise<ReadResourceResult> {
		return this.withClient((client) => client.readResource(uri, { signal: options.signal, timeoutMs: this.timeoutMs }), true);
	}

	/** Run one request, reconnecting when the client dropped; sign-in failures become readable errors. */
	private async withClient<T>(run: (client: McpClient) => Promise<T>, readOnly = false): Promise<T> {
		try {
			return await this.getClient().then(run);
		} catch (error) {
			if (readOnly && this.state === "disconnected") {
				// Reconnect once for a read that found a dropped connection.
				return await this.getClient().then(run);
			}
			throw mcpTransportError(this.entry, error);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.state = "closed";
		const active = this.client ?? this.connecting;
		this.client = undefined;
		this.connecting = undefined;
		await active?.close().catch(() => undefined);
	}

	private async open(): Promise<McpClient> {
		this.state = "connecting";
		const client = new McpClient({
			name: "pi",
			version: VERSION,
			requestTimeoutMs: this.timeoutMs,
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		client.onNotification("notifications/tools/list_changed", () => {
			void this.refreshTools(client);
		});
		client.onClose(() => this.handleClose(client));
		this.connecting = client;
		let transport: StdioTransport | StreamableHttpTransport | undefined;
		try {
			transport = createTransport(this.entry, this.cwd, this.authProvider);
			await client.connect(transport);
			if (this.closed) throw new Error("shut down while connecting");
			const tools = client.serverCapabilities?.tools === undefined ? [] : await client.listTools();
			if (this.closed) throw new Error("shut down while connecting");
			this.tools = tools;
			this.instructions = client.instructions?.trim() || undefined;
			this.hasResources = client.serverCapabilities?.resources !== undefined;
			this.state = "connected";
			this.error = undefined;
			this.client = client;
			this.onTools();
			return client;
		} catch (error) {
			await client.close().catch(() => undefined);
			this.tools = [];
			this.onTools();
			const stderr = transport instanceof StdioTransport ? transport.stderr.trim() : "";
			const mapped = mcpTransportError(this.entry, error);
			throw stderr === "" ? mapped : new Error(`${mapped.message}\n${stderr}`);
		} finally {
			if (this.connecting === client) this.connecting = undefined;
		}
	}

	private handleClose(client: McpClient): void {
		if (this.client !== client || this.closed) return;
		this.client = undefined;
		this.state = "disconnected";
		this.error = "Connection closed";
		this.onTools();
	}

	private async refreshTools(client: McpClient): Promise<void> {
		try {
			const tools = await client.listTools();
			if (this.client !== client || this.closed) return;
			this.tools = tools;
			this.state = "connected";
			this.onTools();
		} catch (error) {
			this.error = `Failed to refresh tools: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}

// ─── MCP resource tools ─────────────────────────────────────────────────────

/** The three resource tools, using the names established by common MCP hosts. */
const RESOURCE_LIST_PARAMETERS: TSchema = {
	type: "object",
	properties: {
		server: { type: "string", description: "MCP server name. Omit to list every server with resources." },
		cursor: { type: "string", description: "Opaque cursor from a previous call with the same server; omit for the first page." },
	},
	additionalProperties: false,
} as TSchema;

const RESOURCE_READ_PARAMETERS: TSchema = {
	type: "object",
	properties: {
		server: { type: "string", description: "MCP server name exactly as configured." },
		uri: { type: "string", description: "Resource URI returned by list_mcp_resources." },
	},
	required: ["server", "uri"],
	additionalProperties: false,
} as TSchema;

const RESOURCE_LIST_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "object", properties: { server: { type: "string" }, resources: { type: "array", items: { type: "object" } }, nextCursor: { type: "string" }, errors: { type: "array", items: { type: "object" } } }, required: ["resources"] };
const RESOURCE_TEMPLATES_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "object", properties: { server: { type: "string" }, resourceTemplates: { type: "array", items: { type: "object" } }, nextCursor: { type: "string" }, errors: { type: "array", items: { type: "object" } } }, required: ["resourceTemplates"] };
const RESOURCE_READ_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "object", properties: { server: { type: "string" }, uri: { type: "string" }, contents: { type: "array", items: { type: "object" } } }, required: ["server", "uri", "contents"] };

/** MCP App resources are user interfaces for hosts that render them. */
function isMcpAppResource(item: { uri?: string; uriTemplate?: string; mimeType?: string }): boolean {
	const uri = item.uri ?? item.uriTemplate ?? "";
	return uri.startsWith("ui://") || /;\s*profile\s*=\s*"?mcp-app"?/i.test(item.mimeType ?? "");
}

/** A listed resource or template without `_meta` and icons, tagged with its server. */
function listedResource(server: string, item: unknown): Record<string, JsonValue> {
	const copy = { ...(item as Record<string, JsonValue>) };
	delete copy._meta;
	delete copy.icons;
	return { server, ...copy };
}

/** A resource tool result: listing JSON for the model and the full payload for scripts. */
async function resourceJsonResult(tool: string, server: string | undefined, payload: JsonValue): Promise<Durable.ToolExecutionResult<JsonValue>> {
	const limited = await limitMcpContent([{ type: "text", text: JSON.stringify(payload) }]);
	return {
		output: [...limited.content],
		structuredOutput: payload,
		details: { server: server ?? "", tool, ...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }) },
	};
}

/** The string argument of a resource tool call. */
function resourceStringArgument(params: unknown, key: string): string | undefined {
	if (!isRecord(params)) return undefined;
	const value = params[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value.trim() || undefined;
}

/** Which built-ins and servers the host settings activate. */
interface Activation {
	readonly codemode: boolean;
	readonly toolSearch: boolean;
	readonly servers: readonly McpServerEntry[];
	readonly indirect: boolean;
}

function computeActivation(host: DurableExecutionHost): Activation {
	const settings = host.services.settingsManager.getSettings();
	const defaultTools = host.services.settingsManager.getDefaultTools();
	const disabled = new Set((settings.extensions ?? []).filter((entry) => entry.startsWith("-builtin:")).map((entry) => entry.slice(9)));
	const config = disabled.has("mcp") ? { servers: [], errors: [] } : loadMcpConfig({ agentDir: host.agentDir, cwd: host.cwd, projectTrusted: host.services.settingsManager.isProjectTrusted() });
	for (const error of config.errors) host.services.diagnostics.push({ type: "warning", message: error });
	const servers = config.servers.filter((server) => server.config.enabled !== false);
	const uses = (exposure: McpExposure) => servers.some((server) => configuredExposures(server.config).has(exposure));
	const configured = (name: string) => defaultTools?.includes(name) ?? false;
	return {
		codemode: !disabled.has("codemode") && (configured(CODEMODE_TOOL_NAME) || (config.autoEnableCodemode !== false && uses("codemode"))),
		toolSearch: !disabled.has("tool_search") && (configured(TOOL_SEARCH_TOOL_NAME) || uses("deferred")),
		servers,
		indirect: servers.some((server) => hasIndirectTools(server.config)),
	};
}

// ─── Native execution host ────────────────────────────────────────────────

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hasIndirectTools(config: McpServerConfig): boolean {
	const exposures = configuredExposures(config);
	return exposures.has("codemode") || exposures.has("deferred");
}
function truncateLine(text: string, max: number): string {
	const first = (text.split("\n", 1)[0] ?? "").trim();
	return first.length <= max ? first : max <= 1 ? "" : `${first.slice(0, max - 1).trimEnd()}…`;
}

class DurableExecutionRuntime implements DurableExecution {
	readonly extensions: readonly Durable.Extension[];
	readonly ready: Promise<void>;
	private readonly host: DurableExecutionHost;
	private readonly liveTools: NestedTool[] = [];
	private readonly namespaces: CodemodeNamespace[] = [];
	private readonly resourceTools: NestedTool[];
	private readonly servers: McpServerConnection[] = [];
	private readonly sandbox = new CodemodeSandbox({ acquireWorker: () => { throw new Error("Codemode calls require queued worker admission."); } });
	private readonly queuedSandboxes = new Set<QueuedCodemodeSandbox>();
	private readonly readyTimeoutMs: number;
	private readonly closeOnHostAbort = () => void this.close();
	private closed = false;

	constructor(host: DurableExecutionHost, options: DurableExecutionOptions = {}) {
		this.host = host;
		this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		this.resourceTools = this.defineResourceTools();
		const activation = computeActivation(host);
		const authStore = new McpAuthFileStore(join(host.agentDir, "mcp-auth.json"));
		this.extensions = this.buildExtensions(activation);
		if (host.signal.aborted) void this.close();
		else host.signal.addEventListener("abort", this.closeOnHostAbort, { once: true });
		for (const server of host.signal.aborted ? [] : activation.servers) {
			this.servers.push(new McpServerConnection(server, host.cwd, () => this.rebuildMcpTools(), createServerAuthProvider(server, authStore, host.services.modelRuntime)));
		}
		this.ready = this.waitForDirectServers();
	}

	private async waitForDirectServers(): Promise<void> {
		const pending = this.servers.filter((server) => configuredExposures(server.entry.config).has("direct")).map((server) => server.ready);
		if (pending.length === 0 || this.readyTimeoutMs <= 0) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, this.readyTimeoutMs);
			timer.unref?.();
			void Promise.all(pending).then(() => { clearTimeout(timer); resolve(); });
		});
	}

	private buildExtensions(activation: Activation): readonly Durable.Extension[] {
		const result: Durable.Extension[] = [];
		if (activation.codemode) {
			const Admission = this.host.durable.defineDoc<{ deadline?: number; admitted: boolean }>({
				kind: "agent.codemode-admission", version: 1, scope: "task", initial: () => ({ admitted: false }), checkpointWhen: () => false,
			});
			const native = createCodemodeExtension({ sandbox: this.sandbox, namespaces: this.namespaces });
			const tools = (native.tools ?? []).map((tool) => tool.name !== CODEMODE_TOOL_NAME ? tool : {
				...tool,
				execute: async (args: { code: string }, api: Durable.ToolExecutionApi, context: Context) => {
					await this.waitForScriptServers(parseCodemodeSource(args.code).code, context);
					const sandbox = new QueuedCodemodeSandbox({
						deadline: () => api.commit(async (tx) => {
							const state = await tx.doc(Admission, api.taskId);
							if (state.deadline === undefined || state.admitted) {
								state.deadline = api.now() + CODEMODE_WORKER_WAIT_MS;
								state.admitted = false;
							}
							return state.deadline;
						}, context).then((deadline) => Date.now() + Math.max(0, deadline - api.now())),
						admitted: () => api.commit(async (tx) => { (await tx.doc(Admission, api.taskId)).admitted = true; }, context),
					}, undefined, { memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES });
					this.queuedSandboxes.add(sandbox);
					if (this.closed) await sandbox.close();
					try {
						return await createCodemodeTool({ sandbox, namespaces: this.namespaces }).execute(args, this.catalogApi(api), context);
					} finally {
						this.queuedSandboxes.delete(sandbox);
						await sandbox.close();
					}
				},
			});
			result.push({ ...native, tools, hooks: [this.host.durable.hook(this.host.durable.GenerationTask, {
				beforeRequest: (request) => {
					if (this.host.services.settingsManager.getSettings().codemode?.mode !== "only") return;
					return { messages: request.messages.map((message) => message.role !== "system" ? message : {
						...message,
						...(message.toolsAdded === undefined ? {} : { toolsAdded: message.toolsAdded.filter((tool) => tool.name === CODEMODE_TOOL_NAME || tool.name === TOOL_SEARCH_TOOL_NAME) }),
					}) };
				},
			})] });
		}
		if (activation.toolSearch) {
			const native = createToolSearchExtension();
			result.push({ ...native, tools: (native.tools ?? []).map((tool) => ({ ...tool,
				execute: async (args: Parameters<typeof tool.execute>[0], api: Durable.ToolExecutionApi, context: Context) => { await this.waitForAllServers(context); return tool.execute(args, this.catalogApi(api), context); },
			})) });
		}
		result.push(this.host.durable.defineExtension({ name: EXTENSION_NAME, tools: this.liveTools,
			sections: activation.indirect ? [this.host.durable.section(MCP_SERVERS_SECTION, () => this.renderServersSection())] : [],
		}));
		return result;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.host.signal.removeEventListener("abort", this.closeOnHostAbort);
		await Promise.all([this.sandbox.close(), ...[...this.queuedSandboxes].map((sandbox) => sandbox.close()), ...this.servers.map((server) => server.close())]);
	}

	private rebuildMcpTools(): void {
		if (this.closed) return;
		this.liveTools.splice(0);
		this.namespaces.splice(0);
		for (const server of this.servers) {
			this.namespaces.push({ name: server.entry.name, prefix: `${mcpNamespace(server.entry.name)}__`,
				...(server.entry.config.description === undefined ? {} : { description: server.entry.config.description }),
				...(server.instructions === undefined ? {} : { instructions: server.instructions }),
			});
			this.registerServerTools(server);
		}
		const exposures = new Set(this.resourceServers().map((server) => server.entry.config.exposure ?? "codemode"));
		if (exposures.size > 0) for (const tool of this.resourceTools) this.liveTools.push({ ...tool, ...(exposures.has("direct") ? {} : { deferred: true }) });
	}

	private registerServerTools(server: McpServerConnection): void {
		const tools = [...new Map(server.tools.map((tool) => [tool.name, tool])).values()];
		const owners = new Set<string>();
		const plain = tools.map((tool) => createMcpToolName(server.entry.name, tool.name));
		for (const tool of tools) {
			const exposure = getToolExposure(server.entry.config, tool.name);
			if (exposure === "hidden") continue;
			const name = createMcpToolName(server.entry.name, tool.name, (candidate) => owners.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate));
			owners.add(name);
			this.liveTools.push(this.defineMcpTool(server, tool, name, exposure));
		}
	}

	private resourceServers(): McpServerConnection[] {
		return this.servers.filter((server) => server.hasResources && server.entry.config.exposure !== "hidden");
	}

	private defineMcpTool(server: McpServerConnection, tool: McpTool, name: string, exposure: McpExposure): NestedTool {
		return { name, description: tool.description?.trim() || tool.title || `MCP tool ${tool.name} from server ${server.entry.name}`,
			parameters: toParameters(tool.inputSchema), structuredOutputSchema: createMcpResultSchema(tool.outputSchema as CodemodeJsonSchema | undefined) as TSchema,
			replay: "unsafe", ...(exposure === "direct" ? {} : { deferred: true }),
			execute: async (args, _api, context) => convertMcpResult(server.entry.name, tool.name, await server.callTool(tool.name, args as Record<string, unknown>, { signal: context.abortSignal })),
		};
	}

	/** A tool phase pins its agent before MCP discovery; the public conversation read resolves the completed catalog. */
	private catalogApi(api: Durable.ToolExecutionApi): Durable.ToolExecutionApi {
		if (this.servers.length === 0) return api;
		return { ...api, get models() { return api.models; }, get env() { return api.env; }, agent: async (context) => {
			await api.agent(context);
			const conversation = await this.host.harness.conversation(api.conversationId, context);
			if (conversation === undefined) throw new Error("The MCP tool's conversation is unavailable");
			return conversation.agent(context);
		} };
	}

	private async waitForScriptServers(code: string, context: Context): Promise<void> {
		const wantsAll = /\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/.test(code);
		const waiting = this.servers.filter((server) => wantsAll || code.includes(mcpNamespace(server.entry.name)) || /\b(list_mcp_resources|list_mcp_resource_templates|read_mcp_resource)\b/.test(code));
		await this.waitForServers(waiting, context);
	}
	private async waitForAllServers(context: Context): Promise<void> { await this.waitForServers(this.servers, context); }
	private async waitForServers(servers: readonly McpServerConnection[], context: Context): Promise<void> {
		const signal = context.abortSignal;
		signal?.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const abort = () => reject(signal?.reason ?? new Error("MCP wait aborted"));
			signal?.addEventListener("abort", abort, { once: true });
			void Promise.all(servers.map((server) => server.ready)).then(() => resolve(), reject).finally(() => signal?.removeEventListener("abort", abort));
		});
		signal?.throwIfAborted();
	}

	// ── Resource tools ─────────────────────────────────────────────────────

	private defineResourceTools(): NestedTool[] {
		return [
			{
				name: LIST_MCP_RESOURCES_TOOL,
				description:
					"Show the resources the connected MCP servers publish. A resource can be a file, a schema, or other context a model can use; prefer it over a web search. Omit `server` to list every server, or name one server with a cursor for one page.",
				parameters: RESOURCE_LIST_PARAMETERS,
				structuredOutputSchema: RESOURCE_LIST_OUTPUT_SCHEMA as TSchema,
				replay: "safe",
				execute: (args, _api, context) => this.listResourceTool(LIST_MCP_RESOURCES_TOOL, "resources", args as Record<string, unknown>, context),
			},
			{
				name: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
				description:
					"Show the parameterized resource templates the connected MCP servers publish. Prefer a template over a web search when it covers the data you need.",
				parameters: RESOURCE_LIST_PARAMETERS,
				structuredOutputSchema: RESOURCE_TEMPLATES_OUTPUT_SCHEMA as TSchema,
				replay: "safe",
				execute: (args, _api, context) => this.listResourceTool(LIST_MCP_RESOURCE_TEMPLATES_TOOL, "resourceTemplates", args as Record<string, unknown>, context),
			},
			{
				name: READ_MCP_RESOURCE_TOOL,
				description: "Read one resource by server name and URI, as returned by `list_mcp_resources`.",
				parameters: RESOURCE_READ_PARAMETERS,
				structuredOutputSchema: RESOURCE_READ_OUTPUT_SCHEMA as TSchema,
				replay: "safe",
				execute: (args, _api, context) => this.readResourceTool(args as Record<string, unknown>, context),
			},
		];
	}

	private async listResourceTool(tool: string, key: "resources" | "resourceTemplates", params: Record<string, unknown>, context: Context): Promise<Durable.ToolExecutionResult<JsonValue>> {
		await this.waitForAllServers(context);
		const serverName = resourceStringArgument(params, "server");
		const cursor = resourceStringArgument(params, "cursor");
		const servers = [...this.resourceServers()].sort((a, b) => a.entry.name.localeCompare(b.entry.name));
		if (serverName === undefined) {
			if (cursor !== undefined) throw new Error("cursor can only be used when a server is specified");
			return await this.listEveryResourceServer(tool, key, servers, context);
		}
		const server = this.findResourceServer(serverName, servers);
		const page = key === "resources" ? await server.resourcesPage(cursor, { signal: context.abortSignal }) : await server.resourceTemplatesPage(cursor, { signal: context.abortSignal });
		const items = "resources" in page ? page.resources : page.resourceTemplates;
		const payload = { server: server.entry.name, [key]: items.filter((item) => !isMcpAppResource(item)).map((item) => listedResource(server.entry.name, item)), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
		return await resourceJsonResult(tool, server.entry.name, payload as unknown as JsonValue);
	}

	private async listEveryResourceServer(tool: string, key: "resources" | "resourceTemplates", servers: readonly McpServerConnection[], context: Context): Promise<Durable.ToolExecutionResult<JsonValue>> {
		const results = await Promise.allSettled(servers.map((server) => (key === "resources" ? server.allResources({ signal: context.abortSignal }) : server.allResourceTemplates({ signal: context.abortSignal }))));
		const items: JsonValue[] = [];
		const errors: JsonValue[] = [];
		results.forEach((result, index) => {
			const server = servers[index];
			if (server === undefined) return;
			if (result.status === "fulfilled") {
				items.push(...result.value.filter((item) => !isMcpAppResource(item)).map((item) => listedResource(server.entry.name, item) as unknown as JsonValue));
			} else {
				errors.push({ server: server.entry.name, error: errorText(result.reason) });
			}
		});
		return await resourceJsonResult(tool, undefined, { [key]: items, ...(errors.length === 0 ? {} : { errors }) } as unknown as JsonValue);
	}

	private async readResourceTool(params: Record<string, unknown>, context: Context): Promise<Durable.ToolExecutionResult<JsonValue>> {
		await this.waitForAllServers(context);
		const serverName = resourceStringArgument(params, "server");
		const uri = resourceStringArgument(params, "uri");
		if (serverName === undefined) throw new Error("server must be provided");
		if (uri === undefined) throw new Error("uri must be provided");
		const server = this.findResourceServer(serverName, this.resourceServers());
		const result = await server.readResource(uri, { signal: context.abortSignal });
		const blocks: ContentBlock[] = result.contents.flatMap((contents) => [...(result.contents.length > 1 ? [{ type: "text" as const, text: `${contents.uri}:` }] : []), { type: "resource" as const, resource: contents }]);
		const converted = (await Promise.all(blocks.map((block) => blockToContent(block)))).flat();
		const limited = await limitMcpContent(converted.length > 0 ? converted : [{ type: "text", text: `Resource ${uri} is empty.` }]);
		const contents = result.contents.map(({ _meta: _ignored, ...rest }) => rest);
		return {
			output: [...limited.content],
			structuredOutput: { server: server.entry.name, uri, contents } as unknown as JsonValue,
			details: {
				server: server.entry.name,
				tool: READ_MCP_RESOURCE_TOOL,
				...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }),
			},
		};
	}

	private findResourceServer(name: string, servers: readonly McpServerConnection[]): McpServerConnection {
		const found = servers.find((server) => server.entry.name === name);
		if (found !== undefined) return found;
		const available = servers.map((server) => server.entry.name).join(", ");
		throw new Error(`MCP server "${name}" has no resources${available === "" ? "" : `. Servers with resources: ${available}`}`);
	}

	// ── Prompt section ─────────────────────────────────────────────────────

	/** The `mcp_servers` section: enabled servers with tools that are not declared. */
	private renderServersSection(): string | undefined {
		const listed = this.servers.filter((server) => hasIndirectTools(server.entry.config)).sort((a, b) => a.entry.name.localeCompare(b.entry.name));
		if (listed.length === 0) return undefined;
		const reaches = listed.map((server) => (configuredExposures(server.entry.config).has("codemode") ? "codemode" : "tool_search"));
		const intro = [
			"MCP servers with tools that are not declared to you.",
			reaches.includes("codemode") ? " Their tools are called from `codemode` scripts." : "",
			reaches.includes("tool_search") ? " Their tools are loaded with `tool_search`." : "",
		].join("");
		const heads = listed.map((server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`);
		const omitted = (count: number) => (count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; use searchTools() to find their tools`] : []);
		const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
		let kept = listed.length;
		while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
		const perServer = kept === 0 ? 0 : Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
		const lines = listed.slice(0, kept).map((server, index) => {
			const summary = perServer > 0 ? truncateLine(server.entry.config.description ?? server.instructions ?? "", perServer) : "";
			return summary === "" ? heads[index] : `${heads[index]}: ${summary}`;
		});
		return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
	}
}

/**
 * Create the native codemode and MCP built-ins for one Durable session host. The caller
 * installs `extensions` in the host registry and calls `close()` when the host shuts down.
 */
export function createDurableExecution(host: DurableExecutionHost, options?: DurableExecutionOptions): DurableExecution {
	return new DurableExecutionRuntime(host, options);
}
