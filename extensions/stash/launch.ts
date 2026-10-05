/** Structural copies of the package-level independent-command contract. */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DistillSource } from "./distill.ts";

export interface IndependentCommandInput {
	invocationId: string;
	creatorId: string;
	cwd: string;
	name?: string;
	command: { name: string; args?: string; data?: JsonValue };
}

export interface IndependentCommandReceipt {
	sessionId: string;
	cwd: string;
	admission: { name: string; conversationId: number; identity: string; text: string };
}

export type IndependentCommandLaunch = (input: IndependentCommandInput) => Promise<IndependentCommandReceipt>;

/** Optional branch metadata from the invocation workspace. */
export function captureBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["branch", "--show-current"],
			{ cwd, signal, timeout: 5000, maxBuffer: 65_536 },
			(error, stdout) => {
				resolve(error ? undefined : stdout.trim() || undefined);
			},
		);
	});
}

/** Source and publication destination belong to the invocation, never the model. */
export type DistillInput = DistillSource & {
	hint: string;
	project: string;
	branch?: string;
	sessionId: string;
	storeDir: string;
};

/** Discover before launch so absence or duplicate providers cause no launch effect. */
export function independentLauncher(events: ExtensionAPI["events"]): IndependentCommandLaunch {
	const providers: IndependentCommandLaunch[] = [];
	events.emit("durable:launch-provider", {
		provide: (launch: IndependentCommandLaunch) => providers.push(launch),
	});
	if (providers.length !== 1 || typeof providers[0] !== "function") {
		throw new Error("Stash creation requires exactly one independent Durable host provider.");
	}
	return providers[0];
}

export function creationRequest(input: DistillInput, invocationId: string): IndependentCommandInput {
	return {
		invocationId,
		creatorId: input.sessionId,
		cwd: input.project,
		name: `Stash: ${input.hint.slice(0, 120)}`,
		command: { name: "stash", args: "new", data: JSON.parse(JSON.stringify(input)) as JsonValue },
	};
}

/** Validate structured command input before any worker configuration or admission. */
export function readDistillInput(data: JsonValue | undefined): DistillInput {
	if (data === null || typeof data !== "object" || Array.isArray(data))
		throw new Error("Invalid stash creation input.");
	for (const field of ["hint", "project", "sessionId", "storeDir"] as const) {
		if (typeof data[field] !== "string" || !data[field].trim()) throw new Error(`Invalid stash creation ${field}.`);
	}
	if (typeof data.transcript !== "string") throw new Error("Invalid stash creation transcript.");
	if (!Array.isArray(data.artifacts) || !data.artifacts.every((item) => typeof item === "string"))
		throw new Error("Invalid stash creation references.");
	if (data.branch !== undefined && typeof data.branch !== "string") throw new Error("Invalid stash creation branch.");
	if (!isAbsolute(data.project as string) || !isAbsolute(data.storeDir as string))
		throw new Error("Stash creation requires absolute project and store paths.");
	return {
		hint: data.hint as string,
		transcript: data.transcript,
		artifacts: [...data.artifacts] as string[],
		project: data.project as string,
		sessionId: data.sessionId as string,
		storeDir: data.storeDir as string,
		...(data.branch === undefined ? {} : { branch: data.branch as string }),
	};
}
