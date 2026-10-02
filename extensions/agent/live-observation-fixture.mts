/**
 * Live-observation fixture host for transport tests.
 *
 * Run as the child process, it takes the storage claim through runHost and
 * serves a real DurableHost over the public host service surface, including the
 * live observation methods. The runtime forwards commits as change
 * notifications so the host pump publishes frames.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	const openedMarker = join(metadata.cwd, "observation-opened");
	const snapshotMarker = join(metadata.cwd, "snapshot-gated");
	const rejectReopen = process.env.DURABLE_TEST_OBSERVATION_REOPEN === "fail" && existsSync(openedMarker);
	return {
		request: async (method, params) => {
			const input = (params ?? undefined) as Record<string, unknown> | undefined;
			if (method === "snapshot" && input?.fixtureHold === true && !existsSync(snapshotMarker)) {
				writeFileSync(snapshotMarker, "held");
				await new Promise(() => {});
			}
			if (method === "observe-open") {
				if (rejectReopen) throw new Error("observation reopen refused");
				writeFileSync(openedMarker, "opened");
			}
			return durable.request(method, input);
		},
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
