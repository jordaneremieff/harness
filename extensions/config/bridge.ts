import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { unlinkSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { isObject } from "./json.ts";
import type { ConfigBackend } from "./operations.ts";
import {
	BRIDGE_PATHS,
	BRIDGE_POLL_MS,
	BRIDGE_REQUEST_BYTES,
	type BridgeCommand,
	type BridgePath,
	type EditRequest,
	type ToolsChange,
} from "./protocol.ts";

type Client = {
	seen: number;
	sequence: number;
	command: BridgeCommand | null;
	changed: boolean;
	/** Document revisions behind the last catalogue this pane received. */
	revisions?: string;
	wake?: () => void;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CLIENTS = 16;

export type BridgeOptions = {
	backend: ConfigBackend;
	agentDir: string;
	label: () => string;
	expectedBuild?: () => string | undefined;
	pollMs?: number;
};

/**
 * One loopback endpoint for one ordinary session. Every native request runs the same
 * backend operations as the tools; the page never receives file or shell access.
 */
export class ConfigBridge {
	private server?: Server;
	private startup?: Promise<{ endpoint: string; token: string }>;
	private host?: string;
	private closed = false;
	private readonly authorization = Buffer.from(`Bearer ${randomBytes(32).toString("hex")}`);
	private readonly clients = new Map<string, Client>();
	private readonly files = new Set<string>();
	private readonly offChange: () => void;
	private readonly options: BridgeOptions;

	constructor(options: BridgeOptions) {
		this.options = options;
		this.offChange = options.backend.onChange(() => {
			for (const client of this.clients.values()) {
				client.changed = true;
				client.wake?.();
			}
		});
	}

	start(): Promise<{ endpoint: string; token: string }> {
		if (this.closed) return Promise.reject(new Error("The Config bridge closed."));
		this.startup ??= this.open();
		return this.startup;
	}

	private async open(): Promise<{ endpoint: string; token: string }> {
		const server = createServer({ headersTimeout: 10000, requestTimeout: 60000 }, (request, response) => {
			void this.serve(request, response);
		});
		server.maxConnections = 32;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.server = server;
		if (this.closed) {
			server.close();
			throw new Error("The Config bridge closed.");
		}
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("The Config endpoint is unavailable.");
		this.host = `127.0.0.1:${address.port}`;
		return { endpoint: `http://${this.host}`, token: this.authorization.toString("ascii", 7) };
	}

	/** Writes the one-use capability file that the native app consumes. */
	async capability(): Promise<{ path: string; remove: () => Promise<void> }> {
		const config = await this.start();
		const directory = join(this.options.agentDir, "config-live");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, `${randomUUID()}.json`);
		const file = await open(path, "wx", 0o600);
		this.files.add(path);
		const remove = async () => {
			this.files.delete(path);
			await unlink(path).catch(() => {});
		};
		try {
			await file.writeFile(JSON.stringify({ version: 1, ...config }));
		} catch (error) {
			await remove();
			throw error;
		} finally {
			await file.close();
		}
		if (this.closed) {
			await remove();
			throw new Error("The Config bridge closed.");
		}
		return { path, remove };
	}

	/** Shows a connected pane again instead of opening another; false when none is live. */
	reveal(query?: string): boolean {
		const now = Date.now();
		const live = [...this.clients.values()].filter((client) => now - client.seen < BRIDGE_POLL_MS + 10000);
		const client = live.sort((a, b) => b.seen - a.seen)[0];
		if (!client) return false;
		client.command = { op: "reveal", ...(query ? { query } : {}) };
		client.wake?.();
		return true;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.offChange();
		for (const client of this.clients.values()) client.wake?.();
		this.clients.clear();
		this.server?.close();
		this.server?.closeAllConnections();
		for (const path of this.files) {
			try {
				unlinkSync(path);
			} catch {}
		}
		this.files.clear();
	}

	private authorised(request: IncomingMessage): boolean {
		const auth = Buffer.from(request.headers.authorization ?? "");
		return (
			!this.closed &&
			this.host !== undefined &&
			request.method === "POST" &&
			request.headers.origin === undefined &&
			request.headers.host === this.host &&
			request.headers["content-type"]?.split(";", 1)[0] === "application/json" &&
			auth.length === this.authorization.length &&
			timingSafeEqual(auth, this.authorization)
		);
	}

	private send(response: ServerResponse, status: number, body: unknown): void {
		const text = JSON.stringify(body);
		response.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": Buffer.byteLength(text),
			"Cache-Control": "no-store",
		});
		response.end(text);
	}

	private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
			size += bytes.length;
			if (size > BRIDGE_REQUEST_BYTES) throw new Error("The request exceeds 1 MiB.");
			chunks.push(bytes);
		}
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
		if (!isObject(value)) throw new Error("The request is not a JSON object.");
		return value;
	}

	private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			if (!this.authorised(request)) {
				response.setHeader("Connection", "close");
				this.send(response, 403, { ok: false, error: "Unauthorised Config request." });
				return;
			}
			const path = request.url ?? "";
			if (!(BRIDGE_PATHS as readonly string[]).includes(path)) {
				response.setHeader("Connection", "close");
				this.send(response, 404, { ok: false, error: "Unknown Config operation." });
				return;
			}
			this.send(response, 200, await this.dispatch(path as BridgePath, await this.body(request)));
		} catch (error) {
			if (response.headersSent) return;
			if (!request.complete) response.setHeader("Connection", "close");
			this.send(response, 409, {
				ok: false,
				error: error instanceof Error ? error.message.slice(0, 500) : "The Config operation failed.",
			});
		}
	}

	private client(body: Record<string, unknown>, connect = false): Client {
		const key = body.client;
		if (typeof key !== "string" || !UUID.test(key)) throw new Error("client is a lowercase UUID.");
		let client = this.clients.get(key);
		if (!client && connect) {
			if (this.clients.size >= MAX_CLIENTS) {
				const oldest = [...this.clients.entries()].sort((a, b) => a[1].seen - b[1].seen)[0];
				oldest[1].wake?.();
				this.clients.delete(oldest[0]);
			}
			client = { seen: Date.now(), sequence: 0, command: null, changed: false };
			this.clients.set(key, client);
		}
		if (!client) throw new Error("This Config pane is not connected.");
		client.seen = Date.now();
		return client;
	}

	/** Holds a poll open until a command, a change or the poll timeout wakes it. */
	private hold(client: Client): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, this.options.pollMs ?? BRIDGE_POLL_MS);
			client.wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}

	private connect(body: Record<string, unknown>): unknown {
		if (body.version !== 1) throw new Error("Unsupported Config bridge version.");
		this.client(body, true);
		const expected = this.options.expectedBuild?.();
		return {
			ok: true,
			context: this.options.backend.catalogue().context,
			label: this.options.label(),
			build: {
				...(expected ? { expected } : {}),
				current: expected === undefined || body.build === undefined || body.build === expected,
			},
		};
	}

	private async poll(body: Record<string, unknown>): Promise<unknown> {
		const client = this.client(body);
		if (typeof body.after !== "number") throw new Error("after is the last sequence the pane read.");
		if (!client.command && !client.changed) {
			await this.hold(client);
			client.wake = undefined;
		}
		if (this.closed) throw new Error("The Config bridge closed.");
		// Another process can change a settings file; a quiet poll compares the files' revisions.
		if (!client.command && !client.changed && client.revisions !== undefined)
			client.changed = JSON.stringify(this.options.backend.revisions()) !== client.revisions;
		const command = client.command;
		const changed = client.changed;
		client.command = null;
		client.changed = false;
		if (command || changed) client.sequence++;
		client.seen = Date.now();
		return { ok: true, sequence: client.sequence, command, changed };
	}

	private catalogue(body: Record<string, unknown>): unknown {
		const client = this.client(body);
		if (typeof body.generation !== "number" || !Number.isSafeInteger(body.generation))
			throw new Error("generation is the pane's request number.");
		const catalogue = this.options.backend.catalogue();
		client.revisions = JSON.stringify(
			Object.fromEntries(catalogue.context.documents.map((document) => [document.document, document.revision])),
		);
		// The pane correlates responses by its own request number.
		return { ok: true, generation: body.generation, catalogue: { ...catalogue, generation: body.generation } };
	}

	private async edit(body: Record<string, unknown>): Promise<unknown> {
		this.client(body);
		const request = body.request as EditRequest;
		const result = await this.options.backend.edit(request);
		return {
			ok: true,
			result:
				isObject(request) && typeof request.requestId === "string"
					? { ...result, requestId: request.requestId }
					: result,
		};
	}

	private closeClient(body: Record<string, unknown>): unknown {
		const key = body.client;
		if (typeof key === "string") {
			this.clients.get(key)?.wake?.();
			this.clients.delete(key);
		}
		return { ok: true };
	}

	private async dispatch(path: BridgePath, body: Record<string, unknown>): Promise<unknown> {
		switch (path) {
			case "/connect":
				return this.connect(body);
			case "/poll":
				return this.poll(body);
			case "/catalogue":
				return this.catalogue(body);
			case "/edit":
				return this.edit(body);
			case "/tools":
				this.client(body);
				return { ok: true, tools: this.options.backend.tools() };
			case "/tools/apply":
				this.client(body);
				return { ok: true, result: this.options.backend.applyTools(body.change as ToolsChange) };
			case "/close":
				return this.closeClient(body);
		}
	}
}
