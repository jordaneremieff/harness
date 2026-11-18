import { opt, str } from "@earendil-works/pi-schema";
import { bundledPlaybooks, type PlaybookCatalog } from "./playbook-catalog.ts";

const selector = str({ minLength: 1, maxLength: 48, pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
const purpose = "Choose how this agent divides work. Creation does not inherit a playbook; configure with off to clear it.";
export const PlaybookParameter = opt({ ...selector, description: purpose });

export function playbookParameter(catalog: PlaybookCatalog) {
	const missing = catalog.state === "missing";
	const choices = missing ? bundledPlaybooks() : catalog.entries;
	const inventory = choices.map(({ name, summary }) => `${name}: ${summary}`).join("; ");
	return opt({ ...selector, description: `${purpose} ${missing ? "Bundled starters (not installed)" : `Playbooks (${catalog.state})`}: ${inventory || "none"}. Diagnostics: ${catalog.diagnostics.length}.` });
}

export function requirePlaybook(catalog: PlaybookCatalog, name: string): string {
	if (catalog.state === "ready" && catalog.entries.some((entry) => entry.name === name)) return name;
	throw new Error(`Cannot select playbook ${JSON.stringify(name.slice(0, 48))}: catalog ${catalog.state}${catalog.state === "ready" ? ", name absent or invalid" : ""}. See /agent playbook for diagnostics.`);
}

export function renderPlaybook(catalog: PlaybookCatalog, name: string | null): string | undefined {
	const choice = catalog.state === "ready" && name !== null ? catalog.entries.find((entry) => entry.name === name) : undefined;
	if (!choice) return undefined;
	return `This session runs the **${choice.name}** playbook. A playbook sets defaults for how you divide work with agents. It grants no authority and removes no rule. An instruction for a single task overrides it for that task. Give an agent you create the playbook that fits its part, or none.\n\n${choice.body}`;
}
