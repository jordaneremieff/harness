/**
 * trust-support: shared project-trust resolution for the Durable host and the
 * primary session that owns it.
 *
 * The host resolves trust in the public order: an explicit decision, configured
 * `project_trust` handlers, the saved public store, the `defaultProjectTrust`
 * setting, then one routed ask to the primary session. The host refuses only
 * when no primary answer arrives. A handler or answer with `remember` writes the
 * public store, so the decision survives restarts. The primary side maps its UI
 * selection through `promptProjectTrust`; the host receives the answer through
 * `askPrimary` and persists it. This module carries no transport, session, or
 * package-loading logic.
 */
import type { LoadExtensionsResult, ProjectTrustContext, ProjectTrustEvent, ProjectTrustEventResult, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";

/** One decision for one cwd. `remember` writes it to the saved trust store. */
export interface ProjectTrustDecision {
	readonly trusted: boolean;
	readonly remember?: boolean;
}

/** Primary-side UI surface used for one ask. */
export interface ProjectTrustPrompt {
	select(prompt: string, options: readonly string[]): Promise<string | undefined>;
}

export interface ProjectTrustResolverOptions {
	/** Working directory whose trust is resolved. */
	readonly cwd: string;
	/** cwd-bound settings manager; the default is read at each unresolved attempt. */
	readonly settingsManager: SettingsManager;
	/** Public saved store. The caller constructs it with the selected agent directory. */
	readonly trustStore: ProjectTrustStore;
	/** True when cwd holds trust-requiring project resources. */
	readonly requiresTrust: (cwd: string) => boolean;
	/** Explicit decision. Bypasses handlers, store, default, and ask. */
	readonly trusted?: boolean;
	/** Route one unresolved ask to the primary session. Absent or undefined refuses. */
	readonly askPrimary?: (cwd: string) => Promise<ProjectTrustDecision | undefined>;
	/** Receives handler and transport failures. Must not throw. */
	readonly onReport?: (error: unknown) => void;
}

/** The no-UI context a Durable host gives to project_trust handlers. */
function trustContext(cwd: string): ProjectTrustContext {
	return {
		cwd,
		mode: "print",
		hasUI: false,
		ui: { notify() {}, select: async () => undefined, confirm: async () => false, input: async () => undefined },
	} as ProjectTrustContext;
}

/** First decided handler across the pre-trust extension set; undecided falls through. */
async function handlerDecision(cwd: string, extensions: LoadExtensionsResult, trustStore: ProjectTrustStore, report: (error: unknown) => void): Promise<boolean | undefined> {
	for (const extension of extensions.extensions) {
		for (const handler of extension.handlers.get("project_trust") ?? []) {
			try {
				const result = await handler({ type: "project_trust", cwd } satisfies ProjectTrustEvent, trustContext(cwd)) as ProjectTrustEventResult | undefined;
				if (result === undefined || result.trusted === "undecided") continue;
				const trusted = result.trusted === "yes";
				if (result.remember === true) trustStore.set(cwd, trusted);
				return trusted;
			} catch (error) {
				report(error);
			}
		}
	}
	return undefined;
}

/** Resolver compatible with `resourceLoaderReloadOptions.resolveProjectTrust`. */
export function createProjectTrustResolver(options: ProjectTrustResolverOptions): (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean> {
	const { cwd, settingsManager, trustStore, requiresTrust, trusted, askPrimary, onReport } = options;
	const report = onReport ?? (() => {});
	return async ({ extensionsResult }) => {
		if (trusted !== undefined) {
			trustStore.set(cwd, trusted);
			return trusted;
		}
		if (!requiresTrust(cwd)) return true;
		const decided = await handlerDecision(cwd, extensionsResult, trustStore, report);
		if (decided !== undefined) return decided;
		const stored = trustStore.get(cwd);
		if (stored !== null) return stored;
		const fallback = settingsManager.getDefaultProjectTrust();
		if (fallback === "always") return true;
		if (fallback === "never") return false;
		if (askPrimary === undefined) return false;
		return dispatchAsk(askPrimary, cwd, trustStore, report);
	};
}

/** One routed ask; a failure or an unanswered ask refuses. */
async function dispatchAsk(askPrimary: (cwd: string) => Promise<ProjectTrustDecision | undefined>, cwd: string, trustStore: ProjectTrustStore, report: (error: unknown) => void): Promise<boolean> {
	let answer: ProjectTrustDecision | undefined;
	try {
		answer = await askPrimary(cwd);
	} catch (error) {
		report(error);
		return false;
	}
	if (answer === undefined) return false;
	saveProjectTrustDecision(trustStore, cwd, answer);
	return answer.trusted;
}

/** Persist one decision. Session-only answers carry `remember: false`. */
export function saveProjectTrustDecision(trustStore: ProjectTrustStore, cwd: string, decision: ProjectTrustDecision): void {
	if (decision.remember === true) trustStore.set(cwd, decision.trusted);
}

/** Primary-side labels, including the session-only variants. */
const PRIMARY_TRUST_OPTIONS = [
	{ label: "Trust this folder", trusted: true, remember: true },
	{ label: "Trust this folder for this session", trusted: true, remember: false },
	{ label: "Do not trust", trusted: false, remember: true },
	{ label: "Do not trust for this session", trusted: false, remember: false },
] as const;

/** Primary-side: ask once through a UI select; undefined means the asker refuses. */
export async function promptProjectTrust(cwd: string, prompt: ProjectTrustPrompt): Promise<ProjectTrustDecision | undefined> {
	const selected = await prompt.select(`Trust project folder?\n${cwd}\n\nThis allows Pi to load project settings and resources, install project packages, and execute project extensions.`, PRIMARY_TRUST_OPTIONS.map((option) => option.label));
	const choice = PRIMARY_TRUST_OPTIONS.find((option) => option.label === selected);
	return choice === undefined ? undefined : { trusted: choice.trusted, remember: choice.remember };
}
