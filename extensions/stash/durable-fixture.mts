/**
 * Synthetic fixture for Durable stash replay tests.
 *
 * The child blocks after publication or a tool effect, before its receipt
 * commits. The test kills the child and reopens the same storage.
 */
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createEventBus, type AgentSessionServices } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { createRegistry, defineExtension, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type StashDurableHost, stashDurableContribution } from "./durable.ts";
import { captureHint } from "./launch.ts";

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
	process.env.PI_HARNESS_FILE = join(workdir, "harness.json");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const host: StashDurableHost = {
		durable: Durable,
		services: { modelRuntime: models } as unknown as AgentSessionServices,
		cwd: workdir,
		agentDir: workdir,
		storageId: "stash-replay",
		launchIndependent: async () => {
			throw new Error("replay fixture does not launch work");
		},
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [], ordinaryOnly: [] },
	};
	const registry = createRegistry();
	const contribution = stashDurableContribution(fileURLToPath(new URL("./index.ts", import.meta.url)), createEventBus(), () => {});
	registry.install(contribution.create(host));
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
	const root = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workdir },
	});
	if (mode === "distill") {
		const link = fs.link;
		fs.link = async (...args) => {
			await link(...args);
			if (dirname(String(args[1])) !== storeDir) return;
			process.stdout.write("READY\n");
			await new Promise(() => {});
		};
		syncBuiltinESMExports();
		faux.setResponses([fauxAssistantMessage('{"title":"Replay handover","summary":"Captured before restart."}')]);
		const command = contribution.commands?.[0];
		if (!command) throw new Error("Stash command is unavailable.");
		await command.run({
			args: "new",
			data: {
				...captureHint("replay"),
				transcript: "Captured source.",
				artifacts: [],
				project: workdir,
				sessionId: "source-session",
				storeDir,
			},
			conversation: root,
			context,
			host,
			invocationId: requestId,
			harness,
		});
		harness.resume();
	} else {
		await root.submit({ type: "input", content: prompt, requestId }, context);
	}
	await new Promise(() => {});
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
