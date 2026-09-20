import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentModelRuntime } from "./index.ts";

describe("agent model runtime", () => {
	it("reads stored credentials in the local refresh without network discovery", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("refresh-contract", async () => ({ type: "api_key", key: "stored" }));
		const runtime = await createAgentModelRuntime({ credentials, modelsPath: null });
		// storedProviders is populated by the refresh; without it provider
		// selection and auth checks read as unconfigured.
		assert.deepEqual(runtime.getProviderAuthStatus("refresh-contract"), { configured: true, source: "stored" });
	});
});
