/**
 * testdata/lifecycle-command: durable test fixture. Registers one command that
 * replaces the session with an ordinary setup write and a withSession message,
 * exercising the full command -> lifecycle -> replacement caller boundary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerLifecycleCommandFixture(pi: ExtensionAPI) {
	pi.on("session_before_tree", () => ({ customInstructions: "REPLACED_BRANCH_INSTRUCTIONS", replaceInstructions: true, label: "selected branch" }));
	pi.registerCommand("agent-tree-test", {
		description: "Select a branch with replaced summary instructions",
		handler: async (args, ctx) => { await ctx.navigateTree(args, { summarize: true }); },
	});
	pi.registerCommand("agent-ui-context-test", {
		description: "Record the native headless UI contract",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Worker notice");
			ctx.ui.setStatus("worker", "status");
			ctx.ui.setEditorText("Worker draft");
			pi.appendEntry("agent.ui-context", {
				mode: ctx.mode, hasUI: ctx.hasUI,
				confirmed: await ctx.ui.confirm("Worker", "Confirm"),
				selected: await ctx.ui.select("Worker", ["Choice"]) ?? null,
				input: await ctx.ui.input("Worker") ?? null,
				custom: await ctx.ui.custom(() => { throw new Error("Headless custom UI executed"); }) ?? null,
				editor: ctx.ui.getEditorText(),
			});
		},
	});
	pi.registerCommand("agent-write-boundary", {
		description: "Record immediate and committed read observations",
		handler: async (_args, ctx) => {
			pi.appendEntry("agent.pending-write", { value: "persisted" });
			const immediate = ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "agent.pending-write");
			pi.appendEntry("agent.immediate-read", { immediate });
		},
	});
	pi.registerCommand("agent-replace-test", {
		description: "Replace the session with a setup write and a withSession message",
		handler: async (_args, ctx) => {
			await ctx.newSession({
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry("agent.setup.test", { seeded: true });
				},
				withSession: async (replaced) => {
					await replaced.sendMessage({
						customType: "agent.replaced.test",
						content: "replacement-context",
						display: true,
						details: undefined,
					});
				},
			});
		},
	});
}
