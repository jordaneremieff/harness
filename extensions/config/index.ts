import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getPackageDir,
	SettingsManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { ConfigUpdater, readConfigBuild } from "./app-update.ts";
import { ConfigBridge } from "./bridge.ts";
import type { ConfigHost } from "./catalogue.ts";
import { commandHelp, commandInput, completions, openConfig } from "./command.ts";
import { EDIT_TOOL_NAME, toolDisplay } from "./display.ts";
import { configContribution } from "./durable.ts";
import { ConfigBackend } from "./operations.ts";
import { publishSettings, readSettings } from "./settings.ts";
import {
	DESCRIPTIONS,
	describeConfigEdit,
	type EditInput,
	EditParameters,
	executeConfigTool,
	type FindInput,
	FindParameters,
	type GetInput,
	GetParameters,
	GUIDANCE,
	runEdit,
	runFind,
	runGet,
	runTools,
	type ToolsInput,
	ToolsParameters,
} from "./tools.ts";

const singleLine = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 1024);

export default function configExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const stopSettings = publishSettings(pi.events, { agentDir });
	const display = toolDisplay();
	const [editRenderer] = display.tools;
	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", toolDisplay());
	const stopDisplay = pi.events.on("harness:tool-display:request", (request) => {
		if (request && typeof request === "object" && "version" in request && request.version === 1) publishDisplay();
	});
	const stopPublishers = () => {
		stopSettings();
		stopDisplay();
	};
	publishDisplay();
	pi.events.emit("durable:contribution", configContribution(fileURLToPath(import.meta.url), pi.events, stopPublishers));

	let context: ExtensionContext | undefined;
	const host = (): ConfigHost => {
		if (!context) throw new Error("Config has no session context yet.");
		const ctx = context;
		return {
			kind: "ordinary",
			agentDir,
			cwd: ctx.cwd,
			session: ctx.sessionManager.getSessionId(),
			projectTrusted: ctx.isProjectTrusted(),
			bus: pi.events,
			env: process.env,
			pi: { version: VERSION, packageDir: getPackageDir(), configDir: CONFIG_DIR_NAME, SettingsManager },
			sessionSettings: () => pi.getSettings(),
			models: () =>
				ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
			tools: {
				all: () => pi.getAllTools(),
				active: () => pi.getActiveTools(),
				setActive: (names) => pi.setActiveTools(names),
			},
		};
	};
	const backend = new ConfigBackend(host);
	let bridge: ConfigBridge | undefined;
	let installedBuild: string | undefined;
	const lifetime = new AbortController();
	const updater = new ConfigUpdater();
	const update = (ctx: ExtensionContext, explicit: boolean) =>
		void updater.check(
			readSettings({ agentDir }).values.app,
			{
				notify: (text, error) => {
					if (!lifetime.signal.aborted) ctx.ui.notify(singleLine(text), error ? "error" : "info");
				},
				status: (text) => {
					if (!lifetime.signal.aborted && ctx.mode === "tui") ctx.ui.setStatus("config", text);
				},
			},
			explicit,
		);
	pi.on("session_start", (event, ctx) => {
		context = ctx;
		if (ctx.mode === "tui" && (event.reason === "startup" || event.reason === "reload")) update(ctx, false);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		lifetime.abort();
		if (ctx.mode === "tui") ctx.ui.setStatus("config", undefined);
		bridge?.close();
		bridge = undefined;
		stopPublishers();
	});

	const openPane = async (ctx: ExtensionContext, app: string, query: string | undefined) => {
		const build = await readConfigBuild(app);
		if (!build) {
			update(ctx, true);
			throw new Error(
				"The Config app is not installed yet. Its build has started; run /config again when it finishes.",
			);
		}
		installedBuild = build.sourceDigest;
		bridge ??= new ConfigBridge({
			backend,
			agentDir,
			label: () => ctx.sessionManager.getSessionName() ?? basename(ctx.cwd),
			expectedBuild: () => installedBuild,
		});
		const opened = await openConfig({ app, cwd: ctx.cwd, query, bridge, signal: lifetime.signal });
		if (opened.outcome === "revealed") ctx.ui.notify(opened.detail, "info");
	};

	pi.registerCommand("config", {
		description: "Find, understand and change Pi, extension and custom settings in the Config app",
		getArgumentCompletions: completions,
		async handler(args, ctx) {
			context = ctx;
			const input = commandInput(args);
			if (input.mode === "help") return ctx.ui.notify(commandHelp(), "info");
			const app = readSettings({ agentDir }).values.app;
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Config opens no pane and builds no app outside interactive Pi; use the config_* tools.", "info");
				return;
			}
			if (input.mode === "update") {
				update(ctx, true);
				return;
			}
			try {
				await openPane(ctx, app, input.query);
			} catch (error) {
				if (lifetime.signal.aborted) return;
				ctx.ui.notify(singleLine(error instanceof Error ? error.message : "Config could not open."), "error");
			}
		},
	});

	const register = <T>(
		name: string,
		label: string,
		description: string,
		parameters: unknown,
		run: (input: T) => unknown,
	) =>
		pi.registerTool({
			name,
			label,
			description,
			promptGuidelines: [GUIDANCE],
			parameters: parameters as never,
			async execute(_id, input, _signal, _update, ctx) {
				context = ctx;
				return executeConfigTool(name, () => run(input as T));
			},
		});
	register<FindInput>("config_find", "Config", DESCRIPTIONS.find, FindParameters, (input) => runFind(backend, input));
	register<GetInput>("config_get", "Config", DESCRIPTIONS.get, GetParameters, (input) => runGet(backend, input));
	pi.registerTool({
		...editRenderer,
		name: EDIT_TOOL_NAME,
		label: "Config",
		description: DESCRIPTIONS.edit,
		promptGuidelines: [GUIDANCE],
		parameters: EditParameters,
		async execute(_id, input: EditInput, _signal, _update, ctx) {
			context = ctx;
			return executeConfigTool(EDIT_TOOL_NAME, () => runEdit(backend, input), describeConfigEdit);
		},
	});
	register<ToolsInput>("config_tools", "Config", DESCRIPTIONS.tools, ToolsParameters, (input) =>
		runTools(backend, input),
	);
}
