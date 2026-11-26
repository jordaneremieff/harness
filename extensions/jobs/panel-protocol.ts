import type { JsonValue } from "@earendil-works/chord/json";
import { displayText } from "./completion.ts";

export const OPEN_LIMIT = 8;
export const FINISHED_LIMIT = 12;
export const JOB_STATES = [
	"Queued",
	"Running",
	"Stopping",
	"Succeeded",
	"Failed",
	"Cancelled",
	"Timed out",
	"Lost",
] as const;

export type PanelJob = {
	id: number;
	state: (typeof JOB_STATES)[number];
	command: string;
	cwd?: string;
	startedAt?: number;
	endedAt?: number;
	exitCode?: number | null;
	error?: string;
	timeoutSeconds?: number;
};

type Cursor = Record<string, JsonValue>;
export type PanelRequest = { op: "list"; cursor?: Cursor };
export type PanelSnapshot = {
	jobs: PanelJob[];
	observedAt: number;
	next?: Cursor;
	openIncomplete?: true;
};

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cursor(value: unknown): value is Cursor {
	return object(value) && Object.keys(value).length > 0 && Buffer.byteLength(JSON.stringify(value)) <= 256;
}

export function panelText(value: string, max: number): string {
	const plain = displayText(value)
		.replace(/[\uD800-\uDFFF]/gu, "\uFFFD")
		.replace(/\s+/gu, " ")
		.trim();
	return plain.length <= max ? plain : `${plain.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

export function readPanelRequest(value: JsonValue): PanelRequest {
	if (!object(value) || value.op !== "list" || Object.keys(value).some((key) => key !== "op" && key !== "cursor"))
		throw new Error("Jobs accepts only { op: 'list', cursor? }.");
	if (!Object.hasOwn(value, "cursor")) return { op: "list" };
	if (!cursor(value.cursor)) throw new Error("Use the continuation from the last Jobs page.");
	return { op: "list", cursor: value.cursor };
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function readJob(value: unknown): PanelJob {
	if (
		!object(value) ||
		!finite(value.id) ||
		!Number.isSafeInteger(value.id) ||
		value.id < 1 ||
		typeof value.command !== "string" ||
		typeof value.state !== "string" ||
		!JOB_STATES.some((state) => state === value.state)
	)
		throw new Error("Invalid job in host response.");
	return {
		id: value.id,
		state: value.state as PanelJob["state"],
		command: panelText(value.command, 512),
		...(typeof value.cwd === "string" ? { cwd: panelText(value.cwd, 320) } : {}),
		...(finite(value.startedAt) ? { startedAt: value.startedAt } : {}),
		...(finite(value.endedAt) ? { endedAt: value.endedAt } : {}),
		...(value.exitCode === null || (finite(value.exitCode) && Number.isSafeInteger(value.exitCode))
			? { exitCode: value.exitCode }
			: {}),
		...(typeof value.error === "string" ? { error: panelText(value.error, 320) } : {}),
		...(finite(value.timeoutSeconds) ? { timeoutSeconds: value.timeoutSeconds } : {}),
	};
}

export function readPanelSnapshot(value: unknown, older: boolean): PanelSnapshot {
	if (
		!object(value) ||
		!finite(value.observedAt) ||
		!Array.isArray(value.jobs) ||
		value.jobs.length > FINISHED_LIMIT + (older ? 0 : 2 * OPEN_LIMIT) ||
		(value.next !== undefined && !cursor(value.next)) ||
		(value.openIncomplete !== undefined && (older || value.openIncomplete !== true))
	)
		throw new Error("Invalid Jobs page from the host.");
	const jobs = value.jobs.map(readJob);
	if (jobs.some((job, index) => jobs.findIndex(({ id }) => id === job.id) !== index))
		throw new Error("Duplicate job in host response.");
	return {
		jobs,
		observedAt: value.observedAt,
		...(value.next === undefined ? {} : { next: value.next }),
		...(value.openIncomplete === true ? { openIncomplete: true } : {}),
	};
}
