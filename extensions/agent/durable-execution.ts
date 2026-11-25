/** Native code mode and tool search with configured MCP transports and resource tools. */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Context } from "@earendil-works/chord/context";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, withCancel } from "@earendil-works/chord/context";
import { CodemodeSandbox, parseCodemodeSource } from "@earendil-works/pi-codemode";
import { createCodemodeExtension, createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import type {
	AuthProvider,
	CallToolResult,
	ContentBlock,
	ListResourcesResult,
	ReadResourceResult,
	Resource,
	ResourceTemplate,
	Tool as McpTool,
} from "@earendil-works/pi-mcp";
import {
	createMcpResultSchema,
	createMcpToolName,
	isMcpServerOverride,
	JSON_RPC_ERROR_CODES,
	limitMcpContent,
	mcpNamespace,
	McpClient,
	McpError,
	normalizeMcpInputSchema,
	StdioTransport,
	StreamableHttpTransport,
	toMcpModelContent,
	validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import type {
	AgentSessionServices,
	LoadedMcpConfig,
	McpExposure,
	McpServerConfig,
	McpServerEntry,
} from "@earendil-works/pi-coding-agent";
export type { LoadedMcpConfig, McpExposure, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { obj, opt, str, type Schema } from "@earendil-works/pi-schema";
import {
	QueuedCodemodeSandbox,
	type CodemodeAdmissionFailure,
	type CodemodeAdmissionFailureCode,
} from "./codemode-admission.ts";
import {
	DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS,
	prepareNativeCodemodeArguments,
	replaceCodemodeTimeout,
} from "./codemode-source.ts";
import { guardStdio, McpGuardian } from "./mcp-guardian.ts";
import { NativeMcpAuth } from "./mcp-auth.ts";
import { McpDiscoveryPool, scriptDiscoveryServers } from "./mcp-discovery.ts";

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
const CODEMODE_DEADLINE_MEMO = "agent.codemode.deadline";
/** Declarations the model keeps when `codemode.mode` is `only`: Pi's code mode and discovery tools, and the Agent's model-only compaction tool that scripts cannot call. */
const CODEMODE_ONLY_DECLARATIONS = new Set([CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME, "agent_compact"]);
const DEFAULT_READY_TIMEOUT_MS = 10_000;

const MAX_SERVERS_SECTION_CHARS = 4096;
const MAX_SERVER_DESCRIPTION_CHARS = 250;

type NestedTool = Durable.ToolRegistration;

// ─── MCP configuration ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExposure(value: unknown): value is McpExposure {
	return (
		value === "codemode" ||
		value === "deferred" ||
		value === "direct" ||
		value === "hidden" ||
		value === "codemode-deferred"
	);
}

/** Validate one `mcpServers` entry, returning a copy or an error message. */
function validateServerConfig(name: string, raw: unknown, scope: "global" | "project"): McpServerConfig | string {
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const value: Record<string, unknown> = { ...raw };
	if (value.exposure === "codemode-deferred") value.exposure = "codemode";
	if (value.toolExposure !== undefined) {
		if (!isRecord(value.toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		value.toolExposure = Object.fromEntries(
			Object.entries(value.toolExposure).map(([tool, exposure]) => [
				tool,
				exposure === "codemode-deferred" ? "codemode" : exposure,
			]),
		);
	}
	const structural = validateMcpServerConfig(name, value, {
		checkMetadataDocumentCallback(callbackUrl) {
			if (callbackUrl === undefined) return undefined;
			const callback = new URL(callbackUrl);
			return callback.hostname !== "[::1]" && callback.pathname === "/callback"
				? undefined
				: 'oauth.clientRegistration "cimd" requires a localhost or 127.0.0.1 callback with path /callback';
		},
	});
	if (structural.kind === "invalid") return structural.error;
	if (value.exposure !== undefined && !isExposure(value.exposure)) return `server "${name}": invalid exposure`;
	if (isRecord(value.toolExposure) && !Object.values(value.toolExposure).every((entry) => isExposure(entry))) {
		return `server "${name}": invalid toolExposure`;
	}
	const auth = validateAuthFields(name, value, scope);
	if (typeof auth === "string") return auth;
	return value as unknown as McpServerConfig;
}

function validateAuthFields(name: string, value: Record<string, unknown>, scope: "global" | "project"): true | string {
	const auth = value.auth;
	if (auth !== undefined) {
		if (scope === "project") return `server "${name}": auth is only allowed in the global mcp.json`;
		if (!isRecord(auth) || typeof auth.provider !== "string" || auth.provider === "")
			return `server "${name}": auth.provider must be a provider name`;
	}
	return true;
}

interface McpConfigState {
	readonly servers: Map<string, McpServerEntry>;
	readonly errors: string[];
	autoEnableCodemode?: boolean;
}

const PROJECT_MCP_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

function isMcpSelectionOverride(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && isMcpServerOverride(value);
}

function applyProjectMcpOverride(
	name: string,
	patch: Record<string, unknown>,
	path: string,
	state: McpConfigState,
): void {
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

function readMcpConfigServers(
	servers: Record<string, unknown>,
	path: string,
	scope: "global" | "project",
	state: McpConfigState,
): void {
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
		const clash = [...state.servers.keys()].find(
			(other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
		);
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
		const output = execSync(config.slice(1), {
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
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
function templateStep(
	config: string,
	dollar: number,
	env: Record<string, string | undefined>,
): { text: string; next: number } | undefined {
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

// ─── MCP results ────────────────────────────────────────────────────────────

async function saveToTempFile(data: string | Uint8Array, extension: string): Promise<string> {
	const path = join(tmpdir(), `pi-durable-execution-${randomBytes(8).toString("hex")}${extension}`);
	await writeFile(path, data, { flag: "wx", mode: 0o600 });
	return path;
}

/** Convert one MCP result into a Durable tool result. Scripts read `structuredOutput`. */
export async function convertMcpResult(
	server: string,
	tool: string,
	result: CallToolResult,
	readableResources = false,
): Promise<Durable.ToolExecutionResult<JsonValue>> {
	const converted = await toMcpModelContent(server, result, {
		saveOutput: saveToTempFile,
		...(readableResources ? { readResourceTool: READ_MCP_RESOURCE_TOOL } : {}),
	});
	if (result.isError && !converted.some((block) => block.type === "text" && block.text !== ""))
		converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
	const limited = await limitMcpContent(converted, saveToTempFile);
	const { _meta: _ignored, ...scriptResult } = result;
	return {
		output: limited.content,
		structuredOutput: scriptResult as unknown as JsonValue,
		details: {
			server,
			tool,
			...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }),
		},
		...(result.isError ? { isError: true } : {}),
	};
}

/** MCP input schemas must be objects; some providers reject object schemas without properties. */
function toParameters(schema: unknown): Schema {
	return normalizeMcpInputSchema(isRecord(schema) ? schema : {}) as Schema;
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

/** Build the transport auth for one server from its configured provider or stored OAuth tokens. */
function createServerAuthProvider(
	entry: McpServerEntry,
	auth: NativeMcpAuth,
	modelRuntime: DurableExecutionHost["services"]["modelRuntime"],
): AuthProvider | undefined {
	const { config, name } = entry;
	if (!("url" in config)) return undefined;
	if (config.auth !== undefined) {
		const provider = config.auth.provider;
		return { token: async () => (await modelRuntime.getAuth(provider))?.auth.apiKey };
	}
	const headers = resolveHeaders(config.headers);
	if (headers !== undefined && Object.keys(headers).some((header) => header.toLowerCase() === "authorization"))
		return undefined;
	return auth.provider(name, config, resolveConfigValue);
}

/** A transport error the model can act on, naming the server and how to sign in. */
function mcpTransportError(server: McpServerEntry, error: unknown): Error {
	if (error instanceof McpOAuthAuthorizationRequiredError) {
		return new Error(
			`MCP server "${server.name}" requires sign-in. Run pi mcp login ${server.name} or /mcp login ${server.name} in an interactive session.`,
		);
	}
	return error instanceof Error ? error : new Error(String(error));
}

function createTransport(entry: McpServerEntry, cwd: string, authProvider: AuthProvider | undefined) {
	const { config, name } = entry;
	if ("url" in config) {
		return new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeaders(config.headers),
			...(authProvider === undefined ? {} : { authProvider }),
		});
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

function descriptorKey(tool: McpTool): string {
	return JSON.stringify(tool, (_name, value) =>
		isRecord(value)
			? Object.fromEntries(
					Object.keys(value)
						.sort()
						.map((key) => [key, value[key]]),
				)
			: value,
	);
}

interface DiscoveryAttempt {
	readonly owner: AbortController;
	readonly promise: Promise<void>;
	waiters: number;
}

/** One configured MCP server: connection, reconnection, and tool refresh. */
class McpServerConnection {
	readonly entry: McpServerEntry;
	readonly timeoutMs: number;
	private discovery: DiscoveryAttempt | undefined;
	private catalogKnown = false;
	private catalogRevision = 0;
	tools: McpTool[] = [];
	private toolKeys = new Map<string, string>();
	hasResources = false;
	instructions: string | undefined;
	private readonly cwd: string;
	private client: McpClient | undefined;
	private connecting: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	private disconnecting: Promise<void> | undefined;
	private users = 0;
	private pinned: boolean;
	private closed = false;

	readonly onTools: () => void;
	readonly authProvider: AuthProvider | undefined;
	private readonly guardian: McpGuardian;
	private readonly pool: McpDiscoveryPool;

	constructor(
		entry: McpServerEntry,
		cwd: string,
		onTools: () => void,
		authProvider: AuthProvider | undefined,
		guardian: McpGuardian,
		pool: McpDiscoveryPool,
	) {
		this.guardian = guardian;
		this.pool = pool;
		this.pinned = "url" in entry.config || configuredExposures(entry.config).has("direct");
		this.entry = entry;
		this.cwd = cwd;
		this.onTools = onTools;
		this.authProvider = authProvider;
		this.timeoutMs = (entry.config.timeout ?? 60) * 1000;
	}

	/** Share pending discovery and retain the catalogue when a discovery-only transport is reclaimed. */
	async discover(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (this.catalogKnown) return;
		const attempt = this.discovery?.owner.signal.aborted === false ? this.discovery : this.startDiscovery();
		attempt.waiters++;
		try {
			await awaitWithContext(
				attempt.promise,
				signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
			);
		} finally {
			if (--attempt.waiters === 0) attempt.owner.abort();
		}
	}

	private startDiscovery(): DiscoveryAttempt {
		const owner = new AbortController();
		const promise = this.pool
			.run(
				() =>
					this.use(async () => {
						await this.getClient();
					}),
				owner.signal,
			)
			.finally(() => {
				if (this.discovery?.owner === owner) this.discovery = undefined;
			});
		const attempt = { owner, promise, waiters: 0 };
		this.discovery = attempt;
		return attempt;
	}

	private getClient(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
		const client = this.client?.connectionState === "connected" ? this.client : undefined;
		if (client && this.catalogKnown) return Promise.resolve(client);
		this.opening ??= (client ? this.readToolCatalog(client) : this.waitToOpen()).finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	private async waitToOpen(): Promise<McpClient> {
		await this.disconnecting;
		if (this.closed) throw new Error(`MCP server "${this.entry.name}" is shut down`);
		return this.open();
	}

	toolKey(name: string): string | undefined {
		return this.toolKeys.get(name);
	}

	callTool(
		name: string,
		key: string | undefined,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		return this.withClient((client) => {
			if (key === undefined || this.toolKey(name) !== key)
				throw new Error(`MCP tool "${name}" on "${this.entry.name}" changed; discover it again before calling it`);
			this.pinned = true;
			return client.callTool(name, args, { signal, timeoutMs: this.timeoutMs });
		}, signal);
	}

	private setTools(tools: McpTool[]): void {
		this.tools = tools;
		this.toolKeys = new Map(tools.map((tool) => [tool.name, descriptorKey(tool)]));
	}

	/** Every resource, following `nextCursor` through all pages. */
	allResources(options: { signal?: AbortSignal } = {}): Promise<Resource[]> {
		return this.pool.run(
			() =>
				this.withClient(
					(client) => client.listResources({ signal: options.signal, timeoutMs: this.timeoutMs }),
					options.signal,
				),
			options.signal,
		);
	}

	resourcesPage(cursor: string | undefined, options: { signal?: AbortSignal } = {}): Promise<ListResourcesResult> {
		return this.withResourceSession(
			(client) => client.listResourcesPage(cursor, { signal: options.signal, timeoutMs: this.timeoutMs }),
			options.signal,
		);
	}

	/** Every resource template, following `nextCursor` through all pages. */
	allResourceTemplates(options: { signal?: AbortSignal } = {}): Promise<ResourceTemplate[]> {
		return this.pool.run(
			() =>
				this.withClient(
					(client) => client.listResourceTemplates({ signal: options.signal, timeoutMs: this.timeoutMs }),
					options.signal,
				),
			options.signal,
		);
	}

	resourceTemplatesPage(
		cursor: string | undefined,
		options: { signal?: AbortSignal } = {},
	): Promise<{ resourceTemplates: ResourceTemplate[]; nextCursor?: string }> {
		return this.withResourceSession(async (client) => {
			try {
				return await client.listResourceTemplatesPage(cursor, { signal: options.signal, timeoutMs: this.timeoutMs });
			} catch (error) {
				// Servers that do not implement templates list have none.
				if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound)
					return { resourceTemplates: [] };
				throw error;
			}
		}, options.signal);
	}

	readResource(uri: string, options: { signal?: AbortSignal } = {}): Promise<ReadResourceResult> {
		return this.withResourceSession(
			(client) => client.readResource(uri, { signal: options.signal, timeoutMs: this.timeoutMs }),
			options.signal,
		);
	}

	private withResourceSession<T>(run: (client: McpClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.withClient((client) => {
			if (!this.hasResources) throw new Error(`MCP server "${this.entry.name}" no longer offers resources`);
			this.pinned = true;
			return run(client);
		}, signal);
	}

	/** Reconnect before dispatch, not after a request with an uncertain result. */
	private withClient<T>(run: (client: McpClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.use(async () => {
			signal?.throwIfAborted();
			try {
				const client = await this.getClient();
				signal?.throwIfAborted();
				return await run(client);
			} catch (error) {
				throw mcpTransportError(this.entry, error);
			}
		});
	}

	private async use<T>(run: () => Promise<T>): Promise<T> {
		this.pool.unpark(this);
		this.users++;
		try {
			return await run();
		} finally {
			if (--this.users === 0 && !this.pinned && this.client && !this.closed)
				this.pool.park(this, () => this.disconnect());
		}
	}

	private disconnect(): Promise<void> {
		const client = this.client;
		if (client === undefined) return Promise.resolve();
		this.client = undefined;
		this.disconnecting = client
			.close()
			.catch(() => undefined)
			.finally(() => {
				this.disconnecting = undefined;
			});
		return this.disconnecting;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.pool.unpark(this);
		this.discovery?.owner.abort();
		const active = this.client ?? this.connecting;
		this.client = undefined;
		this.connecting = undefined;
		await Promise.allSettled([active?.close(), this.opening, this.disconnecting]);
	}

	private async open(): Promise<McpClient> {
		const client = new McpClient({
			name: "pi",
			version: VERSION,
			requestTimeoutMs: this.timeoutMs,
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		client.onNotification("notifications/tools/list_changed", () => this.toolsChanged(client));
		client.onClose(() => this.handleClose(client));
		this.connecting = client;
		let transport: StdioTransport | StreamableHttpTransport | undefined;
		try {
			transport = createTransport(this.entry, this.cwd, this.authProvider);
			if (transport instanceof StdioTransport) guardStdio(transport, this.guardian);
			await client.connect(transport);
			await this.readToolCatalog(client);
			this.client = client;
			return client;
		} catch (error) {
			await client.close().catch(() => undefined);
			const stderr = transport instanceof StdioTransport ? transport.stderr.trim() : "";
			const mapped = mcpTransportError(this.entry, error);
			const failure = stderr === "" ? mapped : new Error(`${mapped.message}\n${stderr}`);
			if (!this.closed) {
				this.catalogKnown = false;
				this.setTools([]);
				this.hasResources = false;
				this.instructions = undefined;
				this.onTools();
			}
			throw failure;
		} finally {
			if (this.connecting === client) this.connecting = undefined;
		}
	}

	private handleClose(client: McpClient): void {
		if (this.client !== client || this.closed) return;
		this.client = undefined;
		this.pool.unpark(this);
		this.catalogKnown = false;
	}

	private toolsChanged(client: McpClient): void {
		if (this.closed || (this.client !== client && this.connecting !== client)) return;
		this.catalogRevision++;
		this.catalogKnown = false;
		// Discovery-only transports update their catalogue on demand. Live sessions refresh immediately.
		if (this.pinned && this.client === client) void this.use(() => this.getClient()).catch(() => undefined);
	}

	private async readToolCatalog(client: McpClient): Promise<McpClient> {
		const revision = this.catalogRevision;
		const tools = client.serverCapabilities?.tools === undefined ? [] : await client.listTools();
		if (this.closed || client.connectionState !== "connected")
			throw new Error("MCP connection closed during discovery");
		if (revision !== this.catalogRevision)
			throw new Error("The MCP tool list changed during discovery; retry discovery");
		this.setTools(tools);
		this.instructions = client.instructions?.trim() || undefined;
		this.hasResources = client.serverCapabilities?.resources !== undefined;
		this.catalogKnown = true;
		this.onTools();
		return client;
	}
}

// ─── MCP resource tools ─────────────────────────────────────────────────────

/** The three resource tools, using the names established by common MCP hosts. */
const RESOURCE_LIST_PARAMETERS = obj({
	server: opt(str({ description: "MCP server name. Omit to list every server with resources." })),
	cursor: opt(
		str({ description: "Opaque cursor from a previous call with the same server; omit for the first page." }),
	),
});

const RESOURCE_READ_PARAMETERS = obj({
	server: str({ description: "MCP server name exactly as configured." }),
	uri: str({ description: "Resource URI returned by list_mcp_resources." }),
});

const RESOURCE_LIST_OUTPUT_SCHEMA: Schema = {
	type: "object",
	properties: {
		server: { type: "string" },
		resources: { type: "array", items: { type: "object" } },
		nextCursor: { type: "string" },
		errors: { type: "array", items: { type: "object" } },
	},
	required: ["resources"],
};
const RESOURCE_TEMPLATES_OUTPUT_SCHEMA: Schema = {
	type: "object",
	properties: {
		server: { type: "string" },
		resourceTemplates: { type: "array", items: { type: "object" } },
		nextCursor: { type: "string" },
		errors: { type: "array", items: { type: "object" } },
	},
	required: ["resourceTemplates"],
};
const RESOURCE_READ_OUTPUT_SCHEMA: Schema = {
	type: "object",
	properties: {
		server: { type: "string" },
		uri: { type: "string" },
		contents: { type: "array", items: { type: "object" } },
	},
	required: ["server", "uri", "contents"],
};

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
async function resourceJsonResult(
	tool: string,
	server: string | undefined,
	payload: JsonValue,
): Promise<Durable.ToolExecutionResult<JsonValue>> {
	const limited = await limitMcpContent([{ type: "text", text: JSON.stringify(payload) }], saveToTempFile);
	return {
		output: [...limited.content],
		structuredOutput: payload,
		details: {
			server: server ?? "",
			tool,
			...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }),
		},
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
	const disabled = new Set(
		(settings.extensions ?? []).filter((entry) => entry.startsWith("-builtin:")).map((entry) => entry.slice(9)),
	);
	const config = disabled.has("mcp")
		? { servers: [], errors: [] }
		: loadMcpConfig({
				agentDir: host.agentDir,
				cwd: host.cwd,
				projectTrusted: host.services.settingsManager.isProjectTrusted(),
			});
	for (const error of config.errors) host.services.diagnostics.push({ type: "warning", message: error });
	const servers = config.servers.filter((server) => server.config.enabled !== false);
	const uses = (exposure: McpExposure) => servers.some((server) => configuredExposures(server.config).has(exposure));
	const configured = (name: string) => defaultTools?.includes(name) ?? false;
	return {
		codemode:
			!disabled.has("codemode") &&
			(configured(CODEMODE_TOOL_NAME) || (config.autoEnableCodemode !== false && uses("codemode"))),
		toolSearch: !disabled.has("tool_search") && (configured(TOOL_SEARCH_TOOL_NAME) || uses("deferred")),
		servers,
		indirect: servers.some((server) => hasIndirectTools(server.config)),
	};
}

type CodemodeRefusal = { readonly code: CodemodeAdmissionFailureCode; readonly message: string };
type AdmissionDoc = Durable.TaskDocToken<{ deadline?: number; admitted: boolean }>;

// ─── Native execution host ────────────────────────────────────────────────

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
/** The invocation budget expired while an MCP connection was still being discovered. */
class CodemodeDiscoveryTimeoutError extends Error {}
class McpDiscoveryError extends Error {}
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
	private readonly servers: McpServerConnection[] = [];
	private readonly discovery = new McpDiscoveryPool();
	private readonly guardian: McpGuardian;
	private readonly auth: NativeMcpAuth;
	private readonly sandbox = new CodemodeSandbox({
		acquireWorker: () => {
			throw new Error("Codemode calls require queued worker admission.");
		},
	});
	private readonly queuedSandboxes = new Set<QueuedCodemodeSandbox>();
	private readonly readyTimeoutMs: number;
	private readonly closeOnHostAbort = () => void this.close();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(host: DurableExecutionHost, options: DurableExecutionOptions = {}) {
		this.host = host;
		this.guardian = new McpGuardian((message) => host.services.diagnostics.push({ type: "warning", message }));
		this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		const activation = computeActivation(host);
		this.auth = new NativeMcpAuth(host.agentDir);
		this.extensions = this.buildExtensions(activation);
		if (host.signal.aborted) void this.close();
		else host.signal.addEventListener("abort", this.closeOnHostAbort, { once: true });
		this.ready = this.waitForDirectServers();
	}

	private async waitForDirectServers(): Promise<void> {
		const pending = this.servers
			.filter((server) => configuredExposures(server.entry.config).has("direct"))
			.map((server) => server.discover(this.host.signal).catch(() => undefined));
		if (pending.length === 0 || this.readyTimeoutMs <= 0) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, this.readyTimeoutMs);
			timer.unref?.();
			void Promise.all(pending).then(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private buildExtensions(activation: Activation): readonly Durable.Extension[] {
		const result: Durable.Extension[] = [];
		if (activation.codemode) {
			const Admission = this.host.durable.defineDoc<{ deadline?: number; admitted: boolean }>({
				kind: "agent.codemode-admission",
				version: 1,
				scope: "task",
				initial: () => ({ admitted: false }),
				checkpointWhen: () => false,
			});
			const native = createCodemodeExtension({ sandbox: this.sandbox });
			const tools = (native.tools ?? []).map((tool) =>
				tool.name !== CODEMODE_TOOL_NAME
					? tool
					: {
							...tool,
							prepareArguments: prepareNativeCodemodeArguments,
							execute: (args: { code: string }, api: Durable.ToolExecutionApi, context: Context) =>
								this.executeCodemode(args, api, context, Admission),
						},
			);
			result.push({
				...native,
				tools,
				hooks: [
					this.host.durable.hook(this.host.durable.GenerationTask, {
						beforeRequest: (request) => {
							if (this.host.services.settingsManager.getSettings().codemode?.mode !== "only") return;
							return {
								messages: request.messages.map((message) =>
									message.role !== "system"
										? message
										: {
												...message,
												...(message.toolsAdded === undefined
													? {}
													: {
															toolsAdded: message.toolsAdded.filter((tool) =>
																CODEMODE_ONLY_DECLARATIONS.has(tool.name),
															),
														}),
											},
								),
							};
						},
					}),
				],
			});
		}
		if (activation.toolSearch) {
			const native = createToolSearchExtension();
			result.push({
				...native,
				tools: (native.tools ?? []).map((tool) => ({
					...tool,
					execute: async (
						args: Parameters<typeof tool.execute>[0],
						api: Durable.ToolExecutionApi,
						context: Context,
					) => {
						await this.waitForAllServers(context);
						return tool.execute(args, this.catalogApi(api), context);
					},
				})),
			});
		}
		if (!this.host.signal.aborted)
			for (const entry of activation.servers) result.push(this.defineServerExtension(entry));
		// Resource capabilities are unknown until use. Keep declarations independent of connection progress.
		const exposures = new Set(
			this.servers
				.filter(({ entry }) => entry.config.exposure !== "hidden")
				.map(({ entry }) => entry.config.exposure ?? "codemode"),
		);
		const resourceTools = exposures.size === 0 ? [] : this.defineResourceTools();
		result.push(
			this.host.durable.defineExtension({
				name: EXTENSION_NAME,
				tools: exposures.has("direct") ? resourceTools : resourceTools.map((tool) => ({ ...tool, deferred: true })),
				sections: activation.indirect
					? [this.host.durable.section(MCP_SERVERS_SECTION, () => this.renderServersSection())]
					: [],
			}),
		);
		return result;
	}

	/** Run one native script inside its persisted execution budget and queued worker admission. */
	private async executeCodemode(
		args: { code: string },
		api: Durable.ToolExecutionApi,
		context: Context,
		Admission: AdmissionDoc,
	) {
		const parsed = parseCodemodeSource(args.code);
		const deadline = await api.memo(
			CODEMODE_DEADLINE_MEMO,
			api.now() + (parsed.options.timeoutMs ?? DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS),
			context,
		);
		const refusal = await this.preflightCodemode(parsed.code, deadline, api, context);
		const sandbox = new QueuedCodemodeSandbox(
			{
				deadline: () =>
					api
						.commit(async (tx) => {
							const state = await tx.doc(Admission, api.taskId);
							if (state.deadline === undefined || state.admitted) {
								state.deadline = api.now() + CODEMODE_WORKER_WAIT_MS;
								state.admitted = false;
							}
							return Math.min(state.deadline, deadline);
						}, context)
						.then((admissionDeadline) => Date.now() + Math.max(0, admissionDeadline - api.now())),
				admitted: () =>
					api.commit(async (tx) => {
						(await tx.doc(Admission, api.taskId)).admitted = true;
					}, context),
				now: () => api.now(),
				executionDeadline: deadline,
				...(refusal === undefined ? {} : { refusal }),
			},
			undefined,
			{ memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES },
			(failure: CodemodeAdmissionFailure) =>
				api.diagnostic({
					severity: failure.code === "CODEMODE_CANCELLED" ? "warn" : "error",
					code: failure.code,
					message: `${failure.message} (active ${failure.active}, waiting ${failure.waiting}, limit ${failure.limit})`,
				}),
		);
		this.queuedSandboxes.add(sandbox);
		if (this.closed) await sandbox.close();
		try {
			// A pending refusal ends the script at its sandbox start whatever the budget; the full budget keeps Pi from
			// ending it earlier with an unrecorded timeout, so the refusal reaches its diagnostic.
			const remainingBudget =
				refusal === undefined
					? Math.max(1, Math.ceil(deadline - api.now()))
					: (parsed.options.timeoutMs ?? DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS);
			return await createCodemodeTool({ sandbox }).execute(
				{ ...args, code: replaceCodemodeTimeout(args.code, remainingBudget) },
				this.catalogApi(api),
				context,
			);
		} finally {
			this.queuedSandboxes.delete(sandbox);
			await sandbox.close();
		}
	}

	/**
	 * MCP discovery spends the script's own budget. A refusal applies only if the native tool starts a sandbox;
	 * a retained result still returns even if discovery now fails.
	 */
	private async preflightCodemode(
		code: string,
		deadline: number,
		api: Durable.ToolExecutionApi,
		context: Context,
	): Promise<CodemodeRefusal | undefined> {
		try {
			await this.waitForScriptServers(code, context, deadline - api.now());
		} catch (error) {
			if (error instanceof CodemodeDiscoveryTimeoutError)
				return { code: "CODEMODE_ADMISSION_TIMEOUT", message: error.message };
			if (context.abortSignal?.aborted === true) return { code: "CODEMODE_CANCELLED", message: errorText(error) };
			if (error instanceof McpDiscoveryError) return { code: "CODEMODE_DISCOVERY_FAILED", message: error.message };
			throw error;
		}
		if (deadline - api.now() <= 0)
			return { code: "CODEMODE_ADMISSION_TIMEOUT", message: "The codemode script timed out before worker admission." };
		return undefined;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.host.signal.removeEventListener("abort", this.closeOnHostAbort);
		this.discovery.close();
		const pending = new Set(this.servers.map((server) => server.entry.name));
		const closing = Promise.all([
			this.sandbox.close(),
			...[...this.queuedSandboxes].map((sandbox) => sandbox.close()),
			...this.servers.map(async (server) => {
				await server.close();
				pending.delete(server.entry.name);
			}),
		]);
		const authSettled = this.auth.close();
		this.closePromise = new Promise<void>((resolve, reject) => {
			const deadline = setTimeout(() => {
				this.host.services.diagnostics.push({
					type: "warning",
					message: `MCP shutdown timed out: ${[...pending].join(", ")}`,
				});
				this.guardian.close();
				resolve();
			}, 5000);
			void closing.then(
				() => {
					clearTimeout(deadline);
					this.guardian.close();
					resolve();
				},
				(error: unknown) => {
					clearTimeout(deadline);
					this.guardian.close();
					reject(error);
				},
			);
		}).finally(() => authSettled);
		return this.closePromise;
	}

	private defineServerExtension(entry: McpServerEntry): Durable.Extension {
		let tools: NestedTool[] = [];
		const server = new McpServerConnection(
			entry,
			this.host.cwd,
			() => {
				if (!this.closed) tools = this.serverToolRegistrations(server);
			},
			createServerAuthProvider(entry, this.auth, this.host.services.modelRuntime),
			this.guardian,
			this.discovery,
		);
		this.servers.push(server);
		const description = (entry.config.description ?? "").split(/\r\n?|\n/u, 1)[0].trim();
		return this.host.durable.defineExtension({
			name: `${EXTENSION_NAME}:${entry.name}`,
			get tools() {
				return tools;
			},
			get namespace() {
				return {
					name: entry.name,
					description,
					...(server.instructions === undefined ? {} : { instructions: server.instructions }),
				};
			},
		});
	}

	private serverToolRegistrations(server: McpServerConnection): NestedTool[] {
		const registrations: NestedTool[] = [];
		const tools = [...new Map(server.tools.map((tool) => [tool.name, tool])).values()];
		const owners = new Set<string>();
		const plain = tools.map((tool) => createMcpToolName(server.entry.name, tool.name));
		for (const tool of tools) {
			const exposure = getToolExposure(server.entry.config, tool.name);
			if (exposure === "hidden") continue;
			const name = createMcpToolName(
				server.entry.name,
				tool.name,
				(candidate) => owners.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate),
			);
			owners.add(name);
			registrations.push(this.defineMcpTool(server, tool, name, exposure));
		}
		return registrations;
	}

	private resourceServers(): McpServerConnection[] {
		return this.servers.filter((server) => server.hasResources && server.entry.config.exposure !== "hidden");
	}

	private defineMcpTool(server: McpServerConnection, tool: McpTool, name: string, exposure: McpExposure): NestedTool {
		const key = server.toolKey(tool.name);
		return {
			name,
			description: tool.description?.trim() || tool.title || `MCP tool ${tool.name} from server ${server.entry.name}`,
			parameters: toParameters(tool.inputSchema),
			structuredOutputSchema: createMcpResultSchema(tool.outputSchema),
			replay: "unsafe",
			...(exposure === "direct" ? {} : { deferred: true }),
			execute: async (args, api, context) => {
				const result = await server.callTool(tool.name, key, args as Record<string, unknown>, context.abortSignal);
				const readableResources =
					result.content.some((block) => block?.type === "resource_link") &&
					(await this.canReadResourceLinks(server, api, context));
				context.abortSignal?.throwIfAborted();
				return convertMcpResult(server.entry.name, tool.name, result, readableResources);
			},
		};
	}

	private async canReadResourceLinks(
		server: McpServerConnection,
		api: Durable.ToolExecutionApi,
		context: Context,
	): Promise<boolean> {
		if (!this.resourceServers().includes(server)) return false;
		const agent = await api.agent(context);
		const readsResources = (tool: NestedTool) => tool.name === READ_MCP_RESOURCE_TOOL;
		// A contribution can replace a built-in without supplying its reach to other tools.
		const owner = (name: string) =>
			agent.extensions.findLast((extension) => extension.tools?.some((tool) => tool.name === name))?.name;
		const offers = (name: string) => agent.tools.some((tool) => tool.name === name);
		if (owner(READ_MCP_RESOURCE_TOOL) !== EXTENSION_NAME) return false;
		return (
			offers(READ_MCP_RESOURCE_TOOL) ||
			(offers(CODEMODE_TOOL_NAME) && owner(CODEMODE_TOOL_NAME) === "codemode" && agent.callable.some(readsResources)) ||
			(offers(TOOL_SEARCH_TOOL_NAME) &&
				owner(TOOL_SEARCH_TOOL_NAME) === "tool-search" &&
				agent.deferred.some(readsResources))
		);
	}

	/** A tool phase pins its agent before MCP discovery; the public conversation read resolves the completed catalog. */
	private catalogApi(api: Durable.ToolExecutionApi): Durable.ToolExecutionApi {
		if (this.servers.length === 0) return api;
		return {
			...api,
			get models() {
				return api.models;
			},
			get env() {
				return api.env;
			},
			agent: async (context) => {
				await api.agent(context);
				const conversation = await this.host.harness.conversation(api.conversationId, context);
				if (conversation === undefined) throw new Error("The MCP tool's conversation is unavailable");
				return conversation.agent(context);
			},
		};
	}

	private async waitForScriptServers(code: string, context: Context, timeoutMs: number): Promise<void> {
		await this.waitForServers(
			scriptDiscoveryServers(code, this.servers, (server) => server.entry.name),
			context,
			timeoutMs,
		);
	}
	private async waitForAllServers(context: Context): Promise<void> {
		await this.waitForServers(this.servers, context);
	}
	private async waitForServers(
		servers: readonly McpServerConnection[],
		context: Context,
		timeoutMs?: number,
	): Promise<void> {
		if (servers.length === 0) return;
		const signal = context.abortSignal;
		signal?.throwIfAborted();
		if (timeoutMs !== undefined && timeoutMs <= 0)
			throw new CodemodeDiscoveryTimeoutError("The codemode script timed out while waiting for MCP servers.");
		// A cancelled wait withdraws queued demand; it does not close an opening or shared connection.
		const waiter = timeoutMs === undefined ? undefined : withCancel(context);
		const timer =
			waiter === undefined
				? undefined
				: setTimeout(
						() =>
							waiter.cancel(
								new CodemodeDiscoveryTimeoutError("The codemode script timed out while waiting for MCP servers."),
							),
						timeoutMs,
					);
		timer?.unref?.();
		try {
			const discoveryContext = waiter?.context ?? context;
			const results = await awaitWithContext(
				Promise.allSettled(servers.map((server) => server.discover(discoveryContext.abortSignal))),
				discoveryContext,
			);
			const failures = results.flatMap((result, index) =>
				result.status === "rejected" ? [`${servers[index].entry.name}: ${errorText(result.reason)}`] : [],
			);
			if (failures.length > 0) throw new McpDiscoveryError(`MCP discovery could not finish: ${failures.join("; ")}`);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
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
				structuredOutputSchema: RESOURCE_LIST_OUTPUT_SCHEMA,
				replay: "safe",
				execute: (args, _api, context) =>
					this.listResourceTool(LIST_MCP_RESOURCES_TOOL, "resources", args as Record<string, unknown>, context),
			},
			{
				name: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
				description:
					"Show the parameterized resource templates the connected MCP servers publish. Prefer a template over a web search when it covers the data you need.",
				parameters: RESOURCE_LIST_PARAMETERS,
				structuredOutputSchema: RESOURCE_TEMPLATES_OUTPUT_SCHEMA,
				replay: "safe",
				execute: (args, _api, context) =>
					this.listResourceTool(
						LIST_MCP_RESOURCE_TEMPLATES_TOOL,
						"resourceTemplates",
						args as Record<string, unknown>,
						context,
					),
			},
			{
				name: READ_MCP_RESOURCE_TOOL,
				description: "Read one resource by server name and URI, as returned by `list_mcp_resources`.",
				parameters: RESOURCE_READ_PARAMETERS,
				structuredOutputSchema: RESOURCE_READ_OUTPUT_SCHEMA,
				replay: "safe",
				execute: (args, _api, context) => this.readResourceTool(args as Record<string, unknown>, context),
			},
		];
	}

	private async listResourceTool(
		tool: string,
		key: "resources" | "resourceTemplates",
		params: Record<string, unknown>,
		context: Context,
	): Promise<Durable.ToolExecutionResult<JsonValue>> {
		const serverName = resourceStringArgument(params, "server");
		await this.waitForResourceServers(serverName, context);
		const cursor = resourceStringArgument(params, "cursor");
		const servers = [...this.resourceServers()].sort((a, b) => a.entry.name.localeCompare(b.entry.name));
		if (serverName === undefined) {
			if (cursor !== undefined) throw new Error("cursor can only be used when a server is specified");
			return await this.listEveryResourceServer(tool, key, servers, context);
		}
		const server = this.findResourceServer(serverName, servers);
		const page =
			key === "resources"
				? await server.resourcesPage(cursor, { signal: context.abortSignal })
				: await server.resourceTemplatesPage(cursor, { signal: context.abortSignal });
		const items = "resources" in page ? page.resources : page.resourceTemplates;
		const payload = {
			server: server.entry.name,
			[key]: items.filter((item) => !isMcpAppResource(item)).map((item) => listedResource(server.entry.name, item)),
			...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
		};
		return await resourceJsonResult(tool, server.entry.name, payload as unknown as JsonValue);
	}

	private async listEveryResourceServer(
		tool: string,
		key: "resources" | "resourceTemplates",
		servers: readonly McpServerConnection[],
		context: Context,
	): Promise<Durable.ToolExecutionResult<JsonValue>> {
		const results = await Promise.allSettled(
			servers.map((server) =>
				key === "resources"
					? server.allResources({ signal: context.abortSignal })
					: server.allResourceTemplates({ signal: context.abortSignal }),
			),
		);
		const items: JsonValue[] = [];
		const errors: JsonValue[] = [];
		results.forEach((result, index) => {
			const server = servers[index];
			if (server === undefined) return;
			if (result.status === "fulfilled") {
				items.push(
					...result.value
						.filter((item) => !isMcpAppResource(item))
						.map((item) => listedResource(server.entry.name, item) as unknown as JsonValue),
				);
			} else {
				errors.push({ server: server.entry.name, error: errorText(result.reason) });
			}
		});
		return await resourceJsonResult(tool, undefined, {
			[key]: items,
			...(errors.length === 0 ? {} : { errors }),
		} as unknown as JsonValue);
	}

	private async readResourceTool(
		params: Record<string, unknown>,
		context: Context,
	): Promise<Durable.ToolExecutionResult<JsonValue>> {
		const serverName = resourceStringArgument(params, "server");
		const uri = resourceStringArgument(params, "uri");
		if (serverName === undefined) throw new Error("server must be provided");
		if (uri === undefined) throw new Error("uri must be provided");
		await this.waitForResourceServers(serverName, context);
		const server = this.findResourceServer(serverName, this.resourceServers());
		const result = await server.readResource(uri, { signal: context.abortSignal });
		context.abortSignal?.throwIfAborted();
		const blocks: ContentBlock[] = result.contents.flatMap((contents) => [
			...(result.contents.length > 1 ? [{ type: "text" as const, text: `${contents.uri}:` }] : []),
			{ type: "resource" as const, resource: contents },
		]);
		const converted = await toMcpModelContent(server.entry.name, { content: blocks }, { saveOutput: saveToTempFile });
		const limited = await limitMcpContent(
			converted.length > 0 ? converted : [{ type: "text", text: `Resource ${uri} is empty.` }],
			saveToTempFile,
		);
		const contents = result.contents.map(({ _meta: _ignored, ...rest }) => rest);
		return {
			output: limited.content,
			structuredOutput: { server: server.entry.name, uri, contents } as unknown as JsonValue,
			details: {
				server: server.entry.name,
				tool: READ_MCP_RESOURCE_TOOL,
				...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }),
			},
		};
	}

	private waitForResourceServers(name: string | undefined, context: Context): Promise<void> {
		return this.waitForServers(
			this.servers.filter(
				(server) => server.entry.config.exposure !== "hidden" && (name === undefined || server.entry.name === name),
			),
			context,
		);
	}

	private findResourceServer(name: string, servers: readonly McpServerConnection[]): McpServerConnection {
		const found = servers.find((server) => server.entry.name === name);
		if (found !== undefined) return found;
		const available = servers.map((server) => server.entry.name).join(", ");
		throw new Error(
			`MCP server "${name}" has no resources${available === "" ? "" : `. Servers with resources: ${available}`}`,
		);
	}

	// ── Prompt section ─────────────────────────────────────────────────────

	/** The `mcp_servers` section: enabled servers with tools that are not declared. */
	private renderServersSection(): string | undefined {
		const listed = this.servers
			.filter((server) => hasIndirectTools(server.entry.config))
			.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
		if (listed.length === 0) return undefined;
		const reaches = listed.map((server) =>
			configuredExposures(server.entry.config).has("codemode") ? "codemode" : "tool_search",
		);
		const intro = [
			"MCP servers with tools that are not declared to you.",
			reaches.includes("codemode") ? " Their tools are called from `codemode` scripts." : "",
			reaches.includes("tool_search") ? " Their tools are loaded with `tool_search`." : "",
		].join("");
		const heads = listed.map((server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`);
		const omitted = (count: number) =>
			count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; use searchTools() to find their tools`] : [];
		const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
		let kept = listed.length;
		while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
		const perServer =
			kept === 0
				? 0
				: Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
		const lines = listed.slice(0, kept).map((server, index) => {
			const summary = perServer > 0 ? truncateLine(server.entry.config.description ?? "", perServer) : "";
			return summary === "" ? heads[index] : `${heads[index]}: ${summary}`;
		});
		return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
	}
}

/**
 * Create the native codemode and MCP built-ins for one Durable session host. The caller
 * installs `extensions` in the host registry and calls `close()` when the host shuts down.
 */
export function createDurableExecution(
	host: DurableExecutionHost,
	options?: DurableExecutionOptions,
): DurableExecution {
	return new DurableExecutionRuntime(host, options);
}
