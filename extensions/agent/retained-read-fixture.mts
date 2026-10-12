/** Child writer that stops with retained tool work and queued input. */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import { DurableHost } from "./durable-host.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { completed, fixtureProvider, fixtureRegistry, hostOptions, toolCallMessage } from "./durable-host-fixture.mts";

async function main(): Promise<void> {
	const [storagePath, storageId, effectsPath] = process.argv.slice(2);
	const tool = defineTool({
		name: "retained-gate", description: "Block with retained work.", parameters: Type.Object({}),
		execute: async () => {
			appendFileSync(effectsPath, "tool\n");
			process.stdout.write("TOOL\n");
			await new Promise(() => {});
			return {};
		},
	});
	const runtime = await createTestRuntime();
	const stream = () => { appendFileSync(effectsPath, "model\n"); return completed(toolCallMessage("retained-gate")); };
	runtime.registerNativeProvider({ id: fixtureProvider, name: "Retained fixture provider", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	const host = await DurableHost.open({ ...hostOptions(storagePath, runtime, fixtureRegistry([tool])), storageId });
	await host.submit({ message: "unfinished tool input", requestId: "unfinished" });
	await host.submit({ message: "queued retained input", requestId: "queued", whenBusy: "followUp" });
	process.stdout.write("QUEUED\n");
	// Keep the writer alive until the test terminates it at the retained-work barrier.
	process.stdin.resume();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
