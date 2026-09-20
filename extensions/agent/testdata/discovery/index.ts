import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function registerDiscoveryFixture(pi: ExtensionAPI) {
	pi.registerTool({ name: "agent_fixture", label: "Agent fixture", description: "Report the fixture context.", parameters: Type.Object({}), execute: async (_id, _args, _signal, _update, ctx) => ({ content: [{ type: "text", text: ctx.cwd }], details: undefined }) });
}
