import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const agentDir = mkdtempSync(join(tmpdir(), "subagent-sametrust-agent-"));
const home = mkdtempSync(join(tmpdir(), "subagent-sametrust-home-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Sessions discover user resources under $HOME. An empty home keeps the
// observed resource set exactly what this fixture writes.
process.env.HOME = home;

/**
 * Seed a trust-requiring directory whose project extension records that it
 * ran. Returns the marker path.
 */
function seedProject(cwd: string, label: string): string {
	const marker = join(agentDir, `${label}-extension-ran`);
	const extensionPath = join(cwd, "project-extension.mjs");
	writeFileSync(
		extensionPath,
		`import { appendFileSync } from "node:fs";
export default function (pi) {
  appendFileSync(${JSON.stringify(marker)}, "factory\\n");
  pi.on("session_start", () => appendFileSync(${JSON.stringify(marker)}, "start\\n"));
}
`,
		"utf8",
	);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [extensionPath] }), "utf8");
	return marker;
}

function fauxModel(label: string): Record<string, unknown> {
	return {
		id: `sametrust-model-${label}`,
		name: `Same Trust Model ${label}`,
		api: `sametrust-api-${label}`,
		provider: `sametrust-provider-${label}`,
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

function registerFaux(runtime: any, label: string): Record<string, unknown> {
	const model = fauxModel(label);
	const faux = fauxProvider({
		api: model.api as string,
		provider: model.provider as string,
		models: [{ id: model.id as string }],
	});
	faux.setResponses(
		Array.from({ length: 8 }, () =>
			fauxAssistantMessage(fauxToolCall("submit_result", { content: "SAME_TRUST_RESULT" }), {
				stopReason: "toolUse",
			}),
		),
	);
	runtime.registerProvider(model.provider as string, {
		api: model.api,
		apiKey: "not-used",
		baseUrl: model.baseUrl,
		models: [model],
		streamSimple: faux.provider.streamSimple,
	});
	return model;
}

// Case A: the session trusts the directory (session-only answer; store says
// false). A same-directory worker must inherit the live decision and load.
const trustedBySession = mkdtempSync(join(tmpdir(), "subagent-sametrust-trusted-"));
// Case B: the session refuses the directory (override or refusal; store says
// true). A same-directory worker must inherit the refusal and not load.
const refusedBySession = mkdtempSync(join(tmpdir(), "subagent-sametrust-refused-"));

const trustedMarker = seedProject(trustedBySession, "trusted");
const refusedMarker = seedProject(refusedBySession, "refused");
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}), "utf8");

const sub = await import("./index.ts");
const sessions: any[] = [];
try {
	const {
		createAgentSessionFromServices,
		createAgentSessionServices,
		ModelRegistry,
		ProjectTrustStore,
		SessionManager,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");
	const store = new ProjectTrustStore(agentDir);
	store.set(trustedBySession, false);
	store.set(refusedBySession, true);

	const selfPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

	async function hostSession(cwd: string, sessionTrusted: boolean, label: string): Promise<any> {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: sessionTrusted }),
			resourceLoaderOptions: { additionalExtensionPaths: [selfPath] },
		});
		const model = registerFaux(services.modelRuntime, label);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model: model as never,
			thinkingLevel: "off",
			tools: ["subagent", "read"],
		});
		const session = created.session;
		sessions.push(session);
		const sessionId = session.sessionManager.getSessionId();
		sub.sharedWorkerState.workerSessionIds.add(sessionId);
		await session.bindExtensions({});
		const dispatch = session.extensionRunner.getToolDefinition("subagent");
		assert.ok(dispatch);
		return { session, sessionId, dispatch, model };
	}

	async function runWorker(host: any, marker: string, shouldLoad: boolean): Promise<void> {
		const registry = new ModelRegistry(host.session.modelRuntime);
		const result = (await host.dispatch.execute(
			"same-trust",
			{
				task: "work here",
				tools: ["read"],
				model: `${host.model.provider}/${host.model.id}`,
			},
			undefined,
			undefined,
			{
				cwd: host.session.sessionManager.getCwd(),
				thinkingLevel: "off",
				model: host.model,
				modelRegistry: registry,
				sessionManager: { getSessionId: () => host.sessionId },
				ui: { setStatus: () => undefined },
				isProjectTrusted: () => host.session.settingsManager.isProjectTrusted(),
			},
		)) as any;
		const id = result.details.workers[0].id as string;
		assert.ok(id, JSON.stringify(result));
		const deadline = Date.now() + 10_000;
		let record = sub.readWorker(id);
		while (Date.now() < deadline && record?.state === "running") {
			await new Promise((resolve) => setTimeout(resolve, 10));
			record = sub.readWorker(id);
		}
		assert.equal(record?.state, "done", JSON.stringify(record));
		if (shouldLoad) {
			assert.equal(
				existsSync(marker) ? readFileSync(marker, "utf8") : "",
				"factory\nstart\n",
				"a same-directory worker must inherit the session's live trust and load the project extension",
			);
		} else {
			assert.equal(
				existsSync(marker),
				false,
				"a same-directory worker must inherit the session's refusal and not load the project extension",
			);
		}
	}

	// Case A: session trusted at a directory the store refuses. The worker must
	// still load (the store alone would have blocked it).
	const hostA = await hostSession(trustedBySession, true, "a");
	await runWorker(hostA, trustedMarker, true);

	// Case B: session refuses at a directory the store trusts. The worker must
	// not load (the store alone would have loaded it).
	const hostB = await hostSession(refusedBySession, false, "b");
	await runWorker(hostB, refusedMarker, false);

	console.log("same-cwd trust child: PASS");
} finally {
	for (const session of sessions) {
		try {
			sub.shutdownWorkerSession(session);
		} catch {}
	}
	for (const dir of [agentDir, home, trustedBySession, refusedBySession]) {
		rmSync(dir, { recursive: true, force: true });
	}
}
