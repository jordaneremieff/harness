import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compilePlan, planNames, sendWithinPlan, wirePlan, workerPlanSnapshot } from "./plans.ts";

const frame = {
	objective: "Decide the source rule.",
	sources: "Read source.txt and cite the exact line.",
	boundaries: "Read only. No publication.",
	integration: { destination: "Parent response", acceptance: "The rule agrees with source.txt." },
	members: [
		{ task: "Check semantics", model: "fixture/one" },
		{ task: "Check edge cases", profile: "review" },
	],
};

describe("named plan contracts", () => {
	for (const name of planNames)
		it(`compiles and wires ${name} without altering caller input`, () => {
			const input = { ...frame, name };
			const before = structuredClone(input);
			const plan = compilePlan(input);
			assert.deepEqual(input, before);
			assert.equal(plan.members[0].model, "fixture/one");
			assert.equal(plan.members[1].profile, "review");
			const wired = wirePlan(plan, ["bg-first", "bg-second"]);
			assert.deepEqual(wired[0].collaboration.peers, [{ id: "bg-second", role: plan.members[1].role }]);
			assert.deepEqual(workerPlanSnapshot(wired[0].collaboration), wired[0].collaboration);
			for (const member of wired) {
				for (const value of [
					frame.objective,
					frame.sources,
					frame.boundaries,
					frame.integration.acceptance,
					"submit_result",
					"parent combines",
					"Peer roster",
				])
					assert.ok(member.task.includes(value), value);
			}
		});
	it("bounds rounds and member counts and rejects ambiguous or oversized contracts", () => {
		for (const rounds of [0, 4, 1.5, NaN])
			assert.throws(() => compilePlan({ ...frame, name: "panel-review", rounds }), /rounds/);
		for (const members of [[], frame.members.slice(0, 1), [...frame.members, ...frame.members, frame.members[0]]])
			assert.throws(() => compilePlan({ ...frame, name: "panel-review", members }), /members/);
		assert.throws(
			() => compilePlan({ ...frame, name: "adversarial-debate", members: [...frame.members, frame.members[0]] }),
			/exactly two/,
		);
		assert.throws(() => compilePlan({ ...frame, name: "panel-review", sources: " " }), /sources/);
		assert.throws(
			() => compilePlan({ ...frame, name: "panel-review", members: [{ task: "" }, { task: "other" }] }),
			/nonblank/,
		);
		assert.throws(
			() => compilePlan({ ...frame, name: "panel-review", objective: "界".repeat(2000), sources: "界".repeat(2000) }),
			/8192/,
		);
		const plan = compilePlan({
			...frame,
			name: "panel-review",
			rounds: 3,
			members: [...frame.members, ...frame.members],
		});
		assert.deepEqual(
			plan.members.map((member) => member.messageLimit),
			[12, 12, 12, 12],
		);
		assert.throws(() => wirePlan(plan, ["x"]), /distinct/);
		assert.throws(() => wirePlan(plan, ["x", "x", "x", "x"]), /distinct/);
	});
	it("assigns role-specific advisor exchanges and rejects malformed stored metadata", () => {
		const plan = compilePlan({ ...frame, name: "advisor-to-implementer", rounds: 2 });
		assert.deepEqual(
			plan.members.map(({ role, messageLimit }) => [role, messageLimit]),
			[
				["advisor", 3],
				["implementer", 2],
			],
		);
		assert.match(plan.members[1].task, /before changes/);
		assert.match(plan.members[0].task, /wait for the implementer/);
		for (const input of [null, {}, { ...wirePlan(plan, ["bg-a", "bg-b"])[0].collaboration, messagesSent: 99 }])
			assert.equal(workerPlanSnapshot(input), undefined);
	});
	it("reserves sends before delivery, refunds refusals, and preserves bounds on persistence errors", () => {
		const plan = wirePlan(compilePlan({ ...frame, name: "advisor-to-implementer" }), ["bg-a", "bg-b"])[1].collaboration;
		const persisted: number[] = [];
		const save = () => {
			persisted.push(plan.messagesSent);
		};
		assert.throws(
			() =>
				sendWithinPlan(
					plan,
					"bg-a",
					() => {
						throw new Error("target closed");
					},
					save,
				),
			/target closed/,
		);
		assert.deepEqual(persisted, [1, 0]);
		assert.throws(
			() =>
				sendWithinPlan(
					plan,
					"bg-a",
					() => assert.fail("must not send"),
					() => {
						throw new Error("disk");
					},
				),
			/disk/,
		);
		assert.equal(plan.messagesSent, 0);
		assert.equal(
			sendWithinPlan(plan, "bg-a", () => "sent", save),
			"sent",
		);
		assert.throws(() => sendWithinPlan(plan, "bg-a", () => assert.fail("must not send"), save), /exhausted/);
		assert.equal(
			sendWithinPlan(plan, "parent", () => "report", save),
			"report",
		);
		assert.equal(plan.messagesSent, 1);
	});
});

it("runs named plans through real Pi sessions with model-free previews and owned cleanup", async () => {
	const coverage = mkdtempSync(join(tmpdir(), "subagent-plan-coverage-"));
	try {
		const { stdout, stderr } = await promisify(execFile)(
			process.execPath,
			[join(dirname(fileURLToPath(import.meta.url)), "plans-runtime-child.mts")],
			{ encoding: "utf8", timeout: 90_000, maxBuffer: 1_000_000, env: { ...process.env, NODE_V8_COVERAGE: coverage } },
		);
		assert.match(stdout, /named plans runtime: PASS/, `${stdout}\n${stderr}`);
	} finally {
		rmSync(coverage, { recursive: true, force: true });
	}
});
