import { join } from "node:path";
import { defineSettings, derivedDefault, pathSetting } from "../../settings/index.ts";

export const settings = defineSettings("clipboard", {
	dir: pathSetting({
		description: "Private clipboard archive directory.",
		env: "PI_CLIPBOARD_DIR",
		default: derivedDefault("<agentDir>/clipboard", [], ({ agentDir }) => join(agentDir, "clipboard")),
	}),
});
