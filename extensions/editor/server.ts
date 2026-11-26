import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { authorised, json, jsonBody, listen, type Payload } from "./local.ts";

const assets = new URL("./web/", import.meta.url);
const types: Record<string, string> = {
	html: "text/html",
	ts: "text/javascript",
	css: "text/css",
};
async function asset(req: IncomingMessage, res: ServerResponse, staticFiles: Map<string, Buffer>) {
	const name = req.url === "/" ? "index.html" : (req.url ?? "").slice(1);
	if (req.method !== "GET" || !/^[a-z][a-z0-9-]{0,39}\.(?:ts|css|html)$/.test(name))
		return json(res, 404, { error: "Not found." });
	let content = staticFiles.get(name);
	if (!content) {
		try {
			const bytes = await readFile(new URL(name, assets));
			content = name.endsWith(".ts") ? Buffer.from(stripTypeScriptTypes(bytes.toString("utf8"))) : bytes;
			staticFiles.set(name, content);
		} catch {
			return json(res, 404, { error: "Not found." });
		}
	}
	res.writeHead(200, { "Content-Type": `${types[name.split(".")[1]]}; charset=utf-8`, "Cache-Control": "no-store" });
	res.end(content);
}
export async function serveEditor(run: (input: Payload, signal: AbortSignal) => Promise<Payload>) {
	const key = randomBytes(32).toString("hex");
	const staticFiles = new Map<string, Buffer>();
	const server = await listen(async (req, res) => {
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		);
		if (req.method === "POST" && req.url === "/api") {
			if (!authorised(req, key)) return json(res, 403, { error: "This tab is not connected to the editor." });
			const input = await jsonBody(req, 8 * 1024 * 1024);
			const controller = new AbortController();
			res.once("close", () => controller.abort());
			const output = await run(input, controller.signal);
			if (!res.destroyed) json(res, 200, output);
			return;
		}
		await asset(req, res, staticFiles);
	});
	return {
		url(file?: string) {
			const params = new URLSearchParams({ k: key });
			if (file) params.set("file", file);
			return `${server.origin}/#${params}`;
		},
		close: server.close,
	};
}
