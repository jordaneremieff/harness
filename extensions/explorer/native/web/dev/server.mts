import { once } from "node:events";
import { type FSWatcher, mkdtempSync, readdirSync, readFileSync, rmSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "./bridge.mts";
import { createFixture, defaultPath } from "./fixture.mts";

const bind = "127.0.0.1";
const csp =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const web = fileURLToPath(new URL("../", import.meta.url));
const KiB = 1024;
const MiB = 1024 * KiB;

function build() {
	const files = new Map<string, { type: string; body: string | Buffer }>();
	const add = (path: string, type: string, body: string | Buffer) => files.set(`/${path}`, { type, body });
	const visit = (path: string, callback: (path: string) => void) => {
		for (const entry of readdirSync(join(web, path), { withFileTypes: true })) {
			const child = `${path}/${entry.name}`;
			if (entry.isDirectory()) visit(child, callback);
			else if (entry.isFile()) callback(child);
		}
	};
	visit("app", (path) => {
		if (path.endsWith(".ts") && !path.endsWith(".d.ts") && !path.endsWith(".test.ts")) {
			add(
				path.replace(/\.ts$/, ".js"),
				"text/javascript; charset=utf-8",
				stripTypeScriptTypes(readFileSync(join(web, path), "utf8")),
			);
		}
	});
	visit("styles", (path) => {
		if (path.endsWith(".css")) add(path, "text/css; charset=utf-8", readFileSync(join(web, path)));
	});
	const source = readFileSync(join(web, "index.html"), "utf8");
	const policy = /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/i;
	if (!policy.test(source)) throw new Error("Explorer index is missing its CSP meta tag.");
	const html = source.replace(
		policy,
		`<meta http-equiv="Content-Security-Policy" content="${csp}">\n<script defer src="/boot.js"></script>`,
	);
	add("index.html", "text/html; charset=utf-8", html);
	add("", "text/html; charset=utf-8", html);
	add(
		"boot.js",
		"text/javascript; charset=utf-8",
		stripTypeScriptTypes(readFileSync(join(web, "dev/boot.ts"), "utf8")),
	);
	return files;
}

const error = (code: string, message: string) => ({ ok: false, error: { code, message } });

async function handlePost(
	req: IncomingMessage,
	bridge: ReturnType<typeof createBridge>,
	json: (status: number, body: unknown) => void,
) {
	if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
		json(415, error("invalid", "Expected a JSON bridge packet."));
		return;
	}
	const chunks = [];
	let length = 0;
	for await (const chunk of req.iterator({ destroyOnReturn: false })) {
		length += chunk.length;
		if (length > 13 * MiB) {
			json(413, error("invalid", "Bridge packet exceeds its size limit."));
			req.resume();
			return;
		}
		chunks.push(chunk);
	}
	const packet = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (length > 256 * KiB && !["file.write", "edit.draft", "clipboard.write"].includes(packet?.type)) {
		json(413, error("invalid", "Bridge packet exceeds its size limit."));
		return;
	}
	const result = bridge.handle(packet);
	const reply = JSON.stringify(result);
	const large = [
		"files.list",
		"files.folder",
		"search",
		"file.read",
		"review.diff",
		"edit.draft",
		"edit.paths",
		"clipboard.read",
	].includes(packet?.type);
	if (Buffer.byteLength(reply) > (large ? 32 * MiB : 256 * KiB))
		json(413, error("invalid", "Bridge reply exceeds the size limit."));
	else json(200, result);
}

function sameOrigin(req: IncomingMessage, host: string, origin: string) {
	const suppliedOrigin = req.headers.origin;
	return (
		req.headers.host === host &&
		(!suppliedOrigin || suppliedOrigin === origin) &&
		!["cross-site", "same-site"].includes(req.headers["sec-fetch-site"] ?? "")
	);
}

