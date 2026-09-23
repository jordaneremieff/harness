/** Public provider inheritance and per-session runtime construction. */
import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";

export async function createAgentModelRuntime(options: Parameters<typeof ModelRuntime.create>[0] = {}): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ ...options, refreshOnCreate: false });
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

export function inheritProviders(runtime: ModelRuntime, registry: ModelRegistry, selectedProvider?: string): void {
	const ids = new Set(registry.getRegisteredProviderIds());
	for (const id of new Set(registry.getAll().map((model) => model.provider))) {
		if (registry.getProviderAuthStatus(id).source === "runtime") ids.add(id);
	}
	if (selectedProvider) ids.add(selectedProvider);
	for (const id of ids) {
		// Copy the composed provider once. Registering its config afterward would
		// replace this native registration and discard delegated authentication.
		const provider = registry.getProvider(id);
		if (provider && registry.getProviderAuthStatus(id).source === "runtime") {
			runtime.registerNativeProvider({
				...provider,
				auth: { ...provider.auth, apiKey: {
					name: provider.auth.apiKey?.name ?? "Primary runtime authentication",
					check: async () => registry.getProviderAuthStatus(id).configured ? { type: "api_key" } : undefined,
					resolve: async () => registry.getProviderAuth(id),
				} },
				// The registry also owns model-specific headers outside Provider.
				// Resolve those and authentication at each request, never in records.
				// The calling runtime already consumed the request's header transform.
				stream: (model, context, options) => registry.stream(model, context, options && { ...options, transformHeaders: undefined }),
				streamSimple: (model, context, options) => registry.streamSimple(model, context, options),
			});
			continue;
		}
		const native = registry.getRegisteredNativeProvider(id);
		const config = registry.getRegisteredProviderConfig(id);
		if (native) runtime.registerNativeProvider(native);
		else if (config) runtime.registerProvider(id, config);
	}
}
