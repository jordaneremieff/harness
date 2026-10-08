import { defineSettings, pathSetting } from "../../settings/index.ts";

export const settings = defineSettings("memory", {
	dir: pathSetting({
		description: "Absolute directory of the external Markdown memory corpus.",
		env: "PI_MEMORY_DIR",
		absolute: true,
		maxLength: 1024,
	}),
});
