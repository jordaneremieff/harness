import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlaybookCatalog } from "./playbook-catalog.ts";
import { renderPlaybook, requirePlaybook } from "./playbook.ts";
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

function describe(choice: Selection, catalog?: PlaybookCatalog): string {
	if (choice.origin === "unsupported") return "unknown (unsupported saved selection)";
	if (choice.name === null) return `off (${choice.origin})`;
	const item = catalog?.state === "ready" && catalog.entries.find(({ name }) => name === choice.name);
	return `${choice.name} (${choice.origin}) · ${item ? item.summary : "unavailable; see /agent playbook"}`;
}

/** The selected branch owns the next run; only its prepared run label stays in memory. */
export class OrdinaryPlaybook {
	private active?: string;
	private readonly pi: Pick<ExtensionAPI, "appendEntry">;
	private readonly catalog: (initialize?: boolean) => PlaybookCatalog;
	constructor(pi: Pick<ExtensionAPI, "appendEntry">, catalog: (initialize?: boolean) => PlaybookCatalog) {
		this.pi = pi;
		this.catalog = catalog;
	}

	private show(ctx: ExtensionContext, pending: string): string {
		const text = this.active !== undefined && this.active !== pending ? `Playbook current: ${this.active}; next run: ${pending}` : `Playbook: ${pending}`;
		if (ctx.hasUI) ctx.ui.setStatus("agent-playbook", text);
		return text;
	}

	status(ctx: ExtensionContext): string {
		const choice = branchPlaybook(ctx.sessionManager.getBranch());
		return this.show(ctx, describe(choice, choice.name === null ? undefined : this.catalog()));
	}

	set(name: string, ctx: ExtensionContext): string {
		const catalog = name === "off" ? undefined : this.catalog(true);
		const choice: Selection = { name: catalog ? requirePlaybook(catalog, name) : null, origin: "operator" };
		this.pi.appendEntry(entryType, { version: 1, ...choice });
		return this.show(ctx, describe(choice, catalog));
	}

	start(ctx: ExtensionContext, catalog: PlaybookCatalog): string | undefined {
		const selected = branchPlaybook(ctx.sessionManager.getBranch());
		this.active = describe(selected, catalog);
		this.show(ctx, this.active);
		return renderPlaybook(catalog, selected.name);
	}

	restore(ctx: ExtensionContext): void {
		this.active = undefined;
		this.status(ctx);
	}
}
