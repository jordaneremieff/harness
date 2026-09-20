/**
 * Host facts for the no-argument summary.
 *
 * Every fact comes from a Pi export or the callback context. A fact whose
 * accessor is absent or fails is reported as unavailable; it is never inferred
 * from an unrelated path. Accessors are injected so the fact table can be tested
 * without the installed package.
 */

import { existsSync } from "node:fs";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getDocsPath,
	getExamplesPath,
	getPackageDir,
	getReadmePath,
	VERSION,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface HostFact {
	key: string;
	value: string | null;
	/** Set when the fact is a path, reporting whether that path resolves now. */
	exists?: boolean | null;
	/** Set when the value's scope is narrower than its name suggests. */
	note?: string;
}

export interface HostAccessors {
	version: () => string;
	packageDir: () => string;
	docsPath: () => string;
	examplesPath: () => string;
	readmePath: () => string;
	agentDir: () => string;
	configDirName: () => string;
	pathExists: (path: string) => boolean;
}

export const installedAccessors: HostAccessors = {
	version: () => VERSION,
	packageDir: () => getPackageDir(),
	docsPath: () => getDocsPath(),
	examplesPath: () => getExamplesPath(),
	readmePath: () => getReadmePath(),
	agentDir: () => getAgentDir(),
	configDirName: () => CONFIG_DIR_NAME,
	pathExists: (path: string) => existsSync(path),
};

function fact(key: string, read: () => string, exists?: (value: string) => boolean | null, note?: string): HostFact {
	try {
		const value = read();
		if (typeof value !== "string" || value.length === 0) return { key, value: null };
		const entry: HostFact = { key, value };
		if (exists) entry.exists = exists(value);
		if (note) entry.note = note;
		return entry;
	} catch {
		return { key, value: null };
	}
}

export interface ContextSnapshot {
	at: number;
	evidence: "host_estimate";
	state: "available" | "unknown" | "unavailable";
	model: string | null;
	thinkingLevel: string | null;
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

/** Read on demand. Pi owns the estimate and its post-compaction unknown state. */
export function readContext(ctx: ExtensionContext, at: number): ContextSnapshot {
	const snapshot: ContextSnapshot = {
		at, evidence: "host_estimate", state: "unavailable",
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
		thinkingLevel: ctx.thinkingLevel ?? null,
		tokens: null, contextWindow: null, percent: null,
	};
	try {
		const usage = ctx.getContextUsage();
		if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return snapshot;
		snapshot.contextWindow = usage.contextWindow;
		if (usage.tokens === null || usage.percent === null) {
			snapshot.state = "unknown";
		} else if (Number.isFinite(usage.tokens) && usage.tokens >= 0 && Number.isFinite(usage.percent) && usage.percent >= 0) {
			snapshot.state = "available";
			snapshot.tokens = usage.tokens;
			snapshot.percent = usage.percent;
		}
	} catch { /* Access failure does not establish an empty context. */ }
	return snapshot;
}

export const CONTEXT_BOUNDARY = "Pi estimates context from assistant usage and trailing messages; unknown usage can follow compaction. This is not a safe remaining budget, a final provider payload count, or a compaction threshold.";

export function contextLines(context: ContextSnapshot): string[] {
	return [
		"CURRENT SESSION",
		`- model: ${context.model === null ? "unavailable" : JSON.stringify(context.model)}`,
		`- thinking level: ${context.thinkingLevel === null ? "unavailable" : JSON.stringify(context.thinkingLevel)}`,
		`- context usage: ${context.state} (host_estimate)`,
		`- context tokens: ${context.tokens ?? "unknown"}`,
		`- context window: ${context.contextWindow ?? "unavailable"}`,
		`- context percent: ${context.percent ?? "unknown"}`,
		CONTEXT_BOUNDARY,
	];
}

export interface SessionFacts {
	cwd?: string;
	mode?: string;
	hasUI?: boolean;
	projectTrusted?: boolean;
	sessionId?: string;
	sessionFile?: string | null;
}

/**
 * The agent-directory fact is the process default that `getAgentDir()` resolves.
 * An embedding that configured a different agent directory is not reflected
 * there, so the value carries that boundary with it.
 */
export function hostFacts(session: SessionFacts, accessors: HostAccessors = installedAccessors): HostFact[] {
	const exists = (value: string) => {
		try {
			return accessors.pathExists(value);
		} catch {
			return null;
		}
	};
	return [
		{ key: "cwd", value: typeof session.cwd === "string" && session.cwd.length > 0 ? session.cwd : null },
		{ key: "mode", value: typeof session.mode === "string" && session.mode.length > 0 ? session.mode : null },
		{ key: "hasUI", value: typeof session.hasUI === "boolean" ? String(session.hasUI) : null },
		{
			key: "projectTrusted",
			value: typeof session.projectTrusted === "boolean" ? String(session.projectTrusted) : null,
		},
		{ key: "sessionId", value: session.sessionId ?? null },
		{ key: "sessionFile", value: session.sessionFile === null ? "(ephemeral)" : session.sessionFile ?? null,
			note: "sessionFile absence means an ephemeral session only when the accessor answered" },
		fact("installedVersion", accessors.version),
		fact("packageDir", accessors.packageDir, exists),
		fact("docsPath", accessors.docsPath, exists),
		fact("examplesPath", accessors.examplesPath, exists),
		fact("readmePath", accessors.readmePath, exists),
		fact(
			"agentDirDefault",
			accessors.agentDir,
			exists,
			"process default from getAgentDir(); an embedding-configured agent directory is not reflected here",
		),
		fact("configDirName", accessors.configDirName),
	];
}
