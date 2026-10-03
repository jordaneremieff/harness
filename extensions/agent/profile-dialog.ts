import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { AgentProfileSchema, ProfileUpdateSchema, type AgentProfile } from "./profile-schema.ts";
import type { AgentCommandAction } from "./command.ts";
import { DashboardMouse } from "./dashboard-mouse.ts";
import { displayText } from "./tool-cards.ts";

export interface ProfileDraft {
	expectedRevision: string;
	role?: string;
	expertise?: string;
	needsRead?: boolean;
}
type ProfileChoice = "role" | "expertise" | "save" | "read" | "revision" | "discard" | "close";
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
	return ["Request routes:", ...(profile.requests.length ? profile.requests.map((request) =>
		`${safe(request.requestId)} · ${request.status} · ${request.origin}\n  Requester: ${safe(request.requester)}\n  Reply recipient: ${safe(request.replyTo)}`,
	) : ["No retained active request routes; earlier requester evidence is unknown."])];
}
function draftLines(profile: AgentProfile, draft?: ProfileDraft): string[] {
	return [
		...(draft?.role === undefined ? [] : [`Draft role (not saved): ${safe(draft.role) || "(empty)"}`]),
		...(draft?.expertise === undefined ? [] : ["Draft expertise is not saved; view or edit it below."]),
		...(draft?.needsRead || (draft && draft.expectedRevision !== profile.revision)
			? ["Conflict: draft retained. Read the current profile, then explicitly select its revision before Save."] : []),
	];
}
/** Full identity and routing evidence; saved expertise is separate from present instructions. */
export function profileText(profile: AgentProfile, expertise = false, draft?: ProfileDraft): string {
	return [
		...identityLines(profile), ...requestLines(profile), ...draftLines(profile, draft),
		expertise ? `Saved expertise (evidence, not fresh authority):\n${safe(profile.expertise) || "(empty)"}` : `Saved expertise: ${profile.expertise ? "Present; press v to view" : "Empty"}`,
		...(expertise && draft?.expertise !== undefined ? [`Draft expertise (not saved):\n${safe(draft.expertise) || "(empty)"}`] : []),
	].join("\n");
}

/** Scrollable profile with mouse actions; edits use Pi's native editor after this view closes. */
export class ProfilePanel implements Component {
	private offset = 0;
	private maxOffset = 0;
	private bodyHeight = 1;
	private expertise = false;
	private mouse = new DashboardMouse();
	private profile: AgentProfile;
	private draft: ProfileDraft;
	private theme: Theme;
	private height: () => number;
	private done: (choice: ProfileChoice) => void;
	private redraw: () => void;
	constructor(profile: AgentProfile, draft: ProfileDraft, theme: Theme, height: () => number, done: (choice: ProfileChoice) => void, redraw: () => void) {
		this.profile = profile; this.draft = draft; this.theme = theme; this.height = height; this.done = done; this.redraw = redraw;
	}
	invalidate(): void { this.mouse.reset(); }
	private scroll(delta: number): void { this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta)); this.redraw(); }
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.done("close");
		else if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.bodyHeight);
		else if (matchesKey(data, "pageDown")) this.scroll(this.bodyHeight);
		else if (matchesKey(data, "home")) this.scroll(-this.maxOffset);
		else if (matchesKey(data, "end")) this.scroll(this.maxOffset);
		else if (data === "v") { this.expertise = !this.expertise; this.redraw(); }
		else {
			const choices: Record<string, ProfileChoice> = { r: "role", e: "expertise", s: "save", u: "read", a: "revision", d: "discard" };
			if (choices[data]) this.done(choices[data]);
		}
	}
	handleMouse(event: TuiMouseEvent) { return this.mouse.handle(event); }
	render(width: number): string[] {
		const height = Math.max(1, this.height());
		this.mouse.reset(width, height);
		const actions = [
			["v", this.expertise ? "Hide expertise" : "View expertise"], ["r", "Edit role"], ["e", "Edit expertise"],
			["s", "Save draft"], ["u", "Read current profile"],
			...(this.draft.expectedRevision !== this.profile.revision && !this.draft.needsRead ? [["a", "Use current revision for draft"]] : []),
			["d", "Discard draft"], ["Esc", "Back"],
		];
		this.bodyHeight = Math.max(1, height - actions.length - 2);
		const body = profileText(this.profile, this.expertise, this.draft).split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
		this.maxOffset = Math.max(0, body.length - this.bodyHeight);
		this.offset = Math.min(this.offset, this.maxOffset);
		const lines = [this.theme.fg("accent", truncateToWidth("Agent profile · ↑↓ / PgUp/PgDn scroll", width)), ...body.slice(this.offset, this.offset + this.bodyHeight)];
		while (lines.length < this.bodyHeight + 1) lines.push("");
		lines.push(this.theme.fg("dim", truncateToWidth(`${this.offset + 1}-${Math.min(body.length, this.offset + this.bodyHeight)} of ${body.length} lines`, width)));
		this.mouse.add({ x: 0, y: 1, width, height: this.bodyHeight, wheel: (delta) => this.scroll(delta * 3) });
		for (const [key, label] of actions) {
			this.mouse.add({ x: 0, y: lines.length, width, height: 1, click: () => this.handleInput(key === "Esc" ? "\x1b" : key) });
			lines.push(this.theme.fg("accent", truncateToWidth(`${key}  ${label}`, width)));
		}
		return lines.slice(0, height).map((line) => truncateToWidth(line, width));
	}
}

