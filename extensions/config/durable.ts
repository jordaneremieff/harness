import { CONFIG_DIR_NAME, getPackageDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { ConfigHost } from "./catalogue.ts";
import { type ConfigDisplayDetails, EDIT_TOOL_NAME } from "./display.ts";
import { ConfigBackend } from "./operations.ts";
import type { Bus } from "./owners.ts";
import { publishSettings } from "./settings.ts";
import {
	DESCRIPTIONS,
	type EditInput,
	EditParameters,
	editDisplay,
	executeConfigTool,
	FindParameters,
	GetParameters,
	GUIDANCE,
	runEdit,
	runFind,
	runGet,
	runTools,
	ToolsParameters,
} from "./tools.ts";

export interface ConfigDurableHost {
	readonly durable: typeof Durable;
	readonly agentDir: string;
	readonly cwd: string;
	readonly services: { readonly settingsManager: { isProjectTrusted(): boolean; getSettings(): unknown } };
	onClose(dispose: () => void | Promise<void>): void;
}

/** The Durable form: the same backend over the host's own facts, without session tool controls. */
export function configContribution(source: string, bus: Bus, stopFactoryPublisher: () => void) {
	return {
		name: "config",
		source,
		display: { version: 1, entry: "./display.ts", export: "toolDisplay" } as const,
		create(host: ConfigDurableHost): Durable.Extension {
			stopFactoryPublisher();
			host.onClose(publishSettings(bus, { agentDir: host.agentDir }));
			const facts = (): ConfigHost => ({
				kind: "durable",
				agentDir: host.agentDir,
				cwd: host.cwd,
				projectTrusted: host.services.settingsManager.isProjectTrusted(),
				bus,
				env: process.env,
				pi: { version: VERSION, packageDir: getPackageDir(), configDir: CONFIG_DIR_NAME, SettingsManager },
				sessionSettings: () => host.services.settingsManager.getSettings(),
			});
			const backend = new ConfigBackend(facts);
			const tool = <T, Result>(
				name: string,
				description: string,
				parameters: Parameters<typeof host.durable.defineTool>[0]["parameters"],
				replay: "safe" | "unsafe",
				run: (input: T) => Result | Promise<Result>,
				describe?: (result: Result, limited: boolean) => ConfigDisplayDetails,
			) =>
				host.durable.defineTool({
					name,
					description,
					parameters,
					replay,
					outputLimits: { maxBytes: 128 * 1024, maxLines: 4000 },
					async execute(input) {
						const { content, ...outcome } = await executeConfigTool(name, () => run(input as T), describe);
						return { output: content, ...outcome };
					},
				});
			return host.durable.defineExtension({
				name: "config",
				tools: [
					tool("config_find", DESCRIPTIONS.find, FindParameters, "safe", (input) => runFind(backend, input as never)),
					tool("config_get", DESCRIPTIONS.get, GetParameters, "safe", (input) => runGet(backend, input as never)),
					// An interrupted commit may have written; the model reads the entry before it retries.
					tool(
						EDIT_TOOL_NAME,
						DESCRIPTIONS.edit,
						EditParameters,
						"unsafe",
						(input: EditInput) => runEdit(backend, input),
						editDisplay,
					),
					tool("config_tools", DESCRIPTIONS.tools, ToolsParameters, "safe", (input) =>
						runTools(backend, input as never),
					),
				],
				sections: [host.durable.section("config", () => GUIDANCE)],
			});
		},
	};
}
