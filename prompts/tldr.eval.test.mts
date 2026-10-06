import assert from "node:assert/strict";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { piSdkAdapter, runDeterministicChecks } from "../evals/subjects/pi-sdk.mts";
import suite from "./tldr.eval.mts";

const examples: Record<string, string> = {
	"long-status":
		"The local fix prevents duplicate invoices when an export retries. The live service remains untested, so the fix is not ready for release. The patch stays local and unpushed for your review.",
	"multi-part-assessment":
		"I recommend saving drafts locally because the prototype restored them after a normal restart. Power loss remains untested, and the change is not installed. You need to decide whether unsent text stored unencrypted on disk is acceptable before installation.",
	"status-explains-delivery":
		"Each assigned review agent receives your correction in its own conversation before its next model turn. A current tool call finishes first. The message is queued, which does not prove the agent read or applied it.",
	"list-changes":
		"- Save stays visible on small screens.\n- Keyboard focus returns to the name field after an error.\n- Cancel discards unsaved edits.\n\nLocal checks passed, but these changes are not released.",
	"shipped-with-optional-cleanup":
		"I released the search fix that removes duplicate results. The live check passed, and search is ready to use. You still decide whether to remove the unused preview directory and close the unnecessary investigation note.",
	"agent-work-attribution":
		"My audit corrected the guide's false claim of unlimited exports to the actual 20 MB limit. A review agent checked the edit, and I committed it locally without publication. You decide whether to publish the corrected guide.",
	"agent-coined-term":
		"The catalog now asks you to start again from the first page if the list changes between page requests. This prevents mismatched pages. The change is active and passed local checks.",
	"proposal-approval":
		"The proposal saves search results for five minutes to speed up repeat searches, so recent edits could be missing during that time. No code changed or speed test ran. You need to decide whether that delay is acceptable for a local prototype and tests, without deployment.",
	"focus-question":
		"The import failed because its input lacked the required account column. It stopped before saving, so no accounts changed. The input needs that column before another import.",
	"one-line": "The fix passed local tests, but release is blocked because the live upload service remains untested.",
	"whole-session":
		"The password reset link is fixed and tested, with deployment left for later. The daily report stopped because its access token expired. You need to renew report access.",
	"receipt-after-answer":
		"Your local backup completed, but there is no remote backup because remote storage is full. Cleanup needs account-owner approval because the remote account is read-only. Remote space must be freed before another copy.",
	"returning-operator":
		"The CSV parser now keeps quoted commas inside their fields, and local checks passed. The change is committed locally but not published. Live exports remain unchecked.",
	"already-short": "A checksum is a value used to detect data changes.",
	"action-in-hint":
		"The link points to the current help page and passed its local check. The change is committed but not pushed, pending your review.",
	"exact-command":
		"The check failed because two entries share a name. Rename the duplicate in config/index.json, then run `npm run verify:index -- --local --limit=25` to check local entries without publishing. The live index remains unchecked.",
	"nothing-to-summarize": "There is no substantive discussion to summarize.",
	"slop-source":
		"The client reconnects after a dropped connection in the local test. Long outages remain untested.",
	"repeated-summary": "The local backup matches the original, but a restore remains untested.",
	"more-detail":
		"The cache saves each query's results for five minutes. Repeat searches use those saved results. An edit does not clear them. After five minutes, the next search gets and saves fresh results. This is expected behavior, and no fix is proposed or implemented.",
	"reported-not-verified":
		"The review agent reports that the fix handles empty rows and its tests passed. That report remains unchecked and does not cover large files.",
	"missing-selected-context": "The earlier pricing decision is not visible here.",
};

it("the tldr suite validates and resolves both variants without inference", () => {
	const suitePath = fileURLToPath(new URL("./tldr.eval.mts", import.meta.url));
	assert.equal(suite.subject.adapter, "pi-sdk");
	assert.equal(suite.subject.kind, "prompt");
	assert.equal(suite.adjudication.policy, "human-required");
	assert.deepEqual(suite.subject.variants.map((variant) => variant.id), ["maintained", "plain-request"]);
	assert.deepEqual(suite.authority.requestedEffects, {
		providerNetwork: ["paid-model-inference"],
		credentials: ["read-approved-model-credentials", "credential-resolution"],
		subject: [],
	});
	piSdkAdapter.validate?.({
		suitePath,
		subjectKind: suite.subject.kind,
		subjectConfig: suite.subject.config,
		cases: suite.cases,
	});
	for (const variant of suite.subject.variants) {
		assert.deepEqual(variant.config.tools, []);
		assert.ok(piSdkAdapter.resolve({ suitePath, subjectKind: suite.subject.kind, subjectConfig: suite.subject.config, variant }));
	}
	assert.deepEqual(suite.subject.variants[1].config.promptTemplates, [
		{ name: "tldr", source: { inline: "tldr $ARGUMENTS" } },
	]);
});

it("every tldr case has a readable synthetic output that passes its deterministic floors", () => {
	assert.deepEqual(Object.keys(examples).sort(), suite.cases.map((entry) => entry.id).sort());
	for (const entry of suite.cases) {
		assert.ok(entry.reviewMetadata?.criteria.length, `${entry.id} requires semantic review criteria`);
		const results = runDeterministicChecks(examples[entry.id], entry.checks);
		assert.deepEqual(results.filter((result) => !result.passed), [], entry.id);
	}
});

it("each tldr deterministic floor rejects its own isolated violation", () => {
	for (const entry of suite.cases) {
		const output = examples[entry.id];
		for (const check of entry.checks) {
			const config = check.config as { maximum?: number; values?: string[] };
			const violations: string[] = [];
			switch (check.type) {
				case "max-characters":
					assert.ok(config.maximum);
					violations.push(output + "x".repeat(config.maximum + 1));
					break;
				case "omits-exact":
					assert.ok(config.values?.length);
					violations.push(...config.values.map((value) => `${output} ${value}`));
					break;
				case "contains-exact":
					assert.ok(config.values?.length);
					violations.push(...config.values.map((value) => output.replaceAll(value, "omitted")));
					break;
				default:
					assert.fail(`Unhandled deterministic check ${check.type}`);
			}
			for (const violation of violations) {
				const failed = runDeterministicChecks(violation, entry.checks).filter((result) => !result.passed);
				assert.deepEqual(failed.map((result) => result.checkId), [check.id], `${entry.id}: ${check.id}`);
			}
		}
	}
});

it("a short but false answer still needs human review", () => {
	const entry = suite.cases.find((entry) => entry.id === "proposal-approval");
	assert.ok(entry);
	const results = runDeterministicChecks("The search fix is deployed and makes every search instant.", entry.checks);
	assert.ok(results.every((result) => result.passed));
	assert.equal(suite.adjudication.policy, "human-required");
	assert.ok(entry.reviewMetadata.criteria.some((criterion) => criterion.includes("No implementation")));
});
