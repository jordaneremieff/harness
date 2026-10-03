import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ProfilePanel, editProfile, profileCommand, profileText, type ProfileDraft } from "./profile-dialog.ts";
import type { AgentProfile } from "./profile-schema.ts";
import { theme } from "./dashboard-test-fixture.mts";

const profile: AgentProfile = {
	identity: "retained-storage", handle: "@history", name: "History expert", role: "Study decisions and their sources", expertise: "Sourced fact: reference.md, 2026-01-01",
	revision: "a".repeat(64), updatedAt: 1, updatedBy: "editor", creator: "founder", model: { provider: "fixture", modelId: "model" }, thinkingLevel: "high", cwd: "/workspace", live: false,
	requests: [{ requestId: "request", requester: "second-requester", replyTo: "third-recipient", origin: "model", status: "placed" }],
};
const draft = (): ProfileDraft => ({ expectedRevision: profile.revision });
const mouse = (width: number, height: number, x: number, y: number, patch: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
	type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, ...patch,
});

it("profile text separates identity, provenance, current routes, and on-demand expertise", () => {
	const text = profileText(profile);
	for (const value of [profile.identity, "@history", "History expert", profile.role, "fixture/model", "high", "founder", "second-requester", "third-recipient", profile.revision]) assert.ok(text.includes(value), value);
	assert.match(text, /Retained; no host started/);
	assert.doesNotMatch(text, /Sourced fact/);
	assert.match(profileText(profile, true), /Sourced fact: reference.md/);
	assert.match(profileText({ ...profile, model: null, requests: [] }), /Model: Unknown[\s\S]*earlier requester evidence is unknown/);
});
it("profile reports omitted routes without calling a partial list empty", () => {
	for (const requests of [profile.requests, []]) {
		const complete = { ...profile, requests };
		assert.doesNotMatch(profileText(complete), /omitted from this profile/);
		assert.equal(profileText({ ...complete, requestsOmitted: 0 }), profileText(complete));
		for (const requestsOmitted of [1, 7]) {
			const text = profileText({ ...complete, requestsOmitted });
			assert.ok(text.includes(`${requestsOmitted} additional request route${requestsOmitted === 1 ? "" : "s"} omitted from this profile.`));
			assert.doesNotMatch(text, /No retained active request routes/);
			if (requests.length) assert.ok(text.indexOf("additional request route") < text.indexOf(`${requests[0].requestId} ·`), "coverage precedes the bounded list");
		}
	}
});
for (const width of [28, 48, 120]) {
	it(`profile omission counts remain readable at width ${width}`, () => {
		const panel = new ProfilePanel({ ...profile, requestsOmitted: 7 }, draft(), theme, () => 20, () => {}, () => {});
		panel.render(width);
		panel.handleInput("\x1b[F");
		const lines = panel.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines.join("\n").replace(/\s/gu, "").includes("7additionalrequestroutesomittedfromthisprofile."));
	});
	it(`profile exposes structured current and queued routes on demand at width ${width}`, () => {
		const routed: AgentProfile = { ...profile, requests: [
			{ requestId: "active-request", requester: "active-requester", replyTo: "active-recipient", origin: "operator", status: "placed" },
			{ requestId: "queued-request", requester: "queued-requester", replyTo: "queued-recipient", origin: "model", status: "queued" },
		] };
		const panel = new ProfilePanel(routed, draft(), theme, () => 20, () => {}, () => {});
		const pages: string[] = [];
		for (let page = 0; page < 10; page++) {
			const lines = panel.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const footer = lines.findIndex((line) => /\d+-\d+ of \d+ lines/.test(line));
			assert.ok(footer > 0);
			pages.push(lines.slice(1, footer).join("\n"));
			panel.handleInput("\x1b[6~");
		}
		const text = pages.join("\n").replace(/\s/gu, "");
		for (const route of routed.requests) {
			assert.ok(text.includes(`${route.requestId}·${route.status}·${route.origin}`), route.requestId);
			assert.ok(text.includes(`Requester:${route.requester}`));
			assert.ok(text.includes(`Replyrecipient:${route.replyTo}`));
		}
		assert.doesNotMatch(text, /Sourcedfact/);
	});
	it(`profile scrolling and mouse actions retain full content at width ${width}`, () => {
		const choices: string[] = [];
		let height = 20;
		const panel = new ProfilePanel(profile, draft(), theme, () => height, (value) => choices.push(value), () => {});
		const first = panel.render(width);
		assert.ok(first.every((line) => visibleWidth(line) <= width));
		assert.equal(first.length, height);
		const roleLine = first.findIndex((line) => line.includes("Edit role"));
		assert.ok(roleLine >= 0);
		assert.equal(panel.handleMouse(mouse(width, height, 2, roleLine))?.handled, true);
		assert.deepEqual(choices, ["role"]);
		panel.handleInput("v");
		panel.render(width);
		panel.handleInput("\x1b[F");
		assert.match(panel.render(width).join("\n"), /2026-01-01/);
		panel.handleMouse(mouse(width, height, 2, 2, { type: "wheel", wheelDelta: -100 }));
		assert.match(panel.render(width).join("\n"), /Identity:/);
		height = 24;
		assert.equal(panel.handleMouse(mouse(width, height, 2, roleLine)), undefined, "stale viewport clicks refuse before a resize render");
		panel.render(width);
		panel.handleInput("r"); panel.handleInput("\x1b");
		assert.deepEqual(choices, ["role", "role", "close"]);
	});
}

