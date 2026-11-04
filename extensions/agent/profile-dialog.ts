import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesSchema } from "./schema-check.ts";
import { AgentProfileSchema, type AgentProfile } from "./profile-schema.ts";
import type { AgentCommandAction } from "./command.ts";
import { displayText } from "./tool-cards.ts";

export interface ProfileDraft {
	expectedRevision: string;
	role?: string;
	expertise?: string;
	needsRead?: boolean;
}
type ProfileControl = (method: "profile-read" | "profile-update", input: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
const safe = (value: string | null) => value === null ? "Unknown" : displayText(value);

function identityLines(profile: AgentProfile): string[] {
	return [
		`Profile: ${safe(profile.handle ?? profile.name ?? profile.identity)}`,
		`Identity: ${safe(profile.identity)}`,
		`Handle: ${profile.handle === null ? "None" : safe(profile.handle)}`,
		`Display name: ${safe(profile.name)}`,
		`Role: ${safe(profile.role) || "(empty)"}`,
		`Model: ${profile.model ? safe(`${profile.model.provider}/${profile.model.modelId}`) : "Unknown"}`,
		`Reasoning: ${safe(profile.thinkingLevel)}`,
		`Creator (provenance, not a reply route): ${safe(profile.creator)}`,
		`Directory: ${safe(profile.cwd)}`,
		`Source: ${profile.live ? "Live host" : "Retained; no host started"}`,
		`Revision: ${safe(profile.revision)}`,
		`Updated: ${profile.updatedAt === null ? "Unknown" : new Date(profile.updatedAt).toISOString()} by ${safe(profile.updatedBy)}`,
	];
}
function requestLines(profile: AgentProfile): string[] {
	const omitted = profile.requestsOmitted ?? 0;
	const lines = profile.requests.map((request) =>
		`${safe(request.requestId)} · ${request.status} · ${request.origin}\n  Requester: ${safe(request.requester)}\n  Reply recipient: ${safe(request.replyTo)}`,
	);
	if (omitted > 0) lines.unshift(`${omitted} additional request route${omitted === 1 ? "" : "s"} omitted from this profile.`);
	else if (lines.length === 0) lines.push("No retained active request routes; earlier requester evidence is unknown.");
	return ["Request routes:", ...lines];
}
function draftLines(profile: AgentProfile, draft?: ProfileDraft): string[] {
	return [
		...(draft?.role === undefined ? [] : [`Draft role (not saved): ${safe(draft.role) || "(empty)"}`]),
		...(draft?.expertise === undefined ? [] : ["Draft expertise is not saved; view or edit it below."]),
		...(draft?.needsRead || (draft && draft.expectedRevision !== profile.revision)
			? ["Conflict: draft retained. Read the current profile, then explicitly select its revision before Save."] : []),
	];
}
/** Identity, bounded request routes and saved expertise, which is evidence and separate from present instructions. */
export function profileText(profile: AgentProfile, draft?: ProfileDraft): string {
	return [
		...identityLines(profile), ...requestLines(profile), ...draftLines(profile, draft),
		`Saved expertise (evidence, not fresh authority):\n${safe(profile.expertise) || "(empty)"}`,
		...(draft?.expertise !== undefined ? [`Draft expertise (not saved):\n${safe(draft.expertise) || "(empty)"}`] : []),
	].join("\n");
}

export function readValue(value: unknown): AgentProfile {
	if (!matchesSchema(AgentProfileSchema, value)) throw new Error("Invalid profile response");
	return value;
}
/** `/agent profile <session>`: the profile as text. In the terminal UI the work view opens it as a form. */
export function profileCommand(control: ProfileControl): AgentCommandAction {
	return {
		name: "profile",
		description: "Read identity and expertise; edit role or expertise with a revision check",
		args: [{ name: "session", complete: "session" }],
		run: async ([sessionId], ctx) => profileText(readValue(await control("profile-read", { sessionId }, ctx))),
	};
}
