/**
 * Synthetic fixture for Durable stash replay tests.
 *
 * The child runs one stash tool to a durable checkpoint, blocks in an
 * `afterTool` hook before its result commits, and waits to be killed. The test
 * then reopens the same storage without the blocking hook.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { createRegistry, defineExtension, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { stashDurableContribution, type StashDurableHost } from "./durable.ts";

const context = BACKGROUND_CONTEXT;

/** Block in afterTool after the effect, so a kill lands between effect and result. */
function blockingHook(toolName: string) {
	return defineExtension({
		name: "stash-replay-block",
		hooks: [
			hook(ToolTask, {
				afterTool: async (call) => {
					if (call.name !== toolName) return undefined;
					process.stdout.write("READY\n");
					await new Promise(() => {});
					return undefined;
				},
			}),
		],
	});
}

async function main(): Promise<number> {
	const [storagePath, mode, storeDir, workdir, artifactId, prompt, requestId] = process.argv.slice(2);
	if (!storagePath || !mode || !storeDir || !workdir || !prompt || !requestId) return 2;
	process.env.PI_STASH_DIR = storeDir;
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const host: StashDurableHost = {
		durable: Durable,
		services: { modelRuntime: models } as unknown as AgentSessionServices,
		cwd: workdir,
		agentDir: workdir,
		storageId: "stash-replay",
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [], ordinaryOnly: [] },
	};
	const registry = createRegistry();
	registry.install(
		stashDurableContribution(fileURLToPath(new URL("./index.ts", import.meta.url))).create(host),
	);
	registry.install(blockingHook(mode === "write" ? "stash_write" : "stash_complete"));
	faux.setResponses([
		fauxAssistantMessage(
			mode === "write"
				? fauxToolCall("stash_write", { title: "Replay handover", summary: "Written before the process died." })
				: fauxToolCall("stash_complete", { id: artifactId ?? "", outcome: "Closed before the process died." }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("recovered"),
	]);
	const harness = await Harness.open(await openNodeSqliteStorage(storagePath), { models, registry }, context);
	harness.resume();
	const root = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workdir },
	});
	await root.submit({ type: "input", content: prompt, requestId }, context);
	await new Promise(() => {});
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
