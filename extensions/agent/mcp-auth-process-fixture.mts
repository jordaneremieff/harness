import { NativeMcpAuth } from "./mcp-auth.ts";

const [agentDir, url] = process.argv.slice(2);
if (!agentDir || !url || !process.send) throw new Error("Expected isolated auth directory, server URL and IPC channel");
const owner = new NativeMcpAuth(agentDir);
try {
	const auth = owner.provider("docs", { url }, (value) => value);
	const refresh = auth.onUnauthorized({ token: "synthetic-old", serverUrl: new URL(url), fetch: globalThis.fetch, response: new Response(null, { status: 401 }) });
	process.send({ type: "starting" });
	await refresh;
	console.log(JSON.stringify({ token: await auth.token() }));
} finally {
	await owner.close();
	process.disconnect();
}
