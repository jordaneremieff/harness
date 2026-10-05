import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DashboardLayout } from "./dashboard-state.ts";

export interface DashboardPreferences {
	load(): DashboardLayout;
	save(layout: DashboardLayout): void;
}
export function validDashboardLayout(value: unknown): DashboardLayout {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const { rosterRatio, composerRows } = value as Record<string, unknown>;
	return {
		...(typeof rosterRatio === "number" && Number.isFinite(rosterRatio) && rosterRatio > 0 && rosterRatio < 1 ? { rosterRatio } : {}),
		...(typeof composerRows === "number" && Number.isSafeInteger(composerRows) && composerRows >= 5 ? { composerRows } : {}),
	};
}
/** Each primary loads once; atomic publication affects only later fresh primaries. */
export function dashboardPreferences(agentDir: string): DashboardPreferences {
	const path = join(agentDir, "agent-dashboard-layout.json");
	return {
		load() {
			try {
				if (statSync(path).size > 4096) return {};
				return validDashboardLayout(JSON.parse(readFileSync(path, "utf8")));
			} catch { return {}; }
		},
		save(layout) {
			mkdirSync(agentDir, { recursive: true, mode: 0o700 });
			const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
			try {
				writeFileSync(temporary, `${JSON.stringify(validDashboardLayout(layout))}\n`, { flag: "wx", mode: 0o600 });
				renameSync(temporary, path);
			} finally {
				try { unlinkSync(temporary); } catch { /* Rename removes the temporary file. */ }
			}
		},
	};
}
