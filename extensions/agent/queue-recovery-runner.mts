/** Process fixture: run selected repository source with a producer-controlled model. */
import { writeFileSync } from "node:fs";
import { isBuiltin, registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { answerMessage, completed, fixtureRegistry, hostOptions, pending } from "./durable-host-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import type { HostMetadata } from "./host-protocol.ts";
import type { DurableHost as DurableHostType } from "./durable-host.ts";

const [source, seedInput, encoded] = process.argv.slice(2);
if (!source || !seedInput || !encoded) throw new Error("Expected source directory, queue seed, and host metadata");
const metadata = JSON.parse(encoded) as HostMetadata;
// An archived tree uses the same installed public packages, without node_modules copies or links.
const packageParent = new URL("../../package.json", import.meta.url).href;
registerHooks({ resolve(specifier, input, next) {
	const bare = !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":") && !isBuiltin(specifier);
	return next(specifier, bare && !input.parentURL?.includes("/node_modules/") ? { ...input, parentURL: packageParent } : input);
} });
const { runHost } = await import(pathToFileURL(join(source, "host-process.ts")).href) as typeof import("./host-process.ts");
const { DurableHost } = await import(pathToFileURL(join(source, "durable-host.ts")).href) as typeof import("./durable-host.ts");
const models = await createTestRuntime();
let released = false;
const streams: ReturnType<typeof pending>[] = [];
const seen = new Set<string>();
const streamSimple = (_model: unknown, input: TranscriptContext) => {
	for (const message of input.messages) if (message.role === "user" && typeof message.content === "string") seen.add(message.content);
	if (released) return completed(answerMessage("Recovered answer"));
	const stream = pending(answerMessage("Held request"));
	streams.push(stream);
	return stream;
};
models.registerNativeProvider({
	id: testModel.provider, name: "Queue recovery model", getModels: () => [testModel],
	auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
	stream: streamSimple, streamSimple,
});
async function seedQueue(host: DurableHostType, input: Record<string, unknown>): Promise<unknown> {
	const messages = input.messages as string[]; const requestIds = input.requestIds as string[];
	if (!Array.isArray(messages) || messages.length > 129 || requestIds.length !== messages.length) throw new Error("Expected a bounded queue seed");
	for (const [index, message] of messages.entries()) await host.request("submit", { sessionId: metadata.storageId, requestId: requestIds[index], ownerId: metadata.ownerId, origin: "operator", message, whenBusy: "followUp", checkInMinutes: 0 });
	return host.request("receipts", { ownerId: metadata.ownerId, wait: false });
}
const running = await runHost(async () => {
	const host = await DurableHost.open({ ...hostOptions(metadata.storagePath, models, fixtureRegistry(), metadata.cwd), storageId: metadata.storageId, meta: { owner: metadata.ownerId } }, context);
	const seed = JSON.parse(seedInput) as Record<string, unknown> | null;
	if (seed !== null) writeFileSync(`${metadata.storagePath}.seed.json`, JSON.stringify(await seedQueue(host, seed)));
	return {
		request: async (method, params) => {
			const input = params as Record<string, unknown> | undefined;
			if (method !== "command" || input?.name !== "drain") return host.request(method, input);
			released = true;
			for (const stream of streams.splice(0)) {
				const answer = answerMessage("Recovered answer");
				stream.push({ type: "done", reason: "stop", message: answer });
				stream.end(answer);
			}
			await host.harness.waitForIdle(context);
			return { delivery: await host.request("receipts", { ownerId: metadata.ownerId, wait: false }), seen: [...seen] };
		},
		close: () => host.close(), isIdle: () => false,
	};
}, { metadata });
await running.done;