function context(keys: string[], edits: Array<string | undefined> = []) {
	const notices: string[] = [];
	const prefills: string[] = [];
	const screens: string[] = [];
	const ctx = {
		hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "primary" },
		ui: {
			custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => ProfilePanel) => new Promise((resolve) => {
				const panel = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, resolve);
				screens.push(panel.render(100).join("\n"));
				const key = keys.shift(); assert.ok(key, "unexpected dialog"); panel.handleInput(key);
			}),
			editor: async (_title: string, prefill: string) => { prefills.push(prefill); return edits.shift(); },
			notify: (text: string) => notices.push(text),
			select: async () => "Use current revision",
		},
	} as unknown as ExtensionContext;
	return { ctx, notices, prefills, screens };
}
it("profile conflicts keep staged edits and require explicit reread and revision selection", async () => {
	const d = context(["r", "s", "s", "u", "s", "a", "s", "\x1b"], ["New role"]);
	const staged = draft();
	const current = { ...profile, role: "Concurrent role", revision: "b".repeat(64) };
	const updates: Record<string, unknown>[] = [];
	let reads = 0;
	await editProfile(profile, staged, d.ctx, async (method, input) => {
		if (method === "profile-read") { reads++; return current; }
		updates.push(input);
		return updates.length === 1 ? { outcome: "conflict", deduped: false, profile: current } : { outcome: "applied", deduped: false, profile: { ...current, role: String(input.role), revision: "c".repeat(64) } };
	});
	assert.equal(reads, 1);
	assert.equal(updates.length, 2, "Save never retries a conflict without explicit revision selection");
	assert.equal(updates[0].expectedRevision, profile.revision);
	assert.equal(updates[1].expectedRevision, current.revision);
	assert.equal(updates[1].role, "New role");
	assert.match(d.notices.join("\n"), /Profile changed[\s\S]*Draft retained[\s\S]*Profile saved/);
	assert.equal(staged.role, undefined);
});
it("profile command keeps drafts across close and reopen without touching message drafts", async () => {
	const d = context(["e", "\x1b", "e", "\x1b"], ["Draft expertise", undefined]);
	const calls: string[] = [];
	const command = profileCommand(async (method) => { calls.push(method); return profile; });
	await command.run(["@history"], d.ctx);
	await command.run([profile.identity], d.ctx);
	assert.deepEqual(d.prefills, [profile.expertise, "Draft expertise"]);
	assert.deepEqual(calls, ["profile-read", "profile-read"]);
});
it("profile field cancellation preserves the completed draft and empty submission clears a field", async () => {
	const d = context(["r", "r", "s", "\x1b"], ["", undefined]);
	let patch: Record<string, unknown> | undefined;
	await editProfile(profile, draft(), d.ctx, async (_method, input) => { patch = input; return { outcome: "applied", deduped: false, profile: { ...profile, role: "" } }; });
	assert.equal(patch?.role, "");
	assert.deepEqual(d.prefills, [profile.role, ""]);
});
it("non-TUI profile command preserves the request-route omission count", async () => {
	const d = context([]);
	const ctx = { ...d.ctx, hasUI: false } as ExtensionContext;
	const result = await profileCommand(async () => ({ ...profile, requestsOmitted: 1 })).run([profile.identity], ctx);
	assert.match(String(result), /1 additional request route omitted from this profile\./);
	assert.match(String(result), /Sourced fact: reference\.md/);
});
it("non-TUI profile command returns full expertise without opening an editor", async () => {
	const d = context([]);
	const ctx = { ...d.ctx, hasUI: false } as ExtensionContext;
	const result = await profileCommand(async () => profile).run([profile.identity], ctx);
	assert.equal(result, profileText(profile, true));
});
