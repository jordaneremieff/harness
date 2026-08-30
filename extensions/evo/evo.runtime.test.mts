import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface ReportedExtensionError {
	extensionPath: string;
	event: string;
	error: string;
}

test("Pi reports mode rejection and asynchronous send errors through separate runtime paths", async () => {
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));

	async function runtimeErrors(mode: "print" | "rpc"): Promise<ReportedExtensionError[]> {
		const agentDir = mkdtempSync(join(tmpdir(), "evo-runtime-"));
		try {
			const settingsManager = SettingsManager.create(agentDir, agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd: agentDir,
				agentDir,
				settingsManager,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
				additionalExtensionPaths: [extensionPath],
			});
			await resourceLoader.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			const { session } = await createAgentSession({
				cwd: agentDir,
				agentDir,
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(),
				tools: [],
			});
			if (mode === "rpc") {
				Object.defineProperty(session, "sendUserMessage", {
					value: async () => {
						throw new Error("model-free send rejection probe");
					},
				});
			}
			const errors: ReportedExtensionError[] = [];
			try {
				await session.bindExtensions({ mode, onError: (error) => errors.push(error) });
				await session.prompt("/evo", { expandPromptTemplates: true });
				await new Promise((resolve) => setImmediate(resolve));
				return errors;
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	}

	assert.deepEqual(await runtimeErrors("print"), [
		{
			extensionPath: "command:evo",
			event: "command",
			error: "The evo command requires TUI or RPC mode.",
		},
	]);
	assert.deepEqual(await runtimeErrors("rpc"), [
		{
			extensionPath: "<runtime>",
			event: "send_user_message",
			error: "model-free send rejection probe",
		},
	]);
});
