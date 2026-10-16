/** Isolated SDK primary and durable source; the parent exits this process while a notice is only queued. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getPackageDir } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureRuntime, fixtureProvider, fixtureModelId } from "./durable-host-fixture.mts";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { AgentDeliveryDoc, recordReport } from "./durable-controls.ts";
import { startDurableDelivery } from "./durable-delivery.ts";

const [cwd, agentDir, sessionsRoot] = process.argv.slice(2);
if (!cwd || !agentDir || !sessionsRoot || !process.send) throw new Error("The retention fixture requires isolated paths and IPC");
const settingsManager = SettingsManager.create(cwd, agentDir), sessionManager = SessionManager.create(cwd, sessionsRoot);
let started!: () => void;
const entered = new Promise<void>((resolve) => { started = resolve; });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	extensionFactories: [(pi) => { register(pi); pi.on("before_agent_start", async () => { started(); await new Promise<void>(() => {}); }); }],
});
await loader.reload();
const session = (await createAgentSession({ cwd, agentDir, modelRuntime: await createTestRuntime(), settingsManager, sessionManager, model: testModel, resourceLoader: loader, tools: [] })).session;
await session.bindExtensions({});
sessionManager.appendMessage({ role: "user", content: "Retained seed", timestamp: Date.now() });
void session.prompt("Hold startup"); await entered;
const catalog = new AgentCatalog(sessionsRoot);
const record = catalog.create({ cwd, agentDir, packageDir: getPackageDir(), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
const metadata = hostMetadata(record);
const source = await DurableHost.open({ storagePath: metadata.storagePath, storageId: record.storageId, cwd, models: await fixtureRuntime("answer"), registry: fixtureRegistry(), agent: { model: metadata.model } });
const report = await recordReport(source.harness, { ownerId: sessionManager.getSessionId(), senderIdentity: record.storageId, message: "VOLATILE_NOTICE", requestId: "retention-exit" }, BACKGROUND_CONTEXT);
await recordReport(source.harness, { ownerId: record.storageId, senderIdentity: record.storageId, message: "Independent notice", requestId: "independent" }, BACKGROUND_CONTEXT);
let sent = false;
startDurableDelivery({ host: source, metadata, catalog, sessionsRoot, signal: new AbortController().signal, retryDelayMs: 60_000, onIdle: () => {
	if (sent) return; sent = true;
	void source.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT).then((state) => process.send?.({ metadata, ownerId: sessionManager.getSessionId(), sessionFile: sessionManager.getSessionFile(), sourceId: `${record.storageId}:${report.sourceId}`, acknowledged: state?.reports[0]?.acknowledged, independentAcknowledged: state?.reports[1]?.acknowledged, queued: session.agent.peekQueuedMessages().length }));
} });
