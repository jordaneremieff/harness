import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { proposalRevision, type RuleSnapshot, targetIdentity } from "./local-rules.ts";
import { ArtifactReview, artifactLines, type PolicyOperations, type PolicyResult, policyView } from "./operator-view.ts";
import { data, localRule, packageRule, scopeContext, snapshot, viewStack as stack } from "./view-fixture.mts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));


type Call = readonly [string, ...unknown[]];

function operations(current: RuleSnapshot = snapshot(), patch: Partial<PolicyOperations> = {}) {
	const calls: Call[] = [];
	let shown = current;
	const settled = async (outcome: string): Promise<PolicyResult> => ({ outcome, snapshot: shown });
	const ops: PolicyOperations = {
		load: async () => {
			calls.push(["load"]);
			return { snapshot: shown, fireSummary: data().fireSummary, activity: data().activity, scope: scopeContext };
		},
		refresh: async () => {
			calls.push(["refresh"]);
			return shown;
		},
		inspect: async (view, id) => {
			calls.push(["inspect", view, id]);
			return { text: `${view} evidence`, snapshot: shown };
		},
		approve: async (id, effect, revision) => {
			calls.push(["approve", id, effect, revision]);
			shown = { ...shown, pending: [] };
			return settled(`Approved proposal ${id}.`);
		},
		reject: async (id, revision) => {
			calls.push(["reject", id, revision]);
			return settled(`Rejected proposal ${id}.`);
		},
		lifecycle: async (verb, id, reason, expected) => {
			calls.push(["lifecycle", verb, id, reason, expected]);
			return settled(`Done ${verb} ${id}.`);
		},
		effect: async (id, effect, reason, expected) => {
			calls.push(["effect", id, effect, reason, expected]);
			return settled(`Set ${id} effect to ${effect}.`);
		},
		resetRevision: async (id) => {
			calls.push(["reset-revision", id]);
			return "abcdefabcdef";
		},
		reset: async (id, reason, revision) => {
			calls.push(["reset", id, reason, revision]);
			return settled("Started a new policy observation period.");
		},
		data: async (args) => {
			calls.push(["data", args]);
			if (args.startsWith("show")) return { outcome: "binding text", snapshot: shown };
			if (args.includes("APPROVED")) return { outcome: "Set data hosts.", snapshot: shown };
			return { review: { title: "Approve policy data", text: `Review of ${args}`, approval: `${args} APPROVED`, action: "Set policy data" }, snapshot: shown };
		},
		...patch,
	};
	return { ops, calls, mutations: () => calls.filter(([name]) => !["load", "refresh", "inspect", "data"].includes(name) || (name === "data" && String(calls.at(-1)?.[1]).includes("APPROVED"))) };
}

async function opened(ops: PolicyOperations) {
	const frame = stack();
	frame.mount((host) => policyView(host, ops));
	await turn();
	return frame;
}

describe("complete artifact review", () => {
	it("keeps every whitespace character and grapheme across display wraps", () => {
		const artifact = "  {\n    \"key\":  \"two  spaces\"\n  }\n👩‍👩‍👧 family";
		const lines = artifactLines(artifact, 12);
		assert.equal(lines.join(""), artifact.replace(/\n/g, ""), "no character is dropped or reflowed");
		assert.ok(lines.every((line) => visibleWidth(line) <= 12));
		assert.ok(lines.some((line) => line.includes("👩‍👩‍👧")), "a grapheme is never split");
	});

	it("offers the final action only after every line was on screen, and a width change starts again", async () => {
		const frame = stack();
		const decisions: boolean[] = [];
		frame.mount((host) => new ArtifactReview({ host, title: "Import review", artifact: Array.from({ length: 60 }, (_, row) => `artifact-row-${row}`).join("\n"), label: "Import", decide: (approved) => void decisions.push(approved) }));
		assert.ok(frame.screen(100, 8).includes("read every line before Import"));
		assert.equal(typeof frame.action("Import").disabled, "string");
		frame.action("Import").run();
		assert.deepEqual(decisions, [], "a disabled final action decides nothing");
		frame.readAll(100, 8);
		assert.equal(frame.action("Import").disabled, undefined);
		frame.screen(60, 8);
		assert.equal(typeof frame.action("Import").disabled, "string", "new line breaks need a new read");
		frame.readAll(60, 8);
		frame.action("Import").run();
		await turn();
		assert.deepEqual(decisions, [true]);
		frame.action("Cancel").run();
		await turn();
		assert.deepEqual(decisions, [true, false]);
	});
});

