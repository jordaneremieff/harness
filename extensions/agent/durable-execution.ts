/**
 * agent/durable-execution: native codemode and MCP built-ins for Pi Durable conversations.
 *
 * A Durable conversation receives tools, tasks, documents, and hooks only from native
 * extensions. This module builds that native form on top of the public
 * `@earendil-works/pi-codemode` `CodemodeSandbox` and `@earendil-works/pi-mcp` `McpClient`:
 *
 * - a `codemode` tool that runs a QuickJS script and calls other tools through a custom
 *   durable task. The task records validated intent before execution and a terminal result
 *   after it, runs the same `beforeTool`/`afterTool` `ToolTask` hooks a model-issued call
 *   runs, is owned by the codemode call, and applies each target tool's replay policy on
 *   recovery. Nested results reach only the script; they create no transcript entries.
 * - an `mcp_servers` section and per-server MCP tools read from the user and trusted-project
 *   `mcp.json` files. Tools follow the ordinary exposure rules: `direct` tools register in
 *   the registry, `codemode` and `deferred` tools stay callable from scripts, `deferred`
 *   tools enter the registry only after `tool_search` loads them, and `hidden` tools are
 *   unreachable.
 * - a `tool_search` tool over the not-yet-declared MCP tools, when settings or a deferred
 *   server activates it.
 *
 * The host installs the returned extensions as native built-ins. MCP connections start in
 * the background; the extension's tool list is live, so connected direct tools appear on
 * the next request. `close()` closes MCP connections and stops accepting scripts. `ready`
 * settles when the initial servers connected or failed, for a caller that mirrors the
 * ordinary first-prompt wait for direct tools.
 *
 * Boundaries: remote MCP servers use configured headers, a configured Pi login provider, or
 * OAuth state stored in `mcp-auth.json` and refreshed through the public OAuth adapter. A
 * Durable host cannot run the interactive sign-in flow; the failure names `pi mcp login`,
 * and credentials stored by the CLI are used. The installed ordinary MCP integration has no
 * prompt retrieval, so this contribution matches it; only server capabilities are tracked.
 */
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { CodemodeJsonSchema, CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode";
import { CodemodeSandbox, loadQuickJSWasm, parseCodemodeSource, renderToolOutputType, renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import type { AuthProvider, CallToolResult, ContentBlock, ListResourcesResult, ReadResourceResult, Resource, ResourceTemplate, Tool as McpTool } from "@earendil-works/pi-mcp";
import { JSON_RPC_ERROR_CODES, McpClient, McpError, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import type { McpOAuthState, McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { adaptOAuthProvider, McpOAuthAuthorizationRequiredError, McpOAuthProvider } from "@earendil-works/pi-mcp/oauth";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Message, SystemMessage, TextContent, ToolCall, Tool as PiTool, Usage } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type * as Durable from "@earendil-works/pi-durable";
import type { JsonObject } from "@earendil-works/pi-durable";
import { Type, type TSchema } from "typebox";

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

/** Part of the model runtime scripts reach through `models`. */
export type CodemodeModelRuntime = Pick<AgentSessionServices["modelRuntime"], "getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify" | "generateImages">;

const EXTENSION_NAME = "pi.durable-execution";
const TASK_NAME = `${EXTENSION_NAME}.call`;
const STORE_KIND = `${EXTENSION_NAME}.store`;
const TOOL_TASK_NAME = "pi.tool";
const CODEMODE_TOOL_NAME = "codemode";
const TOOL_SEARCH_TOOL_NAME = "tool_search";
const MCP_SERVERS_SECTION = "mcp_servers";
const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";
const DEFAULT_TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };
const MAX_CONCURRENT_MODEL_CALLS = 4;
const MAX_STORE_VALUE_CHARS = 262_144;
const MAX_STORE_TOTAL_CHARS = 1_048_576;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SERVERS_SECTION_CHARS = 4096;
const MAX_SERVER_DESCRIPTION_CHARS = 250;
const MAX_TOOL_NAME_LENGTH = 64;
const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** A native tool as the codemode pipeline sees it: the registration plus its declared output schema. */
type NestedTool = Durable.ToolRegistration & { readonly outputSchema?: CodemodeJsonSchema };

type ToolResultContent = readonly (TextContent | ImageContent)[];

type ToolDiagnostic = { readonly severity: "info" | "warn" | "error"; readonly message: string; readonly code?: string };

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
		parsed = JSON.parse(readFileSync(path, "utf8"));
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
			...(structuredContentSchema === undefined ? {} : { structuredContent: structuredContentSchema }),
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

/** Convert one MCP result into a Durable tool result. Scripts read `details.structuredContent`. */
export async function convertMcpResult(server: string, tool: string, result: CallToolResult): Promise<Durable.ToolExecutionResult<JsonValue>> {
	const limited = await limitMcpContent(await mcpModelContent(result));
	const { _meta: _ignored, ...scriptResult } = result;
	return {
		content: [...limited.content],
		details: { server, tool, ...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }), structuredContent: scriptResult as unknown as JsonValue },
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

// ─── Tool search ranking ────────────────────────────────────────────────────

const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with"]);

/** Lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words. */
export function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term !== "" && !STOP_WORDS.has(term));
}

function schemaTerms(schema: unknown): string[] {
	const terms: string[] = [];
	collectSchemaTerms(terms, schema, 0);
	return terms;
}

function collectSchemaTerms(terms: string[], schema: unknown, depth: number): void {
	if (depth > 6 || !isRecord(schema)) return;
	collectDescriptionTerms(terms, schema);
	collectPropertyTerms(terms, schema.properties, depth);
	collectArrayTerms(terms, schema.anyOf, depth);
	collectArrayTerms(terms, schema.oneOf, depth);
	if (isRecord(schema.items)) collectSchemaTerms(terms, schema.items, depth + 1);
}

function collectDescriptionTerms(terms: string[], schema: Record<string, unknown>): void {
	for (const key of ["description", "title"]) if (typeof schema[key] === "string" && schema[key] !== "") terms.push(schema[key] as string);
}

function collectPropertyTerms(terms: string[], properties: unknown, depth: number): void {
	if (!isRecord(properties)) return;
	for (const [name, child] of Object.entries(properties)) {
		terms.push(name);
		collectSchemaTerms(terms, child, depth + 1);
	}
}

function collectArrayTerms(terms: string[], value: unknown, depth: number): void {
	if (!Array.isArray(value)) return;
	for (const child of value) collectSchemaTerms(terms, child, depth + 1);
}

interface SearchDocument {
	readonly name: string;
	readonly text: string;
}

