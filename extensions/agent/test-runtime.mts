import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const testModel: Model<"openai-completions"> = {
	provider: "agent-test", id: "model", name: "Agent test model", api: "openai-completions",
	baseUrl: "https://invalid.test", reasoning: true, input: ["text", "image"],
	contextWindow: 128000, maxTokens: 4096, thinkingLevelMap: { minimal: null },
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Isolated model metadata; tests that request output must supply their own stream. */
export async function createTestRuntime(options: Parameters<typeof ModelRuntime.create>[0] = {}): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, ...options, refreshOnCreate: false });
	runtime.registerNativeProvider({
		id: testModel.provider, name: "Agent test provider", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: () => { throw new Error("This test must supply a synthetic stream"); },
		streamSimple: () => { throw new Error("This test must supply a synthetic stream"); },
	});
	return runtime;
}
