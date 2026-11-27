import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export type Payload = Record<string, unknown>;

export async function jsonBody(request: IncomingMessage, max: number): Promise<Payload> {
	if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw Error("Expected a JSON request.");
	const parts: Buffer[] = [];
	let bytes = 0;
	for await (const part of request) {
		const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
		bytes += buffer.length;
		if (bytes > max) throw Error("Request exceeds the size limit.");
		parts.push(buffer);
	}
	const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected an object.");
	return value as Payload;
}

export function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(value));
}

export function authorised(request: IncomingMessage, key: string): boolean {
	const actual = Buffer.from(request.headers.authorization ?? "");
	const expected = Buffer.from(`Bearer ${key}`);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function listen(
	handler: (req: IncomingMessage, res: ServerResponse, origin: string) => Promise<void>,
	idleTimeout = 20000,
) {
	let origin = "";
	const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 15000 }, (req, res) => {
		if (!origin || `http://${req.headers.host}` !== origin || (req.headers.origin && req.headers.origin !== origin)) {
			json(res, 403, { error: "Not a request from this editor." });
			return;
		}
		void handler(req, res, origin).catch((err: unknown) => {
			if (res.headersSent || res.destroyed) return res.end();
			const code = err instanceof Error && "code" in err ? String(err.code) : "invalid";
			json(res, code === "conflict" ? 409 : 400, {
				code,
				error: err instanceof Error ? err.message : "Request refused.",
			});
		});
	});
	server.keepAliveTimeout = 1500;
	server.maxConnections = 64;
	server.setTimeout(idleTimeout, (socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw Error("Editor did not receive a local port.");
	origin = `http://127.0.0.1:${address.port}`;
	server.unref();
	return {
		origin,
		port: address.port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
