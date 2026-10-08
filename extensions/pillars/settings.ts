import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { booleanSetting, defineSettings, derivedDefault, pathSetting } from "../../settings/index.ts";

/** The corpus ships beside the extension in one package. */
export function defaultCorpusRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../pillars");
}

export const settings = defineSettings("pillars", {
	dir: pathSetting({
		description: "Private aggregate directory.",
		absolute: true,
		default: derivedDefault("<agentDir>/pillars", [], ({ agentDir }) => join(agentDir, "pillars")),
	}),
	corpus: pathSetting({
		description: "Corpus root with inventory and governance sources.",
		absolute: true,
		default: derivedDefault("Package sibling ../../pillars", [], defaultCorpusRoot),
	}),
	collect: booleanSetting({ description: "Collect source access evidence.", default: true }),
});
