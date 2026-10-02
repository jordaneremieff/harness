/**
 * Live-observation fixture host for transport tests.
 *
 * Run as the child process, it takes the storage claim through runHost and
 * serves a real DurableHost over the public host service surface, including the
 * live observation methods. The runtime forwards commits as change
 * notifications so the host pump publishes frames.
 */
import { pathToFileURL } from "node:url";
import { DurableHost } from "./durable-host.ts";
import { fixtureProvider, fixtureModelId, fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { parseHostMetadata } from "./host-protocol.ts";
import { runHost, type HostRuntime } from "./host-process.ts";

async function createRuntime(metadata: ReturnType<typeof parseHostMetadata>): Promise<HostRuntime> {
	const durable = await DurableHost.open({
		storagePath: metadata.storagePath,
		storageId: metadata.storageId,
		cwd: metadata.cwd,
		models: await fixtureRuntime("answer"),
		registry: fixtureRegistry(),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } },
		resume: true,
	});
	return {
		request: (method, params) => durable.request(method, (params ?? undefined) as Record<string, unknown> | undefined),
		close: () => durable.close(),
		isIdle: () => durable.isIdle(),
		onChange: (listener) => durable.harness.subscribeCommits(() => listener()),
	};
}

async function main(): Promise<void> {
	const raw = process.argv[2];
	if (!raw) throw new Error("live observation fixture requires metadata JSON as its only argument");
	const metadata = parseHostMetadata(JSON.parse(raw));
	const host = await runHost(() => createRuntime(metadata), { metadata });
	await host.done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	});
}