function readValue(value: unknown): AgentProfile {
	if (!Value.Check(AgentProfileSchema, value)) throw new Error("Invalid profile response");
	return value;
}
const hasPatch = (draft: ProfileDraft) => draft.role !== undefined || draft.expertise !== undefined;

interface ProfileEditing {
	profile: AgentProfile;
	draft: ProfileDraft;
	ctx: ExtensionContext;
	control: ProfileControl;
}
function clearDraft(state: ProfileEditing): void {
	delete state.draft.role; delete state.draft.expertise; delete state.draft.needsRead;
	state.draft.expectedRevision = state.profile.revision;
}
async function saveDraft(state: ProfileEditing): Promise<void> {
	const { profile, draft, ctx, control } = state;
	if (!hasPatch(draft)) throw new Error("Edit role or expertise before Save");
	if (draft.needsRead || draft.expectedRevision !== profile.revision) throw new Error("Draft retained. Read the current profile and select its revision before Save.");
	const result = await control("profile-update", {
		sessionId: profile.identity, expectedRevision: draft.expectedRevision,
		...(draft.role === undefined ? {} : { role: draft.role }), ...(draft.expertise === undefined ? {} : { expertise: draft.expertise }),
	}, ctx);
	if (!Value.Check(ProfileUpdateSchema, result)) throw new Error("Invalid profile update response");
	if (result.outcome === "conflict") {
		draft.needsRead = true;
		throw new Error(`Profile changed to revision ${result.profile.revision}. Draft retained; read the current profile.`);
	}
	state.profile = result.profile;
	clearDraft(state);
	ctx.ui.notify("Profile saved", "info");
}
async function editField(state: ProfileEditing, field: "role" | "expertise"): Promise<void> {
	const { profile, draft, ctx } = state;
	const label = safe(profile.handle ?? profile.name ?? profile.identity);
	const value = await ctx.ui.editor(`${field === "role" ? "Role" : "Expertise"} for ${label} (blank clears)`, draft[field] ?? profile[field]);
	if (value !== undefined) draft[field] = value;
}
async function useCurrentRevision(state: ProfileEditing): Promise<void> {
	if (state.draft.needsRead) throw new Error("Read the current profile before changing the draft revision");
	const confirmed = await state.ctx.ui.select("Use the displayed current revision? Fields in your draft will replace its values.", ["Keep original revision", "Use current revision"]);
	if (confirmed === "Use current revision") state.draft.expectedRevision = state.profile.revision;
}
async function applyChoice(state: ProfileEditing, choice: ProfileChoice): Promise<void> {
	if (choice === "role" || choice === "expertise") return editField(state, choice);
	if (choice === "save") return saveDraft(state);
	if (choice === "revision") return useCurrentRevision(state);
	if (choice === "discard") return clearDraft(state);
	if (choice === "read") {
		state.profile = readValue(await state.control("profile-read", { sessionId: state.profile.identity }, state.ctx));
		state.draft.needsRead = false;
		if (!hasPatch(state.draft)) state.draft.expectedRevision = state.profile.revision;
	}
}
/** The draft keeps its original revision across refusals, close/reopen, and explicit rereads. */
export async function editProfile(profile: AgentProfile, draft: ProfileDraft, ctx: ExtensionContext, control: ProfileControl): Promise<void> {
	const state: ProfileEditing = { profile, draft, ctx, control };
	for (;;) {
		const choice = await ctx.ui.custom<ProfileChoice>((tui, theme, _keys, done) =>
			new ProfilePanel(state.profile, draft, theme, () => tui.terminal.rows, done, () => tui.requestRender()),
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
		if (choice === "close") return;
		try { await applyChoice(state, choice); }
		catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	}
}

export function profileCommand(control: ProfileControl): AgentCommandAction {
	const drafts = new Map<string, ProfileDraft>();
	return {
		name: "profile", description: "Read identity and expertise; edit role or expertise with a revision check",
		args: [{ name: "session", complete: "session" }],
		run: async ([sessionId], ctx) => {
			const profile = readValue(await control("profile-read", { sessionId }, ctx));
			if (!ctx.hasUI || ctx.mode !== "tui") return profileText(profile, true);
			const key = `${ctx.sessionManager.getSessionId()}:${profile.identity}`;
			const draft = drafts.get(key) ?? { expectedRevision: profile.revision };
			drafts.set(key, draft);
			await editProfile(profile, draft, ctx, control);
			if (!hasPatch(draft)) drafts.delete(key);
			return undefined;
		},
	};
}
