/** An ordinary SDK caller driven by IPC, with no replacement host runner. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface CallerInput { packageDir: string; cwd: string; agentDir: string; sessionDir: string; extension: string; fixture: string }
const input = JSON.parse(process.argv[2] ?? "{}") as CallerInput;
const manifest = JSON.parse(readFileSync(join(input.packageDir, "package.json"), "utf8")) as { exports: { ".": { import: string } } };
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(resolve(input.packageDir, manifest.exports["."].import)).href);
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: false } });
const loader = new sdk.DefaultResourceLoader({ cwd: input.cwd, agentDir: input.agentDir, settingsManager, additionalExtensionPaths: [input.extension, input.fixture], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload({ resolveProjectTrust: async () => true });
const sessionManager = sdk.SessionManager.create(input.cwd, input.sessionDir);
const { session } = await sdk.createAgentSession({ cwd: input.cwd, agentDir: input.agentDir, resourceLoader: loader, settingsManager, sessionManager, thinkingLevel: "off", tools: ["agent_spawn", "agent_inspect", "agent_send"], model: { provider: "durable-runtime-fixture", id: "fixture-model", name: "Continuity fixture", api: "openai-completions", baseUrl: "https://invalid.test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
await session.bindExtensions({ mode: "print" });
const send = (value: unknown) => new Promise<void>((resolveSent, reject) => {
	if (!process.send) { reject(new Error("Caller IPC is required")); return; }
	if (Buffer.byteLength(JSON.stringify(value)) > 65536) { reject(new Error("Caller evidence exceeds the IPC bound")); return; }
	process.send(value, (error) => error ? reject(error) : resolveSent());
});
session.subscribe((event) => {
	if (event.type === "tool_execution_end") void send({ kind: "tool", name: event.toolName, result: event.result, isError: event.isError }).catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
});
await send({ kind: "ready", pid: process.pid, packageDir: sdk.getPackageDir(), sessionId: sessionManager.getSessionId() });
let sequence = Promise.resolve();
process.on("message", (value: unknown) => {
	const command = value as { op: string; text?: string };
	sequence = sequence.then(async () => {
		if (command.op === "prompt") { await session.prompt(command.text ?? ""); await send({ kind: "prompt-done" }); }
		if (command.op === "exit") { session.dispose(); await send({ kind: "exiting", pid: process.pid }); process.disconnect(); process.exit(0); }
	}).catch(async (error: unknown) => { await send({ kind: "error", error: String(error) }); });
});
