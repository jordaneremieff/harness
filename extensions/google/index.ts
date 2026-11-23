import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Static } from "@earendil-works/pi-schema";
import { calendarTools } from "./calendar.ts";
import { googleCommand, USAGE } from "./command.ts";
import { toolDisplay } from "./display.ts";
import { docsTools } from "./docs.ts";
import { driveTools } from "./drive.ts";
import { googleContribution } from "./durable.ts";
import { gmailTools } from "./gmail.ts";
import { GoogleRuntime } from "./gws.ts";
import { publishSettings } from "./settings.ts";
import { sheetsTools } from "./sheets.ts";
import { slidesTools } from "./slides.ts";
import { tasksTools } from "./tasks.ts";
import { GUIDELINES, invoke } from "./tools.ts";

export const googleTools = [
	...gmailTools,
	...driveTools,
	...sheetsTools,
	...calendarTools,
	...docsTools,
	...slidesTools,
	...tasksTools,
];

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const runtime = new GoogleRuntime(agentDir);
	const stopSettings = publishSettings(pi.events, { agentDir });
	const display = toolDisplay();
	const renderers = new Map(display.tools.map(({ name, ...presentation }) => [name, presentation]));
	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", display);
	const stopDisplay = pi.events.on("harness:tool-display:request", (request) => {
		if (request && typeof request === "object" && "version" in request && request.version === 1) publishDisplay();
	});
	publishDisplay();
	pi.on("session_shutdown", () => {
		stopDisplay();
		stopSettings();
	});
	pi.events.emit("durable:contribution", googleContribution(fileURLToPath(import.meta.url), pi.events, stopSettings));
	pi.registerCommand("google", {
		description: `Set up, update, inspect or sign out of Google access: ${USAGE}`,
		handler: async (args, ctx) => {
			await googleCommand(args, agentDir, process.env, (line, level) => ctx.ui.notify(line, level ?? "info"));
		},
	});
	for (const tool of googleTools) {
		pi.registerTool<typeof tool.parameters, Record<string, unknown>>({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			promptGuidelines: [...GUIDELINES],
			exposure: "deferred",
			...renderers.get(tool.name),
			async execute(_toolCallId, params: Static<typeof tool.parameters>, signal) {
				return invoke(tool, params, runtime, signal);
			},
		});
	}
}
