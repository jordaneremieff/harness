import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DeliveryOrigin } from "./durable-controls.ts";
import { readSettings, type Environment } from "./settings.ts";

export const CHECK_IN_MAX_MINUTES = 35791;
/** Only model tool admissions apply the configured default. */
export function checkInMinutes(value: unknown, origin: DeliveryOrigin = "model", agentDir = process.env.PI_AGENT_DIR ?? getAgentDir(), env?: Environment): number {
	if (value === undefined) {
		if (origin !== "model") return 0;
		return readSettings({ agentDir, env }).values.checkInMinutes;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > CHECK_IN_MAX_MINUTES)
		throw new TypeError(`checkInMinutes must be a finite number from 0 through ${CHECK_IN_MAX_MINUTES}`);
	return value;
}