export async function startDevHost(port = 0) {
	const files = build();
	const directory = mkdtempSync(join(tmpdir(), "explorer-dev-"));
	const clients = new Set<ServerResponse>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let watcher: FSWatcher | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let server: Server | undefined;
	function schedule(fn: () => void, delay: number) {
		const timer = setTimeout(() => {
			timers.delete(timer);
			fn();
		}, delay);
		timers.add(timer);
	}
	async function close() {
		clearTimeout(debounce);
		for (const timer of timers) clearTimeout(timer);
		watcher?.close();
		for (const client of clients) client.end();
		const active = server;
		if (active?.listening) {
			const closed = new Promise<void>((resolve) => active.close(() => resolve()));
			active.closeAllConnections();
			await closed;
		}
		rmSync(directory, { recursive: true, force: true });
	}
	try {
		const repo = createFixture(directory);
		const emit: Parameters<typeof createBridge>[1] = (event) => {
			for (const client of clients) client.write(`data: ${JSON.stringify({ v: 1, ...event })}\n\n`);
		};
		const bridge = createBridge(repo, emit, schedule);
		const changed = new Set<string>();
		const structural = new Set<string>();
		let unknown = false;
		const flush = () => {
			try {
				bridge.changed([...changed].sort(), structural, unknown);
			} catch (watchError) {
				console.error("Could not read fixture changes:", watchError);
			} finally {
				changed.clear();
				structural.clear();
				unknown = false;
			}
		};
		function markChanged(event: string, name: string) {
			if (unknown) return;
			changed.add(name);
			if (event === "rename") structural.add(name);
			if (changed.size > 512) unknown = true;
		}
		function gitMetadata(name: string) {
			return name.endsWith("/.git/HEAD") || name === ".git/HEAD" || name.includes(".git/refs/");
		}
		watcher = watch(repo.root, { recursive: true }, (event, name) => {
			if (!name) unknown = true;
			else if (!name.split("/").includes(".git")) markChanged(event, name);
			else if (!gitMetadata(name)) return;
			clearTimeout(debounce);
			debounce = setTimeout(flush, 100);
		});
		watcher.on("error", (watchError) => console.error("Could not watch the fixture:", watchError.message));
		function subscribe(res: ServerResponse) {
			res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
			res.write(`data: ${JSON.stringify({ v: 1, type: "live", ...bridge.live })}\n\n`);
			clients.add(res);
			res.on("close", () => clients.delete(res));
		}
		function findAsset(path: string) {
			const asset = files.get(path);
			if (asset) return asset;
			const image = bridge.asset(path);
			if (image?.bytes && image.mediaType) return { type: image.mediaType, body: image.bytes };
		}
		function sendAsset(res: ServerResponse, path: string) {
			if (path === "/events") {
				subscribe(res);
				return true;
			}
			const asset = findAsset(path);
			if (!asset) return false;
			res.writeHead(200, { "Content-Type": asset.type });
			res.end(asset.body);
			return true;
		}
		let origin = "";
		let host = "";
		server = createServer(async (req, res) => {
			res.setHeader("Content-Security-Policy", csp);
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("X-Content-Type-Options", "nosniff");
			const send = (status: number, type: string, body: string | Buffer) => {
				res.writeHead(status, { "Content-Type": type });
				res.end(body);
			};
			const json = (status: number, body: unknown) =>
				send(status, "application/json; charset=utf-8", JSON.stringify(body));
			if (!sameOrigin(req, host, origin))
				return json(403, error("forbidden", "Use the loopback origin printed by the dev host."));
			const path = req.url ?? "";
			try {
				if (req.method === "POST" && path === "/bridge") {
					await handlePost(req, bridge, json);
					return;
				}
				if (req.method === "GET" && sendAsset(res, path)) return;
				json(404, error("not-found", "No such dev route."));
			} catch {
				if (!res.headersSent) json(400, error("invalid", "Could not read the request or asset."));
			}
		});
		server.requestTimeout = 10_000;
		server.listen(port, bind);
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No loopback address.");
		host = `${bind}:${address.port}`;
		origin = `http://${host}`;
		return { url: `${origin}/`, root: repo.root, close };
	} catch (startupError) {
		await close();
		throw startupError;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [rawPort = "0", ...extra] = process.argv.slice(2);
	const port = Number(rawPort);
	if (extra.length || !/^\d+$/.test(rawPort) || port > 65_535) throw new Error("Usage: node server.mts [port]");
	const dev = await startDevHost(port);
	const stop = () => void dev.close();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	console.log(`Explorer dev: ${dev.url}\nFixture: ${dev.root}\nDefault file: ${defaultPath} (uncommitted changes)`);
}
