import { CONFIG_DIR_NAME, getPackageDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { SettingsHost } from "./catalogue.ts";
import { SettingsBackend } from "./operations.ts";
import type { Bus } from "./owners.ts";
import { publishSettings } from "./settings.ts";
import {
	DESCRIPTIONS,
	EditParameters,
	FindParameters,
	GetParameters,
	GUIDANCE,
	runEdit,
	runFind,
	runGet,
	runTools,
	ToolsParameters,
	text,
} from "./tools.ts";

export interface SettingsDurableHost {
	readonly durable: typeof Durable;
	readonly agentDir: string;
	readonly cwd: string;
	readonly services: { readonly settingsManager: { isProjectTrusted(): boolean; getSettings(): unknown } };
	onClose(dispose: () => void | Promise<void>): void;
}

/** The Durable form: the same backend over the host's own facts, without session tool controls. */
export function settingsContribution(source: string, bus: Bus, stopFactoryPublisher: () => void) {
	return {
		name: "settings",
		source,
		create(host: SettingsDurableHost): Durable.Extension {
			stopFactoryPublisher();
			host.onClose(publishSettings(bus, { agentDir: host.agentDir }));
			const facts = (): SettingsHost => ({
				kind: "durable",
				agentDir: host.agentDir,
				cwd: host.cwd,
				projectTrusted: host.services.settingsManager.isProjectTrusted(),
				bus,
				env: process.env,
				pi: { version: VERSION, packageDir: getPackageDir(), configDir: CONFIG_DIR_NAME, SettingsManager },
				sessionSettings: () => host.services.settingsManager.getSettings(),
			});
			const backend = new SettingsBackend(facts);
			const tool = <T>(
				name: string,
				description: string,
				parameters: Parameters<typeof host.durable.defineTool>[0]["parameters"],
				replay: "safe" | "unsafe",
				run: (input: T) => unknown | Promise<unknown>,
			) =>
				host.durable.defineTool({
					name,
					description,
					parameters,
					replay,
					outputLimits: { maxBytes: 128 * 1024, maxLines: 4000 },
					async execute(input) {
						try {
							const value = await run(input as T);
							return { output: text(value), details: { summary: name } };
						} catch (error) {
							return {
								output: text({ error: error instanceof Error ? error.message : String(error) }),
								details: { summary: name },
								isError: true,
							};
						}
					},
				});
			return host.durable.defineExtension({
				name: "settings",
				tools: [
					tool("settings_find", DESCRIPTIONS.find, FindParameters, "safe", (input) => runFind(backend, input as never)),
					tool("settings_get", DESCRIPTIONS.get, GetParameters, "safe", (input) => runGet(backend, input as never)),
					// An interrupted commit may have written; the model reads the entry before it retries.
					tool("settings_edit", DESCRIPTIONS.edit, EditParameters, "unsafe", (input) =>
						runEdit(backend, input as never),
					),
					tool("settings_tools", DESCRIPTIONS.tools, ToolsParameters, "safe", (input) =>
						runTools(backend, input as never),
					),
				],
				sections: [host.durable.section("settings", () => GUIDANCE)],
			});
		},
	};
}