describe("policy view", () => {
	it("lists rule titles first with their identities, and selection only reads", async () => {
		const { ops, calls } = operations(snapshot({ records: new Map([["routing.cat-read", packageRule()], ["local.scan", localRule()], ["local.other", localRule({ id: "local.other" })]]) }));
		const frame = await opened(ops);
		const screen = frame.screen();
		assert.ok(screen.includes("Read complete file content."));
		assert.ok(screen.includes("routing.cat-read"));
		assert.ok(screen.includes("local.other"), "rules that share a purpose stay distinguishable");
		for (const scope of ["Rules", "Proposals", "Activity", "Data", "State"]) assert.ok(screen.includes(scope), `${scope} scope missing`);
		frame.top()?.handleInput("\u001b[B");
		frame.screen();
		assert.deepEqual(calls.map(([name]) => name), ["load"], "moving the selection calls no owner change");
	});

	it("never offers an exact-only rule an effect choice", async () => {
		const exact = packageRule({ definition: { ...packageRule().definition, authority: "exact" } });
		const { ops } = operations(snapshot({ records: new Map([["routing.cat-read", exact]]) }));
		const frame = await opened(ops);
		frame.screen();
		assert.match(String(frame.action("Effect…").disabled), /exact replacement proposal only/);
	});

	it("disables a rule with a required reason against the identity the operator read", async () => {
		const { ops, calls } = operations();
		const frame = await opened(ops);
		frame.screen();
		frame.action("Disable…").run();
		const form = frame.top();
		assert.ok(frame.screen().includes("Disable rule routing.cat-read"));
		await (form as unknown as { submit(): Promise<void> }).submit();
		assert.ok(frame.screen().includes("Write the reason first."), "an empty reason is refused before any request");
		assert.equal(calls.filter(([name]) => name === "lifecycle").length, 0);
		for (const key of "too noisy") form?.handleInput(key === " " ? " " : key);
		frame.action("Disable rule").run();
		await turn();
		assert.deepEqual(calls.find(([name]) => name === "lifecycle"), ["lifecycle", "disable", "routing.cat-read", "too noisy", targetIdentity(packageRule()) ?? undefined]);
		assert.equal(frame.depth(), 1, "the form leaves after success");
		assert.ok(frame.notices.some((notice) => notice === "success:Done disable routing.cat-read."));
	});

	it("approves an exact proposal only from the final action after the complete artifact was read", async () => {
		const { ops, calls } = operations();
		const frame = await opened(ops);
		frame.top()?.handleInput("\t");
		const proposal = snapshot().pending[0];
		assert.ok(proposal);
		// The Proposals scope lists the pending disable proposal.
		(frame.top() as unknown as { focusNext(backward: boolean): boolean }).focusNext(true);
		frame.top()?.handleInput("\u001b[C");
		frame.screen();
		assert.ok(frame.screen().includes("Pause noisy guidance"));
		frame.action("Approve…").run();
		assert.ok(frame.screen(100, 8).includes(`Approve disable proposal ${proposal.id}`), "a short window shows the first lines only");
		frame.action("Approve disable").run();
		await turn();
		assert.equal(calls.filter(([name]) => name === "approve").length, 0, "nothing approves before the whole artifact was read");
		frame.readAll();
		frame.action("Approve disable").run();
		await turn();
		assert.deepEqual(calls.find(([name]) => name === "approve"), ["approve", proposal.id, undefined, proposalRevision(proposal)]);
		assert.equal(frame.depth(), 1);
		assert.ok(frame.notices.includes(`success:Approved proposal ${proposal.id}.`));
	});

	it("an approval that permits steer or block names the chosen effect on its final action", async () => {
		const add = {
			kind: "proposal" as const,
			id: "00000000-0000-4000-8000-000000000010",
			operation: "add" as const,
			ruleId: "local.new",
			reason: "Add guidance",
			audit: snapshot().pending[0]?.audit ?? ({} as never),
			candidate: { purpose: "Guide bounded scans.", authority: "steer-or-block" as const, matcher: { kind: "declarative" as const, language: "command-shape/v1" as const, spec: { command: "scan" } }, note: "Bound it.", state: "active" as const, effect: "steer" as const, revision: "333333333333" },
		};
		const { ops, calls } = operations(snapshot({ pending: [add] as never }));
		const frame = await opened(ops);
		(frame.top() as unknown as { focusNext(backward: boolean): boolean }).focusNext(true);
		frame.top()?.handleInput("\u001b[C");
		frame.screen();
		frame.action("Approve…").run();
		assert.ok(frame.screen().includes("choose its effect"));
		frame.top()?.handleInput("\u001b[B");
		frame.action("Read the artifact").run();
		await turn();
		frame.readAll();
		frame.action("Approve as block").run();
		await turn();
		assert.deepEqual(calls.find(([name]) => name === "approve"), ["approve", add.id, "block", proposalRevision(add as never)]);
		assert.equal(frame.depth(), 1, "the operator returns to the list through the effect choice");
	});

	it("a refused change reads the registry again and keeps the form with the reason", async () => {
		const { ops, calls } = operations(snapshot(), {
			lifecycle: async () => {
				throw new Error("Rule routing.cat-read changed since it was read");
			},
		});
		const frame = await opened(ops);
		frame.screen();
		frame.action("Disable…").run();
		for (const key of "pause") frame.top()?.handleInput(key);
		frame.action("Disable rule").run();
		await turn();
		await turn();
		assert.ok(calls.some(([name]) => name === "refresh"), "a refusal reads the registry again");
		assert.ok(frame.screen().includes("changed since it was read"));
		assert.equal(frame.depth(), 2, "the staged form stays");
	});

	it("a data change opens its complete review, and only the reviewed approval applies", async () => {
		const { ops, calls } = operations();
		const frame = await opened(ops);
		const scopes = frame.top() as unknown as { focusNext(backward: boolean): boolean };
		scopes.focusNext(true);
		for (let step = 0; step < 3; step++) frame.top()?.handleInput("\u001b[C");
		assert.ok(frame.screen().includes("No named policy data"));
		frame.action("Set data…").run();
		frame.top()?.handleInput("{");
		frame.top()?.handleInput("}");
		frame.action("Review change").run();
		await turn();
		assert.ok(frame.screen().includes("Review of set {}"));
		frame.readAll();
		frame.action("Set policy data").run();
		await turn();
		assert.deepEqual(calls.filter(([name]) => name === "data").map(([, args]) => args), ["set {}", "set {} APPROVED"]);
		assert.equal(frame.depth(), 1, "the review and the form both leave after the change applies");
	});
});
