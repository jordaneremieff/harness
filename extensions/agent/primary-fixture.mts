/**
 * Real ordinary primary AgentSession fixture for the self-compaction scenarios.
 *
 * The fixture builds an isolated cwd, agent home, and sessions root, writes a
 * wrapper extension for one scenario, and loads it with the public
 * DefaultResourceLoader. The current `index.ts` agent extension registers the
 * ordinary primary controls, including the model-only `agent_compact` tool.
 * `createAgentSession` then creates the primary session over the testModel
 * runtime. The faux provider answers the first request with the self-compaction
 * request plus the sibling tool call, and the next request with the final
 * answer. Temporary files live under the OS temporary directory and the after
 * hook disposes the session, restores the environment, and removes the root.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createTestRuntime, testModel } from "./test-runtime.mts";

export type PrimaryScenario = "resume" | "prior-drafts" | "collision" | "abort-before" | "abort-after";

export interface PrimaryFixture {
	readonly cwd: string;
	readonly agentDir: string;
	/** Every provider request context, in order, cloned before return. */
	readonly requests: TranscriptContext[];
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	/** Send one prompt and wait for the native run to become idle. */
	run(text: string): Promise<void>;
}

const SUMMARY = "CONTINUITY_CONTRACT: Finish the assigned local task. No publication authority. Retain source qualifications. Review the sibling result and return completed delivery.";

/** The scenario wrapper registers the current extension and the sibling tool. */
function wrapperSource(scenario: PrimaryScenario, indexPath: string): string {
	const before = scenario === "abort-before" ? '\tpi.on("turn_end", (_event, ctx) => { ctx.abort(); });' : "";
	const priorDrafts = scenario === "prior-drafts"
		? '\tpi.on("turn_end", (event) => event.toolResults.length ? ({ entries: [{ type: "custom", customType: "boundary.record", data: { retained: true } }, { type: "custom_message", customType: "boundary.message", content: "PRIOR_BOUNDARY_MESSAGE", display: false }, { type: "context_edit", targetId: event.toolResultEntryIds[1], replacement: { content: [{ type: "text", text: "EDITED_SIBLING_EVIDENCE" }] } }], continue: true }) : undefined);'
		: "";
	const collision = scenario === "collision"
		? '\tpi.on("turn_end", (event) => event.toolResults.length ? ({ entries: [{ type: "compaction", summary: "OTHER_CONTRACT", firstKeptEntryId: event.messageEntryId }], continue: true }) : undefined);'
		: "";
	const after = scenario === "abort-after" ? '\t\t\tpi.on("turn_end", (_event, ctx) => { ctx.abort(); });' : "";
	return `import register from ${JSON.stringify(indexPath)};
import { Type } from "typebox";
export default function (pi) {
${before}
${priorDrafts}
${collision}
	register(pi);
	pi.registerTool({
		name: "batch_evidence",
		label: "Batch evidence",
		description: "Return sibling evidence",
		parameters: Type.Object({}),
		async execute() {
${after}
			return { content: [{ type: "text", text: "SIBLING_EVIDENCE" }] };
		},
	});
}
`;
}

/** First request: the self-compaction request and the sibling call. Later requests: the final answer. */
function primaryStream(requests: TranscriptContext[], sessionId: () => string) {
	let calls = 0;
	return (_model: unknown, context: TranscriptContext) => {
		calls += 1;
		requests.push(structuredClone(context));
		const first = calls === 1;
		const reason = first ? "toolUse" as const : "stop" as const;
		const message: AssistantMessage = {
			role: "assistant",
			api: testModel.api,
			provider: testModel.provider,
			model: testModel.id,
			content: first
				? [
						{ type: "toolCall", id: "self-continuity", name: "agent_compact", arguments: { sessionId: sessionId(), summary: SUMMARY } },
						{ type: "toolCall", id: "sibling", name: "batch_evidence", arguments: {} },
					]
				: [{ type: "text", text: "DELIVERY_COMPLETE" }],
			stopReason: reason,
			timestamp: Date.now(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: message });
		events.push({ type: "done", reason, message });
		events.end(message);
		return events;
	};
}

/** Create one primary session for one self-compaction scenario. */
export async function primaryFixture(t: { after(fn: () => void): void }, scenario: PrimaryScenario): Promise<PrimaryFixture> {
	const root = mkdtempSync(join(tmpdir(), "primary-self-compaction-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(sessionsRoot);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false } }));
	writeFileSync(join(root, "continuity.ts"), wrapperSource(scenario, fileURLToPath(new URL("./index.ts", import.meta.url))));

	const previousAgentDir = process.env.PI_AGENT_DIR;
	const previousSessionsDir = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = sessionsRoot;
	let session: AgentSession | undefined;
	t.after(() => {
		try {
			session?.dispose();
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
			else process.env.PI_AGENT_DIR = previousAgentDir;
			if (previousSessionsDir === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
			else process.env.PI_AGENT_SESSIONS_DIR = previousSessionsDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	const sessionManager = SessionManager.create(cwd, sessionsRoot);
	const requests: TranscriptContext[] = [];
	const runtime = await createTestRuntime();
	const stream = primaryStream(requests, () => sessionManager.getSessionId());
	runtime.registerNativeProvider({
		id: testModel.provider,
		name: "Primary self-compaction fixture",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [join(root, "continuity.ts")] });
	await loader.reload();
	session = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, sessionManager, model: testModel, resourceLoader: loader })).session;

	return {
		cwd,
		agentDir,
		requests,
		session,
		sessionManager,
		async run(text: string): Promise<void> {
			await session?.prompt(text).catch(() => {});
			await session?.waitForIdle();
		},
	};
}
