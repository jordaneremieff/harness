import { join } from "node:path";
import { defineSettings, derivedDefault, enumSetting, pathSetting } from "../../settings/index.ts";
import { POLICY_MODES } from "./mode.ts";

export const settings = defineSettings("policy", {
	dir: pathSetting({
		description: "Private directory for rules, approved data, and telemetry.",
		default: derivedDefault("<agentDir>/policy", [], ({ agentDir }) => join(agentDir, "policy")),
	}),
	mode: enumSetting(POLICY_MODES, {
		description: "Configured machine mode; an ordinary --policy-mode flag overrides it for that session.",
		default: "observe",
	}),
});
