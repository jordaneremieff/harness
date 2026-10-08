import { join } from "node:path";
import {
	booleanSetting,
	defineSettings,
	derivedDefault,
	integerSetting,
	numberSetting,
	pathSetting,
	type SettingsValues,
} from "../../settings/index.ts";

const dir = pathSetting({
	description: "Handover store directory.",
	default: derivedDefault("<agentDir>/stash", [], ({ agentDir }) => join(agentDir, "stash")),
});

export const settings = defineSettings("stash", {
	dir,
	capacity: booleanSetting({ description: "Enable capacity observation and requests.", default: true }),
	checkpointPercent: numberSetting({
		description: "Positive checkpoint threshold, strictly below the decision threshold.",
		default: 85,
		max: 100,
		validate: (value) => value > 0,
	}),
	decisionPercent: numberSetting({
		description: "Positive continuity-decision threshold, at most 100.",
		default: 90,
		max: 100,
		validate: (value) => value > 0,
	}),
	intakeTokenBudget: integerSetting({
		description: "Positive token budget for the unknown-usage text-intake trigger.",
		min: 1,
	}),
	checkpointDir: pathSetting({
		description: "Working-checkpoint directory, separate from the handover store.",
		default: derivedDefault("<dir>/checkpoints", [dir], ({ get }) => join(get(dir), "checkpoints")),
	}),
});

export type StashSettings = SettingsValues<typeof settings.fields>;