/** Okapi BM25 over tool metadata. Ties keep document order. */
class Bm25Ranker {
	rank(query: string, documents: readonly SearchDocument[], limit: number): SearchDocument[] {
		const queryTerms = [...new Set(tokenize(query))];
		const tokenized = documents.map((document) => tokenize(document.text));
		if (queryTerms.length === 0 || documents.length === 0) return documents.slice(0, limit);
		const length = tokenized.map((terms) => terms.length);
		const average = length.reduce((sum, value) => sum + value, 0) / length.length || 1;
		const scored = documents.map((_document, index) => ({ index, score: this.score(queryTerms, tokenized, length, average, index) }));
		return scored
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, limit)
			.flatMap((entry) => {
				const document = documents[entry.index];
				return document === undefined ? [] : [document];
			});
	}

	private score(queryTerms: readonly string[], tokenized: readonly (readonly string[])[], length: readonly number[], average: number, index: number): number {
		let score = 0;
		for (const term of queryTerms) {
			const frequency = tokenized[index]?.filter((candidate) => candidate === term).length ?? 0;
			if (frequency === 0) continue;
			const documentFrequency = tokenized.filter((terms) => terms.includes(term)).length;
			const idf = Math.log(1 + (tokenized.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
			score += idf * ((frequency * 2.2) / (frequency + 1.2 * (1 - 0.75 + (0.75 * (length[index] ?? 0)) / average)));
		}
		return score;
	}
}

const ranker = new Bm25Ranker();

// ─── MCP transport and connection ───────────────────────────────────────────

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

// ─── Callable catalog ───────────────────────────────────────────────────────

interface McpNamespace {
	readonly name: string;
	readonly description?: string;
	readonly instructions?: string;
}

interface CallableEntry {
	readonly name: string;
	readonly description: string;
	readonly declaration: Pick<CodemodeTool, "name" | "description" | "inputSchema" | "outputSchema">;
	readonly structured: boolean;
	/** MCP catalog entry: reachable only through scripts until `tool_search` loads it. */
	readonly namespace?: McpNamespace;
	readonly replay: "safe" | "unsafe";
}

function entryOf(tool: NestedTool, namespace?: McpNamespace): CallableEntry {
	return {
		name: tool.name,
		description: tool.description ?? "",
		declaration: {
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.parameters as CodemodeJsonSchema,
			outputSchema: tool.outputSchema ?? DEFAULT_TEXT_OUTPUT_SCHEMA,
		},
		structured: tool.outputSchema !== undefined,
		...(namespace === undefined ? {} : { namespace }),
		replay: tool.replay ?? "unsafe",
	};
}

// ─── Nested-call durable task ───────────────────────────────────────────────

interface NestedCallInput {
	readonly callId: string;
	readonly name: string;
	readonly arguments: JsonValue;
}

type NestedCallCheckpoint = { readonly phase: "call" } | { readonly phase: "execute"; readonly arguments: JsonObject; readonly replay: "safe" | "unsafe" };

interface NestedCallResult {
	readonly content: ToolResultContent;
	readonly details?: JsonValue;
	readonly diagnostics?: readonly ToolDiagnostic[];
	readonly isError?: boolean;
	readonly usage?: Usage;
}

type NestedRuntime = Durable.TaskRuntime<NestedCallInput, NestedCallCheckpoint, NestedCallResult, Durable.ToolHooks>;

function errorResult(code: string, message: string, result?: NestedCallResult): NestedCallResult {
	return { ...(result ?? {}), isError: true, content: result?.content ?? [], diagnostics: [{ severity: "error", code, message }] };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function diagnosticText(result: NestedCallResult): string {
	const text = textOf(result.content as readonly { type?: string; text?: string }[]);
	if (text !== "") return text;
	return (result.diagnostics ?? []).map((diagnostic) => diagnostic.message).join("\n");
}

/** Call the tool's argument repair and then validate the result, as the built-in tool task does. */
function repairArguments(tool: NestedTool, args: JsonValue): { args: JsonValue } | { error: string } {
	if (tool.prepareArguments === undefined) return { args };
	try {
		return { args: tool.prepareArguments(args) as JsonValue };
	} catch (error) {
		return { error: errorText(error) };
	}
}

function validateArguments(tool: NestedTool, call: ToolCall, args: JsonValue): { args: JsonObject } | { error: string } {
	try {
		return { args: validateToolArguments(tool, { ...call, arguments: args as JsonObject }) as JsonObject };
	} catch (error) {
		return { error: errorText(error) };
	}
}

/** Run the `ToolTask` handlers the selected extensions registered, in extension order. */
async function eachToolTaskHook<K extends "beforeTool" | "afterTool">(
	runtime: NestedRuntime,
	context: Context,
	member: K,
	invoke: (handler: NonNullable<Durable.ToolHooks[K]>) => Promise<void>,
): Promise<void> {
	const agent = await runtime.agent(context);
	for (const extension of agent.extensions) {
		for (const handler of extensionToolHandlers(extension, member)) await invokeReported(runtime, () => invoke(handler));
	}
}

function extensionToolHandlers<K extends "beforeTool" | "afterTool">(extension: Durable.Extension, member: K): NonNullable<Durable.ToolHooks[K]>[] {
	const handlers: NonNullable<Durable.ToolHooks[K]>[] = [];
	for (const hook of extension.hooks ?? []) {
		if (hook.task !== TOOL_TASK_NAME) continue;
		const handler = (hook.handlers as Durable.ToolHooks)[member] as NonNullable<Durable.ToolHooks[K]> | undefined;
		if (typeof handler === "function") handlers.push(handler.bind(hook.handlers) as NonNullable<Durable.ToolHooks[K]>);
	}
	return handlers;
}

async function invokeReported(runtime: NestedRuntime, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		if (runtime.signal.aborted) throw error;
		runtime.report(error);
	}
}

async function resolveBeforeTool(runtime: NestedRuntime, context: Context, call: ToolCall, initialArgs: JsonObject): Promise<{ args: JsonObject; block?: string }> {
	let args = initialArgs;
	let block: string | undefined;
	await eachToolTaskHook(runtime, context, "beforeTool", async (handler) => {
		if (block !== undefined) return;
		const decision = await beforeToolDecision(handler, { ...call, arguments: args }, runtime, context);
		if (decision?.block !== undefined) block = decision.block;
		else if (decision?.arguments !== undefined) args = decision.arguments;
	});
	return { args, block };
}

async function beforeToolDecision(handler: NonNullable<Durable.ToolHooks["beforeTool"]>, call: ToolCall, runtime: NestedRuntime, context: Context) {
	try {
		return await handler(call, runtime, context);
	} catch (error) {
		if (runtime.signal.aborted) throw error;
		return { block: errorText(error) };
	}
}

/** What one tool execution reported through its api; the built-in task falls back to these. */
interface ToolCollectors {
	readonly output: string[];
	details: JsonValue | undefined;
	readonly diagnostics: ToolDiagnostic[];
}

/** A `ToolExecutionApi` backed by the nested task's runtime. */
function nestedToolApi(runtime: NestedRuntime, callId: string, env: Durable.ToolExecutionApi["env"], collectors: ToolCollectors): Durable.ToolExecutionApi {
	return {
		taskId: runtime.taskId,
		conversationId: runtime.conversationId,
		callId,
		get registry() {
			return runtime.registry;
		},
		agent: runtime.agent,
		env,
		output: (chunk) => {
			collectors.output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		},
		diagnostic: (diagnostic) => {
			collectors.diagnostics.push(diagnostic);
		},
		details: async (value, context) => {
			context.abortSignal?.throwIfAborted();
			collectors.details = value;
		},
		commit: async (change, commitContext) => {
			let value: unknown;
			await runtime.commit(async (tx) => {
				value = await change(tx);
				return undefined;
			}, commitContext);
			return value;
		},
		memo: runtime.memo,
		createTask: async (task, input, options, taskContext) => {
			let id: Durable.TaskId<unknown> | undefined;
			await runtime.commit(async (tx) => {
				id = await tx.createTask(task, input, { ...options, conversationId: runtime.conversationId });
				return undefined;
			}, taskContext);
			return id as Durable.TaskId<unknown>;
		},
		getTask: runtime.getTask,
		waitForTask: runtime.waitForTask,
		conversation: runtime.conversation,
		snapshot: runtime.snapshot,
		snapshotAsOf: runtime.snapshotAsOf,
		watchDoc: runtime.watchDoc,
	} as Durable.ToolExecutionApi;
}

function toolResultOf(produced: Durable.ToolExecutionResult, collectors: ToolCollectors): NestedCallResult {
	return {
		content: produced.content ?? (collectors.output.length === 0 ? [] : [{ type: "text", text: collectors.output.join("") }]),
		details: produced.details ?? collectors.details,
		diagnostics: [...collectors.diagnostics, ...(produced.diagnostics ?? [])],
		...(produced.isError === undefined ? {} : { isError: produced.isError }),
		...(produced.usage === undefined ? {} : { usage: produced.usage }),
	};
}

const CODEMODE_HEADER =
	"Write one JavaScript program that calls this session's tools. Pass raw source, not JSON and not a fenced block; it runs as the body of an async function inside a QuickJS sandbox, so top-level `await` and `return` work and there is no Node API, file system, network, or timer.\n- `await tools.<name>({ ...args })` returns a string, or the structured value named by the tool declaration, and throws an Error when the call fails. Cancelling the script cancels its calls.\n- An optional first line sets limits: `// @options: {\"max_output_tokens\": 10000, \"timeout_ms\": 60000}`";

type ClassifierContextValue = Parameters<CodemodeModelRuntime["classify"]>[1];
type ImagesContextValue = Parameters<CodemodeModelRuntime["generateImages"]>[1];
const MODEL_KINDS = ["chat", "image", "classifier"] as const;

function toModelKind(value: unknown): "chat" | "image" | "classifier" {
	if (value === "chat" || value === "image" || value === "classifier") return value;
	throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
}

function toProvider(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("provider must be a string");
	return value;
}

function withArticle(word: string): string {
	return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

/** A script value in an error message: `undefined`, `a string`, `an array`, or its keys. */
function describeValue(value: unknown): string {
	if (value === undefined || value === null) return String(value);
	if (Array.isArray(value)) return value.length === 0 ? "an empty array" : "an array";
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return keys.length === 0 ? "{}" : `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""} }`;
	}
	return typeof value === "string" ? "a string" : `a ${typeof value}`;
}

const CLASSIFIER_CONTEXT_SHAPE =
	'{ state: { ... }, questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest>, ..., <highest>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } }';

/** Check a script's classifier context, so mistakes fail before the provider call. */
export function checkClassifierContext(context: unknown): ClassifierContextValue {
	const fail = (problem: string) => new Error(`models.classify() got an invalid context: ${problem}. Shape: ${CLASSIFIER_CONTEXT_SHAPE}.`);
	if (!isRecord(context)) throw fail(`the second argument must be a context object, got ${describeValue(context)}`);
	if (!isRecord(context.state)) throw fail(`context.state must be an object, got ${describeValue(context.state)}`);
	if (!isRecord(context.questions) || Object.keys(context.questions).length === 0) throw fail(`context.questions must map question IDs to question objects, got ${describeValue(context.questions)}`);
	for (const [id, question] of Object.entries(context.questions)) checkClassifierQuestion(fail, `context.questions.${id}`, question);
	return context as unknown as ClassifierContextValue;
}

function checkClassifierQuestion(fail: (problem: string) => Error, at: string, question: unknown): void {
	if (!isRecord(question)) throw fail(`${at} must be a question object, got ${describeValue(question)}`);
	if (typeof question.instructions !== "string") throw fail(`${at}.instructions must be a string`);
	const criteria = question.criteria;
	const isStrings = (values: readonly unknown[]) => values.length > 0 && values.every((value) => typeof value === "string");
	if (question.type === "choice") {
		if (!isRecord(criteria) || !isStrings(Object.values(criteria))) throw fail(`${at} is a "choice" question, so criteria must map each label to its meaning`);
		return;
	}
	if (question.type === "score") {
		if (!Array.isArray(criteria) || !isStrings(criteria)) throw fail(`${at} is a "score" question, so criteria must list the levels as strings, lowest first`);
		return;
	}
	if (question.type === "bool") {
		if (!isRecord(criteria) || typeof criteria.true !== "string" || typeof criteria.false !== "string") throw fail(`${at} is a "bool" question, so criteria must be { true: string, false: string }`);
		return;
	}
	throw fail(`${at}.type must be "choice", "score", or "bool", got ${JSON.stringify(question.type)}`);
}

/** Check a script's image context, so mistakes such as `{ prompt }` fail before the provider call. */
export function checkImagesContext(context: unknown): ImagesContextValue {
	const fail = (problem: string) => new Error(`models.generateImages() got an invalid context: ${problem}. Shape: { input: [{ type: "text", text }, or { type: "image", data, mimeType }] }.`);
	if (!isRecord(context)) throw fail(`the second argument must be a context object, got ${describeValue(context)}`);
	if (!Array.isArray(context.input) || context.input.length === 0) throw fail(`context.input must be a non-empty array of blocks, got ${describeValue(context.input)}`);
	context.input.forEach((block, index) => {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") return;
		if (isRecord(block) && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") return;
		throw fail(`context.input[${index}] must be a text or image block, got ${describeValue(block)}`);
	});
	return context as unknown as ImagesContextValue;
}

/** The codemode tool description: fixed, so it does not change while MCP servers connect. */
function codemodeDescription(models: boolean): string {
	const lines = [
		CODEMODE_HEADER,
		"Available globals:",
		"- Output: `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and a top-level `return`; `exit()` stops the script successfully.",
		"- State: `store(key, value)` and `load(key)` keep a JSON value for later scripts.",
		"- Discovery: `ALL_TOOLS`, `searchTools(query, { limit?, namespace? })`, `describeTool(name)`, `describeNamespace(name)` reach tools that are not declared, such as MCP tools.",
	];
	if (models) lines.push("- Models: `models` lists and runs classifiers and image models.");
	return lines.join("\n");
}

/** A system message that carries tool declarations. */
function isSystemWithTools(message: Message): message is SystemMessage & { toolsAdded: PiTool[] } {
	return message.role === "system" && (message as SystemMessage).toolsAdded !== undefined;
}

/** The mode-`only` codemode description: every tool a script can call. */
function codemodeOnlyDescription(entries: readonly CallableEntry[]): string {
	const sections = entries.map((entry) => {
		const id = toCodemodeIdentifier(entry.name);
		const heading = id === entry.name ? `### \`${id}\`` : `### \`${id}\` (\`${entry.name}\`)`;
		return `${heading}\n${renderToolSample(entry.declaration).trim()}`;
	});
	return `${codemodeDescription(true)}\n\nNested tools:\n\n${sections.join("\n\n")}`;
}

/** What a script call resolves to: `a string`, an object's fields, or the rendered type. */
function describeOutput(schema: CodemodeJsonSchema): string {
	const type = renderToolOutputType(schema);
	if (type === "string") return "a string";
	const object = typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : undefined;
	const properties = object?.properties;
	if (object?.type === "object" && typeof properties === "object" && properties !== null) {
		const required = new Set(Array.isArray(object.required) ? object.required : []);
		const fields = Object.keys(properties).map((name) => (required.has(name) ? name : `${name}?`));
		return `\`{ ${fields.join(", ")} }\``;
	}
	return `\`${type.replace(/\s+/g, " ")}\``;
}

/** How one script treated one call, for the tool details. */
interface ScriptCallRecord {
	readonly name: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs: number;
}

interface ScriptRun {
	readonly calls: ScriptCallRecord[];
	usage: Usage | undefined;
	generatedImages: number;
}

function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

function addUsage(run: ScriptRun, usage: Usage | undefined): void {
	if (usage !== undefined) run.usage = run.usage === undefined ? usage : combineUsage(run.usage, usage);
}

function valueText(value: unknown): string {
	return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

/** The failure text of a script, with the calls it made before failing. */
function scriptErrorText(result: CodemodeResult, run: ScriptRun): string {
	if (result.ok) return "";
	const header = result.error.kind === "script" ? (result.error.stack ?? `${result.error.name ?? "Error"}: ${result.error.message}`) : `${result.error.kind}: ${result.error.message}`;
	const madeCalls = run.calls.length === 0 ? "No tool calls were made." : `Calls already made are not undone: ${run.calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
	return `Script error:\n${header}\n\n${madeCalls}`;
}

/** Resolve the model argument of `models.classify()`/`models.generateImages()`. */
function resolveModelArgument(name: string, kind: "classifier" | "image", model: unknown, models: CodemodeModelRuntime): unknown {
	const listHint = `List the ${kind} models you can use with models.getAvailableOfType("${kind}").`;
	const modelRecord = isRecord(model) ? model : undefined;
	if (modelRecord === undefined || typeof modelRecord.provider !== "string" || typeof modelRecord.id !== "string") {
		const undefinedHint = model === undefined || model === null ? " models.getModelOfType() returns undefined for an unknown provider or id." : "";
		throw new Error(`${name}() needs a ${kind} model object with provider and id, got ${describeValue(model)}.${undefinedHint} ${listHint}`);
	}
	const provider = modelRecord.provider;
	const id = modelRecord.id;
	const resolved = models.getModelOfType(kind, provider, id);
	if (resolved !== undefined) return resolved;
	const other = MODEL_KINDS.find((candidate) => candidate !== kind && models.getModelOfType(candidate, provider, id) !== undefined);
	throw new Error(other === undefined ? `Unknown ${kind} model "${provider}/${id}". ${listHint}` : `"${provider}/${id}" is ${withArticle(other)} model, not ${withArticle(kind)} model. ${listHint}`);
}

/** Catalog entry for scripts; `headers` is dropped because a model entry can carry credentials. */
function toModelInfo(model: unknown): Record<string, unknown> {
	const info = { ...(model as Record<string, unknown>) };
	delete info.headers;
	return info;
}

/** The script's view of one nested call result. */
function toScriptValue(entry: CallableEntry, result: NestedCallResult | undefined, fallbackError?: string): JsonValue {
	const structured = (result?.details as { structuredContent?: JsonValue } | undefined)?.structuredContent;
	if (entry.structured && structured !== undefined) return structured;
	const text = result === undefined ? "" : diagnosticText(result);
	if (result?.isError === true || result === undefined) throw new Error(text || fallbackError || `Tool "${entry.name}" failed`);
	return text;
}

/** Search text of one callable entry. */
function searchText(entry: CallableEntry): string {
	const parts = [entry.name, entry.name.replace(/_/g, " "), entry.description];
	parts.push(...schemaTerms(entry.declaration.inputSchema));
	if (entry.namespace !== undefined) parts.push(entry.namespace.name, entry.namespace.description ?? "", entry.namespace.instructions ?? "");
	return parts.filter((part) => part !== "").join("\n");
}

/** Whether `query` names a namespace directly or by its suffix. */
function isNamespaceName(namespace: string, query: string): boolean {
	const identifier = toCodemodeIdentifier(namespace);
	const queryIdentifier = toCodemodeIdentifier(query);
	const suffix = (name: string) => (name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : undefined);
	return namespace === query || identifier === queryIdentifier || suffix(namespace) === query || suffix(identifier) === queryIdentifier;
}

function truncateLine(text: string, max: number): string {
	const first = (text.split("\n", 1)[0] ?? "").trim();
	if (first.length <= max) return first;
	return max <= 1 ? "" : `${first.slice(0, max - 1).trimEnd()}…`;
}

function hasIndirectTools(config: McpServerConfig): boolean {
	const exposures = configuredExposures(config);
	return exposures.has("codemode") || exposures.has("deferred");
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
		content: [...limited.content],
		details: { server: server ?? "", tool, ...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }), structuredContent: payload },
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

// ─── The execution runtime ──────────────────────────────────────────────────

interface McpCatalogItem {
	readonly entry: CallableEntry;
	readonly tool: NestedTool;
	readonly server: string;
	readonly exposure: McpExposure;
}

/**
 * Native codemode and MCP support for one Durable session host. The services bootstrap calls
 * `createDurableExecution(host)` and installs `extensions`.
 */
class DurableExecutionRuntime implements DurableExecution {
	readonly extensions: readonly Durable.Extension[];
	readonly ready: Promise<void>;
	private readonly host: DurableExecutionHost;
	private readonly durable: typeof Durable;
	private readonly callTask: Durable.Task<NestedCallInput, NestedCallCheckpoint, NestedCallResult, Durable.ToolHooks>;
	private readonly store: Durable.RewindableConversationDocToken<{ values: Record<string, JsonValue> }>;
	private readonly liveTools: NestedTool[] = [];
	private readonly mcpTools = new Map<string, McpCatalogItem>();
	private readonly resourceTools: NestedTool[];
	private readonly servers: McpServerConnection[] = [];
	private readonly loaded = new Set<string>();
	private readonly authStore: McpAuthFileStore;
	private resourceExposure: McpExposure | "hidden" = "hidden";
	private readonly abortControllers = new Map<Durable.TaskId<unknown>, AbortController>();
	private readonly wasm = loadQuickJSWasm();
	private readonly readyTimeoutMs: number;
	private readonly closeOnHostAbort = () => void this.close();
	private closed = false;

	constructor(host: DurableExecutionHost, options: DurableExecutionOptions = {}) {
		this.host = host;
		this.durable = host.durable;
		this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		this.store = this.durable.defineDoc({
			kind: STORE_KIND,
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ values: {} as Record<string, JsonValue> }),
		});
		this.callTask = this.defineCallTask();
		this.authStore = new McpAuthFileStore(join(host.agentDir, "mcp-auth.json"));
		this.resourceTools = this.defineResourceTools();
		const activation = computeActivation(host);
		if (activation.codemode) this.liveTools.push(this.defineCodemodeTool());
		if (activation.toolSearch) this.liveTools.push(this.defineToolSearchTool());
		this.extensions = this.buildExtensions(activation);
		if (host.signal.aborted) void this.close();
		else host.signal.addEventListener("abort", this.closeOnHostAbort, { once: true });
		for (const server of activation.servers) {
			const connection = new McpServerConnection(server, host.cwd, () => this.rebuildMcpTools(), createServerAuthProvider(server, this.authStore, host.services.modelRuntime));
			this.servers.push(connection);
		}
		this.ready = this.waitForDirectServers();
	}

	/** Resolve when the initial direct-exposure servers settled, bounded by `readyTimeoutMs`. */
	private async waitForDirectServers(): Promise<void> {
		const pending = this.servers.filter((server) => configuredExposures(server.entry.config).has("direct")).map((server) => server.ready);
		if (pending.length === 0 || this.readyTimeoutMs <= 0) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, this.readyTimeoutMs);
			(timer as { unref?: () => void }).unref?.();
			void Promise.all(pending).then(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	/** Build the contribution extension from the tools, tasks, and sections the activation selected. */
	private buildExtensions(activation: Activation): readonly Durable.Extension[] {
		const sections: Durable.PromptSection[] = [];
		if (activation.codemode) {
			sections.push(
				this.durable.section("codemode", () =>
					["## Codemode", "- Run JavaScript that calls other tools.", "- Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls."].join("\n"),
				),
			);
		}
		if (activation.indirect) sections.push(this.durable.section(MCP_SERVERS_SECTION, () => this.renderServersSection()));
		const hooks: Durable.HookRegistration[] = [];
		if (activation.codemode) {
			hooks.push(
				this.durable.hook(this.durable.GenerationTask, {
					beforeRequest: (request) => {
						const messages = this.applyCodemodeMode(request.messages);
						return messages === undefined ? undefined : { messages };
					},
				}),
			);
		}
		if (this.liveTools.length === 0 && sections.length === 0) return [];
		return [
			this.durable.defineExtension({
				name: EXTENSION_NAME,
				tools: this.liveTools,
				sections,
				...(hooks.length === 0 ? {} : { hooks }),
				...(activation.codemode ? { tasks: [this.callTask] } : {}),
			}),
		];
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.host.signal.removeEventListener("abort", this.closeOnHostAbort);
		for (const controller of this.abortControllers.values()) controller.abort(new Error("durable execution is closed"));
		this.abortControllers.clear();
		await Promise.all(this.servers.map((server) => server.close()));
	}

	// ── MCP catalog ────────────────────────────────────────────────────────

	/** Rebuild the script-visible MCP entries after a connection or tool-list change. */
	private rebuildMcpTools(): void {
		if (this.closed) return;
		this.mcpTools.clear();
		for (const server of this.servers) {
			const tools = [...new Map(server.tools.map((tool) => [tool.name, tool])).values()];
			const plain = [...new Set(tools.map((tool) => tool.name))].map((name) => createMcpToolName(server.entry.name, name));
			const owners = new Map<string, string>();
			for (const tool of tools) {
				const exposure = getToolExposure(server.entry.config, tool.name);
				if (exposure === "hidden") continue;
				const owner = `${server.entry.name}\0${tool.name}`;
				const name = createMcpToolName(server.entry.name, tool.name, (candidate) => {
					const existing = owners.get(candidate);
					return (existing !== undefined && existing !== owner) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate);
				});
				owners.set(name, owner);
				const registration = this.defineMcpTool(server, tool, name);
				const namespace: McpNamespace = {
					name: mcpNamespace(server.entry.name),
					...(server.entry.config.description === undefined ? {} : { description: server.entry.config.description }),
					...(server.instructions === undefined ? {} : { instructions: server.instructions }),
				};
				this.mcpTools.set(name, { entry: entryOf(registration, namespace), tool: registration, server: server.entry.name, exposure });
			}
		}
		this.resourceExposure = this.computeResourceExposure();
		this.syncRegisteredTools();
	}

	/** Enabled servers with resources whose exposure is not `hidden`, which the resource tools reach. */
	private resourceServers(): McpServerConnection[] {
		return this.servers.filter((server) => server.hasResources && server.entry.config.exposure !== "hidden");
	}

	/** Widest exposure of the reachable resource servers: `direct`, then `codemode`, then `deferred`. */
	private computeResourceExposure(): McpExposure | "hidden" {
		const exposures = new Set(this.resourceServers().map((server) => server.entry.config.exposure ?? "codemode"));
		if (exposures.has("direct")) return "direct";
		if (exposures.has("codemode")) return "codemode";
		if (exposures.has("deferred")) return "deferred";
		return "hidden";
	}

	/** Keep `direct` tools, the resource tools, and `tool_search`-loaded tools in the live registry list. */
	private syncRegisteredTools(): void {
		const wanted = this.wantedRegisteredTools();
		const managed = new Set([...this.mcpTools.keys(), ...this.resourceTools.map((tool) => tool.name)]);
		for (let index = this.liveTools.length - 1; index >= 0; index--) {
			const tool = this.liveTools[index];
			if (tool !== undefined && managed.has(tool.name) && !wanted.has(tool.name)) this.liveTools.splice(index, 1);
		}
		const present = new Set(this.liveTools.map((tool) => tool.name));
		for (const name of wanted) {
			if (present.has(name)) continue;
			const tool = this.mcpTools.get(name)?.tool ?? this.resourceTools.find((candidate) => candidate.name === name);
			if (tool !== undefined) this.liveTools.push(tool);
		}
	}

	private wantedRegisteredTools(): Set<string> {
		const wanted = new Set<string>();
		for (const [name, item] of this.mcpTools) if (item.exposure === "direct" || this.loaded.has(name)) wanted.add(name);
		for (const tool of this.resourceTools) if (this.resourceExposure === "direct" || this.loaded.has(tool.name)) wanted.add(tool.name);
		return wanted;
	}

	/** MCP and resource tools a script may call, whether or not the model sees them. */
	private scriptOnlyEntries(): CallableEntry[] {
		return [...this.mcpTools.values()].map((item) => item.entry).concat(this.resourceExposure === "hidden" ? [] : this.resourceTools.map((tool) => entryOf(tool)));
	}

	/** Tools `tool_search` may load: not declared yet and reachable through codemode or tool_search. */
	private searchableEntries(): CallableEntry[] {
		const candidates = this.scriptOnlyEntries().filter((entry) => {
			const item = this.mcpTools.get(entry.name);
			return item !== undefined && item.exposure !== "direct";
		});
		if (this.resourceExposure === "codemode" || this.resourceExposure === "deferred") {
			for (const tool of this.resourceTools) candidates.push(entryOf(tool));
		}
		return candidates.filter((entry) => !this.loaded.has(entry.name));
	}

	/** Load one tool into the registry after `tool_search` matched it. */
	private loadToolSearchMatch(name: string): boolean {
		const known = this.mcpTools.get(name)?.tool ?? this.resourceTools.find((tool) => tool.name === name);
		if (known === undefined || this.loaded.has(name)) return false;
		this.loaded.add(name);
		this.syncRegisteredTools();
		return true;
	}

	// ── Scripts ────────────────────────────────────────────────────────────

	/** Wait for the servers a script names, or for all servers when it searches or enumerates. */
	async waitForScriptServers(code: string, context: Context): Promise<void> {
		const wantsAll = /\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/.test(code);
		const waiting = this.servers.filter((server) => wantsAll || code.includes(mcpNamespace(server.entry.name)));
		await Promise.all(waiting.map((server) => server.ready));
		context.abortSignal?.throwIfAborted();
	}

	async waitForAllServers(context: Context): Promise<void> {
		await Promise.all(this.servers.map((server) => server.ready));
		context.abortSignal?.throwIfAborted();
	}

	/** All tools a script may call: the model's tools plus the not-yet-declared MCP tools. */
	private async callableEntries(api: Durable.ToolExecutionApi, context: Context): Promise<CallableEntry[]> {
		const agent = await api.agent(context);
		const entries = new Map<string, CallableEntry>();
		for (const tool of agent.tools) {
			if (tool.name === CODEMODE_TOOL_NAME) continue;
			entries.set(tool.name, entryOf(tool as NestedTool));
		}
		for (const entry of this.scriptOnlyEntries()) if (!entries.has(entry.name)) entries.set(entry.name, entry);
		return [...entries.values()];
	}

	/** Resolve one script call to a registry tool, an MCP catalog tool, or a resource tool. */
	private async resolveTool(runtime: NestedRuntime, name: string, context: Context): Promise<NestedTool | undefined> {
		const agent = await runtime.agent(context);
		const registered = agent.tools.find((tool) => tool.name === name);
		if (registered !== undefined) return registered as NestedTool;
		return this.mcpTools.get(name)?.tool ?? this.resourceTools.find((tool) => tool.name === name);
	}

	/** Run one nested call as an owned durable task and return its result. */
	async callTool(sandbox: { api: Durable.ToolExecutionApi; context: Context; run: ScriptRun }, name: string, args: JsonValue, callSignal: AbortSignal): Promise<JsonValue> {
		if (this.closed) throw new Error("durable execution is closed");
		callSignal.throwIfAborted();
		const entry = (await this.callableEntries(sandbox.api, sandbox.context)).find((candidate) => candidate.name === name);
		if (entry === undefined) throw new Error(`Tool "${name}" is not available`);
		const callId = `${sandbox.api.callId}/${sandbox.run.calls.length + 1}`;
		const startedAt = performance.now();
		const record: ScriptCallRecord = { name, status: "running", durationMs: 0 };
		sandbox.run.calls.push(record);
		const controller = new AbortController();
		const taskId = await sandbox.api.createTask(
			this.callTask,
			{ callId, name, arguments: args },
			{ ownership: { kind: "task", taskId: sandbox.api.taskId } },
			sandbox.context,
		);
		this.abortControllers.set(taskId, controller);
		let settled: Durable.SettledTask<NestedCallResult>;
		try {
			settled = await sandbox.api.waitForTask(taskId, withAbortSignal(callSignal, sandbox.context));
		} catch {
			controller.abort(new Error(`Tool "${name}" was cancelled`));
			record.status = "cancelled";
			record.durationMs = performance.now() - startedAt;
			throw new Error(`Tool "${name}" was cancelled because the script call ended`);
		} finally {
			this.abortControllers.delete(taskId);
		}
		record.durationMs = performance.now() - startedAt;
		const outcome = settled.state.outcome;
		const result = "result" in outcome ? outcome.result : undefined;
		addUsage(sandbox.run, result?.usage);
		record.status = outcome.status === "completed" ? "ok" : "error";
		return toScriptValue(entry, result, outcome.status === "completed" ? undefined : `Tool "${name}" did not complete (${outcome.status})`);
	}

	// ── Codemode sandbox ───────────────────────────────────────────────────

	/** The script's discovery globals and the `models` namespace. */
	private sandboxGlobals(entries: CallableEntry[], run: ScriptRun): CodemodeTool[] {
		const samples = new Map(entries.map((entry) => [entry.name, renderToolSample(entry.declaration)]));
		const entryList = entries.map((entry) => ({ name: toCodemodeIdentifier(entry.name), description: samples.get(entry.name) ?? "" }));
		const globals: CodemodeTool[] = [
			{
				name: "searchTools",
				spread: true,
				execute: (args: unknown) => {
					const [query, options] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
					if (typeof query !== "string") throw new Error("searchTools() expects a query string");
					const limit = options?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
					if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) throw new Error("searchTools() limit must be a positive integer");
					const namespace = options?.namespace;
					if (namespace !== undefined && namespace !== null && typeof namespace !== "string") throw new Error("searchTools() namespace must be a string");
					const documents = entries
						.filter((entry) => namespace === undefined || namespace === null || (entry.namespace !== undefined && isNamespaceName(entry.namespace.name, namespace)))
						.map((entry) => ({ name: entry.name, text: searchText(entry) }));
					return ranker.rank(query, documents, limit).map((document) => entryList.find((candidate) => candidate.name === toCodemodeIdentifier(document.name)) ?? { name: toCodemodeIdentifier(document.name), description: "" });
				},
			},
			{
				name: "describeTool",
				spread: true,
				execute: (args: unknown) => {
					const [name] = args as [unknown];
					if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
					const entry = entries.find((candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name);
					return entry === undefined ? undefined : samples.get(entry.name);
				},
			},
			{
				name: "describeNamespace",
				spread: true,
				execute: (args: unknown) => {
					const [name] = args as [unknown];
					if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
					const matches = entries.filter((entry) => entry.namespace !== undefined && isNamespaceName(entry.namespace.name, name));
					const namespace = matches[0]?.namespace;
					if (namespace === undefined) return undefined;
					return {
						name: namespace.name,
						...(namespace.description === undefined ? {} : { description: namespace.description }),
						...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
						tools: matches.map((entry) => toCodemodeIdentifier(entry.name)),
					};
				},
			},
			...this.modelGlobals(run),
		];
		return globals;
	}

	/** `models.*` for scripts, backed by the session model runtime. */
	private modelGlobals(run: ScriptRun): CodemodeTool[] {
		const models = this.host.services.modelRuntime as CodemodeModelRuntime;
		let active = 0;
		const waiting: (() => void)[] = [];
		const limit = async <T>(job: () => Promise<T>): Promise<T> => {
			if (active >= MAX_CONCURRENT_MODEL_CALLS) await new Promise<void>((resolve) => waiting.push(resolve));
			active++;
			try {
				return await job();
			} finally {
				active--;
				waiting.shift()?.();
			}
		};
		const runCall = async (
			name: string,
			kind: "classifier" | "image",
			model: unknown,
			context: unknown,
			options: { signal?: AbortSignal } | undefined,
			execute: (resolved: unknown, checked: unknown, callOptions?: { signal?: AbortSignal }) => Promise<{ stopReason?: string; usage?: Usage }>,
		): Promise<unknown> => {
			const resolved = resolveModelArgument(name, kind, model, models);
			if (kind === "classifier") checkClassifierContext(context);
			else checkImagesContext(context);
			const record: ScriptCallRecord = { name, status: "running", durationMs: 0 };
			run.calls.push(record);
			const startedAt = performance.now();
			const result = await limit(() => execute(resolved, context, options));
			record.durationMs = performance.now() - startedAt;
			record.status = result.stopReason === "stop" ? "ok" : result.stopReason === "aborted" ? "cancelled" : "error";
			addUsage(run, result.usage);
			return result;
		};
		return [
			{
				name: "models.getModelsOfType",
				spread: true,
				execute: (args) => {
					const [type, provider] = args as [unknown, unknown];
					return models.getModelsOfType(toModelKind(type), toProvider(provider)).map(toModelInfo);
				},
			},
			{
				name: "models.getAvailableOfType",
				spread: true,
				execute: async (args) => {
					const [type, provider, options] = args as [unknown, unknown, { signal?: AbortSignal } | undefined];
					const available = await models.getAvailableOfType(toModelKind(type), toProvider(provider), options as never);
					return available.map(toModelInfo);
				},
			},
			{
				name: "models.getModelOfType",
				spread: true,
				execute: (args) => {
					const [type, provider, id] = args as [unknown, unknown, unknown];
					if (typeof provider !== "string" || typeof id !== "string") {
						throw new Error(`models.getModelOfType(type, provider, id) expects three strings, got (${[type, provider, id].map(describeValue).join(", ")}). The provider and the id are separate arguments.`);
					}
					return models.getModelOfType(toModelKind(type), provider, id);
				},
			},
			{
				name: "models.classify",
				spread: true,
				execute: async (args) => {
					const [model, classifierContext, options] = args as [unknown, unknown, { signal?: AbortSignal } | undefined];
					return await runCall("models.classify", "classifier", model, classifierContext, options, (resolved, checked, callOptions) =>
						models.classify(resolved as Parameters<CodemodeModelRuntime["classify"]>[0], checked as never, callOptions),
					);
				},
			},
			{
				name: "models.generateImages",
				spread: true,
				execute: async (args) => {
					const [model, imagesContext, options] = args as [unknown, unknown, { signal?: AbortSignal } | undefined];
					const result = (await runCall("models.generateImages", "image", model, imagesContext, options, (resolved, checked, callOptions) =>
						models.generateImages(resolved as Parameters<CodemodeModelRuntime["generateImages"]>[0], checked as never, callOptions),
					)) as { output?: readonly { type: string }[] };
					run.generatedImages += (result.output ?? []).filter((block) => block.type === "image").length;
					return result;
				},
			},
		];
	}

	/** Run one script in a fresh sandbox and return the tool result. */
	async executeScript(args: { code: string }, api: Durable.ToolExecutionApi, context: Context): Promise<Durable.ToolExecutionResult<JsonValue>> {
		const startedAt = performance.now();
		const { code, options } = parseCodemodeSource(args.code);
		await this.waitForScriptServers(code, context);
		const entries = await this.callableEntries(api, context);
		const run: ScriptRun = { calls: [], usage: undefined, generatedImages: 0 };
		const sandbox = new CodemodeSandbox({
			tools: entries.map((entry) => ({
				name: entry.name,
				description: renderToolSample(entry.declaration),
				execute: async (rawArgs, toolContext) => this.callTool({ api, context, run }, entry.name, rawArgs as JsonValue, toolContext.signal),
			})),
			globals: this.sandboxGlobals(entries, run),
			timeoutMs: options.timeoutMs ?? Number.POSITIVE_INFINITY,
			memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
			wasm: this.wasm,
		});
		const result = await this.runSandbox(sandbox, code, api, context);
		for (const call of run.calls) if (call.status === "running") call.status = "cancelled";
		if (result.ok) await this.writeStore(api, context, result.storeWrites);
		return await this.scriptResult(result, run, options.maxOutputTokens, startedAt);
	}

	private async runSandbox(sandbox: CodemodeSandbox, code: string, api: Durable.ToolExecutionApi, context: Context): Promise<CodemodeResult> {
		try {
			return await sandbox.execute(code, { signal: context.abortSignal, store: await this.readStore(api, context) });
		} finally {
			await sandbox.close().catch(() => undefined);
		}
	}

	/** Store values of the branch, for `load()`. */
	private async readStore(api: Durable.ToolExecutionApi, context: Context): Promise<Record<string, JsonValue>> {
		const document = await api.snapshot(this.store, api.conversationId, context);
		return document?.values ?? {};
	}

	/** Persist `store()` writes of a successful script. */
	private async writeStore(api: Durable.ToolExecutionApi, context: Context, writes: { set: Record<string, unknown>; delete: string[] }): Promise<void> {
		if (Object.keys(writes.set).length === 0 && writes.delete.length === 0) return;
		await api.commit(async (tx) => {
			const document = await tx.doc(this.store, api.conversationId);
			for (const key of writes.delete) delete document.values[key];
			for (const [key, value] of Object.entries(writes.set)) {
				if (JSON.stringify(value).length > MAX_STORE_VALUE_CHARS) throw new Error(`store("${key}") exceeds ${MAX_STORE_VALUE_CHARS} characters`);
				document.values[key] = value as JsonValue;
			}
			if (JSON.stringify(document.values).length > MAX_STORE_TOTAL_CHARS) throw new Error(`the codemode store exceeds ${MAX_STORE_TOTAL_CHARS} characters`);
		}, context);
	}

	/** Turn the sandbox result into the tool result the model sees. */
	private async scriptResult(result: CodemodeResult, run: ScriptRun, maxOutputTokens: number | undefined, startedAt: number): Promise<Durable.ToolExecutionResult<JsonValue>> {
		const items = this.scriptItems(result, run);
		const bounded = await this.boundOutput(items, maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
		const details: Record<string, JsonValue> = { calls: run.calls.map((call) => ({ name: call.name, status: call.status, durationMs: Math.round(call.durationMs) })) };
		if (bounded.fullOutputPath !== undefined) details.fullOutputPath = bounded.fullOutputPath;
		const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
		return {
			content: [{ type: "text", text: `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n` }, ...bounded.items],
			details,
			...(run.usage === undefined ? {} : { usage: run.usage }),
			...(result.ok ? {} : { isError: true }),
		};
	}

	/** Script output items, including the returned value, the failure, and an unshown-image note. */
	private scriptItems(result: CodemodeResult, run: ScriptRun): (TextContent | ImageContent)[] {
		const items: (TextContent | ImageContent)[] = result.output.map((item) => (item.type === "text" ? { type: "text", text: item.text } : { type: "image", data: item.data, mimeType: item.mimeType }));
		if (result.ok) {
			if (result.value !== undefined) items.push({ type: "text", text: valueText(result.value) });
		} else {
			items.push({ type: "text", text: scriptErrorText(result, run) });
		}
		if (run.generatedImages > 0 && !items.some((item) => item.type === "image")) {
			items.push({
				type: "text",
				text: `Note: ${run.generatedImages} generated image${run.generatedImages === 1 ? "" : "s"} were not shown. Call image(block) for each image block of result.output.`,
			});
		}
		return items;
	}

	/** Apply the token budget: text over it keeps its start and end and spills the full text. */
	private async boundOutput(items: (TextContent | ImageContent)[], maxTokens: number): Promise<{ items: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
		const combined = items.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
		/** Plain text counts characters; the budget is in estimated tokens. */
		const budget = maxTokens * CHARS_PER_TOKEN;
		if (combined === "" || combined.length <= budget) return { items };
		const head = combined.slice(0, Math.floor(budget / 2));
		const tail = combined.slice(-Math.max(0, budget - Math.floor(budget / 2)));
		let fullOutputPath: string | undefined;
		let where: string;
		try {
			fullOutputPath = await saveToTempFile(combined, ".txt");
			where = `[Complete output: ${fullOutputPath} (read with offset/limit)]`;
		} catch (error) {
			where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
		}
		const text = `Output was truncated (about ${Math.ceil(combined.length / CHARS_PER_TOKEN)} tokens originally, ${combined.split("\n").length} lines):\n\n${head}…${Math.ceil((combined.length - head.length - tail.length) / CHARS_PER_TOKEN)} tokens omitted…${tail}\n\n${where}`;
		return { items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")], ...(fullOutputPath === undefined ? {} : { fullOutputPath }) };
	}

	// ── Tool definitions ───────────────────────────────────────────────────

	private defineCallTask(): Durable.Task<NestedCallInput, NestedCallCheckpoint, NestedCallResult, Durable.ToolHooks> {
		const toolCall = (input: NestedCallInput): ToolCall => ({ type: "toolCall", id: input.callId, name: input.name, arguments: input.arguments as JsonObject });
		const settle = async (taskRuntime: NestedRuntime, context: Context, result: NestedCallResult, status: "completed" | "failed" | "aborted", message?: string): Promise<void> => {
			await taskRuntime.commit(async () => {
				if (status === "aborted") return { status: "terminal" as const, outcome: { status: "aborted" as const, reason: message, result } };
				if (status === "failed") return { status: "terminal" as const, outcome: { status: "failed" as const, error: { message: message ?? "nested call failed" }, result } };
				return { status: "terminal" as const, outcome: { status: "completed" as const, result } };
			}, context);
		};
		const run = async (taskRuntime: NestedRuntime, context: Context, call: ToolCall, tool: NestedTool, argumentObject: JsonObject): Promise<void> => {
			const local = this.abortControllers.get(taskRuntime.taskId);
			const toolContext = local === undefined ? context : withAbortSignal(local.signal, context);
			const env = await taskRuntime.env(context);
			const collectors: ToolCollectors = { output: [], details: undefined, diagnostics: [] };
			let result: NestedCallResult;
			let failed: string | undefined;
			try {
				result = toolResultOf(await tool.execute(argumentObject, nestedToolApi(taskRuntime, call.id, env, collectors), toolContext), collectors);
			} catch (error) {
				if (taskRuntime.signal.aborted) throw error;
				failed = `Tool ${call.name} threw`;
				result = errorResult("tool_error", errorText(error));
			}
			let final = result;
			await eachToolTaskHook(taskRuntime, context, "afterTool", async (handler) => {
				final = ((await handler(call, final as Durable.ToolExecutionResult, taskRuntime, context)) as NestedCallResult | undefined) ?? final;
			});
			await settle(taskRuntime, context, final, failed === undefined ? "completed" : "failed", failed);
		};
		return this.durable.defineTask<NestedCallInput, NestedCallCheckpoint, NestedCallResult, Durable.ToolHooks>({
			name: TASK_NAME,
			version: 1,
			initial: () => ({ phase: "call" }),
			phases: {
				call: async (task, taskRuntime, context) => {
					const call = toolCall(task.input);
					const tool = await this.resolveTool(taskRuntime, task.input.name, context);
					if (tool === undefined) {
						await settle(taskRuntime, context, errorResult("tool_unavailable", `Tool ${task.input.name} is not available`), "completed");
						return;
					}
					const repaired = repairArguments(tool, task.input.arguments);
					const initial = "error" in repaired ? repaired : validateArguments(tool, call, repaired.args);
					if ("error" in initial) {
						await settle(taskRuntime, context, errorResult("invalid_arguments", initial.error), "completed");
						return;
					}
					const decided = await resolveBeforeTool(taskRuntime, context, call, initial.args);
					const args = decided.args;
					if (decided.block !== undefined) {
						await settle(taskRuntime, context, errorResult("blocked", `Tool call blocked: ${decided.block}`), "completed");
						return;
					}
					const validated = validateArguments(tool, call, args);
					if ("error" in validated) {
						await settle(taskRuntime, context, errorResult("invalid_arguments", validated.error), "completed");
						return;
					}
					const finalArgs = validated.args;
					const replay = tool.replay ?? "unsafe";
					await taskRuntime.commit(async () => ({ status: "running" as const, checkpoint: { phase: "execute" as const, arguments: finalArgs, replay } }), context);
					await run(taskRuntime, context, call, tool, finalArgs);
				},
				execute: async (task, taskRuntime, context) => {
					const checkpoint = task.state.checkpoint;
					const call = toolCall(task.input);
					const tool = await this.resolveTool(taskRuntime, task.input.name, context);
					if (checkpoint.replay === "safe" && tool?.replay === "safe") {
						await run(taskRuntime, context, call, tool, checkpoint.arguments);
						return;
					}
					const message = `Tool ${task.input.name} was interrupted and may have partially run`;
					await settle(taskRuntime, context, errorResult("interrupted", message), "failed", message);
				},
			},
			abort: async (task, taskRuntime, context) => {
				const message = `Tool ${task.input.name} was aborted`;
				await settle(taskRuntime, context, errorResult("aborted", message), "aborted", message);
			},
		});
	}

	private defineCodemodeTool(): NestedTool {
		return {
			...this.durable.defineTool({
				name: CODEMODE_TOOL_NAME,
				description: codemodeDescription(true),
				parameters: Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) }),
				replay: "unsafe",
				execute: async (args, api, context) => this.executeScript(args, api, context),
			}),
		};
	}

	private defineToolSearchTool(): NestedTool {
		return {
			...this.durable.defineTool({
				name: TOOL_SEARCH_TOOL_NAME,
				description:
					"# Tool discovery\n\nFind a tool that is not declared to you and make it available for your next request. Matches are ranked by relevance.\n\nMCP tools and other deferred tools are often reachable only this way, so use `tool_search` to find them.",
				parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
				replay: "safe",
				execute: async (args, api, context) => {
					await this.waitForAllServers(context);
					const available = this.searchableEntries();
					const samples = new Map(available.map((entry) => [entry.name, renderToolSample(entry.declaration)]));
					const documents: SearchDocument[] = available.map((entry) => ({ name: entry.name, text: searchText(entry) }));
					const matches = ranker.rank(args.query, documents, args.limit ?? DEFAULT_TOOL_SEARCH_LIMIT);
					const loadedTools = matches.filter((document) => this.loadToolSearchMatch(document.name));
					void api;
					const details: Record<string, JsonValue> = { loaded: loadedTools.map((document) => document.name), tools: loadedTools.flatMap((document) => (samples.get(document.name) === undefined ? [] : [{ name: document.name, description: samples.get(document.name) as string }])) };
					return {
						content: [{ type: "text", text: loadedTools.length === 0 ? "No matching tools found." : loadedTools.map((document) => `- ${document.name}`).join("\n") }],
						details: { structuredContent: details },
						...(loadedTools.length === 0 ? {} : { control: { addTools: loadedTools.map((document) => document.name) } }),
					};
				},
			}),
		};
	}

	// ── Resource tools ─────────────────────────────────────────────────────

	private defineResourceTools(): NestedTool[] {
		return [
			{
				name: LIST_MCP_RESOURCES_TOOL,
				description:
					"Show the resources the connected MCP servers publish. A resource can be a file, a schema, or other context a model can use; prefer it over a web search. Omit `server` to list every server, or name one server with a cursor for one page.",
				parameters: RESOURCE_LIST_PARAMETERS,
				outputSchema: RESOURCE_LIST_OUTPUT_SCHEMA,
				replay: "safe",
				execute: (args, _api, context) => this.listResourceTool(LIST_MCP_RESOURCES_TOOL, "resources", args as Record<string, unknown>, context),
			},
			{
				name: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
				description:
					"Show the parameterized resource templates the connected MCP servers publish. Prefer a template over a web search when it covers the data you need.",
				parameters: RESOURCE_LIST_PARAMETERS,
				outputSchema: RESOURCE_TEMPLATES_OUTPUT_SCHEMA,
				replay: "safe",
				execute: (args, _api, context) => this.listResourceTool(LIST_MCP_RESOURCE_TEMPLATES_TOOL, "resourceTemplates", args as Record<string, unknown>, context),
			},
			{
				name: READ_MCP_RESOURCE_TOOL,
				description: "Read one resource by server name and URI, as returned by `list_mcp_resources`.",
				parameters: RESOURCE_READ_PARAMETERS,
				outputSchema: RESOURCE_READ_OUTPUT_SCHEMA,
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
			content: [...limited.content],
			details: {
				server: server.entry.name,
				tool: READ_MCP_RESOURCE_TOOL,
				...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }),
				structuredContent: { server: server.entry.name, uri, contents } as unknown as JsonValue,
			},
		};
	}

	private findResourceServer(name: string, servers: readonly McpServerConnection[]): McpServerConnection {
		const found = servers.find((server) => server.entry.name === name);
		if (found !== undefined) return found;
		const available = servers.map((server) => server.entry.name).join(", ");
		throw new Error(`MCP server "${name}" has no resources${available === "" ? "" : `. Servers with resources: ${available}`}`);
	}

	// ── Codemode presentation mode ─────────────────────────────────────────

	/** Apply the `codemode.mode` setting to one request's declarations without changing the transcript. */
	private applyCodemodeMode(messages: readonly Message[]): readonly Message[] | undefined {
		const declared = getCurrentTools([...messages]);
		if (declared.length === 0) return undefined;
		const mode = this.host.services.settingsManager.getSettings().codemode?.mode ?? "on";
		const callable = declared.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
		return mode === "only" ? this.withOnlyDeclarations(messages, callable) : this.withScriptCallNotes(messages, callable);
	}

	/** `on`: declared callable tools say how scripts call them. */
	private withScriptCallNotes(messages: readonly Message[], callable: readonly PiTool[]): readonly Message[] | undefined {
		const names = new Set(callable.map((tool) => tool.name));
		let changed = false;
		const next = messages.map((message) => {
			if (!isSystemWithTools(message)) return message;
			const toolsAdded = message.toolsAdded?.map((tool) => {
				if (!names.has(tool.name)) return tool;
				const note = this.scriptCallNote(tool.name);
				if (tool.description.includes(note)) return tool;
				changed = true;
				return { ...tool, description: `${tool.description.trimEnd()}\n\n${note}` };
			});
			return toolsAdded === undefined ? message : { ...message, toolsAdded };
		});
		return changed ? next : undefined;
	}

	/** `only`: only the discovery tools stay declared; the codemode description lists every callable tool. */
	private withOnlyDeclarations(messages: readonly Message[], callable: readonly PiTool[]): readonly Message[] | undefined {
		const declaredNames = new Set(callable.map((tool) => tool.name));
		const scriptOnly = this.scriptOnlyEntries().filter((entry) => !declaredNames.has(entry.name));
		const description = codemodeOnlyDescription([...callable.map((tool) => entryOf(tool as NestedTool)), ...scriptOnly]);
		let changed = false;
		const next = messages.map((message) => {
			if (!isSystemWithTools(message)) return message;
			const toolsAdded = message.toolsAdded?.flatMap((tool) => {
				if (tool.name !== CODEMODE_TOOL_NAME && tool.name !== TOOL_SEARCH_TOOL_NAME) {
					changed = true;
					return [];
				}
				if (tool.name !== CODEMODE_TOOL_NAME) return [tool];
				changed = true;
				return [{ ...tool, description }];
			});
			return toolsAdded === undefined ? message : { ...message, toolsAdded };
		});
		return changed ? next : undefined;
	}

	/** What a script call resolves to, for the declared-tool note. */
	private scriptCallNote(name: string): string {
		const schema = this.liveTools.find((tool) => tool.name === name)?.outputSchema ?? DEFAULT_TEXT_OUTPUT_SCHEMA;
		return `Codemode: \`tools.${toCodemodeIdentifier(name)}(args)\` returns ${describeOutput(schema)}.`;
	}

	private defineMcpTool(server: McpServerConnection, tool: McpTool, name: string): NestedTool {
		return {
			name,
			description: tool.description?.trim() || tool.title || `MCP tool ${tool.name} from server ${server.entry.name}`,
			parameters: toParameters(tool.inputSchema),
			outputSchema: createMcpResultSchema(tool.outputSchema as CodemodeJsonSchema | undefined),
			replay: "unsafe",
			execute: async (args, _api, context) => {
				const result = await server.callTool(tool.name, (args ?? {}) as Record<string, unknown>, { signal: context.abortSignal });
				return await convertMcpResult(server.entry.name, tool.name, result);
			},
		};
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
