import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlaybookCatalog } from "./playbook-catalog.ts";
import { renderPlaybook, requirePlaybook } from "./playbook.ts";
import type { PlaybookTargetState } from "./playbook-browser.ts";
import { playbookName } from "./playbook-files.ts";

const entryType = "agent.playbook";
type Selection = { name: string | null; origin: "operator" | "unset" | "unsupported" };

export function branchPlaybook(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): Selection {
	const entry = branch.findLast((item) => item.type === "custom" && item.customType === entryType);
	if (entry?.type !== "custom") return { name: null, origin: "unset" };
	const value = entry.data as { version?: unknown; origin?: unknown; name?: unknown } | undefined;
	if (value?.version === 1 && value.origin === "operator" && (value.name === null || (typeof value.name === "string" && playbookName(value.name)))) {
		return { name: value.name, origin: "operator" };
	}
	return { name: null, origin: "unsupported" };
}

/** True when the catalog supplies this name's instructions to a run. */
function applies(catalog: PlaybookCatalog | undefined, name: string): boolean {
	return catalog?.state === "ready" && catalog.entries.some((entry) => entry.name === name);
}

/** The footer word for a selection: nothing for none, and a flag when its file supplies no instructions. */
function badge(choice: Selection, catalog?: PlaybookCatalog): string | undefined {
	if (choice.origin === "unsupported") return "unknown";
	if (choice.name === null) return undefined;
	return applies(catalog, choice.name) ? choice.name : `${choice.name} unavailable`;
}

const UNSENT = "The last run did not receive it: another extension replaced the whole system prompt before this section was added.";

function named(name: string | null | undefined): string {
	return name ? `the ${name} playbook` : "no playbook";
}

/**
 * The selected branch owns the next run. While a run is active its own selection stays in
 * memory, so the footer can show a change that waits for the next run.
 */
export class OrdinaryPlaybook {
	private running?: { name: string | null; badge: string | undefined };
	private shown?: string;
	/** The playbook whose text the last run prepared but could not send, because the prompt was replaced. */
	private unsent?: string;
	private readonly pi: Pick<ExtensionAPI, "appendEntry">;
	private readonly catalog: (initialize?: boolean) => PlaybookCatalog;
	private readonly publish: (ctx: ExtensionContext, badge: string | undefined) => void;

	constructor(
		pi: Pick<ExtensionAPI, "appendEntry">,
		catalog: (initialize?: boolean) => PlaybookCatalog,
		publish: (ctx: ExtensionContext, badge: string | undefined) => void,
	) {
		this.pi = pi;
		this.catalog = catalog;
		this.publish = publish;
	}

	/** The badge last shown in the agent cell; reading it performs no I/O. */
	get badge(): string | undefined {
		return this.shown;
	}

	/** Marks a badge whose playbook the last run could not send. */
	private sent(badge: string | undefined, name: string | null): string | undefined {
		return badge !== undefined && name !== null && name === this.unsent ? `${badge} not sent` : badge;
	}

	private show(ctx: ExtensionContext, saved: string | undefined): void {
		const running = this.running;
		this.shown = running === undefined || running.badge === saved ? saved : `${running.badge ?? "off"} \u2192 ${saved ?? "off"}`;
		this.publish(ctx, this.shown);
	}

	/** The saved choice and, during a run, the run's own choice when it differs. */
	state(ctx: ExtensionContext): PlaybookTargetState {
		const choice = branchPlaybook(ctx.sessionManager.getBranch());
		const running = this.running !== undefined && this.running.name !== choice.name ? { running: this.running.name } : {};
		if (choice.origin === "unsupported") return { saved: undefined, note: "The saved choice has an unsupported form. Choose a playbook or off to replace it.", ...running };
		const unsent = choice.name !== null && choice.name === this.unsent ? { note: UNSENT, unsent: true } : {};
		return { saved: choice.name, ...(choice.origin === "operator" ? { origin: "you chose it" } : {}), ...running, ...unsent };
	}

	status(ctx: ExtensionContext): string {
		const choice = branchPlaybook(ctx.sessionManager.getBranch());
		const catalog = choice.name === null ? undefined : this.catalog();
		this.show(ctx, this.sent(badge(choice, catalog), choice.name));
		if (choice.origin === "unsupported") return "This session: unknown playbook (unsupported saved selection). Choose a playbook or off to replace it.";
		const unavailable = choice.name !== null && !applies(catalog, choice.name) ? " Its file supplies no instructions now; see /agent playbook." : choice.name !== null && choice.name === this.unsent ? ` ${UNSENT}` : "";
		const pending = this.running !== undefined && this.running.name !== choice.name ? ` The current run keeps ${named(this.running.name)}.` : "";
		return `This session: ${named(choice.name)}.${unavailable}${pending}`;
	}

	set(name: string, ctx: ExtensionContext): string {
		const catalog = name === "off" ? undefined : this.catalog(true);
		const choice: Selection = { name: catalog ? requirePlaybook(catalog, name) : null, origin: "operator" };
		this.pi.appendEntry(entryType, { version: 1, ...choice });
		this.show(ctx, badge(choice, catalog));
		const pending = this.running !== undefined && this.running.name !== choice.name ? ` The current run keeps ${named(this.running.name)}; the next run uses it.` : "";
		return `This session now uses ${named(choice.name)}.${pending}`;
	}

	/**
	 * Prepares the run's playbook text. `replaced` is true when an earlier handler has already
	 * replaced the whole system prompt: Pi then sends that text alone, without this section.
	 */
	start(ctx: ExtensionContext, catalog: PlaybookCatalog, replaced = false): string | undefined {
		const selected = branchPlaybook(ctx.sessionManager.getBranch());
		const text = renderPlaybook(catalog, selected.name);
		this.unsent = text !== undefined && replaced && selected.name !== null ? selected.name : undefined;
		const shown = this.sent(badge(selected, catalog), selected.name);
		this.running = { name: selected.name, badge: shown };
		this.show(ctx, shown);
		return text;
	}

	restore(ctx: ExtensionContext): void {
		this.running = undefined;
		this.status(ctx);
	}
}
