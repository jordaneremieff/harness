import type { AgentDialogs, DialogChoice, InputOptions } from "./dialog-adapter.ts";

export interface DialogCall { kind: "select" | "confirm" | "input" | "editor" | "read" | "notify"; title: string; choices?: readonly DialogChoice[]; selected?: string; options?: InputOptions; initial?: string; description?: string }

/**
 * Prompts consume scripted answers in order. `undefined` cancels; confirm takes a boolean.
 * A function answer receives the call, for answers that depend on what was offered.
 */
export function scriptedDialogs(answers: readonly unknown[], options: { filtersChoices?: boolean } = {}): AgentDialogs & { calls: DialogCall[]; remaining(): number } {
	const queue = [...answers];
	const calls: DialogCall[] = [];
	const next = (call: DialogCall) => {
		calls.push(call);
		if (!queue.length) throw new Error(`Unscripted ${call.kind} dialog: ${call.title}`);
		const answer = queue.shift();
		return typeof answer === "function" ? (answer as (call: DialogCall) => unknown)(call) : answer;
	};
	return {
		calls,
		remaining: () => queue.length,
		filtersChoices: options.filtersChoices ?? true,
		select: async (title, choices, selected) => next({ kind: "select", title, choices, selected }) as string | undefined,
		confirm: async (title, description, action) => next({ kind: "confirm", title, description, choices: [{ value: "apply", label: action }] }) === true,
		input: async (title, inputOptions) => next({ kind: "input", title, options: inputOptions }) as string | undefined,
		editor: async (title, initial) => next({ kind: "editor", title, initial }) as string | undefined,
		read: async (title, text) => { calls.push({ kind: "read", title, initial: text }); },
		notify: (text) => { calls.push({ kind: "notify", title: text }); },
	};
}
