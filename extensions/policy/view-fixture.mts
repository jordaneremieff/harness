/** Rule, proposal, activity and registry fixtures shared by the policy content and view tests. */

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { OperatorView, ViewHost } from "../../operator-ui/index.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import type { PolicyActivityRecord, PolicyPanelData } from "./panel.ts";
import type { RuleMatchContext, RuleRecord } from "./rule.ts";

export const operatorAudit = {
	at: "2026-09-03T12:00:00.000Z",
	session: "session-local",
	model: "provider/model",
	surface: "command" as const,
};
export const agentAudit = { ...operatorAudit, surface: "agent-tool" as const };
export const scopeContext: RuleMatchContext = {
	provider: "openai-codex",
	model: "openai-codex/gpt-5.6-sol",
	cwd: "/work/project",
};

export function packageRule(overrides: Partial<RuleRecord> = {}): RuleRecord {
	return {
		id: "routing.cat-read",
		source: { kind: "package" },
		matcher: { kind: "code", key: "routing.cat-read" },
		definition: {
			purpose: "Read complete file content.",
			authority: "steer-or-block",
			revision: "111111111111",
			state: "active",
			effect: "block",
			note: "Prefer the read tool for one file.",
		},
		matcherAvailable: true,
		staleOverride: false,
		...overrides,
	};
}

export function localRule(overrides: Partial<RuleRecord> = {}): RuleRecord {
	return {
		id: "local.scan",
		source: {
			kind: "local",
			proposalId: "00000000-0000-4000-8000-000000000001",
			approvedAudit: operatorAudit,
		},
		matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "scan" } },
		definition: {
			purpose: "Keep search output bounded.",
			authority: "steer-or-block",
			revision: "222222222222",
			state: "active",
			effect: "steer",
			note: "Bound scan output.",
			scope: { modelProviders: ["openai-codex"], cwdPrefixes: ["/work"] },
		},
		override: {
			state: "disabled",
			effect: "block",
			reason: "Temporarily noisy",
			audit: operatorAudit,
			againstDefinitionRevision: "000000000000",
		},
		matcherAvailable: true,
		staleOverride: true,
		...overrides,
	};
}

export function snapshot(overrides: Partial<RuleSnapshot> = {}): RuleSnapshot {
	const records = new Map<string, RuleRecord>([
		["routing.cat-read", packageRule()],
		["local.scan", localRule()],
	]);
	return {
		records,
		data: new Map(),
		pending: [
			{
				kind: "proposal",
				id: "00000000-0000-4000-8000-000000000009",
				operation: "disable",
				ruleId: "routing.cat-read",
				reason: "Pause noisy guidance",
				audit: agentAudit,
			},
		],
		health: { status: "ok", path: "/agent/policy/rules.jsonl" },
		...overrides,
	};
}

export function activity(overrides: Partial<PolicyActivityRecord> = {}): PolicyActivityRecord {
	return {
		at: "2026-09-03T12:00:00.000Z",
		model: "openai-codex/gpt-5.6-sol",
		thinkingLevel: "high",
		tool: "bash",
		classes: ["routing.cat-read", "bounds.false-cap"],
		blocked: true,
		error: true,
		captured: "cat [redacted]",
		policyMode: "enforce",
		session: "session-observed",
		ruleStoreDegraded: true,
		...overrides,
	};
}

export function data(overrides: Partial<PolicyPanelData> = {}): PolicyPanelData {
	return {
		snapshot: snapshot(),
		fireSummary: {
			fires: new Map([
				["routing.cat-read", 3],
				["local.scan", 2],
			]),
			firesByModel: new Map([
				[
					"routing.cat-read",
					new Map([
						["openai-codex/gpt-5.6-sol", 2],
						[null, 1],
					]),
				],
			]),
			partial: false,
		},
		activity: {
			records: [activity()],
			partial: false,
			byteLimited: false,
			recordLimited: false,
			bytesRead: 200,
		},
		...overrides,
	};
}


export const viewTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

const PAGE_DOWN = "\u001b[6~";
const text = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line)).join("\n");
const theme = viewTheme;

/** A minimal frame: a stack of views with their own signals, as NavigationFrame provides them. */
export function viewStack() {
	const layers: Array<{ view: OperatorView; controller: AbortController }> = [];
	const notices: string[] = [];
	let closed = false;
	const host = (controller: AbortController): ViewHost => ({
		theme,
		target: { id: "session", label: "This session · work" },
		signal: controller.signal,
		requestRender: () => {},
		notify: (message, kind) => notices.push(`${kind ?? "info"}:${message}`),
		push: (open) => {
			const child = new AbortController();
			layers.push({ view: open(host(child)), controller: child });
		},
		back: () => {
			const index = layers.findIndex((layer) => layer.controller === controller);
			for (const layer of layers.splice(Math.max(1, index))) layer.controller.abort();
		},
		close: () => {
			closed = true;
		},
	});
	const root = new AbortController();
	const top = () => layers.at(-1)?.view;
	return {
		notices,
		closed: () => closed,
		mount(open: (host: ViewHost) => OperatorView) {
			layers.push({ view: open(host(root)), controller: root });
		},
		top,
		depth: () => layers.length,
		screen: (width = 120, height = 30) => text(top()?.render(width, height) ?? []),
		action(label: string) {
			const action = top()?.actions?.().find((candidate) => candidate.label === label);
			assert.ok(action, `no action ${label}; have ${top()?.actions?.().map((candidate) => candidate.label).join(", ")}`);
			return action;
		},
		/** Page through the view until it reports every line read, as an operator reading to the end. */
		readAll(width = 100, height = 8) {
			for (let page = 0; page < 200; page++) {
				const shown = text(top()?.render(width, height) ?? []);
				if (/All \d+ lines read/.test(shown)) return;
				top()?.handleInput(PAGE_DOWN);
			}
			assert.fail("the review never reported a complete read");
		},
	};
}
