import { defineSettings, jsonSetting, numberSetting } from "../../settings/index.ts";
import {
	validPresets,
	validPreferences,
	type ExecutionPresets,
	type DelegationPreferences,
} from "./preference-schema.ts";

export const settings = defineSettings("agent", {
	idleMinutes: numberSetting({
		description: "Idle host retirement interval in minutes; zero disables.",
		default: 5,
		min: 0,
		max: 35791,
	}),
	checkInMinutes: numberSetting({
		description: "Automatic owner check-in interval for model tasks in minutes; zero disables.",
		default: 30,
		min: 0,
		max: 35791,
	}),
	presets: jsonSetting<ExecutionPresets>(validPresets)({
		description: "Named execution presets with exact model identities and optional creation fields.",
		default: {},
	}),
	preferences: jsonSetting<DelegationPreferences>(validPreferences)({
		description: "Delegation preferences, default preset, exclusions, planning budgets, and reporting guidance.",
		default: {},
	}),
});
