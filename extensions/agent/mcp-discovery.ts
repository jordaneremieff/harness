import { toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import { mcpNamespace } from "@earendil-works/pi-mcp";

export const MCP_DISCOVERY_CONCURRENCY = 4;
export const MCP_DISCOVERY_IDLE_MS = 10_000;

interface IdleConnection {
	readonly timer: ReturnType<typeof setTimeout>;
	readonly disconnect: () => Promise<void>;
}

/** Per-host permits for discovery and an ordered cache of idle discovery-only stdio transports. */
export class McpDiscoveryPool {
	private readonly stopping = new AbortController();
	private readonly waiting = new Set<() => void>();
	private readonly idle = new Map<object, IdleConnection>();
	private readonly disconnecting = new Set<Promise<void>>();
	private active = 0;

	async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const owner = this.stopping.signal;
		const effective = signal === undefined ? owner : AbortSignal.any([owner, signal]);
		await this.acquire(effective);
		try {
			while (this.active + this.idle.size > MCP_DISCOVERY_CONCURRENCY) {
				const oldest = this.idle.keys().next().value;
				if (oldest === undefined) break;
				this.disconnect(oldest);
			}
			await Promise.all(this.disconnecting);
			effective.throwIfAborted();
			return await work();
		} finally {
			this.active--;
			this.waiting.values().next().value?.();
		}
	}

	private acquire(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (this.active < MCP_DISCOVERY_CONCURRENCY && this.waiting.size === 0) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const give = () => {
				this.waiting.delete(give);
				signal.removeEventListener("abort", cancel);
				this.active++;
				resolve();
			};
			const cancel = () => {
				this.waiting.delete(give);
				reject(signal.reason);
			};
			this.waiting.add(give);
			signal.addEventListener("abort", cancel, { once: true });
		});
	}

	park(owner: object, disconnect: () => Promise<void>): void {
		if (this.stopping.signal.aborted || this.idle.has(owner)) return;
		const timer = setTimeout(() => this.disconnect(owner), MCP_DISCOVERY_IDLE_MS);
		timer.unref();
		this.idle.set(owner, { timer, disconnect });
	}

	unpark(owner: object): void {
		const entry = this.idle.get(owner);
		if (entry === undefined) return;
		this.idle.delete(owner);
		clearTimeout(entry.timer);
	}

	private disconnect(owner: object): void {
		const entry = this.idle.get(owner);
		if (entry === undefined) return;
		this.unpark(owner);
		const completion = entry.disconnect().catch(() => undefined);
		this.disconnecting.add(completion);
		void completion.then(() => this.disconnecting.delete(completion));
	}

	close(): void {
		this.stopping.abort(new Error("MCP discovery is shut down"));
		for (const owner of this.idle.keys()) this.unpark(owner);
	}
}

type ScriptDiscovery =
	| { readonly kind: "all" | "none" }
	| { readonly kind: "namespace" | "server" | "tool"; readonly name: string };

const RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
const RETURN_HELPER =
	/^return[ \t]+(?:await[ \t]+)?(describeNamespace|describeTool)\s*\(\s*(["'])([A-Za-z0-9_-]+)\2\s*\)\s*;?$/u;
const RETURN_CALL = /^return[ \t]+(?:await[ \t]+)?tools\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([\s\S]*)\)\s*;?$/u;
const RETURN_JSON = /^return[ \t]+([\s\S]+?)\s*;?$/u;

function parseJson(input: string): unknown {
	try {
		return JSON.parse(input);
	} catch {
		return undefined;
	}
}

/** Specialise only complete source forms that cannot execute other discovery or tool calls. */
function scriptDiscovery(source: string): ScriptDiscovery {
	const code = source.trim();
	const helper = RETURN_HELPER.exec(code);
	if (helper !== null) return { kind: helper[1] === "describeNamespace" ? "namespace" : "tool", name: helper[3] };
	const call = RETURN_CALL.exec(code);
	if (call !== null) {
		const input = parseJson(call[2]);
		if (input === null || typeof input !== "object" || Array.isArray(input)) return { kind: "all" };
		const name = call[1];
		if (!RESOURCE_TOOLS.has(name)) return { kind: "tool", name };
		const server = Object.hasOwn(input, "server") ? (input as { server?: unknown }).server : undefined;
		return typeof server === "string" ? { kind: "server", name: server } : { kind: "all" };
	}
	const literal = RETURN_JSON.exec(code);
	return literal !== null && parseJson(literal[1]) !== undefined ? { kind: "none" } : { kind: "all" };
}

export function scriptDiscoveryServers<T>(
	source: string,
	servers: readonly T[],
	nameOf: (server: T) => string,
): readonly T[] {
	const scope = scriptDiscovery(source);
	switch (scope.kind) {
		case "all":
			return servers;
		case "none":
			return [];
		case "server":
			return servers.filter((server) => nameOf(server) === scope.name);
		case "namespace": {
			const identifier = toCodemodeIdentifier(scope.name);
			return servers.filter((server) => toCodemodeIdentifier(nameOf(server)) === identifier);
		}
		case "tool": {
			if (!scope.name.startsWith("mcp__")) return [];
			// Pi MCP may shorten names at its 64-character tool-name limit, including the server prefix.
			if (scope.name.length >= 64) return servers;
			const matches = servers.filter((server) => scope.name.startsWith(`${mcpNamespace(nameOf(server))}__`));
			return matches.length === 1 ? matches : servers;
		}
	}
}
