/** Isolated runtime release through a test-only status request. */
import { bindInstallationPackages } from "./installation-binding.ts";

const input = JSON.parse(process.argv[2] ?? "null") as { packageDir: string };
bindInstallationPackages(input.packageDir, new URL("./", import.meta.url));
const [{ parseHostMetadata }, { runHost }, { createDurableRuntime }] = await Promise.all([import("./host-protocol.ts"), import("./host-process.ts"), import("./durable-runtime.ts")]);
const metadata = parseHostMetadata(input);
const processHost = await runHost(async () => {
	const runtime = await createDurableRuntime(metadata);
	const request = runtime.request.bind(runtime);
	return { ...runtime, request: async (method: string, params: unknown, requestId: string, signal?: AbortSignal) => {
		if (method === "status" && (params as { releaseFixture?: boolean })?.releaseFixture) {
			if (runtime.requestRelease === undefined) throw new Error("Runtime release is unavailable");
			return runtime.requestRelease();
		}
		return request(method, params, requestId, signal);
	} };
}, { metadata, idleMs: 3600000, exit: () => process.exit(0) });
await processHost.done;
